const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { chromeExecutable, chromeFlags } = require('../analyzers/browser-options');
const { AppError } = require('../lib/errors');

function reportHtml(report) {
    const payload = JSON.stringify(report.payload, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return `<!doctype html><html lang="${report.locale}"><head><meta charset="utf-8"><style>@page{size:A4;margin:14mm}body{font:12px/1.45 system-ui;color:#17202a}h1{font-size:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid #ccd3d9;padding-top:12px}</style></head><body><h1>WebPage Analyzer Report</h1><p>${report.status} · version ${report.version}</p><pre>${payload}</pre></body></html>`;
}

function printWithChromium(executablePath, args, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        const errors = [];
        let errorBytes = 0;
        let settled = false;
        const abort = () => { child.kill('SIGKILL'); finish(abortError()); };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(Object.assign(new Error('PDF rendering timed out.'), { code: 'PDF_TIMEOUT' }));
        }, timeoutMs);
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        child.stderr.on('data', (chunk) => {
            if (errorBytes >= 64 * 1024) return;
            const remaining = 64 * 1024 - errorBytes;
            errors.push(chunk.subarray(0, remaining));
            errorBytes += Math.min(chunk.length, remaining);
        });
        child.once('error', (cause) => finish(Object.assign(new Error('Chromium could not start the PDF renderer.'), { code: 'PDF_RENDERER_UNAVAILABLE', cause })));
        child.once('exit', (code, signal) => {
            if (code === 0) return finish();
            const detail = Buffer.concat(errors).toString('utf8').slice(-1_000);
            finish(Object.assign(new Error(`PDF renderer failed (${code ?? signal}). ${detail}`), { code: 'PDF_RENDER_FAILED' }));
        });
    });
}

async function renderReportPdf(report, config, { signal } = {}) {
    if (config.pdfExecutionDisabled) throw new AppError('PDF rendering is available only in the isolated worker.', { status: 503, code: 'PDF_WORKER_REQUIRED' });
    const executablePath = chromeExecutable(config);
    if (!executablePath) throw Object.assign(new Error('Chromium is not installed.'), { code: 'PDF_RENDERER_UNAVAILABLE' });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wpa-pdf-'));
    const htmlPath = path.join(directory, 'report.html');
    const pdfPath = path.join(directory, 'report.pdf');
    try {
        await fs.writeFile(htmlPath, reportHtml(report), { mode: 0o600 });
        const args = chromeFlags('', config).filter((flag) => !flag.startsWith('--proxy-server='));
        args.push('--disable-javascript', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href);
        await printWithChromium(executablePath, args, config.timeouts?.pdfMs || 45_000, signal);
        const stat = await fs.stat(pdfPath);
        if (stat.size <= 0 || stat.size > 50 * 1024 * 1024) throw Object.assign(new Error('Generated PDF size is invalid.'), { code: 'PDF_OUTPUT_INVALID' });
        return await fs.readFile(pdfPath);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

function abortError() { return new AppError('The PDF export request was cancelled.', { status: 499, code: 'CLIENT_DISCONNECTED' }); }

class PdfRenderService {
    constructor({ config, renderer = renderReportPdf, maxConcurrent = 1, maxQueue = 4, cacheTtlMs = 60_000, maxCacheBytes = 100 * 1024 * 1024 } = {}) {
        this.config = config;
        this.renderer = renderer;
        this.maxConcurrent = Math.max(1, Math.min(4, Number(maxConcurrent) || 1));
        this.maxQueue = Math.max(0, Math.min(32, Number(maxQueue) || 0));
        this.cacheTtlMs = Math.max(0, Number(cacheTtlMs) || 0);
        this.maxCacheBytes = Math.max(1, Number(maxCacheBytes) || 1);
        this.active = 0; this.queue = []; this.inFlight = new Map(); this.cache = new Map(); this.cacheBytes = 0;
    }

    keyFor(report, format = 'pdf') { return `${report.id}:${report.version || 1}:${format}`; }

    async render(report, { signal, format = 'pdf' } = {}) {
        const key = this.keyFor(report, format);
        const cached = this.cache.get(key);
        if (cached && cached.expiresAt > Date.now()) return this.awaitAbort(Promise.resolve(cached.buffer), signal);
        if (cached) this.dropCache(key);
        let operation = this.inFlight.get(key);
        if (!operation) {
            if (this.active + this.queue.length >= this.maxConcurrent + this.maxQueue) throw new AppError('PDF export capacity is temporarily exhausted.', { status: 429, code: 'PDF_QUEUE_FULL' });
            operation = this.enqueue(key, report);
            this.inFlight.set(key, operation);
            operation.promise.then(() => { if (this.inFlight.get(key) === operation) this.inFlight.delete(key); }, () => { if (this.inFlight.get(key) === operation) this.inFlight.delete(key); });
        }
        return this.awaitAbort(operation, signal);
    }

    enqueue(key, report) {
        const operation = { key, report, controller: new AbortController(), waiters: 0, settled: false };
        operation.promise = new Promise((resolve, reject) => {
            operation.resolve = resolve; operation.reject = reject;
            this.queue.push(operation);
            this.pump();
        });
        return operation;
    }

    pump() {
        while (this.active < this.maxConcurrent && this.queue.length) {
            const item = this.queue.shift(); this.active += 1;
            Promise.resolve().then(() => this.renderer(item.report, this.config, { signal: item.controller.signal })).then((buffer) => {
                this.putCache(item.key, buffer); item.resolve(buffer);
            }, item.reject).finally(() => { item.settled = true; this.active -= 1; this.pump(); });
        }
    }

    putCache(key, buffer) {
        if (!this.cacheTtlMs || !Buffer.isBuffer(buffer) || buffer.length > this.maxCacheBytes) return;
        while (this.cacheBytes + buffer.length > this.maxCacheBytes && this.cache.size) this.dropCache(this.cache.keys().next().value);
        this.cache.set(key, { buffer, expiresAt: Date.now() + this.cacheTtlMs }); this.cacheBytes += buffer.length;
    }

    dropCache(key) { const item = this.cache.get(key); if (!item) return; this.cacheBytes -= item.buffer.length; this.cache.delete(key); }

    awaitAbort(operation, signal) {
        if (!operation || typeof operation.promise !== 'object' && typeof operation.promise !== 'function') {
            const promise = Promise.resolve(operation);
            if (!signal) return promise;
            if (signal.aborted) return Promise.reject(abortError());
            return new Promise((resolve, reject) => {
                const abort = () => reject(abortError());
                signal.addEventListener('abort', abort, { once: true });
                promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
            });
        }
        operation.waiters += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            operation.waiters = Math.max(0, operation.waiters - 1);
            if (!operation.settled && operation.waiters === 0) operation.controller.abort();
        };
        if (!signal) return operation.promise.finally(release);
        if (signal.aborted) { release(); return Promise.reject(abortError()); }
        return new Promise((resolve, reject) => {
            const abort = () => { release(); reject(abortError()); };
            signal.addEventListener('abort', abort, { once: true });
            operation.promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort); release(); });
        });
    }
}

module.exports = { renderReportPdf, reportHtml, printWithChromium, PdfRenderService };
