export const CONSENT_VERSION = '2026-10-15';

export const ENGINE_IDS = ['lighthouse', 'axe', 'yellowLab', 'wpaPage', 'performancePlus', 'advancedGeo', 'visualUx'] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export type EngineStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timed_out';
export type ScanStatus = 'queued' | 'running' | 'completed' | 'failed';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface ApiErrorBody {
  code: string;
  message: string;
  retryAfterSeconds?: number;
  /** Per-field validation messages (contact form). */
  fields?: Record<string, string>;
}

export interface EngineInfo {
  id: string;
  name: string;
  description: string;
  external: boolean;
}

export interface EngineState {
  status: EngineStatus;
  startedAt?: string;
  durationMs?: number;
  error?: ApiErrorBody;
}

export interface Evidence {
  type?: string;
  name?: string;
  value?: unknown;
}

export interface Finding {
  id: string;
  ruleId: string;
  category: string;
  title: string;
  description?: string;
  severity: Severity;
  engineId?: string;
  device?: string;
  pageUrl?: string;
  remediation?: string;
  evidence?: Evidence[];
}

export interface Scan {
  id: string;
  url: string;
  requestedUrl?: string;
  status: ScanStatus;
  position?: number;
  startedAt?: string;
  finishedAt?: string;
  engines: Partial<Record<string, EngineState>>;
  findings: Finding[];
  summary: { bySeverity: Partial<Record<Severity, number>>; byCategory: Record<string, number> };
  error?: ApiErrorBody;
}

export interface SubmitResult {
  id: string;
  status: ScanStatus;
  position?: number;
  cached?: boolean;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly fields?: Record<string, string>;

  constructor(status: number, body: Partial<ApiErrorBody> | undefined) {
    super(body?.message || `Request failed with status ${status}`);
    this.status = status;
    this.code = body?.code || (status === 0 ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR');
    this.retryAfterSeconds = body?.retryAfterSeconds;
    this.fields = body?.fields;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  } catch {
    throw new ApiError(0, undefined);
  }
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = body?.error as Partial<ApiErrorBody> | undefined;
    throw new ApiError(response.status, { ...error, retryAfterSeconds: error?.retryAfterSeconds ?? body?.retryAfterSeconds });
  }
  return body as T;
}

export const CONTACT_TOPICS = ['Feedback', 'Bug report', 'Abuse report', 'Other'] as const;

export interface ContactMessage {
  name: string;
  email: string;
  topic: string;
  message: string;
}

export const api = {
  engines: () => request<{ engines: EngineInfo[] }>('/api/engines').then((r) => r.engines),
  submit: (url: string) =>
    request<SubmitResult>('/api/scans', {
      method: 'POST',
      body: JSON.stringify({ url, consent: { accepted: true, version: CONSENT_VERSION } }),
    }),
  scan: (id: string) => request<Scan>(`/api/scans/${encodeURIComponent(id)}`),
  /** `website` is a honeypot: real visitors never see or fill it. */
  contact: (message: ContactMessage, website = '') =>
    request<{ ok: boolean }>('/api/contact', { method: 'POST', body: JSON.stringify({ ...message, website }) }),
};

const MESSAGES: Record<string, string> = {
  CONSENT_REQUIRED: 'Please confirm that you are authorized to test this site.',
  URL_NOT_ALLOWED: 'That address can’t be scanned. Use a public http(s) URL on port 80 or 443.',
  RATE_LIMIT_EXCEEDED: 'You’ve reached the limit of 3 scans per hour. Please try again later.',
  QUEUE_FULL: 'The scan queue is full right now. Please try again in a few minutes.',
  HOST_COOLDOWN: 'This site was scanned recently.',
  DAILY_LIMIT_REACHED: 'Today’s scan limit has been reached. Please come back tomorrow.',
  SCAN_NOT_FOUND: 'This result expired. Results are kept for 30 minutes.',
  NETWORK_ERROR: 'Can’t reach the scanner. Check your connection and try again.',
  CONTACT_INVALID: 'Some fields need another look.',
  CONTACT_RATE_LIMITED: 'Too many messages from here. Please try again in an hour.',
  CONTACT_DISABLED: 'The contact form is switched off right now. Please try again later.',
  CONTACT_FAILED: 'Your message couldn’t be delivered. Please try again in a few minutes.',
};

export function messageFor(code: string): string {
  return MESSAGES[code] || 'Something went wrong. Please try again.';
}

export function normalizeInputUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

/** Shorter URL for headings: no scheme and no lone trailing slash (the full URL stays in the title attribute). */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
