# Production environment matrix

Copy the root `production.environment.template` to a permission-`0600` `.env` file outside Git.
Values below are configuration contracts, not production credentials. Generate
independent random values; do not reuse secrets across rows. “Required” means
required for the launch topology, even when Compose supplies a fixed internal
value rather than asking the operator to type it.

## APP

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `PUBLIC_ORIGIN` | yes | no | `https://app.example.com` | Owned DNS/TLS origin; change only with coordinated auth/Paddle/OpenRouter/DNS update | backend, email-service, frontend build/proxy |
| `FRONTEND_PORT` | no | no | `8080` | Localhost-only host listener; change with host Nginx upstream | frontend |
| `MAX_CONCURRENT_ANALYSES` | yes | no | `1` | Launch capacity policy; raise only after load evidence | backend, analysis-worker |
| `MAX_QUEUED_ANALYSES` | yes | no | `8` | Operator capacity policy | backend, analysis-worker |
| `LEGACY_API_ENABLED` | yes | no | `false` | Keep false in production | backend |
| `LEGACY_API_ALLOW_UNAUTHENTICATED_DEVELOPMENT` | yes | no | `false` | Development-only; never enable in production | backend |

## DATABASE

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `POSTGRES_TLS_DIR` | yes | path | `/srv/webpage-analyzer/secrets/postgres-tls` | Operator-generated CA/server material; rotate certificate before expiry | postgres, bootstrap, migrator, grants, backend, workers |
| `POSTGRES_ADMIN_USER` | no | no | `postgres` | Bootstrap login name; set explicitly only for an existing volume initialized under another administrator role | postgres, one-shot db-bootstrap/db-grants only |
| `POSTGRES_ADMIN_PASSWORD` | yes | yes | `<random-48-plus-chars>` | Operator password manager; rotate in a maintenance window | postgres, one-shot db-bootstrap/db-grants only |
| `POSTGRES_PASSWORD` | no | yes | empty | Compatibility alias only; omit when `POSTGRES_ADMIN_PASSWORD` is set | postgres bootstrap interpolation only |
| `POSTGRES_RUNTIME_PASSWORD` | yes | yes | `<random-48-plus-chars>` | Operator password manager; rotate independently | backend |
| `POSTGRES_MIGRATOR_PASSWORD` | yes | yes | `<random-48-plus-chars>` | Operator password manager; one-shot rotation | db-migrate |
| `POSTGRES_WORKER_PASSWORD` | yes | yes | `<random-48-plus-chars>` | Operator password manager; rotate then restart worker | analysis-worker |
| `POSTGRES_MAINTENANCE_PASSWORD` | yes | yes | `<random-48-plus-chars>` | Operator password manager; rotate then restart maintenance worker | maintenance-worker |
| `POSTGRES_QUEUE_PASSWORD` | yes | yes | `<random-48-plus-chars>` | Operator password manager; rotate with queue bootstrap/runtime review | db-migrate/queue |
| `DATABASE_SSLMODE` | yes | no | `require` | Production security policy; overlay supplies trusted CA | backend, analysis-worker, maintenance-worker |
| `MIGRATION_DATABASE_SSLMODE` | yes | no | `require` | Production security policy | db-migrate, queue bootstrap |
| `MIGRATION_REQUIRE_TLS` | yes | no | `true` | Keep true | db-migrate |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | yes | no | `true` | Keep true; disabling fails startup | backend, workers, migrator |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | no | no | `5` | Operational tuning | every database client |
| `DATABASE_STATEMENT_TIMEOUT_MS` | no | no | `30000` | Operational tuning | runtime/worker/queue URLs |
| `DATABASE_LOCK_TIMEOUT_MS` | no | no | `10000` | Operational tuning | runtime/worker/queue URLs |
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | no | no | `60000` | Operational tuning | runtime/worker/queue URLs |
| `MIGRATION_STATEMENT_TIMEOUT_MS` | no | no | `30000` | Migration policy | db-migrate |
| `MIGRATION_LOCK_TIMEOUT_MS` | no | no | `10000` | Migration policy | db-migrate |
| `MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT_MS` | no | no | `60000` | Migration policy | db-migrate |

