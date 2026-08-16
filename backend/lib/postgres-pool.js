const { logger: defaultLogger } = require('./logger');

const OBSERVED_POOL = Symbol('wpa.postgresPoolObserved');

function observePostgresPool(pool, { logger = defaultLogger, component = 'postgres' } = {}) {
    if (!pool || typeof pool.on !== 'function' || pool[OBSERVED_POOL]) return pool;

    Object.defineProperty(pool, OBSERVED_POOL, { value: true });
    pool.on('error', (error) => {
        // node-postgres emits an `error` event when an idle client is severed
        // (for example during a planned PostgreSQL restart). Without a
        // listener EventEmitter treats it as uncaught and terminates Node.
        // Query errors still reject their owning operation normally.
        try {
            logger?.error?.('PostgreSQL idle client connection failed', {
                component,
                errorCode: error?.code || 'POSTGRES_IDLE_CLIENT_ERROR',
                error
            });
        } catch {
            // Observability must not turn a recoverable idle-client event back
            // into a process-fatal exception, even if a custom logger fails.
        }
    });
    return pool;
}

module.exports = { observePostgresPool };
