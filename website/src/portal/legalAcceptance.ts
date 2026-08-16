import { apiFetch, jsonRequest } from './api';

const STORAGE_KEY = 'wpa.pending-legal-acceptance.v1';
const MAX_PENDING_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type PendingLegalAcceptance = {
  termsVersion: string;
  acceptableUseVersion: string;
  queuedAt: string;
};

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 80;
}
export function queuePendingLegalAcceptance(termsVersion: string, acceptableUseVersion: string) {
  const pending: PendingLegalAcceptance = { termsVersion, acceptableUseVersion, queuedAt: new Date().toISOString() };
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pending)); } catch { /* A session can still record it immediately. */ }
  return pending;
}

export function readPendingLegalAcceptance(): PendingLegalAcceptance | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingLegalAcceptance>;
    const queuedAt = Date.parse(value.queuedAt || '');
    if (!validVersion(value.termsVersion) || !validVersion(value.acceptableUseVersion) || !Number.isFinite(queuedAt) || Date.now() - queuedAt > MAX_PENDING_AGE_MS) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return value as PendingLegalAcceptance;
  } catch {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* Storage can be unavailable. */ }
    return null;
  }
}

export async function flushPendingLegalAcceptance() {
  const pending = readPendingLegalAcceptance();
  if (!pending) return false;
  await apiFetch('/api/v1/legal/acceptances', jsonRequest('POST', {
    accepted: true,
    termsVersion: pending.termsVersion,
    acceptableUseVersion: pending.acceptableUseVersion,
  }));
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* The server record is authoritative. */ }
  return true;
}
