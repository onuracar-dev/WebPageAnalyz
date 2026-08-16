const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
    DISCOVERY_SOURCES,
    candidateTrapReason,
    decodeSitemapPayload,
    discoverSitemaps,
    extractPageSignals,
    extractSitemapUrls,
    parseRobots,
    parseSitemapDocument,
    isRobotsAllowed,
    renderedLinkEntries,
    resolveDiscoveryLimits
} = require('../analyzers/crawler');

test('crawler fixtures discover normalized links, sitemap locations and robots boundaries', () => {
    const html = `<link href="https://example.com/docs" rel="canonical"><link href="/tr" rel="alternate" hreflang="tr"><meta content="index,follow" name="robots"><a href="/docs/?utm_source=x#top">Docs</a><a href="https://other.test/">offsite</a>`;
    const signals = extractPageSignals(html, 'https://example.com/');
    assert.deepEqual(signals.links, ['https://example.com/docs', 'https://other.test/']);
    assert.equal(signals.canonical, 'https://example.com/docs');
    assert.deepEqual(signals.hreflangs, ['tr']);
    assert.deepEqual(signals.hreflangLinks, [{ language: 'tr', url: 'https://example.com/tr' }]);
    assert.equal(signals.robotsMeta, 'index,follow');
    assert.deepEqual(extractSitemapUrls('<urlset><url><loc>https://example.com/a&amp;b</loc></url></urlset>'), ['https://example.com/a&b']);
    assert.deepEqual(parseSitemapDocument('<sitemapindex><sitemap><loc>/nested.xml</loc></sitemap></sitemapindex>'), { type: 'index', locations: ['/nested.xml'] });
    const robots = parseRobots('User-agent: *\nDisallow: /private/*\nAllow: /private/public$\nSitemap: https://example.com/sitemap.xml');
    assert.deepEqual(robots, { disallow: ['/private/*'], allow: ['/private/public$'], sitemaps: ['https://example.com/sitemap.xml'] });
    assert.equal(isRobotsAllowed('/private/secret', robots), false);
    assert.equal(isRobotsAllowed('/private/public', robots), true);
});

test('sitemap indexes recurse within scope, preserve sitemap provenance, and terminate cycles', async () => {
    const documents = new Map([
        ['https://example.com/sitemap.xml', '<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap><sitemap><loc>https://example.com/sitemap.xml</loc></sitemap><sitemap><loc>https://off-scope.test/private.xml</loc></sitemap></sitemapindex>'],
        ['https://example.com/pages.xml', '<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>']
    ]);
    const limits = resolveDiscoveryLimits(25, { maxSitemaps: 5, maxSitemapDepth: 3, maxDiscoveryMs: 5_000 });
    const result = await discoverSitemaps(['https://example.com/sitemap.xml'], {
        allowedOrigins: new Set(['https://example.com']),
        limits,
        fetchSitemap: async (url) => {
            const body = documents.get(url);
            assert.ok(body, `unexpected sitemap fetch: ${url}`);
            return { url, status: 200, headers: {}, body, bodyBuffer: Buffer.from(body) };
        }
    });
    assert.deepEqual(result.pageSeeds, [
        { url: 'https://example.com/a', source: { type: 'sitemap', referrer: 'https://example.com/pages.xml' } },
        { url: 'https://example.com/b', source: { type: 'sitemap', referrer: 'https://example.com/pages.xml' } }
    ]);
    assert.equal(result.counters.indexes, 1);
    assert.equal(result.counters.urlsets, 1);
    assert.equal(result.counters.cycles, 1);
    assert.equal(result.counters.offScope, 1);
    assert.ok(result.documents.some((entry) => entry.errorCode === 'CRAWLER_SITEMAP_CYCLE'));
    assert.ok(result.blockedLocations.some((entry) => entry.errorCode === 'CRAWLER_ORIGIN_MISMATCH' && entry.kind === 'sitemap'));
});

