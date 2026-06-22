import { useState, useRef, useEffect } from 'react'
import Avatar from './components/Avatar.jsx'
import BackgroundArt from './components/BackgroundArt.jsx'
import Chat from './components/Chat.jsx'
import HistoryScreen from './components/HistoryScreen.jsx'
import ScenarioEditor from './components/ScenarioEditor.jsx'
import VoiceCall from './components/VoiceCall.jsx'
import { SCENARIOS } from './scenarios.js'
import { startSession, sendMessageStream, endSession, fetchScenarios, saveScenario, deleteScenario } from './api.js'
import useSessionClosedPoll from './hooks/useSessionClosedPoll.js'

export default function App() {
  const [screen, setScreen] = useState('setup')     // 'setup' | 'chat' | 'call' | 'analysing' | 'report' | 'editor' | 'history'
  const [startMode, setStartMode] = useState('chat') // 'chat' | 'call'
  const [scenarios, setScenarios] = useState(SCENARIOS)
  const [selectedId, setSelectedId] = useState(SCENARIOS[0].id)
  const [editingIdx, setEditingIdx] = useState(null)  // null = new scenario
  const [viewingIdx, setViewingIdx] = useState(null)  // read-only view
  const [session, setSession] = useState(null)
  const [openingData, setOpeningData] = useState(null)   // { message, ttsUrl }
  const [briefingData, setBriefingData] = useState(null) // { message, ttsUrl }
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [sessionEnded, setSessionEnded] = useState(false)
  const [report, setReport] = useState(null)
  const [timeExpiredReport, setTimeExpiredReport] = useState(null) // pending report after timer fires
  const [profanityWarning, setProfanityWarning] = useState(null)  // { count, terminated, report }
  const [error, setError] = useState(null)
  const [launchPopup, setLaunchPopup] = useState(null) // pending scenario waiting for learner name
  const [learnerName, setLearnerName] = useState('')

  const audioRef        = useRef(null)
  const sessionStartRef = useRef(null)
  const [earlyClosePopup, setEarlyClosePopup] = useState(false)

  // Poll for timer-triggered session close (text chat mode)
  useSessionClosedPoll(
    session?.id,
    screen === 'chat' && !sessionEnded,
    (r) => r.time_expired ? setTimeExpiredReport(r) : finaliseReport(r)
  )


  // Warn before tab close / browser back when a session is in progress
  useEffect(() => {
    const active = session && !sessionEnded && ['chat', 'call'].includes(screen)
    if (!active) return
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [session, sessionEnded, screen])

  // Load persisted scenarios from backend on mount.
  // Always upsert builtins so scenarios.js changes are reflected immediately.
  // Custom scenarios are loaded from DB and merged in after builtins.
  useEffect(() => {
    Promise.all(SCENARIOS.map(s => saveScenario(s)))
      .then(() => fetchScenarios())
      .then((saved) => {
        if (saved && saved.length > 0) {
          setScenarios(saved)
          setSelectedId(saved[0].id)
        }
      })
      .catch(() => {})
  }, [])

  const EARLY_CLOSE_THRESHOLD_MS = 2 * 60 * 1000

  const scenario = scenarios.find((s) => s.id === selectedId)

  // When selected scenario changes, snap startMode to what the author set
  useEffect(() => {
    if (!scenario) return
    const mode = scenario.session_mode || 'text'
    setStartMode(mode === 'voice' ? 'call' : 'chat')
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Speak a URL — retries up to 6 times (3s total) if file isn't ready yet ──
  const speak = (url, attempt = 0) => {
    if (!url || !audioRef.current) return
    fetch(url, { method: 'HEAD' })
      .then(res => {
        if (res.ok) {
          audioRef.current.src = url
          audioRef.current.play().catch(() => {})
        } else if (attempt < 30) {
          setTimeout(() => speak(url, attempt + 1), 500)
        }
      })
      .catch(() => {
        if (attempt < 30) setTimeout(() => speak(url, attempt + 1), 500)
      })
  }

  // ── Start session ──
  const handleStartScenario = (s) => {
    setSelectedId(s.id)
    setError(null)
    setLearnerName('')
    setLaunchPopup(s)
  }

  const confirmLaunch = async () => {
    const s = launchPopup
    const name = learnerName.trim()
    if (!name) return
    setLaunchPopup(null)
    setIsLoading(true)
    const mode = s.session_mode === 'voice' ? 'call' : 'chat'
    try {
      const data = await startSession({ ...s.payload, title: s.label, tts_enabled: mode === 'call', learner_name: name })
      setSession({ id: data.session_id, personaName: s.payload.ai_persona.name })
      sessionStartRef.current = Date.now()
      if (mode === 'call') {
        setOpeningData({ message: data.opening_message, ttsUrl: data.opening_tts_url })
        setBriefingData({ ttsUrl: data.briefing_tts_url })
        setScreen('call')
      } else {
        setMessages([{ role: 'ai', text: data.opening_message }])
        setScreen('chat')
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setIsLoading(false)
    }
  }

  const handleStart = () => handleStartScenario(scenario)

  // ── Send a user message ──
  const handleSend = async (text) => {
    setError(null)
    setMessages((prev) => [...prev, { role: 'user', text }])
    setIsLoading(true)

    // Add a streaming placeholder for the AI reply
    setMessages((prev) => [...prev, { role: 'ai', text: '', streaming: true }])

    try {
      const data = await sendMessageStream(session.id, 'Learner', text, (url, idx, chunkText) => {
        if (chunkText) {
          setMessages((prev) => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            if (last?.role === 'ai' && last.streaming) {
              updated[updated.length - 1] = {
                ...last,
                text: last.text ? last.text + ' ' + chunkText : chunkText,
              }
            }
            return updated
          })
        }
      }, true)

      if (data.profanity_blocked) {
        // Remove user message and streaming placeholder
        setMessages((prev) => prev.slice(0, -2))
        setProfanityWarning({ count: data.offense_count, terminated: data.profanity_terminated, report: data.report })
        return
      }

      setMessages((prev) => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last?.role === 'ai' && last.streaming) {
          updated[updated.length - 1] = { role: 'ai', text: last.text || data.reply || '' }
        }
        return updated
      })

      if (data.ai_closed || data.report != null) {
        setScreen('analysing')
        if (data.ai_closed) {
          try {
            const ended = await endSession(session.id)
            finaliseReport(ended.report ?? ended)
          } catch {
            finaliseReport(data.report)
          }
        } else {
          finaliseReport(data.report)
        }
      }
    } catch (e) {
      // Remove streaming placeholder on error
      setMessages((prev) => prev.slice(0, -1))
      if (e.message?.includes('already closed')) {
        try {
          const ended = await endSession(session.id)
          const r = ended.report ?? ended
          r?.time_expired ? setTimeExpiredReport(r) : finaliseReport(r)
        } catch {
          setSessionEnded(true)
        }
      } else {
        setError(e.message)
      }
    } finally {
      setIsLoading(false)
    }
  }

  // ── End session manually ──
  const handleEnd = () => {
    const elapsed = Date.now() - (sessionStartRef.current ?? Date.now())
    if (elapsed < EARLY_CLOSE_THRESHOLD_MS) {
      setEarlyClosePopup(true)
      return
    }
    _doEnd()
  }

  const _doEnd = async () => {
    setEarlyClosePopup(false)
    setError(null)
    setScreen('analysing')
    try {
      const data = await endSession(session.id)
      finaliseReport(data.report ?? data)
    } catch (e) {
      setError(e.message)
      setScreen('chat')
    }
  }

  const finaliseReport = (r) => {
    setSessionEnded(true)
    setReport(r)
    setScreen('report')
  }

  const handleAudioEnd = () => {
    setIsSpeaking(false)
  }

  // ── Restart ──
  const handleRestart = () => {
    setScreen('setup')
    setSession(null)
    setMessages([])
    setReport(null)
    setLiveScore(null)
    setSessionEnded(false)
    setIsSpeaking(false)
    setError(null)
    setOpeningData(null)
    setBriefingData(null)
    setTimeExpiredReport(null)
    setProfanityWarning(null)
    setEarlyClosePopup(false)
    sessionStartRef.current = null
  }

  // ── Voice call end ──
  const handleCallEnd = () => {
    setScreen('setup')
    setSession(null)
  }

  // ── Editor save / cancel ──
  const handleEditorSave = (saved) => {
    setScenarios((prev) => {
      if (editingIdx === null) {
        return [...prev, saved]
      }
      const next = [...prev]
      next[editingIdx] = saved
      return next
    })
    setSelectedId(saved.id)
    saveScenario(saved).catch(() => {})
    setScreen('setup')
  }

  const handleEditorCancel = () => setScreen('setup')

  const handleDeleteScenario = (idx) => {
    const s = scenarios[idx]
    setScenarios((prev) => prev.filter((_, i) => i !== idx))
    if (selectedId === s.id) {
      const remaining = scenarios.filter((_, i) => i !== idx)
      if (remaining.length > 0) setSelectedId(remaining[0].id)
    }
    deleteScenario(s.id).catch(() => {})
  }

  const openEditor = (idx) => {
    setEditingIdx(idx)
    setViewingIdx(null)
    setScreen('editor')
  }

  const openViewer = (idx) => {
    setViewingIdx(idx)
    setEditingIdx(idx)
    setScreen('editor')
  }

  // ─────────────────── RENDER ───────────────────

  if (screen === 'editor') {
    const initial = editingIdx !== null ? scenarios[editingIdx] : null
    const isReadOnly = viewingIdx !== null && scenarios[viewingIdx]?.builtin
    return (
      <ScenarioEditor
        initial={initial}
        onSave={handleEditorSave}
        onCancel={() => { setViewingIdx(null); handleEditorCancel() }}
        readOnly={isReadOnly}
      />
    )
  }

  if (screen === 'history') {
    return <HistoryScreen onBack={() => setScreen('setup')} />
  }

  if (screen === 'setup') {
    return (
      <div className="setup-screen">
        <BackgroundArt />

        {/* ── ALM-style top header ── */}
        <header className="alm-header">
          <div className="alm-logo-area">
            <div className="alm-logo-icon">AI</div>
            <span className="alm-logo-text">AI Coach</span>
            <span className="alm-logo-sub">Roleplay Practice</span>
          </div>
          <div className="alm-header-actions">
            <button className="btn-ghost btn-sm" onClick={() => setScreen('history')}>
              History
            </button>
            <button className="btn-ghost btn-sm" onClick={() => openEditor(null)}>
              + Create
            </button>
          </div>
        </header>

        {/* ── Main content ── */}
        <div className="setup-content">
          <div className="setup-card">
            <p className="setup-page-title">Practice Scenarios</p>
            <p className="setup-page-sub">Select a scenario to practice, then choose your preferred mode.</p>

            {error && <p className="error-msg" style={{margin:'0 0 12px'}}>{error}</p>}

            {/* Scenario card grid */}
            <div className="scenario-list">
              {scenarios.map((s, idx) => {
                const mode = s.session_mode === 'voice' ? 'call' : 'chat'
                const isSelected = selectedId === s.id
                const launching = isLoading && isSelected
                return (
                <div
                  key={s.id}
                  className={`scenario-btn ${isSelected ? 'active' : ''}`}
                  onClick={() => setSelectedId(s.id)}
                >
                  {/* Thumbnail */}
                  <div className="scenario-btn-thumb">
                    {s.thumbnail
                      ? <img src={s.thumbnail} alt={s.label} className="scenario-thumb-img" />
                      : <div className="scenario-thumb-placeholder" />
                    }
                    <div className="scenario-thumb-badges">
                      <span className="scenario-thumb-badge">
                        {s.builtin ? 'Sample' : 'Custom'}
                      </span>
                      {(s.session_mode === 'text' || s.session_mode === 'voice') && (
                        <span className="scenario-thumb-badge scenario-thumb-badge--mode">
                          {s.session_mode === 'text' ? 'Text' : 'Voice'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Body */}
                  <div className="scenario-btn-main">
                    <strong>{s.label}</strong>
                    <span>{s.description}</span>
                  </div>

                  {/* Footer */}
                  <div className="scenario-btn-footer">
                    <div className="scenario-btn-actions">
                      {s.builtin ? (
                        <button
                          className="scenario-edit-btn"
                          onClick={(e) => { e.stopPropagation(); openViewer(idx) }}
                        >
                          View
                        </button>
                      ) : (
                        <>
                          <button
                            className="scenario-edit-btn"
                            onClick={(e) => { e.stopPropagation(); openEditor(idx) }}
                          >
                            Edit
                          </button>
                          <button
                            className="scenario-edit-btn scenario-delete-btn"
                            onClick={(e) => { e.stopPropagation(); handleDeleteScenario(idx) }}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                    <button
                      className="scenario-launch-btn"
                      disabled={isLoading}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleStartScenario(s)
                      }}
                    >
                      {launching ? 'Starting…' : 'Launch'}
                    </button>
                  </div>
                </div>
                )
              })}
            </div>

            {/* Action bar — kept for fallback / error display */}
            <div className="setup-actions-row" style={{display:'none'}}>
              <div className="setup-actions-right">
              </div>
            </div>
          </div>
        </div>

        {/* Learner name popup */}
        {launchPopup && (
          <div className="popup-overlay">
            <div className="popup-card">
              <h3 className="popup-title">Before you begin</h3>
              <p className="popup-body">Enter your name so the AI can address you during the session.</p>
              <input
                className="popup-name-input"
                type="text"
                placeholder="Your name"
                value={learnerName}
                onChange={e => setLearnerName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmLaunch() }}
                autoFocus
              />
              <div className="popup-actions">
                <button className="btn-ghost" onClick={() => setLaunchPopup(null)}>Cancel</button>
                <button className="btn-primary" disabled={!learnerName.trim() || isLoading} onClick={confirmLaunch}>
                  {isLoading ? 'Starting…' : 'Start'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (screen === 'analysing') {
    return (
      <div className="analysing-screen">
        <BackgroundArt />
        <button className="analysing-back" onClick={handleRestart} title="Back to home">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Home
        </button>
        <div className="analysing-card">
          <div className="analysing-spinner" />
          <p className="analysing-title">Analysing your session...</p>
          <p className="analysing-sub">Evaluating responses, scoring topics, and generating feedback</p>
        </div>
      </div>
    )
  }

  if (screen === 'report') {
    const score        = report?.final_score ?? report?.evaluation_score ?? 0
    const passed       = report?.passed ?? false
    const passingMarks = report?.passing_marks ?? 70
    const explanation  = report?.session_explanation
    const topicExpls   = explanation?.topic_explanations ?? []
    const isEmpty      = score === 0 && topicExpls.length === 0

    if (isEmpty) {
      return (
        <div className="report-screen">
          <div className="report-card">
            <div className="report-topbar">
              <button className="report-back-btn" onClick={handleRestart}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Home
              </button>
            </div>
            <h2>Session Report</h2>
            <div className="report-empty">
              <h3>Session Too Short to Evaluate</h3>
              <p>
                The conversation didn't have enough content for a meaningful assessment.
                Complete a full roleplay exchange to receive your score and detailed feedback.
              </p>
              <ul className="report-empty-tips">
                <li>Respond to the AI's prompts with detailed answers</li>
                <li>Cover the key topics outlined in the scenario</li>
                <li>Aim for at least 3–5 back-and-forth exchanges</li>
              </ul>
            </div>
            <button className="btn-primary" onClick={handleRestart}>
              Try Again
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="report-screen">
        <div className="report-card">
          <div className="report-topbar">
            <button className="report-back-btn" onClick={handleRestart}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Home
            </button>
          </div>
          <h2>Session Report</h2>

          {/* ── Score badge ── */}
          <div className={`score-badge ${passed ? 'pass' : 'fail'}`}>
            <div className="score-main">
              <span className="score-num">{Math.round(score)}</span>
              <span className="score-label">/ 100</span>
            </div>
            <div className="score-meta">
              <span className="passing-mark">Pass: {passingMarks}+</span>
              <span className={`verdict ${passed ? 'pass' : 'fail'}`}>
                {passed ? 'Passed' : 'Did not pass'}
              </span>
            </div>
          </div>

          {/* ── Overall summary ── */}
          {explanation?.summary && (
            <div className="report-summary">
              <p>{explanation.summary}</p>
            </div>
          )}

          {report?.make_or_break_failed && (
            <p className="warning-msg">A make-or-break criterion was not met.</p>
          )}

          {/* ── Speaking analysis (voice sessions only) ── */}
          {report?.speech_stats && (
            <div className="report-speech-stats">
              <h3>Speaking Analysis</h3>
              <div className="speech-stats-grid">
                {report.speech_stats.avg_pace_wpm != null && (
                  <div className="stat-card">
                    <span className="stat-value">{report.speech_stats.avg_pace_wpm}</span>
                    <span className="stat-label">words / min</span>
                    <span className="stat-hint">
                      {report.speech_stats.avg_pace_wpm < 120 ? 'Slow pace' :
                       report.speech_stats.avg_pace_wpm < 160 ? 'Natural pace' :
                       report.speech_stats.avg_pace_wpm < 200 ? 'Fast pace' : 'Very fast'}
                    </span>
                  </div>
                )}
                <div className="stat-card">
                  <span className="stat-value">{report.speech_stats.total_fillers}</span>
                  <span className="stat-label">filler words</span>
                  {Object.keys(report.speech_stats.filler_breakdown ?? {}).length > 0 && (
                    <span className="stat-hint">
                      {Object.entries(report.speech_stats.filler_breakdown)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 3)
                        .map(([w, c]) => `"${w}" ×${c}`)
                        .join(', ')}
                    </span>
                  )}
                </div>
                <div className="stat-card">
                  <span className="stat-value">{report.speech_stats.total_words}</span>
                  <span className="stat-label">words spoken</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Per-topic explanation ── */}
          {topicExpls.length > 0 && (
            <div className="report-topics">
              <h3>Topic Breakdown</h3>
              {topicExpls.map((t, i) => {
                const rawCriteria = report?.topic_breakdown?.[i]?.criteria ?? []
                const learnerTurns = report?.learner_turns ?? []
                return (
                <div key={i} className={`report-topic-card ${t.make_or_break_failed ? 'mob-failed' : ''}`}>
                  {/* Header */}
                  <div className="rpt-header">
                    <span className="rpt-name">{t.topic}</span>
                    <span className={`rpt-score ${t.score_pct >= 66 ? 'good' : t.score_pct >= 33 ? 'mid' : 'bad'}`}>
                      {Math.round(t.score_pct)}%
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div className="rpt-bar">
                    <div className="rpt-bar-fill" style={{ width: `${Math.min(t.score_pct, 100)}%` }} />
                  </div>

                  {/* Explanation */}
                  {t.explanation && <p className="rpt-explanation">{t.explanation}</p>}

                  {/* Criteria with turn-by-turn evidence */}
                  {rawCriteria.length > 0 ? (
                    <ul className="rpt-criteria-list">
                      {rawCriteria.map((c, j) => {
                        const quote = c.supporting_turn != null
                          ? learnerTurns[c.supporting_turn - 1]
                          : null
                        const excerpt = quote
                          ? (quote.length > 120 ? quote.slice(0, 117) + '…' : quote)
                          : null
                        return (
                          <li key={j} className={c.met ? 'covered' : 'missed'}>
                            <span className={`crit-icon ${c.met ? 'crit-pass' : 'crit-fail'}`}></span>
                            <span className="crit-text">{c.criterion}</span>
                            {(excerpt || c.reason) && (
                              <div className="crit-evidence">
                                {excerpt && <span className="crit-quote">"{excerpt}"</span>}
                                {c.reason && <span className="crit-reason">{c.reason}</span>}
                              </div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <>
                      {t.covered_criteria.length > 0 && (
                        <ul className="rpt-criteria-list">
                          {t.covered_criteria.map((c, j) => (
                            <li key={j} className="covered"><span className="crit-icon crit-pass"></span><span className="crit-text">{c}</span></li>
                          ))}
                        </ul>
                      )}
                      {t.missed_criteria.length > 0 && (
                        <ul className="rpt-criteria-list">
                          {t.missed_criteria.map((c, j) => (
                            <li key={j} className="missed"><span className="crit-icon crit-fail"></span><span className="crit-text">{c}</span></li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}

                  {/* Gap / actionable tip */}
                  {t.gap && (
                    <div className="rpt-gap">
                      <span className="rpt-gap-label">Tip</span>
                      <span>{t.gap}</span>
                    </div>
                  )}

                  {t.make_or_break_failed && (
                    <p className="rpt-mob-warning">Make-or-break criterion not met</p>
                  )}
                </div>
                )
              })}
            </div>
          )}

          <button className="btn-primary" onClick={handleRestart}>
            Start New Session
          </button>
        </div>
      </div>
    )
  }

  // ── Voice call screen ──
  if (screen === 'call') {
    return (
      <VoiceCall
        session={session}
        scenario={scenario}
        openingMessage={openingData?.message}
        openingTtsUrl={openingData?.ttsUrl}
        briefingTtsUrl={briefingData?.ttsUrl}
        onCallEnd={handleCallEnd}
        onReport={async (r) => {
          setScreen('analysing')
          if (r == null) {
            const [ended] = await Promise.all([
              endSession(session.id).catch(() => null),
              new Promise(res => setTimeout(res, 6000)),
            ])
            finaliseReport(ended?.report ?? ended)
          } else {
            finaliseReport(r)
          }
        }}
        sessionStart={sessionStartRef.current}
        timeLimitMinutes={scenario?.payload?.additional_settings?.simulation_time_limit?.enabled
          ? scenario.payload.additional_settings.simulation_time_limit.duration_minutes
          : null}
        warningMinutes={scenario?.payload?.additional_settings?.simulation_time_limit?.warning_minutes ?? 3}
      />
    )
  }

  // ── Chat screen ──
  return (
    <div className="chat-screen">
      {profanityWarning && (
        <div className="popup-overlay">
          <div className="popup-card">
            <h3 className="popup-title">{profanityWarning.terminated ? 'Session Terminated' : 'Language Warning'}</h3>
            <p className="popup-body">
              {profanityWarning.terminated
                ? 'This session has been terminated due to repeated use of inappropriate language.'
                : 'Please keep your language professional. A second violation will end the session immediately.'}
            </p>
            <div className="popup-actions">
              <button className="btn-primary" onClick={() => {
                if (profanityWarning.terminated) {
                  setProfanityWarning(null)
                  finaliseReport(profanityWarning.report)
                } else {
                  setProfanityWarning(null)
                }
              }}>
                {profanityWarning.terminated ? 'View Report' : 'Understood'}
              </button>
            </div>
          </div>
        </div>
      )}

      {timeExpiredReport && (
        <div className="popup-overlay">
          <div className="popup-card">
            <h3 className="popup-title">Time's up</h3>
            <p className="popup-body">The session time limit has been reached. Your responses have been recorded and will now be analysed.</p>
            <div className="popup-actions">
              <button className="btn-primary" onClick={() => { setTimeExpiredReport(null); finaliseReport(timeExpiredReport) }}>OK</button>
            </div>
          </div>
        </div>
      )}

      {earlyClosePopup && (
        <div className="popup-overlay">
          <div className="popup-card">
            <h3 className="popup-title">End session early?</h3>
            <p className="popup-body">
              The session has been running for less than 2 minutes. Ending now may result in
              an incomplete evaluation — some criteria won't have enough conversation to assess.
            </p>
            <div className="popup-actions">
              <button className="btn-ghost" onClick={() => setEarlyClosePopup(false)}>
                Keep going
              </button>
              <button className="btn-danger" onClick={_doEnd}>
                End anyway
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Hidden audio element — shared across all TTS playback */}
      <audio
        ref={audioRef}
        onEnded={handleAudioEnd}
        onPause={handleAudioEnd}
        style={{ display: 'none' }}
      />

      {/* Left — Avatar panel */}
      <div className="avatar-panel">
        <div className="persona-name">{session?.personaName}</div>
        <Avatar
          isSpeaking={isSpeaking}
          isThinking={isLoading}
          name={session?.personaName}
        />
        <div className="scenario-tag">{scenario?.label}</div>

      </div>

      {/* Right — Chat panel */}
      <div className="chat-column">
        {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>✕</button></div>}
        <Chat
          messages={messages}
          isLoading={isLoading}
          sessionEnded={sessionEnded}
          onSend={handleSend}
          onEnd={handleEnd}
          onTimeExpired={async () => {
            try {
              const data = await endSession(session.id)
              const r = data.report ?? data
              setTimeExpiredReport({ ...r, time_expired: true })
            } catch { /* session may already be closed */ }
          }}
          timeLimitMinutes={scenario?.payload?.additional_settings?.simulation_time_limit?.enabled
            ? scenario.payload.additional_settings.simulation_time_limit.duration_minutes
            : null}
          warningMinutes={scenario?.payload?.additional_settings?.simulation_time_limit?.warning_minutes ?? 3}
        />
      </div>
    </div>
  )
}
