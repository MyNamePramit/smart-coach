import { useState, useEffect, useRef, useCallback } from 'react'
import { sendMessageStream, endSession, beginSession, transcribeAudio } from '../api.js'
import useSessionClosedPoll from '../hooks/useSessionClosedPoll.js'
import useLearnerElapsed from '../hooks/useLearnerElapsed.js'

const MAX_RECORDING_MS   = 25000 // force-stop after 25s regardless of silence
const USE_DEEPGRAM       = true  // set false to fall back to Whisper batch mode

function fmt(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0')
  const s = String(secs % 60).padStart(2, '0')
  return `${m}:${s}`
}

export default function VoiceCall({ session, scenario, openingMessage, openingTtsUrl, briefingTtsUrl, onCallEnd, onReport, sessionStart, timeLimitMinutes, warningMinutes }) {
  const [callStatus, setCallStatus]     = useState('idle')
  const [, setTranscript]               = useState([])
  const [subtitleWords, setSubtitleWords] = useState([])   // full word array for current AI turn
  const [subtitleVisible, setSubtitleVisible] = useState(0) // how many words are shown
  const [isSpeaking, setIsSpeaking]     = useState(false)
  const [error, setError]               = useState(null)
  const [earlyClosePopup, setEarlyClosePopup] = useState(false)
  const [timeExpiredReport, setTimeExpiredReport] = useState(null)
  const [profanityWarning, setProfanityWarning] = useState(null) // { count, terminated, report }
  const [showWarning, setShowWarning]   = useState(false)
  const [showOffTopic, setShowOffTopic] = useState(false)
  const [analysing, setAnalysing]       = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [cameraStatus, setCameraStatus] = useState('pending') // pending|granted|denied
  const [isBriefing, setIsBriefing]     = useState(!!briefingTtsUrl)
  const [showSubtitles, setShowSubtitles] = useState(true)
  const [muted, setMuted]               = useState(false)
  const [rmsLevel, setRmsLevel]         = useState(0)

  const sessionStartRef  = useRef(sessionStart ?? Date.now())
  const warnedRef        = useRef(false)
  const expiredRef       = useRef(false)

  // Count only while learner is active — paused during briefing, AI processing, AI speaking
  const learnerActive = !isBriefing && !analysing && !disconnecting && !timeExpiredReport &&
    (callStatus === 'idle' || callStatus === 'listening')
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
    if (!timeLimitMinutes || expiredRef.current || isBriefing || analysing) return
    if (elapsed >= timeLimitMinutes * 60) {
      expiredRef.current = true
      stopVad()
      audioRef.current?.pause()
      cameraStreamRef.current?.getTracks().forEach(t => t.stop())
      endSession(session.id).then(data => {
        const r = data.report ?? data
        setTimeExpiredReport({ ...r, time_expired: true })
      }).catch(() => {})
    }
  }, [elapsed, timeLimitMinutes, isBriefing, analysing]) // eslint-disable-line react-hooks/exhaustive-deps

  const isTurnInFlightRef = useRef(false)         // true while sendTurn awaits LLM

  const audioRef          = useRef(null)
  const userVideoRef      = useRef(null)
  const cameraStreamRef   = useRef(null)
  const mediaRecorderRef  = useRef(null)
  const micStreamRef      = useRef(null)
  const audioContextRef   = useRef(null)
  const statusRef         = useRef('idle')
  const ttsQueueRef       = useRef([])
  const ttsPlayingRef     = useRef(false)
  const pendingAiTextRef  = useRef('') // kept for briefing/opening path
  const pendingOpeningRef = useRef(null)
  const sendTurnRef       = useRef(null)
  const isBriefingRef     = useRef(!!briefingTtsUrl)
  const recordingAbortRef = useRef(false)
  const mutedRef          = useRef(false)
  const vadActiveRef      = useRef(false)   // true while VAD loop is running
  const vadStreamRef      = useRef(null)    // persistent mic stream for VAD
  const aiSpeakingEndRef  = useRef(0)       // timestamp when AI last finished speaking
  const transcribingRef   = useRef(false)   // true while a transcription is in flight
  const stopAndSendRef    = useRef(null)    // set by VAD loop so mute can trigger immediate send
  const handleAudioEndRef = useRef(null)    // forward ref to break circular dep with playWhenReady
  const isSpeakingRef     = useRef(false)   // true while AI audio is playing — blocks Deepgram sends
  const [showBgNoise, setShowBgNoise] = useState(false)
  const bgNoiseTimerRef   = useRef(null)
  const wsRef             = useRef(null)    // Deepgram WebSocket
  const [pttMode, setPttMode]   = useState(false) // noisy env detected → push-to-talk
  const [pttActive, setPttActive] = useState(false) // spacebar / touch held
  const pttModeRef        = useRef(false)
  const pttActiveRef      = useRef(false)
  const [interimText, setInterimText] = useState('')  // live partial transcript

  const EARLY_CLOSE_THRESHOLD_MS = 2 * 60 * 1000

  // ── Camera ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then(s => {
        cameraStreamRef.current = s
        if (userVideoRef.current) userVideoRef.current.srcObject = s
        setCameraStatus('granted')
      })
      .catch(() => setCameraStatus('denied'))
    return () => {
      cameraStreamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ── Status ref sync ─────────────────────────────────────────────────────────

  const setStatus = useCallback((s) => {
    statusRef.current = s
    setCallStatus(s)
  }, [])

  // ── TTS queue ───────────────────────────────────────────────────────────────

  const resetSpeaking = useCallback(() => {
    ttsPlayingRef.current = false
    isSpeakingRef.current = false
    setIsSpeaking(false)
    setSubtitleVisible(0)
    setSubtitleWords([])
    aiSpeakingEndRef.current = Date.now() // mark when AI finished — VAD cooldown
    // If a turn is still awaiting the LLM response, show 'processing' not 'idle'.
    // This covers the gap between filler ending and the first real TTS chunk arriving.
    setStatus(isTurnInFlightRef.current ? 'processing' : 'idle')
  }, [setStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  const playWhenReady = useCallback((url) => {
    if (!audioRef.current) return
    // Base64 inline audio: "wav:<b64>" or "mp3:<b64>"
    if (url && (url.startsWith('wav:') || url.startsWith('mp3:'))) {
      const [fmt, b64] = url.split(':', 2)
      const mime = fmt === 'wav' ? 'audio/wav' : 'audio/mpeg'
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: mime })
      const blobUrl = URL.createObjectURL(blob)
      audioRef.current._blobUrl = blobUrl  // stored for revoke in handleAudioEnd
      audioRef.current.src = blobUrl
      audioRef.current.play().catch(() => resetSpeaking())
      return
    }
    // Fallback: legacy file URL with polling
    fetch(url, { method: 'HEAD' })
      .then(res => {
        if (res.ok) {
          audioRef.current.src = url
          audioRef.current.play().catch(() => resetSpeaking())
        } else {
          resetSpeaking()
        }
      })
      .catch(() => resetSpeaking())
  }, [resetSpeaking]) // eslint-disable-line react-hooks/exhaustive-deps

  const startSubtitle = useCallback((text) => {
    const words = text.trim().split(/\s+/).filter(Boolean)
    setSubtitleWords(words)
    setSubtitleVisible(0)
  }, [])

  const flushTtsQueue = useCallback(() => {
    if (ttsPlayingRef.current || !ttsQueueRef.current.length) return
    ttsQueueRef.current.sort((a, b) => a.idx - b.idx)
    const next = ttsQueueRef.current.shift()
    if (!next || !audioRef.current) return
    ttsPlayingRef.current = true
    // Use per-chunk text if available, fall back to buffered full reply (briefing/opening path)
    const text = next.text || pendingAiTextRef.current
    if (text) {
      startSubtitle(text)
      pendingAiTextRef.current = ''
    }
    isSpeakingRef.current = true
    setIsSpeaking(true)
    setStatus('speaking')
    playWhenReady(next.url)
  }, [setStatus, playWhenReady, startSubtitle])

  const enqueueTts = useCallback((idx, url, text) => {
    ttsQueueRef.current.push({ idx, url, text: text || '' })
    flushTtsQueue()
  }, [flushTtsQueue])

  const handleAudioEnd = useCallback(() => {
    ttsPlayingRef.current = false
    if (audioRef.current?._blobUrl) {
      URL.revokeObjectURL(audioRef.current._blobUrl)
      audioRef.current._blobUrl = null
    }
    // After briefing ends, swap to AI persona and play opening
    if (pendingOpeningRef.current) {
      const { message, ttsUrl } = pendingOpeningRef.current
      pendingOpeningRef.current = null
      setIsBriefing(false)
      beginSession(session.id).catch(() => {})
      startSubtitle(message)
      setIsSpeaking(true)
      setStatus('speaking')
      ttsPlayingRef.current = true
      playWhenReady(ttsUrl)
      return
    }
    if (ttsQueueRef.current.length) flushTtsQueue()
    else resetSpeaking()
  }, [flushTtsQueue, resetSpeaking, playWhenReady, startSubtitle])
  useEffect(() => { handleAudioEndRef.current = handleAudioEnd }, [handleAudioEnd])

  // ── Opening message (AI speaks first) ───────────────────────────────────────

  useEffect(() => {
    if (!openingMessage) return
    setTranscript([{ role: 'ai', text: openingMessage }])
    if (briefingTtsUrl && openingTtsUrl) {
      // Play mediator briefing first (no subtitles), then opening
      pendingOpeningRef.current = { message: openingMessage, ttsUrl: openingTtsUrl }
      ttsPlayingRef.current = true
      setIsSpeaking(true)
      setStatus('speaking')
      playWhenReady(briefingTtsUrl)
    } else if (openingTtsUrl) {
      ttsPlayingRef.current = true
      startSubtitle(openingMessage)
      setIsSpeaking(true)
      setStatus('speaking')
      playWhenReady(openingTtsUrl)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Always-on VAD + Whisper recorder ────────────────────────────────────────
  // One persistent mic stream; VAD detects speech onset, records until silence,
  // transcribes, then loops. Mute suppresses both recording and VAD highlight.

  const stopVad = useCallback(() => {
    vadActiveRef.current = false
    if (wsRef.current) {
      try { wsRef.current.close() } catch {}
      wsRef.current = null
    }
    if (mediaRecorderRef.current?.state === 'recording') {
      try { mediaRecorderRef.current.stop() } catch {}
    }
    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    vadStreamRef.current?.getTracks().forEach(t => t.stop())
    vadStreamRef.current = null
    micStreamRef.current?.getTracks().forEach(t => t.stop())
    micStreamRef.current = null
    setRmsLevel(0)
    setInterimText('')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const startVad = useCallback(async () => {
    if (vadActiveRef.current) return
    setError(null)
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('Microphone access denied.')
      return
    }
    vadStreamRef.current = stream
    vadActiveRef.current = true

    // ── Noise meter ─────────────────────────────────────────────────────────
    const ctx = new AudioContext()
    audioContextRef.current = ctx
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    // PTT hysteresis: enter when sustained background noise (rms 15-35) for 3 s,
    // exit when consistently quiet (rms < 15) for 5 s.
    let pttEntryStart = null
    let pttExitStart  = null
    const meterLoop = () => {
      if (!vadActiveRef.current) return
      analyser.getByteFrequencyData(dataArray)
      const rms = Math.sqrt(dataArray.reduce((s, v) => s + v * v, 0) / dataArray.length)
      setRmsLevel(rms)
      const canDetect = !mutedRef.current && !isBriefingRef.current
      const isBgNoise = canDetect && rms >= 15 && rms < 35

      if (!pttModeRef.current) {
        if (isBgNoise) {
          if (!pttEntryStart) pttEntryStart = Date.now()
          else if (Date.now() - pttEntryStart >= 3000) {
            pttEntryStart = null
            pttModeRef.current = true
            setPttMode(true)
          }
        } else pttEntryStart = null
      } else {
        // Already in PTT — exit once it's been quiet for 5 s
        if (rms < 15) {
          if (!pttExitStart) pttExitStart = Date.now()
          else if (Date.now() - pttExitStart >= 5000) {
            pttExitStart = null
            pttModeRef.current = false
            setPttMode(false)
          }
        } else pttExitStart = null
      }
      setTimeout(meterLoop, 100)
    }
    setTimeout(meterLoop, 100)

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm'

    if (!USE_DEEPGRAM) {
      // ── Whisper batch fallback ───────────────────────────────────────────
      const SILENCE_MS = 1500, SILENCE_THRESHOLD = 30, SPEECH_THRESHOLD = 35, SPEECH_ONSET_MS = 200
      let speechOnsetStart = null, silenceStart = null, recordingStart = null, chunks = []
      const stopAndSend = () => { setStatus('processing'); recordingStart = null; mediaRecorderRef.current.stop() }
      stopAndSendRef.current = stopAndSend
      const loop = () => {
        if (!vadActiveRef.current) return
        analyser.getByteFrequencyData(dataArray)
        const rms = Math.sqrt(dataArray.reduce((s, v) => s + v * v, 0) / dataArray.length)
        const isRecording = mediaRecorderRef.current?.state === 'recording'
        const aiCooldown = Date.now() - aiSpeakingEndRef.current < 1500
        const canRecord = !mutedRef.current && !isBriefingRef.current && !aiCooldown &&
          !transcribingRef.current && !(pttModeRef.current && !pttActiveRef.current) &&
          (statusRef.current === 'idle' || statusRef.current === 'listening')
        if (!isRecording) {
          if (rms >= SPEECH_THRESHOLD && canRecord) {
            if (!speechOnsetStart) speechOnsetStart = Date.now()
            else if (Date.now() - speechOnsetStart >= SPEECH_ONSET_MS) {
              speechOnsetStart = null; silenceStart = null; chunks = []
              const recorder = new MediaRecorder(stream, { mimeType })
              mediaRecorderRef.current = recorder
              recordingAbortRef.current = false
              recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
              recorder.onstop = async () => {
                if (recordingAbortRef.current) { setStatus('idle'); return }
                transcribingRef.current = true
                try {
                  const blob = new Blob(chunks, { type: mimeType })
                  const { text } = await transcribeAudio(blob)
                  transcribingRef.current = false
                  if (text?.trim()) {
                    sendTurnRef.current?.(text.trim())
                  } else setStatus('idle')
                } catch { setError('Transcription failed.'); setStatus('idle'); transcribingRef.current = false }
              }
              recorder.start(); recordingStart = Date.now(); setStatus('listening')
            }
          } else { speechOnsetStart = null }
        } else {
          if (recordingStart && Date.now() - recordingStart >= MAX_RECORDING_MS) { stopAndSend(); setTimeout(loop, 100); return }
          if (rms < SILENCE_THRESHOLD) {
            if (!silenceStart) silenceStart = Date.now()
            else if (Date.now() - silenceStart >= SILENCE_MS) { stopAndSend(); setTimeout(loop, 100); return }
          } else { silenceStart = null }
        }
        setTimeout(loop, 100)
      }
      setTimeout(loop, 100)
      return
    }

    // ── Deepgram real-time path ─────────────────────────────────────────────
    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${wsProto}://${window.location.host}/ws/transcribe/${session.id}`)
    wsRef.current = ws

    let finalBuffer = ''
    let recordingStart = null

    const stopAndSend = () => {
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
      recordingStart = null
    }
    stopAndSendRef.current = stopAndSend

    ws.onopen = () => {
      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = e => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN &&
            !mutedRef.current && !isSpeakingRef.current &&
            !(pttModeRef.current && !pttActiveRef.current)) {
          ws.send(e.data)
        }
      }
      recorder.start(250)
      recordingStart = Date.now()

      // Send keepalive every 7s whenever we're not streaming audio, to prevent
      // Deepgram's idle timeout (fires at ~10s with no audio or control frames).
      // Covers: AI speaking, AI processing, user muted, PTT armed-but-not-active.
      const keepaliveInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && statusRef.current !== 'listening') {
          ws.send(JSON.stringify({ type: 'KeepAlive' }))
        }
      }, 7000)
      ws.addEventListener('close', () => clearInterval(keepaliveInterval))
    }

    ws.onmessage = e => {
      const msg = JSON.parse(e.data)

      if (msg.type === 'error') { setError(`Deepgram: ${msg.detail}`); return }

      if (msg.type === 'speech_started') {
        const aiCooldown = Date.now() - aiSpeakingEndRef.current < 1500
        if (!mutedRef.current && !isBriefingRef.current && !aiCooldown && !isSpeakingRef.current &&
            !(pttModeRef.current && !pttActiveRef.current) &&
            (statusRef.current === 'idle' || statusRef.current === 'listening')) {
          setStatus('listening')
        }
      }

      if (msg.type === 'transcript' && !mutedRef.current && !isBriefingRef.current && !isSpeakingRef.current &&
          !(pttModeRef.current && !pttActiveRef.current)) {
        if (!msg.is_final) {
          setInterimText(finalBuffer ? finalBuffer + ' ' + msg.text : msg.text)
        } else {
          finalBuffer = finalBuffer ? finalBuffer + ' ' + msg.text : msg.text
          setInterimText(finalBuffer)
        }
      }

      if (msg.type === 'utterance_end') {
        const text = finalBuffer.trim()
        finalBuffer = ''
        setInterimText('')
        if (!text) return
        const aiCooldown = Date.now() - aiSpeakingEndRef.current < 1500
        if (mutedRef.current || isBriefingRef.current || aiCooldown || isSpeakingRef.current) return
        if (statusRef.current === 'idle' || statusRef.current === 'listening') {
          const speechStats = msg.word_count > 0 ? {
            filler_count: msg.filler_count ?? 0,
            filler_words: msg.filler_words ?? {},
            pace_wpm: msg.pace_wpm ?? null,
            word_count: msg.word_count ?? 0,
            duration_s: msg.duration_s ?? 0,
          } : null
          sendTurnRef.current?.(text, speechStats)
        }
      }

      // Force-send if recording too long
      if (recordingStart && Date.now() - recordingStart >= MAX_RECORDING_MS) {
        const text = finalBuffer.trim()
        finalBuffer = ''; setInterimText('')
        if (text) { setStatus('processing'); sendTurnRef.current?.(text) }
        recordingStart = Date.now()
      }
    }

    ws.onerror = () => setError('Deepgram connection failed.')
    ws.onclose = () => { wsRef.current = null }

  }, [session?.id, setStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  // Start VAD after briefing ends; stop on unmount
  useEffect(() => {
    if (!isBriefing) startVad()
  }, [isBriefing]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => { vadActiveRef.current = false; stopVad() }
  }, [stopVad])

  // ── Call-drop beep (Web Audio) ───────────────────────────────────────────────

  const playCallDropBeep = useCallback(() => {
    try {
      const ctx = new AudioContext()
      const beeps = [0, 0.35, 0.70]
      beeps.forEach((startAt) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.type = 'sine'
        osc.frequency.value = 480
        gain.gain.setValueAtTime(0.4, ctx.currentTime + startAt)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startAt + 0.25)
        osc.start(ctx.currentTime + startAt)
        osc.stop(ctx.currentTime + startAt + 0.25)
      })
      setTimeout(() => ctx.close(), 1500)
    } catch (_) {}
  }, [])

  // ── Send turn ────────────────────────────────────────────────────────────────

  const sendTurn = useCallback(async (text, speechStats = null) => {
    if (!text) { setStatus('idle'); return }
    // Ignore any input captured during Alice's briefing
    if (isBriefingRef.current) { setStatus('idle'); return }
    // Don't stomp 'speaking' if a filler is already playing — resetSpeaking will
    // transition to 'processing' if the queue empties before LLM responds.
    if (!ttsPlayingRef.current) setStatus('processing')
    isTurnInFlightRef.current = true
    setTranscript(prev => [...prev, { role: 'user', text }])

    try {
      let ttsReceived = false
      const data = await sendMessageStream(session.id, 'Learner', text, (url, idx, chunkText) => {
        ttsReceived = true
        enqueueTts(idx, url, chunkText)
      }, false, speechStats)

      if (data.profanity_blocked) {
        setTranscript(prev => prev.slice(0, -1))
        setProfanityWarning({ count: data.offense_count, terminated: data.profanity_terminated, report: data.report })
        setStatus('idle')
        return
      }

      if (data.off_topic) {
        setShowOffTopic(true)
        setTimeout(() => setShowOffTopic(false), 3500)
      }


      const reply = data.reply || ''
      setTranscript(prev => [...prev, { role: 'ai', text: reply }])

      const isEnd = data.ai_closed || data.report != null

      if (!ttsReceived) {
        setStatus('idle')
      }

      if (isEnd) {
        const waitAndReport = () => {
          if (ttsPlayingRef.current || ttsQueueRef.current.length) {
            setTimeout(waitAndReport, 300)
          } else {
            stopVad()
            setDisconnecting(true)
            setTimeout(() => {
              playCallDropBeep()
              setTimeout(() => {
                setDisconnecting(false)
                onReport(data.ai_closed ? null : data.report)
              }, 2200)
            }, 80)
          }
        }
        waitAndReport()
      }
    } catch (e) {
      if (e.message?.includes('already closed')) {
        try {
          const ended = await endSession(session.id)
          const r = ended.report ?? ended
          if (r?.time_expired) {
            stopVad()
            audioRef.current?.pause()
            setTimeExpiredReport(r)
          } else {
            onReport(r)
          }
        } catch {
          setStatus('idle')
        }
      } else {
        setError(e.message)
        setStatus('idle')
      }
    } finally {
      isTurnInFlightRef.current = false
    }
  }, [session.id, enqueueTts, onReport]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { isBriefingRef.current = isBriefing }, [isBriefing])
  useEffect(() => { sendTurnRef.current = sendTurn })

  // Poll for timer-triggered session close — only needed when scenario has a time limit
  useSessionClosedPoll(
    session.id,
    !!timeLimitMinutes && !analysing,
    (report) => {
      stopVad()
      audioRef.current?.pause()
      cameraStreamRef.current?.getTracks().forEach(t => t.stop())
      if (report.time_expired) {
        setTimeExpiredReport(report)
      } else {
        onReport(report)
      }
    }
  )

  // ── Push-to-talk: spacebar (desktop) ────────────────────────────────────────

  useEffect(() => {
    const activate = () => {
      if (!pttModeRef.current) return
      if (statusRef.current === 'speaking' || statusRef.current === 'processing') return
      pttActiveRef.current = true
      setPttActive(true)
    }
    const deactivate = () => {
      if (!pttModeRef.current || !pttActiveRef.current) return
      pttActiveRef.current = false
      setPttActive(false)
      if (!USE_DEEPGRAM && statusRef.current === 'listening') {
        stopAndSendRef.current?.()
      } else if (statusRef.current === 'listening') {
        // Drop the green border immediately; utterance_end fires ~1 s later and submits the text
        setStatus('idle')
      }
    }
    const onKeyDown = (e) => { if (e.code === 'Space' && !e.repeat) { e.preventDefault(); activate() } }
    const onKeyUp   = (e) => { if (e.code === 'Space') { e.preventDefault(); deactivate() } }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup',   onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup',   onKeyUp)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePttPointerDown = useCallback((e) => {
    e.preventDefault()
    if (!pttModeRef.current) return
    pttActiveRef.current = true
    setPttActive(true)
  }, [])

  const handlePttPointerUp = useCallback((e) => {
    e.preventDefault()
    if (!pttModeRef.current || !pttActiveRef.current) return
    pttActiveRef.current = false
    setPttActive(false)
    if (!USE_DEEPGRAM && statusRef.current === 'listening') {
      stopAndSendRef.current?.()
    } else if (statusRef.current === 'listening') {
      setStatus('idle')
    }
  }, [setStatus])

  // ── Mute toggle ──────────────────────────────────────────────────────────────

  const handleMuteToggle = () => {
    const nowMuted = !mutedRef.current
    mutedRef.current = nowMuted
    setMuted(nowMuted)
    if (nowMuted) {
      // Muting while listening — flush whatever was captured
      if (USE_DEEPGRAM) {
        // For Deepgram: clear interim, let utterance_end fire naturally
        setInterimText('')
      } else if (statusRef.current === 'listening' && mediaRecorderRef.current?.state === 'recording') {
        stopAndSendRef.current?.()
      }
    }
  }

  // ── End call ─────────────────────────────────────────────────────────────────

  const handleEndCall = () => {
    const elapsed = Date.now() - sessionStartRef.current
    if (elapsed < EARLY_CLOSE_THRESHOLD_MS) { setEarlyClosePopup(true); return }
    _doEnd()
  }

  const _doEnd = async () => {
    setEarlyClosePopup(false)
    stopVad()
    audioRef.current?.pause()
    cameraStreamRef.current?.getTracks().forEach(t => t.stop())
    setAnalysing(true)
    try {
      const data = await endSession(session.id)
      onReport(data.report ?? data)
    } catch {
      setAnalysing(false)
      onCallEnd()
    }
  }

  // ── Derived ──────────────────────────────────────────────────────────────────

  const personaName = scenario?.payload?.ai_persona?.name ?? 'AI'
  const personaRole = scenario?.payload?.ai_persona?.role ?? ''


  // Subtitle: AI speech only, word-by-word in sync with audio
  const subtitleText = isSpeaking && subtitleWords.length
    ? subtitleWords.slice(0, subtitleVisible).join(' ')
    : ''

  // ── Analysing screen ─────────────────────────────────────────────────────────

  if (analysing) {
    return (
      <div className="analysing-screen">
        <div className="analysing-card">
          <div className="analysing-spinner" />
          <p className="analysing-title">Analysing your session...</p>
          <p className="analysing-sub">Evaluating responses, scoring topics, and generating feedback</p>
        </div>
      </div>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="vc-screen">
      {showWarning && (
        <div className="time-warning-toast">{warningMinutes} minutes remaining</div>
      )}
      {showOffTopic && (
        <div className="off-topic-toast">Please keep the conversation relevant to this session</div>
      )}
      {showBgNoise && (
        <div className="bg-noise-toast">Background noise detected — consider muting when not speaking</div>
      )}
      <audio
        ref={audioRef}
        onEnded={handleAudioEnd}
        onError={resetSpeaking}
        onTimeUpdate={() => {
          const el = audioRef.current
          if (!el || !el.duration) return
          setSubtitleWords(words => {
            const progress = el.currentTime / el.duration
            setSubtitleVisible(Math.ceil(progress * words.length))
            return words
          })
        }}
        style={{ display: 'none' }}
      />

      {/* Time expired popup */}
      {timeExpiredReport && (
        <div className="popup-overlay">
          <div className="popup-card">
            <h3 className="popup-title">Time's up</h3>
            <p className="popup-body">The session time limit has been reached. Your responses have been recorded and will now be analysed.</p>
            <div className="popup-actions">
              <button className="btn-primary" onClick={() => { setTimeExpiredReport(null); onReport(timeExpiredReport) }}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* Profanity popup */}
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
                  stopVad()
                  audioRef.current?.pause()
                  cameraStreamRef.current?.getTracks().forEach(t => t.stop())
                  setProfanityWarning(null)
                  onReport(profanityWarning.report)
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

      {/* Early-close popup */}
      {earlyClosePopup && (
        <div className="popup-overlay">
          <div className="popup-card">
            <h3 className="popup-title">End call early?</h3>
            <p className="popup-body">
              Less than 2 minutes have elapsed. Ending now may result in an incomplete evaluation.
            </p>
            <div className="popup-actions">
              <button className="btn-ghost" onClick={() => setEarlyClosePopup(false)}>Keep going</button>
              <button className="btn-danger" onClick={_doEnd}>End anyway</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Top bar ── */}
      <div className="vc-topbar">
        <div className="vc-topbar-left">
          <span className="vc-scenario-label">{scenario?.label}</span>
          {scenario?.payload?.passing_marks && (
            <span className="vc-pass-badge">Pass score: {scenario.payload.passing_marks}</span>
          )}
        </div>
        <div className="vc-topbar-right">
        </div>
      </div>

      {/* ── Video panels ── */}
      <div className="vc-panels">

        {/* AI / mediator panel — hidden when AI has dropped the call */}
        {!disconnecting && (isBriefing ? (
          <div className={`vc-panel vc-panel--ai vc-panel--mediator ${isSpeaking ? 'speaking' : ''}`}>
            <div className="vc-avatar-placeholder vc-avatar--mediator">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="28" height="28">
                <circle cx="12" cy="8" r="4"/>
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                <path d="M2 10a2 2 0 0 1 2-2M22 10a2 2 0 0 0-2-2M4 10v3a1 1 0 0 0 1 1h.5M20 10v3a1 1 0 0 1-1 1h-.5" strokeLinecap="round"/>
              </svg>
            </div>
            <div className="vc-panel-label">
              <span className="vc-panel-name">Alice</span>
              <span className="vc-panel-role">Session Coordinator</span>
            </div>
            {isSpeaking && (
              <div className="vc-speaking-dots"><span /><span /><span /></div>
            )}
          </div>
        ) : (
          <div className={`vc-panel vc-panel--ai ${isSpeaking ? 'speaking' : ''} ${callStatus === 'processing' ? 'thinking' : ''}`}>
            <div className="vc-avatar-placeholder">
              <span className="vc-avatar-initials">
                {personaName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </span>
            </div>
            <div className="vc-panel-label">
              <span className="vc-panel-name">{personaName}</span>
              {personaRole && <span className="vc-panel-role">{personaRole}</span>}
            </div>
            {isSpeaking && (
              <div className="vc-speaking-dots"><span /><span /><span /></div>
            )}
            {callStatus === 'processing' && !isSpeaking && (
              <div className="vc-thinking-wave" aria-label="Thinking">
                <span /><span /><span /><span /><span />
              </div>
            )}
          </div>
        ))}

        {/* User panel */}
        <div className={`vc-panel vc-panel--user ${callStatus === 'listening' ? 'listening' : ''}`}>
          {cameraStatus === 'granted' ? (
            <video
              ref={userVideoRef}
              autoPlay
              muted
              playsInline
              className="vc-camera-feed"
            />
          ) : (
            <div className="vc-camera-placeholder">
              {cameraStatus === 'pending' ? (
                <span className="vc-cam-msg">Requesting camera…</span>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48">
                    <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                  </svg>
                  <span className="vc-cam-msg">Camera unavailable</span>
                </>
              )}
            </div>
          )}
          <div className="vc-noise-meter">
            {Array.from({ length: 10 }).map((_, i) => {
              const segThreshold = ((i + 1) / 10) * 55
              const active = rmsLevel >= segThreshold
              const cls = active
                ? segThreshold > 35 ? 'speech' : segThreshold > 15 ? 'noise' : 'quiet'
                : ''
              return <div key={i} className={`vc-noise-seg ${cls}`} style={{ height: `${8 + i * 2}px` }} />
            })}
          </div>
          <div className="vc-panel-label">
            <span className="vc-panel-name">You</span>
          </div>
          <div className={`vc-status-dot ${callStatus === 'listening' ? 'mic' : cameraStatus === 'granted' ? 'cam' : 'off'}`} />
        </div>

      </div>

      {/* ── Subtitles (AI only, word-synced) ── */}
      <div className={`vc-subtitles ${showSubtitles && subtitleText ? 'visible' : ''}`}>
        {showSubtitles && subtitleText && (
          <span className="vc-subtitle-text">{subtitleText}</span>
        )}
      </div>

      {/* ── Learner interim transcript (Deepgram live) ── */}
      {USE_DEEPGRAM && interimText && (
        <div className="vc-interim-text">{interimText}</div>
      )}

      {/* ── Push-to-talk bar (noisy environment) ── */}
      {pttMode && !isBriefing && (
        <div className={`vc-ptt-bar${pttActive ? ' vc-ptt-bar--active' : ''}`}>
          <div className="vc-ptt-icon">
            {pttActive
              ? <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><circle cx="12" cy="12" r="8" opacity=".25"/><circle cx="12" cy="12" r="4"/></svg>
              : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><path d="M12 2a4 4 0 0 1 4 4v5a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/><path d="M19 10a7 7 0 0 1-14 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
            }
          </div>
          <span className="vc-ptt-label">
            {pttActive ? 'Recording… release to send' : 'Noisy environment — hold to speak'}
          </span>
          {/* Keyboard hint (desktop) */}
          <kbd className="vc-ptt-key">SPACE</kbd>
          {/* Touch button (mobile) */}
          <button
            className={`vc-ptt-touch-btn${pttActive ? ' active' : ''}`}
            onPointerDown={handlePttPointerDown}
            onPointerUp={handlePttPointerUp}
            onPointerLeave={handlePttPointerUp}
          >
            {pttActive ? 'Release' : 'Hold'}
          </button>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="call-error">{error} <button onClick={() => setError(null)}>✕</button></div>
      )}

      {/* ── Controls ── */}
      <div className="vc-controls">
        {timeLimitMinutes && (
          <div className={`session-timer session-timer--vc${elapsed >= timeLimitMinutes * 60 ? ' session-timer--over' : (warningMinutes && elapsed >= (timeLimitMinutes - warningMinutes) * 60) ? ' session-timer--warn' : ''}`}>
            {fmt(elapsed)}<span className="session-timer-total">/{fmt(timeLimitMinutes * 60)}</span>
          </div>
        )}
        <button
          className={`vc-mic-btn ${muted ? 'muted' : ''}`}
          onClick={handleMuteToggle}
          title={muted ? 'Unmute' : 'Mute'}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
            {muted
              ? <><path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z" opacity=".35"/><line x1="3" y1="3" x2="21" y2="21" strokeWidth="2" stroke="currentColor"/></>
              : <><path d="M12 1a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z"/><path d="M19 10a7 7 0 0 1-14 0H3a9 9 0 0 0 18 0h-2z"/><line x1="12" y1="19" x2="12" y2="23" strokeWidth="2" stroke="currentColor" fill="none"/><line x1="8" y1="23" x2="16" y2="23" strokeWidth="2" stroke="currentColor" fill="none"/></>
            }
          </svg>
          <span>{muted ? 'Unmute' : 'Mute'}</span>
        </button>

        <button
          className={`vc-subtitle-toggle ${showSubtitles ? 'active' : ''}`}
          onClick={() => setShowSubtitles(v => !v)}
          title={showSubtitles ? 'Hide subtitles' : 'Show subtitles'}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
            <path d="M4 6h16v2H4zm0 5h10v2H4zm0 5h7v2H4z"/>
          </svg>
          <span>CC</span>
        </button>

        <button className="vc-end-btn" onClick={handleEndCall}>
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/>
          </svg>
          <span>End call</span>
        </button>
      </div>
    </div>
  )
}
