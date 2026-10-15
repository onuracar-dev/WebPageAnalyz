import { SEVERITIES, type Finding, type Severity } from '../api';

export type GroupMode = 'all' | 'category' | 'engine' | 'severity';

export interface Group {
  key: string;
  label: string;
  items: Finding[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Body extends Point {
  vx: number;
  vy: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  accessibility: 'Accessibility',
  backend: 'Backend',
  design: 'Design',
  geo: 'GEO',
  lighthouse: 'Best practices',
  performance: 'Performance',
  runtime: 'Runtime',
  security: 'Security',
  seo: 'SEO',
};

export const ENGINE_LABELS: Record<string, string> = {
  lighthouse: 'Lighthouse',
  axe: 'axe',
  yellowLab: 'Yellow Lab',
  wpaPage: 'WPA Page',
  performancePlus: 'Performance+',
  advancedGeo: 'Advanced GEO',
  visualUx: 'Visual UX',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

const severityRank = (severity: Severity) => {
  const index = SEVERITIES.indexOf(severity);
  return index === -1 ? SEVERITIES.length : index;
};

export function bySeverity(a: Finding, b: Finding): number {
  return severityRank(a.severity) - severityRank(b.severity) || a.title.localeCompare(b.title);
}

export function groupKey(finding: Finding, mode: GroupMode): string {
  if (mode === 'all') return 'all';
  if (mode === 'severity') return finding.severity;
  if (mode === 'engine') return finding.engineId || 'other';
  return finding.category || 'other';
}

export function groupLabel(key: string, mode: GroupMode): string {
  if (mode === 'all') return 'All findings';
  if (mode === 'severity') return SEVERITY_LABELS[key as Severity] || key;
  if (mode === 'engine') return ENGINE_LABELS[key] || key;
  return CATEGORY_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

/** Groups findings; severity groups keep severity order, others sort by size. */
export function groupFindings(findings: Finding[], mode: GroupMode): Group[] {
  const map = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = groupKey(finding, mode);
    const list = map.get(key);
    if (list) list.push(finding);
    else map.set(key, [finding]);
  }
  const groups = [...map.entries()].map(([key, items]) => ({ key, label: groupLabel(key, mode), items: items.sort(bySeverity) }));
  if (mode === 'severity') return groups.sort((a, b) => severityRank(a.key as Severity) - severityRank(b.key as Severity));
  return groups.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

/** Cluster centres on an ellipse inside the stage, leaving room for labels. */
export function clusterCenters(count: number, width: number, height: number): Point[] {
  const cx = width / 2;
  const cy = height / 2;
  if (count <= 0) return [];
  if (count === 1) return [{ x: cx, y: cy }];
  const rx = width * (count === 2 ? 0.24 : 0.33);
  const ry = height * (count === 2 ? 0.0 : 0.3);
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (i / count) * Math.PI * 2 + (count === 2 ? Math.PI / 2 : 0);
    return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
}

const BASE_RADIUS: Record<Severity, number> = { critical: 10, high: 8, medium: 6.5, low: 5, info: 4 };

export function starRadius(severity: Severity, scale = 1): number {
  return (BASE_RADIUS[severity] ?? 4) * scale;
}

/** Scale factor so stars stay legible on small stages without crowding large ones. */
export function stageScale(width: number, height: number): number {
  return Math.max(0.7, Math.min(1.25, Math.min(width, height) / 520));
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Sunflower packing around a centre; the largest (most severe) stars sit innermost. */
export function packOffset(index: number, spacing: number): Point {
  if (index === 0) return { x: 0, y: 0 };
  const r = spacing * Math.sqrt(index + 0.5);
  const angle = index * GOLDEN_ANGLE;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

export interface Layout {
  groups: Group[];
  centers: Point[];
  targets: Map<string, Point & { group: number }>;
}

/** Radius of the spiral disc used by the "all" view. */
export function discRadius(width: number, height: number): number {
  return Math.min(width * 0.42, height * 0.75);
}

const DISC_TILT = 0.5; // y squash, so the disc reads as a tilted galaxy
const ARM_TURNS = 1.35;

/** Point on one of two spiral arms; `t` runs from the core (0) to the rim (1). */
export function spiralPoint(t: number, arm: number, width: number, height: number, scatter = 0): Point {
  const maxR = discRadius(width, height);
  const r = maxR * (0.1 + 0.9 * t) + scatter * maxR * 0.08;
  const angle = t * ARM_TURNS * Math.PI * 2 + arm * Math.PI + scatter * 0.35;
  return { x: width / 2 + Math.cos(angle) * r, y: height / 2 + Math.sin(angle) * r * DISC_TILT };
}

export function computeLayout(findings: Finding[], mode: GroupMode, width: number, height: number): Layout {
  const groups = groupFindings(findings, mode);
  const centers = clusterCenters(groups.length, width, height);
  const scale = stageScale(width, height);
  const spacing = 13 * scale;
  const targets = new Map<string, Point & { group: number }>();

  if (mode === 'all') {
    // Most severe findings sit in the core; the rest trail out along two arms.
    const items = groups[0]?.items ?? [];
    items.forEach((finding, i) => {
      if (i < 6) {
        const offset = packOffset(i, spacing * 0.9);
        targets.set(finding.id, { x: width / 2 + offset.x, y: height / 2 + offset.y * 0.8, group: 0 });
        return;
      }
      const t = (i - 6 + 1) / Math.max(1, items.length - 6);
      targets.set(finding.id, { ...spiralPoint(t, i % 2, width, height), group: 0 });
    });
    return { groups, centers, targets };
  }

  groups.forEach((group, groupIndex) => {
    const center = centers[groupIndex];
    group.items.forEach((finding, i) => {
      const offset = packOffset(i, spacing);
      targets.set(finding.id, { x: center.x + offset.x, y: center.y + offset.y, group: groupIndex });
    });
  });
  return { groups, centers, targets };
}

export const SPRING = { stiffness: 0.055, damping: 0.8 };
export const DUST_SPRING = { stiffness: 0.022, damping: 0.88 };

/** One frame of a damped spring towards `target`; `dt` is in 60 fps frames. */
export function springStep(body: Body, target: Point, dt = 1, spring = SPRING): Body {
  const steps = Math.max(1, Math.round(dt));
  let { x, y, vx, vy } = body;
  for (let i = 0; i < steps; i += 1) {
    vx = (vx + (target.x - x) * spring.stiffness) * spring.damping;
    vy = (vy + (target.y - y) * spring.stiffness) * spring.damping;
    x += vx;
    y += vy;
  }
  return { x, y, vx, vy };
}

/** Radius of a packed cluster, used to place its label. */
export function clusterRadius(count: number, width: number, height: number): number {
  const spacing = 13 * stageScale(width, height);
  return count <= 1 ? spacing : spacing * Math.sqrt(count - 0.5) + spacing;
}

/* ---------- Transition choreography ---------- */

export const TRANSITION = {
  /** Last star leaves the gathering swirl this long after the switch. */
  maxStaggerMs: 420,
  /** Labels start fading in once clusters have mostly settled. */
  labelDelayMs: 650,
  labelFadeMs: 450,
};

/** Release delay for the k-th star (ordered from the centre outwards). */
export function releaseDelay(rank: number, total: number): number {
  if (total <= 1) return 0;
  return Math.round((rank / (total - 1)) * TRANSITION.maxStaggerMs);
}

/** Where a star swirls to before it is released: pulled towards the centre and rotated. */
export function gatherPoint(from: Point, width: number, height: number): Point {
  const cx = width / 2;
  const cy = height / 2;
  const angle = 0.7;
  const dx = (from.x - cx) * 0.4;
  const dy = (from.y - cy) * 0.4;
  return { x: cx + dx * Math.cos(angle) - dy * Math.sin(angle), y: cy + dx * Math.sin(angle) + dy * Math.cos(angle) };
}

/** Tangential kick that makes the stars spin when grouping changes. */
export function swirlImpulse(at: Point, width: number, height: number, strength = 0.035): Point {
  const dx = at.x - width / 2;
  const dy = at.y - height / 2;
  return { x: -dy * strength, y: dx * strength };
}

export function labelOpacity(sinceSwitchMs: number): number {
  const t = (sinceSwitchMs - TRANSITION.labelDelayMs) / TRANSITION.labelFadeMs;
  return Math.max(0, Math.min(1, t));
}

/** Ease-out count-up for cluster totals. */
export function countUp(value: number, sinceSwitchMs: number): number {
  const t = Math.max(0, Math.min(1, (sinceSwitchMs - TRANSITION.labelDelayMs) / 700));
  return Math.round(value * (1 - (1 - t) ** 3));
}

/* ---------- Halo dust ---------- */

export interface DustSeed {
  /** Picks the group (by cumulative share) and the spiral arm. */
  u1: number;
  /** Orbit radius / position along the arm. */
  u2: number;
  /** Starting angle / scatter. */
  u3: number;
  size: number;
  alpha: number;
}

export function createDustSeeds(count: number, random: () => number): DustSeed[] {
  return Array.from({ length: count }, () => ({
    u1: random(),
    u2: random(),
    u3: random(),
    size: random() * 1.5 + 0.7,
    alpha: random() * 0.5 + 0.25,
  }));
}

/** Index of the group that owns a dust particle, proportional to group size. */
export function dustGroup(u1: number, groups: Group[]): number {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  if (!total) return -1;
  let acc = 0;
  for (let i = 0; i < groups.length; i += 1) {
    acc += groups[i].items.length / total;
    if (u1 < acc) return i;
  }
  return groups.length - 1;
}

/** Target for a dust particle at `timeMs`: an orbit around its cluster, or a spot on a spiral arm. */
export function dustTarget(seed: DustSeed, layout: Layout, mode: GroupMode, width: number, height: number, timeMs: number): Point | null {
  if (mode === 'all') {
    const t = seed.u2 ** 0.8;
    const scatter = (seed.u3 - 0.5) * 2;
    const p = spiralPoint(t, seed.u1 < 0.5 ? 0 : 1, width, height, scatter);
    // Slowly rotate the whole disc (in un-tilted space so the ellipse keeps its shape).
    const cx = width / 2;
    const cy = height / 2;
    const dx = p.x - cx;
    const dy = (p.y - cy) / DISC_TILT;
    const a = timeMs * 0.00003 * (1.3 - t);
    return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + (dx * Math.sin(a) + dy * Math.cos(a)) * DISC_TILT };
  }
  const groupIndex = dustGroup(seed.u1, layout.groups);
  if (groupIndex < 0) return null;
  const center = layout.centers[groupIndex];
  const r = clusterRadius(layout.groups[groupIndex].items.length, width, height);
  const orbit = r * (0.55 + 1.25 * seed.u2 ** 0.7);
  const speed = 0.00018 * (1.5 - seed.u2);
  const angle = seed.u3 * Math.PI * 2 + timeMs * speed;
  return { x: center.x + Math.cos(angle) * orbit, y: center.y + Math.sin(angle) * orbit * 0.82 };
}
