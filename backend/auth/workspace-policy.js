const { AppError } = require('../lib/errors');
const { getPlan } = require('../domain/plans');
const { stableWorkspaceId } = require('./better-auth');

const WORKSPACE_PERMISSIONS = Object.freeze({
    settings: 'settings',
    billing: 'billing',
    integrations: 'integrations',
    project: 'project',
    scan: 'scan',
    sourceUpload: 'source_upload',
    share: 'share',
    review: 'review',
    support: 'support'
});

const ROLE_PERMISSIONS = Object.freeze({
    owner: Object.freeze([
        WORKSPACE_PERMISSIONS.settings,
        WORKSPACE_PERMISSIONS.billing,
        WORKSPACE_PERMISSIONS.integrations,
        WORKSPACE_PERMISSIONS.project,
        WORKSPACE_PERMISSIONS.scan,
        WORKSPACE_PERMISSIONS.sourceUpload,
        WORKSPACE_PERMISSIONS.share,
        WORKSPACE_PERMISSIONS.review,
        WORKSPACE_PERMISSIONS.support
    ]),
    admin: Object.freeze([
        WORKSPACE_PERMISSIONS.settings,
        WORKSPACE_PERMISSIONS.integrations,
        WORKSPACE_PERMISSIONS.project,
        WORKSPACE_PERMISSIONS.scan,
        WORKSPACE_PERMISSIONS.sourceUpload,
        WORKSPACE_PERMISSIONS.share,
        WORKSPACE_PERMISSIONS.review,
        WORKSPACE_PERMISSIONS.support
    ]),
    analyst: Object.freeze([
        WORKSPACE_PERMISSIONS.project,
        WORKSPACE_PERMISSIONS.scan,
        WORKSPACE_PERMISSIONS.sourceUpload,
        WORKSPACE_PERMISSIONS.share,
        WORKSPACE_PERMISSIONS.review,
        WORKSPACE_PERMISSIONS.support
    ]),
    viewer: Object.freeze([])
});

const membershipByStore = new WeakMap();

function normalizeRole(role) {
    if (role === 'member') return 'analyst';
    return Object.hasOwn(ROLE_PERMISSIONS, role) ? role : null;
}

function membershipKey(workspaceId, userId) {
    return `${workspaceId}:${userId}`;
}

function memoryMemberships(store) {
    let memberships = membershipByStore.get(store);
    if (!memberships) {
        memberships = new Map();
        membershipByStore.set(store, memberships);
    }
    return memberships;
}

