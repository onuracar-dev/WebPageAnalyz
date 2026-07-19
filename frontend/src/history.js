export const HISTORY_KEY = 'webpage-analyzer:report-history:v1'
const MAX_REPORTS = 10
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_STORAGE_CHARACTERS = 4_000_000

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export function loadHistory(storage, now = Date.now()) {
  try {
    const value = JSON.parse(storage.getItem(HISTORY_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value
      .filter((entry) => entry
        && typeof entry.id === 'string'
        && typeof entry.url === 'string'
        && isHttpUrl(entry.url)
        && entry.report
        && Number.isFinite(Date.parse(entry.createdAt))
        && now - Date.parse(entry.createdAt) < MAX_AGE_MS)
      .slice(0, MAX_REPORTS)
  } catch {
    storage.removeItem(HISTORY_KEY)
    return []
  }
}

export function saveHistory(storage, history) {
  const retained = history.slice(0, MAX_REPORTS)
  while (retained.length > 0 && JSON.stringify(retained).length > MAX_STORAGE_CHARACTERS) retained.pop()
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(retained))
    return retained.length
  } catch {
    return 0
  }
}

export function createHistoryEntry(url, report, now = new Date()) {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${now.getTime()}-${Math.random().toString(36).slice(2)}`,
    url,
    createdAt: now.toISOString(),
    report,
    solutions: {},
    executiveSummary: null,
  }
}

export function reportFileName(url, createdAt) {
  let hostname = 'website'
  try { hostname = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '-') || hostname } catch { /* use fallback */ }
  return `webpage-analysis-${hostname}-${createdAt.slice(0, 10)}.json`
}

export function serializeReport(entry) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    targetUrl: entry.url,
    analyzedAt: entry.createdAt,
    report: entry.report,
    executiveSummary: entry.executiveSummary,
    solutions: entry.solutions,
  }, null, 2)
}
