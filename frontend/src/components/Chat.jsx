import { useRef, useEffect, useState } from 'react'
import useLearnerElapsed from '../hooks/useLearnerElapsed.js'

function fmt(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0')
  const s = String(secs % 60).padStart(2, '0')
  return `${m}:${s}`
}

export default function Chat({ messages, isLoading, sessionEnded, onSend, onEnd, onTimeExpired, timeLimitMinutes, warningMinutes }) {
  const [text, setText] = useState('')
  const [showWarning, setShowWarning] = useState(false)
  const warnedRef    = useRef(false)
  const expiredRef   = useRef(false)
  const bottomRef    = useRef(null)

  // Count only while learner is active (not while AI is processing)
  const learnerActive = !isLoading && !sessionEnded
  const elapsed = useLearnerElapsed(learnerActive)

  // Warning toast
  useEffect(() => {
    if (!timeLimitMinutes || !warningMinutes || warnedRef.current) return
    const warnAt = (timeLimitMinutes - warningMinutes) * 60
    if (warnAt <= 0) return
    if (elapsed >= warnAt) {
      warnedRef.current = true
      setShowWarning(true)
      setTimeout(() => setShowWarning(false), 2000)
    }
  }, [elapsed, timeLimitMinutes, warningMinutes])

  // Hard stop — learner time exhausted
  useEffect(() => {
    if (!timeLimitMinutes || !onTimeExpired || expiredRef.current || sessionEnded) return
    if (elapsed >= timeLimitMinutes * 60) {
      expiredRef.current = true
      onTimeExpired()
    }
  }, [elapsed, timeLimitMinutes, onTimeExpired, sessionEnded])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  const handleSubmit = (e) => {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || isLoading || sessionEnded) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="chat-panel">
      {showWarning && (
        <div className="time-warning-toast">{warningMinutes} minutes remaining</div>
      )}
      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <div className="bubble">
              {m.role === 'ai' && <span className="speaker-label">AI Coach</span>}
              <p>
                {m.text}
                {m.streaming && <span className="stream-cursor" />}
              </p>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="input-area">
        {timeLimitMinutes && (
          <div className={`session-timer${elapsed >= timeLimitMinutes * 60 ? ' session-timer--over' : (warningMinutes && elapsed >= (timeLimitMinutes - warningMinutes) * 60) ? ' session-timer--warn' : ''}`}>
            {fmt(elapsed)}<span className="session-timer-total">/{fmt(timeLimitMinutes * 60)}</span>
          </div>
        )}
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, flex: 1 }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={sessionEnded ? 'Session ended' : isLoading ? 'Waiting for AI…' : 'Type your response…'}
            disabled={isLoading || sessionEnded}
            autoFocus
          />
          <button type="submit" disabled={isLoading || sessionEnded || !text.trim()}>
            Send
          </button>
        </form>
        {!sessionEnded && (
          <button className="btn-end" onClick={onEnd} disabled={isLoading}>
            End Session
          </button>
        )}
      </div>
    </div>
  )
}
