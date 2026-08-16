# Pre-production cleanup checklist

This checklist is intentionally non-executable. Cleanup must be a separately approved release operation with a backup, an inventory, exact target IDs and a post-cleanup verification record. Do not delete migration history or security evidence merely because it was created during acceptance.

## 1. Establish the release boundary

- [ ] Record the target environment, database name, deployment revision and operator.
- [ ] Take and verify a restorable database backup before destructive cleanup.
- [ ] Export an ID-level inventory for every row selected for removal; do not use broad email-domain or date-only deletion predicates.
- [ ] Confirm that the inventory contains only WebPageAnalyzer QA data and no real customer, billing-provider or legal records.
- [ ] Run cleanup through an audited maintenance/admin path or a reviewed transaction; never grant the API runtime role broad delete authority for convenience.

## 2. Disposable QA identities and commercial state

- [ ] Review the local Free/Signal/Studio/Enterprise QA identities and remove them only from the production seed/import set.
- [ ] Replace the local QA administrator identity with a dedicated production privileged identity. Verify email, TOTP, two independent WebAuthn credentials and recovery-code custody before retiring bootstrap access.
- [ ] Remove temporary QA plan changes, entitlement grants, page/AI credit adjustments and test subscriptions by their immutable IDs.
- [ ] Disable/revoke test redeem codes and review linked redemptions/grants before removal.
- [ ] Remove test organization memberships only after confirming the workspace has another intended owner where required.

## 3. QA operational data

- [ ] Inventory test projects, target authorizations, scans, findings, reports, share links and worker artifacts; retain release evidence required by the launch decision.
- [ ] Remove QA support tickets, messages and internal notes only when they are not needed as acceptance evidence.
- [ ] Remove Engine Lab runs and generated screenshots by their managed artifact IDs/directories, never by a broad filesystem path.
- [ ] Clear disposable checkout acceptances/provider sandbox events only after confirming that no live provider identifier is present.
- [ ] Review test webhook endpoints/outbox events and remove only the explicitly inventoried QA rows.

## 4. Credentials and local-only configuration

- [ ] Remove `BOOTSTRAP_ADMIN_EMAILS` and consume/disable every one-shot bootstrap token after the production privileged identity is proven.
- [ ] Rotate any secret ever used outside the intended secret manager: Better Auth, database roles, internal service tokens, Paddle/Resend/OpenRouter, source encryption, ZAP and API/admin API keys.
- [ ] Remove local acceptance passwords, exported TOTP material, browser storage states and temporary environment files from release artifacts.
- [ ] Confirm production does not enable `ADMIN_REAUTH_SESSION_LIFETIME`, development CORS origins, plaintext PostgreSQL, debug logging or a memory store.
- [ ] Confirm `ADMIN_WEBAUTHN_REQUIRED=true`, the exact production RP ID/origin and the intended privileged-role list.

## 5. Evidence that must be preserved

- [ ] Preserve the complete migration ledger and checksums, including `040_privileged_access_security.sql` and `041_privileged_admin_set_lock.sql`.
- [ ] Preserve security-relevant audit records such as role changes, privileged logins, WebAuthn enrollment/removal, recovery use, MFA reset, password reset/change and failed/successful step-up.
- [ ] Preserve legally required acceptance/billing records according to the retention policy; QA cleanup is not a reason to erase statutory evidence.
- [ ] Preserve the release reports and selected browser evidence used to approve production.
- [ ] If disposable audit noise may legally be removed, approve exact event IDs separately; never truncate `wpa_audit_log`.

## 6. Post-cleanup acceptance

- [ ] Exactly the intended active super administrators remain; the last-super-admin invariant still rejects a downgrade/removal attempt.
- [ ] Every privileged identity has the intended role, verified email, TOTP and required WebAuthn enrollment.
- [ ] No QA user, temporary grant, credit adjustment, redeem code, support ticket or test checkout remains in the production inventory.
- [ ] Customer login, read-only admin navigation and one reversible test-persona privileged mutation pass after cleanup.
- [ ] Migration validation, runtime grants, health/readiness, website build and privileged browser acceptance pass against the release artifact.
- [ ] Record remaining rows, removed row counts, backup reference, operator, timestamp and rollback result in the release evidence.
