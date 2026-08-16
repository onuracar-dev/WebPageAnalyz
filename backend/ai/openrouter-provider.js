const { AppError, isAbortError } = require('../lib/errors');
const { AIProvider } = require('./provider');
const { executiveSummaryMessages, remediationMessages } = require('./prompts');
const { normalizeExecutiveInput, normalizeFindingForAI } = require('./redaction');
const {
    executiveSummarySchema,
    remediationSchema,
    validateExecutiveSummary,
    validateRemediation
} = require('./schemas');

const OPENROUTER_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function uniqueModels(primaryModel, fallbackModels = []) {
    return [...new Set([primaryModel, ...fallbackModels]
        .map((model) => String(model || '').trim())
        .filter(Boolean))];
}

function schemaPromptMessages(messages, schema) {
    const instruction = {
        role: 'system',
        content: `Return only one raw JSON object without Markdown fences or commentary. The object must exactly match this JSON Schema: ${JSON.stringify(schema)}`
    };
    return messages.length ? [messages[0], instruction, ...messages.slice(1)] : [instruction];
}

function boundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function safeHttpUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.toString() : '';
    } catch {
        return '';
    }
}

function createDeadline(signal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('AI provider timeout', 'TimeoutError'));
    }, timeoutMs);
    timer.unref?.();
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        cleanup() {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', abortFromCaller);
        }
    };
}

async function readLimitedJson(response, maxBytes) {
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > maxBytes) throw new AppError('AI provider response exceeded the configured limit.', { status: 502, code: 'AI_RESPONSE_TOO_LARGE' });
    let text;
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new AppError('AI provider response exceeded the configured limit.', { status: 502, code: 'AI_RESPONSE_TOO_LARGE' });
            }
            chunks.push(Buffer.from(value));
        }
        text = Buffer.concat(chunks).toString('utf8');
    } else if (typeof response.text === 'function') {
        text = await response.text();
    } else if (typeof response.json === 'function') {
        text = JSON.stringify(await response.json());
    } else {
        throw new AppError('AI provider returned an unreadable response.', { status: 502, code: 'AI_PROVIDER_INVALID_RESPONSE' });
    }
    if (Buffer.byteLength(text) > maxBytes) throw new AppError('AI provider response exceeded the configured limit.', { status: 502, code: 'AI_RESPONSE_TOO_LARGE' });
    try {
        return JSON.parse(text);
    } catch (cause) {
        throw new AppError('AI provider returned invalid JSON.', { status: 502, code: 'AI_PROVIDER_INVALID_RESPONSE', cause });
    }
}

function contentObject(payload) {
    const content = payload?.choices?.[0]?.message?.content;
    if (content && typeof content === 'object' && !Array.isArray(content)) return content;
    if (typeof content !== 'string') throw new AppError('AI provider returned empty structured content.', { status: 502, code: 'AI_PROVIDER_INVALID_RESPONSE' });
    try {
        return JSON.parse(content);
    } catch (cause) {
        throw new AppError('AI provider structured content was not valid JSON.', { status: 502, code: 'AI_SCHEMA_INVALID', cause });
    }
}

function selectedEndpoint(metadata) {
    const endpoints = metadata?.endpoints?.available;
    return Array.isArray(endpoints) ? endpoints.find((endpoint) => endpoint?.selected === true) : null;
}

function nonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function decimalString(value) {
    return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))
        ? String(value)
        : null;
}

function accountingFromPayload(payload, attempt) {
    const usage = payload?.usage || {};
    return Object.freeze({
        attempt,
        promptTokens: nonNegativeInteger(usage.prompt_tokens),
        completionTokens: nonNegativeInteger(usage.completion_tokens),
        totalTokens: nonNegativeInteger(usage.total_tokens),
        cachedTokens: nonNegativeInteger(usage.prompt_tokens_details?.cached_tokens),
        cacheWriteTokens: nonNegativeInteger(usage.prompt_tokens_details?.cache_write_tokens),
        reasoningTokens: nonNegativeInteger(usage.completion_tokens_details?.reasoning_tokens),
        costCredits: decimalString(usage.cost),
        upstreamInferenceCredits: decimalString(usage.cost_details?.upstream_inference_cost)
    });
}

