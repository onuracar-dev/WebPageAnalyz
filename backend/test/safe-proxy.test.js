const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { SafeBrowserProxy } = require('../security/safe-proxy');

test('safe proxy rejects HTTP requests to loopback without connecting to the target', async () => {
    const proxy = new SafeBrowserProxy({ logger: { warn() {} } });
    const proxyUrl = new URL(await proxy.start());
    try {
        const status = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: proxyUrl.hostname,
                port: proxyUrl.port,
                method: 'GET',
                path: 'http://127.0.0.1:80/private'
            }, (response) => {
                response.resume();
                response.on('end', () => resolve(response.statusCode));
            });
            req.once('error', reject);
            req.end();
        });
        assert.equal(status, 403);
    } finally {
        await proxy.stop();
    }
});

test('safe proxy rejects HTTPS CONNECT tunnels to private destinations', async () => {
    const proxy = new SafeBrowserProxy({ logger: { warn() {} } });
    const proxyUrl = new URL(await proxy.start());
    try {
        const response = await new Promise((resolve, reject) => {
            const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () => {
                socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n');
            });
            let data = '';
            socket.setEncoding('utf8');
            socket.on('data', (chunk) => { data += chunk; });
            socket.on('end', () => resolve(data));
            socket.once('error', reject);
        });
        assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
    } finally {
        await proxy.stop();
    }
});
