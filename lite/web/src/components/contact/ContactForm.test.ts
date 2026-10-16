import { describe, expect, it } from 'vitest';
import { MIN_MESSAGE, validateContact } from './ContactForm';
import { buildMailto, contactAddress, mailSubject } from './mailto';

describe('validateContact', () => {
  it('requires a name and a message of at least the minimum length', () => {
    expect(validateContact({ name: '', message: '' })).toEqual({ name: 'Enter your name', message: 'Tell me what’s on your mind' });
    expect(validateContact({ name: 'Ada', message: 'short' })).toEqual({ message: `Add a little more detail, at least ${MIN_MESSAGE} characters` });
  });

  it('accepts a complete message', () => {
    expect(validateContact({ name: 'Ada', message: 'x'.repeat(MIN_MESSAGE) })).toEqual({});
  });
});

describe('mailto', () => {
  const draft = { name: 'Ada Lovelace', topic: 'Bug report', message: 'Line one\nLine two & more?' };

  it('addresses the project inbox', () => {
    expect(contactAddress()).toBe('onuracar.work@gmail.com');
    expect(buildMailto(draft).startsWith('mailto:onuracar.work@gmail.com?subject=')).toBe(true);
  });

  it('encodes subject and body, with CRLF line breaks', () => {
    const url = new URL(buildMailto(draft));
    expect(url.searchParams.get('subject')).toBe('[WPA Lite] Bug report from Ada Lovelace');
    expect(url.searchParams.get('body')).toBe('Name: Ada Lovelace\r\nTopic: Bug report\r\n\r\nLine one\r\nLine two & more?');
    // No raw spaces or line breaks may survive in the link itself.
    expect(buildMailto(draft)).not.toMatch(/\s/);
  });

  it('keeps line breaks out of the subject', () => {
    expect(mailSubject({ ...draft, name: 'Ada\r\nBcc: someone@example.com' })).toBe('[WPA Lite] Bug report from Ada Bcc: someone@example.com');
  });
});
