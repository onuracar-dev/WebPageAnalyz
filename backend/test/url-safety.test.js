const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isPublicAddress,
    validatePublicUrl
} = require('../security/url-safety');

test('public address classification blocks private and reserved IPv4 ranges', () => {
    for (const address of ['0.0.0.0', '10.2.3.4', '127.0.0.1', '169.254.169.254', '172.31.1.1', '192.168.1.2', '224.0.0.1', '255.255.255.255']) {
        assert.equal(isPublicAddress(address), false, address);
    }
    assert.equal(isPublicAddress('8.8.8.8'), true);
});

test('public address classification blocks local IPv6 ranges and mapped addresses', () => {
    for (const address of ['::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1']) {
        assert.equal(isPublicAddress(address), false, address);
    }
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('URL validation only accepts credential-free HTTP(S) on allowed ports', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    await assert.rejects(() => validatePublicUrl('file:///etc/passwd', { lookup }), { code: 'INVALID_TARGET_URL' });
    await assert.rejects(() => validatePublicUrl('https://user:pass@example.com', { lookup }), { code: 'INVALID_TARGET_URL' });
    await assert.rejects(() => validatePublicUrl('https://example.com:8443', { lookup }), { code: 'TARGET_PORT_BLOCKED' });

    const result = await validatePublicUrl('https://Example.com/path#fragment', { lookup });
    assert.equal(result.url, 'https://example.com/path');
    assert.equal(result.address, '8.8.8.8');
});

test('URL validation rejects local names, numeric loopback, and mixed DNS answers', async () => {
    await assert.rejects(() => validatePublicUrl('http://localhost'), { code: 'PRIVATE_TARGET_BLOCKED' });
    await assert.rejects(() => validatePublicUrl('http://2130706433'), { code: 'PRIVATE_TARGET_BLOCKED' });
    await assert.rejects(() => validatePublicUrl('https://service.internal'), { code: 'PRIVATE_TARGET_BLOCKED' });
    await assert.rejects(() => validatePublicUrl('https://example.com', {
        lookup: async () => [
            { address: '8.8.8.8', family: 4 },
            { address: '10.0.0.4', family: 4 }
        ]
    }), { code: 'PRIVATE_TARGET_BLOCKED' });
});

test('every validation performs DNS resolution so a rebinding answer is blocked', async () => {
    let calls = 0;
    const lookup = async () => {
        calls += 1;
        return [{ address: calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    };
    await validatePublicUrl('https://example.com', { lookup });
    await assert.rejects(() => validatePublicUrl('https://example.com', { lookup }), { code: 'PRIVATE_TARGET_BLOCKED' });
    assert.equal(calls, 2);
});
