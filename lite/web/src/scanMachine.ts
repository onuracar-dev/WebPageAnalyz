import { ApiError, messageFor, type Scan, type SubmitResult } from './api';

export type Phase = 'idle' | 'submitting' | 'scanning' | 'results';

export interface FlowError {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export interface FlowState {
  phase: Phase;
  scanId?: string;
  scan?: Scan;
  cached: boolean;
  failures: number;
  error?: FlowError;
}

export type FlowEvent =
  | { type: 'SUBMIT_START' }
  | { type: 'SUBMIT_OK'; result: SubmitResult }
  | { type: 'SUBMIT_FAIL'; error: unknown }
  | { type: 'RESUME'; scanId: string }
  | { type: 'POLL_OK'; scan: Scan }
  | { type: 'POLL_FAIL'; error: unknown }
  | { type: 'RESET' };

export const initialFlowState: FlowState = { phase: 'idle', cached: false, failures: 0 };

export const POLL_INTERVAL_MS = 2_000;
export const MAX_POLL_INTERVAL_MS = 10_000;

const isTerminal = (status: string) => status === 'completed' || status === 'failed';

export function toFlowError(error: unknown): FlowError {
  const code = error instanceof ApiError ? error.code : 'UNKNOWN_ERROR';
  return {
    code,
    message: messageFor(code),
    ...(error instanceof ApiError && error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
}

function isTransient(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
}

export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'SUBMIT_START':
      return { ...initialFlowState, phase: 'submitting' };
    case 'SUBMIT_OK':
      return {
        ...initialFlowState,
        phase: isTerminal(event.result.status) ? 'results' : 'scanning',
        scanId: event.result.id,
        cached: Boolean(event.result.cached),
      };
    case 'SUBMIT_FAIL':
      return { ...initialFlowState, error: toFlowError(event.error) };
    case 'RESUME':
      return { ...initialFlowState, phase: 'scanning', scanId: event.scanId };
    case 'POLL_OK':
      if (!state.scanId || event.scan.id !== state.scanId) return state;
      return { ...state, scan: event.scan, failures: 0, phase: isTerminal(event.scan.status) ? 'results' : 'scanning' };
    case 'POLL_FAIL':
      if (!isTransient(event.error)) return { ...initialFlowState, error: toFlowError(event.error) };
      return { ...state, failures: state.failures + 1 };
    case 'RESET':
      return initialFlowState;
  }
}

/** Whether the client still needs to fetch the scan. */
export function shouldPoll(state: FlowState): boolean {
  if (!state.scanId) return false;
  if (state.phase === 'scanning') return true;
  return state.phase === 'results' && !state.scan;
}

/** Delay before the next GET; the first fetch after submit or resume is immediate. */
export function pollDelay(state: FlowState): number {
  if (!state.scan && state.failures === 0) return 0;
  if (state.failures === 0) return POLL_INTERVAL_MS;
  return Math.min(POLL_INTERVAL_MS * 2 ** state.failures, MAX_POLL_INTERVAL_MS);
}
