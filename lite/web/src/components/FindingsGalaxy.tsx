import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { SEVERITIES, type Finding, type Severity } from '../api';
import {
  DUST_SPRING,
  clusterRadius,
  computeLayout,
  countUp,
  createDustSeeds,
  discRadius,
  dustGroup,
  dustTarget,
  gatherPoint,
  groupKey,
  labelOpacity,
  releaseDelay,
  springStep,
  stageScale,
  starRadius,
  swirlImpulse,
  type Body,
  type DustSeed,
  type GroupMode,
  type Layout,
  type Point,
  SEVERITY_LABELS,
} from '../galaxy/layout';

interface Props {
  findings: Finding[];
  mode: GroupMode;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
}

interface Speck {
  x: number;
  y: number;
  r: number;
  a: number;
}

interface Transition {
  start: number;
  delays: Map<string, number>;
  gather: Map<string, Point>;
  dustGather: Point[];
}

const MAX_DPR = 2;
const DUST_PER_FINDING = 26;
const DUST_STAGGER_MS = 650;

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function seededRandom(seed: number) {
  let s = Math.abs(Math.floor(seed)) % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function hashPhase(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}

function settled(): Transition {
  return { start: -1e9, delays: new Map(), gather: new Map(), dustGather: [] };
}

export function FindingsGalaxy({ findings, mode, selectedId, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bodiesRef = useRef(new Map<string, Body>());
  const layoutRef = useRef<Layout | null>(null);
  const modeRef = useRef<GroupMode>(mode);
  const transitionRef = useRef<Transition>(settled());
  const dustSeedsRef = useRef<DustSeed[]>([]);
  const dustBodiesRef = useRef<Body[]>([]);
  const specksRef = useRef<Speck[]>([]);
  const hoverRef = useRef<string | undefined>(undefined);
  const selectedRef = useRef<string | undefined>(selectedId);
  const drawRef = useRef<() => void>(() => {});
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<{ finding: Finding; x: number; y: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const byId = useMemo(() => new Map(findings.map((finding) => [finding.id, finding])), [findings]);

  // Track the stage size.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // Recompute targets whenever data, grouping or size changes, and choreograph the switch.
  useEffect(() => {
    const { width, height } = size;
    if (!width || !height) return;
    const layout = computeLayout(findings, mode, width, height);
    const previousMode = modeRef.current;
    const hadLayout = layoutRef.current !== null;
    layoutRef.current = layout;
    modeRef.current = mode;

    const reduced = prefersReducedMotion();
    const now = performance.now();
    const bodies = bodiesRef.current;
    const random = seededRandom(findings.length * 7919 + 17);

    // Stars: new ones drift in from a loose ring around the stage.
    for (const finding of findings) {
      const target = layout.targets.get(finding.id)!;
      if (bodies.has(finding.id) && !reduced) continue;
      const angle = random() * Math.PI * 2;
      const distance = Math.max(width, height) * (0.45 + random() * 0.25);
      bodies.set(
        finding.id,
        reduced || bodies.has(finding.id)
          ? { x: target.x, y: target.y, vx: 0, vy: 0 }
          : { x: width / 2 + Math.cos(angle) * distance, y: height / 2 + Math.sin(angle) * distance, vx: 0, vy: 0 },
      );
    }
    for (const id of [...bodies.keys()]) if (!byId.has(id)) bodies.delete(id);

    // Halo dust follows the findings; it is decorative and never hit-tested.
    const dustCount = Math.min(1600, Math.max(420, findings.length * DUST_PER_FINDING));
    if (dustSeedsRef.current.length !== dustCount) {
      const dustRandom = seededRandom(findings.length * 104729 + 3);
      dustSeedsRef.current = createDustSeeds(dustCount, dustRandom);
      dustBodiesRef.current = dustSeedsRef.current.map((seed) => {
        const target = dustTarget(seed, layout, mode, width, height, 0) ?? { x: width / 2, y: height / 2 };
        if (reduced) return { x: target.x, y: target.y, vx: 0, vy: 0 };
        const angle = dustRandom() * Math.PI * 2;
        const distance = Math.max(width, height) * (0.5 + dustRandom() * 0.4);
        return { x: width / 2 + Math.cos(angle) * distance, y: height / 2 + Math.sin(angle) * distance, vx: 0, vy: 0 };
      });
    } else if (reduced) {
      dustSeedsRef.current.forEach((seed, i) => {
        const target = dustTarget(seed, layout, mode, width, height, 0);
        if (target) Object.assign(dustBodiesRef.current[i], { x: target.x, y: target.y, vx: 0, vy: 0 });
      });
    }

    const modeChanged = hadLayout && previousMode !== mode;
    if (reduced) {
      transitionRef.current = settled();
    } else if (modeChanged) {
      // Spin everything, pull it into a swirl, then release stars centre-out in a wave.
      const ordered = [...findings].sort((a, b) => {
        const ta = layout.targets.get(a.id)!;
        const tb = layout.targets.get(b.id)!;
        return Math.hypot(ta.x - width / 2, ta.y - height / 2) - Math.hypot(tb.x - width / 2, tb.y - height / 2);
      });
      const delays = new Map<string, number>();
      const gather = new Map<string, Point>();
      ordered.forEach((finding, rank) => {
        const body = bodies.get(finding.id)!;
        const kick = swirlImpulse(body, width, height);
        body.vx += kick.x;
        body.vy += kick.y;
        delays.set(finding.id, releaseDelay(rank, ordered.length));
        gather.set(finding.id, gatherPoint(body, width, height));
      });
      const dustGather = dustBodiesRef.current.map((body) => {
        const kick = swirlImpulse(body, width, height, 0.03);
        body.vx += kick.x;
        body.vy += kick.y;
        return gatherPoint(body, width, height);
      });
      transitionRef.current = { start: now, delays, gather, dustGather };
    } else if (!hadLayout) {
      transitionRef.current = { start: now, delays: new Map(), gather: new Map(), dustGather: [] };
    }

    const specksRandom = seededRandom(width * 31 + height);
    specksRef.current = Array.from({ length: Math.round((width * height) / 2600) }, () => ({
      x: specksRandom() * width,
      y: specksRandom() * height,
      r: specksRandom() * 1.1 + 0.2,
      a: specksRandom() * 0.3 + 0.04,
    }));
    drawRef.current();
  }, [findings, mode, size, byId]);

  useEffect(() => {
    selectedRef.current = selectedId;
    drawRef.current();
  }, [selectedId]);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !size.width || !size.height) return;
    const { width, height } = size;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const style = getComputedStyle(canvas);
    const colors = Object.fromEntries(SEVERITIES.map((s) => [s, style.getPropertyValue(`--sev-${s}`).trim() || '#fff'])) as Record<
      Severity,
      string
    >;
    const ink = style.getPropertyValue('--ink').trim() || '#efe6e8';
    const muted = style.getPropertyValue('--ink-muted').trim() || '#b9a3ad';
    const scale = stageScale(width, height);
    const labelFont = `500 ${Math.round(12 * Math.max(0.9, scale))}px Inter, system-ui, sans-serif`;
    const countFont = `400 ${Math.round(11 * Math.max(0.9, scale))}px 'JetBrains Mono', ui-monospace, monospace`;
    const reduced = prefersReducedMotion();
    let visible = true;
    let frame = 0;
    let last = performance.now();

    const draw = (time = performance.now()) => {
      const layout = layoutRef.current;
      if (!layout) return;
      const currentMode = modeRef.current;
      const since = reduced ? 1e9 : time - transitionRef.current.start;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = ink;
      for (const speck of specksRef.current) {
        ctx.globalAlpha = speck.a;
        ctx.fillRect(speck.x, speck.y, speck.r, speck.r);
      }

      // Halo dust, tinted by a finding in the cluster it belongs to.
      const seeds = dustSeedsRef.current;
      const dust = dustBodiesRef.current;
      for (let i = 0; i < dust.length; i += 1) {
        const seed = seeds[i];
        const groupIndex = currentMode === 'all' ? 0 : dustGroup(seed.u1, layout.groups);
        const items = layout.groups[groupIndex]?.items;
        if (!items?.length) continue;
        ctx.fillStyle = colors[items[Math.floor(seed.u3 * items.length)].severity];
        ctx.globalAlpha = seed.alpha;
        ctx.fillRect(dust[i].x, dust[i].y, seed.size, seed.size);
      }

      // Cluster labels fade in and count up once the clusters settle.
      const opacity = labelOpacity(since);
      if (opacity > 0) {
        ctx.textAlign = 'center';
        layout.groups.forEach((group, i) => {
          const center = layout.centers[i];
          const y =
            currentMode === 'all'
              ? Math.min(height - 24, height / 2 + discRadius(width, height) * 0.5 + 26)
              : Math.min(height - 24, center.y + clusterRadius(group.items.length, width, height) * 1.25 + 20);
          ctx.globalAlpha = opacity;
          ctx.font = labelFont;
          ctx.fillStyle = ink;
          ctx.fillText(group.label, center.x, y);
          ctx.font = countFont;
          ctx.fillStyle = muted;
          const count = countUp(group.items.length, since);
          ctx.fillText(`${count} ${count === 1 ? 'finding' : 'findings'}`, center.x, y + 15);
        });
      }

      const selected = selectedRef.current;
      const hovered = hoverRef.current;
      for (const finding of findings) {
        const body = bodiesRef.current.get(finding.id);
        if (!body) continue;
        const drift = reduced ? 0 : 2.2 * scale;
        const phase = hashPhase(finding.id) * Math.PI * 2;
        const x = body.x + Math.sin(time * 0.00045 + phase) * drift;
        const y = body.y + Math.cos(time * 0.0004 + phase * 1.3) * drift;
        const r = starRadius(finding.severity, scale);
        const color = colors[finding.severity];
        const dimmed = selected && selected !== finding.id;

        const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
        glow.addColorStop(0, color);
        glow.addColorStop(1, 'transparent');
        ctx.globalAlpha = dimmed ? 0.12 : 0.35;
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = dimmed ? 0.45 : 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();

        if (finding.id === selected || finding.id === hovered) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = ink;
          ctx.lineWidth = finding.id === selected ? 2 : 1.25;
          ctx.beginPath();
          ctx.arc(x, y, r + 5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };
    drawRef.current = () => {
      if (reduced || !visible) draw();
    };

    const tick = (now: number) => {
      const dt = Math.min(4, (now - last) / (1000 / 60));
      last = now;
      const layout = layoutRef.current;
      if (layout) {
        const transition = transitionRef.current;
        const since = now - transition.start;
        for (const [id, body] of bodiesRef.current) {
          const target = layout.targets.get(id);
          if (!target) continue;
          const delay = transition.delays.get(id) ?? 0;
          const aim = since < delay ? (transition.gather.get(id) ?? target) : target;
          Object.assign(body, springStep(body, aim, dt));
        }
        const seeds = dustSeedsRef.current;
        const dust = dustBodiesRef.current;
        for (let i = 0; i < dust.length; i += 1) {
          const target = dustTarget(seeds[i], layout, modeRef.current, width, height, now);
          if (!target) continue;
          const delay = (i / dust.length) * DUST_STAGGER_MS;
          const gather = transition.dustGather[i];
          const aim = gather && since < delay ? gather : target;
          Object.assign(dust[i], springStep(dust[i], aim, dt, DUST_SPRING));
        }
      }
      draw(now);
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (reduced || frame || !visible || document.hidden) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
      else stop();
    });
    observer.observe(canvas);
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);

    draw();
    start();
    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [size, findings]);

  const hitTest = useCallback(
    (clientX: number, clientY: number): Finding | undefined => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return undefined;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const scale = stageScale(size.width, size.height);
      let best: Finding | undefined;
      let bestDistance = Infinity;
      for (const finding of findings) {
        const body = bodiesRef.current.get(finding.id);
        if (!body) continue;
        const distance = Math.hypot(body.x - x, body.y - y);
        if (distance < starRadius(finding.severity, scale) + 6 && distance < bestDistance) {
          best = finding;
          bestDistance = distance;
        }
      }
      return best;
    },
    [findings, size],
  );

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType !== 'mouse') return;
    const finding = hitTest(event.clientX, event.clientY);
    hoverRef.current = finding?.id;
    const rect = event.currentTarget.getBoundingClientRect();
    setHover(finding ? { finding, x: event.clientX - rect.left, y: event.clientY - rect.top } : null);
    event.currentTarget.style.cursor = finding ? 'pointer' : 'default';
    drawRef.current();
  };

  const onPointerLeave = () => {
    hoverRef.current = undefined;
    setHover(null);
  };

  const select = (finding: Finding | undefined) => {
    onSelect(finding?.id);
    setAnnouncement(finding ? `${SEVERITY_LABELS[finding.severity]}: ${finding.title}` : 'Selection cleared');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const layout = layoutRef.current;
    if (!layout || !layout.groups.length) return;
    const current = selectedId ? byId.get(selectedId) : undefined;
    const groupIndex = current ? layout.groups.findIndex((g) => g.key === groupKey(current, mode)) : -1;
    const group = layout.groups[groupIndex];
    const itemIndex = group && current ? group.items.findIndex((f) => f.id === current.id) : -1;

    let next: Finding | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const count = layout.groups.length;
        const nextGroup = groupIndex === -1 ? (step === 1 ? 0 : count - 1) : (groupIndex + step + count) % count;
        next = layout.groups[nextGroup].items[0];
        break;
      }
      case 'ArrowDown':
      case 'ArrowUp': {
        const items = group?.items ?? layout.groups[0].items;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        next = items[itemIndex === -1 ? 0 : (itemIndex + step + items.length) % items.length];
        break;
      }
      case 'Escape':
        select(undefined);
        event.preventDefault();
        return;
      default:
        return;
    }
    event.preventDefault();
    select(next);
  };

  const grouping = mode === 'all' ? 'shown as one galaxy' : `grouped by ${mode}`;
  const summary = `${findings.length} findings ${grouping}. Use arrow keys to move between clusters and findings, Escape to clear.`;

  return (
    <div className="galaxy" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="galaxy__canvas"
        role="application"
        aria-roledescription="findings map"
        aria-label={summary}
        tabIndex={0}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onClick={(event) => select(hitTest(event.clientX, event.clientY))}
        onKeyDown={onKeyDown}
      />
      {hover && (
        <div className="galaxy__tooltip" style={{ left: hover.x, top: hover.y }} role="presentation">
          <span className={`sev-dot sev-dot--${hover.finding.severity}`} />
          {hover.finding.title}
        </div>
      )}
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

