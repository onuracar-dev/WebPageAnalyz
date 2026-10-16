/** Contact goes through the visitor's own mail app; nothing is sent by this site. */

// Assembled at runtime so the address is not sitting in the HTML for simple scrapers.
const USER = ['onuracar', 'work'].join('.');
const DOMAIN = ['gmail', 'com'].join('.');

export function contactAddress(): string {
  return `${USER}@${DOMAIN}`;
}

export interface MailDraft {
  name: string;
  topic: string;
  message: string;
}

export function mailSubject({ name, topic }: MailDraft): string {
  return `[WPA Lite] ${topic} from ${name.replace(/[\r\n]+/g, ' ').trim()}`.slice(0, 120);
}

export function mailBody({ name, topic, message }: MailDraft): string {
  return [`Name: ${name.trim()}`, `Topic: ${topic}`, '', message.trim()].join('\n');
}

/** RFC 6068 mailto link; line breaks are sent as %0D%0A. */
export function buildMailto(draft: MailDraft, address = contactAddress()): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%0A/g, '%0D%0A');
  return `mailto:${address}?subject=${encode(mailSubject(draft))}&body=${encode(mailBody(draft))}`;
}
