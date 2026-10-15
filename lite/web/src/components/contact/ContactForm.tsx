// Adapted from the Arc UI contact-section block (https://uiarc.dev), MIT License.
// Kept: the validated form, topic picker and the morph into a confirmation. Changed: copy for a one-person project,
// no public email address or demo channels/offices, a honeypot field, server-side field errors, and a real API call.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, motion, useAnimate, useIsPresent, useReducedMotion } from 'motion/react';
import type { Variants } from 'motion/react';
import { Clock, ShieldAlert } from 'lucide-react';
import { ApiError, CONTACT_TOPICS, messageFor, type ContactMessage } from '../../api';
import { Button } from '../../vendor/arc/button/button';
import { Input } from '../../vendor/arc/input/input';
import { Textarea } from '../../vendor/arc/textarea/textarea';
import { motionTokens } from '../../vendor/arc/lib/motion-tokens';
import styles from './ContactForm.module.css';

type Bezier = [number, number, number, number];
const enter = [...motionTokens.ease.enter] as Bezier;
const standard = [...motionTokens.ease.standard] as Bezier;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MAX_MESSAGE = 2000;
export const MIN_MESSAGE = 20;

/** Faces slide along one axis in the direction of travel and settle out of a soft blur. */
const faceVariants: Variants = {
  hidden: ({ direction }: { direction: number }) => ({ opacity: 0, y: direction * 18, filter: `blur(${motionTokens.blur.soft}px)` }),
  shown: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      y: motionTokens.spring.smooth,
      opacity: { duration: motionTokens.duration.standard, ease: enter, delay: 0.04 },
      filter: { duration: motionTokens.duration.standard, ease: enter, delay: 0.04 },
    },
  },
  gone: ({ direction }: { direction: number }) => ({
    opacity: 0,
    y: direction * -12,
    filter: `blur(${motionTokens.blur.soft}px)`,
    transition: { duration: motionTokens.duration.fast, ease: standard },
  }),
};
const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: motionTokens.duration.fast } },
  gone: { opacity: 0, transition: { duration: motionTokens.duration.instant } },
};

function Face({ children, direction, reduced }: { children: ReactNode; direction: number; reduced: boolean }) {
  const present = useIsPresent();
  return (
    <motion.div
      className={styles.face}
      data-face=""
      data-leaving={present ? undefined : ''}
      inert={!present}
      custom={{ direction }}
      variants={reduced ? fadeVariants : faceVariants}
      initial="hidden"
      animate="shown"
      exit="gone"
    >
      {children}
    </motion.div>
  );
}

