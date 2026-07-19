import test from 'node:test'
import assert from 'node:assert/strict'
import { createHistoryEntry, HISTORY_KEY, loadHistory, reportFileName, saveHistory, serializeReport } from '../src/history.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

test('history ignores malformed and expired entries', () => {
  const storage = memoryStorage({ [HISTORY_KEY]: '{broken' })
  assert.deepEqual(loadHistory(storage), [])

  const now = Date.parse('2026-07-19T12:00:00.000Z')
  storage.setItem(HISTORY_KEY, JSON.stringify([
    { id: 'old', url: 'https://old.example', createdAt: '2026-01-01T00:00:00.000Z', report: {} },
    { id: 'fresh', url: 'https://fresh.example', createdAt: '2026-07-18T00:00:00.000Z', report: {} },
  ]))
  assert.deepEqual(loadHistory(storage, now).map((entry) => entry.id), ['fresh'])
})

test('history is capped and report export contains analysis context', () => {
  const storage = memoryStorage()
  const entries = Array.from({ length: 12 }, (_, index) => createHistoryEntry(`https://${index}.example.com`, {}, new Date(`2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`)))
  assert.equal(saveHistory(storage, entries), 10)
  assert.equal(JSON.parse(storage.getItem(HISTORY_KEY)).length, 10)
  assert.match(reportFileName('https://docs.example.com/path', entries[0].createdAt), /^webpage-analysis-docs\.example\.com-/)
  assert.equal(JSON.parse(serializeReport(entries[0])).targetUrl, 'https://0.example.com')
})
