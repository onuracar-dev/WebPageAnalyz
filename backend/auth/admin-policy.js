const { AppError } = require('../lib/errors');

const ADMIN_ROLES = Object.freeze(['super_admin', 'admin', 'moderator', 'support']);

const ADMIN_PERMISSIONS = Object.freeze([
    'admin.session.read',
    'system.read',
    'users.read',
    'users.ban',
    'users.unban',
    'workspaces.read',
    'workspaces.suspend',
    'workspaces.unsuspend',
    'workspaces.delete',
    'credits.read',
    'credits.manage',
    'entitlements.read',
    'entitlements.manage',
    'plans.manage',
    'scans.read',
    'scans.retry',
    'scans.cancel',
    'support.read',
    'support.reply',
    'support.internal_note',
    'support.manage',
    'redeem.read',
    'redeem.manage',
    'billing.read',
    'billing.reconcile',
    'audit.read',
    'webhooks.read',
    'webhooks.replay',
    'engine_lab.read',
    'engine_lab.execute',
    'engine_lab.cancel',
    'expert_reviews.read',
    'expert_reviews.manage',
    'expert_reviews.finalize',
    'expert_reviews.publish',
    'reports.read',
    'reports.publish',
    'security.self.read',
    'security.self.manage',
    'security.self.recovery',
    'security.admins.read',
    'security.admins.manage',
    'security.roles.read',
    'security.roles.manage',
    'security.mfa.manage',
    'security.recovery.manage',
    'security.activity.read'
]);

const PERMISSION_SET = new Set(ADMIN_PERMISSIONS);
const COMMON_SELF = ['admin.session.read', 'security.self.read', 'security.self.manage', 'security.self.recovery'];
const SUPPORT_PERMISSIONS = [
    ...COMMON_SELF,
    'system.read',
    'users.read',
    'workspaces.read',
    'scans.read',
    'reports.read',
    'support.read',
    'support.reply',
    'support.internal_note'
];
const MODERATOR_PERMISSIONS = [
    ...SUPPORT_PERMISSIONS,
    'users.ban',
    'users.unban',
    'workspaces.suspend',
    'workspaces.unsuspend',
    'scans.retry',
    'scans.cancel',
    'support.manage',
    'audit.read',
    'expert_reviews.read',
    'expert_reviews.manage'
];
const ADMIN_OPERATIONAL_PERMISSIONS = ADMIN_PERMISSIONS.filter((permission) =>
    !permission.startsWith('security.admins.')
    && !permission.startsWith('security.roles.')
    && !['security.mfa.manage', 'security.recovery.manage', 'workspaces.delete', 'plans.manage', 'reports.publish', 'expert_reviews.publish'].includes(permission)
);

const ROLE_PERMISSIONS = Object.freeze({
    super_admin: Object.freeze([...ADMIN_PERMISSIONS]),
    admin: Object.freeze(ADMIN_OPERATIONAL_PERMISSIONS),
    moderator: Object.freeze([...new Set(MODERATOR_PERMISSIONS)]),
    support: Object.freeze([...new Set(SUPPORT_PERMISSIONS)])
});

const ROLE_RANK = Object.freeze({ support: 0, moderator: 1, admin: 2, super_admin: 3 });

function canonicalAdminRole(role) {
    // `operator` existed before migration 040. It is accepted only as a
    // read-time compatibility alias and is never emitted or assignable.
    if (role === 'operator') return 'moderator';
    return ADMIN_ROLES.includes(role) ? role : null;
}

function permissionsForRole(role) {
    const canonical = canonicalAdminRole(role);
    return canonical ? [...ROLE_PERMISSIONS[canonical]] : [];
}

function hasAdminPermission(roleOrPermissions, permission) {
    if (!PERMISSION_SET.has(permission)) return false;
    const permissions = Array.isArray(roleOrPermissions)
        ? roleOrPermissions
        : permissionsForRole(roleOrPermissions);
    return permissions.includes(permission);
}

