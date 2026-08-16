# Authentication redirect and email-token contract

Better Auth is mounted under `/api/auth`. Redirects are server-validated; the
client cannot choose an arbitrary host.

Allowed redirect origins are the exact origins from `CORS_ORIGINS`, `APP_URL`,
and `BETTER_AUTH_URL`. Relative paths such as `/forgot-password` are also
accepted by Better Auth. A reset request therefore uses:

```json
POST /api/auth/request-password-reset
{"email":"user@example.com","redirectTo":"https://app.example.com/forgot-password"}
```

The reset-mail transport is intentionally not faked. Until a deployment wires
`emailAndPassword.sendResetPassword`, Better Auth returns
`RESET_PASSWORD_DISABLED`; no reset token is issued or claimed to have been
delivered. When configured, Better Auth creates the bounded-lived token and
uses `GET /api/auth/reset-password/:token?callbackURL=...` to hand it to the
allowed application origin, followed by `POST /api/auth/reset-password` with
`{newPassword, token}`.

Email verification uses the corresponding real token endpoints:

- `POST /api/auth/send-verification-email` with `{email, callbackURL?}` asks
  the configured transport to deliver a signed, expiring token.
- `GET /api/auth/verify-email?token=...&callbackURL=...` consumes the token
  and marks the account verified (or redirects with an error code).

Without `emailVerification.sendVerificationEmail`, the send endpoint returns
`VERIFICATION_EMAIL_NOT_ENABLED`; the application must not turn that into a
successful verification message. The browser's `/verify-email` page is only a
landing surface—the Better Auth GET endpoint is the authority that changes
`emailVerified`.
