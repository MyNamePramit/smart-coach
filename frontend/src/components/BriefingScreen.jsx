import { useEffect, useRef, useState } from 'react'

/**
 * Pre-call mediator briefing screen.
 * Plays the briefing TTS, shows the mediator's intro text, then
 * automatically transitions to the call when audio ends.
 */
export default function BriefingScreen({ briefingMessage, briefingTtsUrl, onDone }) {
  const audioRef = useRef(null)
  const [audioReady, setAudioReady] = useState(false)
  const [connecting, setConnecting] = useState(false)

  // Poll until TTS file is ready, then play
  useEffect(() => {
    if (!briefingTtsUrl) {
      // No TTS — just show text for 3s then proceed
      const t = setTimeout(onDone, 3000)
      return () => clearTimeout(t)
    }
    let cancelled = false
    const tryPlay = (attempt = 0) => {
      if (cancelled) return
      fetch(briefingTtsUrl, { method: 'HEAD' })
        .then(res => {
          if (cancelled) return
          if (res.ok) {
            setAudioReady(true)
            audioRef.current?.play().catch(() => { if (!cancelled) onDone() })
          } else if (attempt < 60) {
            setTimeout(() => tryPlay(attempt + 1), 500)
          } else {
            onDone()
          }
        })
        .catch(() => {
          if (!cancelled && attempt < 60) setTimeout(() => tryPlay(attempt + 1), 500)
          else if (!cancelled) onDone()
        })
    }
    tryPlay()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAudioEnd = () => {
    setConnecting(true)
    setTimeout(onDone, 1200)
  }

  return (
    <div className="briefing-screen">
      <audio
        ref={audioRef}
        src={audioReady ? briefingTtsUrl : undefined}
        onEnded={handleAudioEnd}
        onError={onDone}
        style={{ display: 'none' }}
      />

      <div className="briefing-card">
        {/* Mediator icon */}
        <div className="briefing-avatar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="32" height="32">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
            <path d="M2 9a2 2 0 0 1 2-2M22 9a2 2 0 0 0-2-2M4 9v4a1 1 0 0 0 1 1h.5M20 9v4a1 1 0 0 1-1 1h-.5" strokeLinecap="round"/>
          </svg>
        </div>

        <p className="briefing-coordinator-label">Session Coordinator</p>

        <div className="briefing-bubble">
          {briefingMessage
            ? <p className="briefing-text">{briefingMessage}</p>
            : <p className="briefing-text briefing-text--loading">Preparing your session…</p>
          }
        </div>

        {connecting ? (
          <div className="briefing-connecting">
            <span className="briefing-connecting-dot" />
            <span className="briefing-connecting-dot" />
            <span className="briefing-connecting-dot" />
            <span className="briefing-connecting-label">Connecting call…</span>
          </div>
        ) : (
          <button className="btn-ghost briefing-skip" onClick={onDone}>
            Skip intro
          </button>
        )}
      </div>
    </div>
  )
}
