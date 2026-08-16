import { useState } from 'react'
import { CheckCircle2, KeyRound, RefreshCw } from 'lucide-react'
import { apiRequest } from '../api.js'

export default function AdminPanel() {
  const [key, setKey] = useState(() => sessionStorage.getItem('wpa-admin-key') || '')
  const [tasks, setTasks] = useState([])
  const [message, setMessage] = useState('')

  async function loadTasks() {
    setMessage('')
    try {
      sessionStorage.setItem('wpa-admin-key', key)
      const data = await apiRequest('/api/v1/admin/operator-tasks?status=pending', { headers: { 'X-API-Key': key } })
      setTasks(data.tasks)
    } catch (error) { setMessage(error.message) }
  }

  async function complete(task) {
    try {
      await apiRequest(`/api/v1/admin/operator-tasks/${task.id}/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({ notes: 'Reviewed in the operator console.' }),
      })
      await loadTasks()
    } catch (error) { setMessage(error.message) }
  }

  return <details className="glass-panel admin-panel">
    <summary><KeyRound size={17} /> Operator console</summary>
    <div className="admin-auth"><input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="Admin API key" /><button type="button" onClick={loadTasks}><RefreshCw size={16} /> Kuyruğu aç</button></div>
    {message && <p className="workspace-message">{message}</p>}
    <div className="admin-tasks">{tasks.map((task) => <article key={task.id}><span><b>{task.moduleId}</b><small>{task.scanId} · {task.workspaceId}</small></span><time>{task.dueAt ? new Date(task.dueAt).toLocaleDateString('tr-TR') : '—'}</time><button type="button" onClick={() => complete(task)}><CheckCircle2 size={15} /> Tamamla</button></article>)}</div>
  </details>
}
