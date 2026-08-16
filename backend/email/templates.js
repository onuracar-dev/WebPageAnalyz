const { AppError } = require('../lib/errors');

const SUPPORTED_EMAIL_KINDS = new Set(['verification', 'reset', 'support', 'security', 'subscription']);

function bounded(value, maxLength, fallback = '') {
    return String(value ?? fallback).replace(/\0/g, '').trim().slice(0, maxLength);
}

function escapeHtml(value) {
    return bounded(value, 2_000)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function recipientAddress(value) {
    const address = bounded(value, 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new AppError('Transactional email recipient is invalid.', { status: 400, code: 'EMAIL_RECIPIENT_INVALID', expose: true });
    return address;
}

function callbackUrl(value) {
    let parsed;
    try { parsed = new URL(bounded(value, 2_048)); } catch (cause) { throw new AppError('Transactional email callback URL is invalid.', { status: 400, code: 'EMAIL_CALLBACK_INVALID', expose: true, cause }); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new AppError('Transactional email callback URL is invalid.', { status: 400, code: 'EMAIL_CALLBACK_INVALID', expose: true });
    return parsed.toString();
}

function normalizeEmailRequest({ kind, to, url, data = {}, idempotencyKey } = {}) {
    if (!SUPPORTED_EMAIL_KINDS.has(kind)) throw new AppError('Transactional email kind is unsupported.', { status: 400, code: 'EMAIL_KIND_INVALID', expose: true });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('Transactional email data is invalid.', { status: 400, code: 'EMAIL_INPUT_INVALID', expose: true });
    const normalizedData = {};
    if (kind === 'support') normalizedData.ticketId = bounded(data.ticketId, 120, 'destek talebi');
    if (kind === 'security') normalizedData.event = bounded(data.event, 200, 'Hesap güvenliği bildirimi');
    if (kind === 'subscription') {
        normalizedData.status = bounded(data.status, 120, 'güncellendi');
        normalizedData.plan = bounded(data.plan, 120);
    }
    if (idempotencyKey !== undefined && idempotencyKey !== null && !/^[A-Za-z0-9._:-]{1,256}$/.test(idempotencyKey)) throw new AppError('Transactional email idempotency key is invalid.', { status: 400, code: 'EMAIL_IDEMPOTENCY_KEY_INVALID', expose: true });
    const normalizedKey = idempotencyKey || null;
    return Object.freeze({
        kind,
        to: recipientAddress(to),
        url: kind === 'verification' || kind === 'reset' ? callbackUrl(url) : null,
        data: Object.freeze(normalizedData),
        idempotencyKey: normalizedKey
    });
}

function templateFor(kind, { url, data = {}, appUrl = '', supportEmail = '' } = {}) {
    if (!SUPPORTED_EMAIL_KINDS.has(kind)) throw new AppError('Transactional email kind is unsupported.', { status: 400, code: 'EMAIL_KIND_INVALID', expose: true });
    const safeAppUrl = appUrl ? callbackUrl(appUrl) : '';
    const safeSupport = supportEmail ? recipientAddress(supportEmail) : '';
    if (kind === 'verification' || kind === 'reset') {
        const actionUrl = callbackUrl(url);
        const verification = kind === 'verification';
        const title = verification ? 'E-posta adresinizi doğrulayın' : 'Parolanızı sıfırlayın';
        const action = verification ? 'E-posta adresinizi doğrulamak' : 'Parolanızı sıfırlamak';
        return Object.freeze({
            subject: `WebPageAnalyz — ${title}`,
            text: `${action} için bu güvenli bağlantıyı kullanın: ${actionUrl}\n\nBu isteği siz başlatmadıysanız e-postayı yok sayın.`,
            html: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(action)} için aşağıdaki bağlantıyı kullanın.</p><p><a href="${escapeHtml(actionUrl)}">${escapeHtml(title)}</a></p><p>Bu isteği siz başlatmadıysanız e-postayı yok sayın.</p>`
        });
    }
    if (kind === 'support') {
        const ticketId = bounded(data.ticketId, 120, 'destek talebi');
        const destination = safeAppUrl ? `${safeAppUrl.replace(/\/$/, '')}/support` : '';
        return Object.freeze({
            subject: 'WebPageAnalyz — Destek talebi güncellendi',
            text: `Destek talebiniz güncellendi (${ticketId}).${destination ? ` Ayrıntılar: ${destination}` : ''}${safeSupport ? ` Destek: ${safeSupport}` : ''}`,
            html: `<h1>Destek talebi güncellendi</h1><p>Talep: ${escapeHtml(ticketId)}</p>${destination ? `<p><a href="${escapeHtml(destination)}">Ayrıntıları görüntüleyin</a></p>` : ''}${safeSupport ? `<p>Destek: ${escapeHtml(safeSupport)}</p>` : ''}`
        });
    }
    if (kind === 'security') {
        const event = bounded(data.event, 200, 'Hesap güvenliği bildirimi');
        return Object.freeze({
            subject: 'WebPageAnalyz — Güvenlik bildirimi',
            text: `${event}. Bu işlemi siz yapmadıysanız hesabınızı kontrol edin.${safeAppUrl ? ` ${safeAppUrl}` : ''}`,
            html: `<h1>Güvenlik bildirimi</h1><p>${escapeHtml(event)}</p><p>Bu işlemi siz yapmadıysanız hesabınızı kontrol edin.</p>${safeAppUrl ? `<p><a href="${escapeHtml(safeAppUrl)}">WebPageAnalyz hesabını açın</a></p>` : ''}`
        });
    }
    const status = bounded(data.status, 120, 'güncellendi');
    const plan = bounded(data.plan, 120);
    return Object.freeze({
        subject: 'WebPageAnalyz — Abonelik bildirimi',
        text: `Abonelik durumunuz ${status}.${plan ? ` Plan: ${plan}.` : ''}${safeAppUrl ? ` ${safeAppUrl}` : ''}`,
        html: `<h1>Abonelik bildirimi</h1><p>Abonelik durumunuz ${escapeHtml(status)}.</p>${plan ? `<p>Plan: ${escapeHtml(plan)}</p>` : ''}${safeAppUrl ? `<p><a href="${escapeHtml(safeAppUrl)}">Hesabınızı görüntüleyin</a></p>` : ''}`
    });
}

module.exports = { SUPPORTED_EMAIL_KINDS, bounded, callbackUrl, normalizeEmailRequest, recipientAddress, templateFor };