## AUTH

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | yes | yes | `<random-64-plus-chars>` | Operator password manager; rotation invalidates/significantly affects sessions, so use a planned window | backend only |
| `API_KEYS` | no | yes | empty | Optional scoped compatibility/API access; rotate per consumer | backend only |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | mixed | empty | GitHub OAuth app; rotate secret in provider console | backend only |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | no | mixed | empty | GitLab OAuth app; rotate secret in provider console | backend only |
| `BITBUCKET_CLIENT_ID` / `BITBUCKET_CLIENT_SECRET` | no | mixed | empty | Bitbucket OAuth app; rotate secret in provider console | backend only |
| `BOOTSTRAP_ADMIN_TOKEN` | one-shot | yes | `<random-64-plus-chars>` | Generate for the one-time bootstrap command, consume once, then remove from shell/history/secret store | `backend/scripts/bootstrap-admin.js` only; never a long-running container |

## ADMIN

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `ADMIN_API_KEYS` | no | yes | empty | Optional non-browser automation keys; rotate per client | backend only |
| `ADMIN_REAUTH_MAX_AGE_MS` | yes | no | `600000` | Security policy | backend |
| `ADMIN_RATE_LIMIT_WINDOW_MS` / `ADMIN_RATE_LIMIT_MAX` | no | no | `900000` / `600` | Abuse policy, independent from customer budgets | backend |
| `ADMIN_REAUTH_RATE_LIMIT_WINDOW_MS` / `ADMIN_REAUTH_RATE_LIMIT_MAX` | no | no | `900000` / `5` | Step-up brute-force policy | backend |
| `ADMIN_MUTATION_RATE_LIMIT_WINDOW_MS` / `ADMIN_MUTATION_RATE_LIMIT_MAX` | no | no | `900000` / `60` | Dangerous-operation budget | backend |

## BILLING

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `PAYMENTS_ENABLED` | yes | no | `false` | Keep `false` for Free + redeem-only early access. Set `true` only when the complete paid-provider contract below is ready. | backend, public pricing/access state |
| `BILLING_PROVIDER` | yes | no | `paddle` | Fixed launch provider; production rejects another default | backend |
| `ENTERPRISE_SALES_MODE` | yes | no | `contact` | Operator fulfillment decision; `contact` or `invite_only` | backend, public catalog/legal config |
| `PADDLE_ENVIRONMENT` | paid mode only | no | `sandbox` then `production` | Paddle dashboard; change only after sandbox acceptance and live account approval | backend |
| `PADDLE_API_KEY` | paid mode only | yes | `<Paddle server API key>` | Required when `PAYMENTS_ENABLED=true`; rotate/revoke in Paddle, then restart backend | backend only |
| `PADDLE_WEBHOOK_SECRET` | paid mode only | yes | `<Paddle endpoint secret>` | Required when `PAYMENTS_ENABLED=true`; rotate with overlap/cutover plan | backend only |
| `PADDLE_PRICE_SIGNAL` | paid mode only | no | `pri_...` | Required when `PAYMENTS_ENABLED=true`; Paddle monthly Signal price | backend only; public API returns catalog facts, never secret |
| `PADDLE_PRICE_STUDIO` | paid mode only | no | `pri_...` | Required when `PAYMENTS_ENABLED=true`; Paddle monthly Studio price | backend only |
| `PADDLE_PRICE_ENTERPRISE` | no | no | empty | Leave empty while Enterprise is contact/invite-only | backend only |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | no | yes | empty | Optional legacy/dev adapter credentials; rotate/revoke in Stripe if that adapter is deliberately used | none in launch topology |
| `STRIPE_PRICE_SIGNAL` / `STRIPE_PRICE_STUDIO` / `STRIPE_PRICE_ENTERPRISE` | no | no | empty | Optional legacy/dev catalog identifiers; leave empty for the Paddle launch | none in launch topology |

With `PAYMENTS_ENABLED=false`, production deliberately starts without Paddle
credentials or price IDs. Checkout, portal, cancellation, reconciliation and
webhook mutations return `PAYMENTS_DISABLED`; Free signup, redeem codes and
administrator grants remain active. With `PAYMENTS_ENABLED=true`, the API keeps
the existing fail-closed Paddle validation and refuses to start until every
required server credential and Signal/Studio price mapping is present.

