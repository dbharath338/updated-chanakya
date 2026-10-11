# Architecture

Chanakya is a small FastAPI server plus a no-build browser app. The server talks to the AI providers and stores memory; the browser does all rendering, audio playback and animation.

Both providers are **optional**. A built-in lesson library (`lessons/`) covers every curriculum topic in the same event protocol, so a question produces a lesson even with no keys, no network to the providers, or an exhausted quota.

```
┌──────────────────────── Browser (static/) ────────────────────────┐        ┌──────── server.py ────────┐
│                                                                    │        │                           │
│  app.js ── POST /api/lesson ───────────────────────────────────────┼──────► │ build prompt (prompts.py  │
│    │        ◄── NDJSON events, one per line, as they are generated ┼─────── │ + memory.py) → Groq       │
│    │        ◄── or the built-in lesson, if the model cannot answer ┼─────── │ ↳ retry → other model →   │
│    │                                                               │        │   lessons/ (offline)      │
│    │                                                               │        │ stream → JsonObjectScanner│
│    ├─ per step: POST /api/tts (prefetched) ◄── mp3 ────────────────┼─────── │ → clean_event → yield     │
│    │                                                               │        │                           │
│    ├─ board.js   (2D, tldraw)    ┐  drawing paced to the audio     │        │ /api/tts  → Deepgram Aura │
│    ├─ scene3d.js (3D, three.js)  ┘  length of each sentence        │        │ /api/listen (WebSocket)   │
│    │     ├─ models3d.js  kit3d.js  labels3d.js                     │        │   ⇄ Deepgram Nova-3 live  │
│    │                                                               │        │ /api/memory, /api/progress│
│    └─ voice.js: LiveMic ── WS /api/listen (webm/opus chunks) ──────┼──────► │   → data/memory.json      │
│         ↳ or the browser's SpeechRecognition, when there is no key ┼──────  │                           │
└────────────────────────────────────────────────────────────────────┘        └───────────────────────────┘
```

## 1. Lesson pipeline

### Server: streaming structured output

1. `POST /api/lesson` receives `{question, history, model, depth}`.
2. `build_system_prompt(memory_summary, depth)` assembles the tutor prompt (`prompts.py`): the event protocol, the 2D/3D vocabulary, the model catalogue, the depth rules, and what is known about the learner.
3. The request goes to Groq with `stream=True`. Token budget and reasoning effort come from `DEPTH_SETTINGS` (Basic 6k tokens / low; Standard 10k / `GROQ_REASONING_EFFORT`; Deep dive 24k / at least medium).
4. **`JsonObjectScanner`** watches the token stream and pulls out each top-level `{...}` object as soon as its closing brace arrives (tracking strings and escapes, tolerating code fences and stray text). Step 1 is sent to the browser while step 2 is still being generated.
5. **`_loads_lenient`** parses each object, repairing invalid escapes that models produce for LaTeX (`"\alpha"` becomes `"\\alpha"`) by scanning escape pairs left to right.
6. **`clean_event`** validates and normalises each event: types, caps on list lengths, `mode` limited to `2d|3d`, and LaTeX repair. For example, `\t` from `\times` is restored, `\(...\)` becomes `$...$`, and stray `\times`/`\theta` in prose become `×`/`θ`.
7. Side effects: the first `meta` of a lesson bumps the topic's "seen" count; `memory` events are saved as observations.
8. The browser receives NDJSON: one JSON event per line, then `{"type":"done"}`.

### Server: never a dead end

A provider problem is handled inside `lesson_stream`, so the browser never has to show a raw API error:

| Situation | What happens |
|---|---|
| Transient error (timeout, 5xx, connection) | The same model is retried twice, after 0.7 s then 1.8 s |
| Rate limit / quota (HTTP 429) | Switch to the other model at once - each model has its own quota bucket. Waiting for a reset (which can be 35 minutes) is never done |
| No key, `AI_MODE=offline`, or every attempt failed | Stream the matching lesson from `lessons/` instead |
| Steps already drawn, then the stream died | Keep the partial lesson; do not restart or duplicate it |
| Question with no lesson in the library | A short reply that lists the topics the library does cover |

