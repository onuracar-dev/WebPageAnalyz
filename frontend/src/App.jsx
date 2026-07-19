import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Clock3, Download, History, Loader2, Printer, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { apiRequest } from './api.js'
import { createHistoryEntry, loadHistory, reportFileName, saveHistory, serializeReport } from './history.js'

const ReportDashboard = lazy(() => import('./components/ReportDashboard.jsx'))

function App() {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [history, setHistory] = useState(() => loadHistory(localStorage))
  const [currentId, setCurrentId] = useState(() => loadHistory(localStorage)[0]?.id || null)
  const [solving, setSolving] = useState({})
  const [generatingSummary, setGeneratingSummary] = useState(false)

  const currentEntry = useMemo(
    () => history.find((entry) => entry.id === currentId) || null,
    [history, currentId],
  )

  useEffect(() => {
    saveHistory(localStorage, history)
    if (currentId && !history.some((entry) => entry.id === currentId)) setCurrentId(history[0]?.id || null)
  }, [history, currentId])

  function updateCurrent(updater) {
    setHistory((entries) => entries.map((entry) => entry.id === currentId ? updater(entry) : entry))
  }

  async function handleAnalyze(event) {
    event.preventDefault()
    const value = url.trim()
    if (!value) return
    const targetUrl = /^https?:\/\//i.test(value) ? value : `https://${value}`
    setLoading(true)
    setError(null)
    try {
      const data = await apiRequest('/api/analyze', {
        method: 'POST',
        timeoutMs: 255_000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      })
      const entry = createHistoryEntry(data.url || targetUrl, data.report)
      setHistory((entries) => [entry, ...entries.filter((item) => item.url !== entry.url)].slice(0, 10))
      setCurrentId(entry.id)
      setUrl(entry.url)
      setSolving({})
    } catch (requestError) {
      setError({
        message: requestError.message,
        requestId: requestError.requestId,
      })
    } finally {
      setLoading(false)
    }
  }

  async function handleSolveIssue(issue) {
    if (!currentEntry) return
    const issueKey = `${issue.source}:${issue.id}`
    if (solving[issueKey]) return
    setSolving((value) => ({ ...value, [issueKey]: true }))
    try {
      const issuePayload = {
        title: issue.title,
        description: issue.description || '',
        source: issue.source || 'Unknown',
        ...(issue.id ? { id: issue.id } : {}),
        ...(issue.snippet ? { snippet: issue.snippet } : {}),
        ...(issue.displayValue ? { displayValue: issue.displayValue } : {}),
        ...(Number.isFinite(issue.score) ? { score: issue.score } : {}),
      }
      const data = await apiRequest('/api/solve', {
        method: 'POST',
        timeoutMs: 50_000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue: issuePayload }),
      })
      updateCurrent((entry) => ({
        ...entry,
        solutions: { ...entry.solutions, [issueKey]: data.solution },
      }))
    } catch (requestError) {
      setError({ message: requestError.message, requestId: requestError.requestId })
    } finally {
      setSolving((value) => ({ ...value, [issueKey]: false }))
    }
  }

  async function handleGenerateSummary() {
    if (!currentEntry?.report?.scores) return
    setGeneratingSummary(true)
    setError(null)
    try {
      const data = await apiRequest('/api/executive-summary', {
        method: 'POST',
        timeoutMs: 50_000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scores: currentEntry.report.scores }),
      })
      updateCurrent((entry) => ({ ...entry, executiveSummary: data.summary }))
    } catch (requestError) {
      setError({ message: requestError.message, requestId: requestError.requestId })
    } finally {
      setGeneratingSummary(false)
    }
  }

  function exportJson() {
    if (!currentEntry) return
    const blob = new Blob([serializeReport(currentEntry)], { type: 'application/json' })
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = reportFileName(currentEntry.url, currentEntry.createdAt)
    anchor.click()
    URL.revokeObjectURL(objectUrl)
  }

  function removeCurrent() {
    if (!currentEntry || !window.confirm('Bu raporu geçmişten silmek istediğinize emin misiniz?')) return
    setHistory((entries) => entries.filter((entry) => entry.id !== currentEntry.id))
  }

  return (
    <div className="container">
      <header className="hero">
        <div className="eyebrow"><ShieldCheck size={18} /> Güvenli web kalite denetimi</div>
        <h1>WebPage Analyzer AI</h1>
        <p>Performans, SEO, erişilebilirlik ve en iyi pratikleri tek raporda inceleyin.</p>
      </header>

      <main>
        <section className="glass-panel audit-panel" aria-labelledby="audit-title">
          <h2 id="audit-title" className="sr-only">Yeni analiz</h2>
          <form onSubmit={handleAnalyze} className="input-group">
            <label className="sr-only" htmlFor="target-url">Analiz edilecek web sitesi</label>
            <input
              id="target-url"
              type="text"
              inputMode="url"
              autoComplete="url"
              placeholder="example.com"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={loading}
              required
            />
            <button type="submit" disabled={loading || !url.trim()}>
              {loading ? <><Loader2 size={20} className="icon-spin" /> Analiz ediliyor</> : <><Search size={20} /> Analiz et</>}
            </button>
          </form>

          {history.length > 0 && (
            <div className="history-bar">
              <History size={18} aria-hidden="true" />
              <label htmlFor="report-history">Rapor geçmişi</label>
              <select id="report-history" value={currentId || ''} onChange={(event) => setCurrentId(event.target.value)}>
                {history.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {new URL(entry.url).hostname} · {new Date(entry.createdAt).toLocaleString('tr-TR')}
                  </option>
                ))}
              </select>
              <button type="button" className="button-secondary button-icon" onClick={exportJson} title="JSON indir">
                <Download size={18} /><span>JSON</span>
              </button>
              <button type="button" className="button-secondary button-icon" onClick={() => window.print()} title="PDF olarak yazdır">
                <Printer size={18} /><span>PDF</span>
              </button>
              <button type="button" className="button-danger button-icon" onClick={removeCurrent} title="Seçili raporu sil">
                <Trash2 size={18} /><span>Sil</span>
              </button>
            </div>
          )}

          {error && (
            <div className="error-box" role="alert">
              <strong>İstek tamamlanamadı:</strong> {error.message}
              {error.requestId && <small>Destek kodu: {error.requestId}</small>}
            </div>
          )}
        </section>

        {loading && (
          <section className="glass-panel loader-container" aria-live="polite">
            <Loader2 size={48} className="icon-spin" />
            <h2>Kapsamlı analiz çalışıyor</h2>
            <p>Lighthouse, YellowLab ve Axe denetimleri birkaç dakika sürebilir.</p>
          </section>
        )}

        {!loading && currentEntry && (
          <>
            <div className="report-context">
              <span><Clock3 size={16} /> {new Date(currentEntry.createdAt).toLocaleString('tr-TR')}</span>
              <a href={currentEntry.url} target="_blank" rel="noopener noreferrer">{currentEntry.url}</a>
            </div>
            <Suspense fallback={<div className="glass-panel loader-container"><Loader2 className="icon-spin" /> Rapor yükleniyor…</div>}>
              <ReportDashboard
                entry={currentEntry}
                solving={solving}
                generatingSummary={generatingSummary}
                onSolve={handleSolveIssue}
                onGenerateSummary={handleGenerateSummary}
              />
            </Suspense>
          </>
        )}
      </main>

      <footer>
        <p>Open-source bir proje · <a href="https://github.com/onuracar-dev/WebPageAnalyz" target="_blank" rel="noopener noreferrer">GitHub</a></p>
      </footer>
    </div>
  )
}

export default App
