function serializeError(error) {
    if (!error) return undefined;
    return {
        name: error.name,
        message: redact(error.message),
        code: error.code,
        stack: process.env.NODE_ENV === 'production' ? undefined : redact(error.stack)
    };
}

function redact(value) {
    return String(value || '')
        .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[redacted]')
        .replace(/\b(?:AIza[\w-]{20,}|npm_[A-Za-z0-9]{20,})\b/g, '[redacted-secret]')
        .replace(/(authorization|x-api-key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function write(level, message, context = {}) {
    const payload = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...context
    };

    if (payload.error instanceof Error) payload.error = serializeError(payload.error);
    const line = JSON.stringify(payload);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

const logger = {
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context)
};

module.exports = { logger, redact, serializeError };
