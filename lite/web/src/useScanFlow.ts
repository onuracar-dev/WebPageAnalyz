import { useCallback, useEffect, useReducer } from 'react';
import { api } from './api';
import { flowReducer, initialFlowState, pollDelay, shouldPoll } from './scanMachine';

const SCAN_PARAM = 'scan';
const SUCCESS_HOLD_MS = 700;

function readScanParam(): string | null {
  return new URLSearchParams(window.location.search).get(SCAN_PARAM);
}

function writeScanParam(id: string | undefined) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set(SCAN_PARAM, id);
  else url.searchParams.delete(SCAN_PARAM);
  window.history.replaceState(null, '', url);
}

export function useScanFlow() {
  const [state, dispatch] = useReducer(flowReducer, initialFlowState, (initial) => {
    const id = typeof window === 'undefined' ? null : readScanParam();
    return id ? flowReducer(initial, { type: 'RESUME', scanId: id }) : initial;
  });

  useEffect(() => writeScanParam(state.scanId), [state.scanId]);

  useEffect(() => {
    if (!shouldPoll(state) || !state.scanId) return;
    const scanId = state.scanId;
    let cancelled = false;
    let timer: number | undefined;

    const run = async () => {
      if (document.hidden) return; // resumed by the visibility listener
      try {
        const scan = await api.scan(scanId);
        if (!cancelled) dispatch({ type: 'POLL_OK', scan });
      } catch (error) {
        if (!cancelled) dispatch({ type: 'POLL_FAIL', error });
      }
    };
    const onVisible = () => {
      if (!document.hidden) run();
    };

    timer = window.setTimeout(run, pollDelay(state));
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [state]);

  /** Resolves once the scan is accepted and rejects on API errors, so the action button can show either outcome. */
  const submit = useCallback(async (url: string) => {
    dispatch({ type: 'SUBMIT_START' });
    let result;
    try {
      result = await api.submit(url);
    } catch (error) {
      dispatch({ type: 'SUBMIT_FAIL', error });
      throw error;
    }
    // Let the button's success tick land before the scene changes.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (!reduced) await new Promise((resolve) => window.setTimeout(resolve, SUCCESS_HOLD_MS));
    dispatch({ type: 'SUBMIT_OK', result });
  }, []);

  const reset = useCallback(() => dispatch({ type: 'RESET' }), []);

  return { state, submit, reset };
}
