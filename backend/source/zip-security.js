const yauzl = require('yauzl');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { AppError } = require('../lib/errors');

function safeEntryName(name) {
    const normalized = name.replaceAll('\\', '/');
    if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return false;
    return !normalized.split('/').some((part) => part === '..');
}

function inspectZip(buffer, { maxEntries = 20_000, maxUncompressedBytes = 500 * 1024 * 1024, maxCompressionRatio = 200 } = {}) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
            if (openError) { reject(new AppError('The uploaded ZIP is invalid.', { status: 400, code: 'INVALID_ZIP', cause: openError })); return; }
            let entries = 0;
            let uncompressedBytes = 0;
            const files = [];
            const fail = (message, code) => { zip.close(); reject(new AppError(message, { status: 400, code })); };
            zip.on('entry', (entry) => {
                entries += 1;
                uncompressedBytes += entry.uncompressedSize;
                const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
                if (!safeEntryName(entry.fileName)) return fail('The ZIP contains an unsafe path.', 'ZIP_SLIP_DETECTED');
                if (unixType === 0o120000) return fail('Symbolic links are not accepted in source ZIPs.', 'ZIP_SYMLINK_DETECTED');
                if (entries > maxEntries || uncompressedBytes > maxUncompressedBytes) return fail('The ZIP expands beyond the allowed size.', 'ZIP_BOMB_DETECTED');
                if (entry.uncompressedSize > 1_000_000 && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > maxCompressionRatio) return fail('The ZIP compression ratio is unsafe.', 'ZIP_BOMB_DETECTED');
                files.push({ name: entry.fileName, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize });
                zip.readEntry();
            });
            zip.once('error', (error) => reject(new AppError('The uploaded ZIP could not be inspected.', { status: 400, code: 'INVALID_ZIP', cause: error })));
            zip.once('end', () => resolve({ entries, uncompressedBytes, files }));
            zip.readEntry();
        });
    });
}

function inspectOpenedZip(openZip, { maxEntries = 20_000, maxUncompressedBytes = 500 * 1024 * 1024, maxCompressionRatio = 200 } = {}) {
    return new Promise((resolve, reject) => {
        openZip((openError, zip) => {
            if (openError) { reject(new AppError('The uploaded ZIP is invalid.', { status: 400, code: 'INVALID_ZIP', cause: openError })); return; }
            let entries = 0;
            let uncompressedBytes = 0;
            const files = [];
            const fail = (message, code) => { zip.close(); reject(new AppError(message, { status: 400, code })); };
            zip.on('entry', (entry) => {
                entries += 1;
                uncompressedBytes += entry.uncompressedSize;
                const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
                if (!safeEntryName(entry.fileName)) return fail('The ZIP contains an unsafe path.', 'ZIP_SLIP_DETECTED');
                if (unixType === 0o120000) return fail('Symbolic links are not accepted in source ZIPs.', 'ZIP_SYMLINK_DETECTED');
                if (entries > maxEntries || uncompressedBytes > maxUncompressedBytes) return fail('The ZIP expands beyond the allowed size.', 'ZIP_BOMB_DETECTED');
                if (entry.uncompressedSize > 1_000_000 && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > maxCompressionRatio) return fail('The ZIP compression ratio is unsafe.', 'ZIP_BOMB_DETECTED');
                files.push({ name: entry.fileName, compressedSize: entry.compressedSize, uncompressedSize: entry.uncompressedSize });
                zip.readEntry();
            });
            zip.once('error', (error) => reject(new AppError('The uploaded ZIP could not be inspected.', { status: 400, code: 'INVALID_ZIP', cause: error })));
            zip.once('end', () => resolve({ entries, uncompressedBytes, files }));
            zip.readEntry();
        });
    });
}

function inspectZipFile(filename, limits) {
    return inspectOpenedZip((callback) => yauzl.open(filename, { lazyEntries: true, validateEntrySizes: true }, callback), limits);
}

