import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Accessibility, Activity, CheckCircle2, Cpu, Laptop, Loader2, Search, Smartphone, Sparkles, Zap } from 'lucide-react'
import ScoreCard from './ScoreCard.jsx'
import { availableReportDevices, hasCompleteScores, reportIssuesForDevice, reportScoresForDevice } from '../report.js'

const tabs = [
  { id: 'overview', title: 'Genel Bakış', icon: Cpu },
  { id: 'performance', title: 'Performans', icon: Zap },
  { id: 'seo', title: 'SEO', icon: Search },
  { id: 'accessibility', title: 'Erişilebilirlik', icon: Accessibility },
  { id: 'bestPractices', title: 'En İyi Pratikler', icon: Activity },
]

const markdownComponents = {
  a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
  img: () => null,
}

function IssueCard({ issue, solution, solving, onSolve }) {
  return (
    <article className="issue-card">
      <div className="issue-header">
        <h3 className="issue-title">{issue.title}</h3>
        <span className="issue-badge">{issue.source}</span>
      </div>
      <div className="issue-desc"><ReactMarkdown components={markdownComponents}>{issue.description}</ReactMarkdown></div>
      {issue.displayValue && <p className="issue-impact"><strong>Etki:</strong> {issue.displayValue}</p>}
      {issue.snippet && <pre className="snippet-box"><code>{issue.snippet}</code></pre>}
      {!solution ? (
        <button type="button" className="solve-btn" onClick={() => onSolve(issue)} disabled={solving}>
          {solving ? <Loader2 size={16} className="icon-spin" /> : <Sparkles size={16} />}
          {solving ? 'Çözüm üretiliyor' : 'AI ile çöz'}
        </button>
      ) : (
        <div className="solution-box">
          <div className="solution-header"><CheckCircle2 size={18} /> AI çözüm önerisi</div>
          <div className="markdown-body"><ReactMarkdown components={markdownComponents}>{solution}</ReactMarkdown></div>
        </div>
      )}
    </article>
  )
}

export default function ReportDashboard({ entry, solving, generatingSummary, onSolve, onGenerateSummary }) {
  const [activeTab, setActiveTab] = useState('overview')
  const [activeDevice, setActiveDevice] = useState('desktop')
  const { report, solutions } = entry
  const devices = availableReportDevices(report)
  const selectedDevice = devices.includes(activeDevice) ? activeDevice : devices[0] || 'desktop'
  const scores = reportScoresForDevice(report, selectedDevice)
  const category = activeTab === 'overview' ? [] : reportIssuesForDevice(report, activeTab, selectedDevice)
  const executiveSummary = entry.executiveSummaries?.[selectedDevice]
    || (selectedDevice === 'desktop' ? entry.executiveSummary : null)
  const summaryAvailable = hasCompleteScores(report, selectedDevice)

  return (
    <section className="glass-panel report-panel" id="report-container">
      {devices.length > 1 && (
        <div className="device-switcher" role="group" aria-label="Lighthouse cihaz profili">
          <button type="button" className={selectedDevice === 'desktop' ? 'active' : ''} onClick={() => setActiveDevice('desktop')}>
            <Laptop size={17} /> Desktop
          </button>
          <button type="button" className={selectedDevice === 'mobile' ? 'active' : ''} onClick={() => setActiveDevice('mobile')}>
            <Smartphone size={17} /> Mobile
          </button>
        </div>
      )}
      <div className="tabs-header" role="tablist" aria-label="Rapor kategorileri">
        {tabs.map((tab) => {
          const TabIcon = tab.icon
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <TabIcon size={18} /> {tab.title}{tab.id !== 'overview' ? ` (${reportIssuesForDevice(report, tab.id, selectedDevice).length})` : ''}
            </button>
          )
        })}
      </div>

      {activeTab === 'overview' ? (
        <div>
          <div className="score-cards">
            <ScoreCard title="Performans" score={scores.performance} icon={<Zap />} />
            <ScoreCard title="SEO" score={scores.seo} icon={<Search />} />
            <ScoreCard title="Erişilebilirlik" score={scores.accessibility} icon={<Accessibility />} />
            <ScoreCard title="En İyi Pratikler" score={scores.bestPractices} icon={<Activity />} />
          </div>
          {report.meta?.analyzers && (
            <div className="analyzer-status">
              {Object.entries(report.meta.analyzers).map(([name, status]) => (
                <span key={name} className={status === 'completed' ? 'status-ok' : 'status-warning'}>
                  {name}: {status}{report.meta.analyzerErrors?.[name] ? ` (${report.meta.analyzerErrors[name]})` : ''}
                </span>
              ))}
            </div>
          )}
          {!executiveSummary ? (
            <button type="button" className="summary-button" onClick={() => onGenerateSummary(selectedDevice)} disabled={generatingSummary || !summaryAvailable}>
              {generatingSummary ? <Loader2 size={20} className="icon-spin" /> : <Sparkles size={20} />}
              {generatingSummary ? 'Yönetici özeti hazırlanıyor' : 'Yönetici özeti üret'}
            </button>
          ) : (
            <div className="summary-box">
              <h2><Sparkles size={22} /> Yönetici özeti</h2>
              <ReactMarkdown components={markdownComponents}>{executiveSummary}</ReactMarkdown>
            </div>
          )}
          {!summaryAvailable && <p className="summary-note">Lighthouse skorları tamamlanmadan yönetici özeti üretilemez.</p>}
        </div>
      ) : (
        <div className="issues-list">
          <h2>{tabs.find((tab) => tab.id === activeTab)?.title} bulguları</h2>
          {category.length > 0 ? category.map((issue, index) => {
            const issueKey = `${issue.source}:${issue.id}`
            return <IssueCard key={`${issueKey}:${index}`} issue={issue} solution={solutions?.[issueKey]} solving={Boolean(solving[issueKey])} onSolve={onSolve} />
          }) : <p>Bu kategoride sorun bulunamadı.</p>}
        </div>
      )}
    </section>
  )
}