## EMAIL

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `EMAIL_PROVIDER` | yes | no | `resend` | Fixed launch provider | email-service and backend policy |
| `EMAIL_DELIVERY_ENABLED` | yes | no | `true` | Must remain true in production | backend |
| `EMAIL_SERVICE_TOKEN` | yes | yes | `<random-64-plus-chars>` | Internal service token; rotate on backend and email-service together | backend, email-service |
| `RESEND_API_KEY` | yes | yes | `re_...` | Sending-only Resend key; rotate in Resend | email-service only |
| `EMAIL_FROM` | yes | no | `WebPageAnalyzer <noreply@mail.example.com>` | Must use a Resend-verified domain | backend templates, email-service |
| `SUPPORT_EMAIL` | yes | limited personal | `support@usewpa.tech` | Monitored WebPageAnalyz support mailbox | backend, email-service, public contact copy |
| `EMAIL_PROVIDER_HOST_ALLOWLIST` | yes | no | `api.resend.com` | Fixed provider boundary | email-service only |
| `EMAIL_PROVIDER_TIMEOUT_MS` | no | no | `10000` | Bounded provider timeout | email-service only |

## AI

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `AI_PROVIDER` | yes | no | `openrouter` | Fixed production gateway | ai-service and backend policy |
| `AI_SERVICE_TOKEN` | yes | yes | `<random-64-plus-chars>` | Internal service token; rotate on backend and ai-service together | backend, ai-service |
| `OPENROUTER_API_KEY` | yes | yes | `sk-or-v1-...` | OpenRouter server key; rotate/revoke in OpenRouter | ai-service only |
| `OPENROUTER_MODEL_PRIMARY` | yes | no | `<evaluated-provider/model>` | Deployment-time choice from official model metadata and evaluation harness; also keys the durable API cache/usage reservation | backend, ai-service |
| `OPENROUTER_MODEL_FALLBACKS` | no | no | `provider/model-a,provider/model-b` | Ordered evaluated fallback list | backend policy metadata, ai-service routing |
| `OPENROUTER_SITE_URL` | yes | no | `https://app.example.com` | Maps to server-side `HTTP-Referer` attribution | ai-service only |
| `OPENROUTER_APP_NAME` | yes | no | `WebPageAnalyzer` | Maps to server-side `X-OpenRouter-Title` | ai-service only |
| `OPENROUTER_DATA_COLLECTION` | yes | no | `deny` | Official provider-routing preference; verify after account/policy changes | ai-service only |
| `OPENROUTER_ZDR` | yes | no | `false` | Request preference only; set true only after verifying compatible routing and do not market it as an unconditional guarantee | ai-service only |
| `OPENROUTER_METADATA_ENABLED` | yes | no | `true` | Enables accounting/routing metadata request | ai-service only |
| `AI_MAX_REQUESTS_PER_MINUTE` | yes | no | `30` | Global abuse guardrail, separate from plan quota | ai-service |
| `AI_MAX_CONCURRENT_REQUESTS` | yes | no | `2` | Global concurrency guardrail | ai-service |
| `AI_MAX_INPUT_TOKENS` | yes | no | `4096` | Fail-closed tokenizer-independent upper bound | ai-service |
| `AI_MAX_OUTPUT_TOKENS` | yes | no | `1200` | Provider generation bound | ai-service |
| `AI_DAILY_COST_SOFT_LIMIT_USD` | yes | no | `5` | Alert threshold; tune from measured usage | backend/store policy |
| `AI_DAILY_COST_HARD_LIMIT_USD` | yes | no | `10` | Emergency stop threshold; must not be below soft limit | backend/store policy |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | no | yes/no | empty | Optional legacy/dev adapter; never production default or production Compose input | none in launch topology |

