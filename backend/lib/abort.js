const { AppError, TimeoutError } = require('./errors');

function abortableDelay(milliseconds, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, milliseconds);
        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(signal.reason || new AppError('The operation was cancelled.', {
                status: 499,
                code: 'REQUEST_CANCELLED'
            }));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        timer.unref?.();
    });
}

function runWithTimeout(task, milliseconds, label, parentSignal) {
    if (parentSignal?.aborted) return Promise.reject(parentSignal.reason);
    const controller = new AbortController();

    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (method, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', onParentAbort);
            method(value);
        };
        const onParentAbort = () => {
            const reason = parentSignal.reason || new AppError('The operation was cancelled.', {
                status: 499,
                code: 'REQUEST_CANCELLED'
            });
            controller.abort(reason);
            settle(reject, reason);
        };
        parentSignal?.addEventListener('abort', onParentAbort, { once: true });

        const timer = setTimeout(() => {
            const error = new TimeoutError(`${label} exceeded its time limit.`);
            controller.abort(error);
            settle(reject, error);
        }, milliseconds);
        timer.unref?.();

        Promise.resolve()
            .then(() => task(controller.signal))
            .then((value) => settle(resolve, value))
            .catch((error) => settle(reject, error));
    });
}

module.exports = { abortableDelay, runWithTimeout };
