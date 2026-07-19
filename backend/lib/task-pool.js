const { AppError, TimeoutError } = require('./errors');

class TaskPool {
    constructor({ maxConcurrent = 2, maxQueue = 8 } = {}) {
        this.maxConcurrent = maxConcurrent;
        this.maxQueue = maxQueue;
        this.active = 0;
        this.queue = [];
        this.controllers = new Set();
        this.closed = false;
    }

    get stats() {
        return { active: this.active, queued: this.queue.length };
    }

    run(task, { signal, timeoutMs = 240_000 } = {}) {
        if (this.closed) {
            return Promise.reject(new AppError('The analysis service is shutting down.', {
                status: 503,
                code: 'SERVICE_UNAVAILABLE'
            }));
        }
        if (signal?.aborted) return Promise.reject(signal.reason || this.abortError());

        return new Promise((resolve, reject) => {
            const job = { task, signal, timeoutMs, resolve, reject, onAbort: null };
            if (this.active < this.maxConcurrent) {
                this.start(job);
                return;
            }
            if (this.queue.length >= this.maxQueue) {
                reject(new AppError('The analysis queue is full. Try again later.', {
                    status: 503,
                    code: 'ANALYSIS_QUEUE_FULL'
                }));
                return;
            }

            job.onAbort = () => {
                const index = this.queue.indexOf(job);
                if (index >= 0) this.queue.splice(index, 1);
                reject(signal.reason || this.abortError());
            };
            signal?.addEventListener('abort', job.onAbort, { once: true });
            this.queue.push(job);
        });
    }

    start(job) {
        job.signal?.removeEventListener('abort', job.onAbort);
        this.active += 1;
        const controller = new AbortController();
        this.controllers.add(controller);
        let responseSettled = false;

        const settle = (method, value) => {
            if (responseSettled) return;
            responseSettled = true;
            method(value);
        };

        const abortFromParent = () => {
            const reason = job.signal.reason || this.abortError();
            controller.abort(reason);
            settle(job.reject, reason);
        };
        job.signal?.addEventListener('abort', abortFromParent, { once: true });

        const timer = setTimeout(() => {
            const error = new TimeoutError('The analysis exceeded its time limit.');
            controller.abort(error);
            settle(job.reject, error);
        }, job.timeoutMs);

        Promise.resolve()
            .then(() => job.task(controller.signal))
            .then((value) => settle(job.resolve, value))
            .catch((error) => settle(job.reject, error))
            .finally(() => {
                clearTimeout(timer);
                job.signal?.removeEventListener('abort', abortFromParent);
                this.controllers.delete(controller);
                this.active -= 1;
                this.drain();
            });
    }

    drain() {
        while (!this.closed && this.active < this.maxConcurrent && this.queue.length > 0) {
            this.start(this.queue.shift());
        }
    }

    close() {
        this.closed = true;
        const error = new AppError('The analysis service is shutting down.', {
            status: 503,
            code: 'SERVICE_UNAVAILABLE'
        });
        for (const job of this.queue.splice(0)) {
            job.signal?.removeEventListener('abort', job.onAbort);
            job.reject(error);
        }
        for (const controller of this.controllers) controller.abort(error);
    }

    abortError() {
        return new AppError('The request was cancelled.', { status: 499, code: 'REQUEST_CANCELLED' });
    }
}

module.exports = { TaskPool };
