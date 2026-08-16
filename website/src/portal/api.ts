import { authClient } from './authClient';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  code?: string;
  status: number;
  retryAfterSeconds?: number;

  constructor(message: string, status: number, code?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function parseRetryAfter(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { Accept: 'application/json', ...init.headers },
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    throw new ApiError(
      payload?.error || payload?.message || `Request failed (${response.status}).`,
      response.status,
      payload?.code,
      parseRetryAfter(response.headers.get('retry-after')),
    );
  }
  return payload as T;
}

export function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

let privilegedStepUpInFlight: Promise<void> | null = null;

async function performPrivilegedStepUp() {
  if (!privilegedStepUpInFlight) {
    privilegedStepUpInFlight = (async () => {
      const result = await authClient.signIn.passkey();
      if (result.error) throw new ApiError(result.error.message || 'Passkey verification failed.', result.error.status || 403, 'ADMIN_WEBAUTHN_STEP_UP_FAILED');
      await apiFetch('/api/v1/admin/security/step-up/webauthn', jsonRequest('POST', {}));
    })().finally(() => { privilegedStepUpInFlight = null; });
  }
  return privilegedStepUpInFlight;
}

/**
 * Runs an admin request and, only when the API proves the route crossed a
 * critical step-up boundary, obtains a fresh WebAuthn assertion and retries
 * the previously unexecuted request once. Unknown and enrollment errors are
 * never converted into allow decisions.
 */
export async function privilegedApiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await apiFetch<T>(path, init);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'ADMIN_WEBAUTHN_STEP_UP_REQUIRED') throw error;
    await performPrivilegedStepUp();
    return apiFetch<T>(path, init);
  }
}
