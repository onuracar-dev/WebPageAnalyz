// Adapted from AccordionOS by Urvish Mali (https://uselayouts.com/docs/components/accordionos), MIT License.
// Changes: findings instead of images, the right-hand layer is an evidence code block, keyboard handling is
// scoped to the component, no autoplay, and styles moved to styles.css.
import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Finding } from '../api';
import { deviceOf, evidenceCode } from '../evidence';
import { ENGINE_LABELS, SEVERITY_LABELS, bySeverity, groupLabel } from '../galaxy/layout';
import { CodeBlock } from '../vendor/arc/code-block/code-block';
import { InlineText } from './InlineText';

const springPhysics = { type: 'spring' as const, stiffness: 340, damping: 28, mass: 0.8 };
const bouncySpring = { type: 'spring' as const, stiffness: 400, damping: 22 };
const ease = [0.16, 1, 0.3, 1] as const;

interface Props {
  findings: Finding[];
  activeId?: string;
  onActivate: (id: string | undefined) => void;
}

function EvidencePanel({ finding }: { finding: Finding }) {
  const code = evidenceCode(finding);
  const device = deviceOf(finding);
  return (
    <div className="fa__evidence">
      <p className="fa__evidence-meta">
        <span className={`badge badge--${finding.severity}`}>{SEVERITY_LABELS[finding.severity]}</span>
        <span>{groupLabel(finding.category, 'category')}</span>
        {finding.engineId && <span>{ENGINE_LABELS[finding.engineId] ?? finding.engineId}</span>}
        {device && <span>{device}</span>}
      </p>
      <h3 className="fa__evidence-title">{finding.title}</h3>
      {code ? (
        <>
          <p className="fa__evidence-note">
            {code.fromPage ? 'Markup captured from the scanned page' : 'Evidence reported by the engine'}
          </p>
          <CodeBlock code={code.code} filename={code.filename} language={code.language} maxLines={16} />
        </>
      ) : (
        <p className="fa__evidence-empty">The engine didn’t attach code or evidence for this finding.</p>
      )}
      <p className="fa__evidence-rule mono">{finding.ruleId}</p>
    </div>
  );
}

export function FindingsAccordion({ findings, activeId, onActivate }: Props) {
  const reduce = useReducedMotion() ?? false;
  const items = useMemo(() => [...findings].sort(bySeverity), [findings]);
  const activeIndex = items.findIndex((f) => f.id === activeId);
  const active = activeIndex >= 0 ? items[activeIndex] : undefined;
  const stackRef = useRef<HTMLDivElement>(null);
  const pillRefs = useRef(new Map<string, HTMLDivElement>());

  const go = useCallback(
    (step: number) => {
      if (!items.length) return;
      const next = activeIndex < 0 ? 0 : (activeIndex + step + items.length) % items.length;
      onActivate(items[next].id);
    },
    [activeIndex, items, onActivate],
  );

  // Keep the active pill visible inside the scrolling stack without scrolling the page.
  useEffect(() => {
    const stack = stackRef.current;
    const pill = activeId ? pillRefs.current.get(activeId) : undefined;
    if (!stack || !pill) return;
    const top = pill.offsetTop - stack.offsetTop;
    if (top < stack.scrollTop || top + pill.offsetHeight > stack.scrollTop + stack.clientHeight) {
      stack.scrollTo({ top: Math.max(0, top - 12), behavior: reduce ? 'auto' : 'smooth' });
    }
  }, [activeId, reduce]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') go(1);
    else if (event.key === 'ArrowUp') go(-1);
    else if (event.key === 'Escape') onActivate(undefined);
    else return;
    event.preventDefault();
  };

  return (
    <section className="fa panel" aria-labelledby="fa-title" onKeyDown={onKeyDown}>
      <div className="fa__sidebar">
        <h2 id="fa-title" className="section-title">
          Findings <span className="muted mono">{items.length}</span>
        </h2>
        <div className="fa__stack" ref={stackRef}>
          {items.map((finding) => {
            const open = finding.id === activeId;
            return (
              <motion.div
                key={finding.id}
                ref={(node: HTMLDivElement | null) => {
                  if (node) pillRefs.current.set(finding.id, node);
                  else pillRefs.current.delete(finding.id);
                }}
                layout={reduce ? false : 'position'}
                transition={springPhysics}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                className={`fa__pill${open ? ' fa__pill--open' : ''}`}
                onClick={() => onActivate(open ? undefined : finding.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onActivate(open ? undefined : finding.id);
                  }
                }}
                whileHover={reduce ? undefined : { x: 3 }}
                whileTap={reduce ? undefined : { scale: 0.985 }}
              >
                <div className="fa__pill-head">
                  <motion.span className="fa__icon" animate={{ rotate: open ? 135 : 0 }} transition={bouncySpring} aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </motion.span>
                  <span className={`sev-dot sev-dot--${finding.severity}`} aria-hidden="true" />
                  <span className="fa__pill-title">{finding.title}</span>
                  {deviceOf(finding) && <span className="fa__pill-device">{deviceOf(finding)}</span>}
                  <span className="visually-hidden">, {SEVERITY_LABELS[finding.severity]}</span>
                </div>
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div
                      key="claim"
                      className="fa__claim"
                      initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0, marginTop: 0, filter: 'blur(4px)' }}
                      animate={{
                        opacity: 1,
                        height: 'auto',
                        marginTop: 10,
                        filter: 'blur(0px)',
                        transition: { height: { duration: 0.4, ease }, opacity: { duration: 0.3, delay: 0.08 }, filter: { duration: 0.3 } },
                      }}
                      exit={{ opacity: 0, height: 0, marginTop: 0, filter: 'blur(4px)', transition: { height: { duration: 0.28, ease }, opacity: { duration: 0.18 } } }}
                    >
                      {finding.description && (
                        <p>
                          <InlineText text={finding.description} />
                        </p>
                      )}
                      {finding.remediation && (
                        <p>
                          <strong>Fix: </strong>
                          <InlineText text={finding.remediation} />
                        </p>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>

        <div className="fa__deck">
          <AnimatePresence>
            {active && (
              <motion.div
                className="fa__nav"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 15, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: 15, scale: 0.9 }}
                transition={bouncySpring}
              >
                <button type="button" className="fa__nav-btn" onClick={() => go(-1)} aria-label="Previous finding">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                </button>
                <span className="fa__counter mono">
                  {String(activeIndex + 1).padStart(2, '0')}
                  <span className="fa__counter-divider">/</span>
                  {String(items.length).padStart(2, '0')}
                </span>
                <button type="button" className="fa__nav-btn" onClick={() => go(1)} aria-label="Next finding">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="fa__visual" aria-live="polite">
        <AnimatePresence mode="popLayout" initial={false}>
          {active ? (
            <motion.div
              key={active.id}
              className="fa__layer"
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.04, x: 28 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, x: -12 }}
              transition={{ duration: 0.45, ease }}
            >
              <EvidencePanel finding={active} />
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              className="fa__layer fa__layer--empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <p>Pick a finding on the left, or a star on the map, to see the code and evidence behind it.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
