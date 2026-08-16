const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const supportApiPath = path.join(__dirname, '..', '..', 'website', 'src', 'portal', 'supportApi.ts');

test('support portal mutation contract persists operation keys and clears them only after fetch success', () => {
    const source = fs.readFileSync(supportApiPath, 'utf8');
    assert.match(source, /window\.sessionStorage/);
    assert.match(source, /supportOperationKey\('ticket-create', body\)/);
    assert.match(source, /supportOperationKey\(`message:\$\{admin \? 'admin' : 'customer'\}:\$\{ticketId\}`/);
    assert.match(source, /'Idempotency-Key': operation\.key/);
    assert.match(source, /const payload = await apiFetch<unknown>\(customerRoot, init\);[\s\S]*completeSupportOperation\(operation\);/);
    assert.match(source, /const payload = await apiFetch<unknown>\(`[\s\S]*completeSupportOperation\(operation\);/);
});