/** One surface that springs from the height of its old content to the new one while the faces crossfade. */
function MorphPanel({ faceKey, direction, reduced, children }: { faceKey: string; direction: number; reduced: boolean; children: ReactNode }) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const lastKey = useRef(faceKey);
  const lastHeight = useRef(0);
  useEffect(() => {
    const node = scope.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    lastHeight.current = node.offsetHeight;
    const observer = new ResizeObserver(() => {
      lastHeight.current = node.offsetHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [scope]);
  useLayoutEffect(() => {
    if (lastKey.current === faceKey) return;
    lastKey.current = faceKey;
    const node = scope.current;
    const face = node?.querySelector<HTMLElement>(':scope > [data-face]:not([data-leaving])');
    if (!node || !face || reduced) return;
    const from = lastHeight.current || node.offsetHeight;
    const to = face.offsetHeight;
    if (Math.abs(from - to) < 1) return;
    node.style.setProperty('height', `${from}px`);
    const controls = animate(node, { height: [from, to] }, motionTokens.spring.smooth);
    controls.then(() => node.style.removeProperty('height'));
    return () => {
      controls.stop();
      node.style.removeProperty('height');
    };
  }, [faceKey, animate, scope, reduced]);
  return (
    <div ref={scope} className={`${styles.morph} ${styles.formCard}`}>
      <AnimatePresence initial={false} mode="popLayout" custom={{ direction }}>
        <Face key={faceKey} direction={direction} reduced={reduced}>
          {children}
        </Face>
      </AnimatePresence>
    </div>
  );
}

/** Topic chips as a radio group: a highlight glides to the choice and arrow keys move it. */
function TopicPicker({ value, onChange, reduced }: { value: string; onChange: (topic: string) => void; reduced: boolean }) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const topics = CONTACT_TOPICS as readonly string[];
  function onKeyDown(event: KeyboardEvent) {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (topics.indexOf(value) + delta + topics.length) % topics.length;
    onChange(topics[next]);
    refs.current[next]?.focus();
  }
  return (
    <div className={styles.topicField}>
      <span id={`${id}-label`} className={styles.fieldLabel}>
        Topic
      </span>
      <LayoutGroup id={id}>
        <div className={styles.topics} role="radiogroup" aria-labelledby={`${id}-label`} onKeyDown={onKeyDown}>
          {topics.map((topic, index) => (
            <button
              key={topic}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={topic === value}
              tabIndex={topic === value ? 0 : -1}
              className={styles.topic}
              onClick={() => onChange(topic)}
            >
              {topic === value && (
                <motion.span layoutId="topic" className={styles.topicHighlight} transition={reduced ? { duration: 0 } : motionTokens.spring.morph} aria-hidden="true" />
              )}
              <span>{topic}</span>
            </button>
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}

export type ContactErrors = Partial<Record<'name' | 'email' | 'message', string>>;

export function validateContact(values: { name: string; email: string; message: string }): ContactErrors {
  const errors: ContactErrors = {};
  const message = values.message.trim();
  if (!values.name.trim()) errors.name = 'Enter your name';
  if (!values.email.trim()) errors.email = 'Enter your email address';
  else if (!EMAIL.test(values.email.trim())) errors.email = 'Enter an email like name@example.com';
  if (message.length < MIN_MESSAGE) errors.message = message ? `Add a little more detail, at least ${MIN_MESSAGE} characters` : 'Tell me what’s on your mind';
  return errors;
}

interface Props {
  onSubmit: (message: ContactMessage, honeypot: string) => Promise<void>;
  defaultTopic?: string;
}

export function ContactForm({ onSubmit, defaultTopic }: Props) {
  const reduced = useReducedMotion() ?? false;
  const titleId = useId();
  const [values, setValues] = useState({ name: '', email: '', message: '' });
  const [honeypot, setHoneypot] = useState('');
  const [topic, setTopic] = useState<string>(defaultTopic && (CONTACT_TOPICS as readonly string[]).includes(defaultTopic) ? defaultTopic : CONTACT_TOPICS[0]);
  const [errors, setErrors] = useState<ContactErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [phase, setPhase] = useState<'editing' | 'sending' | 'sent'>('editing');
  const [failure, setFailure] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState({ name: '', email: '' });
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const restoreFocus = useRef(false);
  const successRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (phase === 'sent') successRef.current?.focus();
    if (phase === 'editing' && restoreFocus.current) {
      restoreFocus.current = false;
      nameRef.current?.focus();
    }
  }, [phase]);

  const update = (field: keyof typeof values) => (event: { target: { value: string } }) => {
    const next = { ...values, [field]: event.target.value };
    setValues(next);
    if (submitted) setErrors(validateContact(next));
  };

  function focusFirst(found: ContactErrors) {
    if (found.name) nameRef.current?.focus();
    else if (found.email) emailRef.current?.focus();
    else if (found.message) messageRef.current?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (phase !== 'editing') return;
    setSubmitted(true);
    setFailure(null);
    const found = validateContact(values);
    setErrors(found);
    if (Object.keys(found).length) {
      focusFirst(found);
      return;
    }
    setPhase('sending');
    const payload = { name: values.name.trim(), email: values.email.trim(), topic, message: values.message.trim() };
    try {
      await onSubmit(payload, honeypot);
      setSentTo({ name: payload.name.split(/\s+/)[0], email: payload.email });
      setPhase('sent');
    } catch (error) {
      setPhase('editing');
      const code = error instanceof ApiError ? error.code : 'NETWORK_ERROR';
      if (error instanceof ApiError && error.fields) {
        const serverErrors: ContactErrors = { name: error.fields.name, email: error.fields.email, message: error.fields.message };
        setErrors(serverErrors);
        focusFirst(serverErrors);
      }
      setFailure(messageFor(code));
    }
  }

  function reset() {
    setValues({ name: '', email: '', message: '' });
    setErrors({});
    setSubmitted(false);
    setFailure(null);
    restoreFocus.current = true;
    setPhase('editing');
  }

  const left = MAX_MESSAGE - values.message.length;
  return (
    <section className={styles.contact} data-variant="form" aria-labelledby={titleId}>
      <div className={styles.inner}>
        <div className={styles.intro}>
          <p className="eyebrow">Contact</p>
          <h1 id={titleId} className={styles.title}>
            Get in touch
          </h1>
          <p className={styles.description}>
            Feedback on WPA Lite, a bug in a scan result, or traffic from this scanner you didn’t expect. Messages go straight to the
            person who built it.
          </p>
          <ul className={styles.facts}>
            <li>
              <Clock size={16} strokeWidth={1.75} aria-hidden="true" />I usually reply within a few days
            </li>
            <li>
              <ShieldAlert size={16} strokeWidth={1.75} aria-hidden="true" />
              Unexpected scan traffic? Pick “Abuse report”
            </li>
          </ul>
        </div>

        <MorphPanel faceKey={phase === 'sent' ? 'sent' : 'form'} direction={phase === 'sent' ? 1 : -1} reduced={reduced}>
          {phase === 'sent' ? (
            <div className={styles.success} aria-live="polite">
              <span className={styles.successMark} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <motion.path
                    d="M5 12.5l4.5 4.5L19 7.5"
                    initial={reduced ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: reduced ? 0 : 0.42, ease: enter, delay: 0.16 }}
                  />
                </svg>
              </span>
              <h2 ref={successRef} tabIndex={-1} className={styles.successTitle}>
                Thanks, {sentTo.name}
              </h2>
              <p className={styles.successText}>Your message is on its way. I’ll reply to {sentTo.email} as soon as I can.</p>
              <Button variant="secondary" onClick={reset}>
                Send another message
              </Button>
            </div>
          ) : (
            <form className={styles.formBody} onSubmit={submit} noValidate aria-label="Contact form">
              <div className={styles.row}>
                <Input
                  ref={nameRef}
                  label="Name"
                  name="name"
                  autoComplete="name"
                  placeholder="Ada Lovelace"
                  maxLength={100}
                  value={values.name}
                  onChange={update('name')}
                  error={errors.name}
                  readOnly={phase === 'sending'}
                />
                <Input
                  ref={emailRef}
                  label="Email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="ada@example.com"
                  maxLength={200}
                  value={values.email}
                  onChange={update('email')}
                  error={errors.email}
                  readOnly={phase === 'sending'}
                />
              </div>
              {/* Honeypot: hidden from people and assistive tech, bots tend to fill it. */}
              <div className={styles.honeypot} aria-hidden="true">
                <label>
                  Website
                  <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(event) => setHoneypot(event.target.value)} />
                </label>
              </div>
              <TopicPicker value={topic} onChange={setTopic} reduced={reduced} />
              <Textarea
                ref={messageRef}
                label="Message"
                name="message"
                rows={5}
                maxLength={MAX_MESSAGE}
                placeholder="What happened, and on which URL?"
                value={values.message}
                onChange={update('message')}
                error={errors.message}
                description={`${left} characters left`}
                readOnly={phase === 'sending'}
              />
              <AnimatePresence initial={false}>
                {failure && (
                  <motion.p
                    key="failure"
                    role="alert"
                    className={styles.failure}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={reduced ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast, ease: standard } }}
                  >
                    {failure}
                  </motion.p>
                )}
              </AnimatePresence>
              <div className={styles.submitRow}>
                <p className={styles.fine}>Your email is only used to reply to you.</p>
                <Button type="submit" variant="primary" loading={phase === 'sending'}>
                  Send message
                </Button>
              </div>
            </form>
          )}
        </MorphPanel>
      </div>
    </section>
  );
}
