const test = require('node:test');
const assert = require('node:assert/strict');
const { PLANS, getPlan } = require('../domain/plans');
const { normalizePageUrl, pageCreditKey, projectOrigin } = require('../domain/url-normalization');
const { createFinding } = require('../domain/findings');

test('plan catalog exposes the approved fixed commercial limits', () => {
    assert.equal(PLANS.length, 3);
    assert.equal(getPlan('signal').limits.pageCredits, 25);
    assert.equal(getPlan('studio').limits.pageCredits, 150);
    assert.equal(getPlan('enterprise').limits.pageCredits, 500);
    assert.equal(getPlan('enterprise').entitlements.api_webhooks.executionMode, 'automated');
    assert.equal(getPlan('enterprise').entitlements.journey_test.executionMode, 'automated');
    for (const planId of ['studio', 'enterprise']) {
        assert.equal(getPlan(planId).entitlements.monitoring, undefined);
        assert.equal(getPlan(planId).entitlements.white_label, undefined);
    }
    assert.equal(getPlan('enterprise').entitlements.expert_review, undefined);
    assert.equal(getPlan('enterprise').limits.expertReviews, undefined);
    assert.equal(getPlan('enterprise').features.some((feature) => /monitor|white-label|expert-reviewed|priority support/i.test(feature)), false);
});

test('page credit normalization removes fragments and tracking without collapsing real pages', () => {
    const first = normalizePageUrl('https://EXAMPLE.com:443/project/?utm_source=x&b=2&a=1#section');
    assert.equal(first, 'https://example.com/project?a=1&b=2');
    assert.equal(pageCreditKey('https://example.com/project?fbclid=abc'), 'https://example.com/project');
    assert.notEqual(pageCreditKey('https://example.com/'), pageCreditKey('https://example.com/project'));
    assert.notEqual(projectOrigin('https://app.example.com/a'), projectOrigin('https://example.com/a'));
});

test('page URL normalization removes credentials and sensitive query parameters', () => {
    assert.equal(normalizePageUrl('https://user:pass@example.com/a?token=private&view=full#x'), 'https://example.com/a?view=full');
});

test('finding contract produces stable fingerprints and preserves evidence kind', () => {
    const input = {
        ruleId: 'seo.title.missing', category: 'seo', title: 'Missing title', pageUrl: 'https://example.com/',
        source: 'WPA', kind: 'heuristic', evidence: [{ type: 'metric', value: 0 }]
    };
    const first = createFinding(input);
    const second = createFinding(input);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(first.kind, 'heuristic');
    assert.equal(first.evidence.length, 1);
});
