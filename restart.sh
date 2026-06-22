#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

# ── Kill any running Vite dev server ────────────────────────────────────────
echo "==> Stopping any existing Vite process..."
pkill -f "vite" 2>/dev/null || true

# ── Backend: rebuild & restart Docker ───────────────────────────────────────
echo "==> Stopping containers..."
docker compose down --remove-orphans

echo "==> Rebuilding image..."
docker compose build

echo "==> Starting containers..."
docker compose up -d

# ── Frontend: install deps (if needed) & start Vite dev server ──────────────
echo "==> Starting Vite dev server..."
cd frontend
npm install --silent
npm run dev &
VITE_PID=$!
cd ..

echo ""
echo "  Backend : http://localhost:8000"
echo "  Frontend: http://localhost:3000  (or check Vite output above)"
echo "  Vite PID: $VITE_PID"
echo ""
echo "==> Tailing backend logs (Ctrl+C stops tailing — containers & Vite keep running)..."
docker compose logs -f
