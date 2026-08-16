const http = require('node:http');
const zlib = require('node:zlib');
const { SafeBrowserProxy } = require('../security/safe-proxy');
const { normalizePageUrl } = require('../domain/url-normalization');
const { createFinding } = require('../domain/findings');

const VERSION = '2.1.0';
const DISCOVERY_SOURCES = Object.freeze(['root', 'internal_link', 'rendered_link', 'sitemap', 'manual', 'canonical', 'hreflang']);
const DEFAULT_DISCOVERY_LIMITS = Object.freeze({
    maxSitemaps: 20,
    maxSitemapUrls: 5_000,
    maxSitemapResponseBytes: 4_000_000,
    maxSitemapXmlBytes: 8_000_000,
    maxSitemapDecompressedBytes: 8_000_000,
    maxSitemapDepth: 3,
    maxDiscoveryMs: 30_000,
    maxQueuedUrls: 1_000,
    maxPathDepth: 16,
    maxQueryVariantsPerPath: 5,
    maxPaginationValue: 250,
    maxCalendarYearDrift: 5
});

function codedError(code, message) {
    return Object.assign(new Error(message), { code });
}

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function resolveDiscoveryLimits(pageLimit, overrides = {}) {
    return {
        maxSitemaps: boundedInteger(overrides.maxSitemaps, DEFAULT_DISCOVERY_LIMITS.maxSitemaps, { max: 100 }),
        maxSitemapUrls: boundedInteger(overrides.maxSitemapUrls, DEFAULT_DISCOVERY_LIMITS.maxSitemapUrls, { max: 50_000 }),
        maxSitemapResponseBytes: boundedInteger(overrides.maxSitemapResponseBytes, DEFAULT_DISCOVERY_LIMITS.maxSitemapResponseBytes, { max: 20_000_000 }),
        maxSitemapXmlBytes: boundedInteger(overrides.maxSitemapXmlBytes, DEFAULT_DISCOVERY_LIMITS.maxSitemapXmlBytes, { max: 40_000_000 }),
        maxSitemapDecompressedBytes: boundedInteger(overrides.maxSitemapDecompressedBytes, DEFAULT_DISCOVERY_LIMITS.maxSitemapDecompressedBytes, { max: 40_000_000 }),
        maxSitemapDepth: boundedInteger(overrides.maxSitemapDepth, DEFAULT_DISCOVERY_LIMITS.maxSitemapDepth, { min: 0, max: 10 }),
        maxDiscoveryMs: boundedInteger(overrides.maxDiscoveryMs, DEFAULT_DISCOVERY_LIMITS.maxDiscoveryMs, { min: 100, max: 120_000 }),
        maxQueuedUrls: boundedInteger(overrides.maxQueuedUrls, Math.max(DEFAULT_DISCOVERY_LIMITS.maxQueuedUrls, pageLimit * 4), { max: 20_000 }),
        maxPathDepth: boundedInteger(overrides.maxPathDepth, DEFAULT_DISCOVERY_LIMITS.maxPathDepth, { max: 100 }),
        maxQueryVariantsPerPath: boundedInteger(overrides.maxQueryVariantsPerPath, DEFAULT_DISCOVERY_LIMITS.maxQueryVariantsPerPath, { max: 100 }),
        maxPaginationValue: boundedInteger(overrides.maxPaginationValue, DEFAULT_DISCOVERY_LIMITS.maxPaginationValue, { max: 100_000 }),
        maxCalendarYearDrift: boundedInteger(overrides.maxCalendarYearDrift, DEFAULT_DISCOVERY_LIMITS.maxCalendarYearDrift, { min: 0, max: 50 })
    };
}

