import { describe, expect, it } from 'vitest';
import type { Finding, Severity } from '../api';
import {
  TRANSITION,
  clusterCenters,
  computeLayout,
  countUp,
  discRadius,
  dustGroup,
  groupFindings,
  labelOpacity,
  packOffset,
  releaseDelay,
  spiralPoint,
  springStep,
  starRadius,
} from './layout';

const finding = (id: string, severity: Severity, category: string, engineId: string): Finding => ({
  id,
  ruleId: `rule.${id}`,
  title: `Finding ${id}`,
  severity,
  category,
  engineId,
});

const findings: Finding[] = [
  finding('1', 'low', 'seo', 'wpaPage'),
  finding('2', 'critical', 'security', 'wpaPage'),
  finding('3', 'medium', 'seo', 'lighthouse'),
  finding('4', 'high', 'accessibility', 'axe'),
  finding('5', 'info', 'seo', 'wpaPage'),
];

describe('groupFindings', () => {
  it('puts every finding in exactly one group for each mode', () => {
    for (const mode of ['all', 'category', 'engine', 'severity'] as const) {
      const ids = groupFindings(findings, mode)
        .flatMap((group) => group.items.map((item) => item.id))
        .sort();
      expect(ids).toEqual(['1', '2', '3', '4', '5']);
    }
  });

  it('orders severity groups by severity and items inside a group by severity', () => {
    expect(groupFindings(findings, 'severity').map((g) => g.key)).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    const seo = groupFindings(findings, 'category').find((g) => g.key === 'seo')!;
    expect(seo.items.map((item) => item.severity)).toEqual(['medium', 'low', 'info']);
    expect(groupFindings(findings, 'category')[0].key).toBe('seo');
  });
});

describe('layout geometry', () => {
  it('creates one centre per group inside the stage', () => {
    for (const count of [1, 2, 5, 9]) {
      const centers = clusterCenters(count, 800, 600);
      expect(centers).toHaveLength(count);
      for (const c of centers) {
        expect(c.x).toBeGreaterThan(0);
        expect(c.x).toBeLessThan(800);
        expect(c.y).toBeGreaterThan(0);
        expect(c.y).toBeLessThan(600);
      }
    }
  });

  it('assigns a target to every finding', () => {
    const layout = computeLayout(findings, 'engine', 800, 600);
    expect(layout.targets.size).toBe(findings.length);
    expect(layout.centers).toHaveLength(layout.groups.length);
  });

  it('packs stars at distinct positions', () => {
    expect(packOffset(0, 13)).toEqual({ x: 0, y: 0 });
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const p = packOffset(i, 13);
      seen.add(`${Math.round(p.x)}:${Math.round(p.y)}`);
    }
    expect(seen.size).toBe(40);
  });

  it('sizes stars by severity', () => {
    expect(starRadius('critical')).toBeGreaterThan(starRadius('high'));
    expect(starRadius('low')).toBeGreaterThan(starRadius('info'));
  });

  it('settles a spring on its target', () => {
    let body = { x: 0, y: 0, vx: 0, vy: 0 };
    for (let i = 0; i < 400; i += 1) body = springStep(body, { x: 100, y: -50 });
    expect(body.x).toBeCloseTo(100, 1);
    expect(body.y).toBeCloseTo(-50, 1);
  });
});

describe('all view', () => {
  it('keeps the spiral disc inside the stage', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      for (const arm of [0, 1]) {
        const p = spiralPoint(t, arm, 800, 600);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(800);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(600);
      }
    }
    expect(discRadius(800, 600)).toBeLessThan(400);
  });

  it('puts the most severe finding in the core', () => {
    const layout = computeLayout(findings, 'all', 800, 600);
    expect(layout.groups).toHaveLength(1);
    expect(layout.targets.get('2')).toMatchObject({ x: 400, y: 300 });
  });
});

describe('transition choreography', () => {
  it('staggers releases from 0 to the maximum', () => {
    expect(releaseDelay(0, 10)).toBe(0);
    expect(releaseDelay(9, 10)).toBe(TRANSITION.maxStaggerMs);
    expect(releaseDelay(0, 1)).toBe(0);
  });

  it('hides labels during the switch and counts up afterwards', () => {
    expect(labelOpacity(0)).toBe(0);
    expect(labelOpacity(TRANSITION.labelDelayMs + TRANSITION.labelFadeMs)).toBe(1);
    expect(countUp(14, 0)).toBe(0);
    expect(countUp(14, 10_000)).toBe(14);
  });

  it('shares dust between groups in proportion to their size', () => {
    const groups = groupFindings(findings, 'category');
    const counts = new Array(groups.length).fill(0);
    for (let i = 0; i < 1000; i += 1) counts[dustGroup((i + 0.5) / 1000, groups)] += 1;
    const seo = groups.findIndex((g) => g.key === 'seo');
    expect(counts[seo]).toBe(600);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});
