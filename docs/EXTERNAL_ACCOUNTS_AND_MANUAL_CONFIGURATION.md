# External accounts and manual launch configuration

This checklist contains work that cannot be completed by repository code. Do not accept live revenue until every required item has an owner and evidence.

## Required before launch

- [ ] Ubuntu 24.04 LTS VDS with 10 vCPU, 12 GB RAM and at least 200 GB NVMe.
- [ ] Production domain and authoritative DNS access.
- [ ] TLS certificate and renewal monitoring. Cloudflare is optional; do not list it as a processor unless it is actually enabled.
- [ ] Paddle seller account, applicable identity/business verification and approved production domain.
- [ ] Paddle products and monthly prices for Signal and Studio. Enterprise is Contact/invite-only at launch.
- [ ] Resend account and verified sending domain.
- [ ] OpenRouter account, server-side API key and sufficient credits for the configured paid model.
- [ ] UptimeRobot or an equivalent external HTTPS monitor.
- [ ] Operator-controlled `age` backup identity and an encrypted off-VDS backup destination.
- [ ] Operator/invoicing/tax-accounting setup reviewed before accepting live revenue.
- [ ] Published operator identity, address and support contact reviewed for accuracy.
- [ ] Actual VDS/hosting provider, region and privacy/DPA reference recorded in the public subprocessor register; optional edge/CDN provider recorded only if enabled.

## Paddle

1. Complete seller verification and production-domain review in Paddle.
2. Configure the approved HTTPS website with accurate product descriptions, prices, recurring interval, support contact, Terms, Privacy and Refund links.
3. Create monthly recurring prices for Signal and Studio; copy the price IDs to `PADDLE_PRICE_SIGNAL` and `PADDLE_PRICE_STUDIO`.
4. Keep Enterprise unavailable to automatic checkout until real human-review capacity is approved. `ENTERPRISE_SALES_MODE=contact` is the launch default.
5. Create a webhook destination at `https://<domain>/api/v1/billing/webhook` and subscribe to subscription, transaction and adjustment/refund lifecycle events used by the application.
6. Copy the API key and endpoint secret to the secret store as `PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET`. Never expose either value to website JavaScript.
7. Run the Paddle sandbox lifecycle smoke test, including duplicate and deliberately out-of-order fixtures, before changing `PADDLE_ENVIRONMENT` to `production`.
8. Confirm that cancellation and payment-method recovery links open through a fresh customer-portal session; portal URLs must not be cached or embedded.

Authority: [Paddle subscription provisioning](https://developer.paddle.com/build/subscriptions/provision-access-webhooks), [signature verification](https://developer.paddle.com/webhooks/about/signature-verification/), [customer portal sessions](https://developer.paddle.com/api-reference/customer-portals/create-customer-portal-session), [domain verification](https://www.paddle.com/help/start/account-verification/what-is-domain-verification), [Buyer Terms](https://www.paddle.com/legal/buyer-terms), and [Refund Policy](https://www.paddle.com/legal/refund-policy).

## Resend

1. Add the production sending domain in Resend.
2. Publish exactly the SPF and DKIM records shown by Resend and wait for verification.
3. Create a sending-only API key and store it only in the email-service environment as `RESEND_API_KEY`.
4. Set `EMAIL_FROM` to a verified-domain mailbox and `SUPPORT_EMAIL` to the monitored customer-support address.
5. Test verification, password reset and support-reply notifications with designated operator test accounts. Do not use real customer addresses during pre-launch testing.
6. Monitor bounces/complaints and rotate the key after suspected exposure.

## OpenRouter

1. Create a server-side API key and store it only in the AI-service environment as `OPENROUTER_API_KEY`.
2. Set the approved application origin and title in `OPENROUTER_SITE_URL` and `OPENROUTER_APP_NAME`.
3. Use the checked-in evaluation harness against candidate models only after explicit cost approval. Record the selected stable low-cost model in `OPENROUTER_MODEL_PRIMARY` and ordered compatible fallbacks in `OPENROUTER_MODEL_FALLBACKS`.
4. Keep `OPENROUTER_DATA_COLLECTION=deny`; enable `OPENROUTER_ZDR=true` only when the selected providers support the required routing constraint and the resulting availability is accepted.
5. Configure the daily soft and hard USD limits. A hard limit disables AI remediation, not core scans.

Authority: [OpenRouter app attribution](https://openrouter.ai/docs/app-attribution), [model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection), and [data collection controls](https://openrouter.ai/docs/guides/privacy/data-collection).

## YellowLab.tools external analysis

1. YellowLab.tools does not require a customer account for the current public API integration, but it is still an external recipient of the public target URL and performance-job metadata.
2. Keep `REQUIRE_EXTERNAL_PROVIDER_CONSENT=true`. Each scan must show the disclosure and record a fresh confirmation; a prior scan's confirmation is not reusable.
3. Do not send cookies, authorization headers, uploaded source archives, account identifiers or private credentials. Only an already-authorized public target URL is eligible.
4. Keep YellowLab.tools in Privacy/Subprocessors while the integration is enabled, and re-review its public service/privacy terms before production activation.
5. If the provider becomes unavailable or its terms no longer fit the product, disable that analyzer and expose a partial-result state rather than silently routing the data elsewhere.

The production UI and worker enforce the per-scan boundary; no live external call was made as part of repository hardening.

## DNS, TLS and optional Cloudflare

1. Point the application hostname to the VDS.
2. Permit inbound TCP 80/443 only; restrict SSH to operator addresses or a private access path. Do not expose PostgreSQL, worker, ZAP, AI-service or email-service ports.
3. Obtain and automatically renew a valid TLS certificate before setting production URLs.
4. If Cloudflare proxying is enabled, record it in Privacy/Subprocessors, configure the origin certificate and trusted proxy policy, and verify that the application receives the intended client IP chain. Do not enable analytics or marketing tracking in this launch task.

## Uptime and operations

1. Monitor `https://<domain>/healthz` every five minutes or faster.
2. Alert on consecutive non-2xx responses and certificate expiry.
3. Keep `/readyz` for deployment/orchestrator readiness; private queue, database and provider diagnostics remain authenticated.
4. Configure host alerts for disk usage, memory pressure, container restarts and backup age.
5. Assign an incident contact for billing webhook, AI-provider and email-delivery errors.

## Backup custody

1. Install `age` and create the encryption identity on an operator-controlled device, not the VDS.
2. Put only the public recipient in `BACKUP_AGE_RECIPIENT`.
3. Schedule `infra/backup/backup-postgres.sh` and copy encrypted output plus checksums off the VDS.
4. Run `infra/backup/restore-check-postgres.sh` against a recent backup at least monthly and after material schema changes.
5. Record backup and restore evidence without copying customer data or credentials into tickets/logs.

No paid observability, CRM, analytics, email-marketing or enterprise platform subscription is required for this small launch.
