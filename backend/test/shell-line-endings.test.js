const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const expectedProductionScripts = [
    'backend/scripts/apply-runtime-grants.sh',
    'backend/scripts/bootstrap-roles.sh',
    'infra/backup/backup-postgres.sh',
    'infra/backup/restore-check-postgres.sh'
];

function trackedFiles() {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
}

function isShellScript(relativePath, bytes) {
    if (relativePath.endsWith('.sh')) return true;
    const newline = bytes.indexOf(0x0a);
    const firstLine = bytes.subarray(0, newline === -1 ? Math.min(bytes.length, 512) : newline).toString('utf8').replace(/\r$/, '');
    return /^#!.*(?:\/|env\s+)(?:ba|da|a|k|z)?sh(?:\s|$)/.test(firstLine);
}

function trackedShellScripts() {
    return trackedFiles().map((relativePath) => {
        const bytes = fs.readFileSync(path.join(root, relativePath));
        return { relativePath, bytes };
    }).filter(({ relativePath, bytes }) => isShellScript(relativePath, bytes));
}

test('tracked Linux shell scripts use LF-only bytes and explicit Git attributes', () => {
    const scripts = trackedShellScripts();
    const paths = scripts.map(({ relativePath }) => relativePath).sort();
    for (const expected of expectedProductionScripts) assert.ok(paths.includes(expected), `${expected} must remain in the tracked shell audit`);

    const crlf = scripts.filter(({ bytes }) => bytes.includes(Buffer.from('\r\n'))).map(({ relativePath }) => relativePath);
    const carriageReturns = scripts.filter(({ bytes }) => bytes.includes(0x0d)).map(({ relativePath }) => relativePath);
    assert.deepEqual(crlf, [], `CRLF bytes found in: ${crlf.join(', ')}`);
    assert.deepEqual(carriageReturns, [], `carriage-return bytes found in: ${carriageReturns.join(', ')}`);

    const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
    assert.match(attributes, /^\*\.sh text eol=lf$/m);
    const checkedAttributes = execFileSync('git', ['check-attr', 'eol', '--', ...paths], { cwd: root, encoding: 'utf8' });
    for (const relativePath of paths) assert.match(checkedAttributes, new RegExp(`^${relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: eol: lf$`, 'm'));
});
