import { describe, expect, it } from 'vitest';
import type { Finding } from './api';
import { deviceOf, evidenceCode } from './evidence';

const finding = (evidence: Finding['evidence'], extra: Partial<Finding> = {}): Finding => ({
  id: 'f',
  ruleId: 'rule.x',
  title: 'X',
  severity: 'medium',
  category: 'seo',
  evidence,
  ...extra,
});

describe('evidenceCode', () => {
  it('shows axe markup with its selector', () => {
    const code = evidenceCode(finding([{ type: 'axe-nodes', value: [{ target: ['main', 'p'], html: '<p>Hi</p>' }] }]));
    expect(code).toEqual({ code: '<!-- main p -->\n<p>Hi</p>', language: 'html', filename: 'main p', fromPage: true });
  });

  it('finds Lighthouse node snippets nested in audit items and de-duplicates them', () => {
    const node = { type: 'node', selector: 'html', snippet: '<html lang="en">', boundingRect: { top: 0 } };
    const code = evidenceCode(finding([{ type: 'lighthouse-audit', value: { items: [{ node }, { node }] } }]));
    expect(code?.language).toBe('html');
    expect(code?.code).toBe('<!-- html -->\n<html lang="en">');
  });

  it('falls back to pruned JSON when there is no markup', () => {
    const code = evidenceCode(finding([{ type: 'lighthouse-audit', name: 'cache-insight', value: { items: [{ url: 'https://a/s.js', node: { lhId: 'x', path: '1', type: 'node' } }] } }]));
    expect(code?.language).toBe('json');
    expect(code?.fromPage).toBe(false);
    expect(code?.filename).toBe('rule.x.json');
    expect(code?.code).toContain('"cache-insight"');
    expect(code?.code).not.toContain('lhId');
  });

  it('returns null when the engine attached nothing', () => {
    expect(evidenceCode(finding([]))).toBeNull();
    expect(evidenceCode(finding(undefined))).toBeNull();
  });

  it('ignores strings that only look like html fields', () => {
    expect(evidenceCode(finding([{ type: 'x', value: { html: 'plain text' } }]))?.language).toBe('json');
  });
});

describe('deviceOf', () => {
  it('reads the device from the field or the rule id suffix', () => {
    expect(deviceOf(finding([], { device: 'desktop' }))).toBe('desktop');
    expect(deviceOf(finding([], { ruleId: 'backend.csp.missing.mobile' }))).toBe('mobile');
    expect(deviceOf(finding([]))).toBeUndefined();
  });
});