function canManagePrivilegedRole(actorRole, targetRole) {
    const actor = canonicalAdminRole(actorRole);
    const target = canonicalAdminRole(targetRole);
    return Boolean(actor && target && actor === 'super_admin' && ROLE_RANK[target] <= ROLE_RANK[actor]);
}

function rule(method, pattern, permission, options = {}) {
    if (!PERMISSION_SET.has(permission)) throw new Error(`Unknown admin permission in route policy: ${permission}`);
    return Object.freeze({ method, pattern, permission, stepUp: Boolean(options.stepUp), allowDuringEnrollment: Boolean(options.allowDuringEnrollment) });
}

const ADMIN_ROUTE_POLICIES = Object.freeze([
    rule('GET', /^\/me$/, 'admin.session.read', { allowDuringEnrollment: true }),
    rule('GET', /^\/security\/status$/, 'security.self.read', { allowDuringEnrollment: true }),
    rule('POST', /^\/security\/step-up\/webauthn$/, 'security.self.manage', { allowDuringEnrollment: true }),
    rule('POST', /^\/security\/recovery\/use$/, 'security.self.recovery', { allowDuringEnrollment: true }),
    rule('POST', /^\/security\/recovery-codes$/, 'security.self.recovery', { stepUp: true }),
    rule('GET', /^\/security\/admins$/, 'security.admins.read'),
    rule('PUT', /^\/security\/admins\/[^/]+$/, 'security.admins.manage', { stepUp: true }),
    rule('POST', /^\/security\/admins\/[^/]+\/mfa-reset$/, 'security.mfa.manage', { stepUp: true }),
    rule('GET', /^\/overview$/, 'system.read'),
    rule('GET', /^\/resources\/users$/, 'users.read'),
    rule('GET', /^\/resources\/workspaces$/, 'workspaces.read'),
    rule('GET', /^\/resources\/grants$/, 'entitlements.read'),
    rule('GET', /^\/resources\/audit$/, 'audit.read'),
    rule('GET', /^\/resources\/(?:scans|findings)$/, 'scans.read'),
    rule('GET', /^\/resources\/reports$/, 'reports.read'),
    rule('GET', /^\/users\/[^/]+$/, 'users.read'),
    rule('POST', /^\/users\/[^/]+\/ban$/, 'users.ban', { stepUp: true }),
    rule('POST', /^\/users\/[^/]+\/unban$/, 'users.unban', { stepUp: true }),
    rule('POST', /^\/users\/[^/]+\/credits$/, 'credits.manage', { stepUp: true }),
    rule('POST', /^\/users\/[^/]+\/entitlements$/, 'entitlements.manage', { stepUp: true }),
    rule('POST', /^\/users\/[^/]+\/plan$/, 'plans.manage', { stepUp: true }),
    rule('GET', /^\/workspaces\/[^/]+$/, 'workspaces.read'),
    rule('POST', /^\/workspaces\/[^/]+\/suspend$/, 'workspaces.suspend', { stepUp: true }),
    rule('POST', /^\/workspaces\/[^/]+\/unsuspend$/, 'workspaces.unsuspend', { stepUp: true }),
    rule('POST', /^\/workspaces\/[^/]+\/billing\/reconcile$/, 'billing.reconcile', { stepUp: true }),
    rule('POST', /^\/workspaces\/[^/]+\/deletion\/(?:authorize|execute)$/, 'workspaces.delete', { stepUp: true }),
    rule('GET', /^\/workspaces\/[^/]+\/scans\/[^/]+$/, 'scans.read'),
    rule('POST', /^\/workspaces\/[^/]+\/scans\/[^/]+\/cancel$/, 'scans.cancel', { stepUp: true }),
    rule('POST', /^\/workspaces\/[^/]+\/scans\/[^/]+\/retry$/, 'scans.retry', { stepUp: true }),
    rule('POST', /^\/entitlements\/[^/]+\/revoke$/, 'entitlements.manage', { stepUp: true }),
    rule('GET', /^\/redeem-codes$/, 'redeem.read'),
    rule('POST', /^\/redeem-codes(?:\/[^/]+\/(?:disable|enable|revoke))?$/, 'redeem.manage', { stepUp: true }),
    rule('GET', /^\/webhook-outbox$/, 'webhooks.read'),
    rule('POST', /^\/webhook-outbox\/[^/]+\/replay$/, 'webhooks.replay', { stepUp: true }),
    rule('GET', /^\/support\/tickets(?:\/[^/]+)?$/, 'support.read'),
    rule('PATCH', /^\/support\/tickets\/[^/]+$/, 'support.manage'),
    rule('POST', /^\/support\/tickets\/[^/]+\/notes$/, 'support.internal_note'),
    rule('POST', /^\/support\/tickets\/[^/]+\/(?:replies|messages)$/, 'support.reply'),
    rule('GET', /^\/engine-lab\/(?:catalog|runs(?:\/[^/]+)?(?:\/artifacts\/[^/]+\/[^/]+)?)$/, 'engine_lab.read'),
    rule('POST', /^\/engine-lab\/runs$/, 'engine_lab.execute', { stepUp: true }),
    rule('POST', /^\/engine-lab\/runs\/[^/]+\/cancel$/, 'engine_lab.cancel', { stepUp: true }),
    rule('GET', /^\/operator-tasks$/, 'expert_reviews.read'),
    rule('POST', /^\/operator-tasks\/[^/]+\/complete$/, 'expert_reviews.manage'),
    rule('GET', /^\/expert-reviews(?:\/[^/]+)?$/, 'expert_reviews.read'),
    rule('POST', /^\/expert-reviews\/[^/]+\/claim$/, 'expert_reviews.manage'),
    rule('PUT', /^\/expert-reviews\/[^/]+\/(?:findings\/[^/]+|roadmap)$/, 'expert_reviews.manage'),
    rule('POST', /^\/expert-reviews\/[^/]+\/finalize$/, 'expert_reviews.finalize', { stepUp: true }),
    rule('POST', /^\/expert-reviews\/[^/]+\/publish$/, 'expert_reviews.publish', { stepUp: true }),
    rule('POST', /^\/reports\/[^/]+\/publish$/, 'reports.publish', { stepUp: true }),
    rule('PUT', /^\/plans\/[^/]+\/entitlements\/[^/]+$/, 'plans.manage', { stepUp: true })
]);

