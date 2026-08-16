const { createAIHttpService, loadAIServiceConfig } = require('../ai/http-service');
const { createOpenRouterProvider } = require('../ai/openrouter-provider');
const { logger } = require('../lib/logger');

async function startAIService({ env = process.env, fetchImpl = fetch, serviceLogger = logger } = {}) {
    const config = loadAIServiceConfig(env);
    const provider = createOpenRouterProvider({ ...config.openRouter, fetchImpl });
    const service = createAIHttpService({ provider, config, logger: serviceLogger });
    const address = await service.listen();
    serviceLogger.info('Internal AI service started', {
        host: config.host,
        port: typeof address === 'object' ? address.port : config.port,
        provider: provider.name,
        configured: provider.configured
    });
    return { config, provider, service };
}

async function main() {
    const running = await startAIService();
    let stopping = false;
    const stop = async (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info('Internal AI service shutdown initiated', { signal });
        const forceTimer = setTimeout(() => process.exit(1), 10_000);
        forceTimer.unref();
        try {
            await running.service.close();
            clearTimeout(forceTimer);
            process.exitCode = 0;
        } catch (error) {
            clearTimeout(forceTimer);
            logger.error('Internal AI service shutdown failed', { error });
            process.exitCode = 1;
        }
    };
    process.once('SIGTERM', () => { void stop('SIGTERM'); });
    process.once('SIGINT', () => { void stop('SIGINT'); });
}

if (require.main === module) {
    main().catch((error) => {
        logger.error('Internal AI service failed to start', { error });
        process.exitCode = 1;
    });
}

module.exports = { startAIService };
