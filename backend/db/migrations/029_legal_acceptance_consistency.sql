-- Align the durable legal document identifier with the public/application
-- contract. Existing pre-launch `aup` rows retain their meaning.
ALTER TABLE wpa_legal_acceptances
    DROP CONSTRAINT IF EXISTS wpa_legal_acceptances_document_type_check;

UPDATE wpa_legal_acceptances
SET document_type = 'acceptable_use'
WHERE document_type = 'aup';

ALTER TABLE wpa_legal_acceptances
    ADD CONSTRAINT wpa_legal_acceptances_document_type_check
    CHECK (document_type IN ('terms','acceptable_use','refund','target_authorization'));
