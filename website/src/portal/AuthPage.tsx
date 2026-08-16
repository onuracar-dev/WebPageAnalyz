import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { ApiError, apiFetch, jsonRequest } from './api';
import { BrandMark, PortalButtonLink } from './Brand';
import { flushPendingLegalAcceptance, queuePendingLegalAcceptance } from './legalAcceptance';
import { navigate } from './router';
import { normalizeLegalConfig, type PublicLegalConfig } from '../LegalContent';

type AuthMode = 'login' | 'register';

function safeTarget(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function routeAfterLogin(planId?: string | null, target?: string | null) {
  try {
    await apiFetch('/api/v1/admin/me');
    navigate('/admin', true);
    return;
  } catch (requestError) {
    if (['ADMIN_2FA_REQUIRED', 'ADMIN_REAUTH_REQUIRED'].includes((requestError as ApiError).code || '')) {
      navigate('/admin', true);
      return;
    }
    /* Customer sessions are expected to fail the admin role check. */
  }
  const params = new URLSearchParams();
  if (planId && ['signal', 'studio'].includes(planId)) params.set('checkout', planId);
  if (target) params.set('target', target);
  navigate(`/app${params.size ? `?${params}` : ''}`, true);
}

function AuthControl({ label, htmlFor, children, className = '' }: {
  label: string;
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return <div className={`auth-control ${className}`}>
    <label htmlFor={htmlFor}>{label}</label>
    <div className="auth-control__input">{children}</div>
  </div>;
}

export default function AuthPage({ mode }: { mode: AuthMode }) {
  const register = mode === 'register';
  const authParams = new URLSearchParams(window.location.search);
  const selectedPlan = ['signal', 'studio'].includes(authParams.get('plan') || '') ? authParams.get('plan') : null;
  const selectedTarget = safeTarget(authParams.get('target'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [totp, setTotp] = useState('');
  const [twoFactor, setTwoFactor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [legalConfig, setLegalConfig] = useState<PublicLegalConfig | null>(null);
  const [legalLoading, setLegalLoading] = useState(register);
  const [legalError, setLegalError] = useState('');
  const [verificationNotice, setVerificationNotice] = useState('');

  useEffect(() => {
    document.documentElement.classList.add('auth-route');
    document.body.classList.add('auth-route-body');
    return () => {
      document.documentElement.classList.remove('auth-route');
      document.body.classList.remove('auth-route-body');
    };
  }, []);

  useEffect(() => {
    if (!register) return undefined;
    let cancelled = false;
    setLegalLoading(true);
    void apiFetch<PublicLegalConfig>('/api/v1/legal/config')
      .then((result) => { if (!cancelled) setLegalConfig(normalizeLegalConfig(result)); })
      .catch((requestError: unknown) => { if (!cancelled) setLegalError(requestError instanceof Error ? requestError.message : 'Legal configuration is unavailable.'); })
      .finally(() => { if (!cancelled) setLegalLoading(false); });
    return () => { cancelled = true; };
  }, [register]);

  const termsVersion = legalConfig?.documents?.terms?.version;
  const acceptableUseVersion = legalConfig?.documents?.acceptableUse?.version;
  const legalReady = Boolean(legalConfig?.ready && termsVersion && acceptableUseVersion);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (register && !accepted) {
      setError('Please accept the Terms of Service and Acceptable Use Policy.');
      return;
    }
    if (register && !legalReady) {
      setError('Registration is unavailable until the server publishes the active Terms and Acceptable Use versions.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await apiFetch<Record<string, unknown>>(`/api/auth/${register ? 'sign-up' : 'sign-in'}/email`, jsonRequest('POST', register ? { name, email, password } : { email, password }));
      if (!register && (result.twoFactorRedirect || (result.data as Record<string, unknown> | undefined)?.twoFactorRedirect)) {
        setTwoFactor(true);
        return;
      }
      if (register) {
        const data = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : result;
        const user = data.user && typeof data.user === 'object' ? data.user as Record<string, unknown> : null;
        const token = typeof data.token === 'string' ? data.token : (typeof result.token === 'string' ? result.token : '');
        if (token) {
          queuePendingLegalAcceptance(termsVersion || '', acceptableUseVersion || '');
          await flushPendingLegalAcceptance();
        } else {
          queuePendingLegalAcceptance(termsVersion || '', acceptableUseVersion || '');
        }
        if (!token || result.requiresEmailVerification === true || data.requiresEmailVerification === true || user?.emailVerified === false) {
          setVerificationNotice(token
            ? 'Account created and legal acceptance recorded. Check your inbox and verify your email address before continuing.'
            : 'Account created. Check your inbox and verify your email address; the accepted Terms and Acceptable Use versions will be recorded as soon as the verified session begins.');
          return;
        }
      }
      if (!register) await flushPendingLegalAcceptance();
      await routeAfterLogin(selectedPlan, selectedTarget);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyTwoFactor(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/auth/two-factor/verify-totp', jsonRequest('POST', { code: totp, trustDevice: false }));
      await flushPendingLegalAcceptance();
      await routeAfterLogin(null, selectedTarget);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The code could not be verified.');
    } finally {
      setBusy(false);
    }
  }

  const title = twoFactor ? 'Verify your identity.' : verificationNotice ? 'Verify your email.' : register ? 'Create your account.' : 'Welcome back.';

  return <main className={`auth-page auth-threshold auth-page--${mode}${twoFactor ? ' auth-page--two-factor' : ''}`}>
    <header className="auth-threshold__header">
      <BrandMark />
      <span>{twoFactor ? '02 / VERIFY' : register ? '01 / CREATE' : '01 / ENTER'}</span>
    </header>

    <section className="auth-threshold__intro" aria-labelledby="auth-title">
      <h1 id="auth-title">{title}</h1>
    </section>

    {verificationNotice ? <section className="auth-form auth-threshold__form auth-threshold__form--verify" aria-live="polite"><div className="auth-verification-notice" role="status"><strong>Account created.</strong><p>{verificationNotice}</p><PortalButtonLink href="/verify-email">Open email verification</PortalButtonLink><PortalButtonLink href="/login">Return to sign in</PortalButtonLink></div></section> : twoFactor ? <form className="auth-form auth-threshold__form auth-threshold__form--verify" onSubmit={verifyTwoFactor} aria-busy={busy}>
      <AuthControl label="Authenticator code" htmlFor="totp">
        <input
          id="totp"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={totp}
          onChange={(event) => setTotp(event.target.value.replace(/\D/g, ''))}
          placeholder="000000"
          required
        />
      </AuthControl>
      <button className="auth-submit" disabled={busy || totp.length !== 6}>{busy ? 'Verifying…' : 'Verify and continue'}</button>
      <div className="auth-form__below">
        <p>Enter the six-digit code from your authenticator app.</p>
        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>
    </form> : <form className={`auth-form auth-threshold__form auth-threshold__form--${mode}`} onSubmit={submit} aria-busy={busy}>
      {register && <AuthControl label="Full name" htmlFor="name">
        <input id="name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" minLength={2} maxLength={100} required />
      </AuthControl>}

      <AuthControl label={register ? 'Work email' : 'Email address'} htmlFor="email">
        <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={register ? 'name@company.com' : 'you@company.com'} maxLength={254} required />
      </AuthControl>

      <AuthControl label="Password" htmlFor="password" className="auth-control--password">
        <input id="password" type={showPassword ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={register ? 'At least 8 characters' : 'Enter your password'} minLength={8} maxLength={128} required />
        <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff /> : <Eye />}</button>
      </AuthControl>

      <button className="auth-submit" disabled={busy || (register && (legalLoading || !legalReady))}>{busy ? 'Please wait…' : register && legalLoading ? 'Loading legal versions…' : register ? 'Create account' : 'Sign in'}</button>

      <div className="auth-form__below">
        <div className="auth-form__meta">
          {register ? <label className="auth-consent">
            <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} required aria-describedby="registration-privacy-notice" />
            <span>I agree to the <a href="/terms">Terms of Service</a> and <a href="/acceptable-use">Acceptable Use Policy</a>.</span>
          </label> : <div className="auth-forgot-links"><a className="auth-forgot" href="/forgot-password">Forgot password?</a><a href="mailto:onuracar.work@gmail.com?subject=WPA%20password%20support">Need support?</a></div>}
          {register && <p id="registration-privacy-notice" className="auth-privacy-notice">We use account data to create and secure your workspace. Read the <a href="/privacy">Privacy Notice</a> and <a href="/kvkk">KVKK Aydınlatma Metni</a>. These notices are not consent checkboxes.</p>}
          {register && legalError && <div className="auth-error" role="alert">{legalError}</div>}
          <p className="auth-switch">{register ? 'Already have an account?' : 'New to WPA?'} <PortalButtonLink href={`${register ? '/login' : '/register'}${window.location.search}`}>{register ? 'Sign in' : 'Create account'}</PortalButtonLink></p>
        </div>
        {error && <div className="auth-error" role="alert">{error}</div>}
      </div>
    </form>}
  </main>;
}
