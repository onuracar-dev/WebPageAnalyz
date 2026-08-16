# Privileged access security report

Date: 2026-08-16
Scope: WebPageAnalyzer application-level operator/admin plane
Decision: implemented locally; production deployment and physical-key/provider proof remain separate gates

## A. Previous model

The application already used Better Auth sessions, verified email, TOTP, server-side administrator records, an admin re-authentication marker, trusted mutation origins, endpoint rate limits and append-only audit records. The main weaknesses were a coarse role model, route-local legacy role declarations, a global re-auth gate that made read-only work awkward, no phishing-resistant credential, no strong privileged recovery path and no finite permission contract for future support/moderator identities.

The implementation extends the existing identity system. It does not add a second password database, hidden admin URL, custom WebAuthn cryptography, customer RBAC product or Cloudflare dependency.

## B. Threat model

The change addresses:

- password/TOTP phishing followed by a high-risk admin mutation;
- stale sessions retaining permissions after a role, ban, password or MFA change;
- support/moderator self-escalation and body-supplied role/permission escalation;
- concurrent removal/downgrade of the final super administrator;
- concurrent deletion of multiple WebAuthn credentials leaving a required-role account without its final credential;
- email-only privileged recovery, recovery-code replay and plaintext recovery storage;
- CSRF/origin bypass on privileged mutations;
- missing audit/notification boundaries for security events;
- future operator growth being blocked by a one-person/e-mail assumption.

Unknown privileged routes and unknown permissions fail closed.

## C. Roles

The canonical registry is `backend/auth/admin-policy.js`. `operator` is a read-time migration alias for `moderator`; it is not assignable or emitted.

| Role | Operational permissions | Explicit exclusions |
|---|---|---|
| `super_admin` | All 47 registered permissions | None inside the application policy; critical operations still require step-up/reason/confirmation where defined |
| `admin` | Users, workspace operations, credits, entitlements, scans, support, redeem, billing read/reconcile, audit, Engine Lab, reports and self-security | Privileged-role administration, other-admin MFA/recovery, workspace deletion, global plan catalog mutation and highest-risk publish controls |
| `moderator` | Read users/workspaces/scans/reports, ban/unban, suspend/unsuspend, scan retry/cancel, support management, audit and selected expert-review work | Credits, plans, entitlements, billing mutation, redeem mutation, Engine Lab and `security.admins.*` |
| `support` | Minimum customer context, users/workspaces/scans/reports read, support read/reply/internal note and self-security | Ban/suspension, credits, plans, entitlements, billing/redeem mutation, Engine Lab, audit and privileged-user management |

Every `/api/v1/admin` route resolves an explicit method/path policy before its handler. The frontend consumes the returned permission list only to hide unavailable navigation and controls; it is not the authorization boundary.

## D. WebAuthn

- Better Auth and the official `@better-auth/passkey` integration are pinned to `1.6.26` in both backend and website.
- WebAuthn registration/authentication verification is owned by the official library. The server stores only public credential material, counters and bounded metadata; private keys never reach the server.
- Credentials are `0..N`. Production policy requires at least one for configured roles and recommends two independent credentials; the schema is not locked to exactly two.
- Initial enrollment is authorized by current password + TOTP. Adding/updating/removing later credentials requires a fresh WebAuthn step-up or a bounded recovery window.
- A real Chrome virtual-authenticator test exposed that Better Auth plugin-owned passkey rows do not invoke the configured generic model hooks. The final implementation therefore protects the official delete endpoint with application middleware and an atomic store operation instead of trusting that ineffective hook.
- Passkey deletion locks per user, re-counts credentials and serializes concurrent delete attempts. The last required credential returns `ADMIN_FINAL_PASSKEY_REQUIRED`.
- Passkey state mutations are trusted-origin checked. Registration/removal creates security audit events and notification attempts without logging challenge, session token or credential public-key material.

## E. Recovery

- Recovery codes are generated with cryptographically secure randomness, shown only in the creation response and stored as HMAC hashes.
- Regeneration replaces the whole batch. A code is one-time; replay and rotated-out codes fail.
- Recovery also verifies password + TOTP, revokes other sessions, invalidates prior step-up markers, increments the security version, opens only a short enrollment window and tells the operator to enroll a replacement passkey.
- Normal email password reset revokes sessions. Privileged password change forces Better Auth's official `revokeOtherSessions` behavior, invalidates privileged markers/recovery state, increments the security version, audits and attempts a notification.
- Other-admin MFA reset requires `security.mfa.manage`, a fresh WebAuthn step-up, reason and confirmation. The final active super administrator cannot be reset through the normal control plane.

Recovery codes are a break-glass path, not a substitute for the recommended backup authenticator.

## F. Session behavior

