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
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from lessons import build_events, no_match_events, stats as lesson_stats, topics as lesson_topics
from memory import MemoryStore
from prompts import build_system_prompt

# The provider SDKs are optional: without them (or without keys) the server runs
# purely on the built-in offline lessons and the browser's own voice.
try:
    from groq import APIConnectionError, APIStatusError, AsyncGroq, RateLimitError
except ImportError:  # pragma: no cover - only when groq is not installed
    AsyncGroq = RateLimitError = APIStatusError = APIConnectionError = None

try:
    import websockets
except ImportError:  # pragma: no cover - live mic proxy is Deepgram-only
    websockets = None

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

# AI_MODE=offline never calls the language model: every lesson comes from the
# built-in library. Default "auto" tries the model first and falls back locally,
# so a rate limit or a missing key produces a lesson instead of an error.
AI_MODE = os.getenv("AI_MODE", "auto").strip().lower()
LLM_ENABLED = bool(GROQ_API_KEY) and AsyncGroq is not None and AI_MODE != "offline"
# Voice works either way: Deepgram when a key is present, the browser otherwise.
VOICE_MODE = "deepgram" if DEEPGRAM_API_KEY else "browser"

# Retry policy: short, bounded waits only. A quota that resets in 35 minutes is
# not worth waiting for - we switch model, then switch to the offline library.
RETRY_DELAYS = (0.7, 1.8)
# How many events a partial lesson must have produced before we stop falling back
# (a lesson that already drew five steps should not restart from the top).
PARTIAL_LESSON_EVENTS = 2

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
    return ("" if s is None else str(s)).translate(_LATEX_CONTROL)


def _inline_latex(s) -> str:
    """Repair only the $...$ parts of mixed prose + math text (\\(...\\) and \\[...\\] become $ / $$)."""
    s = re.sub(r"\\\[(.+?)\\\]", r"$$\1$$", "" if s is None else str(s), flags=re.S)
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
            if isinstance(items, dict):
                items = [items]
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
    if kind == "notice":
        # A soft, non-fatal heads-up ("the model is rate limited, using the offline
        # lesson instead"). The UI shows it as an amber note, never as a red error.
        return {
            "type": "notice",
            "message": str(ev.get("message", ""))[:400],
            "tone": "warn" if str(ev.get("tone", "warn")) == "warn" else "info",
        }
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


# ---------- provider failure handling ----------

_RESET_IN = re.compile(r"(?:try again in|retry after)\s+([0-9]+(?:\.[0-9]+)?)([smh])", re.I)


def _friendly_failure(exc: Exception) -> tuple[str, bool]:
    """(human message, is_rate_limit) - never the raw provider payload."""
    status = getattr(exc, "status_code", None)
    text = str(exc)
    lowered = text.lower()
    rate_limited = status == 429 or "rate limit" in lowered or "rate_limit_exceeded" in lowered

    if rate_limited:
        quota = "tokens per day" if "tokens per day" in lowered or "(tpd)" in lowered else (
            "tokens per minute" if "tokens per minute" in lowered or "(tpm)" in lowered else "usage")
        m = _RESET_IN.search(text)
        if m:
            value, unit = float(m.group(1)), m.group(2).lower()
            when = f"{int(value)} minute{'s' if unit == 'm' and value >= 2 else ''}" if unit == "m" else (
                f"{int(value)} second{'s' if value >= 2 else ''}" if unit == "s" else f"{value:g} hour{'s' if value >= 2 else ''}")
            return f"Groq's {quota} limit is used up for this model (resets in about {when}).", True
        return f"Groq's {quota} limit was reached for this model.", True
    if status in (401, 403):
        return "The Groq API key was rejected (check GROQ_API_KEY in .env).", False
    if isinstance(exc, (asyncio.TimeoutError,)) or "timed out" in lowered or "timeout" in lowered:
        return "The language model took too long to respond.", False
    if AsyncGroq is not None and APIConnectionError is not None and isinstance(exc, APIConnectionError):
        return "Could not reach Groq (no internet connection, or their service is down).", False
    if isinstance(exc, (httpx.HTTPError, ConnectionError, OSError)):
        return "Network problem reaching the language model.", False
    if status and 500 <= int(status) < 600:
        return f"Groq returned a server error ({status}).", False
    return "The language model could not answer this question.", False


def _model_order(requested: str | None) -> list[str]:
    """Requested model first, then the others - each model has its own quota bucket."""
    first = requested if requested in MODELS else GROQ_MODEL
    return [first, *[m for m in MODELS if m != first]]


