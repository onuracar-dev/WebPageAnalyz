const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config');
const { MemoryPlatformStore } = require('../platform/store');
const { createIntegrationService } = require('../integrations/service');

function harness(planId = 'enterprise') {
    const store = new MemoryPlatformStore();
    const config = loadConfig({
        NODE_ENV: 'test', APP_URL: 'https://wpa.example.com', BETTER_AUTH_URL: 'https://wpa.example.com',
        GITHUB_CLIENT_ID: 'github-client', GITHUB_CLIENT_SECRET: 'github-secret'
    });
    const service = createIntegrationService({
        config, store,
        validateUrl: async (url) => ({ url, hostname: new URL(url).hostname, address: '203.0.113.10', family: 4, port: 443 }),
        logger: { warn() {} }
    });
    return { store, service, initialize: async (workspaceId) => { await store.ensureWorkspace(workspaceId); await store.setWorkspacePlan(workspaceId, planId); } };
}

test('integration catalog reflects plan entitlement and server OAuth configuration', async () => {
    const { service, initialize } = harness();
    await initialize('ws_integrations');
    const integrations = await service.list('ws_integrations');
    assert.equal(integrations.find((item) => item.provider === 'github').serverConfigured, true);
    assert.equal(integrations.find((item) => item.provider === 'webhook').available, true);
    assert.equal(integrations.every((item) => item.status === 'not_connected'), true);
});

test('OAuth initiation records a one-use state without returning credentials', async () => {
    const { store, service, initialize } = harness();
    await initialize('ws_oauth');
    const result = await service.beginOAuth('ws_oauth', 'github', 'user_1');
    const url = new URL(result.url);
    assert.equal(url.origin, 'https://github.com');
    assert.equal(url.searchParams.get('client_id'), 'github-client');
    assert.ok(url.searchParams.get('state').length >= 32);
    assert.equal(store.oauthStates.size, 1);
    assert.equal(JSON.stringify(result).includes('github-secret'), false);
});

test('webhook setup is entitled and stores its signing secret encrypted', async () => {
    const { store, service, initialize } = harness();
    await initialize('ws_webhook');
    const result = await service.configureWebhook('ws_webhook', { url: 'https://hooks.example.com/wpa' }, 'user_1');
    assert.ok(result.generatedSecret.length >= 32);
    const record = await store.getIntegration('ws_webhook', 'webhook');
    assert.equal(record.status, 'configured');
    assert.equal(record.configuration.url, 'https://hooks.example.com/wpa');
    assert.equal(record.encryptedCredentials.toString('utf8').includes(result.generatedSecret), false);
});

test('Signal cannot configure enterprise webhooks', async () => {
    const { service, initialize } = harness('signal');
    await initialize('ws_signal_hook');
    await assert.rejects(() => service.configureWebhook('ws_signal_hook', { url: 'https://hooks.example.com/wpa' }, 'user_1'), { code: 'MODULE_NOT_ENTITLED' });
});

test('report webhooks are durable idempotent outbox events, never false delivery success', async () => {
    const { store, service, initialize } = harness();
    await initialize('ws_outbox');
    await service.configureWebhook('ws_outbox', { url: 'https://hooks.example.com/wpa' }, 'user_1');
    const report = { id: 'rpt_1', scanId: 'scan_1', version: 1, status: 'published' };
    const first = await service.deliverReport('ws_outbox', report);
    const second = await service.deliverReport('ws_outbox', report);
    assert.equal(first.queued, true);
    assert.equal(first.delivered, false);
    assert.equal(second.outboxId, first.outboxId);
    const [event] = await store.claimWebhookOutbox('worker-a');
    assert.ok(event.leaseToken);
    assert.equal(await store.completeWebhookOutbox(event.id, 'worker-b', event.leaseToken), null);
    const failed = await store.failWebhookOutbox(event.id, 'worker-a', event.leaseToken, Object.assign(new Error('offline'), { code: 'WEBHOOK_TIMEOUT' }), { maxAttempts: 1 });
    assert.equal(failed.status, 'dead_letter');
    const listed = await store.listWebhookOutboxAdmin({ workspaceId: 'ws_outbox' });
    assert.equal(listed[0].payload, undefined);
    assert.ok(listed[0].history.some((entry) => entry.action === 'dead_letter'));
    const replayed = await store.replayWebhookOutbox(event.id, 'admin-1', 'ws_outbox');
    assert.equal(replayed.status, 'pending');
    assert.equal((await store.listWebhookOutboxHistory(event.id))[0].action, 'replayed');
});

test('webhook delivery is suppressed after the workspace loses its entitlement', async () => {
    const { store, service, initialize } = harness();
    await initialize('ws_webhook_downgrade');
    await service.configureWebhook('ws_webhook_downgrade', { url: 'https://hooks.example.com/wpa' }, 'user_1');
    await store.setWorkspacePlan('ws_webhook_downgrade', 'signal');
    const result = await service.deliverReport('ws_webhook_downgrade', { id: 'rpt_downgrade', scanId: 'scan_1', version: 1, status: 'published' });
    assert.deepEqual(result, { queued: false, reason: 'not_entitled' });
    assert.equal(store.webhookOutbox.size, 0);
});
