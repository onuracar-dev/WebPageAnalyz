function createPrivilegedPasswordChangeMiddleware({ authService, store, notifyAccountSecurity, logger }) {
    return async (request, response, next) => {
        try {
            const session = await authService.session(request);
            if (!session?.user?.id) return next();
            const account = await store.getAdminAccount?.(session.user.id);
            if (!account?.active) return next();

            // Better Auth owns password verification and hashing. For a
            // privileged identity we only strengthen its official contract so
            // every other session is revoked and a new current session token
            // is issued on success.
            request.body.revokeOtherSessions = true;
            response.once('finish', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) return;
                void (async () => {
                    await store.recordAdminPasswordChange?.({
                        userId: session.user.id,
                        actorId: session.user.id,
                        requestId: request.id
                    });
                    await notifyAccountSecurity?.(
                        { userId: session.user.id, email: account.email, state: 'password_changed' },
                        'Ayrıcalıklı hesabınızın parolası değiştirildi ve diğer oturumlar iptal edildi',
                        request.id
                    );
                })().catch((error) => logger?.warn?.('Privileged password-change security event failed', {
                    requestId: request.id,
                    userId: session.user.id,
                    errorCode: error?.code || 'PASSWORD_CHANGE_EVENT_FAILED'
                }));
            });
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

module.exports = { createPrivilegedPasswordChangeMiddleware };
