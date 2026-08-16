import { useEffect, useState } from 'react'
import { FolderPlus, Play, RefreshCw, ShieldCheck } from 'lucide-react'
import { apiRequest } from '../api.js'

export default function SaasWorkspace() {
  const [workspace, setWorkspace] = useState(null)
  const [projects, setProjects] = useState([])
  const [reports, setReports] = useState([])
  const [name, setName] = useState('My website')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function refresh() {
    const [workspaceData, projectData, reportData] = await Promise.all([
      apiRequest('/api/v1/workspace'),
      apiRequest('/api/v1/projects'),
      apiRequest('/api/v1/reports'),
    ])
    setWorkspace(workspaceData)
    setProjects(projectData.projects)
    setReports(reportData.reports)
  }

  useEffect(() => {
    const reload = () => refresh().catch(() => {})
    reload()
    window.addEventListener('wpa-auth-changed', reload)
    return () => window.removeEventListener('wpa-auth-changed', reload)
  }, [])

  async function createProject(event) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const targetUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`
      const data = await apiRequest('/api/v1/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url: targetUrl, locale: 'tr' }),
      })
      await apiRequest(`/api/v1/projects/${data.project.id}/verify-target`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'operator' }),
      })
      setUrl('')
      setMessage('Proje oluşturuldu ve geliştirme ortamında doğrulandı.')
      await refresh()
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }

  async function startScan(projectId) {
    setBusy(true)
    setMessage('')
    try {
      const data = await apiRequest('/api/v1/scans', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, locale: 'tr' }),
      })
      setMessage(`Tarama kuyruğa alındı: ${data.scan.id}`)
      await refresh()
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }

  return (
    <section className="glass-panel workspace-panel" aria-labelledby="workspace-title">
      <div className="workspace-heading">
        <div><span className="eyebrow"><ShieldCheck size={16} /> SaaS workspace</span><h2 id="workspace-title">Projeler ve plan kullanımı</h2></div>
        <button type="button" className="button-secondary" onClick={() => refresh().catch(() => {})}><RefreshCw size={16} /> Yenile</button>
      </div>
      {workspace && <div className="workspace-stats">
        <span><b>{workspace.plan.name}</b><small>aktif plan</small></span>
        <span><b>{workspace.usage.consumed + workspace.usage.reserved} / {workspace.plan.limits.pageCredits}</b><small>aylık sayfa kredisi</small></span>
        <span><b>{projects.length} / {workspace.plan.limits.projects}</b><small>proje</small></span>
        <span><b>{reports.length}</b><small>sunucu raporu</small></span>
      </div>}
      <form className="workspace-form" onSubmit={createProject}>
        <input aria-label="Proje adı" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
        <input aria-label="Proje URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="example.com" required />
        <button disabled={busy}><FolderPlus size={17} /> Proje ekle</button>
      </form>
      {message && <p className="workspace-message" role="status">{message}</p>}
      {projects.length > 0 && <div className="workspace-projects">{projects.map((project) => (
        <article key={project.id}><div><b>{project.name}</b><small>{project.origin}</small></div><span>{project.verifiedAt ? 'Doğrulandı' : 'Doğrulanmadı'}</span><button type="button" disabled={busy || !project.verifiedAt} onClick={() => startScan(project.id)}><Play size={15} /> Tara</button></article>
      ))}</div>}
    </section>
  )
}
