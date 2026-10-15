import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { normalizeInputUrl } from '../api';
import type { FlowError } from '../scanMachine';
import { ActionButton } from '../vendor/arc/action-button/action-button';

interface Props {
  error?: FlowError;
  onSubmit: (url: string) => Promise<void>;
}

function useCountdown(seconds: number | undefined) {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setDeadline(seconds ? Date.now() + seconds * 1000 : null);
  }, [seconds]);

  useEffect(() => {
    if (!deadline) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [deadline]);

  if (!deadline) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

function formatWait(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export function ScanForm({ error, onSubmit }: Props) {
  const [url, setUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const buttonSlot = useRef<HTMLDivElement>(null);
  const urlId = useId();
  const consentId = useId();
  const errorId = useId();
  const wait = useCountdown(error?.code === 'HOST_COOLDOWN' ? error.retryAfterSeconds : undefined);
  const ready = consent && url.trim().length > 0;

  // Enter in the URL field goes through the action button so it shows the same pending/success states.
  const submitWithEnter = (event: FormEvent) => {
    event.preventDefault();
    if (ready) buttonSlot.current?.querySelector('button')?.click();
  };

  return (
    <section className="entry" aria-labelledby="entry-title">
      <p className="eyebrow">WebPage Analyzer · Lite</p>
      <h1 id="entry-title" className="entry__title">
        Map what’s wrong with <em>any page</em>.
      </h1>
      <p className="entry__lede">
        Paste a public URL. Lighthouse, axe, Yellow Lab and WPA’s own browser checks run against it, and the findings come back
        as a map you can explore.
      </p>

      <form className="scan-form" onSubmit={submitWithEnter} noValidate>
        <label htmlFor={urlId} className="visually-hidden">
          Website URL
        </label>
        <div className="scan-form__row">
          <input
            id={urlId}
            className="scan-form__input"
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error?.code === 'URL_NOT_ALLOWED' || undefined}
            required
          />
          <div className="scan-form__action" ref={buttonSlot}>
            <ActionButton
              label="Scan"
              pendingLabel="Starting"
              successLabel="Queued"
              resetAfterMs={0}
              disabled={!ready}
              onAction={() => onSubmit(normalizeInputUrl(url))}
            />
          </div>
        </div>

        <div className="scan-form__consent">
          <input id={consentId} type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          <label htmlFor={consentId}>
            I own this site or I’m authorized to test it, and I accept responsibility for this scan.{' '}
            <a href="/terms">Terms</a>
          </label>
        </div>

        {error && (
          <p id={errorId} className="scan-form__error" role="alert">
            {error.message}
            {error.code === 'HOST_COOLDOWN' && (wait > 0 ? ` Try again in ${formatWait(wait)}.` : ' You can try again now.')}
          </p>
        )}

        <p className="scan-form__note">Your URL is also sent to Yellow Lab Tools, a third-party service. No account, no cookies.</p>
      </form>
    </section>
  );
}