- Read-only navigation validates the current authoritative admin record, verified email, TOTP state and current role on every request but does not repeatedly prompt for a security key.
- Critical route policies require a fresh, session-bound marker. Production uses a bounded WebAuthn marker (default 600 seconds) for configured privileged roles.
- Markers contain a security-version snapshot; role, password, recovery and MFA changes make old markers stale or delete them.
- Role changes and account bans revoke sessions. Recovery/MFA reset revoke privileged sessions. Better Auth password reset and privileged password change revoke sessions through the canonical auth system.
- `ADMIN_REAUTH_SESSION_LIFETIME` is accepted only as a local-development convenience for non-WebAuthn password+TOTP operation; production refuses to start with it enabled.

## G. Privilege escalation controls

- Role and permission names are finite and canonical. Request bodies cannot add arbitrary permissions.
- Support, moderator and admin do not have `security.admins.manage`/`security.roles.manage`; direct API calls are denied before mutation.
- Only a current super administrator can grant privileged roles, including another super administrator.
- The store locks the privileged set during role change, resolves the actor from current storage, revokes target sessions and increments the target security version.
- UI controls and navigation are permission-filtered, while all security decisions remain server-side.

## H. Last super-admin invariant

The application transaction takes a PostgreSQL advisory lock, locks all admin records and rejects removal/downgrade/deactivation when only one active super administrator remains. Migration 040 installs the row-level database guard; migration 041 adds a statement-level advisory lock for direct role/deactivation/delete SQL so two concurrent transactions cannot both validate against the same stale privileged set. Multiple super administrators remain supported.

Live local PostgreSQL proof attempted to downgrade the only active super administrator inside a transaction. PostgreSQL returned SQLSTATE `23514` with `LAST_SUPER_ADMIN_REQUIRED`; the transaction was rolled back with no residue.

A second proof used a completely disposable project PostgreSQL database with all 41 migrations, two active super administrators and two concurrent direct-SQL downgrades. One transaction committed, the competing transaction failed with `LAST_SUPER_ADMIN_REQUIRED`, and the final set contained exactly one `admin` plus one active `super_admin`. The disposable database was dropped in `finally`; residue was verified as zero.

## I. Cloudflare compatibility

Application auth, WebAuthn, permissions, step-up, origin checks and audit work without Cloudflare. An optional `admin.example.com` Cloudflare Access policy may later protect both the admin HTML and its admin/auth API paths as an additional outer layer. No client-supplied Cloudflare header is trusted, and no secret route is used.

## J. Audit and security notifications

Recorded events include:

- `security.role_granted`, `security.role_changed`, `security.role_revoked`;
- `security.privileged_login`;
- `security.webauthn_added`, `security.webauthn_updated`, `security.webauthn_removed`;
- `security.recovery_generated`, `security.recovery_used`, `security.recovery_failed`;
- `security.mfa_reset`;
- `security.password_changed`, `security.password_reset`;
- `security.step_up_failed`, `security.step_up_succeeded`.

Audit records retain actor, target/entity, reason where applicable, request ID, timestamp and redacted metadata. Passwords, TOTP secrets, recovery plaintext, challenges, cookies, session tokens and API/provider secrets are excluded. The existing transactional email boundary receives security notifications; provider failure is fail-soft and does not roll back a completed security mutation.

## K. Tests

Evidence collected during this task:

| Verification | Result |
|---|---|
| Complete backend suite | 405 PASS / 0 FAIL / 26 SKIP (431 total); SKIP remains UNPROVEN |
| Privileged security/config focused backend suite | 22 PASS / 0 FAIL / 0 SKIP |
| Updated auth/commercial focused regression | 24 PASS / 0 FAIL / 0 SKIP |
| Admin permission/UI Chrome fixture suite | 14 PASS / 0 FAIL / 0 SKIP |
| Full non-live website Chromium regression | 50 PASS / 0 FAIL / 6 SKIP (56 total); the six skips are tests owned by the mobile/compact/reduced-motion projects, not PASS |
| Live localhost Chrome + virtual WebAuthn | 1 PASS / 0 FAIL / 0 SKIP |
| Website TypeScript | PASS |
| Website production build | PASS, 1,691 modules transformed |
| Journey definition contract | 2 PASS / 0 FAIL / 0 SKIP |
| Four-plan catalog contract | PASS: Free, Signal, Studio, Enterprise |
| Backend syntax + focused ESLint | PASS |
| Migration validation | PASS, 41 contiguous files |
| Live local migrations | 040 and 041 applied; checksums below |
| Current local Compose smoke | PASS: rebuilt backend healthy, frontend healthy, `/api/v1/admin/access-status` HTTP 200 |

Migration 040 SHA-256: `9f49cc3e3ff60f2dbb76b1b4fd0ea82b08f1eca9a4fe4cd13c112b453f29aab4`.

