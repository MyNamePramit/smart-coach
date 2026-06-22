const PALETTE = ['#c0aede', '#b6e3f4', '#d1d4f9', '#f4a8c0', '#a8d8a8', '#f4c9a8']

function nameToColor(name) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

function initials(name) {
  return (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

export default function Avatar({ isSpeaking, isThinking, name = 'AI' }) {
  const bg = nameToColor(name)

  return (
    <div className="avatar-wrap">
      <div className={`avatar-img-ring ${isSpeaking ? 'speaking' : ''} ${isThinking ? 'thinking' : ''}`}>
        <div className="avatar-initials-face" style={{ background: bg }}>
          {initials(name)}
        </div>
      </div>

      <div className="avatar-status">
        {isThinking ? (
          <span className="dots">
            Thinking<span>.</span><span>.</span><span>.</span>
          </span>
        ) : isSpeaking ? (
          <span className="status-speaking">Speaking</span>
        ) : (
          <span className="status-idle">Ready</span>
        )}
      </div>
    </div>
  )
}
