const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const request = require('supertest');
const { createApp } = require('../app');
const { loadConfig } = require('../config');

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL seat trigger allows only one winner for the final Studio seat', { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const workspaceId = `ws_seat_race_${suffix}`;
    const organizationId = workspaceId;
    const userIds = Array.from({ length: 6 }, (_, index) => `user_seat_${index}_${suffix}`);
    try {
        await pool.query(`INSERT INTO wpa_workspaces(id,name,plan_id) VALUES($1,'Seat race','studio')`, [workspaceId]);
        await pool.query(`INSERT INTO organization(id,name,slug,"createdAt") VALUES($1,'Seat race',$2,now())`, [organizationId, `seat-${suffix}`]);
        for (const [index, userId] of userIds.entries()) {
            await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())`, [userId, `Seat ${index}`, `${userId}@example.test`]);
        }
        for (let index = 0; index < 4; index += 1) {
            await pool.query(`INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,$4,now())`, [`member_${index}_${suffix}`, organizationId, userIds[index], index === 0 ? 'owner' : 'member']);
        }

        const attempts = await Promise.allSettled([4, 5].map((index) => pool.query(
            `INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,'member',now())`,
            [`member_${index}_${suffix}`, organizationId, userIds[index]]
        )));
        assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
        assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
        const count = await pool.query(`SELECT count(*)::int AS count FROM member WHERE "organizationId"=$1`, [organizationId]);
        assert.equal(count.rows[0].count, 5);
    } finally {
        await pool.query('DELETE FROM organization WHERE id=$1', [organizationId]).catch(() => {});
        await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [userIds]).catch(() => {});
        await pool.query('DELETE FROM wpa_workspaces WHERE id=$1', [workspaceId]).catch(() => {});
        await pool.end();
    }
});

test('one password-reset token has one winner and revokes every existing session', { skip: !databaseUrl }, async (t) => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const userId = `user_reset_${suffix}`;
    const token = `reset-token-${suffix}`;
    const config = loadConfig({
        NODE_ENV: 'test', DATABASE_URL: databaseUrl,
        APP_URL: 'https://wpa-reset.example.test', BETTER_AUTH_URL: 'https://wpa-reset.example.test',
        BETTER_AUTH_SECRET: 'test-only-reset-secret-that-is-long-enough-0001',
        RATE_LIMIT_MAX: '1000', AUTH_RATE_LIMIT_MAX: '1000', PASSWORD_RESET_RATE_LIMIT_MAX: '1000'
    });
    const application = createApp({ config, logger: { info() {}, warn() {}, error() {} } });
    t.after(async () => { await application.locals.closeResources(); });
    try {
        await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","accountState","createdAt","updatedAt") VALUES($1,'Reset user',$2,true,'active',now(),now())`, [userId, `${userId}@example.test`]);
        await pool.query(`INSERT INTO account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES($1,$2,'credential',$2,'old-hash',now(),now())`, [`account_${suffix}`, userId]);
        for (let index = 0; index < 2; index += 1) {
            await pool.query(`INSERT INTO session(id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES($1,now()+interval '1 day',$2,now(),now(),$3)`, [`session_${index}_${suffix}`, `session-token-${index}-${suffix}`, userId]);
        }
        await pool.query(`INSERT INTO verification(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval '1 hour',now(),now())`, [`verification_${suffix}`, `reset-password:${token}`, userId]);

        const attempts = await Promise.all([
            request(application).post('/api/auth/reset-password').send({ token, newPassword: 'A-new-password-12345!' }),
            request(application).post('/api/auth/reset-password').send({ token, newPassword: 'A-new-password-12345!' })
        ]);
        assert.deepEqual(attempts.map((response) => response.status).sort((a, b) => a - b), [200, 400]);
        const sessions = await pool.query('SELECT count(*)::int AS count FROM session WHERE "userId"=$1', [userId]);
        const verifications = await pool.query('SELECT count(*)::int AS count FROM verification WHERE identifier=$1', [`reset-password:${token}`]);
        assert.equal(sessions.rows[0].count, 0);
        assert.equal(verifications.rows[0].count, 0);
    } finally {
        await pool.query('DELETE FROM "user" WHERE id=$1', [userId]).catch(() => {});
        await pool.end();
    }
});
