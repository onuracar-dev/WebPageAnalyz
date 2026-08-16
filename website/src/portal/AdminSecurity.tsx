import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, Copy, Fingerprint, KeyRound, RefreshCw, ShieldAlert, ShieldCheck, Trash2, UserCog } from 'lucide-react';
import { apiFetch, jsonRequest } from './api';
import { authClient } from './authClient';
import './admin-security.css';

type Passkey = {
  id: string;
  name?: string | null;
  deviceType?: string | null;
  backedUp?: boolean;
  transports?: string | null;
  createdAt?: string;
  lastUsedAt?: string | null;
};

type SecurityActivity = {
  id: string;
  action: string;
  actorId?: string | null;
  entityId?: string | null;
  reason?: string | null;
  createdAt: string;
};

type SecurityStatus = {
  role: string;
  permissions: string[];
  policy: {
    webAuthnRequired: boolean;
    minimumCredentials: number;
    recommendedCredentials: number;
    stepUpMaxAgeSeconds: number;
  };
  passkeys: Passkey[];
  recoveryCodesRemaining: number;
  recentStepUp?: { method: string; verifiedAt: string; expiresAt: string } | null;
  recentActivity: SecurityActivity[];
};

type AdminAccount = {
  userId: string;
  email: string;
  role: 'super_admin' | 'admin' | 'moderator' | 'support';
  active: boolean;
  webAuthnCredentialCount: number;
  recoveryCodesRemaining: number;
  lastAccessAt?: string | null;
};

const ADMIN_ROLES: AdminAccount['role'][] = ['support', 'moderator', 'admin', 'super_admin'];

function time(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unknown' : date.toLocaleString();
}

function clientError(result: { error?: { message?: string } | null }, fallback: string) {
  return result.error?.message || fallback;
}

