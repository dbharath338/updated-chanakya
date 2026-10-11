"""Chanakya: local server for the talk-while-drawing AI tutor.

Run:  python server.py   ->  http://localhost:8000
"""

import asyncio
import json
import os
import re
from contextlib import suppress
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import urlencode

import httpx
import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from groq import AsyncGroq
from pydantic import BaseModel, Field

from memory import MemoryStore
from prompts import build_system_prompt

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
# Only the GPT-OSS family is available on our Groq account.
MODELS = {
    "openai/gpt-oss-20b": "Fast",
    "openai/gpt-oss-120b": "Deep",
}
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
if GROQ_MODEL not in MODELS:
    GROQ_MODEL = "openai/gpt-oss-120b"
# GPT-OSS reasons before answering; "low" keeps the first step fast.
REASONING_EFFORT = os.getenv("GROQ_REASONING_EFFORT", "low")
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")
DEEPGRAM_VOICE = os.getenv("DEEPGRAM_VOICE", "aura-2-thalia-en")
DEEPGRAM_STT_MODEL = os.getenv("DEEPGRAM_STT_MODEL", "nova-3")
DEEPGRAM_STT_LANGUAGE = os.getenv("DEEPGRAM_STT_LANGUAGE", "en")

# Per-depth budgets: the token cap covers hidden reasoning as well as the lesson itself.
DEPTH_SETTINGS = {
    "basic": {"max_tokens": 6000, "effort": "low"},
    "standard": {"max_tokens": 10000, "effort": REASONING_EFFORT},
    # deep dives plan a multi-page lesson, so they get more thinking and room
    "deep": {"max_tokens": 24000, "effort": "medium" if REASONING_EFFORT == "low" else REASONING_EFFORT},
}

MAX_HISTORY_MESSAGES = 8
MAX_HISTORY_CHARS = 24_000

app = FastAPI(title="Chanakya")
memory = MemoryStore(ROOT / "data" / "memory.json")
groq = AsyncGroq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None
http = httpx.AsyncClient(timeout=30)


# ---------- streaming JSON extraction ----------

class JsonObjectScanner:
    """Pulls complete top-level {...} objects out of a growing text stream.

    Tolerates code fences, pretty-printed objects and junk between objects.
    """

    def __init__(self):
        self.buf = ""

    def feed(self, text: str) -> list[dict]:
        self.buf += text
        out, depth, start, in_str, esc = [], 0, -1, False, False
        for i, ch in enumerate(self.buf):
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"' and depth > 0:
                in_str = True
            elif ch == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif ch == "}" and depth > 0:
                depth -= 1
                if depth == 0:
                    obj = _loads_lenient(self.buf[start:i + 1])
                    if obj is not None:
                        out.append(obj)
        # keep only an unfinished object; anything else is noise between objects
        self.buf = self.buf[start:] if depth else ""
        return out


# Matches every escape pair left to right, so "\\vec" (already valid) is never split apart.
_BAD_ESCAPE = re.compile(r"\\(.)", re.S)


def _fix_escape(m: re.Match) -> str:
    return m.group(0) if m.group(1) in '"\\/bfnrtu' else "\\\\" + m.group(1)
# Valid JSON escapes that are really LaTeX commands (\frac, \times, \beta, \rightarrow, \neq)
_LATEX_CONTROL = str.maketrans({"\f": "\\f", "\t": "\\t", "\b": "\\b", "\r": "\\r", "\n": "\\n"})


def _loads_lenient(text: str) -> dict | None:
    """Parse JSON, repairing single-backslash LaTeX such as "\\alpha" that models often emit."""
    for candidate in (text, _BAD_ESCAPE.sub(_fix_escape, text)):
        try:
            obj = json.loads(candidate)
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            continue
    return None


def _latex(s) -> str:
    return str(s or "").translate(_LATEX_CONTROL)


def _inline_latex(s) -> str:
    """Repair only the $...$ parts of mixed prose + math text (\\(...\\) and \\[...\\] become $ / $$)."""
    s = re.sub(r"\\\[(.+?)\\\]", r"$$\1$$", str(s or ""), flags=re.S)
    s = re.sub(r"\\\((.+?)\\\)", r"$\1$", s, flags=re.S)
    # odd pieces are inside $...$; even pieces are prose, where stray commands become symbols
    parts = re.split(r"(\$\$[\s\S]+?\$\$|\$[^$]*\$)", s)
    return "".join(_latex(p) if i % 2 else _bare_symbols(p) for i, p in enumerate(parts))


