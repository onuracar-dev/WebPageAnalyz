-- Support ticket creation already has a workspace-scoped idempotency key.
-- Persist the request identity as well so a reused key cannot silently bind a
-- different subject/body/context to the original ticket.

ALTER TABLE wpa_support_tickets
    ADD COLUMN IF NOT EXISTS request_fingerprint text;