## WORKER

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `ZAP_API_KEY` | yes | yes | `<random-64-plus-chars>` | Operator-generated internal token; rotate on ZAP and worker together | ZAP, analysis-worker only |
| `ENGINE_LAB_SERVICE_TOKEN` | yes | yes | `<random-64-plus-chars>` | Internal control-channel token; rotate on backend and analysis-worker together | backend, analysis-worker |
| `OSV_SCANNER_PATH` | yes | no | `/usr/local/bin/osv-scanner` | Image-owned executable path | analysis-worker |
| `OSV_ISOLATION_RUNNER` / `OSV_ISOLATION_ARGS` | for OSV | no | deployment-specific | Reviewed no-network sandbox command and fixed arguments; blank keeps OSV unavailable | analysis-worker |
| `ENGINE_LAB_MAX_CONCURRENT_RUNS` / `ENGINE_LAB_MAX_QUEUED_RUNS` | no | no | `1` / `8` | Process-global hostile-job admission bounds | analysis-worker |
| `ENGINE_LAB_ARTIFACT_TTL_MS` / `ENGINE_LAB_SHUTDOWN_DRAIN_MS` | no | no | `86400000` / `15000` | Private screenshot expiry and bounded shutdown drain | analysis-worker |
| `RETENTION_POLL_MS` | no | no | `21600000` | Retention scheduling policy | maintenance-worker |
| `WORKER_LEASE_MS` | no | no | `900000` | Lease/recovery policy | maintenance-worker |
| `CRAWLER_MAX_SITEMAPS` | no | no | `20` | Discovery safety bound | backend/worker crawler config |
| `CRAWLER_MAX_SITEMAP_DEPTH` | no | no | `3` | Discovery safety bound | backend/worker crawler config |
| `CRAWLER_MAX_SITEMAP_URLS` | no | no | `5000` | Discovery safety bound | backend/worker crawler config |
| `CRAWLER_MAX_SITEMAP_BYTES` | no | no | `2097152` | Compressed/input bound | backend/worker crawler config |
| `CRAWLER_MAX_SITEMAP_DECOMPRESSED_BYTES` | no | no | `8388608` | Decompression-bomb bound | backend/worker crawler config |
| `CRAWLER_MAX_PATH_DEPTH` | no | no | `12` | Crawler-trap bound | backend/worker crawler config |
| `CRAWLER_MAX_QUERY_VARIANTS_PER_PATH` | no | no | `5` | Query-explosion bound | backend/worker crawler config |
| `REQUIRE_EXTERNAL_PROVIDER_CONSENT` | yes | no | `true` | Keep true: the public target URL may be submitted to YellowLab only after an explicit, per-scan disclosure | analysis-worker |
| `ANALYSIS_TIMEOUT_MS` / `LIGHTHOUSE_TIMEOUT_MS` / `AXE_TIMEOUT_MS` | no | no | `240000` / `180000` / `90000` | Bounded analyzer execution policy | analysis-worker |
| `YELLOWLAB_TIMEOUT_MS` / `YELLOWLAB_MAX_POLL_ATTEMPTS` | no | no | `150000` / `24` | External analyzer timeout and polling bound | analysis-worker |
| `AI_TIMEOUT_MS` | no | no | `45000` | Internal AI request timeout; change only with provider and queue evidence | backend |
| `ALLOWED_TARGET_PORTS` | yes | no | `80,443` | SSRF policy; do not widen without a security review | backend, analysis-worker |
| `PROXY_CONNECT_TIMEOUT_MS` / `PROXY_MAX_CONNECTIONS` | no | no | `10000` / `100` | Safe-proxy capacity limits | backend, analysis-worker |
| `PROXY_MAX_RESPONSE_BYTES` / `PROXY_MAX_TOTAL_BYTES` | no | no | `26214400` / `262144000` | Per-response and aggregate fetch bounds | backend, analysis-worker |

## SECURITY

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `SOURCE_ENCRYPTION_KEY` | yes | yes | `<32-byte base64 key>` | Generate from a CSPRNG; rotation needs artifact re-encryption/retention plan | backend, analysis-worker only |
| `LOGIN_RATE_LIMIT_WINDOW_MS` / `LOGIN_RATE_LIMIT_MAX` | no | no | `900000` / `10` | Login brute-force policy | backend |
| `PASSWORD_RESET_RATE_LIMIT_WINDOW_MS` / `PASSWORD_RESET_RATE_LIMIT_MAX` | no | no | `3600000` / `5` | Reset abuse policy | backend |
| `REDEEM_RATE_LIMIT_WINDOW_MS` / `REDEEM_RATE_LIMIT_MAX` | no | no | `900000` / `10` | Redeem brute-force policy | backend |

## STORAGE

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `BACKUP_AGE_RECIPIENT` | yes for backup job | public recipient | `age1...` | Operator-controlled age identity; rotate with overlapping decrypt identities | backup script only |
| `BACKUP_REQUIRE_ENCRYPTION` | yes | no | `true` | Keep true in production | backup script only |

Artifact/source/result directories are Compose-owned fixed paths and named
volumes; do not point them at arbitrary host paths through production `.env`.