function extractZip(buffer, destination, limits = {}) {
    const maxEntries = limits.maxEntries || 20_000;
    const maxUncompressedBytes = limits.maxUncompressedBytes || 500 * 1024 * 1024;
    const maxFileBytes = limits.maxFileBytes || 100 * 1024 * 1024;
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
            if (openError) return reject(new AppError('The uploaded ZIP is invalid.', { status: 400, code: 'INVALID_ZIP', cause: openError }));
            let entries = 0; let total = 0; const names = new Set(); const files = [];
            const fail = (error) => { zip.close(); reject(error instanceof AppError ? error : new AppError('The ZIP could not be extracted safely.', { status: 400, code: 'INVALID_ZIP', cause: error })); };
            zip.once('error', fail);
            zip.once('end', () => resolve({ entries, uncompressedBytes: total, files }));
            zip.on('entry', async (entry) => {
                try {
                    entries += 1;
                    const normalized = entry.fileName.replaceAll('\\', '/');
                    const folded = normalized.toLocaleLowerCase('en-US');
                    const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
                    if (!safeEntryName(normalized)) throw new AppError('The ZIP contains an unsafe path.', { status: 400, code: 'ZIP_SLIP_DETECTED' });
                    if (names.has(folded)) throw new AppError('The ZIP contains duplicate or case-colliding paths.', { status: 400, code: 'ZIP_PATH_COLLISION' });
                    names.add(folded);
                    if (unixType && ![0o040000, 0o100000].includes(unixType)) throw new AppError('The ZIP contains a non-regular filesystem entry.', { status: 400, code: 'ZIP_SPECIAL_FILE_DETECTED' });
                    if (entries > maxEntries || entry.uncompressedSize > maxFileBytes || total + entry.uncompressedSize > maxUncompressedBytes) throw new AppError('The ZIP expands beyond the allowed size.', { status: 400, code: 'ZIP_BOMB_DETECTED' });
                    const absolute = path.resolve(destination, normalized);
                    if (absolute !== destination && !absolute.startsWith(`${destination}${path.sep}`)) throw new AppError('The ZIP contains an unsafe path.', { status: 400, code: 'ZIP_SLIP_DETECTED' });
                    if (/\/$/.test(normalized)) { await fsp.mkdir(absolute, { recursive: true, mode: 0o700 }); zip.readEntry(); return; }
                    await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
                    zip.openReadStream(entry, async (streamError, stream) => {
                        if (streamError) return fail(streamError);
                        let written = 0;
                        const output = fs.createWriteStream(absolute, { flags: 'wx', mode: 0o600 });
                        stream.on('data', (chunk) => { written += chunk.length; total += chunk.length; if (written > maxFileBytes || total > maxUncompressedBytes) { stream.destroy(new AppError('The ZIP expands beyond the allowed size.', { status: 400, code: 'ZIP_BOMB_DETECTED' })); } });
                        stream.once('error', fail); output.once('error', fail);
                        output.once('finish', () => { files.push(normalized); zip.readEntry(); });
                        stream.pipe(output);
                    });
                } catch (error) { fail(error); }
            });
            zip.readEntry();
        });
    });
}

function extractOpenedZip(openZip, destination, limits = {}) {
    const maxEntries = limits.maxEntries || 20_000;
    const maxUncompressedBytes = limits.maxUncompressedBytes || 500 * 1024 * 1024;
    const maxFileBytes = limits.maxFileBytes || 100 * 1024 * 1024;
    return new Promise((resolve, reject) => {
        openZip((openError, zip) => {
            if (openError) return reject(new AppError('The uploaded ZIP is invalid.', { status: 400, code: 'INVALID_ZIP', cause: openError }));
            let entries = 0; let total = 0; const names = new Set(); const files = [];
            const fail = (error) => { zip.close(); reject(error instanceof AppError ? error : new AppError('The ZIP could not be extracted safely.', { status: 400, code: 'INVALID_ZIP', cause: error })); };
            zip.once('error', fail);
            zip.once('end', () => resolve({ entries, uncompressedBytes: total, files }));
            zip.on('entry', async (entry) => {
                try {
                    entries += 1;
                    const normalized = entry.fileName.replaceAll('\\', '/');
                    const folded = normalized.toLocaleLowerCase('en-US');
                    const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
                    if (!safeEntryName(normalized)) throw new AppError('The ZIP contains an unsafe path.', { status: 400, code: 'ZIP_SLIP_DETECTED' });
                    if (names.has(folded)) throw new AppError('The ZIP contains duplicate or case-colliding paths.', { status: 400, code: 'ZIP_PATH_COLLISION' });
                    names.add(folded);
                    if (unixType && ![0o040000, 0o100000].includes(unixType)) throw new AppError('The ZIP contains a non-regular filesystem entry.', { status: 400, code: 'ZIP_SPECIAL_FILE_DETECTED' });
                    if (entries > maxEntries || entry.uncompressedSize > maxFileBytes || total + entry.uncompressedSize > maxUncompressedBytes) throw new AppError('The ZIP expands beyond the allowed size.', { status: 400, code: 'ZIP_BOMB_DETECTED' });
                    const absolute = path.resolve(destination, normalized);
                    if (absolute !== destination && !absolute.startsWith(`${destination}${path.sep}`)) throw new AppError('The ZIP contains an unsafe path.', { status: 400, code: 'ZIP_SLIP_DETECTED' });
                    if (/\/$/.test(normalized)) { await fsp.mkdir(absolute, { recursive: true, mode: 0o700 }); zip.readEntry(); return; }
                    await fsp.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
                    zip.openReadStream(entry, async (streamError, stream) => {
                        if (streamError) return fail(streamError);
                        let written = 0;
                        const output = fs.createWriteStream(absolute, { flags: 'wx', mode: 0o600 });
                        stream.on('data', (chunk) => { written += chunk.length; total += chunk.length; if (written > maxFileBytes || total > maxUncompressedBytes) stream.destroy(new AppError('The ZIP expands beyond the allowed size.', { status: 400, code: 'ZIP_BOMB_DETECTED' })); });
                        stream.once('error', fail); output.once('error', fail);
                        output.once('finish', () => { files.push(normalized); zip.readEntry(); });
                        stream.pipe(output);
                    });
                } catch (error) { fail(error); }
            });
            zip.readEntry();
        });
    });
}

function extractZipFile(filename, destination, limits) {
    return extractOpenedZip((callback) => yauzl.open(filename, { lazyEntries: true, validateEntrySizes: true }, callback), destination, limits);
}

module.exports = { inspectZip, inspectZipFile, extractZip, extractZipFile, safeEntryName };
