import { describe, expect, it } from 'vitest';
import { messageFor, normalizeInputUrl } from './api';

describe('messageFor', () => {
  it('has a human message for every backend error code', () => {
    const codes = ['CONSENT_REQUIRED', 'URL_NOT_ALLOWED', 'RATE_LIMIT_EXCEEDED', 'QUEUE_FULL', 'HOST_COOLDOWN', 'DAILY_LIMIT_REACHED', 'SCAN_NOT_FOUND', 'NETWORK_ERROR'];
    for (const code of codes) expect(messageFor(code)).not.toBe(messageFor('SOMETHING_ELSE'));
  });
});

describe('normalizeInputUrl', () => {
  it('adds https:// to bare hosts and keeps explicit schemes', () => {
    expect(normalizeInputUrl(' example.com ')).toBe('https://example.com');
    expect(normalizeInputUrl('http://example.com')).toBe('http://example.com');
    expect(normalizeInputUrl('ftp://example.com')).toBe('ftp://example.com');
    expect(normalizeInputUrl('')).toBe('');
  });
});
