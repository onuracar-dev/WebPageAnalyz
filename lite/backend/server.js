const { config } = require('./config');
const { logger } = require('./lib/logger');
const { createScanRunner } = require('./scan-runner');
const { JobQueue } = require('./job-queue');
const { createApp } = require('./app');

process.on('uncaughtException', (err) => {
    if (err?.code === 'ECONNRESET') {
        logger.warn('Ignored transient network ECONNRESET socket error', { code: err.code });
        return;
    }
    logger.error('Uncaught exception', { error: err });
    process.exit(1);
});

const runner = createScanRunner({
    config,
    logger
});

const queue = new JobQueue({
    runner,
    concurrency: config.scanConcurrency,
    maxQueue: config.maxQueue,
    scanTimeoutMs: config.scanTimeoutMs,
    resultTtlMs: config.resultTtlMs,
    logger
});

const app = createApp({
    config,
    queue,
    runner,
    logger
});

const server = app.listen(config.port, config.host, () => {
    logger.info(`WebPage Analyzer Lite listening on http://${config.host}:${config.port}`, {
        port: config.port,
        host: config.host,
        concurrency: config.scanConcurrency,
        maxQueue: config.maxQueue,
        nodeEnv: config.nodeEnv
    });
});

function shutdown(signal) {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);
    queue.close();
    server.close(() => {
        logger.info('Server closed. Process terminating.');
        process.exit(0);
    });

    setTimeout(() => {
        logger.error('Forcefully terminating process due to shutdown timeout.');
        process.exit(1);
    }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, queue, runner };
