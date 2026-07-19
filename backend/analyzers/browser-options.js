const chromeLauncher = require('chrome-launcher');

function chromeExecutable(config = {}) {
    return config.chromePath || chromeLauncher.Launcher.getInstallations()[0];
}

function chromeFlags(proxyUrl, config = {}) {
    const flags = [
        '--headless=new',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-quic',
        '--disable-sync',
        '--dns-prefetch-disable',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-first-run',
        `--proxy-server=${proxyUrl}`,
        '--proxy-bypass-list=<-loopback>'
    ];
    if (config.chromeNoSandbox) flags.push('--no-sandbox', '--disable-setuid-sandbox');
    return flags;
}

module.exports = { chromeExecutable, chromeFlags };
