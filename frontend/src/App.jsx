import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Loader2, Activity, Zap, Accessibility, Trash2, Cpu, FileWarning, Sparkles, CheckCircle2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState(null); // Now stores the parsed JSON object
  const [activeTab, setActiveTab] = useState('overview'); // overview, performance, seo, accessibility
  const [solvingIssues, setSolvingIssues] = useState({}); // Tracking which issues are currently being solved
  const [solutions, setSolutions] = useState({}); // Stores AI solutions mapped by issue ID
  const [executiveSummary, setExecutiveSummary] = useState(null); // Stores the CEO-level business summary
  const [generatingSummary, setGeneratingSummary] = useState(false); // Loading state for summary

  // Load state from localStorage on initial mount
  useEffect(() => {
    const savedData = localStorage.getItem('analyzerState');
    if (savedData) {
      try {
        const parsedData = JSON.parse(savedData);
        // Check if data is less than 15 minutes old (15 * 60 * 1000 milliseconds)
        if (Date.now() - parsedData.timestamp < 15 * 60 * 1000) {
          setUrl(parsedData.url || '');
          setReport(parsedData.report || null);
          setActiveTab(parsedData.activeTab || 'overview');
          setSolutions(parsedData.solutions || {});
          setExecutiveSummary(parsedData.executiveSummary || null);
        } else {
          localStorage.removeItem('analyzerState'); // Expire old data
        }
      } catch (e) {
        console.error("Failed to parse local storage", e);
      }
    }
  }, []);

  // Save state to localStorage whenever the report, active tab, or solutions change
  useEffect(() => {
    if (report) {
      const stateToSave = {
        url,
        report,
        activeTab,
        solutions,
        executiveSummary,
        timestamp: Date.now()
      };
      localStorage.setItem('analyzerState', JSON.stringify(stateToSave));
    }
  }, [url, report, activeTab, solutions, executiveSummary]);

  const handleAnalyze = async (e) => {
    e.preventDefault();
    if (!url) return;

    // Add http protocol if missing
    let targetUrl = url;
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }

    setLoading(true);
    setError('');
    setReport(null);

    try {
      const response = await fetch('http://localhost:5000/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to analyze URL');
      }

      setReport(data.report);
      setActiveTab('overview');
      setSolutions({});
      setSolvingIssues({});
      setExecutiveSummary(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleClearLogs = async () => {
    if (!window.confirm('Tüm eski log dosyalarını temizlemek istediğinize emin misiniz?')) return;

    try {
      const response = await fetch('http://localhost:5000/api/logs', {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Log temizleme hatası');
      alert(data.message || 'Loglar başarıyla temizlendi!');
    } catch (err) {
      alert('Hata: ' + err.message);
    }
  };

  const handleSolveIssue = async (issue) => {
    // Avoid double-clicking
    if (solvingIssues[issue.id]) return;

    setSolvingIssues(prev => ({ ...prev, [issue.id]: true }));

    try {
      const response = await fetch('http://localhost:5000/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to get solution');

      setSolutions(prev => ({ ...prev, [issue.id]: data.solution }));
    } catch (err) {
      alert('Failed to solve issue: ' + err.message);
    } finally {
      setSolvingIssues(prev => ({ ...prev, [issue.id]: false }));
    }
  };

  const handleGenerateSummary = async () => {
    if (!report || !report.scores) return;

    setGeneratingSummary(true);
    try {
      const response = await fetch('http://localhost:5000/api/executive-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scores: report.scores })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to get executive summary');

      setExecutiveSummary(data.summary);
    } catch (err) {
      alert('Yönetici özeti alınırken hata oluştu: ' + err.message);
    } finally {
      setGeneratingSummary(false);
    }
  };

  const renderScoreCard = (title, score, icon) => {
    let color = '#2ea043'; // score-good
    if (score < 50) color = '#ff7b72'; // score-poor
    else if (score < 90) color = '#d29922'; // score-average

    const data = [
      { name: 'Score', value: score },
      { name: 'Remaining', value: 100 - score }
    ];

    return (
      <div className="score-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          {icon} <h3 style={{ margin: 0 }}>{title}</h3>
        </div>
        <div style={{ position: 'relative', width: 120, height: 120 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={45}
                outerRadius={60}
                startAngle={90}
                endAngle={-270}
                dataKey="value"
                stroke="none"
              >
                <Cell fill={color} />
                <Cell fill="rgba(139, 148, 158, 0.2)" />
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.5rem', fontWeight: 'bold', color: color
          }}>
            {score}
          </div>
        </div>
      </div>
    );
  };

  const renderIssueCard = (issue) => {
    const isSolving = solvingIssues[issue.id];
    const solution = solutions[issue.id];

    return (
      <div key={issue.id} className="issue-card">
        <div className="issue-header">
          <div className="issue-title">
            {issue.title}
          </div>
          <div className="issue-badge">{issue.source}</div>
        </div>
        <div className="issue-desc">
          <ReactMarkdown>
            {issue.description}
          </ReactMarkdown>
        </div>

        {issue.displayValue && (
          <div style={{ marginBottom: '1rem', color: '#ff7b72', fontSize: '0.9rem' }}>
            <strong>Impact:</strong> {issue.displayValue}
          </div>
        )}

        {issue.snippet && (
          <div className="snippet-box">
            {issue.snippet}
          </div>
        )}

        {!solution ? (
          <button
            className="solve-btn"
            onClick={() => handleSolveIssue(issue)}
            disabled={isSolving}
          >
            {isSolving ? <Loader2 size={16} className="spinner" style={{ margin: 0, width: 16, height: 16 }} /> : <Sparkles size={16} />}
            {isSolving ? 'AI Çözüm Üretiyor...' : 'AI ile Çöz'}
          </button>
        ) : (
          <div className="solution-box">
            <div className="solution-header">
              <CheckCircle2 size={18} /> AI Çözüm Önerisi
            </div>
            <div className="markdown-body" style={{ fontSize: '0.95rem' }}>
              <ReactMarkdown>{solution}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="container">
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        style={{ textAlign: 'center', marginBottom: '3rem' }}
      >
        <h1>WebPage Analyzer AI</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1.2rem' }}>
          Comprehensive Performance, SEO, and Accessibility audit powered by Google Gemini.
        </p>
      </motion.header>

      <motion.main
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, delay: 0.1 }}
      >
        <div className="glass-panel" style={{ padding: '2rem', marginBottom: '2rem' }}>
          <form onSubmit={handleAnalyze} className="input-group">
            <input
              type="text"
              placeholder="Enter website URL (e.g., example.com)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
              required
            />
            <button type="submit" disabled={loading || !url}>
              {loading ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Loader2 className="spinner" style={{ width: 20, height: 20, margin: 0, border: 'none', animation: 'spin 2s linear infinite' }} />
                  Analyzing...
                </span>
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Search size={20} />
                  Analyze
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handleClearLogs}
              disabled={loading}
              title="Logları Temizle"
              style={{ padding: '1rem', background: 'rgba(248, 81, 73, 0.2)', color: 'var(--error)', border: '1px solid rgba(248, 81, 73, 0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <Trash2 size={24} />
            </button>
          </form>

          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                style={{ color: 'var(--error)', padding: '1rem', background: 'rgba(248, 81, 73, 0.1)', borderRadius: 8, marginTop: '1rem' }}
              >
                <strong>Error:</strong> {error}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {loading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="glass-panel loader-container"
            >
              <div className="spinner"></div>
              <h3>Running comprehensive analysis</h3>
              <p style={{ color: 'var(--text-secondary)' }}>
                This might take a few minutes as we run Lighthouse, YellowLab, and Axe DevTools concurrently, then generate an AI report. Please wait...
              </p>

              <div style={{ display: 'flex', gap: '2rem', marginTop: '2rem', color: 'var(--text-secondary)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                  <Zap size={24} /> <span>Lighthouse</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                  <Activity size={24} /> <span>YellowLab</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                  <Accessibility size={24} /> <span>Axe DevTools</span>
                </div>
              </div>
            </motion.div>
          )}

          {!loading && report && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass-panel"
              style={{ padding: '2rem' }}
              id="report-container"
            >
              <div className="tabs-header">
                <button
                  className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
                  onClick={() => setActiveTab('overview')}
                ><Cpu size={18} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />Genel Bakış</button>
                <button
                  className={`tab-btn ${activeTab === 'performance' ? 'active' : ''}`}
                  onClick={() => setActiveTab('performance')}
                ><Zap size={18} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />Performans ({report.categories?.performance?.length || 0})</button>
                <button
                  className={`tab-btn ${activeTab === 'seo' ? 'active' : ''}`}
                  onClick={() => setActiveTab('seo')}
                ><Search size={18} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />SEO ({report.categories?.seo?.length || 0})</button>
                <button
                  className={`tab-btn ${activeTab === 'accessibility' ? 'active' : ''}`}
                  onClick={() => setActiveTab('accessibility')}
                ><Accessibility size={18} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />Erişilebilirlik ({report.categories?.accessibility?.length || 0})</button>
              </div>

              <div className="tab-body">
                {activeTab === 'overview' && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    {/* Added an ID here so the PDF exporter captures only this clean grid */}
                    <div className="score-cards" id="score-cards-container" style={{ padding: '2rem', borderRadius: '12px', background: 'var(--glass-bg)' }}>
                      {renderScoreCard('Performans', report.scores?.performance || 0, <Zap />)}
                      {renderScoreCard('SEO', report.scores?.seo || 0, <Search />)}
                      {renderScoreCard('Erişilebilirlik', report.scores?.accessibility || 0, <Accessibility />)}
                      {renderScoreCard('En İyi Pratikler', report.scores?.bestPractices || 0, <Activity />)}
                    </div>
                    <div style={{ textAlign: 'center', color: 'var(--text-secondary)', marginTop: '2rem', marginBottom: '2rem' }}>
                      <p>Yukarıdaki sekmelerden hataların olduğu kategorilere giderek detayları inceleyebilir, her bir sorun için anında <strong>"AI ile Çöz"</strong> butonunu kullanarak kod snippet'leri üretebilirsin.</p>

                      {!executiveSummary ? (
                        <button
                          type="button"
                          onClick={handleGenerateSummary}
                          disabled={generatingSummary}
                          style={{
                            marginTop: '1rem',
                            padding: '1rem 2rem',
                            background: 'linear-gradient(45deg, #d29922, #e3b341)',
                            color: '#0d1117',
                            fontWeight: 'bold',
                            border: 'none',
                            borderRadius: '8px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            cursor: 'pointer'
                          }}
                        >
                          {generatingSummary ? <Loader2 size={20} className="spinner" style={{ borderTopColor: '#0d1117' }} /> : <Sparkles size={20} />}
                          {generatingSummary ? 'CEO Raporu Hazırlanıyor...' : 'Yönetici Özeti (CEO Raporu) Üret'}
                        </button>
                      ) : (
                        <div style={{
                          marginTop: '2rem',
                          padding: '2rem',
                          background: 'rgba(210, 153, 34, 0.1)',
                          border: '1px solid rgba(210, 153, 34, 0.3)',
                          borderRadius: '12px',
                          textAlign: 'left',
                          color: '#e3b341'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', fontWeight: 'bold', fontSize: '1.2rem' }}>
                            <Sparkles size={24} /> Genel Direktör (CMO) Raporu
                          </div>
                          <div className="markdown-body" style={{ color: '#c9d1d9', fontSize: '1.05rem', lineHeight: '1.6' }}>
                            <ReactMarkdown>{executiveSummary}</ReactMarkdown>
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}

                {activeTab === 'performance' && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <h2 style={{ marginBottom: '1.5rem', color: '#58a6ff' }}>Performans İyileştirmeleri</h2>
                    {report.categories?.performance?.length > 0 ? report.categories.performance.map(renderIssueCard) : <p>Performans sorunu bulunamadı! Harika iş.</p>}
                  </motion.div>
                )}

                {activeTab === 'seo' && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <h2 style={{ marginBottom: '1.5rem', color: '#58a6ff' }}>Arama Motoru Optimizasyonu (SEO)</h2>
                    {report.categories?.seo?.length > 0 ? report.categories.seo.map(renderIssueCard) : <p>SEO sorunu bulunamadı! Harika iş.</p>}
                  </motion.div>
                )}

                {activeTab === 'accessibility' && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <h2 style={{ marginBottom: '1.5rem', color: '#58a6ff' }}>Erişilebilirlik Sorunları</h2>
                    {report.categories?.accessibility?.length > 0 ? report.categories.accessibility.map(renderIssueCard) : <p>Erişilebilirlik sorunu bulunamadı! Harika iş.</p>}
                  </motion.div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.main>

      <footer style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '2rem', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
        <p>
          Developed by <a href="https://github.com/onuracar-dev" target="_blank" rel="noopener noreferrer" style={{ color: '#58a6ff', textDecoration: 'none' }}>Onur Acar</a>
          {' | '}
          <a href="mailto:onuracar.work@gmail.com" style={{ color: '#58a6ff', textDecoration: 'none' }}>onuracar.work@gmail.com</a>
        </p>
      </footer>
    </div>
  );
}

export default App;
