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
    echo Created .env. Both API keys are optional: without them Chanakya teaches its
    echo 42 built-in topics offline and speaks with your browser's own voice.
    echo Add GROQ_API_KEY ^(AI tutor^) and/or DEEPGRAM_API_KEY ^(natural voice^) any time.
    echo.
)

echo Starting Chanakya at http://localhost:8000  (Ctrl+C to stop)
start "" http://localhost:8000
".venv\Scripts\python.exe" server.py
