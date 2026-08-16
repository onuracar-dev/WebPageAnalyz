const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

function clientKey(request) {
    if (request.platformIdentity?.workspaceId) return `workspace:${request.platformIdentity.workspaceId}:${request.apiKeyId ? `key:${request.apiKeyId}` : `ip:${ipKeyGenerator(request.ip)}`}`;
    if (request.apiKeyId) return `key:${request.apiKeyId}`;
    return `ip:${ipKeyGenerator(request.ip)}`;
}

function isScanProgressRead(request) {
    if (request.method !== 'GET') return false;
    const pathname = String(request.originalUrl || request.url || '').split('?', 1)[0];
    return /^\/api\/v1\/scans\/[^/]+\/(?:progress|events)$/.test(pathname);
}

class PgRateLimitStore {
    constructor(pool, namespace = 'general') {
        if (!/^[a-z0-9_-]{1,40}$/.test(namespace)) throw new TypeError('Rate-limit namespace is invalid.');
        this.pool = pool;
        this.namespace = namespace;
    }
    async init() {}
    async increment(key, windowMs = this.windowMs || 900_000) {
        const { rows } = await this.pool.query(
            `INSERT INTO wpa_rate_limit_buckets(namespace,key,window_started_at,hits)
             VALUES($1,$2,now(),1)
             ON CONFLICT(namespace,key) DO UPDATE SET
                window_started_at=CASE WHEN wpa_rate_limit_buckets.window_started_at <= now()-($3::text || ' milliseconds')::interval THEN now() ELSE wpa_rate_limit_buckets.window_started_at END,
                hits=CASE WHEN wpa_rate_limit_buckets.window_started_at <= now()-($3::text || ' milliseconds')::interval THEN 1 ELSE wpa_rate_limit_buckets.hits+1 END,
                updated_at=now()
             RETURNING hits,window_started_at`, [this.namespace, key, windowMs]);
        const row = rows[0];
        return { totalHits: Number(row.hits), resetTime: new Date(new Date(row.window_started_at).getTime() + windowMs) };
    }
    async decrement(key) { await this.pool.query('UPDATE wpa_rate_limit_buckets SET hits=GREATEST(0,hits-1) WHERE namespace=$1 AND key=$2', [this.namespace, key]); }
    async resetKey(key) { await this.pool.query('DELETE FROM wpa_rate_limit_buckets WHERE namespace=$1 AND key=$2', [this.namespace, key]); }
}

function limiter({ windowMs, max, message, skip, store }) {
    if (store) store.windowMs = windowMs;
    return rateLimit({
        windowMs,
        limit: max,
        ...(skip ? { skip } : {}),
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        keyGenerator: clientKey,
        ...(store ? { store } : {}),
        handler: (request, response) => response.status(429).json({
            error: message,
            code: 'RATE_LIMIT_EXCEEDED',
            requestId: request.id
        })
    });
}

module.exports = { limiter, PgRateLimitStore, clientKey, isScanProgressRead };
