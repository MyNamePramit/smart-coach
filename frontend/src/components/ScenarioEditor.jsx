import { useState, useRef, useEffect } from 'react'
import { generateScenario } from '../api.js'

// ── Templates ────────────────────────────────────────────────────────────────

const emptyTopic = () => ({
  topic: '',
  evaluation_guidelines: '',
  success_criteria: [''],
  weight: 25,
  make_or_break: false,
  make_or_break_threshold: 0.2,
  example_videos: [],
  helpful_links: [],
})

const emptyConcern = () => ({
  concern: '',
  when_it_comes_up: '',
  how_persona_frames_it: '',
  good_enough_to_proceed_when: '',
})

const defaultForm = () => ({
  id: `custom-${Date.now()}`,
  label: '',
  description: '',
  session_mode: 'text',
  payload: {
    author: 'user',
    conversation_context: '',
    ai_persona: {
      name: '',
      role: '',
      organization: '',
      personality: '',
      background_information: '',
      concerns: [],
    },
    evaluation_topics: [emptyTopic()],
    additional_settings: {
      difficulty_mode: 'off',
      roleplay_end: {
        allow_ai_to_end_roleplay: false,
        end_condition: '',
        goodbye_message: '',
      },
      simulation_time_limit: {
        enabled: false,
        duration_minutes: 20,
        warning_minutes: 5,
      },
      short_session_penalty: {
        enabled: false,
        minimum_session_minutes: 5,
        penalty_points: 20,
      },
    },
    passing_marks: 70,
    tts_enabled: true,
    tts_lang: 'en',
  },
})

// ── Field — two-column ALM row by default, compact when inside a card ────────

function Field({ label, children, hint, error, required, compact, inline }) {
  if (compact) {
    return (
      <div className={`ed-field ${inline ? 'ed-field-inline' : ''}`}>
        {label && (
          <label className="ed-label">
            {label}{required && <span className="ed-req"> *</span>}
          </label>
        )}
        {hint && <p className="ed-hint">{hint}</p>}
        {children}
        {error && <p className="ed-error">{error}</p>}
      </div>
    )
  }
  return (
    <div className="ed-form-row">
      <div className="ed-form-label-col">
        {label && (
          <span className="ed-form-label">
            {label}{required && <span className="ed-req"> *</span>}
          </span>
        )}
        {hint && <p className="ed-form-hint">{hint}</p>}
        {error && <p className="ed-form-error">{error}</p>}
      </div>
      <div className="ed-form-control-col">
        {children}
      </div>
    </div>
  )
}

// ── Section ──────────────────────────────────────────────────────────────────