_SYMBOLS = {
    "times": "×", "cdot": "·", "pi": "π", "theta": "θ", "alpha": "α", "beta": "β", "lambda": "λ",
    "mu": "μ", "sigma": "σ", "omega": "ω", "Delta": "Δ", "delta": "δ", "infty": "∞", "le": "≤", "leq": "≤",
    "ge": "≥", "geq": "≥", "neq": "≠", "approx": "≈", "pm": "±", "to": "→", "rightarrow": "→", "degree": "°",
}


def _bare_symbols(text: str) -> str:
    # \times, \beta, \frac lose their first letter to JSON escapes; restore those (real newlines stay)
    text = text.translate(str.maketrans({"\t": "\\t", "\b": "\\b", "\f": "\\f"}))
    return re.sub(r"\\([A-Za-z]+)", lambda m: _SYMBOLS.get(m.group(1), m.group(0)), text)


# ---------- event validation ----------

def _num(v, default=0.0, lo=-2000.0, hi=3000.0) -> float:
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


def clean_event(ev: dict) -> dict | None:
    kind = ev.get("type")
    if kind == "meta":
        return {
            "type": "meta",
            "topic": str(ev.get("topic", ""))[:80],
            "mode": "3d" if str(ev.get("mode", "")).lower() == "3d" else "2d",
            "clear": bool(ev.get("clear", True)),
        }
    if kind == "step":
        out = {"type": "step", "say": str(ev.get("say", ""))[:600]}
        for key, cap in (("draw", 10), ("draw3d", 14)):
            items = ev.get(key) or []
            items = [d for d in items if isinstance(d, dict) and isinstance(d.get("kind"), str)][:cap]
            for d in items:
                if "latex" in d:
                    d["latex"] = _latex(d["latex"])
            out[key] = items
        if isinstance(ev.get("camera"), dict):
            out["camera"] = {k: ev["camera"][k] for k in ("pos", "target") if isinstance(ev["camera"].get(k), list)}
        return out
    if kind == "check":
        options = [_inline_latex(o)[:200] for o in (ev.get("options") or [])][:5]
        answer = int(_num(ev.get("answer"), 0, 0, max(len(options) - 1, 0)))
        if len(options) < 2:
            return None
        return {
            "type": "check",
            "question": _inline_latex(ev.get("question"))[:400],
            "options": options,
            "answer": answer,
            "explain": _inline_latex(ev.get("explain"))[:400],
        }
    if kind == "suggest":
        items = [_inline_latex(i)[:120] for i in (ev.get("items") or []) if isinstance(i, str) and i.strip()][:4]
        return {"type": "suggest", "items": items} if items else None
    if kind == "memory":
        return {"type": "memory", "note": str(ev.get("note", ""))[:300]}
    return None


# ---------- API ----------

class Message(BaseModel):
    role: str
    content: str


class LessonRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[Message] = []
    model: str | None = None
    depth: str = "standard"


def _trim_history(history: list[Message]) -> list[dict]:
    msgs = [m for m in history if m.role in ("user", "assistant")][-MAX_HISTORY_MESSAGES:]
    total, kept = 0, []
    for m in reversed(msgs):
        total += len(m.content)
        if total > MAX_HISTORY_CHARS:
            break
        kept.append({"role": m.role, "content": m.content})
    kept.reverse()
    # Groq requires the first non-system message to come from the user
    while kept and kept[0]["role"] != "user":
        kept.pop(0)
    return kept


def _line(obj: dict) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode()


async def lesson_stream(req: LessonRequest) -> AsyncIterator[bytes]:
    if groq is None:
        yield _line({"type": "error", "message": "GROQ_API_KEY is not set in .env"})
        return

    messages = [
        {"role": "system", "content": build_system_prompt(memory.summary_for_prompt(), req.depth)},
        *_trim_history(req.history),
        {"role": "user", "content": req.question},
    ]
    scanner = JsonObjectScanner()
    settings = DEPTH_SETTINGS.get(req.depth, DEPTH_SETTINGS["standard"])
    topics_seen: set[str] = set()
    try:
        stream = await groq.chat.completions.create(
            model=req.model if req.model in MODELS else GROQ_MODEL,
            messages=messages,
            stream=True,
            temperature=0.5,
            max_completion_tokens=settings["max_tokens"],
            reasoning_effort=settings["effort"],
            include_reasoning=False,
        )
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content or ""
            for raw in scanner.feed(delta):
                ev = clean_event(raw)
                if ev is None:
                    continue
                if ev["type"] == "meta" and ev["topic"] not in topics_seen:
                    # page turns repeat the meta; count the topic once per lesson
                    topics_seen.add(ev["topic"])
                    memory.touch_topic(ev["topic"])
                elif ev["type"] == "memory":
                    memory.add_note(ev["note"])
                yield _line(ev)
    except Exception as e:  # surface provider errors to the UI
        yield _line({"type": "error", "message": f"{type(e).__name__}: {e}"})
    yield _line({"type": "done"})


