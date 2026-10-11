# API

All endpoints are served by `server.py` on `http://127.0.0.1:8000` (local only; the port is set by `PORT`). Errors are returned as `{"error": "..."}` with an HTTP status.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/lesson` | Stream a lesson as NDJSON |
| `POST` | `/api/tts` | Text to speech (MP3) |
| `WS` | `/api/listen` | Live speech-to-text |
| `GET` | `/api/health` | Which keys are configured, available models |
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

Response: `application/x-ndjson`, streamed. One event per line, as described in [LESSON_PROTOCOL.md](LESSON_PROTOCOL.md), ending with `{"type":"done"}`. Provider failures arrive in the stream as `{"type":"error","message":"..."}` rather than as an HTTP error.

```bash
curl -N -X POST localhost:8000/api/lesson -H "Content-Type: application/json" \
  -d '{"question":"What is a vector?","depth":"basic"}'
```

| Depth | Max completion tokens | Reasoning effort |
|---|---|---|
| `basic` | 6,000 | low |
| `standard` | 10,000 | `GROQ_REASONING_EFFORT` |
| `deep` | 24,000 | medium (or higher if configured) |

## `POST /api/tts`

Request: `{"text": "Hello there"}` (1-1900 chars). Response: `audio/mpeg`.
Returns **503** if `DEEPGRAM_API_KEY` is not set (the browser then uses its own voice) and **502** if Deepgram fails.

## `WS /api/listen`

A relay to Deepgram's live transcription, so the API key never reaches the browser.

- **Client → server:** binary audio chunks (webm/opus from `MediaRecorder`, 250 ms each), or the text frame `{"type":"CloseStream"}` to flush and finish.
- **Server → client:**
  - `{"type":"transcript","text":"...","final":false|true}`: interim guesses, then finalised segments
  - `{"type":"utterance_end"}`: about 1.5 s of silence (the app sends the question)
  - `{"type":"error","message":"..."}`

Deepgram options used: `nova-3` (configurable), `smart_format`, `interim_results`, `endpointing=300`, `utterance_end_ms=1500`, `vad_events`.

## `GET /api/health`

```json
{"groq": true, "deepgram": true, "model": "openai/gpt-oss-120b",
 "models": [{"id": "openai/gpt-oss-20b", "label": "Fast"}, {"id": "openai/gpt-oss-120b", "label": "Deep"}]}
```

The app shows a banner when a key is missing.

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
