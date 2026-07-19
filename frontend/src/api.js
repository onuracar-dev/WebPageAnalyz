const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export async function apiRequest(path, { timeoutMs = 30_000, signal, ...options } = {}) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...options.headers,
      },
    })
    const contentType = response.headers.get('content-type') || ''
    const data = contentType.includes('application/json') ? await response.json() : null
    if (!response.ok) {
      const error = new Error(data?.error || `Request failed with status ${response.status}.`)
      error.code = data?.code
      error.requestId = data?.requestId || response.headers.get('x-request-id')
      throw error
    }
    return data
  } catch (error) {
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new Error('Request cancelled.')
      throw new Error('The request timed out. Please try again.')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
