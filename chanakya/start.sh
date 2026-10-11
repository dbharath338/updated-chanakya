#!/usr/bin/env bash
# One-step setup and launch for Chanakya on macOS / Linux.
set -e
cd "$(dirname "$0")"

PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python

if [ ! -x ".venv/bin/python" ]; then
  echo "Creating virtual environment..."
  "$PY" -m venv .venv
  echo "Installing dependencies..."
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r requirements.txt
fi

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo
  echo "Created .env. Both API keys are optional: without them Chanakya teaches its"
  echo "42 built-in topics offline and speaks with your browser's own voice."
  echo "Add GROQ_API_KEY (AI tutor) and/or DEEPGRAM_API_KEY (natural voice) any time,"
  echo "then restart. Continuing..."
  echo
fi

PORT=$(grep -E '^PORT=' .env | cut -d= -f2)
echo "Starting Chanakya at http://localhost:${PORT:-8000}  (Ctrl+C to stop)"
exec .venv/bin/python server.py
