const crypto = require('node:crypto');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_TOKEN_LENGTH = 32;

function bootstrapError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function validateBootstrapInput({ userId, email, token, reason }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!String(userId || '').trim() || String(userId).length > 256) throw bootstrapError('BOOTSTRAP_USER_REQUIRED', 'A user id is required.');
    if (!EMAIL_PATTERN.test(normalizedEmail) || normalizedEmail.length > 254) throw bootstrapError('BOOTSTRAP_EMAIL_INVALID', 'A valid email is required.');
    if (String(token || '').length < MIN_TOKEN_LENGTH) throw bootstrapError('BOOTSTRAP_TOKEN_INVALID', `BOOTSTRAP_ADMIN_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`);
    if (!String(reason || '').trim() || String(reason).length > 500) throw bootstrapError('BOOTSTRAP_REASON_REQUIRED', 'A short bootstrap reason is required.');
    return { userId: String(userId).trim(), email: normalizedEmail, token: String(token), reason: String(reason).trim() };
}

function validateBootstrapToken(token) {
    if (String(token || '').length < MIN_TOKEN_LENGTH) throw bootstrapError('BOOTSTRAP_TOKEN_INVALID', `BOOTSTRAP_ADMIN_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`);
    return String(token);
}

function tokenHash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function hashesEqual(left, right) {
    if (!left || !right) return false;
    const leftBuffer = Buffer.from(String(left), 'hex');
    const rightBuffer = Buffer.from(String(right), 'hex');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function provisionBootstrapToken({ pool, token }) {
    const currentTokenHash = tokenHash(validateBootstrapToken(token));
    const client = await pool.connect();
    let transactionOpen = false;
    try {
        await client.query('BEGIN');
        transactionOpen = true;
        await client.query("SELECT pg_advisory_xact_lock(hashtext('wpa-admin-bootstrap'))");
        const adminCount = await client.query('SELECT count(*)::int AS count FROM wpa_admin_accounts');
        if (Number(adminCount.rows[0]?.count || 0) > 0) throw bootstrapError('BOOTSTRAP_ADMIN_EXISTS', 'An administrator record already exists.');
        const existing = await client.query('SELECT consumed_at AS "consumedAt" FROM wpa_admin_bootstrap WHERE id=true FOR UPDATE');
        if (existing.rows[0]) throw bootstrapError('BOOTSTRAP_TOKEN_ALREADY_PROVISIONED', 'A bootstrap token has already been provisioned.');
        await client.query('INSERT INTO wpa_admin_bootstrap(id,token_hash) VALUES(true,$1)', [currentTokenHash]);
        await client.query('COMMIT');
        transactionOpen = false;
        return { provisioned: true };
    } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function bootstrapFirstAdmin({ pool, userId, email, token, reason, requestId = `bootstrap:${crypto.randomUUID()}` }) {
    const input = validateBootstrapInput({ userId, email, token, reason });
    const client = await pool.connect();
    let transactionOpen = false;
    try {
        await client.query('BEGIN');
        transactionOpen = true;
        await client.query("SELECT pg_advisory_xact_lock(hashtext('wpa-admin-bootstrap'))");

        const adminCount = await client.query('SELECT count(*)::int AS count FROM wpa_admin_accounts');
        if (Number(adminCount.rows[0]?.count || 0) > 0) throw bootstrapError('BOOTSTRAP_ADMIN_EXISTS', 'An administrator record already exists.');

        const userResult = await client.query(
            'SELECT id,email,"emailVerified" AS "emailVerified" FROM "user" WHERE id=$1 AND lower(email)=lower($2) FOR UPDATE',
            [input.userId, input.email]
        );
        const user = userResult.rows[0];
        if (!user) throw bootstrapError('BOOTSTRAP_USER_NOT_FOUND', 'The requested verified account was not found.');
        if (user.emailVerified !== true) throw bootstrapError('BOOTSTRAP_EMAIL_UNVERIFIED', 'The account email must be verified before bootstrap.');

        const bootstrapResult = await client.query('SELECT token_hash AS "tokenHash", consumed_at AS "consumedAt" FROM wpa_admin_bootstrap WHERE id=true FOR UPDATE');
        const stored = bootstrapResult.rows[0];
        const currentTokenHash = tokenHash(input.token);
        if (stored?.consumedAt) throw bootstrapError('BOOTSTRAP_ALREADY_CONSUMED', 'The one-time administrator bootstrap has already been consumed.');
        if (!stored) throw bootstrapError('BOOTSTRAP_TOKEN_NOT_PROVISIONED', 'Provision the one-time bootstrap token before creating an administrator.');
        if (!hashesEqual(stored.tokenHash, currentTokenHash)) throw bootstrapError('BOOTSTRAP_TOKEN_MISMATCH', 'The one-time bootstrap token was not accepted.');

        const adminResult = await client.query(
            `INSERT INTO wpa_admin_accounts(user_id,email,role,active) VALUES($1,$2,'super_admin',true)
             ON CONFLICT(user_id) DO NOTHING
             RETURNING user_id AS "userId",email,role,active`,
            [user.id, user.email]
        );
        if (adminResult.rowCount !== 1) throw bootstrapError('BOOTSTRAP_ADMIN_EXISTS', 'An administrator record already exists.');
        await client.query('UPDATE wpa_admin_bootstrap SET consumed_at=now(), consumed_by_user_id=$1 WHERE id=true', [user.id]);
        await client.query(
            `INSERT INTO wpa_audit_log(id,actor_id,action,entity_type,entity_id,metadata)
             VALUES($1,$2,'admin.bootstrap_completed','admin_account',$2,$3::jsonb)`,
            [`audit_${crypto.randomUUID()}`, user.id, JSON.stringify({ reason: input.reason, requestId, oneTime: true })]
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return { userId: user.id, email: user.email, role: 'super_admin', requestId };
    } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { bootstrapFirstAdmin, hashesEqual, provisionBootstrapToken, tokenHash, validateBootstrapInput, validateBootstrapToken };
