import { useEffect, useRef } from 'react'
import { fetchSessionStatus } from '../api.js'

const POLL_INTERVAL_MS = 10000

/**
 * Polls /sessions/{id} every 2s while the session is active.
 * When the backend marks it closed (timer expiry), calls onClosed(report).
 */
export default function useSessionClosedPoll(sessionId, active, onClosed) {
  const onClosedRef = useRef(onClosed)
  useEffect(() => { onClosedRef.current = onClosed })

  useEffect(() => {
    if (!sessionId || !active) return
    let cancelled = false

    const poll = async () => {
      if (cancelled) return
      try {
        const data = await fetchSessionStatus(sessionId)
        if (data.closed && data.report && Object.keys(data.report).length > 0) {
          onClosedRef.current(data.report)
          return // stop polling
        }
      } catch {
        // ignore transient errors, keep polling
      }
      if (!cancelled) setTimeout(poll, POLL_INTERVAL_MS)
    }

    const timerId = setTimeout(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(timerId)
    }
  }, [sessionId, active])
}