async function findMembership(store, workspaceId, userId, { organizationBacked = false } = {}) {
    if (typeof store.getWorkspaceMembership === 'function') {
        return store.getWorkspaceMembership(workspaceId, userId);
    }
    if (store.pool?.query) {
        if (organizationBacked) {
            const organization = await store.pool.query(
                `SELECT "userId",role,"seatPosition" FROM (
                    SELECT "userId",role,row_number() OVER (
                        ORDER BY CASE WHEN role='owner' THEN 0 ELSE 1 END,"createdAt",id
                    )::int AS "seatPosition"
                    FROM member
                    WHERE "organizationId"=$1
                ) AS ranked
                WHERE "userId"=$2
                ORDER BY "seatPosition"
                LIMIT 1`,
                [workspaceId, userId]
            );
            const organizationMembership = organization.rows[0];
            const role = normalizeRole(organizationMembership?.role);
            if (!role) {
                await store.pool.query('DELETE FROM wpa_memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId]);
                return null;
            }
            await assertWithinWorkspaceSeatLimit(store, workspaceId, organizationMembership);
            await store.pool.query(
                `INSERT INTO wpa_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)
                 ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role`,
                [workspaceId, userId, role]
            );
            return { workspaceId, userId, role };
        }
        const direct = await store.pool.query(
            'SELECT workspace_id AS "workspaceId", user_id AS "userId", role FROM wpa_memberships WHERE workspace_id=$1 AND user_id=$2',
            [workspaceId, userId]
        );
        if (direct.rows[0]) return { ...direct.rows[0], role: normalizeRole(direct.rows[0].role) };
        return null;
    }
    const membership = memoryMemberships(store).get(membershipKey(workspaceId, userId));
    return membership || null;
}

async function effectiveWorkspaceSeatLimit(store, workspaceId) {
    let plan = null;
    if (typeof store.getEffectiveEntitlements === 'function') {
        plan = await store.getEffectiveEntitlements(workspaceId);
    } else {
        const workspace = typeof store.getWorkspace === 'function' ? await store.getWorkspace(workspaceId) : null;
        plan = (typeof store.getPlan === 'function' && workspace?.planId ? await store.getPlan(workspace.planId) : null)
            || getPlan(workspace?.planId)
            || getPlan('free');
    }
    const seatLimit = Number(plan?.limits?.seats);
    if (!Number.isSafeInteger(seatLimit) || seatLimit < 1) {
        throw new AppError('Workspace seat capacity is not configured correctly.', { status: 503, code: 'WORKSPACE_SEAT_LIMIT_UNAVAILABLE' });
    }
    return seatLimit;
}

async function assertWithinWorkspaceSeatLimit(store, workspaceId, membership) {
    // PostgreSQL returns the row_number as an integer. The fallback keeps the
    // narrow store doubles used by policy tests compatible; production
    // organization lookups always select seatPosition above.
    const seatPosition = Number(membership?.seatPosition ?? 1);
    if (!Number.isSafeInteger(seatPosition) || seatPosition < 1) {
        throw new AppError('Workspace seat assignment is invalid.', { status: 503, code: 'WORKSPACE_SEAT_LIMIT_UNAVAILABLE' });
    }
    const seatLimit = await effectiveWorkspaceSeatLimit(store, workspaceId);
    if (seatPosition > seatLimit) {
        if (store.pool?.query) {
            await store.pool.query('DELETE FROM wpa_memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, membership.userId]);
        }
        throw new AppError('This workspace has reached the seat limit for its plan.', { status: 403, code: 'WORKSPACE_SEAT_LIMIT_REACHED' });
    }
    return { seatLimit, seatPosition };
}

async function saveMembership(store, workspaceId, userId, role) {
    if (typeof store.upsertWorkspaceMembership === 'function') {
        return store.upsertWorkspaceMembership({ workspaceId, userId, role });
    }
    if (store.pool?.query) {
        const { rows } = await store.pool.query(
            `INSERT INTO wpa_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)
             ON CONFLICT(workspace_id,user_id) DO NOTHING
             RETURNING workspace_id AS "workspaceId", user_id AS "userId", role`,
            [workspaceId, userId, role]
        );
        return rows[0] || findMembership(store, workspaceId, userId);
    }
    const membership = { workspaceId, userId, role };
    memoryMemberships(store).set(membershipKey(workspaceId, userId), membership);
    return membership;
}

function canCreatePersonalOwner(identity, workspaceId, config) {
    if (identity.session && workspaceId === stableWorkspaceId(identity.userId)) return true;
    if (!identity.session && identity.userId?.startsWith('api_')) return true;
    return !identity.session && identity.userId === 'development-user' && config.nodeEnv !== 'production';
}

async function assertPrincipalActive(store, identity) {
    if (!identity?.userId || !identity.workspaceId) throw new AppError('Workspace authentication is required.', { status: 401, code: 'AUTHENTICATION_REQUIRED' });
    const userState = typeof store.getUserState === 'function' ? await store.getUserState(identity.userId) : null;
    if (userState?.state === 'banned') throw new AppError('This account is banned.', { status: 403, code: 'USER_BANNED' });
    const workspaceState = typeof store.getWorkspaceState === 'function' ? await store.getWorkspaceState(identity.workspaceId) : null;
    if (workspaceState?.state === 'suspended') throw new AppError('This workspace is suspended.', { status: 403, code: 'WORKSPACE_SUSPENDED' });
    return { userState: userState || { userId: identity.userId, state: 'active' }, workspaceState: workspaceState || { workspaceId: identity.workspaceId, state: 'active' } };
}

function requireActivePrincipal(store) {
    return async (request, _response, next) => {
        try {
            request.platformState = await assertPrincipalActive(store, request.platformIdentity);
            return next();
        } catch (error) { return next(error); }
    };
}

function attachWorkspaceMembership({ config, store }) {
    return async (request, _response, next) => {
        try {
            const identity = request.platformIdentity;
            if (!identity?.userId || !identity.workspaceId) {
                return next(new AppError('Workspace authentication is required.', { status: 401, code: 'AUTHENTICATION_REQUIRED' }));
            }
            request.platformState = await assertPrincipalActive(store, identity);
            let membership = await findMembership(store, identity.workspaceId, identity.userId, {
                organizationBacked: Boolean(identity.session?.session?.activeOrganizationId)
            });
            if (!membership && canCreatePersonalOwner(identity, identity.workspaceId, config)) {
                membership = await saveMembership(store, identity.workspaceId, identity.userId, 'owner');
            }
            const role = normalizeRole(membership?.role);
            if (!role) return next(new AppError('This account is not a member of the requested workspace.', { status: 403, code: 'WORKSPACE_MEMBERSHIP_REQUIRED' }));
            if (role === 'owner' && typeof store.assignWorkspaceEntitlementOwner === 'function') {
                await store.assignWorkspaceEntitlementOwner(identity.workspaceId, identity.userId, { ifUnset: true });
            }
            request.platformIdentity = { ...identity, role, membership };
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

function assertWorkspacePermission(identity, permission) {
    const permissions = ROLE_PERMISSIONS[identity?.role] || [];
    if (!permissions.includes(permission)) {
        throw new AppError('This workspace role cannot perform that action.', { status: 403, code: 'WORKSPACE_PERMISSION_DENIED' });
    }
}

function requireWorkspacePermission(permission) {
    if (!Object.values(WORKSPACE_PERMISSIONS).includes(permission)) throw new Error(`Unknown workspace permission: ${permission}`);
    return (request, _response, next) => {
        try {
            assertWorkspacePermission(request.platformIdentity, permission);
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

function setWorkspaceMembershipForTests(store, workspaceId, userId, role) {
    const normalized = normalizeRole(role);
    if (!normalized) throw new Error(`Unknown workspace role: ${role}`);
    memoryMemberships(store).set(membershipKey(workspaceId, userId), { workspaceId, userId, role: normalized });
}

module.exports = {
    ROLE_PERMISSIONS,
    WORKSPACE_PERMISSIONS,
    assertPrincipalActive,
    assertWorkspacePermission,
    attachWorkspaceMembership,
    normalizeRole,
    requireActivePrincipal,
    requireWorkspacePermission,
    setWorkspaceMembershipForTests
};
