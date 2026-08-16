# Support API contract

Support is a workspace-scoped, session-authenticated ticket workflow. The API
does not send email or claim that an external notification was delivered;
responses expose `notificationState.externalEmail: "not_configured"`.

Customer routes use the active workspace membership:

- `POST /api/v1/support/tickets` with `{category, subject, message, context?, targetUrl?, reportId?, priority?}` (the server also accepts `body` in place of `message`). `Idempotency-Key` is optional and, when present, is unique per workspace.
- For the current portal composer, a body ending in `\n\n— Context —\n` followed by `Category:`, `Context:`, `Target URL:`, and `Report ID:` lines is parsed into the same structured fields; the public message keeps only the customer narrative.
- `GET /api/v1/support/tickets?limit=&cursor=&status=&priority=`
- `GET /api/v1/support/tickets/:id`
- `POST /api/v1/support/tickets/:id/messages` (alias: `/replies`) with `{body}`
- `PATCH /api/v1/support/tickets/:id` with `{status: "open"|"closed"}`
- `POST /api/v1/support/tickets/:id/close` and `/reopen`

Customer responses contain only public messages. An ID from another workspace
returns `404 SUPPORT_TICKET_NOT_FOUND`, including for ticket detail and reply.
Successful creation returns `201 {ticket}`; an idempotent replay returns
`200 {ticket}`. List responses are `{tickets, limit, nextCursor}` and detail
or mutation responses are `{ticket}`.

The active session administrator queue is cross-workspace and role-gated:

- `GET /api/v1/admin/support/tickets?limit=&cursor=&status=&priority=&assignee=`
- `GET /api/v1/admin/support/tickets/:id`
- `PATCH /api/v1/admin/support/tickets/:id` with `{status?, priority?, assigneeId?}`
- `POST /api/v1/admin/support/tickets/:id/messages` (alias: `/replies`) with `{body, visibility: "customer"|"internal"}`
- `POST /api/v1/admin/support/tickets/:id/notes` with `{body}`

The public status vocabulary uses `waiting_customer` for the "awaiting
customer" state. `pending` remains accepted as a backwards-compatible input
and list filter; the durable database value is `pending` so existing rows and
migrations remain compatible.

All message text is bounded to 20,000 characters, subjects to 200, page size
to 100, and cursor values are opaque. Admin mutations require an active
operator, admin, or super-admin session with the existing email-verification,
2FA, and recent re-authentication gates.
