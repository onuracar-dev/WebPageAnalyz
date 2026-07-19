const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { validatePublicHost, validatePublicUrl } = require('./url-safety');

const hopByHopHeaders = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

function filteredHeaders(headers) {
    return Object.fromEntries(
        Object.entries(headers).filter(([name]) => !hopByHopHeaders.has(name.toLowerCase()))
    );
}

class SafeBrowserProxy {
    constructor({
        allowedPorts = [80, 443],
        lookup,
        logger,
        connectTimeoutMs = 10_000,
        maxConnections = 100,
        maxResponseBytes = 25 * 1024 * 1024,
        maxTotalBytes = 250 * 1024 * 1024
    } = {}) {
        this.allowedPorts = allowedPorts;
        this.lookup = lookup;
        this.logger = logger;
        this.connectTimeoutMs = connectTimeoutMs;
        this.maxConnections = maxConnections;
        this.maxResponseBytes = maxResponseBytes;
        this.maxTotalBytes = maxTotalBytes;
        this.totalBytes = 0;
        this.activeConnections = 0;
        this.reservedSockets = new Set();
        this.sockets = new Set();
        this.server = http.createServer(this.handleHttp.bind(this));
        this.server.on('connect', this.handleConnect.bind(this));
        this.server.on('clientError', (_error, socket) => socket.destroy());
        this.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));
        });
    }

    async start() {
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.server.off('error', reject);
                resolve();
            });
        });
        const address = this.server.address();
        this.url = `http://127.0.0.1:${address.port}`;
        return this.url;
    }

    async stop() {
        for (const socket of this.sockets) socket.destroy();
        if (!this.server.listening) return;
        await new Promise((resolve) => this.server.close(resolve));
    }

    reserveConnection(socket) {
        if (this.reservedSockets.has(socket)) return true;
        if (this.activeConnections >= this.maxConnections || this.totalBytes >= this.maxTotalBytes) {
            socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
            return false;
        }
        this.activeConnections += 1;
        this.reservedSockets.add(socket);
        socket.once('close', () => {
            this.reservedSockets.delete(socket);
            this.activeConnections = Math.max(0, this.activeConnections - 1);
        });
        return true;
    }

    async handleConnect(request, clientSocket, head) {
        if (!this.reserveConnection(clientSocket)) return;

        try {
            const authority = new URL(`http://${request.url}`);
            if (authority.username || authority.password || authority.pathname !== '/') throw new Error('Invalid authority');
            const hostname = authority.hostname.replace(/^\[|\]$/g, '');
            const port = authority.port ? Number(authority.port) : 443;
            const target = await validatePublicHost(hostname, port, {
                allowedPorts: this.allowedPorts,
                lookup: this.lookup
            });

            const upstream = net.connect({ host: target.address, port, family: target.family });
            this.sockets.add(upstream);
            upstream.once('close', () => this.sockets.delete(upstream));
            upstream.setTimeout(this.connectTimeoutMs, () => upstream.destroy(new Error('Proxy connection timed out')));
            upstream.once('connect', () => {
                upstream.setTimeout(0);
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head?.length) upstream.write(head);
                clientSocket.pipe(upstream);
                upstream.pipe(clientSocket);
            });

            let connectionBytes = 0;
            upstream.on('data', (chunk) => {
                connectionBytes += chunk.length;
                this.totalBytes += chunk.length;
                if (connectionBytes > this.maxResponseBytes || this.totalBytes > this.maxTotalBytes) {
                    upstream.destroy(new Error('Proxy response limit exceeded'));
                    clientSocket.destroy();
                }
            });
            upstream.once('error', () => clientSocket.destroy());
            clientSocket.once('error', () => upstream.destroy());
        } catch (error) {
            this.logger?.warn('Blocked browser proxy CONNECT request', { code: error.code || 'INVALID_PROXY_TARGET' });
            clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        }
    }

    async handleHttp(clientRequest, clientResponse) {
        if (!this.reserveConnection(clientResponse.socket)) return;

        try {
            const target = await validatePublicUrl(clientRequest.url, {
                allowedPorts: this.allowedPorts,
                lookup: this.lookup
            });
            const parsed = new URL(target.url);
            const transport = parsed.protocol === 'https:' ? https : http;
            const headers = filteredHeaders(clientRequest.headers);
            headers.host = parsed.host;

            const upstreamRequest = transport.request({
                protocol: parsed.protocol,
                hostname: target.address,
                family: target.family,
                port: target.port,
                method: clientRequest.method,
                path: `${parsed.pathname}${parsed.search}`,
                headers,
                servername: target.hostname,
                rejectUnauthorized: true
            }, (upstreamResponse) => {
                clientResponse.writeHead(upstreamResponse.statusCode || 502, filteredHeaders(upstreamResponse.headers));
                let responseBytes = 0;
                upstreamResponse.on('data', (chunk) => {
                    responseBytes += chunk.length;
                    this.totalBytes += chunk.length;
                    if (responseBytes > this.maxResponseBytes || this.totalBytes > this.maxTotalBytes) {
                        upstreamRequest.destroy(new Error('Proxy response limit exceeded'));
                        clientResponse.destroy();
                    }
                });
                upstreamResponse.pipe(clientResponse);
            });

            upstreamRequest.setTimeout(this.connectTimeoutMs, () => upstreamRequest.destroy(new Error('Proxy request timed out')));
            upstreamRequest.once('error', () => {
                if (!clientResponse.headersSent) clientResponse.writeHead(502);
                clientResponse.end();
            });
            clientRequest.once('aborted', () => upstreamRequest.destroy());
            clientRequest.pipe(upstreamRequest);
        } catch (error) {
            this.logger?.warn('Blocked browser proxy HTTP request', { code: error.code || 'INVALID_PROXY_TARGET' });
            if (!clientResponse.headersSent) clientResponse.writeHead(403);
            clientResponse.end();
        }
    }
}

module.exports = { SafeBrowserProxy };