Migration 041 SHA-256: `620cd7d829e4844906558052a51828aadb1a5c07629fd6a0b3987c64548047c3`.

The live browser flow proved password + TOTP login, read-only navigation without a WebAuthn prompt, first passkey enrollment, WebAuthn step-up, recovery-code generation, ten unique codes, show-once behavior after refresh and rejection of final-credential deletion. The focused server harness separately proved two registered credentials, one successful removal and one rejected concurrent final-credential removal. Temporary passwords, sessions, passkeys, assertions and recovery rows were restored/removed; security audit evidence was preserved. Browser screenshot: `website/artifacts/privileged-access-security-live.png`.

The first fully parallel website run exposed stale pre-RBAC browser fixtures and an SSE fixture that did not match the progress query string. Those contracts were corrected, the failing reproductions passed 8/8 in focused reruns, and the complete Chromium regression then passed with one worker. The worker reduction avoids local Chrome/Vite resource contention; it does not relax an assertion or bypass WebAuthn.

## L. Known limitations

- The live browser used Chrome's virtual authenticator, not two physical FIDO2 devices. Physical primary/backup enrollment remains a production ceremony.
- Two-credential removal safety is proven through the real Express policy/store harness; enrolling and exercising two independent authenticators in one live browser ceremony remains UNPROVEN until the production primary and backup devices are available.
- Super-admin was exercised against the live local PostgreSQL/browser stack. Admin/moderator/support UI behavior was exercised in real Chrome with deterministic API fixtures and their API authorization was exercised through the real Express policy/store harness; three separate live privileged logins were not created in the persistent local database.
- Transactional email delivery to a real mailbox was not proven. Security audit/event generation is proven; provider delivery remains a production acceptance item.
- Cloudflare Access is documented but was not enabled or tested and is not an authorization dependency.
- PostgreSQL/provider/worker tests that require separately provisioned `TEST_*_DATABASE_URL` values remain UNPROVEN when skipped. They are not counted as PASS.
- Production hostname/RP ID, HTTPS cookies and an actual deployed release artifact remain deployment gates.

Current rebuilt local backend image: `sha256:865d536ec65198408de3413265bda209beee768189cdad660caee02415dce95b`.

## M. Production setup

1. Apply all migrations with the migrator role and re-apply/verify runtime grants; verify migrations 040 and 041 against the recorded checksums.
2. Create or select a dedicated privileged identity in the canonical Better Auth user table. Verify its email and enable TOTP.
3. Bootstrap/assign `super_admin` using the controlled one-shot mechanism. Do not hard-code an email and do not expose a hidden URL.
4. Serve the exact HTTPS origin, configure the exact WebAuthn RP ID/name, and keep `ADMIN_WEBAUTHN_REQUIRED=true` with `ADMIN_PRIVILEGED_ROLES=super_admin,admin` (or an explicitly reviewed expansion).
5. Log in, perform password+TOTP bootstrap enrollment and register a primary plus an independent backup authenticator. Confirm both credentials work before relying on enforcement.
6. Generate recovery codes once, store them offline under two-person operational custody where possible, then verify the UI no longer reveals plaintext after refresh.
7. Prove one read-only operation without a prompt and one reversible critical test-persona operation with a fresh WebAuthn step-up.
8. Confirm security email delivery, login/step-up/recovery rate limits, session revocation and last-super-admin rejection.
9. Remove bootstrap allowlists/tokens and rotate the bootstrap password after credential enrollment.
10. Optionally put `admin.example.com`, `/api/v1/admin/*` and the required `/api/auth/*` flows behind a correctly verified identity-aware proxy policy. Keep application authorization enabled.
11. Execute the separately approved cleanup checklist and capture release evidence.

## N. Pre-production cleanup

Use [PRE_PRODUCTION_CLEANUP_CHECKLIST.md](./PRE_PRODUCTION_CLEANUP_CHECKLIST.md). This security task intentionally did not delete QA accounts, audit history or launch evidence.

## Final security questions

| Question | Answer |
|---|---|
| Can knowing `/admin` alone help an attacker bypass authentication? | **NO** |
| Can a normal customer call an admin API directly? | **NO** |
| Can support/moderator self-promote? | **NO** |
| Can admin become super_admin without the required security permission? | **NO** |
| Can the final super_admin accidentally remove all privileged access? | **NO** through the normal UI/API or direct row update/delete protected by the invariant |
| Can an expired privileged step-up authorize a critical mutation? | **NO** |
| Can losing one security key permanently lock out an appropriately configured super_admin? | **NO**, when the recommended backup credential/recovery codes were configured and retained |
| Does Cloudflare Access become the sole authorization mechanism? | **NO** |
| Can another moderator/support/admin be added later without auth/database redesign? | **YES** |
