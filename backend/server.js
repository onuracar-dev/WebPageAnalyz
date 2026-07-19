require('dotenv').config({ quiet: true });
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { logger } = require('./lib/logger');

function startServer() {
    const config = loadConfig();
    const app = createApp({ config, logger });
    const server = app.listen(config.port, () => logger.info('WebPage Analyzer API started', {
        port: config.port,
        environment: config.nodeEnv
    }));
    server.requestTimeout = config.timeouts.analysisMs + 15_000;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 100;
    server.maxRequestsPerSocket = 1_000;

    let shuttingDown = false;
    const shutdown = (reason, exitCode = 0, error) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger[error ? 'error' : 'info']('Server shutdown initiated', { reason, error });
        app.locals.closeResources?.();
        const forceTimer = setTimeout(() => {
            logger.error('Forced shutdown after grace period');
            process.exit(exitCode || 1);
        }, 10_000);
        forceTimer.unref();
        server.close(() => {
            clearTimeout(forceTimer);
            process.exitCode = exitCode;
        });
    };

    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('unhandledRejection', (error) => shutdown('unhandledRejection', 1, error));
    process.once('uncaughtException', (error) => shutdown('uncaughtException', 1, error));
    return { app, server, shutdown };
}

if (require.main === module) startServer();

module.exports = { startServer };
