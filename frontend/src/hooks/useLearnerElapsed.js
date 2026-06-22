import { useState, useEffect, useRef } from 'react'

/**
 * Counts elapsed seconds only while `active` is true.
 * Accumulates across multiple active/inactive transitions.
 * Used to measure learner thinking/speaking time — excludes AI processing and TTS playback.
 */
export default function useLearnerElapsed(active) {
  const [elapsed, setElapsed] = useState(0)
  const accRef   = useRef(0)   // accumulated ms from previous active periods
  const startRef = useRef(null) // start of current active period

  useEffect(() => {
    if (!active) return
    startRef.current = Date.now()
    const id = setInterval(() => {
      setElapsed(Math.floor((accRef.current + (Date.now() - startRef.current)) / 1000))
    }, 500)
    return () => {
      if (startRef.current !== null) {
        accRef.current += Date.now() - startRef.current
        startRef.current = null
      }
      clearInterval(id)
    }
  }, [active])

  return elapsed
}
