@echo off
rem One-step setup and launch for Chanakya on Windows.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv .venv || (echo Python 3.10+ is required: https://www.python.org/downloads/ & pause & exit /b 1)
    echo Installing dependencies...
    ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (pause & exit /b 1)
)

if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo.
    echo Created .env - open it, add your GROQ_API_KEY and DEEPGRAM_API_KEY, then run start.bat again.
    notepad .env
    exit /b 0
)

echo Starting Chanakya at http://localhost:8000  (Ctrl+C to stop)
start "" http://localhost:8000
".venv\Scripts\python.exe" server.py
