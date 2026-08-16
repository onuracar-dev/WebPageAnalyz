const test = require('node:test');
const assert = require('node:assert/strict');
const { PdfRenderService } = require('../reports/pdf');

test('PDF render service deduplicates concurrent report exports and caches by version', async () => {
    let calls = 0;
    const service = new PdfRenderService({ config: {}, maxConcurrent: 1, maxQueue: 2, renderer: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return Buffer.from('pdf'); } });
    const report = { id: 'rpt-pdf', version: 3 };
    const [left, right] = await Promise.all([service.render(report), service.render(report)]);
    assert.equal(left.toString(), 'pdf');
    assert.equal(right.toString(), 'pdf');
    assert.equal(calls, 1);
    await service.render(report);
    assert.equal(calls, 1);
});

test('PDF render service rejects beyond bounded queue capacity', async () => {
    let release;
    const service = new PdfRenderService({ config: {}, maxConcurrent: 1, maxQueue: 0, renderer: () => new Promise((resolve) => { release = () => resolve(Buffer.from('pdf')); }) });
    const first = service.render({ id: 'rpt-a', version: 1 });
    await assert.rejects(() => service.render({ id: 'rpt-b', version: 1 }), { code: 'PDF_QUEUE_FULL' });
    release();
    await first;
});

test('PDF client abort propagates to the underlying renderer', async () => {
    let rendererAborted = false;
    const service = new PdfRenderService({
        config: {},
        renderer: (_report, _config, { signal }) => new Promise((_resolve, reject) => {
            if (signal.aborted) { rendererAborted = true; reject(Object.assign(new Error('renderer closed'), { code: 'PDF_ABORTED' })); return; }
            signal.addEventListener('abort', () => { rendererAborted = true; reject(Object.assign(new Error('renderer closed'), { code: 'PDF_ABORTED' })); }, { once: true });
        })
    });
    const controller = new AbortController();
    const pending = service.render({ id: 'rpt-abort', version: 1 }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { code: 'CLIENT_DISCONNECTED' });
    assert.equal(rendererAborted, true);
});

test('PDF renderer refuses to execute inside an API-disabled boundary', async () => {
    const service = new PdfRenderService({ config: { pdfExecutionDisabled: true } });
    await assert.rejects(() => service.render({ id: 'rpt-disabled', version: 1 }), { code: 'PDF_WORKER_REQUIRED' });
});
