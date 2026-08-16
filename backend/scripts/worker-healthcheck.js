const fs = require('node:fs').promises;

function validateWorkerMarker(marker, { isProcessAlive = (pid) => { process.kill(pid, 0); return true; }, now = Date.now } = {}) {
    const validRole = marker.role === 'worker' || marker.role === 'maintenance';
    const validKind = marker.role === 'maintenance' ? marker.kind === 'maintenance' : marker.kind !== 'maintenance';
    const readyAgeMs = now() - Date.parse(marker.readyAt || marker.startedAt);
    const validPid = Number.isInteger(marker.pid) && marker.pid > 0;
    if (!validRole || !validKind || !validPid || !Number.isFinite(readyAgeMs) || readyAgeMs < 0) return false;
    try { return isProcessAlive(marker.pid) !== false; } catch { return false; }
}

async function validateEngineLabEndpoint(marker, { fetchImpl = fetch, port = process.env.ENGINE_LAB_SERVICE_PORT || 5030 } = {}) {
    if (!marker.engineLabService) return true;
    const parsedPort = Number.parseInt(port, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) return false;
    try {
        const response = await fetchImpl(`http://127.0.0.1:${parsedPort}/healthz`, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
    } catch { return false; }
}

async function main({ fsImpl = fs, markerPath = '/tmp/wpa-worker.ready', isProcessAlive, now, fetchImpl, engineLabPort } = {}) {
    const marker = JSON.parse(await fsImpl.readFile(markerPath, 'utf8'));
    if (!validateWorkerMarker(marker, { isProcessAlive, now }) || !await validateEngineLabEndpoint(marker, { fetchImpl, port: engineLabPort })) process.exitCode = 1;
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = { main, validateEngineLabEndpoint, validateWorkerMarker };
