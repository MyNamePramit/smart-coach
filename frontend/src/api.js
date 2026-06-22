// ── Scenarios ──────────────────────────────────────────────────────────────

export async function generateScenario(prompt) {
  const res = await fetch('/scenario/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchScenarios() {
  const res = await fetch('/scenarios')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function saveScenario(scenario) {
  const res = await fetch('/scenarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenario),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function deleteScenario(scenarioId) {
  const res = await fetch(`/scenarios/${encodeURIComponent(scenarioId)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ── Session history ────────────────────────────────────────────────────────

export async function fetchSessionHistory() {
  const res = await fetch('/sessions')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchSessionDetail(sessionId) {
  const res = await fetch(`/sessions/${sessionId}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchSessionStatus(sessionId) {
  const res = await fetch(`/sessions/${sessionId}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() // { closed, report, ... }
}

// ── Session lifecycle ──────────────────────────────────────────────────────

export async function startSession(payload) {
  const res = await fetch('/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json()
}

/**
 * Streaming variant. Calls onTts(url, idx) for each sentence TTS URL as it arrives.
 * Resolves with the final done payload when the stream ends.
 */
export async function sendMessageStream(sessionId, user, text, onTts, skipTts = false, speechStats = null) {
  const body = { session_id: sessionId, user, text, skip_tts: skipTts }
  if (speechStats) body.speech_stats = speechStats
  const res = await fetch('/session/message/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || `HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let done = null
  while (true) {
    const { value, done: streamDone } = await reader.read()
    if (streamDone) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() // keep incomplete line
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = JSON.parse(line.slice(6))
      if (payload.type === 'tts') {
        onTts(payload.url, payload.idx, payload.text || '')
      } else if (payload.type === 'sentence') {
        onTts(null, payload.idx, payload.text || '')
      } else if (payload.type === 'done') {
        done = payload
      } else if (payload.type === 'error') {
        throw new Error(payload.detail)
      }
    }
  }
  if (!done) throw new Error('Stream ended without done event')
  return done
}

export async function transcribeAudio(blob) {
  const form = new FormData()
  form.append('audio', blob, 'recording.webm')
  const res = await fetch('/transcribe', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Transcription failed: HTTP ${res.status}`)
  return res.json() // { text }
}

export async function beginSession(sessionId) {
  const res = await fetch(`/session/${sessionId}/begin`, { method: 'POST' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function endSession(sessionId) {
  const res = await fetch(`/session/end?session_id=${sessionId}`, {
    method: 'POST',
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || `HTTP ${res.status}`)
  }
  return res.json()
}
