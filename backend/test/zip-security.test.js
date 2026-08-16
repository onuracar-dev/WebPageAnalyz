const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectZip, safeEntryName } = require('../source/zip-security');

test('source ZIP path policy rejects traversal, absolute paths, drives and NULs', () => {
    assert.equal(safeEntryName('src/index.js'), true);
    assert.equal(safeEntryName('../secret.txt'), false);
    assert.equal(safeEntryName('src/../../secret.txt'), false);
    assert.equal(safeEntryName('/etc/passwd'), false);
    assert.equal(safeEntryName('C:\\Windows\\file.txt'), false);
    assert.equal(safeEntryName('bad\0name'), false);
});

test('source ZIP inspector fails closed on malformed archives', async () => {
    await assert.rejects(() => inspectZip(Buffer.from('not a zip')), { code: 'INVALID_ZIP' });
});
