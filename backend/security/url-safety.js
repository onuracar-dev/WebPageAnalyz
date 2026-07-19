const dns = require('node:dns').promises;
const net = require('node:net');
const { AppError } = require('../lib/errors');

const blockedNames = new Set(['localhost', 'localhost.localdomain', 'broadcasthost']);
const blockedSuffixes = ['.localhost', '.local', '.internal', '.home.arpa', '.test', '.invalid', '.example'];

const blockedIpv4 = new net.BlockList();
[
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
].forEach(([network, prefix]) => blockedIpv4.addSubnet(network, prefix, 'ipv4'));

const blockedIpv6 = new net.BlockList();
[
    ['::', 128],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8]
].forEach(([network, prefix]) => blockedIpv6.addSubnet(network, prefix, 'ipv6'));

function cleanHostname(hostname) {
    return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isPublicAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return !blockedIpv4.check(address, 'ipv4');
    if (family !== 6 || blockedIpv6.check(address, 'ipv6')) return false;

    // Globally routable IPv6 currently lives in 2000::/3. Rejecting other ranges is
    // intentionally conservative for a service that visits untrusted URLs.
    const firstHextet = Number.parseInt(address.split(':')[0] || '0', 16);
    return firstHextet >= 0x2000 && firstHextet <= 0x3fff;
}

function validateHostnameSyntax(hostname) {
    if (!hostname || hostname.length > 253 || hostname.includes('%')) {
        throw new AppError('The target hostname is invalid.', { status: 400, code: 'INVALID_TARGET_HOST' });
    }

    if (blockedNames.has(hostname) || blockedSuffixes.some((suffix) => hostname.endsWith(suffix))) {
        throw new AppError('Private or reserved network targets are not allowed.', {
            status: 400,
            code: 'PRIVATE_TARGET_BLOCKED'
        });
    }

    if (!net.isIP(hostname) && !hostname.includes('.')) {
        throw new AppError('Single-label hostnames are not allowed.', {
            status: 400,
            code: 'PRIVATE_TARGET_BLOCKED'
        });
    }
}

async function resolvePublicHost(hostname, { lookup = dns.lookup, dnsTimeoutMs = 5_000 } = {}) {
    const normalized = cleanHostname(hostname);
    validateHostnameSyntax(normalized);

    if (net.isIP(normalized)) {
        if (!isPublicAddress(normalized)) {
            throw new AppError('Private or reserved network targets are not allowed.', {
                status: 400,
                code: 'PRIVATE_TARGET_BLOCKED'
            });
        }
        return [{ address: normalized, family: net.isIP(normalized) }];
    }

    let records;
    let timeout;
    try {
        records = await Promise.race([
            lookup(normalized, { all: true, verbatim: true }),
            new Promise((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error('DNS lookup timed out')), dnsTimeoutMs);
            })
        ]);
    } catch (error) {
        throw new AppError('The target hostname could not be resolved.', {
            status: 400,
            code: 'TARGET_DNS_FAILED',
            cause: error
        });
    } finally {
        clearTimeout(timeout);
    }

    const normalizedRecords = (Array.isArray(records) ? records : [records])
        .filter((record) => record && net.isIP(record.address))
        .slice(0, 32);

    if (normalizedRecords.length === 0) {
        throw new AppError('The target hostname did not resolve to an IP address.', {
            status: 400,
            code: 'TARGET_DNS_FAILED'
        });
    }

    if (normalizedRecords.some((record) => !isPublicAddress(record.address))) {
        throw new AppError('Private or reserved network targets are not allowed.', {
            status: 400,
            code: 'PRIVATE_TARGET_BLOCKED'
        });
    }

    return normalizedRecords;
}

function parsePort(url) {
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
}

async function validatePublicUrl(input, options = {}) {
    if (typeof input !== 'string' || input.length === 0 || input.length > 2048) {
        throw new AppError('A valid target URL is required.', { status: 400, code: 'INVALID_TARGET_URL' });
    }

    let url;
    try {
        url = new URL(input);
    } catch (error) {
        throw new AppError('A valid absolute URL is required.', {
            status: 400,
            code: 'INVALID_TARGET_URL',
            cause: error
        });
    }

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new AppError('Only credential-free HTTP and HTTPS URLs are allowed.', {
            status: 400,
            code: 'INVALID_TARGET_URL'
        });
    }

    const port = parsePort(url);
    const allowedPorts = options.allowedPorts || [80, 443];
    if (!allowedPorts.includes(port)) {
        throw new AppError('The target URL uses a disallowed port.', {
            status: 400,
            code: 'TARGET_PORT_BLOCKED'
        });
    }

    const hostname = cleanHostname(url.hostname);
    const addresses = await resolvePublicHost(hostname, options);
    url.hash = '';

    return {
        url: url.toString(),
        hostname,
        port,
        addresses,
        address: addresses[0].address,
        family: addresses[0].family
    };
}

async function validatePublicHost(hostname, port, options = {}) {
    const normalized = cleanHostname(hostname);
    const allowedPorts = options.allowedPorts || [80, 443];
    if (!Number.isInteger(port) || !allowedPorts.includes(port)) {
        throw new AppError('The target uses a disallowed port.', { status: 400, code: 'TARGET_PORT_BLOCKED' });
    }
    const addresses = await resolvePublicHost(normalized, options);
    return { hostname: normalized, port, addresses, address: addresses[0].address, family: addresses[0].family };
}

module.exports = {
    isPublicAddress,
    resolvePublicHost,
    validatePublicHost,
    validatePublicUrl
};
