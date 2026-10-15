const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');
const { validatePublicUrl, isPublicAddress } = require('./url-safety');
const { AppError } = require('../lib/errors');

function createSafeLookup(customLookup, { allowPrivate = false } = {}) {
    const baseLookup = customLookup || dns.lookup;

    return function safeLookup(hostname, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        function checkAndCallback(err, address, family) {
            if (err) return callback(err);

            if (allowPrivate) {
                if (Array.isArray(address)) {
                    if (options && options.all) return callback(null, address);
                    const first = address[0];
                    const firstIp = typeof first === 'string' ? first : first.address;
                    const firstFam = typeof first === 'string' ? (net.isIP(firstIp) === 6 ? 6 : 4) : (first.family || 4);
                    return callback(null, firstIp, firstFam);
                }
                const ip = (typeof address === 'object' && address !== null) ? address.address : address;
                const fam = (typeof address === 'object' && address !== null) ? address.family : family;
                return callback(null, ip, fam || (net.isIP(ip) === 6 ? 6 : 4));
            }

            if (Array.isArray(address)) {
                for (const item of address) {
                    const ip = typeof item === 'string' ? item : item?.address;
                    if (!ip || !isPublicAddress(ip)) {
                        const blockedErr = new AppError(`DNS resolution returned private or reserved IP: ${ip}`, {
                            status: 400,
                            code: 'PRIVATE_TARGET_BLOCKED'
                        });
                        return callback(blockedErr);
                    }
                }
                if (options && options.all) {
                    return callback(null, address);
                }
                const first = address[0];
                const firstIp = typeof first === 'string' ? first : first.address;
                const firstFam = typeof first === 'string' ? (net.isIP(firstIp) === 6 ? 6 : 4) : (first.family || 4);
                return callback(null, firstIp, firstFam);
            }

            const ip = (typeof address === 'object' && address !== null) ? address.address : address;
            const fam = (typeof address === 'object' && address !== null) ? address.family : family;

            if (!ip || !isPublicAddress(ip)) {
                const blockedErr = new AppError(`DNS resolution returned private or reserved IP: ${ip}`, {
                    status: 400,
                    code: 'PRIVATE_TARGET_BLOCKED'
                });
                return callback(blockedErr);
            }

            return callback(null, ip, fam || (net.isIP(ip) === 6 ? 6 : 4));
        }

        let isCallbackCalled = false;
        const wrappedCallback = (err, address, family) => {
            if (isCallbackCalled) return;
            isCallbackCalled = true;
            checkAndCallback(err, address, family);
        };

        let result;
        try {
            result = baseLookup(hostname, options, wrappedCallback);
        } catch (syncError) {
            return callback(syncError);
        }

        if (result && typeof result.then === 'function') {
            result
                .then((res) => {
                    if (Array.isArray(res)) {
                        wrappedCallback(null, res);
                    } else if (res && typeof res === 'object') {
                        wrappedCallback(null, res.address, res.family);
                    } else {
                        wrappedCallback(null, res);
                    }
                })
                .catch((promiseErr) => {
                    wrappedCallback(promiseErr);
                });
        }
    };
}