test('sitemap traversal enforces global URL and depth limits', async () => {
    const documents = new Map([
        ['https://example.com/root.xml', '<sitemapindex><sitemap><loc>/nested.xml</loc></sitemap></sitemapindex>'],
        ['https://example.com/nested.xml', '<sitemapindex><sitemap><loc>/too-deep.xml</loc></sitemap></sitemapindex>']
    ]);
    const depthResult = await discoverSitemaps(['https://example.com/root.xml'], {
        allowedOrigins: new Set(['https://example.com']),
        limits: resolveDiscoveryLimits(25, { maxSitemapDepth: 1, maxDiscoveryMs: 5_000 }),
        fetchSitemap: async (url) => {
            const body = documents.get(url);
            return { url, status: 200, headers: {}, body, bodyBuffer: Buffer.from(body) };
        }
    });
    assert.deepEqual(depthResult.pageSeeds, []);
    assert.ok(depthResult.truncatedReasons.includes('sitemap_depth'));

    const xml = '<urlset><url><loc>https://example.com/1</loc></url><url><loc>https://example.com/2</loc></url></urlset>';
    const urlResult = await discoverSitemaps(['https://example.com/urls.xml'], {
        allowedOrigins: new Set(['https://example.com']),
        limits: resolveDiscoveryLimits(25, { maxSitemapUrls: 1, maxDiscoveryMs: 5_000 }),
        fetchSitemap: async (url) => ({ url, status: 200, headers: {}, body: xml, bodyBuffer: Buffer.from(xml) })
    });
    assert.equal(urlResult.pageSeeds.length, 1);
    assert.ok(urlResult.truncatedReasons.includes('sitemap_urls'));
});

test('gzip sitemap decoding is bounded before XML parsing', () => {
    const xml = '<urlset><url><loc>https://example.com/a</loc></url></urlset>';
    const compressed = zlib.gzipSync(Buffer.from(xml));
    const decoded = decodeSitemapPayload({ url: 'https://example.com/sitemap.xml.gz', headers: {}, bodyBuffer: compressed }, {
        maxResponseBytes: 1_000,
        maxXmlBytes: 1_000,
        maxDecompressedBytes: 1_000
    });
    assert.equal(decoded.xml, xml);
    assert.equal(decoded.gzip, true);

    const bomb = zlib.gzipSync(Buffer.alloc(100_000, 65));
    assert.throws(() => decodeSitemapPayload({ url: 'https://example.com/bomb.xml.gz', headers: {}, bodyBuffer: bomb }, {
        maxResponseBytes: 1_000,
        maxXmlBytes: 1_000,
        maxDecompressedBytes: 512
    }), { code: 'CRAWLER_SITEMAP_DECOMPRESSED_TOO_LARGE' });
    assert.throws(() => decodeSitemapPayload({ url: 'https://example.com/large.xml', headers: {}, bodyBuffer: Buffer.from(xml) }, {
        maxResponseBytes: 1_000,
        maxXmlBytes: 10,
        maxDecompressedBytes: 1_000
    }), { code: 'CRAWLER_SITEMAP_XML_TOO_LARGE' });
    assert.throws(() => decodeSitemapPayload({ url: 'https://example.com/bad.xml.gz', headers: {}, bodyBuffer: Buffer.from('not-gzip') }, {
        maxResponseBytes: 1_000,
        maxXmlBytes: 1_000,
        maxDecompressedBytes: 1_000
    }), { code: 'CRAWLER_SITEMAP_GZIP_INVALID' });
});

test('trap controls reject session, deep, runaway pagination, and distant calendar URLs', () => {
    const limits = resolveDiscoveryLimits(25, { maxPathDepth: 3, maxPaginationValue: 20, maxCalendarYearDrift: 2 });
    assert.equal(candidateTrapReason('https://example.com/a/b/c/d', limits, 2026), 'path_depth');
    assert.equal(candidateTrapReason('https://example.com/items?sessionId=abcdefghijk', limits, 2026), 'session_identifier');
    assert.equal(candidateTrapReason('https://example.com/items?page=999', limits, 2026), 'pagination');
    assert.equal(candidateTrapReason('https://example.com/calendar/2099/01', limits, 2026), 'calendar');
    assert.equal(candidateTrapReason('https://example.com/articles/2025/release', limits, 2026), null);
});

test('rendered link adapter consumes worker evidence without inventing paths or subdomains', () => {
    assert.deepEqual(renderedLinkEntries(
        ['https://example.com/rendered', { url: '/dialog', referrer: 'https://example.com/' }],
        { 'https://example.com/account': ['/settings'] }
    ), [
        { url: 'https://example.com/rendered', referrer: null },
        { url: '/dialog', referrer: 'https://example.com/' },
        { url: '/settings', referrer: 'https://example.com/account' }
    ]);
    assert.deepEqual(DISCOVERY_SOURCES, ['root', 'internal_link', 'rendered_link', 'sitemap', 'manual', 'canonical', 'hreflang']);
    assert.equal(DISCOVERY_SOURCES.includes('random_path'), false);
    assert.equal(DISCOVERY_SOURCES.includes('subdomain_enumeration'), false);
});
