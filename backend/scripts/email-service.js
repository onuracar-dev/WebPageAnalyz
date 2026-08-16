const { createEmailHttpService, loadEmailServiceConfig } = require('../email/http-service');
const { createResendProvider } = require('../email/resend-provider');
const { logger } = require('../lib/logger');

async function startEmailService({ env = process.env, fetchImpl = fetch, serviceLogger = logger } = {}) {
    const config = loadEmailServiceConfig(env);
    const provider = createResendProvider({ ...config.resend, fetchImpl, logger: serviceLogger });
    const service = createEmailHttpService({ provider, config, logger: serviceLogger });
    const address = await service.listen();
    serviceLogger.info('Internal email service started', {
        host: config.host,
        port: typeof address === 'object' ? address.port : config.port,
        provider: provider.name,
        configured: provider.configured
    });
    return { config, provider, service };
}

async function main() {
    const running = await startEmailService();
    let stopping = false;
    const stop = async (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info('Internal email service shutdown initiated', { signal });
        const forceTimer = setTimeout(() => process.exit(1), 10_000);
        forceTimer.unref();
        try {
            await running.service.close();
            clearTimeout(forceTimer);
            process.exitCode = 0;
        } catch (error) {
            clearTimeout(forceTimer);
            logger.error('Internal email service shutdown failed', { error });
            process.exitCode = 1;
        }
    };
    process.once('SIGTERM', () => { void stop('SIGTERM'); });
    process.once('SIGINT', () => { void stop('SIGINT'); });
}

if (require.main === module) {
    main().catch((error) => {
        logger.error('Internal email service failed to start', { error });
        process.exitCode = 1;
    });
}

module.exports = { startEmailService };