@app.post("/api/lesson")
async def lesson(req: LessonRequest):
    return StreamingResponse(
        lesson_stream(req),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1900)


@app.post("/api/tts")
async def tts(req: TTSRequest):
    if not DEEPGRAM_API_KEY:
        raise HTTPException(503, "DEEPGRAM_API_KEY is not set")
    r = await http.post(
        "https://api.deepgram.com/v1/speak",
        params={"model": DEEPGRAM_VOICE, "encoding": "mp3"},
        headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
        json={"text": req.text},
    )
    if r.status_code != 200:
        raise HTTPException(502, f"Deepgram TTS failed: {r.text[:200]}")
    return Response(r.content, media_type="audio/mpeg")


@app.websocket("/api/listen")
async def listen(ws: WebSocket):
    """Live transcription: relays browser mic audio to Deepgram's streaming API.

    Browser -> server: binary audio chunks (webm/opus), or the text frame {"type":"CloseStream"}.
    Server -> browser: {"type":"transcript","text","final"} | {"type":"utterance_end"} | {"type":"error"}.
    The key stays on the server, which is why we proxy instead of connecting from the browser.
    """
    await ws.accept()
    if not DEEPGRAM_API_KEY:
        await ws.send_json({"type": "error", "message": "DEEPGRAM_API_KEY is not set in .env"})
        await ws.close()
        return

    params = urlencode({
        "model": DEEPGRAM_STT_MODEL,
        "language": DEEPGRAM_STT_LANGUAGE,
        "smart_format": "true",
        "interim_results": "true",
        "endpointing": 300,
        "utterance_end_ms": 1500,
        "vad_events": "true",
    })
    try:
        async with websockets.connect(
            f"wss://api.deepgram.com/v1/listen?{params}",
            additional_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
        ) as dg:

            async def upstream():
                try:
                    while True:
                        msg = await ws.receive()
                        if msg["type"] == "websocket.disconnect":
                            break
                        if msg.get("bytes"):
                            await dg.send(msg["bytes"])
                        elif msg.get("text"):
                            await dg.send(msg["text"])
                finally:
                    # ask Deepgram to flush remaining audio, then it closes the stream
                    with suppress(Exception):
                        await dg.send(json.dumps({"type": "CloseStream"}))

            up = asyncio.create_task(upstream())
            try:
                async for raw in dg:
                    data = json.loads(raw)
                    if data.get("type") == "Results":
                        alt = data["channel"]["alternatives"][0]
                        await ws.send_json({
                            "type": "transcript",
                            "text": alt.get("transcript", ""),
                            "final": bool(data.get("is_final")),
                        })
                    elif data.get("type") == "UtteranceEnd":
                        await ws.send_json({"type": "utterance_end"})
            finally:
                up.cancel()
    except Exception as e:
        with suppress(Exception):
            await ws.send_json({"type": "error", "message": f"Live transcription failed: {e}"})
    finally:
        with suppress(Exception):
            await ws.close()


@app.get("/api/health")
async def health():
    return {
        "groq": bool(GROQ_API_KEY),
        "deepgram": bool(DEEPGRAM_API_KEY),
        "model": GROQ_MODEL,
        "models": [{"id": k, "label": v} for k, v in MODELS.items()],
    }


@app.get("/api/memory")
async def get_memory():
    return memory.load()


@app.put("/api/memory/profile")
async def put_profile(profile: dict):
    return memory.update_profile(profile)


@app.delete("/api/memory")
async def reset_memory():
    return memory.reset()


class Progress(BaseModel):
    topic: str
    correct: bool


@app.post("/api/progress")
async def progress(p: Progress):
    return memory.record_answer(p.topic, p.correct)


@app.get("/")
async def index():
    return FileResponse(ROOT / "static" / "index.html")


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.middleware("http")
async def no_stale_assets(request, call_next):
    # ES modules are cached aggressively; make the browser revalidate so edits show up on reload
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(HTTPException)
async def http_error(_, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))
