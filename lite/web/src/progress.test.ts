import { describe, expect, it } from 'vitest';
import type { Scan } from './api';
import { scanProgress } from './progress';

const scan = (status: Scan['status'], engines: Scan['engines'], extra: Partial<Scan> = {}): Scan => ({
  id: 'a',
  url: 'https://example.com/',
  status,
  engines,
  findings: [],
  summary: { bySeverity: {}, byCategory: {} },
  ...extra,
});

describe('scanProgress', () => {
  it('reports the queue position while waiting', () => {
    expect(scanProgress(scan('queued', {}, { position: 3 }))).toEqual({ done: 0, total: 7, label: 'Waiting in queue · position 3' });
  });

  it('counts finished engines (including failures) and names the running ones', () => {
    const progress = scanProgress(
      scan('running', {
        lighthouse: { status: 'completed' },
        axe: { status: 'failed' },
        yellowLab: { status: 'running' },
        wpaPage: { status: 'running' },
        performancePlus: { status: 'pending' },
      }),
    );
    expect(progress.done).toBe(2);
    expect(progress.label).toBe('Running Yellow Lab & WPA Page');
  });

  it('lists three running engines with commas', () => {
    const running = { status: 'running' as const };
    expect(scanProgress(scan('running', { performancePlus: running, advancedGeo: running, visualUx: running })).label).toBe(
      'Running Performance+, Advanced GEO & Visual UX',
    );
  });

  it('says it is preparing when nothing has started yet', () => {
    expect(scanProgress(scan('running', {})).label).toBe('Preparing engines');
    expect(scanProgress(undefined)).toEqual({ done: 0, total: 7, label: 'Starting scan' });
  });

  it('wraps up once every engine has finished', () => {
    const done = Object.fromEntries(['lighthouse', 'axe', 'yellowLab', 'wpaPage', 'performancePlus', 'advancedGeo', 'visualUx'].map((id) => [id, { status: 'completed' as const }]));
    expect(scanProgress(scan('running', done))).toEqual({ done: 7, total: 7, label: 'Wrapping up' });
  });
});