function normalizedAdminPath(request) {
    const raw = String(request.originalUrl || request.url || '').split('?')[0];
    const prefix = '/api/v1/admin';
    const path = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    return path || '/';
}

function resolveAdminRoutePolicy(request) {
    const method = String(request.method || '').toUpperCase();
    const path = normalizedAdminPath(request);
    return ADMIN_ROUTE_POLICIES.find((candidate) => candidate.method === method && candidate.pattern.test(path)) || null;
}

function requireKnownAdminRoutePermission() {
    return (request, _response, next) => {
        const policy = resolveAdminRoutePolicy(request);
        if (!policy) return next(new AppError('This privileged route has no authorization policy.', { status: 403, code: 'ADMIN_ROUTE_POLICY_MISSING' }));
        if (!hasAdminPermission(request.adminIdentity?.permissions || [], policy.permission)) {
            return next(new AppError('This administrator does not have the required permission.', {
                status: 403,
                code: 'ADMIN_PERMISSION_DENIED',
                details: { requiredPermission: policy.permission }
            }));
        }
        request.adminRoutePolicy = policy;
        return next();
    };
}

module.exports = {
    ADMIN_PERMISSIONS,
    ADMIN_ROLES,
    ADMIN_ROUTE_POLICIES,
    ROLE_PERMISSIONS,
    canManagePrivilegedRole,
    canonicalAdminRole,
    hasAdminPermission,
    permissionsForRole,
    requireKnownAdminRoutePermission,
    resolveAdminRoutePolicy
};
