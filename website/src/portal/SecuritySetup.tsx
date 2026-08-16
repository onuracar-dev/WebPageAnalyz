import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { apiFetch, jsonRequest } from './api';

export default function SecuritySetup({ enabled = false, required = false, onComplete }: { enabled?: boolean; required?: boolean; onComplete?: () => void }) {
  const [password, setPassword] = useState('');
  const [uri, setUri] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function enable() {
    setBusy(true); setMessage('');
    try {
      const response = await apiFetch<{ totpURI?: string; backupCodes?: string[]; data?: { totpURI?: string; backupCodes?: string[] } }>('/api/auth/two-factor/enable', jsonRequest('POST', { password, issuer: 'WPA' }));
      const data = response.data || response;
      setUri(data.totpURI || '');
      setBackupCodes(data.backupCodes || []);
    } catch (error) { setMessage(error instanceof Error ? error.message : '2FA setup failed.'); }
    finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setMessage('');
    try {
      await apiFetch('/api/auth/two-factor/verify-totp', jsonRequest('POST', { code, trustDevice: false }));
      setMessage('Two-factor authentication is active.');
      onComplete?.();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The code was not accepted.'); }
    finally { setBusy(false); }
  }

  if (enabled && !uri) return <div className="security-card security-card--enabled"><CheckCircle2 /><div><b>Two-factor authentication enabled</b><p>Your account has an additional authenticator challenge.</p></div></div>;
  return <section className="security-card">
    <ShieldCheck />
    <div className="security-card__body"><span>{required ? 'ADMIN SECURITY REQUIREMENT' : 'ACCOUNT SECURITY'}</span><h2>Protect this account with 2FA</h2><p>{required ? 'Administrator routes stay locked until an authenticator is enrolled and verified.' : 'Use an authenticator app to protect access even if your password is compromised.'}</p>
      {!uri ? <div className="security-inline"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Confirm current password" /><button onClick={enable} disabled={busy || password.length < 8}>{busy ? 'Preparing…' : 'Set up authenticator'}</button></div> : <div className="security-enroll"><div className="security-qr"><QRCodeSVG value={uri} size={148} bgColor="#ffffff" fgColor="#080a08" /></div><div><p>Scan this code, then enter the six-digit code.</p><div className="security-inline"><input inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" /><button onClick={verify} disabled={busy || code.length !== 6}>Verify 2FA</button></div></div></div>}
      {backupCodes.length > 0 && <details><summary>Show recovery codes</summary><code>{backupCodes.join('\n')}</code></details>}
      {message && <p className="security-message" role="status">{message}</p>}
    </div>
  </section>;
}