function EdSection({ id, title, children, action }) {
  return (
    <section id={id} className="ed-section">
      <div className="ed-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ScenarioEditor({ initial, onSave, onCancel, readOnly = false }) {
  const [form, setForm] = useState(() =>
    initial ? JSON.parse(JSON.stringify(initial)) : defaultForm()
  )
  const [errors, setErrors] = useState({})
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState('')
  const [genAiOpen, setGenAiOpen] = useState(false)
  const [genPrompt, setGenPrompt] = useState('')
  const [genLoading, setGenLoading] = useState(false)
  const [genError, setGenError] = useState('')
  const fileInputRef  = useRef(null)
  const thumbInputRef = useRef(null)
  const bodyRef       = useRef(null)
  const [activeSection, setActiveSection] = useState('section-info')

  const SECTIONS = ['section-info', 'section-context', 'section-persona', 'section-topics', 'section-settings', 'section-import']

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onScroll = () => {
      const containerTop = el.getBoundingClientRect().top
      const threshold = el.clientHeight * 0.4
      let active = SECTIONS[0]
      for (const id of SECTIONS) {
        const section = document.getElementById(id)
        if (!section) continue
        if (section.getBoundingClientRect().top - containerTop <= threshold) active = id
      }
      setActiveSection(active)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleThumbnailUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => setForm(f => ({ ...f, thumbnail: ev.target.result }))
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const p   = form.payload
  const re  = p.additional_settings.roleplay_end
  const tl  = p.additional_settings.simulation_time_limit
  const sp  = p.additional_settings.short_session_penalty

  // ── Update helpers ──────────────────────────────────────────────────────────

  const setPayload = (updates) =>
    setForm(f => ({ ...f, payload: { ...f.payload, ...updates } }))

  const setPersona = (updates) =>
    setPayload({ ai_persona: { ...p.ai_persona, ...updates } })

  const setAdditional = (key, updates) =>
    setPayload({
      additional_settings: {
        ...p.additional_settings,
        [key]: { ...p.additional_settings[key], ...updates },
      },
    })

  // Concerns
  const addConcern = () =>
    setPersona({ concerns: [...p.ai_persona.concerns, emptyConcern()] })
  const removeConcern = (i) =>
    setPersona({ concerns: p.ai_persona.concerns.filter((_, idx) => idx !== i) })
  const updateConcern = (i, key, val) => {
    const concerns = [...p.ai_persona.concerns]
    concerns[i] = { ...concerns[i], [key]: val }
    setPersona({ concerns })
  }

  // Topics
  const addTopic = () =>
    setPayload({ evaluation_topics: [...p.evaluation_topics, emptyTopic()] })
  const removeTopic = (i) =>
    setPayload({ evaluation_topics: p.evaluation_topics.filter((_, idx) => idx !== i) })
  const updateTopic = (i, key, val) => {
    const topics = [...p.evaluation_topics]
    topics[i] = { ...topics[i], [key]: val }
    setPayload({ evaluation_topics: topics })
  }

  // Criteria
  const addCriterion = (ti) => {
    const topics = [...p.evaluation_topics]
    topics[ti] = { ...topics[ti], success_criteria: [...topics[ti].success_criteria, ''] }
    setPayload({ evaluation_topics: topics })
  }
  const removeCriterion = (ti, ci) => {
    const topics = [...p.evaluation_topics]
    topics[ti] = {
      ...topics[ti],
      success_criteria: topics[ti].success_criteria.filter((_, i) => i !== ci),
    }
    setPayload({ evaluation_topics: topics })
  }
  const updateCriterion = (ti, ci, val) => {
    const topics = [...p.evaluation_topics]
    const crit = [...topics[ti].success_criteria]
    crit[ci] = val
    topics[ti] = { ...topics[ti], success_criteria: crit }
    setPayload({ evaluation_topics: topics })
  }

  // ── JSON import ─────────────────────────────────────────────────────────────

  const applyJson = (text) => {
    setJsonError('')
    try {
      const parsed = JSON.parse(text)
      const isFullScenario = parsed.payload && parsed.label !== undefined
      const payload = isFullScenario ? parsed.payload : parsed
      const label   = isFullScenario ? parsed.label       : (form.label || '')
      const desc    = isFullScenario ? (parsed.description || '') : (form.description || '')

      // Normalise concerns: accept plain strings or full objects
      const rawConcerns = payload.ai_persona?.concerns ?? []
      const normConcerns = rawConcerns.map(c =>
        typeof c === 'string'
          ? { ...emptyConcern(), concern: c }
          : { ...emptyConcern(), ...c }
      )

      const base = defaultForm()
      setForm({
        ...base,
        id: isFullScenario ? (parsed.id || base.id) : base.id,
        label,
        description: desc,
        session_mode: isFullScenario ? (parsed.session_mode || base.session_mode) : base.session_mode,
        payload: {
          ...base.payload,
          ...payload,
          ai_persona: { ...base.payload.ai_persona, ...(payload.ai_persona || {}), concerns: normConcerns },
          additional_settings: {
            ...base.payload.additional_settings,
            ...(payload.additional_settings || {}),
            roleplay_end: {
              ...base.payload.additional_settings.roleplay_end,
              ...(payload.additional_settings?.roleplay_end || {}),
            },
            simulation_time_limit: {
              ...base.payload.additional_settings.simulation_time_limit,
              ...(payload.additional_settings?.simulation_time_limit || {}),
            },
            short_session_penalty: {
              ...base.payload.additional_settings.short_session_penalty,
              ...(payload.additional_settings?.short_session_penalty || {}),
            },
          },
        },
      })
      setErrors({})
    } catch (e) {
      setJsonError(`Invalid JSON: ${e.message}`)
    }
  }

  const handleJsonPaste = (e) => {
    const text = e.target.value
    setJsonText(text)
    if (text.trim()) applyJson(text)
    else setJsonError('')
  }

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target.result
      setJsonText(text)
      applyJson(text)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  // ── Validation ──────────────────────────────────────────────────────────────

  const validate = () => {
    const errs = {}
    if (!form.label.trim())                          errs.label = 'Required'
    if (!p.conversation_context.trim())              errs.context = 'Required'
    if (!p.ai_persona.name.trim())                   errs.persona_name = 'Required'
    if (!p.ai_persona.role.trim())                   errs.persona_role = 'Required'
    if (!p.ai_persona.background_information.trim()) errs.background = 'Required'
    if (p.evaluation_topics.length === 0)            errs.topics = 'Add at least one topic'

    p.evaluation_topics.forEach((t, i) => {
      if (!t.topic.trim())               errs[`tn_${i}`] = 'Required'
      if (!t.evaluation_guidelines.trim()) errs[`tg_${i}`] = 'Required'
      if (t.success_criteria.filter(c => c.trim()).length === 0)
        errs[`tc_${i}`] = 'Add at least one criterion'
      if (!t.weight || t.weight <= 0) errs[`tw_${i}`] = 'Must be > 0'
    })

    if (re.allow_ai_to_end_roleplay && !re.end_condition.trim())
      errs.end_condition = 'Required when AI can end roleplay'
    if (tl.enabled && !tl.duration_minutes)
      errs.duration = 'Required'
    if (sp.enabled && (!sp.minimum_session_minutes || !sp.penalty_points))
      errs.penalty = 'Both fields required'

    return errs
  }

  const handleGenAi = async () => {
    if (!genPrompt.trim()) return
    setGenLoading(true)
    setGenError('')
    try {
      const result = await generateScenario(genPrompt.trim())
      applyJson(JSON.stringify(result))
      setGenAiOpen(false)
      setGenPrompt('')
    } catch (e) {
      setGenError(e.message)
    } finally {
      setGenLoading(false)
    }
  }

  const handleSave = () => {
    const errs = validate()
    if (Object.keys(errs).length) {
      setErrors(errs)
      document.querySelector('.ed-form-error,.ed-error')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    const cleaned = {
      ...form,
      payload: {
        ...p,
        evaluation_topics: p.evaluation_topics.map(t => ({
          ...t,
          success_criteria: t.success_criteria.filter(c => c.trim()),
        })),
      },
    }
    onSave(cleaned)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="editor-screen">
      {/* GenAI modal */}
      {genAiOpen && (
        <div className="popup-overlay">
          <div className="popup-card genai-modal">
            <h3 className="popup-title">Create with GenAI</h3>
            <p className="popup-body">Describe the scenario you want and the AI will generate it for you.</p>
            <textarea
              className="genai-prompt-input"
              rows={4}
              placeholder="e.g. A sales intern practising how to offer internet plans to a reluctant household customer who is happy with their current provider"
              value={genPrompt}
              onChange={e => setGenPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenAi() }}
              autoFocus
              disabled={genLoading}
            />
            {genLoading ? (
              <div className="genai-loading">
                <div className="genai-loading-orbs">
                  <span /><span /><span />
                </div>
                <p className="genai-loading-label">Designing your scenario…</p>
                <p className="genai-loading-sub">Building persona, context, and evaluation topics</p>
              </div>
            ) : (
              <>
                {genError && <p className="ed-form-error" style={{ marginTop: 6 }}>{genError}</p>}
                <div className="popup-actions">
                  <button className="btn-ghost" onClick={() => { setGenAiOpen(false); setGenPrompt(''); setGenError('') }}>
                    Cancel
                  </button>
                  <button className="btn-primary" onClick={handleGenAi} disabled={!genPrompt.trim()}>
                    Generate
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Fixed header */}
      <div className="editor-topbar">
        <button className="btn-ghost" onClick={onCancel}>Back</button>
        <h2 className="editor-title">
          {readOnly ? 'View Scenario' : (initial ? 'Edit Scenario' : 'New Scenario')}
        </h2>
        <div className="editor-topbar-actions">
          {!readOnly && !initial && (
            <button className="btn-genai btn-sm" onClick={() => setGenAiOpen(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="15" height="15">
                <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
              </svg>
              Create with GenAI
            </button>
          )}
          {readOnly ? (
            <span className="editor-readonly-badge">Read Only</span>
          ) : (
            <button className="btn-primary btn-sm" onClick={handleSave}>Save Scenario</button>
          )}
        </div>
      </div>

      <div className="editor-layout">
        {/* Left nav (ALM-style sidebar) */}
        <nav className="editor-nav">
          {[
            ['section-info',     'Overview'],
            ['section-context',  'Context'],
            ['section-persona',  'AI Persona'],
            ['section-topics',   'Evaluation'],
            ['section-settings', 'Settings'],
            ...(!readOnly ? [['section-import', 'Import JSON']] : []),
          ].map(([id, label]) => (
            <a key={id} href={`#${id}`}
              className={`editor-nav-item ${activeSection === id ? 'active' : ''}`}>
              {label}
            </a>
          ))}
        </nav>

        {/* Right form body */}
        <div className="editor-body" ref={bodyRef}>
          <fieldset disabled={readOnly} style={{ border: 'none', padding: 0, margin: 0, display: 'contents' }}>

          {/* ── 1. Scenario Info ── */}
          <EdSection id="section-info" title="Overview">
            <Field label="Scenario Name" required error={errors.label}>
              <input
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="e.g. System Design Interview"
              />
            </Field>

            <Field label="Brief Description" hint="Displayed on the scenario card.">
              <input
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="One-line description shown on the selection card"
              />
            </Field>

            <Field label="Thumbnail Image" hint="Optional. PNG or JPG, landscape recommended.">
              <input
                ref={thumbInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={handleThumbnailUpload}
              />
              <div className="ed-thumb-row">
                {form.thumbnail && (
                  <img
                    src={form.thumbnail}
                    alt="thumbnail preview"
                    className="ed-thumb-preview"
                  />
                )}
                <button type="button" className="btn-ghost btn-sm" onClick={() => thumbInputRef.current?.click()}>
                  {form.thumbnail ? 'Replace image' : 'Upload image'}
                </button>
                {form.thumbnail && (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setForm(f => ({ ...f, thumbnail: null }))}>
                    Remove
                  </button>
                )}
              </div>
            </Field>

            <Field label="Session Mode" hint="Determines how learners interact with this scenario.">
              <select
                value={form.session_mode || 'text'}
                onChange={e => setForm(f => ({ ...f, session_mode: e.target.value }))}
                style={{ maxWidth: 240 }}
              >
                <option value="text">Text chat</option>
                <option value="voice">Voice call</option>
              </select>
            </Field>
          </EdSection>

          {/* ── 2. Context ── */}
          <EdSection id="section-context" title="Conversation Context">
            <Field
              label="Context"
              required
              error={errors.context}
              hint="Sets the scene — who is meeting, the purpose, any relevant constraints."
            >
              <textarea
                rows={5}
                value={p.conversation_context}
                onChange={e => setPayload({ conversation_context: e.target.value })}
                placeholder="e.g. A senior engineer at a large tech company is interviewing a candidate for a staff role..."
              />
            </Field>
          </EdSection>

          {/* ── 3. AI Persona ── */}
          <EdSection id="section-persona" title="AI Persona">
            <Field label="Name" required error={errors.persona_name}>
              <input
                value={p.ai_persona.name}
                onChange={e => setPersona({ name: e.target.value })}
                placeholder="e.g. Alex"
                style={{ maxWidth: 320 }}
              />
            </Field>

            <Field label="Role" required error={errors.persona_role}>
              <input
                value={p.ai_persona.role}
                onChange={e => setPersona({ role: e.target.value })}
                placeholder="e.g. Senior Staff Engineer"
                style={{ maxWidth: 320 }}
              />
            </Field>

            <Field label="Organization">
              <input
                value={p.ai_persona.organization || ''}
                onChange={e => setPersona({ organization: e.target.value })}
                placeholder="Optional"
                style={{ maxWidth: 320 }}
              />
            </Field>

            <Field label="Personality" hint="Tone, style, and disposition the AI should adopt.">
              <textarea
                rows={3}
                value={p.ai_persona.personality || ''}
                onChange={e => setPersona({ personality: e.target.value })}
                placeholder="e.g. Technically rigorous, encouraging but expects depth"
              />
            </Field>

            <Field
              label="Background Information"
              required
              error={errors.background}
              hint="What the persona knows and cares about. Injected into every prompt."
            >
              <textarea
                rows={4}
                value={p.ai_persona.background_information}
                onChange={e => setPersona({ background_information: e.target.value })}
              />
            </Field>

            {/* Concerns */}
            <Field
              label="Concerns"
              hint="Objections or hesitations the persona holds during the conversation."
            >
              <div className="ed-list">
                {p.ai_persona.concerns.map((c, i) => (
                  <div key={i} className="ed-card">
                    <div className="ed-card-top">
                      <span className="ed-card-label">Concern {i + 1}</span>
                      <button className="btn-remove" onClick={() => removeConcern(i)}>Remove</button>
                    </div>
                    <Field compact label="Concern">
                      <input value={c.concern} onChange={e => updateConcern(i, 'concern', e.target.value)} placeholder="e.g. Migration complexity" />
                    </Field>
                    <Field compact label="When it comes up">
                      <input value={c.when_it_comes_up || ''} onChange={e => updateConcern(i, 'when_it_comes_up', e.target.value)} />
                    </Field>
                    <Field compact label="How the persona frames it">
                      <input value={c.how_persona_frames_it || ''} onChange={e => updateConcern(i, 'how_persona_frames_it', e.target.value)} />
                    </Field>
                    <Field compact label="Good enough to proceed when">
                      <input value={c.good_enough_to_proceed_when || ''} onChange={e => updateConcern(i, 'good_enough_to_proceed_when', e.target.value)} />
                    </Field>
                  </div>
                ))}
                <button className="btn-add" onClick={addConcern}>+ Add Concern</button>
              </div>
            </Field>
          </EdSection>

          {/* ── 4. Evaluation Topics ── */}
          <EdSection id="section-topics" title="Evaluation Topics">
            {errors.topics && <p className="ed-form-error" style={{ padding: '0 0 12px' }}>{errors.topics}</p>}

            <Field
              label="Topics"
              hint="Define what skills or behaviours will be evaluated and their relative weight."
            >
              <div className="ed-list">
                {p.evaluation_topics.map((t, ti) => (
                  <div key={ti} className="ed-card">
                    <div className="ed-card-top">
                      <span className="ed-card-label">Topic {ti + 1}</span>
                      {p.evaluation_topics.length > 1 && (
                        <button className="btn-remove" onClick={() => removeTopic(ti)}>Remove</button>
                      )}
                    </div>

                    <div className="ed-card-row">
                      <Field compact label="Topic Name" required error={errors[`tn_${ti}`]}>
                        <input
                          value={t.topic}
                          onChange={e => updateTopic(ti, 'topic', e.target.value)}
                          placeholder="e.g. Requirements Clarification"
                        />
                      </Field>
                      <Field compact label="Weight (%)" error={errors[`tw_${ti}`]}>
                        <input
                          type="number" min="1" max="100"
                          value={t.weight}
                          onChange={e => updateTopic(ti, 'weight', parseFloat(e.target.value) || 0)}
                          style={{ width: 80 }}
                        />
                      </Field>
                    </div>

                    <Field
                      compact
                      label="Evaluation Guidelines"
                      required
                      error={errors[`tg_${ti}`]}
                      hint="What behaviour the evaluator looks for."
                    >
                      <textarea
                        rows={2}
                        value={t.evaluation_guidelines}
                        onChange={e => updateTopic(ti, 'evaluation_guidelines', e.target.value)}
                      />
                    </Field>

                    {/* Success criteria */}
                    <div className="ed-subsection">
                      <div className="ed-sub-header">
                        <span>Success Criteria</span>
                        <button className="btn-add btn-sm" onClick={() => addCriterion(ti)}>+ Add</button>
                      </div>
                      {errors[`tc_${ti}`] && <p className="ed-error">{errors[`tc_${ti}`]}</p>}
                      {t.success_criteria.map((crit, ci) => (
                        <div key={ci} className="ed-criterion-row">
                          <input
                            value={crit}
                            onChange={e => updateCriterion(ti, ci, e.target.value)}
                            placeholder="e.g. Ask about expected scale or number of users"
                          />
                          {t.success_criteria.length > 1 && (
                            <button className="btn-remove-sm" onClick={() => removeCriterion(ti, ci)}>✕</button>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Make or break */}
                    <label className="ed-toggle-row">
                      <input
                        type="checkbox"
                        checked={t.make_or_break}
                        onChange={e => updateTopic(ti, 'make_or_break', e.target.checked)}
                      />
                      <span>Make or break — session fails if this topic is not covered</span>
                    </label>
                    {t.make_or_break && (
                      <Field
                        compact
                        label="Coverage threshold (0 – 1)"
                        hint="Ratio below which the session is considered failed."
                        inline
                      >
                        <input
                          type="number" min="0" max="1" step="0.05"
                          value={t.make_or_break_threshold}
                          onChange={e => updateTopic(ti, 'make_or_break_threshold', parseFloat(e.target.value) || 0)}
                          style={{ width: 80 }}
                        />
                      </Field>
                    )}
                  </div>
                ))}
                <button className="btn-add" onClick={addTopic}>+ Add Topic</button>
              </div>
            </Field>
          </EdSection>

          {/* ── 5. Session Settings ── */}
          <EdSection id="section-settings" title="Session Settings">

            <Field
              label="Difficulty Mode"
              hint="Controls how the AI persona adapts its resistance to challenge the learner. Auto-detect profiles the learner's style after 3 turns (heuristic first, one LLM call only if needed) and locks in a counter-personality for the rest of the session."
            >
              <select
                value={p.additional_settings.difficulty_mode || 'off'}
                onChange={e => setPayload({
                  additional_settings: { ...p.additional_settings, difficulty_mode: e.target.value }
                })}
                style={{ maxWidth: 280 }}
              >
                <option value="off">Off — balanced, no adaptation</option>
                <option value="impatient">Impatient — cuts off rambling, wants the bottom line</option>
                <option value="skeptical">Skeptical — challenges every claim, asks for proof</option>
                <option value="evasive">Evasive — deflects direct questions, hard to pin down</option>
                <option value="hostile">Hostile — adversarial, hints at competitor</option>
                <option value="auto">Auto-detect — mirrors learner weakness from turn 4</option>
              </select>
            </Field>

            <Field label="Passing Score" hint="Minimum score out of 100 required to pass.">
              <input
                type="number" min="0" max="100"
                value={p.passing_marks}
                onChange={e => setPayload({ passing_marks: parseFloat(e.target.value) || 0 })}
                style={{ width: 100 }}
              />
            </Field>

            <Field label="TTS Language" hint="Text-to-speech voice language for AI responses.">
              <select value={p.tts_lang} onChange={e => setPayload({ tts_lang: e.target.value })} style={{ maxWidth: 200 }}>
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="hi">Hindi</option>
                <option value="ja">Japanese</option>
                <option value="pt">Portuguese</option>
              </select>
            </Field>

            <Field label="AI-Ended Roleplay" hint="Allow the AI to close the session when satisfied.">
              <label className="ed-toggle-row" style={{ marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={re.allow_ai_to_end_roleplay}
                  onChange={e => setAdditional('roleplay_end', { allow_ai_to_end_roleplay: e.target.checked })}
                />
                <span>Allow AI to end the roleplay when satisfied</span>
              </label>
              {re.allow_ai_to_end_roleplay && (
                <div className="ed-indent">
                  <Field compact label="End condition" required error={errors.end_condition} hint="Describe when the AI should wrap up.">
                    <textarea
                      rows={2}
                      value={re.end_condition}
                      onChange={e => setAdditional('roleplay_end', { end_condition: e.target.value })}
                      placeholder="e.g. The interviewer is satisfied and has no more questions."
                    />
                  </Field>
                  <Field compact label="Goodbye message (optional)">
                    <input
                      value={re.goodbye_message || ''}
                      onChange={e => setAdditional('roleplay_end', { goodbye_message: e.target.value })}
                      placeholder="Custom closing message from the AI"
                    />
                  </Field>
                </div>
              )}
            </Field>

            <Field label="Time Limit" hint="Cap the session at a fixed duration.">
              <label className="ed-toggle-row" style={{ marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={tl.enabled}
                  onChange={e => setAdditional('simulation_time_limit', { enabled: e.target.checked })}
                />
                <span>Enable session time limit</span>
              </label>
              {tl.enabled && (
                <div className="ed-indent ed-inline-fields">
                  <Field compact label="Duration (mins)" error={errors.duration} inline>
                    <input
                      type="number" min="1" max="59"
                      value={tl.duration_minutes}
                      onChange={e => setAdditional('simulation_time_limit', { duration_minutes: parseInt(e.target.value) || 1 })}
                      style={{ width: 72 }}
                    />
                  </Field>
                  <Field compact label="Warn when X mins remain" inline>
                    <input
                      type="number" min="0" max="58"
                      value={tl.warning_minutes}
                      onChange={e => setAdditional('simulation_time_limit', { warning_minutes: parseInt(e.target.value) || 0 })}
                      style={{ width: 72 }}
                    />
                  </Field>
                </div>
              )}
            </Field>

            <Field label="Short Session Penalty" hint="Deduct points if the session ends too quickly.">
              <label className="ed-toggle-row" style={{ marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={sp.enabled}
                  onChange={e => setAdditional('short_session_penalty', { enabled: e.target.checked })}
                />
                <span>Penalise sessions that end too quickly</span>
              </label>
              {sp.enabled && (
                <div className="ed-indent ed-inline-fields">
                  <Field compact label="Min length (mins)" error={errors.penalty} inline>
                    <input
                      type="number" min="1" max="59"
                      value={sp.minimum_session_minutes}
                      onChange={e => setAdditional('short_session_penalty', { minimum_session_minutes: parseInt(e.target.value) || 1 })}
                      style={{ width: 72 }}
                    />
                  </Field>
                  <Field compact label="Deduct points" inline>
                    <input
                      type="number" min="1" max="100"
                      value={sp.penalty_points}
                      onChange={e => setAdditional('short_session_penalty', { penalty_points: parseFloat(e.target.value) || 0 })}
                      style={{ width: 72 }}
                    />
                  </Field>
                </div>
              )}
            </Field>
          </EdSection>

          {/* ── 6. JSON Import — hidden in read-only mode ── */}
          {!readOnly && (
            <EdSection id="section-import" title="Import from JSON">
              <Field
                label="Paste JSON"
                hint="Paste a scenario JSON or bare payload — form fields will populate automatically."
              >
                <div className="json-import-row">
                  {jsonError && <p className="ed-form-error">{jsonError}</p>}
                  <textarea
                    className="json-textarea"
                    rows={5}
                    value={jsonText}
                    onChange={handleJsonPaste}
                    placeholder={'{\n  "conversation_context": "...",\n  "ai_persona": { ... },\n  ...\n}'}
                    spellCheck={false}
                  />
                  <div className="json-import-actions">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json,application/json"
                      style={{ display: 'none' }}
                      onChange={handleFileUpload}
                    />
                    <button className="btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()}>
                      Upload JSON file
                    </button>
                    {jsonText && (
                      <button className="btn-ghost btn-sm" onClick={() => { setJsonText(''); setJsonError('') }}>
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </Field>
            </EdSection>
          )}

          </fieldset>
        </div>
      </div>

      {/* Sticky footer — hidden in read-only mode */}
      {!readOnly && (
        <div className="editor-footer">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>Save Scenario</button>
        </div>
      )}
    </div>
  )
}
