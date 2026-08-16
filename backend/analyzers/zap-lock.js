const { AppError } = require('../lib/errors');

function createZapDistributedLock({ pool, namespace = 'wpa-zap-baseline', required = false, retryMs = 250, acquireTimeoutMs = 120_000 } = {}) {
    if (!pool?.connect) {
        if (required) throw new AppError('Distributed ZAP serialization is unavailable.', { status: 503, code: 'ZAP_DISTRIBUTED_LOCK_UNAVAILABLE' });
        return null;
    }
    return {
        async acquire(signal) {
            const deadline = Date.now() + acquireTimeoutMs;
            while (Date.now() < deadline) {
                signal?.throwIfAborted();
                const client = await pool.connect();
                let held = false;
                try {
                    const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [namespace]);
                    held = result.rows[0]?.acquired === true || result.rows[0]?.acquired === 't';
                    if (held) {
                        let released = false;
                        return async () => {
                            if (released) return;
                            released = true;
                            await client.query('SELECT pg_advisory_unlock(hashtext($1))', [namespace]).catch(() => {});
                            client.release();
                        };
                    }
                } catch (cause) {
                    client.release();
                    throw new AppError('Distributed ZAP serialization is unavailable.', { status: 503, code: 'ZAP_DISTRIBUTED_LOCK_UNAVAILABLE', cause });
                }
                if (!held) client.release();
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, retryMs);
                    const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('Aborted')); };
                    signal?.addEventListener('abort', abort, { once: true });
                    const cleanup = () => signal?.removeEventListener('abort', abort);
                    timer.unref?.();
                    setTimeout(cleanup, retryMs + 1);
                });
            }
            throw new AppError('ZAP serialization is busy; retry later.', { status: 429, code: 'ZAP_LOCK_TIMEOUT' });
        }
    };
}

module.exports = { createZapDistributedLock };
