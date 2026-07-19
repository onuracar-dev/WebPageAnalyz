class AppError extends Error {
    constructor(message, { status = 500, code = 'INTERNAL_ERROR', cause, expose = status < 500 } = {}) {
        super(message, { cause });
        this.name = this.constructor.name;
        this.status = status;
        this.code = code;
        this.expose = expose;
    }
}

class TimeoutError extends AppError {
    constructor(message = 'The operation timed out.') {
        super(message, { status: 504, code: 'OPERATION_TIMEOUT', expose: true });
    }
}

function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

module.exports = { AppError, TimeoutError, isAbortError };