export default function AdminSecurity({ permissions }: { permissions: string[] }) {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [passkeyName, setPasskeyName] = useState('Primary security key');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryTotp, setRecoveryTotp] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [targetUserId, setTargetUserId] = useState('');
  const [targetRole, setTargetRole] = useState<AdminAccount['role']>('support');
  const [targetActive, setTargetActive] = useState(true);

  const canReadAdmins = permissions.includes('security.admins.read');
  const canManageAdmins = permissions.includes('security.admins.manage');
  const canResetMfa = permissions.includes('security.mfa.manage');
  const hasPasskey = Boolean(status?.passkeys.length);
  const confirmedReason = reason.trim().length >= 3 && confirmed;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const security = await apiFetch<SecurityStatus>('/api/v1/admin/security/status');
      setStatus(security);
      if (canReadAdmins) {
        const result = await apiFetch<{ admins: AdminAccount[] }>('/api/v1/admin/security/admins');
        setAdmins(result.admins || []);
      } else setAdmins([]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Security state could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [canReadAdmins]);

  useEffect(() => { void load(); }, [load]);

  const stepUp = useCallback(async () => {
    const result = await authClient.signIn.passkey();
    if (result.error) throw new Error(clientError(result, 'The passkey assertion was not accepted.'));
    await apiFetch('/api/v1/admin/security/step-up/webauthn', jsonRequest('POST', {}));
  }, []);

  async function addPasskey(event: FormEvent) {
    event.preventDefault();
    setBusy('add-passkey'); setError(''); setMessage(''); setRecoveryCodes([]);
    try {
      if (hasPasskey) await stepUp();
      else await apiFetch('/api/v1/admin/reauth', jsonRequest('POST', { password, totpCode }));
      const result = await authClient.passkey.addPasskey({ name: passkeyName.trim() || 'Security key' });
      if (result.error) throw new Error(clientError(result, 'The passkey could not be registered.'));
      setPassword(''); setTotpCode('');
      setMessage('Passkey registered. Add a second independent credential before relying on recovery codes.');
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The passkey could not be registered.');
    } finally { setBusy(''); }
  }

  async function removePasskey(passkey: Passkey) {
    if (!window.confirm(`Remove passkey “${passkey.name || passkey.id}”? The final required credential cannot be removed.`)) return;
    setBusy(`remove:${passkey.id}`); setError(''); setMessage('');
    try {
      await stepUp();
      await apiFetch('/api/auth/passkey/delete-passkey', jsonRequest('POST', { id: passkey.id }));
      setMessage('Passkey removed and the security event was recorded.');
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The passkey could not be removed.');
    } finally { setBusy(''); }
  }

  async function generateRecoveryCodes() {
    if (!confirmedReason) return;
    setBusy('recovery-codes'); setError(''); setMessage(''); setRecoveryCodes([]);
    try {
      await stepUp();
      const result = await apiFetch<{ codes: string[] }>('/api/v1/admin/security/recovery-codes', jsonRequest('POST', { reason: reason.trim(), confirm: true }));
      setRecoveryCodes(result.codes || []);
      setMessage('These codes are shown once. Store them offline; generating another set invalidates every code below.');
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Recovery codes could not be generated.');
    } finally { setBusy(''); }
  }

  async function useRecoveryCode(event: FormEvent) {
    event.preventDefault();
    setBusy('recovery-use'); setError(''); setMessage(''); setRecoveryCodes([]);
    try {
      await apiFetch('/api/v1/admin/security/recovery/use', jsonRequest('POST', {
        code: recoveryCode.trim().toUpperCase(), password: recoveryPassword, totpCode: recoveryTotp, confirm: true,
      }));
      setRecoveryCode(''); setRecoveryPassword(''); setRecoveryTotp('');
      setMessage('Recovery accepted. Other sessions were revoked; enroll a replacement passkey now.');
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Recovery verification failed.');
    } finally { setBusy(''); }
  }

  async function changeAdmin(event: FormEvent) {
    event.preventDefault();
    if (!canManageAdmins || !targetUserId.trim() || !confirmedReason) return;
    setBusy('role-change'); setError(''); setMessage('');
    try {
      await stepUp();
      await apiFetch(`/api/v1/admin/security/admins/${encodeURIComponent(targetUserId.trim())}`, jsonRequest('PUT', {
        role: targetRole, active: targetActive, reason: reason.trim(), confirm: true,
      }));
      setMessage('Privileged access changed. Existing target sessions and stale step-up markers were revoked.');
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Privileged access could not be changed.');
    } finally { setBusy(''); }
  }

  async function resetMfa(account: AdminAccount) {
    if (!canResetMfa || !confirmedReason || !window.confirm(`Reset every MFA credential and session for ${account.email}?`)) return;
    setBusy(`mfa:${account.userId}`); setError(''); setMessage('');
    try {
      await stepUp();
      await apiFetch(`/api/v1/admin/security/admins/${encodeURIComponent(account.userId)}/mfa-reset`, jsonRequest('POST', { reason: reason.trim(), confirm: true }));
      setMessage('MFA reset completed. The target must enroll credentials again.');
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'MFA could not be reset.');
    } finally { setBusy(''); }
  }

  const recoveryText = useMemo(() => recoveryCodes.join('\n'), [recoveryCodes]);

  if (loading && !status) return <div className="portal-loading"><i />Loading privileged security state</div>;

  return <section className="admin-security">
    <header className="admin-security__hero"><div><span>PRIVILEGED ACCESS / FAIL CLOSED</span><h2>Admin security</h2><p>Read-only navigation stays available. Passkey verification is requested only when a critical operation crosses the step-up boundary.</p></div><button type="button" onClick={() => void load()} disabled={loading}><RefreshCw /> Refresh</button></header>
    {error && <div className="portal-alert" role="alert">{error}</div>}
    {message && <div className="admin-security__success" role="status"><CheckCircle2 />{message}</div>}

    <div className="admin-security__summary">
      <div><span>ROLE</span><strong>{status?.role.replaceAll('_', ' ')}</strong></div>
      <div><span>PASSKEYS</span><strong>{status?.passkeys.length || 0} / {status?.policy.recommendedCredentials || 2}</strong></div>
      <div><span>RECOVERY CODES</span><strong>{status?.recoveryCodesRemaining || 0}</strong></div>
      <div><span>STEP-UP</span><strong>{status?.recentStepUp ? `${status.recentStepUp.method} · until ${time(status.recentStepUp.expiresAt)}` : 'Not active'}</strong></div>
    </div>

    <article className="admin-security__panel">
      <header><Fingerprint /><div><span>WEBAUTHN CREDENTIALS</span><h3>Passkeys and security keys</h3><p>Use phishing-resistant credentials. Two independent devices are recommended so one lost device does not become an outage.</p></div></header>
      <div className="admin-security__credentials">{status?.passkeys.length ? status.passkeys.map((passkey) => <div key={passkey.id}><Fingerprint /><span><b>{passkey.name || 'Unnamed passkey'}</b><small>{passkey.deviceType || 'authenticator'} · created {time(passkey.createdAt)} · last used {time(passkey.lastUsedAt)}</small></span><em>{passkey.backedUp ? 'BACKED UP' : 'SINGLE DEVICE'}</em><button type="button" className="is-danger" disabled={Boolean(busy)} onClick={() => void removePasskey(passkey)}><Trash2 /> {busy === `remove:${passkey.id}` ? 'Removing…' : 'Remove'}</button></div>) : <p className="empty-state">No passkey is enrolled. Critical production mutations remain blocked until the first credential is added.</p>}</div>
      <form className="admin-security__form" onSubmit={addPasskey}>
        <label><span>Credential name</span><input value={passkeyName} onChange={(event) => setPasskeyName(event.target.value)} maxLength={80} required /></label>
        {!hasPasskey && <><label><span>Current password</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label><span>Authenticator code</span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ''))} required /></label></>}
        <button disabled={Boolean(busy) || (!hasPasskey && (password.length < 8 || totpCode.length !== 6))}>{busy === 'add-passkey' ? 'Waiting for authenticator…' : hasPasskey ? 'Verify and add another passkey' : 'Verify and add first passkey'}</button>
      </form>
    </article>

    <article className="admin-security__panel">
      <header><KeyRound /><div><span>BREAK-GLASS RECOVERY</span><h3>One-time recovery codes</h3><p>Codes are hashed at rest and shown only in the creation response. A used code cannot be replayed and recovery revokes other sessions.</p></div></header>
      <div className="admin-security__reason"><label><span>Required audit reason</span><input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Why is this privileged change required?" /></label><label className="admin-security__confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirm this intentional privileged operation.</span></label></div>
      <button type="button" disabled={Boolean(busy) || !hasPasskey || !confirmedReason} onClick={() => void generateRecoveryCodes()}>{busy === 'recovery-codes' ? 'Waiting for passkey…' : 'Rotate and show recovery codes once'}</button>
      {recoveryCodes.length > 0 && <div className="admin-security__codes" aria-live="polite"><div><b>Copy now — this panel will not be restored after leaving or refreshing.</b><button type="button" onClick={() => void navigator.clipboard.writeText(recoveryText)}><Copy /> Copy all</button></div><pre>{recoveryText}</pre></div>}
      <form className="admin-security__form admin-security__form--recovery" onSubmit={useRecoveryCode}>
        <label><span>Recovery code</span><input autoComplete="one-time-code" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" required /></label>
        <label><span>Current password</span><input type="password" autoComplete="current-password" value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} required /></label>
        <label><span>Authenticator code</span><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={recoveryTotp} onChange={(event) => setRecoveryTotp(event.target.value.replace(/\D/g, ''))} required /></label>
        <button disabled={Boolean(busy) || recoveryPassword.length < 8 || recoveryTotp.length !== 6}>{busy === 'recovery-use' ? 'Recovering…' : 'Use one-time recovery code'}</button>
      </form>
    </article>

    {canReadAdmins && <article className="admin-security__panel">
      <header><UserCog /><div><span>PRIVILEGED IDENTITIES</span><h3>Role and credential register</h3><p>Roles are finite and server-authoritative. Deactivating or changing a role revokes target sessions; the final active super administrator cannot be removed.</p></div></header>
      <div className="admin-security__admins">{admins.map((account) => <div key={account.userId}><ShieldCheck /><span><b>{account.email}</b><small>{account.userId} · last access {time(account.lastAccessAt)}</small></span><em>{account.active ? account.role.replaceAll('_', ' ') : 'inactive'}</em><small>{account.webAuthnCredentialCount} passkey · {account.recoveryCodesRemaining} codes</small>{canResetMfa && <button type="button" className="is-danger" disabled={Boolean(busy) || !confirmedReason} onClick={() => void resetMfa(account)}>{busy === `mfa:${account.userId}` ? 'Resetting…' : 'Reset MFA'}</button>}</div>)}</div>
      {canManageAdmins && <form className="admin-security__form" onSubmit={changeAdmin}>
        <label><span>Exact user ID</span><input value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)} placeholder="Immutable registered user ID" required /></label>
        <label><span>Role</span><select value={targetRole} onChange={(event) => setTargetRole(event.target.value as AdminAccount['role'])}>{ADMIN_ROLES.map((role) => <option key={role} value={role}>{role.replaceAll('_', ' ')}</option>)}</select></label>
        <label className="admin-security__confirm"><input type="checkbox" checked={targetActive} onChange={(event) => setTargetActive(event.target.checked)} /><span>Privileged account active</span></label>
        <button disabled={Boolean(busy) || !targetUserId.trim() || !confirmedReason}>{busy === 'role-change' ? 'Waiting for passkey…' : 'Verify and apply role change'}</button>
      </form>}
    </article>}

    <article className="admin-security__panel">
      <header><ShieldAlert /><div><span>RECENT SECURITY ACTIVITY</span><h3>Your security trail</h3><p>Only security events involving this privileged identity are shown here.</p></div></header>
      <div className="admin-security__activity">{status?.recentActivity.length ? status.recentActivity.map((item) => <div key={item.id}><span>{item.action.replaceAll('.', ' / ').replaceAll('_', ' ')}</span><small>{time(item.createdAt)}{item.reason ? ` · ${item.reason}` : ''}</small></div>) : <p className="empty-state">No recent security activity was recorded for this identity.</p>}</div>
    </article>
  </section>;
}