## OBSERVABILITY

No paid observability provider is required. `/healthz` is the public uptime
target; `/readyz` is the deployment probe. Configure the external monitor URL,
contacts and escalation in its dashboard, not as application secrets. Rate,
timeout, queue-depth, disk, memory, database, AI, email and Paddle failures are
emitted through structured container logs.

## LEGAL

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `LEGAL_OPERATOR_NAME` | yes | no | `<actual operator name>` | Operator-approved factual identity; update only when legally changed | backend public legal config, website |
| `LEGAL_OPERATOR_TYPE` | no | no | `<actual type or empty>` | Never invent a company type | backend public legal config, website |
| `LEGAL_COUNTRY` | yes | no | `TR` | Actual operator jurisdiction | backend public legal config, website |
| `LEGAL_BUSINESS_ADDRESS` | yes | personal/business | `<actual service address>` | Operator-approved factual address | backend public legal config, website |
| `LEGAL_SUPPORT_EMAIL` | yes | limited personal | `support@usewpa.tech` | Actual support/privacy contact | backend public legal config, website |
| `LEGAL_SUPPORT_PHONE` | no | personal | empty | Publish only when operator chooses a real number | backend public legal config, website |
| `LEGAL_EFFECTIVE_DATE` | yes | no | `2026-08-15` | Publication date for v1 documents | backend public legal config, website |
| `LEGAL_HOSTING_PROVIDER_NAME` | yes | no | `<actual VDS provider>` | Actual production infrastructure processor; changing host requires register review | backend public legal config, website |
| `LEGAL_HOSTING_PROVIDER_REGION` | no | no | `<officially confirmed region>` | Publish only a provider-confirmed processing/hosting location | backend public legal config, website |
| `LEGAL_HOSTING_PROVIDER_PRIVACY_URL` | no | no | `https://provider.example/privacy` | Actual provider privacy/DPA reference | backend public legal config, website |
| `LEGAL_EDGE_PROVIDER_NAME` | no | no | `Cloudflare` | Set only when an edge/DNS proxy actually processes requests | backend public legal config, website |
| `LEGAL_EDGE_PROVIDER_REGION` | no | no | empty | Publish only an officially supported statement | backend public legal config, website |
| `LEGAL_EDGE_PROVIDER_PRIVACY_URL` | no | no | `https://provider.example/privacy` | Actual edge-provider privacy/DPA reference | backend public legal config, website |

Production startup fails closed when required operator facts are missing. The
website must not render placeholder company, address, registration, tax or VAT
information.

## Complete runtime and compatibility variables

These rows close the inventory for variables that are image-owned, Compose-owned,
or optional development compatibility inputs. They are not extra launch secrets.
An operator must not override the production fixed values unless the architecture
and full container/security acceptance suite are reviewed again.