Each of these emits a soft `{"type":"notice","tone":"warn"}` event - an amber note in the transcript -
with a human message built by `_friendly_failure()`. Provider payloads, organisation ids and status
codes are never forwarded. `{"type":"error"}` survives only for the case where nothing at all came back.

### Offline lesson library (`lessons/`)

Hand-authored lessons in exactly the model's vocabulary, so the whole playback pipeline is reused
unchanged: `meta` → `step` (say + draw/draw3d + camera) → `check` → `suggest`.

| Module | Contents |
|---|---|
| `lessons/maths.py`, `physics.py`, `chemistry.py` | 42 lessons, one per curriculum topic in `static/curriculum.js` |
| `lessons/__init__.py` | Matching (`match`, `best_match`), depth slicing (`events_for`), event building |
| `lessons/validate.py` | `python -m lessons.validate`: checks every lesson against what the renderers support |

Matching is keyword based with light stemming, so spoken phrasings ("how do planes fly", "eigen values")
find the right lesson; the validator asserts that every curriculum prompt and every starter chip maps to
its own topic. Depth slices the same lesson: Basic takes the first 4 steps, Standard all of them,
Deep dive adds the `deep`-only pages and a second quiz. Events go through the same `clean_event()`
as model output, and are paced ~40 ms apart so speech is prefetched step by step, as with a stream.

### Browser: producer/consumer playback (`app.js` → `ask()`)

- The **producer** reads the NDJSON stream. For every `step` it immediately starts fetching that step's speech (`synthesize()`, which calls `/api/tts`), so audio is usually ready before it is needed.
- The **consumer** plays events strictly in order (`play()`):
  - `meta`: clears the page if asked, switches the 2D/3D view, adds a topic divider.
  - `step`: waits for that step's audio and reads its duration, then starts speaking, shows the live caption and calls `board.render(draw, durationMs)` and `scene.render(draw3d, durationMs, camera)` together. Drawing is paced to finish as the sentence ends.
  - `check`: renders a quiz card; answers go to `/api/progress`.
  - `suggest`: renders "Go deeper" chips.
  - `memory`: shows a "Noted" chip.
- **Stop or barge-in**: a single `AbortController` cancels the fetch, speech and every animation (all animation helpers honour the abort signal).
- **Conversation history**: after a lesson, the question and the raw events are kept as a user/assistant pair and sent back with follow-ups (server-side trimmed to 8 messages / 24k characters).

## 2. 2D whiteboard (`board.js`)

- tldraw editor fixed to a 1000×640 logical board, zoomed to fit (`fit()`), and zoomed out automatically if anything is drawn off-board (`keepInView()`).
- Shapes animate like hand drawing: text types out, lines and plots are drawn as progressively revealed freehand strokes, and geometric shapes fade in. Animation frames bypass the undo history.
- A custom `math` shape renders KaTeX. `plot` samples a math.js expression and draws its own axes.

## 3. 3D stage (`scene3d.js` and friends)

| Module | Responsibility |
|---|---|
| `scene3d.js` | `Scene3D`: renderer, lights, grid, OrbitControls, render loop, the `draw()` switch for every object and action kind, model assembly, flows, highlight, auto-framing, formula notes |
| `kit3d.js` | Coordinates and building blocks shared by the scene and the models: `v()` (math → three.js coordinates), colours, `material()` with finishes, `blobGeometry` (metaballs via MarchingCubes), `tube` (tapered), `bodyGeometry` (lofted along a spine), `lathe`, `ellipsoid`, `leaf`, `paintGeometry` |
| `models3d.js` | Procedural model builders. Each returns `{group, parts, paths, hinges}` |
| `labels3d.js` | `LabelLayer`: screen-space label layout recomputed every frame |

