const SCORE_KEYS = ['performance', 'seo', 'accessibility', 'bestPractices']
const DEVICES = ['desktop', 'mobile']

export function availableReportDevices(report) {
  return DEVICES.filter((device) => report?.devices?.[device])
}

export function reportScoresForDevice(report, device = 'desktop') {
  return report?.devices?.[device]?.scores || report?.scores || {}
}

export function hasCompleteScores(report, device = 'desktop') {
  if (report?.meta?.analyzers?.lighthouse === 'unavailable') return false
  const scores = reportScoresForDevice(report, device)
  return SCORE_KEYS.every((key) => typeof scores[key] === 'number' && Number.isFinite(scores[key]))
}

export function reportIssuesForDevice(report, category, device = 'desktop', limit = 150) {
  const deviceCategories = report?.devices?.[device]?.categories
  if (!deviceCategories) return report?.categories?.[category] || []

  const shared = report?.sharedCategories?.[category]
    || (report?.categories?.[category] || []).filter((issue) => !String(issue.source).startsWith('Lighthouse'))

  return [...(deviceCategories[category] || []), ...shared]
    .sort((left, right) => (Number(right.normalizedImpact) || 0) - (Number(left.normalizedImpact) || 0))
    .slice(0, limit)
}
