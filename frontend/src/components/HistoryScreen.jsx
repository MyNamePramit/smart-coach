import { useState, useEffect } from 'react'
import { fetchSessionHistory, fetchSessionDetail } from '../api.js'

export default function HistoryScreen({ onBack }) {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)   // full session detail
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    fetchSessionHistory()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false))
  }, [])

  const openDetail = async (id) => {
    setDetailLoading(true)
    try {
      const data = await fetchSessionDetail(id)
      setSelected(data)
    } catch {
      // ignore
    } finally {
      setDetailLoading(false)
    }
  }

  if (selected) {
    return <SessionDetail session={selected} onBack={() => setSelected(null)} />
  }

  return (
    <div className="history-screen">
      <header className="alm-header">
        <div className="alm-logo-area">
          <button className="btn-ghost btn-sm" onClick={onBack}>← Back</button>
          <span className="alm-logo-text" style={{marginLeft:8}}>Session History</span>
        </div>
      </header>
      <div className="history-card">

        {loading && <p className="history-empty">Loading…</p>}
        {!loading && sessions.length === 0 && (
          <p className="history-empty">No sessions yet. Start a practice to see history here.</p>
        )}

        {!loading && sessions.length > 0 && (
          <div className="history-list">
            {sessions.map((s) => (
              <div key={s.id} className="history-row" onClick={() => openDetail(s.id)}>
                <div className="history-row-left">
                  <span className="history-title">{s.title}</span>
                  {s.persona_name && <span className="history-persona">with {s.persona_name}</span>}
                  <span className="history-date">{s.created_at ? new Date(s.created_at).toLocaleString() : ''}</span>
                </div>
                <div className="history-row-right">
                  {s.score != null ? (
                    <>
                      <span className={`history-score ${s.passed ? 'pass' : 'fail'}`}>
                        {Math.round(s.score)}<span className="history-score-denom">/100</span>
                      </span>
                      <span className={`history-verdict ${s.passed ? 'pass' : 'fail'}`}>
                        {s.passed ? 'Passed' : 'Failed'}
                      </span>
                    </>
                  ) : (
                    <span className="history-incomplete">Incomplete</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {detailLoading && <div className="history-loading-overlay">Loading session…</div>}
      </div>
    </div>
  )
}

function SessionDetail({ session, onBack }) {
  const [tab, setTab] = useState('report')
  const report = session.report || {}
  const score = report.final_score ?? 0
  const passed = report.passed ?? false
  const passingMarks = report.passing_marks ?? 70
  const topicExpls = report.session_explanation?.topic_explanations ?? []

  return (
    <div className="history-screen">
      <header className="alm-header">
        <div className="alm-logo-area">
          <button className="btn-ghost btn-sm" onClick={onBack}>← Back</button>
          <span className="alm-logo-text" style={{marginLeft:8}}>{session.title}</span>
        </div>
        <div className="alm-header-actions">
          <span className="history-detail-date">
            {session.created_at ? new Date(session.created_at).toLocaleString() : ''}
          </span>
        </div>
      </header>
      <div className="history-card history-detail-card">
        <div className="history-tabs">
          <button className={`history-tab ${tab === 'report' ? 'active' : ''}`} onClick={() => setTab('report')}>Report</button>
          <button className={`history-tab ${tab === 'transcript' ? 'active' : ''}`} onClick={() => setTab('transcript')}>Transcript</button>
        </div>

        {tab === 'report' && (
          <div className="history-report">
            {report.final_score == null ? (
              <p className="history-empty">No report available for this session.</p>
            ) : score === 0 && topicExpls.length === 0 ? (
              <div className="report-empty">
                <h3>Session Too Short to Evaluate</h3>
                <p>The conversation didn't have enough content for a meaningful assessment. Complete a full roleplay exchange to receive your score and detailed feedback.</p>
                <ul className="report-empty-tips">
                  <li>Respond to the AI's prompts with detailed answers</li>
                  <li>Cover the key topics outlined in the scenario</li>
                  <li>Aim for at least 3–5 back-and-forth exchanges</li>
                </ul>
              </div>
            ) : (
              <>
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

                {report.session_explanation?.summary && (
                  <div className="report-summary"><p>{report.session_explanation.summary}</p></div>
                )}

                {topicExpls.length > 0 && (
                  <div className="report-topics">
                    <h3>Topic Breakdown</h3>
                    {topicExpls.map((t, i) => (
                      <div key={i} className={`report-topic-card ${t.make_or_break_failed ? 'mob-failed' : ''}`}>
                        <div className="rpt-header">
                          <span className="rpt-name">{t.topic}</span>
                          <span className={`rpt-score ${t.score_pct >= 66 ? 'good' : t.score_pct >= 33 ? 'mid' : 'bad'}`}>
                            {Math.round(t.score_pct)}%
                          </span>
                        </div>
                        <div className="rpt-bar">
                          <div className="rpt-bar-fill" style={{ width: `${Math.min(t.score_pct, 100)}%` }} />
                        </div>
                        {t.explanation && <p className="rpt-explanation">{t.explanation}</p>}
                        {t.covered_criteria?.length > 0 && (
                          <ul className="rpt-criteria-list covered">
                            {t.covered_criteria.map((c, j) => <li key={j}><span className="crit-icon crit-pass"></span>{c}</li>)}
                          </ul>
                        )}
                        {t.missed_criteria?.length > 0 && (
                          <ul className="rpt-criteria-list missed">
                            {t.missed_criteria.map((c, j) => <li key={j}><span className="crit-icon crit-fail"></span>{c}</li>)}
                          </ul>
                        )}
                        {t.gap && (
                          <div className="rpt-gap">
                            <span className="rpt-gap-label">Tip</span>
                            <span>{t.gap}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'transcript' && (
          <div className="history-transcript">
            {session.transcript.length === 0 && <p className="history-empty">No transcript available.</p>}
            {session.transcript.map((t, i) => (
              <div key={i} className={`transcript-turn ${t.speaker === 'AI' ? 'ai' : 'user'}`}>
                <span className="transcript-speaker">{t.speaker}</span>
                <p className="transcript-text">{t.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
