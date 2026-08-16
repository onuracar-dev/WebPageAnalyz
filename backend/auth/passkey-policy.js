const { AppError } = require('../lib/errors');
const {
    reauthenticationMatchesPolicy,
    roleRequiresWebAuthn,
    sessionBinding
} = require('./security');

const PASSKEY_MANAGEMENT_PATHS = new Set([
    '/generate-register-options',
    '/verify-registration',
    '/delete-passkey',
    '/update-passkey'
]);

function pathFor(request) {
    return String(request.path || request.url || '').split('?')[0];
}

async function hasPasskeyManagementAuthorization({ config, store, session, account, passkeyCount }) {
    const binding = sessionBinding(session);
    if (!binding) return false;
    if (await store.hasAdminRecoverySession?.(binding, session.user.id)) return true;
    const marker = await store.getAdminReauthentication?.(binding, session.user.id);
    const policy = {
        maxAgeMs: config.adminSecurity.stepUpMaxAgeMs,
        sessionLifetime: false,
        securityVersion: account.securityVersion ?? 1
    };
    if (passkeyCount === 0) {
        return reauthenticationMatchesPolicy(marker, { ...policy, requiredMethod: 'password_totp' })
            || reauthenticationMatchesPolicy(marker, { ...policy, requiredMethod: 'webauthn' });
    }
    return reauthenticationMatchesPolicy(marker, { ...policy, requiredMethod: 'webauthn' });
}

function createPrivilegedPasskeyMiddleware({ config, authService, store, notifyAccountSecurity, logger }) {
    return async (request, response, next) => {
        try {
            const routePath = pathFor(request);
            if (!PASSKEY_MANAGEMENT_PATHS.has(routePath)) return next();

            const session = await authService.session(request);
            if (!session?.user?.id) return next();
            const account = await store.getAdminAccount?.(session.user.id);
            if (!account?.active) return next();

            const before = await store.listUserPasskeys?.(session.user.id) || [];
            const authorized = await hasPasskeyManagementAuthorization({
                config,
                store,
                session,
                account,
                passkeyCount: before.length
            });
            if (!authorized) {
                throw new AppError(
                    before.length === 0
                        ? 'Re-authenticate with password and TOTP before enrolling the first passkey.'
                        : 'Verify an existing passkey before changing WebAuthn credentials.',
                    {
                        status: 403,
                        code: before.length === 0
                            ? 'ADMIN_PASSKEY_BOOTSTRAP_REAUTH_REQUIRED'
                            : 'ADMIN_WEBAUTHN_STEP_UP_REQUIRED'
                    }
                );
            }

            if (routePath === '/delete-passkey') {
                const passkeyId = String(request.body?.id || '');
                if (!passkeyId) throw new AppError('A passkey ID is required.', { status: 400, code: 'PASSKEY_ID_REQUIRED' });
                if (typeof store.deletePrivilegedPasskey !== 'function') {
                    throw new AppError('Privileged passkey deletion is unavailable.', { status: 503, code: 'ADMIN_PASSKEY_DELETE_UNAVAILABLE' });
                }
                const removed = await store.deletePrivilegedPasskey({
                    userId: session.user.id,
                    passkeyId,
                    actorId: session.user.id,
                    requestId: request.id,
                    minimumCredentialCount: config.adminSecurity.minimumCredentialCount,
                    credentialRequired: roleRequiresWebAuthn(config, account.role)
                });
                const notification = await notifyAccountSecurity?.(
                    { userId: session.user.id, email: account.email, state: 'webauthn_removed' },
                    `WebAuthn credential kaldırıldı${removed.name ? `: ${removed.name}` : ''}`,
                    request.id
                );
                if (notification?.status === 'failed') {
                    await store.logAudit?.({
                        actorId: session.user.id,
                        action: 'security.notification_failed',
                        entityType: 'admin_account',
                        entityId: session.user.id,
                        requestId: request.id,
                        metadata: { event: 'security.webauthn_removed', errorCode: notification.errorCode }
                    }).catch(() => {});
                }
                return response.status(200).json({ status: true });
            }

            const auditAfterSuccessfulMutation = routePath === '/verify-registration' || routePath === '/update-passkey';
            if (auditAfterSuccessfulMutation) {
                response.once('finish', () => {
                    if (response.statusCode < 200 || response.statusCode >= 300) return;
                    void (async () => {
                        const after = await store.listUserPasskeys?.(session.user.id) || [];
                        if (routePath === '/verify-registration') {
                            const known = new Set(before.map((credential) => credential.id));
                            for (const credential of after.filter((item) => !known.has(item.id))) {
                                await store.invalidateAdminRecoverySessions?.(session.user.id);
                                await store.logAudit?.({
                                    actorId: session.user.id,
                                    action: 'security.webauthn_added',
                                    entityType: 'admin_account',
                                    entityId: session.user.id,
                                    requestId: request.id,
                                    metadata: {
                                        credentialId: credential.id,
                                        name: credential.name || null,
                                        deviceType: credential.deviceType || null,
                                        backedUp: Boolean(credential.backedUp)
                                    }
                                });
                                await notifyAccountSecurity?.(
                                    { userId: session.user.id, email: account.email, state: 'webauthn_added' },
                                    `Yeni WebAuthn credential eklendi${credential.name ? `: ${credential.name}` : ''}`,
                                    request.id
                                );
                            }
                            return;
                        }

                        const passkeyId = String(request.body?.id || '');
                        const previous = before.find((item) => item.id === passkeyId);
                        const updated = after.find((item) => item.id === passkeyId);
                        if (!previous || !updated || previous.name === updated.name) return;
                        await store.logAudit?.({
                            actorId: session.user.id,
                            action: 'security.webauthn_updated',
                            entityType: 'admin_account',
                            entityId: session.user.id,
                            requestId: request.id,
                            before: { credentialId: passkeyId, name: previous.name || null },
                            after: { credentialId: passkeyId, name: updated.name || null }
                        });
                    })().catch((error) => logger?.warn?.('Privileged passkey post-mutation event failed', {
                        requestId: request.id,
                        userId: session.user.id,
                        errorCode: error?.code || 'PASSKEY_POST_MUTATION_FAILED'
                    }));
                });
            }
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

module.exports = {
    createPrivilegedPasskeyMiddleware,
    hasPasskeyManagementAuthorization
};
