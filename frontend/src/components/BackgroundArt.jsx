import { useEffect, useRef } from 'react'

// ── Sample conversation snippets shown drifting in the background ──────────
const CONVOS = [
  // System design
  { role: 'learner', text: 'How many users are we designing for?' },
  { role: 'ai',      text: 'Think big — 50 million DAU. How does that change your design?' },
  { role: 'learner', text: 'I\'d add a CDN and horizontal auto-scaling behind a load balancer.' },
  { role: 'ai',      text: 'Good. Now where\'s your single point of failure?' },
  { role: 'learner', text: 'Use Cassandra for write-heavy workloads, read replicas for queries.' },
  { role: 'ai',      text: 'Walk me through the data flow end to end.' },
  // Sales pitch
  { role: 'learner', text: 'RouteIQ cut last-mile costs by 18% for ops teams your size.' },
  { role: 'ai',      text: 'Every vendor says that. What\'s the fully loaded cost?' },
  { role: 'learner', text: 'Full migration in under 30 days — zero downtime guaranteed.' },
  { role: 'ai',      text: 'We\'ve been burned by vendor promises before. Show me the data.' },
  { role: 'learner', text: 'Can we do a 15-minute call Thursday at 2pm?' },
  // Salary negotiation
  { role: 'learner', text: 'Based on Levels.fyi, I\'m targeting $115,000 base.' },
  { role: 'ai',      text: 'Our band tops out at $105K — is there flexibility on your end?' },
  { role: 'learner', text: 'If base is fixed, could we add a $10K signing bonus?' },
  { role: 'ai',      text: 'That\'s creative. Let me check with the hiring manager.' },
  // Cold call
  { role: 'learner', text: 'I\'ll be brief — we reduce driver churn by 30% in 90 days.' },
  { role: 'ai',      text: 'I have a meeting in 10 minutes. What exactly do you need?' },
  { role: 'learner', text: 'Just 15 minutes to show you one number that changes everything.' },
  { role: 'ai',      text: 'Fine. Thursday 3pm. Don\'t waste my time.' },
]

// Spread bubbles across screen with staggered timing
const BUBBLES = CONVOS.map((c, i) => ({
  ...c,
  left: 4 + (i * 19.7) % 88,        // % from left, spread across width
  top:  8 + (i * 23.3) % 78,        // % from top
  delay: i * 2.1,                    // stagger seconds
  duration: 14 + (i % 5) * 2.5,     // each bubble's full cycle
  drift: -28 - (i % 4) * 8,         // px upward drift
}))

const NODE_COUNT = 52
const CONNECT_DIST = 160
const PULSE_NODES = 6   // nodes that glow as "active" conversations

function rand(min, max) { return Math.random() * (max - min) + min }

