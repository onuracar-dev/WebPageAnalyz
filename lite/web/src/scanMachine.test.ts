import { describe, expect, it } from 'vitest';
import { ApiError, type Scan } from './api';
import { MAX_POLL_INTERVAL_MS, POLL_INTERVAL_MS, flowReducer, initialFlowState, pollDelay, shouldPoll, type FlowState } from './scanMachine';

const scan = (status: Scan['status'], id = 'a'): Scan => ({
  id,
  url: 'https://example.com/',
  status,
  engines: {},
  findings: [],
  summary: { bySeverity: {}, byCategory: {} },
});

const submitted = flowReducer(initialFlowState, { type: 'SUBMIT_OK', result: { id: 'a', status: 'queued', position: 1 } });

describe('flowReducer', () => {
  it('moves queued -> running -> completed and stops polling at the end', () => {
    expect(submitted.phase).toBe('scanning');
    expect(shouldPoll(submitted)).toBe(true);
    expect(pollDelay(submitted)).toBe(0);

    const running = flowReducer(submitted, { type: 'POLL_OK', scan: scan('running') });
    expect(running.phase).toBe('scanning');
    expect(pollDelay(running)).toBe(POLL_INTERVAL_MS);

    const done = flowReducer(running, { type: 'POLL_OK', scan: scan('completed') });
    expect(done.phase).toBe('results');
    expect(shouldPoll(done)).toBe(false);
  });

  it('shows failed scans as results', () => {
    const failed = flowReducer(submitted, { type: 'POLL_OK', scan: { ...scan('failed'), error: { code: 'SCAN_TIMEOUT', message: 'x' } } });
    expect(failed.phase).toBe('results');
    expect(failed.scan?.error?.code).toBe('SCAN_TIMEOUT');
  });

  it('fetches a cached result once, then stops', () => {
    const cached = flowReducer(initialFlowState, { type: 'SUBMIT_OK', result: { id: 'a', status: 'completed', cached: true } });
    expect(cached).toMatchObject({ phase: 'results', cached: true });
    expect(shouldPoll(cached)).toBe(true);
    expect(shouldPoll(flowReducer(cached, { type: 'POLL_OK', scan: scan('completed') }))).toBe(false);
  });

  it('returns to the form with a message when the scan expired', () => {
    const expired = flowReducer(submitted, { type: 'POLL_FAIL', error: new ApiError(404, { code: 'SCAN_NOT_FOUND' }) });
    expect(expired.phase).toBe('idle');
    expect(expired.scanId).toBeUndefined();
    expect(expired.error?.code).toBe('SCAN_NOT_FOUND');
  });

  it('backs off on network errors up to the maximum and keeps polling', () => {
    let state: FlowState = flowReducer(submitted, { type: 'POLL_OK', scan: scan('running') });
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      state = flowReducer(state, { type: 'POLL_FAIL', error: new ApiError(0, undefined) });
      delays.push(pollDelay(state));
    }
    expect(delays).toEqual([4000, 8000, MAX_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS]);
    expect(shouldPoll(state)).toBe(true);
    expect(pollDelay(flowReducer(state, { type: 'POLL_OK', scan: scan('running') }))).toBe(POLL_INTERVAL_MS);
  });

  it('keeps the retry-after value for host cooldown errors', () => {
    const state = flowReducer(initialFlowState, {
      type: 'SUBMIT_FAIL',
      error: new ApiError(429, { code: 'HOST_COOLDOWN', retryAfterSeconds: 120 }),
    });
    expect(state).toMatchObject({ phase: 'idle', error: { code: 'HOST_COOLDOWN', retryAfterSeconds: 120 } });
  });

  it('ignores poll responses for another scan', () => {
    expect(flowReducer(submitted, { type: 'POLL_OK', scan: scan('completed', 'b') })).toBe(submitted);
  });

  it('resumes from a scan id in the URL', () => {
    const resumed = flowReducer(initialFlowState, { type: 'RESUME', scanId: 'z' });
    expect(resumed).toMatchObject({ phase: 'scanning', scanId: 'z' });
    expect(pollDelay(resumed)).toBe(0);
  });
});