function sumIntegers(attempts, key) {
    const values = attempts.map((attempt) => attempt[key]).filter((value) => Number.isInteger(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function sumDecimals(attempts, key) {
    const values = attempts.map((attempt) => attempt[key]).filter((value) => value !== null);
    return values.length ? String(values.reduce((sum, value) => sum + Number(value), 0)) : null;
}

function resultMetadata(payload, { models, latencyMs, clientAttempts, attemptAccounting = [], inputTokenUpperBound = null, dataCollection = 'deny', zeroDataRetention = false }) {
    const routing = payload?.openrouter_metadata || {};
    const endpoint = selectedEndpoint(routing);
    const accounting = attemptAccounting.length ? attemptAccounting : [accountingFromPayload(payload, clientAttempts)];
    return Object.freeze({
        provider: 'openrouter',
        requestedModel: models[0],
        requestedModels: Object.freeze([...models]),
        actualModel: typeof payload?.model === 'string' ? payload.model : endpoint?.model || null,
        actualProvider: typeof endpoint?.provider === 'string' ? endpoint.provider : null,
        providerRequestId: typeof payload?.id === 'string' ? payload.id.slice(0, 200) : null,
        timestamp: new Date().toISOString(),
        latencyMs,
        clientAttempts,
        inputTokenUpperBound,
        usage: Object.freeze({
            promptTokens: sumIntegers(accounting, 'promptTokens'),
            completionTokens: sumIntegers(accounting, 'completionTokens'),
            totalTokens: sumIntegers(accounting, 'totalTokens'),
            cachedTokens: sumIntegers(accounting, 'cachedTokens'),
            cacheWriteTokens: sumIntegers(accounting, 'cacheWriteTokens'),
            reasoningTokens: sumIntegers(accounting, 'reasoningTokens')
        }),
        cost: Object.freeze({
            totalCredits: sumDecimals(accounting, 'costCredits'),
            upstreamInferenceCredits: sumDecimals(accounting, 'upstreamInferenceCredits')
        }),
        attemptAccounting: Object.freeze([...accounting]),
        privacy: Object.freeze({ dataCollection, zeroDataRetentionRequested: zeroDataRetention === true }),
        routing: Object.freeze({
            strategy: typeof routing.strategy === 'string' ? routing.strategy : null,
            region: typeof routing.region === 'string' ? routing.region : null,
            routerAttempt: nonNegativeInteger(routing.attempt),
            fallbackUsed: typeof payload?.model === 'string' && payload.model !== models[0]
        })
    });
}

class OpenRouterProvider extends AIProvider {
    constructor({
        apiKey,
        primaryModel,
        fallbackModels = [],
        httpReferer,
        appTitle,
        fetchImpl = fetch,
        timeoutMs = 45_000,
        maxRequestBytes = 24 * 1024,
        maxResponseBytes = 64 * 1024,
        maxInputTokens = 4_096,
        maxOutputTokens = 1_200,
        maxAttempts = 2,
        retryDelayMs = 100,
        structuredOutputMode = 'native',
        reasoningEffort = null,
        sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        dataCollection = 'deny',
        zeroDataRetention = false
    } = {}) {
        const models = uniqueModels(primaryModel, fallbackModels);
        const referer = safeHttpUrl(httpReferer);
        const title = String(appTitle || '').trim().slice(0, 100);
        super({ name: 'openrouter', configured: Boolean(apiKey && models.length && referer && title) });
        this.apiKey = String(apiKey || '');
        this.models = Object.freeze(models);
        this.httpReferer = referer;
        this.appTitle = title;
        this.fetchImpl = fetchImpl;
        this.timeoutMs = boundedInteger(timeoutMs, 45_000, 1_000, 120_000);
        this.maxRequestBytes = boundedInteger(maxRequestBytes, 24 * 1024, 1_024, 256 * 1024);
        this.maxResponseBytes = boundedInteger(maxResponseBytes, 64 * 1024, 1_024, 512 * 1024);
        this.maxInputTokens = boundedInteger(maxInputTokens, 4_096, 128, 1_000_000);
        this.maxOutputTokens = boundedInteger(maxOutputTokens, 1_200, 64, 100_000);
        this.maxAttempts = boundedInteger(maxAttempts, 2, 1, 3);
        this.retryDelayMs = boundedInteger(retryDelayMs, 100, 0, 2_000);
        this.structuredOutputMode = structuredOutputMode === 'prompt' ? 'prompt' : 'native';
        this.reasoningEffort = reasoningEffort ? String(reasoningEffort) : null;
        this.sleepImpl = sleepImpl;
        this.dataCollection = dataCollection === 'allow' ? 'allow' : 'deny';
        this.zeroDataRetention = zeroDataRetention !== false;
    }

    assertConfigured() {
        if (!this.configured) throw new AppError('OpenRouter AI provider is not configured.', { status: 503, code: 'AI_NOT_CONFIGURED', expose: true });
    }

    async generateRemediation(finding, context = {}) {
        const normalized = normalizeFindingForAI(finding);
        return this.complete({
            operation: 'remediation',
            messages: remediationMessages(normalized),
            schemaName: 'wpa_remediation',
            schema: remediationSchema,
            validate: validateRemediation,
            signal: context.signal
        });
    }

    async generateExecutiveSummary(input, context = {}) {
        const normalized = normalizeExecutiveInput(input);
        return this.complete({
            operation: 'executive-summary',
            messages: executiveSummaryMessages(normalized),
            schemaName: 'wpa_executive_summary',
            schema: executiveSummarySchema,
            validate: validateExecutiveSummary,
            signal: context.signal
        });
    }

    async complete({ operation, messages, schemaName, schema, validate, signal }) {
        this.assertConfigured();
        if (signal?.aborted) throw new AppError('AI request was cancelled.', { status: 408, code: 'AI_REQUEST_ABORTED', expose: true });
        const startedAt = Date.now();
        let lastError;
        let lastPayload = null;
        let lastInputTokenUpperBound = null;
        let attemptsExecuted = 0;
        const attemptAccounting = [];
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            attemptsExecuted = attempt;
            const retryMessages = attempt === 1 ? messages : [
                ...messages,
                { role: 'system', content: 'The prior attempt failed validation. Return one complete JSON object that exactly matches the supplied schema.' }
            ];
            const nativeStructuredOutput = this.structuredOutputMode === 'native';
            const body = JSON.stringify({
                models: this.models,
                messages: nativeStructuredOutput ? retryMessages : schemaPromptMessages(retryMessages, schema),
                max_tokens: this.maxOutputTokens,
                ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort, exclude: true } } : {}),
                ...(nativeStructuredOutput ? { response_format: {
                    type: 'json_schema',
                    json_schema: { name: schemaName, strict: true, schema }
                } } : {}),
                provider: {
                    require_parameters: true,
                    data_collection: this.dataCollection,
                    zdr: this.zeroDataRetention
                }
            });
            if (Buffer.byteLength(body) > this.maxRequestBytes) throw new AppError('AI provider request exceeded the configured limit.', { status: 413, code: 'AI_REQUEST_TOO_LARGE', expose: true });
            // Byte length is a conservative tokenizer-independent upper bound for byte-level model tokenizers.
            // It may reject early, but it cannot silently permit a clearly oversized prompt.
            const inputTokenUpperBound = Buffer.byteLength(body, 'utf8');
            lastInputTokenUpperBound = inputTokenUpperBound;
            if (inputTokenUpperBound > this.maxInputTokens) throw new AppError('AI provider input exceeded the configured token limit.', { status: 413, code: 'AI_INPUT_TOKEN_LIMIT', expose: true });
            const deadline = createDeadline(signal, this.timeoutMs);
            try {
                const response = await this.fetchImpl(OPENROUTER_COMPLETIONS_URL, {
                    method: 'POST',
                    redirect: 'error',
                    signal: deadline.signal,
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'HTTP-Referer': this.httpReferer,
                        'X-OpenRouter-Title': this.appTitle,
                        'X-OpenRouter-Metadata': 'enabled'
                    },
                    body
                });
                if (!response.ok) {
                    const error = new AppError('OpenRouter could not complete the request.', {
                        status: RETRYABLE_STATUSES.has(response.status) ? 503 : 502,
                        code: 'AI_PROVIDER_ERROR'
                    });
                    error.retryable = RETRYABLE_STATUSES.has(response.status);
                    throw error;
                }
                const payload = await readLimitedJson(response, this.maxResponseBytes);
                lastPayload = payload;
                attemptAccounting.push(accountingFromPayload(payload, attempt));
                const output = validate(contentObject(payload));
                return Object.freeze({
                    operation,
                    output,
                    metadata: resultMetadata(payload, {
                        models: this.models,
                        latencyMs: Date.now() - startedAt,
                        clientAttempts: attempt,
                        attemptAccounting,
                        inputTokenUpperBound,
                        dataCollection: this.dataCollection,
                        zeroDataRetention: this.zeroDataRetention
                    })
                });
            } catch (cause) {
                if (signal?.aborted) throw new AppError('AI request was cancelled.', { status: 408, code: 'AI_REQUEST_ABORTED', expose: true, cause });
                if (deadline.timedOut() || isAbortError(cause)) {
                    lastError = new AppError('OpenRouter request timed out.', { status: 504, code: 'AI_PROVIDER_TIMEOUT', cause });
                    lastError.retryable = true;
                } else if (cause instanceof AppError) {
                    lastError = cause;
                    if (cause.code === 'AI_SCHEMA_INVALID' || cause.code === 'AI_PROVIDER_INVALID_RESPONSE') lastError.retryable = true;
                } else {
                    lastError = new AppError('OpenRouter could not complete the request.', { status: 503, code: 'AI_PROVIDER_ERROR', cause });
                    lastError.retryable = true;
                }
            } finally {
                deadline.cleanup();
            }
            if (attempt >= this.maxAttempts || lastError.retryable !== true) break;
            if (this.retryDelayMs) await this.sleepImpl(this.retryDelayMs * attempt);
        }
        const failure = lastError || new AppError('OpenRouter could not complete the request.', { status: 503, code: 'AI_PROVIDER_ERROR' });
        if (attemptAccounting.length) {
            failure.aiMetadata = resultMetadata(lastPayload || {}, {
                models: this.models,
                latencyMs: Date.now() - startedAt,
                clientAttempts: attemptsExecuted,
                attemptAccounting,
                inputTokenUpperBound: lastInputTokenUpperBound,
                dataCollection: this.dataCollection,
                zeroDataRetention: this.zeroDataRetention
            });
        }
        throw failure;
    }
}

function createOpenRouterProvider(options) {
    return new OpenRouterProvider(options);
}

module.exports = {
    OPENROUTER_COMPLETIONS_URL,
    OpenRouterAIProvider: OpenRouterProvider,
    OpenRouterProvider,
    createOpenRouterProvider,
    accountingFromPayload,
    readLimitedJson,
    resultMetadata,
    uniqueModels
};