function probeUrl(targetUrl, { method = 'HEAD', timeoutMs = 4000, lookup, allowPrivate = false } = {}) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(targetUrl);
        } catch (err) {
            return reject(new AppError('Invalid URL', { status: 400, code: 'INVALID_TARGET_URL', cause: err }));
        }

        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return reject(new AppError('Disallowed protocol', { status: 400, code: 'INVALID_TARGET_URL' }));
        }

        if (!allowPrivate && net.isIP(parsed.hostname) && !isPublicAddress(parsed.hostname)) {
            return reject(new AppError(`Target hostname is private or reserved IP: ${parsed.hostname}`, {
                status: 400,
                code: 'PRIVATE_TARGET_BLOCKED'
            }));
        }

        const transport = parsed.protocol === 'https:' ? https : http;
        const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
        const port = parsed.port ? Number(parsed.port) : defaultPort;

        let finished = false;
        let timer = null;

        const req = transport.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port,
            method,
            path: `${parsed.pathname || '/'}${parsed.search || ''}`,
            headers: {
                'User-Agent': 'WPA-Lite/1.0 (+https://webpageanalyzer.onuracar.dev/about)',
                'Connection': 'close',
                'Accept': '*/*'
            },
            lookup: createSafeLookup(lookup, { allowPrivate })
        });

        function cleanup() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                if (finished) return;
                finished = true;
                cleanup();
                req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
                reject(new Error(`Request timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }

        req.on('response', (res) => {
            if (finished) return;
            finished = true;
            cleanup();

            const statusCode = res.statusCode;
            const headers = res.headers;

            // Immediately destroy response stream and request to ensure body is NEVER read
            res.destroy();
            req.destroy();

            resolve({
                status: statusCode,
                headers: {
                    get: (name) => {
                        const val = headers[name.toLowerCase()];
                        return Array.isArray(val) ? val[0] : val;
                    }
                }
            });
        });

        req.on('error', (err) => {
            if (finished) return;
            finished = true;
            cleanup();
            reject(err);
        });

        req.end();
    });
}

async function resolveRedirects(initialUrl, {
    maxHops = 5,
    timeoutMs = 8000,
    allowedPorts = [80, 443],
    validator = validatePublicUrl,
    lookup = null,
    allowPrivate = false,
    fetchFn = null,
    probeFn = null
} = {}) {
    let currentUrl = initialUrl;
    const deadline = Date.now() + timeoutMs;

    const probe = probeFn || (fetchFn ? async (url, opts) => {
        return fetchFn(url, opts);
    } : (url, opts) => probeUrl(url, { ...opts, allowPrivate }));

    for (let hop = 0; hop < maxHops; hop += 1) {
        const remainingTime = deadline - Date.now();
        if (remainingTime <= 0) {
            break;
        }

        let res;
        try {
            res = await probe(currentUrl, {
                method: 'HEAD',
                timeoutMs: Math.min(remainingTime, 4000),
                lookup
            });

            // If HEAD returned 405 Method Not Allowed or 501 Not Implemented, try GET
            if (res.status === 405 || res.status === 501) {
                const getRemaining = deadline - Date.now();
                if (getRemaining <= 0) break;
                res = await probe(currentUrl, {
                    method: 'GET',
                    timeoutMs: Math.min(getRemaining, 4000),
                    lookup
                });
            }
        } catch (probeError) {
            // Rethrow SSRF and private IP blocked errors so caller can reject immediately
            if (probeError.code === 'PRIVATE_TARGET_BLOCKED' || probeError.code === 'URL_NOT_ALLOWED') {
                throw probeError;
            }
            // On network error or timeout: fall back gracefully to currentUrl
            return {
                resolvedUrl: currentUrl,
                hops: hop,
                redirected: currentUrl !== initialUrl
            };
        }

        // Check if response is a redirect status
        if (![301, 302, 303, 307, 308].includes(res.status)) {
            // Reached destination
            return {
                resolvedUrl: currentUrl,
                hops: hop,
                redirected: currentUrl !== initialUrl
            };
        }

        const location = res.headers.get('location');
        if (!location) {
            return {
                resolvedUrl: currentUrl,
                hops: hop,
                redirected: currentUrl !== initialUrl
            };
        }

        let nextUrl;
        try {
            nextUrl = new URL(location, currentUrl).toString();
        } catch {
            return {
                resolvedUrl: currentUrl,
                hops: hop,
                redirected: currentUrl !== initialUrl
            };
        }

        // SSRF check on every hop: Location MUST be a valid public URL
        const validatorOptions = { allowedPorts };
        if (lookup) {
            validatorOptions.lookup = lookup;
        }
        const validated = await validator(nextUrl, validatorOptions);
        currentUrl = validated.url;
    }

    // Exceeded maxHops: fallback to initialUrl
    return {
        resolvedUrl: initialUrl,
        hops: maxHops,
        redirected: false,
        exceededMaxHops: true
    };
}

module.exports = {
    resolveRedirects,
    probeUrl,
    createSafeLookup
};
