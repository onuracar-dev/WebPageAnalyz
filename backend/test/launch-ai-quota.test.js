const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryPlatformStore } = require('../platform/store');

function request(index, workspaceId = 'ws_ai') {
    return {
        userId: 'user_ai', findingFingerprint: `finding_${index}`, requestedModel: 'requested-model',
        provider: 'provider', promptVersion: 'prompt-v1', evidenceVersion: `evidence_${index}`,
        idempotencyKey: `${workspaceId}:generation:${index}`
    };
}

test('AI generation reservation atomically enforces monthly plan plus bonus quota', async () => {
    const store = new MemoryPlatformStore();
    const now = new Date('2026-08-15T12:00:00.000Z');
    await store.ensureWorkspace('ws_ai');
    await store.adjustCredits('ws_ai', 'ai', 2, { actorId: 'admin_1', reason: 'launch bonus' });

    const reservations = await Promise.all(Array.from({ length: 7 }, (_, index) => store.consumeAiGeneration('ws_ai', request(index), { now })));
    assert.deepEqual(reservations.map((entry) => entry.quota.used), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(reservations.at(-1).quota.limit, 7);
    await assert.rejects(() => store.consumeAiGeneration('ws_ai', request(7), { now }), { code: 'AI_REMEDIATION_LIMIT_REACHED' });

    const duplicate = await store.consumeAiGeneration('ws_ai', request(0), { now });
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.usage.id, reservations[0].usage.id);
});

test('failed AI calls release quota while terminal settlement and global daily cost are idempotent', async () => {
    const store = new MemoryPlatformStore();
    const now = new Date('2026-08-15T12:00:00.000Z');
    await store.ensureWorkspace('ws_ai');
    const reservations = [];
    for (let index = 0; index < 5; index += 1) reservations.push(await store.consumeAiGeneration('ws_ai', request(index), { now }));

    const failure = await store.settleAiGeneration('ws_ai', reservations[0].usage.id, { status: 'failed', failureCode: 'UPSTREAM_TIMEOUT' });
    assert.equal(failure.usage.status, 'failed');
    const replacement = await store.consumeAiGeneration('ws_ai', request(5), { now });
    assert.equal(replacement.quota.used, 5);

    const completed = await store.settleAiGeneration('ws_ai', replacement.usage.id, { status: 'completed', actualModel: 'actual-model', usageMetadata: { totalTokens: 100 }, costMetadata: { cost: 0.25 } });
    assert.equal(completed.idempotent, false);
    assert.equal((await store.settleAiGeneration('ws_ai', replacement.usage.id, { status: 'completed', costMetadata: { cost: 99 } })).idempotent, true);

    await store.recordAiUsage({ workspaceId: 'ws_other', userId: 'user_other', findingFingerprint: 'other', requestedModel: 'model', actualModel: 'model', provider: 'provider', promptVersion: 'p1', evidenceVersion: 'e1', idempotencyKey: 'other:1', status: 'completed', costMetadata: { cost: 0.5 }, createdAt: now.toISOString() });
    assert.equal(await store.dailyAiCost('ws_ai', now), 0.25);
    assert.equal(await store.dailyAiCost(null, now), 0.75);
});
