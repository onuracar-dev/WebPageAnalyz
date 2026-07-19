const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', 'coverage', 'logs']);

function collectJavaScriptFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (ignored.has(entry.name)) return [];
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return collectJavaScriptFiles(fullPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
    });
}

for (const file of collectJavaScriptFiles(root)) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}

console.log('Syntax check passed.');
