import test from 'node:test'
import assert from 'node:assert/strict'
import { availableReportDevices, hasCompleteScores, reportIssuesForDevice, reportScoresForDevice } from '../src/report.js'

const scores = { performance: 90, seo: 80, accessibility: 70, bestPractices: 60 }

test('device helpers select the matching scores and merge shared findings', () => {
  const report = {
    scores,
    categories: {},
    sharedCategories: { performance: [{ source: 'YellowLab', normalizedImpact: 80 }] },
    devices: {
      desktop: { scores, categories: { performance: [{ source: 'Lighthouse (Desktop)', normalizedImpact: 20 }] } },
      mobile: {
        scores: { ...scores, performance: 55 },
        categories: { performance: [{ source: 'Lighthouse (Mobile)', normalizedImpact: 90 }] },
      },
    },
    meta: { analyzers: { lighthouse: 'completed' } },
  }

  assert.deepEqual(availableReportDevices(report), ['desktop', 'mobile'])
  assert.equal(reportScoresForDevice(report, 'mobile').performance, 55)
  assert.deepEqual(reportIssuesForDevice(report, 'performance', 'mobile').map((issue) => issue.source), [
    'Lighthouse (Mobile)',
    'YellowLab',
  ])
  assert.equal(hasCompleteScores(report, 'mobile'), true)
})

test('incomplete or unavailable Lighthouse scores cannot generate summaries', () => {
  assert.equal(hasCompleteScores({ scores: { ...scores, seo: null } }), false)
  assert.equal(hasCompleteScores({ scores, meta: { analyzers: { lighthouse: 'unavailable' } } }), false)
})
