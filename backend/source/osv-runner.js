const { spawn } = require('node:child_process');
const fs = require('node:fs').promises;
const path = require('node:path');
const { createFinding } = require('../domain/findings');

const VERSION = '2.3.8';
const MANIFEST_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'requirements.txt', 'poetry.lock', 'pipfile.lock', 'cargo.lock', 'go.mod', 'go.sum', 'pom.xml', 'gradle.lockfile', 'composer.lock', 'gemfile.lock']);

async function discoverManifests(root, maxFiles = 20_000) {
    const found = []; let visited = 0;
    async function walk(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (++visited > maxFiles) return;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory() && !['node_modules', '.git', 'vendor', 'dist', 'build'].includes(entry.name.toLowerCase())) await walk(absolute);
            else if (entry.isFile() && MANIFEST_NAMES.has(entry.name.toLowerCase())) found.push(path.relative(root, absolute).replaceAll('\\', '/'));
        }
    }
    await walk(root);
    return found.slice(0, 1_000);
}

function normalizeOsv(output, projectUrl) {
    const findings = [];
    const results = Array.isArray(output.results) ? output.results : [];
    let manifests = 0;
    for (const result of results) {
        const sourcePath = String(result.source?.path || result.source || '').replaceAll('\\', '/').slice(-1_000);
        if (sourcePath) manifests += 1;
        for (const pkgResult of result.packages || []) {
            const pkg = pkgResult.package || pkgResult;
            const vulnerabilities = pkgResult.vulnerabilities || pkg.vulnerabilities || [];
            for (const vulnerability of vulnerabilities) {
                const id = vulnerability.id || vulnerability.vulnerability?.id || 'unknown';
                const database = vulnerability.database_specific || {};
                const severity = /critical/i.test(database.severity || '') ? 'critical' : /high/i.test(database.severity || '') ? 'high' : 'medium';
                const fixed = (vulnerability.affected || []).flatMap((affected) => affected.ranges || []).flatMap((range) => range.events || []).map((event) => event.fixed).filter(Boolean);
                findings.push({
                    ...createFinding({
                        ruleId: `osv:${id}`,
                        category: 'dependency-security',
                        title: `${id} affects ${pkg.name || 'a dependency'}`,
                        description: String(vulnerability.summary || vulnerability.details || 'A known dependency vulnerability was detected.').slice(0, 10_000),
                        severity,
                        confidence: pkg.version ? 0.98 : 0.78,
                        kind: 'measured',
                        pageUrl: projectUrl,
                        source: 'OSV-Scanner',
                        sourceVersion: VERSION,
                        evidenceKey: `${id}:${pkg.ecosystem || ''}:${pkg.name || ''}:${pkg.version || ''}:${sourcePath}`,
                        evidence: [{ type: 'dependency', name: pkg.name || 'unknown', value: { ecosystem: pkg.ecosystem || '', version: pkg.version || '', manifest: sourcePath, aliases: vulnerability.aliases || [] } }],
                        remediation: fixed.length ? `Upgrade to a fixed version (${[...new Set(fixed)].join(', ')}).` : 'Review the advisory and upgrade, replace or isolate the affected dependency.'
                    }),
                    moduleId: 'source_audit',
                    normalizedImpact: { critical: 100, high: 75, medium: 50 }[severity]
                });
            }
        }
    }
    return { findings, coverage: { manifests, resultGroups: results.length, databaseSource: 'osv.dev', sourceCodeTransmitted: false } };
}

function killProcessTree(child) {
    if (!child || child.killed) return;
    try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
    } catch { child.kill('SIGKILL'); }
}

async function runOsv(root, { executable = 'osv-scanner', isolationRunner = '', isolationArgs = [], timeoutMs = 180_000, maxOutputBytes = 25 * 1024 * 1024, projectUrl, signal } = {}) {
    const scannedManifests = await discoverManifests(root);
    if (!scannedManifests.length) throw Object.assign(new Error('No supported dependency manifest or lockfile was found.'), { code: 'OSV_NO_SUPPORTED_MANIFEST' });
    if (!isolationRunner) throw Object.assign(new Error('OSV isolation runner is not configured.'), { code: 'OSV_ISOLATION_UNAVAILABLE' });
    return new Promise((resolve, reject) => {
        // The configured runner owns the sandbox policy (no network, read-only
        // source mount, CPU/process limits). Direct execution is deliberately
        // unavailable because a scanner is third-party code.
        const child = spawn(isolationRunner, [...isolationArgs, '--', executable, 'scan', 'source', '-r', root, '--format', 'json'], {
            cwd: root, shell: false, windowsHide: true, detached: process.platform !== 'win32',
            env: { PATH: process.env.PATH || '', SSL_CERT_FILE: process.env.SSL_CERT_FILE || '', SSL_CERT_DIR: process.env.SSL_CERT_DIR || '', HOME: '/nonexistent', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const chunks = []; const errors = []; let bytes = 0; let settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
        const abort = () => { killProcessTree(child); finish(Object.assign(new Error('OSV scan aborted.'), { code: 'OSV_ABORTED' })); };
        const timer = setTimeout(() => { killProcessTree(child); finish(Object.assign(new Error('OSV scan timed out.'), { code: 'OSV_TIMEOUT' })); }, timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > maxOutputBytes) { killProcessTree(child); finish(Object.assign(new Error('OSV output exceeded the size limit.'), { code: 'OSV_OUTPUT_TOO_LARGE' })); } else chunks.push(chunk); });
        child.stderr.on('data', (chunk) => { if (errors.reduce((sum, item) => sum + item.length, 0) < 64_000) errors.push(chunk); });
        child.once('error', (error) => finish(Object.assign(error, { code: error.code === 'ENOENT' ? 'OSV_UNAVAILABLE' : 'OSV_FAILED' })));
        child.once('close', (code) => {
            if (settled) return;
            if (![0, 1].includes(code)) return finish(Object.assign(new Error(`OSV-Scanner failed (${code}): ${Buffer.concat(errors).toString('utf8').slice(0, 500)}`), { code: 'OSV_FAILED' }));
            try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); const normalized = normalizeOsv(parsed, projectUrl); finish(null, { version: VERSION, status: 'completed', ...normalized, coverage: { ...normalized.coverage, manifests: scannedManifests.length, scannedManifests } }); }
            catch (cause) { finish(Object.assign(new Error('OSV-Scanner returned invalid JSON.'), { code: 'OSV_INVALID_OUTPUT', cause })); }
        });
    });
}

module.exports = { VERSION, discoverManifests, normalizeOsv, runOsv, killProcessTree };