| Name | Required | Secret | Safe example | Source and rotation | Used by |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` / `EXECUTION_ROLE` / `PORT` | Compose-owned | no | `production` / `api` / `5000` | Fixed per image/service; change through reviewed Compose configuration | backend, workers, ai-service, email-service |
| `APP_URL` / `BETTER_AUTH_URL` | Compose-owned | no | `https://app.example.com` | Derived from `PUBLIC_ORIGIN`; rotate with DNS/TLS/auth callback changes | backend |
| `CORS_ORIGINS` / `TRUST_PROXY` | Compose-owned | no | `https://app.example.com` / `true` | Derived from the public origin and reverse-proxy topology | backend |
| `DATABASE_URL` / `QUEUE_DATABASE_URL` | Compose-owned | yes | role-scoped PostgreSQL URL | Built from separate role passwords; rotate the corresponding role credential | backend, workers, migrator/queue |
| `DATABASE_EXPECTED_ROLE` / `MIGRATION_EXPECTED_ROLE` | Compose-owned | no | `wpa_runtime` / `wpa_migrator` | Least-privilege role assertion fixed per process | backend, workers, migrator |
| `AI_SERVICE_URL` / `EMAIL_SERVICE_URL` | Compose-owned | no | `http://ai-service:5010` / `http://email-service:5020` | Internal Docker DNS endpoints; architecture-owned | backend |
| `EMAIL_PROVIDER_URL` | no | no | `https://api.resend.com/emails` | Resend endpoint; production allowlist still applies | email-service/local compatibility transport |
| `REQUEST_BODY_LIMIT` | no | no | `32kb` | API parsing bound | backend |
| `ANALYZE_RATE_LIMIT_WINDOW_MS` / `ANALYZE_RATE_LIMIT_MAX` | no | no | `3600000` / `10` | Scan abuse policy, separate from page credits | backend |
| `AI_RATE_LIMIT_WINDOW_MS` / `AI_RATE_LIMIT_MAX` | no | no | `3600000` / `20` | Customer-facing AI route abuse policy, separate from monthly AI quota | backend |
| `ARTIFACT_DIR` / `SOURCE_ARTIFACT_DIR` / `WORKER_RESULT_DIR` | Compose-owned | path | `/app/worker-artifacts` / `/app/logs/source-inputs` / `/app/worker-results` | Image/named-volume paths; never point at arbitrary host directories | backend, analysis-worker, maintenance-worker |
| `KEEP_ANALYZER_ARTIFACTS` | Compose-owned | no | `false` | Data-minimization policy; keep false | analysis-worker |
| `CHROME_PATH` / `CHROME_NO_SANDBOX` | Compose-owned | no | `/usr/bin/chromium` / `false` | Image-owned browser path; no-sandbox is rejected in production | analysis-worker |
| `WORKER_ENABLED` / `WORKER_HANDLER_MODULE` / `WORKER_SANDBOX_REQUIRED` | Compose-owned | no | `true` / `/app/platform/worker-handler.js` / `true` | Fixed worker execution boundary | analysis-worker, maintenance-worker |
| `BROWSER_EXECUTION_DISABLED` / `PDF_EXECUTION_DISABLED` / `SOURCE_EXECUTION_DISABLED` / `OSV_EXECUTION_DISABLED` | Compose-owned | no | API: all `true`; worker: job-specific | Production role separation; API and maintenance fail closed if local execution is enabled | backend, workers |
| `SOURCE_UPLOAD_MAX_BYTES` | no | no | `52428800` | Encrypted source-upload input bound | backend, analysis-worker |
| `BOOTSTRAP_ADMIN_EMAILS` | one-shot | limited personal | `admin@example.com` | Allowlist for first-admin bootstrap; remove after the controlled bootstrap | bootstrap-admin script |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | mixed | empty | Optional Google OAuth app; rotate the secret in the provider console | backend only |

The backend also recognizes additional test/lab and tuning inputs
(`DEMO_WORKSPACE_ID`, `OPENROUTER_BASE_URL`, `PADDLE_API_BASE_URL`,
`EMAIL_PROVIDER_API_KEY`, `ADMIN_API_KEY`, `VERIFICATION_TTL_MS`,
`DATABASE_CONNECTION_TIMEOUT_MS`, `DATABASE_IDLE_TIMEOUT_MS`,
`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`,
`AUTH_RATE_LIMIT_MAX`, `SUPPORT_RATE_LIMIT_WINDOW_MS`, `SUPPORT_RATE_LIMIT_MAX`,
`SUPPORT_ADMIN_RATE_LIMIT_WINDOW_MS`, `SUPPORT_ADMIN_RATE_LIMIT_MAX`,
`MAX_CONCURRENT_PDF_EXPORTS`, `MAX_QUEUED_PDF_EXPORTS`,
`REPORT_PAYLOAD_MAX_BYTES`, `WEBHOOK_OUTBOX_BATCH_SIZE`,
`WEBHOOK_OUTBOX_POLL_MS`, `SOURCE_STAGING_JANITOR_MS`,
`SOURCE_ARTIFACT_JANITOR_MS`, `WPA_PAGE_TIMEOUT_MS`,
`ADVANCED_BROWSER_TIMEOUT_MS`, `ZAP_TIMEOUT_MS`, `OSV_TIMEOUT_MS`,
`ZAP_URL`, `ZAP_PROXY_BIND_HOST`, `ZAP_PROXY_ADVERTISED_HOST`,
`ZAP_MAX_URLS`, `ZAP_MAX_ALERTS`, `ZAP_MAX_POLL_ATTEMPTS`,
`OSV_ISOLATION_RUNNER`, and `OSV_ISOLATION_ARGS`). Production Compose either
pins or intentionally omits these; they are not operator-supplied launch
credentials. Provider base-URL overrides are test-only and must never redirect
production secrets to an unreviewed host.