export default function BackgroundArt() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let animId
    let W, H

    // ── Node setup ──────────────────────────────────────────
    const nodes = Array.from({ length: NODE_COUNT }, (_, i) => ({
      x: rand(0, 1),
      y: rand(0, 1),
      vx: rand(-0.00012, 0.00012),
      vy: rand(-0.00012, 0.00012),
      r: rand(2.5, 5.5),
      pulse: i < PULSE_NODES,
      phase: rand(0, Math.PI * 2),
      speed: rand(0.018, 0.035),
    }))

    const resize = () => {
      W = canvas.width  = canvas.offsetWidth
      H = canvas.height = canvas.offsetHeight
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    // ── Draw loop ────────────────────────────────────────────
    let t = 0
    const draw = () => {
      animId = requestAnimationFrame(draw)
      t += 0.016

      ctx.clearRect(0, 0, W, H)

      // Move nodes
      nodes.forEach(n => {
        n.x += n.vx
        n.y += n.vy
        if (n.x < 0 || n.x > 1) n.vx *= -1
        if (n.y < 0 || n.y > 1) n.vy *= -1
        n.x = Math.max(0, Math.min(1, n.x))
        n.y = Math.max(0, Math.min(1, n.y))
      })

      // Draw edges
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j]
          const dx = (a.x - b.x) * W
          const dy = (a.y - b.y) * H
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < CONNECT_DIST) {
            const alpha = (1 - dist / CONNECT_DIST) * 0.18
            const isActive = a.pulse || b.pulse
            ctx.beginPath()
            ctx.moveTo(a.x * W, a.y * H)
            ctx.lineTo(b.x * W, b.y * H)
            ctx.strokeStyle = isActive
              ? `rgba(58,136,200,${alpha * 2.2})`
              : `rgba(40,90,150,${alpha})`
            ctx.lineWidth = isActive ? 1.2 : 0.7
            ctx.stroke()
          }
        }
      }

      // Draw speech-bubble "data packets" travelling along edges
      const packetSpeed = 0.0006
      nodes.forEach((a, i) => {
        if (!a.pulse) return
        nodes.forEach((b, j) => {
          if (i === j) return
          const dx = (a.x - b.x) * W
          const dy = (a.y - b.y) * H
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < CONNECT_DIST * 0.7) {
            const prog = ((t * packetSpeed * 1000 + i * 137 + j * 53) % 1)
            const px = (a.x + (b.x - a.x) * prog) * W
            const py = (a.y + (b.y - a.y) * prog) * H
            const alpha = Math.sin(prog * Math.PI) * 0.7
            ctx.beginPath()
            ctx.arc(px, py, 2.2, 0, Math.PI * 2)
            ctx.fillStyle = `rgba(100,200,255,${alpha})`
            ctx.fill()
          }
        })
      })

      // Draw nodes
      nodes.forEach(n => {
        const nx = n.x * W, ny = n.y * H
        if (n.pulse) {
          // Outer glow ring
          const glow = (Math.sin(t * n.speed + n.phase) + 1) / 2
          const outerR = n.r + 6 + glow * 8
          const grad = ctx.createRadialGradient(nx, ny, n.r, nx, ny, outerR)
          grad.addColorStop(0, `rgba(58,136,200,${0.25 + glow * 0.2})`)
          grad.addColorStop(1, 'rgba(58,136,200,0)')
          ctx.beginPath()
          ctx.arc(nx, ny, outerR, 0, Math.PI * 2)
          ctx.fillStyle = grad
          ctx.fill()

          // Core
          ctx.beginPath()
          ctx.arc(nx, ny, n.r, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(80,170,240,${0.75 + glow * 0.25})`
          ctx.fill()
        } else {
          ctx.beginPath()
          ctx.arc(nx, ny, n.r, 0, Math.PI * 2)
          ctx.fillStyle = 'rgba(40,80,130,0.55)'
          ctx.fill()
        }
      })

      // Subtle vignette
      const vign = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.85)
      vign.addColorStop(0, 'rgba(13,27,42,0)')
      vign.addColorStop(1, 'rgba(13,27,42,0.72)')
      ctx.fillStyle = vign
      ctx.fillRect(0, 0, W, H)
    }

    draw()
    return () => {
      cancelAnimationFrame(animId)
      ro.disconnect()
    }
  }, [])

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          zIndex: 0,
          display: 'block',
          pointerEvents: 'none',
        }}
      />

      {/* Floating conversation bubbles */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {BUBBLES.map((b, i) => (
          <div
            key={i}
            className={`bg-bubble bg-bubble--${b.role}`}
            style={{
              left: `${b.left}%`,
              top: `${b.top}%`,
              animationDuration: `${b.duration}s`,
              animationDelay: `${b.delay}s`,
              '--drift': `${b.drift}px`,
            }}
          >
            <span className="bg-bubble-tag">{b.role === 'ai' ? 'AI' : 'Learner'}</span>
            {b.text}
          </div>
        ))}
      </div>
    </>
  )
}