function decodeXml(value) {
    return value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

function extractSitemapUrls(xml) {
    return [...String(xml).matchAll(/<(?:[\w.-]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?loc>/gi)]
        .map((match) => decodeXml(match[1].trim()))
        .filter(Boolean);
}

function parseSitemapDocument(xml) {
    const source = String(xml).replace(/^\uFEFF/, '').trimStart();
    const root = source.match(/<(?:[\w.-]+:)?(sitemapindex|urlset)\b/i)?.[1]?.toLowerCase();
    if (!root) throw codedError('CRAWLER_SITEMAP_TYPE_INVALID', 'Sitemap XML must contain a urlset or sitemapindex root.');
    return { type: root === 'sitemapindex' ? 'index' : 'urlset', locations: extractSitemapUrls(source) };
}

function parseTagAttributes(tag) {
    const attributes = {};
    for (const match of String(tag).matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    return attributes;
}

function normalizedReference(value, baseUrl) {
    try {
        const parsed = new URL(value, baseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
        return normalizePageUrl(parsed.toString());
    } catch { return ''; }
}

function extractPageSignals(html, baseUrl) {
    const links = [];
    for (const match of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const link = normalizedReference(match[1] ?? match[2] ?? match[3], baseUrl);
        if (link) links.push(link);
    }
    let canonical = '';
    const hreflangLinks = [];
    for (const match of String(html).matchAll(/<link\b[^>]*>/gi)) {
        const attributes = parseTagAttributes(match[0]);
        const href = normalizedReference(attributes.href, baseUrl);
        if (!href) continue;
        const relationships = String(attributes.rel || '').toLowerCase().split(/\s+/);
        if (!canonical && relationships.includes('canonical')) canonical = href;
        if (attributes.hreflang) hreflangLinks.push({ language: attributes.hreflang, url: href });
    }
    const robotsTag = [...String(html).matchAll(/<meta\b[^>]*>/gi)].find((match) => parseTagAttributes(match[0]).name?.toLowerCase() === 'robots');
    return {
        links: [...new Set(links)],
        canonical,
        hreflangs: [...new Set(hreflangLinks.map((entry) => entry.language))],
        hreflangLinks: [...new Map(hreflangLinks.map((entry) => [`${entry.language}\u0000${entry.url}`, entry])).values()],
        robotsMeta: robotsTag ? parseTagAttributes(robotsTag[0]).content?.trim() || '' : ''
    };
}

function parseRobots(text) {
    const disallow = [];
    const allow = [];
    const sitemaps = [];
    let applies = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        const [rawName, ...rest] = line.split(':');
        const name = rawName?.trim().toLowerCase();
        const value = rest.join(':').trim();
        if (name === 'user-agent') applies = value === '*';
        else if (name === 'disallow' && applies && value) disallow.push(value);
        else if (name === 'allow' && applies && value) allow.push(value);
        else if (name === 'sitemap' && value) sitemaps.push(value);
    }
    return { disallow, allow, sitemaps };
}

function robotsPattern(pattern) {
    const anchored = pattern.endsWith('$');
    const source = anchored ? pattern.slice(0, -1) : pattern;
    const escaped = source.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}${anchored ? '$' : '.*'}`);
}

function isRobotsAllowed(pathname, robots) {
    const matches = [
        ...(robots.disallow || []).map((pattern) => ({ pattern, allow: false })),
        ...(robots.allow || []).map((pattern) => ({ pattern, allow: true }))
    ].filter((rule) => robotsPattern(rule.pattern).test(pathname)).sort((a, b) => b.pattern.length - a.pattern.length);
    return matches.length ? matches[0].allow : true;
}

function getThroughProxy(proxyUrl, targetUrl, {
    maxBytes = 2_000_000,
    redirects = 5,
    signal,
    allowedOrigins,
    allowedOrigin,
    timeoutMs = 15_000
} = {}) {
    return new Promise((resolve, reject) => {
        const proxy = new URL(proxyUrl);
        const scope = new Set(allowedOrigins || (allowedOrigin ? [allowedOrigin] : []));
        const request = http.request({
            hostname: proxy.hostname, port: proxy.port, method: 'GET', path: targetUrl,
            headers: { accept: 'text/html,application/xml,text/xml,application/gzip,text/plain;q=0.9,*/*;q=0.1', 'user-agent': 'WebPageAnalyzerBot/2.0' }
        }, (response) => {
            const status = response.statusCode || 0;
            const location = response.headers.location;
            if (location && status >= 300 && status < 400) {
                response.resume();
                if (redirects <= 0) { reject(codedError('CRAWLER_REDIRECT_LIMIT', 'Crawler redirect limit was reached.')); return; }
                let next;
                try { next = new URL(location, targetUrl).toString(); } catch (error) { reject(error); return; }
                if (scope.size && !scope.has(new URL(next).origin)) { reject(codedError('CRAWLER_ORIGIN_REDIRECT_BLOCKED', 'Crawler redirect left the authorized scope.')); return; }
                getThroughProxy(proxyUrl, next, { maxBytes, redirects: redirects - 1, signal, allowedOrigins: [...scope], timeoutMs }).then(resolve, reject);
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes) request.destroy(codedError('CRAWLER_RESPONSE_TOO_LARGE', 'Crawler response exceeded its byte limit.'));
                else chunks.push(chunk);
            });
            response.on('end', () => {
                const bodyBuffer = Buffer.concat(chunks);
                resolve({ url: targetUrl, status, headers: response.headers, bodyBuffer, body: bodyBuffer.toString('utf8') });
            });
        });
        request.setTimeout(Math.max(1, timeoutMs), () => request.destroy(codedError('CRAWLER_TIMEOUT', 'Crawler request timed out.')));
        request.on('error', reject);
        const abort = () => request.destroy(signal.reason || codedError('CRAWLER_ABORTED', 'Crawler aborted.'));
        signal?.addEventListener('abort', abort, { once: true });
        request.once('close', () => signal?.removeEventListener('abort', abort));
        request.end();
    });
}

async function discoverSiteV1(origin, { limit = 25, config, logger, signal } = {}) {
    const root = normalizePageUrl(origin);
    const originValue = new URL(root).origin;
    const proxy = new SafeBrowserProxy({ allowedPorts: config.allowedTargetPorts, allowedOrigins: [originValue], readOnly: true, logger, connectTimeoutMs: config.timeouts.proxyConnectMs, ...config.proxyLimits });
    const proxyUrl = await proxy.start();
    try {
        const robotsResponse = await getThroughProxy(proxyUrl, `${originValue}/robots.txt`, { signal, allowedOrigin: originValue }).catch(() => ({ body: '', status: 0 }));
        const robots = parseRobots(robotsResponse.body);
        const sitemapCandidates = robots.sitemaps.length ? robots.sitemaps : [`${originValue}/sitemap.xml`];
        const seeds = [{ url: root, discoverySource: 'root', referrer: null }];
        const sitemapCoverage = [];
        for (const sitemapUrl of sitemapCandidates.slice(0, 5)) {
            let sitemapOrigin = '';
            try { sitemapOrigin = new URL(sitemapUrl).origin; } catch { /* invalid sitemap is recorded below */ }
            if (sitemapOrigin !== originValue) { sitemapCoverage.push({ url: sitemapUrl, status: 0, reachable: false, errorCode: 'CRAWLER_ORIGIN_MISMATCH' }); continue; }
            const response = await getThroughProxy(proxyUrl, sitemapUrl, { signal, allowedOrigin: originValue }).catch(() => null);
            sitemapCoverage.push({ url: sitemapUrl, status: response?.status || 0, reachable: Boolean(response && response.status > 0 && response.status < 400) });
            if (!response || response.status >= 400) continue;
            for (const url of extractSitemapUrls(response.body)) {
                try { if (new URL(url).origin === originValue) seeds.push({ url: normalizePageUrl(url), discoverySource: 'sitemap', referrer: sitemapUrl }); } catch { /* ignore invalid sitemap URLs */ }
            }
        }
        const queued = new Set();
        const queue = [];
        for (const seed of seeds) if (!queued.has(seed.url)) { queued.add(seed.url); queue.push(seed); }
        const visited = new Set();
        const pages = [];
        const skippedByRobots = [];
        let internalLinksDiscovered = 0;
        while (queue.length && visited.size < limit) {
            signal?.throwIfAborted();
            const current = queue.shift();
            const url = current.url;
            if (visited.has(url) || new URL(url).origin !== originValue) continue;
            if (!isRobotsAllowed(new URL(url).pathname, robots)) { skippedByRobots.push({ url, discoverySource: current.discoverySource, referrer: current.referrer }); continue; }
            visited.add(url);
            const response = await getThroughProxy(proxyUrl, url, { signal, allowedOrigin: originValue }).catch((error) => ({ url, status: 0, headers: {}, body: '', errorCode: error.code || 'CRAWL_FAILED' }));
            const signals = extractPageSignals(response.body, url);
            pages.push({ url, status: response.status, discoverySource: current.discoverySource, referrer: current.referrer, canonical: signals.canonical, hreflangs: signals.hreflangs, robotsMeta: signals.robotsMeta, errorCode: response.errorCode });
            for (const link of signals.links) if (new URL(link).origin === originValue && !visited.has(link) && !queued.has(link) && queue.length + visited.size < limit * 3) {
                queued.add(link); queue.push({ url: link, discoverySource: 'internal_link', referrer: url }); internalLinksDiscovered += 1;
            }
        }
        const findings = pages.filter((page) => page.status === 0 || page.status >= 400).map((page) => createFinding({
            ruleId: 'crawler.page.unreachable', category: 'crawler', severity: 'high', confidence: 0.98, kind: 'measured',
            pageUrl: page.url, source: 'WPA Crawler', sourceVersion: VERSION,
            title: 'Discovered page is unreachable', description: `The crawler received status ${page.status || 'network failure'}.`,
            moduleId: 'full_site_crawl', engineId: 'crawler', device: 'crawler', evidenceKey: `${page.discoverySource}:${page.referrer || ''}`,
            evidence: [{ type: 'http', status: page.status, errorCode: page.errorCode || null, discoverySource: page.discoverySource, referrer: page.referrer }], remediation: 'Repair the route or remove internal and sitemap references to it.'
        }));
        const coverage = {
            limit, attemptedPages: pages.length, reachablePages: pages.filter((page) => page.status > 0 && page.status < 400).length,
            brokenPages: findings.length, queuedRemaining: queue.length, internalLinksDiscovered, skippedByRobots: skippedByRobots.length,
            robots: { status: robotsResponse.status, rules: robots.disallow.length + robots.allow.length, sitemapsDeclared: robots.sitemaps.length },
            sitemaps: sitemapCoverage, truncated: queue.length > 0 || visited.size >= limit
        };
        return { version: VERSION, status: 'completed', origin: originValue, urls: pages.filter((page) => page.status > 0 && page.status < 400).map((page) => page.url), pages, findings, robots, skippedByRobots, coverage };
    } finally { await proxy.stop(); }
}

function decodeSitemapPayload(response, { maxResponseBytes, maxXmlBytes, maxDecompressedBytes }) {
    const input = Buffer.isBuffer(response.bodyBuffer) ? response.bodyBuffer : Buffer.from(response.body || '', 'utf8');
    if (input.length > maxResponseBytes) throw codedError('CRAWLER_SITEMAP_RESPONSE_TOO_LARGE', 'Sitemap response exceeded the remaining global byte budget.');
    const encoding = String(response.headers?.['content-encoding'] || '').toLowerCase();
    const gzip = encoding.includes('gzip') || String(response.url || '').toLowerCase().endsWith('.gz') || (input[0] === 0x1f && input[1] === 0x8b);
    let xmlBuffer = input;
    let decompressedBytes = 0;
    if (gzip) {
        try {
            xmlBuffer = zlib.gunzipSync(input, { maxOutputLength: maxDecompressedBytes + 1 });
        } catch (error) {
            if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /output length|larger than/i.test(error?.message || '')) {
                throw codedError('CRAWLER_SITEMAP_DECOMPRESSED_TOO_LARGE', 'Compressed sitemap exceeded the remaining decompressed-byte budget.');
            }
            throw codedError('CRAWLER_SITEMAP_GZIP_INVALID', 'Compressed sitemap could not be decoded safely.');
        }
        decompressedBytes = xmlBuffer.length;
        if (decompressedBytes > maxDecompressedBytes) throw codedError('CRAWLER_SITEMAP_DECOMPRESSED_TOO_LARGE', 'Compressed sitemap exceeded the remaining decompressed-byte budget.');
    }
    if (xmlBuffer.length > maxXmlBytes) throw codedError('CRAWLER_SITEMAP_XML_TOO_LARGE', 'Sitemap XML exceeded the remaining global XML byte budget.');
    return { xml: xmlBuffer.toString('utf8'), responseBytes: input.length, xmlBytes: xmlBuffer.length, decompressedBytes, gzip };
}

function normalizeAuthorizedOrigins(root, values = []) {
    const origins = new Set([new URL(root).origin]);
    for (const value of values || []) {
        try {
            const parsed = new URL(value);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
            origins.add(parsed.origin);
        } catch { /* Invalid authorization entries never widen scope. */ }
    }
    return origins;
}

function candidateTrapReason(value, limits = DEFAULT_DISCOVERY_LIMITS, currentYear = new Date().getUTCFullYear()) {
    const url = value instanceof URL ? value : new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length > limits.maxPathDepth) return 'path_depth';
    if (/;jsessionid=|\/(?:session|sessions)\/[A-Za-z0-9_-]{12,}/i.test(url.pathname)) return 'session_identifier';
    for (const [name, parameterValue] of url.searchParams) {
        if (/^(?:sid|sessionid|phpsessid|jsessionid)$/i.test(name) || (/session/i.test(name) && parameterValue.length >= 8)) return 'session_identifier';
        if (/^(?:page|paged|p|offset|start)$/i.test(name) && /^\d+$/.test(parameterValue) && Number(parameterValue) > limits.maxPaginationValue) return 'pagination';
    }
    for (let index = 0; index < segments.length; index += 1) {
        const pageMatch = segments[index].match(/^(?:page|paged)-(\d+)$/i) || (/(?:page|pages|pagination)/i.test(segments[index - 1] || '') ? segments[index].match(/^(\d+)$/) : null);
        if (pageMatch && Number(pageMatch[1]) > limits.maxPaginationValue) return 'pagination';
        const year = /^(?:19|20|21)\d{2}$/.test(segments[index]) ? Number(segments[index]) : null;
        if (year && Math.abs(year - currentYear) > limits.maxCalendarYearDrift) return 'calendar';
    }
    return null;
}

function renderedLinkEntries(renderedLinks, renderedLinksByPage) {
    const entries = [];
    for (const item of renderedLinks || []) {
        if (typeof item === 'string') entries.push({ url: item, referrer: null });
        else if (item && typeof item.url === 'string') entries.push({ url: item.url, referrer: typeof item.referrer === 'string' ? item.referrer : null });
    }
    if (renderedLinksByPage && typeof renderedLinksByPage === 'object' && !Array.isArray(renderedLinksByPage)) {
        for (const [referrer, links] of Object.entries(renderedLinksByPage)) {
            if (!Array.isArray(links)) continue;
            for (const url of links) if (typeof url === 'string') entries.push({ url, referrer });
        }
    }
    return entries;
}

async function discoverSitemaps(initialUrls, { fetchSitemap, allowedOrigins, limits, startedAt = Date.now(), clock = Date.now, signal }) {
    const queue = [...new Set(initialUrls)].map((url) => ({ url, depth: 0, referrer: null }));
    const seen = new Set();
    const pageSeeds = [];
    const documents = [];
    const blockedLocations = [];
    const truncatedReasons = new Set();
    const counters = { sitemapCount: 0, locationsSeen: 0, responseBytes: 0, xmlBytes: 0, decompressedBytes: 0, indexes: 0, urlsets: 0, cycles: 0, offScope: 0, invalid: 0 };
    const remainingMs = () => limits.maxDiscoveryMs - (clock() - startedAt);
    while (queue.length) {
        signal?.throwIfAborted();
        if (remainingMs() <= 0) { truncatedReasons.add('time'); break; }
        const current = queue.shift();
        let parsedUrl;
        try { parsedUrl = new URL(current.url, current.referrer || undefined); } catch {
            counters.invalid += 1;
            documents.push({ url: current.url, depth: current.depth, status: 0, reachable: false, errorCode: 'CRAWLER_SITEMAP_URL_INVALID' });
            continue;
        }
        const sitemapUrl = parsedUrl.toString();
        if (!allowedOrigins.has(parsedUrl.origin)) {
            counters.offScope += 1;
            documents.push({ url: sitemapUrl, depth: current.depth, status: 0, reachable: false, errorCode: 'CRAWLER_ORIGIN_MISMATCH' });
            continue;
        }
        if (seen.has(sitemapUrl)) {
            counters.cycles += 1;
            documents.push({ url: sitemapUrl, depth: current.depth, status: 0, reachable: false, errorCode: 'CRAWLER_SITEMAP_CYCLE', referrer: current.referrer });
            continue;
        }
        if (seen.size >= limits.maxSitemaps) { truncatedReasons.add('sitemap_count'); break; }
        seen.add(sitemapUrl);
        const remainingResponseBytes = limits.maxSitemapResponseBytes - counters.responseBytes;
        const remainingXmlBytes = limits.maxSitemapXmlBytes - counters.xmlBytes;
        const remainingDecompressedBytes = limits.maxSitemapDecompressedBytes - counters.decompressedBytes;
        if (remainingResponseBytes <= 0 || remainingXmlBytes <= 0 || remainingDecompressedBytes <= 0) { truncatedReasons.add('sitemap_bytes'); break; }
        let response;
        try {
            response = await fetchSitemap(sitemapUrl, { maxBytes: remainingResponseBytes, timeoutMs: Math.max(1, remainingMs()), signal });
        } catch (error) {
            documents.push({ url: sitemapUrl, depth: current.depth, status: 0, reachable: false, errorCode: error.code || 'CRAWLER_SITEMAP_FETCH_FAILED' });
            if (['CRAWLER_RESPONSE_TOO_LARGE', 'CRAWLER_SITEMAP_RESPONSE_TOO_LARGE'].includes(error.code)) {
                truncatedReasons.add('sitemap_bytes');
                break;
            }
            continue;
        }
        const document = { url: sitemapUrl, depth: current.depth, status: response?.status || 0, reachable: Boolean(response && response.status > 0 && response.status < 400), referrer: current.referrer };
        if (!response || response.status >= 400) { documents.push(document); continue; }
        try {
            const rawBytes = Buffer.isBuffer(response.bodyBuffer) ? response.bodyBuffer.length : Buffer.byteLength(response.body || '', 'utf8');
            counters.responseBytes += rawBytes;
            const payload = decodeSitemapPayload(response, { maxResponseBytes: remainingResponseBytes, maxXmlBytes: remainingXmlBytes, maxDecompressedBytes: remainingDecompressedBytes });
            counters.xmlBytes += payload.xmlBytes;
            counters.decompressedBytes += payload.decompressedBytes;
            const parsed = parseSitemapDocument(payload.xml);
            Object.assign(document, { type: parsed.type, gzip: payload.gzip, locations: parsed.locations.length });
            counters.sitemapCount += 1;
            if (parsed.type === 'index') counters.indexes += 1;
            else counters.urlsets += 1;
            for (const location of parsed.locations) {
                if (counters.locationsSeen >= limits.maxSitemapUrls) { truncatedReasons.add('sitemap_urls'); break; }
                counters.locationsSeen += 1;
                let resolved;
                try { resolved = new URL(location, sitemapUrl); } catch { counters.invalid += 1; continue; }
                if (!allowedOrigins.has(resolved.origin)) {
                    counters.offScope += 1;
                    blockedLocations.push({ url: resolved.toString(), referrer: sitemapUrl, kind: parsed.type === 'index' ? 'sitemap' : 'page', errorCode: 'CRAWLER_ORIGIN_MISMATCH' });
                    continue;
                }
                if (parsed.type === 'index') {
                    if (current.depth >= limits.maxSitemapDepth) { truncatedReasons.add('sitemap_depth'); continue; }
                    queue.push({ url: resolved.toString(), depth: current.depth + 1, referrer: sitemapUrl });
                } else {
                    pageSeeds.push({ url: resolved.toString(), source: { type: 'sitemap', referrer: sitemapUrl } });
                }
            }
        } catch (error) {
            document.reachable = false;
            document.errorCode = error.code || 'CRAWLER_SITEMAP_INVALID';
            if (['CRAWLER_SITEMAP_RESPONSE_TOO_LARGE', 'CRAWLER_SITEMAP_XML_TOO_LARGE', 'CRAWLER_SITEMAP_DECOMPRESSED_TOO_LARGE'].includes(document.errorCode)) {
                truncatedReasons.add('sitemap_bytes');
                documents.push(document);
                break;
            }
        }
        documents.push(document);
    }
    return {
        pageSeeds,
        documents,
        blockedLocations,
        counters,
        truncatedReasons: [...truncatedReasons],
        limits: {
            maxSitemaps: limits.maxSitemaps,
            maxSitemapUrls: limits.maxSitemapUrls,
            maxSitemapResponseBytes: limits.maxSitemapResponseBytes,
            maxSitemapXmlBytes: limits.maxSitemapXmlBytes,
            maxSitemapDecompressedBytes: limits.maxSitemapDecompressedBytes,
            maxSitemapDepth: limits.maxSitemapDepth,
            maxDiscoveryMs: limits.maxDiscoveryMs
        }
    };
}

async function discoverSite(origin, {
    limit = 25,
    config = {},
    logger,
    signal,
    discoveryLimits,
    manualUrls = [],
    additionalUrls = [],
    authorizedOrigins = [],
    renderedLinks = [],
    renderedLinksByPage = null,
    clock = Date.now
} = {}) {
    const pageLimit = boundedInteger(limit, 25, { max: 500 });
    const limits = resolveDiscoveryLimits(pageLimit, discoveryLimits);
    const startedAt = clock();
    const root = normalizePageUrl(origin);
    const rootOrigin = new URL(root).origin;
    const scope = normalizeAuthorizedOrigins(root, authorizedOrigins);
    const proxy = new SafeBrowserProxy({
        allowedPorts: config.allowedTargetPorts,
        allowedOrigins: [...scope],
        readOnly: true,
        logger,
        connectTimeoutMs: config.timeouts?.proxyConnectMs,
        ...config.proxyLimits
    });
    const proxyUrl = await proxy.start();
    const remainingMs = () => limits.maxDiscoveryMs - (clock() - startedAt);
    const request = (url, options = {}) => getThroughProxy(proxyUrl, url, {
        signal,
        allowedOrigins: [...scope],
        timeoutMs: Math.max(1, Math.min(options.timeoutMs || 15_000, remainingMs())),
        maxBytes: options.maxBytes,
        redirects: options.redirects
    });
    try {
        const robotsCache = new Map();
        const robotsCoverage = [];
        async function robotsFor(targetOrigin) {
            if (robotsCache.has(targetOrigin)) return robotsCache.get(targetOrigin);
            if (remainingMs() <= 0) {
                const unavailable = { disallow: [], allow: [], sitemaps: [] };
                robotsCache.set(targetOrigin, unavailable);
                robotsCoverage.push({ origin: targetOrigin, status: 0, rules: 0, sitemapsDeclared: 0, errorCode: 'CRAWLER_DISCOVERY_TIMEOUT' });
                return unavailable;
            }
            const response = await request(`${targetOrigin}/robots.txt`, { maxBytes: 500_000 }).catch((error) => ({ body: '', status: 0, errorCode: error.code || 'CRAWLER_ROBOTS_FETCH_FAILED' }));
            const parsed = parseRobots(response.body);
            robotsCache.set(targetOrigin, parsed);
            robotsCoverage.push({ origin: targetOrigin, status: response.status || 0, rules: parsed.disallow.length + parsed.allow.length, sitemapsDeclared: parsed.sitemaps.length, errorCode: response.errorCode || null });
            return parsed;
        }
        const robots = await robotsFor(rootOrigin);
        await Promise.all([...scope].filter((targetOrigin) => targetOrigin !== rootOrigin).map((targetOrigin) => robotsFor(targetOrigin)));
        const sitemapDiscovery = await discoverSitemaps([...new Set([...robots.sitemaps, `${rootOrigin}/sitemap.xml`])], {
            allowedOrigins: scope,
            limits,
            startedAt,
            clock,
            signal,
            fetchSitemap: (url, options) => request(url, options)
        });
        const queue = [];
        const entries = new Map();
        const visited = new Set();
        const queryVariants = new Map();
        const skipped = { invalid: 0, offScope: 0, queueLimit: 0, traps: {}, robots: 0 };
        const sourceStats = Object.fromEntries(DISCOVERY_SOURCES.map((source) => [source, { references: 0, uniqueUrls: 0 }]));
        let provenanceMerges = 0;
        const truncatedReasons = new Set(sitemapDiscovery.truncatedReasons);

        function addCandidate(rawValue, source, baseUrl) {
            if (!sourceStats[source.type]) return false;
            sourceStats[source.type].references += 1;
            let parsed;
            try {
                parsed = new URL(rawValue, baseUrl || undefined);
                if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsafe URL');
            } catch { skipped.invalid += 1; return false; }
            if (!scope.has(parsed.origin)) { skipped.offScope += 1; return false; }
            const trap = candidateTrapReason(parsed, limits);
            if (trap) { skipped.traps[trap] = (skipped.traps[trap] || 0) + 1; return false; }
            let url;
            try { url = normalizePageUrl(parsed.toString()); } catch { skipped.invalid += 1; return false; }
            const existing = entries.get(url);
            const provenance = { type: source.type, referrer: source.referrer || null };
            if (existing) {
                if (!existing.sources.some((item) => item.type === provenance.type && item.referrer === provenance.referrer)) {
                    existing.sources.push(provenance);
                    provenanceMerges += 1;
                }
                return false;
            }
            const normalized = new URL(url);
            const queryKey = `${normalized.origin}${normalized.pathname}`;
            const variants = queryVariants.get(queryKey) || new Set();
            if (normalized.search && !variants.has(normalized.search) && variants.size >= limits.maxQueryVariantsPerPath) {
                skipped.traps.query_explosion = (skipped.traps.query_explosion || 0) + 1;
                return false;
            }
            if (normalized.search) { variants.add(normalized.search); queryVariants.set(queryKey, variants); }
            if (entries.size >= limits.maxQueuedUrls) {
                skipped.queueLimit += 1;
                truncatedReasons.add('queued_urls');
                return false;
            }
            const entry = { url, sources: [provenance] };
            entries.set(url, entry);
            queue.push(entry);
            sourceStats[source.type].uniqueUrls += 1;
            return true;
        }

        addCandidate(root, { type: 'root', referrer: null });
        for (const seed of sitemapDiscovery.pageSeeds) addCandidate(seed.url, seed.source);
        for (const url of [...manualUrls, ...additionalUrls]) addCandidate(url, { type: 'manual', referrer: null }, root);
        for (const entry of renderedLinkEntries(renderedLinks, renderedLinksByPage)) addCandidate(entry.url, { type: 'rendered_link', referrer: entry.referrer }, entry.referrer || root);

        const pages = [];
        const skippedByRobots = [];
        while (queue.length && visited.size < pageLimit) {
            signal?.throwIfAborted();
            if (remainingMs() <= 0) { truncatedReasons.add('time'); break; }
            const current = queue.shift();
            if (visited.has(current.url)) continue;
            const parsed = new URL(current.url);
            const targetRobots = await robotsFor(parsed.origin);
            if (!isRobotsAllowed(`${parsed.pathname}${parsed.search}`, targetRobots)) {
                skipped.robots += 1;
                skippedByRobots.push({ url: current.url, sources: current.sources });
                continue;
            }
            visited.add(current.url);
            const response = await request(current.url, { maxBytes: 2_000_000 }).catch((error) => ({ url: current.url, status: 0, headers: {}, body: '', bodyBuffer: Buffer.alloc(0), errorCode: error.code || 'CRAWL_FAILED' }));
            const signals = extractPageSignals(response.body, current.url);
            const primary = current.sources[0];
            pages.push({
                url: current.url,
                status: response.status,
                discoverySource: primary.type,
                referrer: primary.referrer,
                sources: current.sources,
                canonical: signals.canonical,
                hreflangs: signals.hreflangs,
                hreflangLinks: signals.hreflangLinks,
                robotsMeta: signals.robotsMeta,
                errorCode: response.errorCode
            });
            for (const link of signals.links) addCandidate(link, { type: 'internal_link', referrer: current.url }, current.url);
            if (signals.canonical) addCandidate(signals.canonical, { type: 'canonical', referrer: current.url }, current.url);
            for (const alternate of signals.hreflangLinks) addCandidate(alternate.url, { type: 'hreflang', referrer: current.url }, current.url);
        }
        if (queue.length || visited.size >= pageLimit) truncatedReasons.add('page_limit');
        const findings = pages.filter((page) => page.status === 0 || page.status >= 400).map((page) => createFinding({
            ruleId: 'crawler.page.unreachable', category: 'crawler', severity: 'high', confidence: 0.98, kind: 'measured',
            pageUrl: page.url, source: 'WPA Crawler', sourceVersion: VERSION,
            title: 'Discovered page is unreachable', description: `The crawler received status ${page.status || 'network failure'}.`,
            moduleId: 'full_site_crawl', engineId: 'crawler', device: 'crawler',
            evidenceKey: page.sources.map((source) => `${source.type}:${source.referrer || ''}`).join('|'),
            evidence: [{ type: 'http', status: page.status, errorCode: page.errorCode || null, sources: page.sources }],
            remediation: 'Repair the route or remove internal, rendered, canonical, hreflang, manual, or sitemap references to it.'
        }));
        const coverage = {
            limit: pageLimit,
            attemptedPages: pages.length,
            reachablePages: pages.filter((page) => page.status > 0 && page.status < 400).length,
            brokenPages: findings.length,
            queuedRemaining: queue.length,
            discoveredUrls: entries.size,
            internalLinksDiscovered: sourceStats.internal_link.uniqueUrls,
            renderedLinksDiscovered: sourceStats.rendered_link.uniqueUrls,
            manualUrlsAccepted: sourceStats.manual.uniqueUrls,
            provenanceMerges,
            sources: sourceStats,
            skipped,
            skippedByRobots: skippedByRobots.length,
            robots: { perOrigin: robotsCoverage, root: robotsCoverage.find((entry) => entry.origin === rootOrigin) || null },
            sitemaps: sitemapDiscovery.documents,
            sitemapBudget: sitemapDiscovery,
            authorizedOrigins: [...scope],
            truncated: truncatedReasons.size > 0,
            truncatedReasons: [...truncatedReasons]
        };
        const robotsByOrigin = Object.fromEntries([...robotsCache].map(([targetOrigin, rules]) => [targetOrigin, rules]));
        return { version: VERSION, status: 'completed', origin: rootOrigin, urls: pages.filter((page) => page.status > 0 && page.status < 400).map((page) => page.url), pages, findings, robots, robotsByOrigin, skippedByRobots, coverage };
    } finally { await proxy.stop(); }
}

module.exports = {
    VERSION,
    DEFAULT_DISCOVERY_LIMITS,
    DISCOVERY_SOURCES,
    candidateTrapReason,
    decodeSitemapPayload,
    discoverSitemaps,
    discoverSite,
    discoverSiteV1,
    extractPageSignals,
    extractSitemapUrls,
    getThroughProxy,
    isRobotsAllowed,
    parseRobots,
    parseSitemapDocument,
    renderedLinkEntries,
    resolveDiscoveryLimits
};
