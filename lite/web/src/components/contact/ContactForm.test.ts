import { describe, expect, it } from 'vitest';
import { MIN_MESSAGE, validateContact } from './ContactForm';

describe('validateContact', () => {
  it('requires a name, a valid email and a message of at least the minimum length', () => {
    expect(validateContact({ name: '', email: '', message: '' })).toEqual({
      name: 'Enter your name',
      email: 'Enter your email address',
      message: 'Tell me what’s on your mind',
    });
    expect(validateContact({ name: 'Ada', email: 'ada@', message: 'short' })).toMatchObject({
      email: 'Enter an email like name@example.com',
      message: `Add a little more detail, at least ${MIN_MESSAGE} characters`,
    });
  });

  it('accepts a complete message', () => {
    expect(validateContact({ name: 'Ada', email: 'ada@example.com', message: 'x'.repeat(MIN_MESSAGE) })).toEqual({});
  });
});