async def _llm_events(req: LessonRequest, state: dict) -> AsyncIterator[dict]:
    """Stream model events. On failure, records a friendly message in `state` and stops."""
    messages = [
        {"role": "system", "content": build_system_prompt(memory.summary_for_prompt(), req.depth)},
        *_trim_history(req.history),
        {"role": "user", "content": req.question},
    ]
    settings = DEPTH_SETTINGS.get(req.depth, DEPTH_SETTINGS["standard"])
    topics_seen: set[str] = set()
    last_message = "The language model could not answer this question."

    for model in _model_order(req.model):
        for attempt, delay in enumerate((0.0, *RETRY_DELAYS)):
            if delay:
                await asyncio.sleep(delay)
            scanner = JsonObjectScanner()
            try:
                stream = await groq.chat.completions.create(
                    model=model,
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
                        state["emitted"] += 1
                        yield ev
                state["ok"] = True
                return
            except asyncio.CancelledError:
                raise
            except Exception as e:
                message, rate_limited = _friendly_failure(e)
                if state["emitted"]:
                    # Steps are already on screen. Retrying or switching model would
                    # replay the lesson from the top, so stop here and let the caller
                    # explain the interruption instead.
                    state["error"] = message
                    return
                last_message = message if model == _model_order(req.model)[0] else f"{model.split('/')[-1]}: {message}"
                if rate_limited:
                    break  # waiting will not help: this model's quota is gone, try the next one
                if attempt < len(RETRY_DELAYS):
                    continue  # transient: retry this model after a short, bounded wait
                break
    state["error"] = last_message


async def _offline_events(req: LessonRequest, state: dict) -> AsyncIterator[dict]:
    """The built-in lesson library: no network, no keys, no quota."""
    reason = state.get("error") or (
        "The language model is switched off (AI_MODE=offline in .env)."
        if AI_MODE == "offline" else "GROQ_API_KEY is not set in .env."
    )
    events, lesson = build_events(req.question, req.depth)
    if lesson is not None:
        memory.touch_topic(lesson["topic"])
        note = (f"{reason} Playing the built-in offline lesson for \u201c{lesson['topic']}\u201d instead "
                f"- it draws and speaks exactly like a normal lesson.")
    else:
        events = no_match_events(req.question)
        note = (f"{reason} I do not have a built-in lesson on that exact question yet, "
                "so here are the topics my offline library does cover.")
    yield {"type": "notice", "message": note, "tone": "warn"}
    for ev in events:
        clean = clean_event(ev) or ev
        yield clean
        state["emitted"] += 1
        await asyncio.sleep(0.04)  # pace it like a stream, so speech is prefetched step by step


async def lesson_stream(req: LessonRequest) -> AsyncIterator[bytes]:
    state = {"emitted": 0, "error": None, "ok": False}

    if LLM_ENABLED and groq is not None:
        async for ev in _llm_events(req, state):
            yield _line(ev)
        if state["ok"]:
            yield _line({"type": "done"})
            return
        if state["emitted"] >= PARTIAL_LESSON_EVENTS:
            # mid-lesson drop: keep what was drawn instead of restarting from the top
            yield _line({"type": "notice", "tone": "warn",
                         "message": f"{state['error']} The lesson stopped part way through - ask again, or tap a follow-up."})
            yield _line({"type": "done"})
            return

    async for ev in _offline_events(req, state):
        yield _line(ev)
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
    if not DEEPGRAM_API_KEY or websockets is None:
        # Not a failure: the browser has its own speech recognition, so hand over to it.
        await ws.send_json({
            "type": "use_browser",
            "message": "No Deepgram key, so the microphone uses your browser's built-in speech recognition.",
        })
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
        # kept for compatibility with anything already reading these
        "groq": bool(GROQ_API_KEY),
        "deepgram": bool(DEEPGRAM_API_KEY),
        "llm": LLM_ENABLED,
        "ai_mode": AI_MODE,
        "voice": VOICE_MODE,
        "stt": "deepgram" if DEEPGRAM_API_KEY else "browser",
        "offline": lesson_stats(),
        "model": GROQ_MODEL,
        "models": [{"id": k, "label": v} for k, v in MODELS.items()],
    }


@app.get("/api/topics")
async def offline_topics():
    """The built-in lesson library, so the UI can show what works with no API."""
    return {"count": len(lesson_topics()), "topics": lesson_topics(), **lesson_stats()}


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


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(ROOT / "static" / "favicon.svg", media_type="image/svg+xml")


@app.get("/.well-known/appspecific/com.chrome.devtools.json", include_in_schema=False)
async def chrome_devtools():
    return JSONResponse({})


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

    uvicorn.run(app, host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8000")))
