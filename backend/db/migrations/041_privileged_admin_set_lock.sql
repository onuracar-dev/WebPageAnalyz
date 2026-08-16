BEGIN;

-- Row triggers see a row after PostgreSQL has begun locking it. Acquiring the
-- shared privileged-set lock from a statement trigger first gives direct SQL
-- updates/deletes the same serialization order as the application service and
-- closes the two-concurrent-downgrades race without serializing last_access_at.
CREATE OR REPLACE FUNCTION wpa_lock_privileged_admin_set() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('wpa:privileged-role-management'));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS wpa_lock_privileged_admin_role_update ON wpa_admin_accounts;
CREATE TRIGGER wpa_lock_privileged_admin_role_update
BEFORE UPDATE OF role,active ON wpa_admin_accounts
FOR EACH STATEMENT EXECUTE FUNCTION wpa_lock_privileged_admin_set();

DROP TRIGGER IF EXISTS wpa_lock_privileged_admin_delete ON wpa_admin_accounts;
CREATE TRIGGER wpa_lock_privileged_admin_delete
BEFORE DELETE ON wpa_admin_accounts
FOR EACH STATEMENT EXECUTE FUNCTION wpa_lock_privileged_admin_set();

COMMIT;
