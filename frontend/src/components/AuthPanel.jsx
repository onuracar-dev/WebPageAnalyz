import { useEffect, useState } from 'react'
import { LogIn, LogOut, UserPlus } from 'lucide-react'
import { apiRequest } from '../api.js'

export default function AuthPanel() {
  const [session, setSession] = useState(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')

  async function refresh() {
    try { setSession(await apiRequest('/api/auth/get-session')) } catch { setSession(null) }
  }
  useEffect(() => {
    let active = true
    apiRequest('/api/auth/get-session')
      .then((data) => { if (active) setSession(data) })
      .catch(() => { if (active) setSession(null) })
    return () => { active = false }
  }, [])

  async function submit(kind) {
    setMessage('')
    try {
      await apiRequest(`/api/auth/${kind}/email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'sign-up' ? { name, email, password } : { email, password }),
      })
      await refresh()
      window.dispatchEvent(new Event('wpa-auth-changed'))
    } catch (error) { setMessage(error.message) }
  }

  async function signOut() {
    await apiRequest('/api/auth/sign-out', { method: 'POST' })
    setSession(null)
    window.dispatchEvent(new Event('wpa-auth-changed'))
  }

  return <details className="glass-panel auth-panel">
    <summary><LogIn size={17} /> {session?.user ? `${session.user.name || session.user.email} olarak giriş yapıldı` : 'Hesap girişi'}</summary>
    {session?.user ? <button type="button" className="button-secondary" onClick={signOut}><LogOut size={16} /> Çıkış yap</button> : <div className="auth-form">
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ad (kayıt için)" />
      <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="E-posta" />
      <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} placeholder="Şifre" />
      <button type="button" onClick={() => submit('sign-in')}><LogIn size={16} /> Giriş</button>
      <button type="button" className="button-secondary" onClick={() => submit('sign-up')}><UserPlus size={16} /> Kayıt</button>
    </div>}
    {message && <p className="workspace-message">{message}</p>}
  </details>
}
