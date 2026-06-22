# AI Coach MVP — Deployment Runbook

**Stack**: GCP e2-micro (always free) · Groq LLM (free) · Kokoro TTS (local, free) · Deepgram STT (free tier) · SQLite · Caddy HTTPS

---

## 0. Before you start — get your API keys

| Key | Where | Cost |
|-----|-------|------|
| **Groq** (LLM) | [console.groq.com](https://console.groq.com) → API Keys | Free |
| **Deepgram** (STT) | [console.deepgram.com](https://console.deepgram.com) → API Keys | Free (12K min/year) |
| **GCP account** | [console.cloud.google.com](https://console.cloud.google.com) | Free (e2-micro always free) |

> **No OpenAI key needed.** Groq handles LLM, Kokoro handles TTS locally.

---

## 1. GCP — Create the VM

1. Open **Compute Engine → VM Instances → Create instance**
2. Set these fields:

   | Field | Value |
   |-------|-------|
   | Name | `ai-coach-mvp` |
   | Region | `us-central1` (or `us-west1`, `us-east1`) — must be US for free tier |
   | Zone | any |
   | Machine type | `e2-micro` (2 vCPU shared, 1 GB RAM) |
   | Boot disk OS | **Ubuntu 24.04 LTS** |
   | Boot disk size | **30 GB** (free allowance) |
   | Firewall | ✅ Allow HTTP traffic · ✅ Allow HTTPS traffic |

3. Click **Create**. Note the **External IP** shown in the VM list.

---

## 2. Domain + DNS

Browser mic access requires HTTPS — you need a domain pointing at your VM.

**Cheap options:**
- `.xyz` domain for ~$1/year on [Namecheap](https://namecheap.com)
- Free subdomain from [DuckDNS](https://duckdns.org) (e.g. `yourapp.duckdns.org`)

Once you have a domain, add an **A record** pointing to your GCP external IP. Wait a few minutes for DNS to propagate before Step 7.

---

## 3. SSH into the VM

```bash
# From your local machine (gcloud CLI must be installed and authed)
gcloud compute ssh ai-coach-mvp --zone=us-central1-a

# Or use the browser SSH button in GCP Console → VM Instances → SSH
```

All remaining steps run **inside the VM**.

---

## 4. System dependencies

```bash
sudo apt update && sudo apt upgrade -y

sudo apt install -y \
    python3.11 python3.11-venv python3-pip \
    git curl \
    espeak-ng \
    libsndfile1 \
    ffmpeg \
    caddy
```

Verify Python:
```bash
python3.11 --version   # should print 3.11.x
```

---

## 5. Clone the repo

```bash
cd ~
git clone https://github.com/YOUR_USERNAME/ai-coach-mvp.git
cd ai-coach-mvp
```

> If the repo is private, use a [GitHub personal access token](https://github.com/settings/tokens) or SSH key.

---

## 6. Python environment + dependencies

```bash
cd ~/ai-coach-mvp

python3.11 -m venv .venv
source .venv/bin/activate

# numpy must be pinned before everything else
pip install --upgrade pip
pip install numpy==1.26.4

# PyTorch CPU-only (Kokoro dependency — install from pytorch.org index)
pip install torch --index-url https://download.pytorch.org/whl/cpu

# All app dependencies
pip install -r requirements.txt
```

This takes 3–5 minutes on first run.

---

## 7. Build the frontend (run this on your local machine, not the VM)

The React frontend must be built locally and uploaded to the VM.

```bash
# On your local machine, in the project root:
cd frontend
npm install
npm run build
# Produces frontend/dist/

# Upload dist/ to the VM:
gcloud compute scp --recurse frontend/dist ai-coach-mvp:~/ai-coach-mvp/frontend/dist --zone=us-central1-a
```

---

## 8. Create data directory

```bash
mkdir -p ~/ai-coach-mvp/data/tts
```

---

## 9. Environment file

```bash
sudo nano /etc/ai-coach.env
```

Paste and fill in your keys:

```bash
# ── LLM — Groq ──────────────────────────────────────────────────
OPENAI_API_KEY=gsk_XXXXXXXXXXXXXXXXXXXXXXXXXXXX
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_MODEL=llama-3.3-70b-versatile
OPENAI_TIMEOUT_S=60

# ── TTS — Kokoro (local, free) ───────────────────────────────────
USE_LOCAL_TTS=1
TTS_LOCAL_VOICE=af_heart

# ── STT — Deepgram ───────────────────────────────────────────────
DEEPGRAM_API_KEY=XXXXXXXXXXXXXXXXXXXXXXXXXXXX

# ── App ──────────────────────────────────────────────────────────
DATABASE_URL=sqlite:////home/ubuntu/ai-coach-mvp/data/ai_coach.db
HF_HOME=/home/ubuntu/.cache/huggingface
HF_HUB_HTTP_TIMEOUT=120
PYTHONUNBUFFERED=1
```

Lock it down:
```bash
sudo chmod 600 /etc/ai-coach.env
```

---

## 10. Pre-warm the Kokoro model (one-time)

Kokoro downloads ~330 MB on first use. Do this now so it doesn't happen during a live session:

```bash
cd ~/ai-coach-mvp
source .venv/bin/activate

# Load env vars
set -a && source /etc/ai-coach.env && set +a

python - <<'EOF'
import os
from kokoro import KPipeline
import numpy as np, soundfile as sf, tempfile

print("Downloading/warming Kokoro model...")
pipeline = KPipeline(lang_code='a')
chunks = [a for _, _, a in pipeline("Hello, this is a warmup.", voice="af_heart", speed=1.0)]
with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as f:
    sf.write(f.name, np.concatenate(chunks), 24000)
print("Kokoro ready.")
EOF
```

After this, the model is cached in `~/.cache/huggingface` and subsequent starts are instant.

---

## 11. Systemd service

```bash
sudo nano /etc/systemd/system/ai-coach.service
```

```ini
[Unit]
Description=AI Coach MVP
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/ai-coach-mvp
EnvironmentFile=/etc/ai-coach.env
ExecStart=/home/ubuntu/ai-coach-mvp/.venv/bin/uvicorn app.main:app \
    --host 127.0.0.1 \
    --port 8000 \
    --workers 1
Restart=on-failure
RestartSec=5
TimeoutStartSec=120
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable ai-coach
sudo systemctl start ai-coach

# Check it started cleanly (wait ~30s for model load)
sudo systemctl status ai-coach
sudo journalctl -u ai-coach -f
```

You should see `[ModelAdapter] Using OpenAI-compatible endpoint model 'llama-3.3-70b-versatile'` and `[ModelAdapter] Kokoro TTS ready`.

---

## 12. Caddy — HTTPS + frontend serving

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the entire file with (substitute your domain):

```
yourdomain.xyz {

    # ── Backend API + WebSocket ──────────────────────────────────
    reverse_proxy /session*    localhost:8000
    reverse_proxy /scenario*   localhost:8000
    reverse_proxy /scenarios*  localhost:8000
    reverse_proxy /sessions*   localhost:8000
    reverse_proxy /audio*      localhost:8000
    reverse_proxy /transcribe* localhost:8000
    reverse_proxy /ws*         localhost:8000 {
        transport http {
            versions h1
        }
    }

    # ── React SPA ────────────────────────────────────────────────
    root * /home/ubuntu/ai-coach-mvp/frontend/dist
    try_files {path} /index.html
    file_server
}
```

Reload Caddy:
```bash
sudo systemctl reload caddy
```

Caddy automatically fetches a Let's Encrypt TLS certificate. This requires port 80 + 443 to be reachable (GCP firewall HTTP/HTTPS checkboxes from Step 1 handle this).

---

## 13. Smoke test

```bash
# Health check
curl https://yourdomain.xyz/scenarios

# Watch live logs during a test session
sudo journalctl -u ai-coach -f
```

Open `https://yourdomain.xyz` in Chrome — mic permission prompt should appear. Run a session end-to-end.

---

## 14. Updating the app

```bash
cd ~/ai-coach-mvp
git pull

# If requirements changed:
source .venv/bin/activate
pip install -r requirements.txt

# If frontend changed (run on local machine first, then upload):
# cd frontend && npm run build
# gcloud compute scp --recurse frontend/dist ai-coach-mvp:~/ai-coach-mvp/frontend/dist --zone=us-central1-a

sudo systemctl restart ai-coach
sudo journalctl -u ai-coach -f   # watch startup
```

---

## 15. Monitoring + logs

```bash
# Live logs
sudo journalctl -u ai-coach -f

# Last 100 lines
sudo journalctl -u ai-coach -n 100

# Memory usage (watch for OOM risk)
free -h
ps aux --sort=-%mem | head -10

# Disk usage
df -h
```

---

## 16. Troubleshooting

**App won't start — OOM killed**
```bash
sudo dmesg | grep -i "killed process"
```
e2-micro has 1 GB RAM. Sentence transformer (~350 MB) + Kokoro (~350 MB) + uvicorn (~100 MB) = ~800 MB. If you're getting OOM, try:
```bash
# Add 1 GB swap (one-time)
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Kokoro model re-downloading every restart**
Ensure `HF_HOME` in `/etc/ai-coach.env` points to a writable path that persists across restarts. The default `~/.cache/huggingface` works if the home directory is on the boot disk.

**WebSocket connections dropping**
Caddy's WebSocket proxy requires HTTP/1.1 (set in the Caddyfile above). If Deepgram sessions drop, check:
```bash
sudo journalctl -u ai-coach | grep "WS Transcribe"
```

**Groq rate limits**
Free tier allows ~14,400 requests/day on Llama 3.3 70B. For higher throughput, switch to `llama-3.1-8b-instant` in `/etc/ai-coach.env` (much higher limits, slightly lower quality):
```bash
OPENAI_MODEL=llama-3.1-8b-instant
sudo systemctl restart ai-coach
```

**HTTPS certificate not issuing**
Caddy needs port 80 reachable for ACME challenge. Check GCP firewall:
- GCP Console → VPC Network → Firewall → ensure `default-allow-http` allows port 80

---

## Quick reference

| Task | Command |
|------|---------|
| Start app | `sudo systemctl start ai-coach` |
| Stop app | `sudo systemctl stop ai-coach` |
| Restart app | `sudo systemctl restart ai-coach` |
| View logs | `sudo journalctl -u ai-coach -f` |
| Edit env vars | `sudo nano /etc/ai-coach.env` then restart |
| SSH into VM | `gcloud compute ssh ai-coach-mvp --zone=us-central1-a` |
| Upload frontend | `gcloud compute scp --recurse frontend/dist ai-coach-mvp:~/ai-coach-mvp/frontend/dist --zone=us-central1-a` |