**Coordinates.** The tutor uses math coordinates: x right, y into the screen, z up. three.js is y-up, so every point passes through `v([x,y,z])`, which gives `Vector3(x, z, -y)`. The mapping is a proper rotation, so handedness is preserved.

**Entrances.** Every object fades or pops in over its share of the sentence. Vectors and cylinders grow from their base; curves and tubes are revealed along their length (`setDrawRange`); surfaces rise from the floor. Materials keep their target opacity in `material.userData.opacity`, so fades and the `opacity` action compose correctly.

**Registry.** Objects with an `id` live in `scene.objects`. Models also register each part as `"<id>.<part>"` in `scene.parts`. `resolve(target)` looks up exact ids first, then normalised names (`Heart.Left Ventricle` → `heart.left-ventricle`), then a fuzzy match on part names and labels (`bird.tail` → `bird.tail-feathers`).

**Models.** `scene.model()` builds the model, adds an invisible anchor object for every part (parented to the part, so labels follow moving parts and disappear with removed ones), re-centres it, scales it to `size`, stands it on the floor, and registers parts, flow routes and hinges.

**Flows.** `flow` creates looping particles along a Catmull-Rom curve. A named route such as `heart.lungs-to-body` is expressed in the model's local space, so it follows the model. Particles are updated in the render loop until the page is cleared.

**Auto-framing.** After each step without an explicit camera, `fits()` checks whether the content projects inside the view (leaving side room when callout labels are present) and fills enough of it. If not, `frame()` flies the camera to fit, keeping its viewing direction. Non-finite bounds are ignored, so a bad shape can never blank the view.

**Labels.** Each frame, `LabelLayer.layout()`:
1. projects every label's anchor and drops labels whose objects left the scene;
2. lays out **callouts** (labels on model parts or targets) in two columns beside their model, sorted by anchor height so leader lines never cross, pushed clear of each other and of the notes column and toolbar;
3. places other labels at the first free candidate spot around the anchor, trying last frame's spot first so they don't jitter while you orbit. Far placements get a leader line; axis letters dim rather than move.

## 4. Voice (`voice.js`, `server.py`)

`/api/health` reports `voice` and `stt` as `deepgram` or `browser`; `voice.js` reads that once at start-up
via `setVoiceMode()`, so no request is wasted on an engine that is not configured.

- **Text-to-speech**: with a key, `/api/tts` proxies Deepgram Aura and returns MP3, whose duration drives
  the drawing pace. Otherwise the browser's `speechSynthesis` is used, with an estimated duration - the
  drawing pace is unchanged, so lessons still look the same.
- **Speech-to-text**: with a key, `LiveMic` records 250 ms webm/opus chunks and streams them over
  `WS /api/listen`; the server relays to Deepgram (keeping the key server-side) and returns interim and
  final transcripts plus `utterance_end` after ~1.5 s of silence, which sends the question. Without a key
  the server replies `{"type":"use_browser"}`, and `LiveMic` switches to the browser's `SpeechRecognition`
  with the same interface - including a 1.5 s pause-to-send timer and the same input meter. The mic button
  is therefore never disabled.

## 5. Memory (`memory.py`)

A single JSON file (`data/memory.json`) holding the profile, per-topic `{seen, attempts, correct, last}` and up to 30 timestamped observations. Writes are atomic (temp file + replace) and serialised with a lock. `summary_for_prompt()` turns it into a short paragraph (weak topics, strong topics, recent observations) that is injected into every lesson's system prompt.

## 6. No build step

`index.html` declares an import map: React, tldraw, KaTeX, math.js, Lucide and three.js all load as ES modules from pinned CDN versions. The server sends `Cache-Control: no-cache` for `/` and `/static/*`, so edits show up on a normal reload.
