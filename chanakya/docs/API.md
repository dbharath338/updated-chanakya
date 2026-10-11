# API

All endpoints are served by `server.py` on `http://127.0.0.1:8000` (local only; the port is set by `PORT`). Errors are returned as `{"error": "..."}` with an HTTP status.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/lesson` | Stream a lesson as NDJSON |
| `POST` | `/api/tts` | Text to speech (MP3) |
| `WS` | `/api/listen` | Live speech-to-text |
| `GET` | `/api/health` | Which engines are live (model, voice), available models, offline library size |
| `GET` | `/api/topics` | The built-in offline lesson library |
| `GET` | `/api/memory` | Read learner memory |
| `PUT` | `/api/memory/profile` | Update the learner profile |
| `DELETE` | `/api/memory` | Reset learner memory |
| `POST` | `/api/progress` | Record a quiz answer |
| `GET` | `/` and `/static/*` | The web app |

---

## `POST /api/lesson`

Request:

```json
{
  "question": "How does blood flow through the heart?",
  "history": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}],
  "model": "openai/gpt-oss-120b",
  "depth": "standard"
}
```

| Field | Type | Notes |
|---|---|---|
| `question` | string, 1-2000 chars | Required |
| `history` | list of `{role, content}` | Earlier turns; trimmed server-side to the last 8 messages / 24,000 characters |
| `model` | string | `openai/gpt-oss-20b` or `openai/gpt-oss-120b`; anything else uses `GROQ_MODEL` |
| `depth` | string | `basic`, `standard` (default) or `deep` |

Response: `application/x-ndjson`, streamed. One event per line, as described in [LESSON_PROTOCOL.md](LESSON_PROTOCOL.md), ending with `{"type":"done"}`.

**A lesson always comes back.** The endpoint never fails because of a provider problem:

1. the requested model is tried; transient errors are retried twice (0.7 s, then 1.8 s);
2. on a rate limit or quota error it switches to the other model immediately - each model has its own quota bucket, and waiting 35 minutes for a reset is never done;
3. if no model can answer (rate limited, no `GROQ_API_KEY`, `AI_MODE=offline`, or offline), the **built-in lesson library** is streamed instead, matched to the question by keyword;
4. if steps were already drawn when the connection dropped, the partial lesson is kept rather than restarted.

Cases 3 and 4 are announced with a soft `{"type":"notice","message":"...","tone":"warn"}` event - an amber note in the UI, never a red error, and never the raw provider payload. `{"type":"error"}` is now only used for a completely empty response.

```bash
curl -N -X POST localhost:8000/api/lesson -H "Content-Type: application/json" \
  -d '{"question":"What is a vector?","depth":"basic"}'
```

| Depth | Max completion tokens | Reasoning effort | Offline library |
|---|---|---|---|
| `basic` | 6,000 | low | first 4 steps, 1 check |
| `standard` | 10,000 | `GROQ_REASONING_EFFORT` | every step, 1 check |
| `deep` | 24,000 | medium (or higher if configured) | every step plus the deep-dive pages, 2 checks |

## `POST /api/tts`

Request: `{"text": "Hello there"}` (1-1900 chars). Response: `audio/mpeg`.
Returns **503** if `DEEPGRAM_API_KEY` is not set (the browser then uses its own voice) and **502** if Deepgram fails. The app reads `/api/health` first, so without a key it never even calls this endpoint.

## `WS /api/listen`

A relay to Deepgram's live transcription, so the API key never reaches the browser. Without a key the server replies once with `{"type":"use_browser"}` and closes; the microphone then uses the browser's own `SpeechRecognition`, so **the mic is never disabled**.

- **Client → server:** binary audio chunks (webm/opus from `MediaRecorder`, 250 ms each), or the text frame `{"type":"CloseStream"}` to flush and finish.
- **Server → client:**
  - `{"type":"transcript","text":"...","final":false|true}`: interim guesses, then finalised segments
  - `{"type":"utterance_end"}`: about 1.5 s of silence (the app sends the question)
  - `{"type":"use_browser"}`: no Deepgram key - the browser's speech recognition takes over
  - `{"type":"error","message":"..."}`

Deepgram options used: `nova-3` (configurable), `smart_format`, `interim_results`, `endpointing=300`, `utterance_end_ms=1500`, `vad_events`.

## `GET /api/health`

```json
{"groq": false, "deepgram": false, "llm": false, "ai_mode": "auto",
 "voice": "browser", "stt": "browser",
 "offline": {"lessons": 42, "steps": 263,
             "by_subject": {"Mathematics": 14, "Physics": 15, "Chemistry": 13}},
 "model": "openai/gpt-oss-120b",
 "models": [{"id": "openai/gpt-oss-20b", "label": "Fast"}, {"id": "openai/gpt-oss-120b", "label": "Deep"}]}
```

| Field | Meaning |
|---|---|
| `llm` | the model will actually be called (key present, SDK installed, `AI_MODE` not `offline`) |
| `ai_mode` | `auto` (model first, offline fallback) or `offline` (never call the model) |
| `voice` / `stt` | `deepgram` when a key is set, otherwise `browser` |
| `offline` | size of the built-in lesson library |
| `groq` / `deepgram` | kept for compatibility: whether each key is present |

The app shows an informational banner explaining which engines are in use. Nothing is broken when a key is missing - the banner says what you get instead.

## `GET /api/topics`

The offline library as an index: `{"count": 42, "steps": 263, "by_subject": {...}, "topics": [{"id", "title", "mode", "subject", "keywords"}]}`.

## Memory

`GET /api/memory` returns the whole file:

```json
{
  "profile": {"name": "Aarav", "level": "Class 10", "goal": "Crack JEE Mains"},
  "topics": {"Pythagorean theorem": {"seen": 3, "attempts": 2, "correct": 1, "last": "2026-10-10T08:21:27+00:00"}},
  "notes": [{"t": "2026-10-10T08:23:39+00:00", "note": "Confuses dot and cross products."}]
}
```

- `PUT /api/memory/profile` with any of `{"name", "level", "goal"}` (each up to 120 chars) returns the updated memory.
- `DELETE /api/memory` resets everything.
- `POST /api/progress` with `{"topic": "Cross product", "correct": true}` records a quiz answer.

Topics with less than 60% accuracy are reported to the tutor as "struggling with"; topics with at least 2 attempts and 80% accuracy count as "comfortable with". The 8 most recent observations are included in every prompt.
