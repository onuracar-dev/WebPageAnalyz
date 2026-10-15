import type { Finding } from './api';

export interface EvidenceCode {
  code: string;
  language: 'html' | 'json';
  filename: string;
  /** True when the code is markup captured from the scanned page, not a data dump. */
  fromPage: boolean;
}

interface Snippet {
  html: string;
  selector?: string;
}

const MAX_SNIPPETS = 8;
const MAX_JSON_LINES = 80;
const NOISE_KEYS = new Set(['boundingRect', 'lhId', 'path', 'type']);

/** Some engines put the device in the rule id (`backend.csp.missing.mobile`) instead of `device`. */
export function deviceOf(finding: Finding): string | undefined {
  return finding.device || /\.(desktop|mobile)$/.exec(finding.ruleId)?.[1];
}

function selectorOf(node: Record<string, unknown>): string | undefined {
  if (typeof node.selector === 'string') return node.selector;
  if (Array.isArray(node.target)) return node.target.filter((part) => typeof part === 'string').join(' ');
  return undefined;
}

/** Collects markup the engines captured from the page (axe `html`, Lighthouse `snippet`). */
export function collectSnippets(value: unknown, out: Snippet[] = [], depth = 0): Snippet[] {
  if (depth > 6 || out.length >= MAX_SNIPPETS || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectSnippets(item, out, depth + 1);
    return out;
  }
  const node = value as Record<string, unknown>;
  const html = typeof node.html === 'string' ? node.html : typeof node.snippet === 'string' ? node.snippet : undefined;
  if (html && /<[a-z!]/i.test(html)) {
    const snippet = { html: html.trim(), selector: selectorOf(node) };
    if (!out.some((s) => s.html === snippet.html && s.selector === snippet.selector)) out.push(snippet);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'html' && key !== 'snippet') collectSnippets(child, out, depth + 1);
  }
  return out;
}

function prune(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => prune(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, child]) => !NOISE_KEYS.has(key) && child !== null && child !== undefined)
        .map(([key, child]) => [key, prune(child, depth + 1)]),
    );
  }
  return value;
}

/** What to show in the code block for a finding, or null when the engine attached nothing. */
export function evidenceCode(finding: Finding): EvidenceCode | null {
  const evidence = finding.evidence ?? [];
  const snippets = collectSnippets(evidence.map((item) => item.value));
  if (snippets.length) {
    const code = snippets.map((s) => (s.selector ? `<!-- ${s.selector} -->\n${s.html}` : s.html)).join('\n\n');
    return { code, language: 'html', filename: snippets[0].selector || 'page.html', fromPage: true };
  }

  const data = evidence.filter((item) => item.value !== undefined && item.value !== null && item.value !== '');
  if (!data.length) return null;
  const shaped = Object.fromEntries(data.map((item, i) => [item.name || item.type || `evidence${i + 1}`, prune(item.value)]));
  const lines = JSON.stringify(shaped, null, 2).split('\n');
  const code = lines.length > MAX_JSON_LINES ? [...lines.slice(0, MAX_JSON_LINES), '  …'].join('\n') : lines.join('\n');
  return { code, language: 'json', filename: `${finding.ruleId}.json`, fromPage: false };
}
