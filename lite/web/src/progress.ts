import { ENGINE_IDS, type Scan } from './api';
import { ENGINE_LABELS } from './galaxy/layout';

const FINISHED = new Set(['completed', 'failed', 'timed_out']);

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

export interface ScanProgress {
  done: number;
  total: number;
  label: string;
}

/** Progress comes only from engine states reported by the backend; nothing is estimated. */
export function scanProgress(scan: Scan | undefined): ScanProgress {
  const total = ENGINE_IDS.length;
  if (!scan) return { done: 0, total, label: 'Starting scan' };
  const states = scan.engines ?? {};
  const done = ENGINE_IDS.filter((id) => FINISHED.has(states[id]?.status ?? '')).length;

  if (scan.status === 'queued') {
    return { done, total, label: `Waiting in queue · position ${scan.position ?? 1}` };
  }
  if (scan.status === 'completed' || scan.status === 'failed' || done === total) {
    return { done, total, label: 'Wrapping up' };
  }
  const running = ENGINE_IDS.filter((id) => states[id]?.status === 'running').map((id) => ENGINE_LABELS[id] ?? id);
  return { done, total, label: running.length ? `Running ${joinNames(running)}` : 'Preparing engines' };
}
