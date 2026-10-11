# Chanakya: AI Tutor

Chanakya is a voice-first AI tutor that **talks while it draws**. Ask a question out loud or by typing. It explains step by step on a live 2D whiteboard or an orbitable 3D stage, with every spoken sentence matched to what appears on screen. Then it quizzes you and remembers how you did.

It runs entirely on your own computer. It has no accounts, payments or hosting; the only things that leave your machine are calls to the Groq (language model) and Deepgram (voice) APIs.

![stack](https://img.shields.io/badge/Python-FastAPI-009688) ![stack](https://img.shields.io/badge/LLM-Groq%20GPT--OSS-f55036) ![stack](https://img.shields.io/badge/voice-Deepgram-13ef93) ![stack](https://img.shields.io/badge/3D-three.js-black)

---

## Features

| | |
|---|---|
| **Talk-while-drawing lessons** | Each step pairs 1-3 spoken sentences with shapes that are drawn (hand-drawn style) in time with the audio. Live captions highlight word by word. |
| **2D whiteboard** | Text, KaTeX formulas, shapes, arrows and function plots on a tldraw canvas. |
| **3D stage** | Vectors, curves, surfaces, solids, vector fields and planes that you can drag to orbit. Camera flights, motion along paths and rotation are timed to the narration. |
| **Realistic 3D models** | 13 labelled, procedurally built models: heart, human body (with optional organs), lungs, brain, tree, flower, animal/plant cell, DNA, neuron, eye (cut open), fish, bird, butterfly/bee. Parts can be labelled, highlighted or cut away; blood, air, water, pollen and nerve impulses can flow through them. |
| **Organic shapes** | For things with no model, the tutor builds from smooth bodies, metaball blobs, tapered tubes, lathes, leaves and fins in natural colours. |
| **Clean labels** | 3D labels never overlap. Labels on model parts become textbook-style callouts in columns with leader lines. |
| **Depth control** | *Basic*, *Standard* or *Deep dive*. Deep dive gives a 9-16 step, multi-page lesson covering intuition, definition, derivation, worked example, edge cases, misconceptions and applications. |
| **Multi-page lessons** | A lesson can turn the page and switch modes, for example a 3D picture, then a 2D derivation, then a 3D worked example. |
| **Checks and follow-ups** | Multiple-choice quiz cards. A wrong answer offers "explain it another way". "Go deeper" chips suggest the next questions. |
| **Live voice** | Streaming speech-to-text (words appear as you speak, sent when you pause). Talking interrupts the tutor. Hinglish works. |
| **Learner memory** | Profile, per-topic accuracy and the tutor's observations are stored locally and fed back into every lesson. |

---

## Quick start

### Requirements

- **Python 3.10+** ([python.org](https://www.python.org/downloads/))
- A modern browser (Chrome, Edge or Firefox) with internet access; the frontend loads its libraries from public CDNs
- API keys:
  - **Groq** (required, runs the tutor): https://console.groq.com/keys
  - **Deepgram** (recommended, natural voice and microphone input): https://console.deepgram.com/

### Windows

```powershell
cd chanakya
start.bat
```

The first run creates a virtual environment, installs dependencies and copies `.env.example` to `.env`. Open `.env`, paste your keys, then run `start.bat` again.

### macOS / Linux

```bash
cd chanakya
./start.sh
```

### Manual setup (any OS)

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate     macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # Windows: copy .env.example .env
# edit .env and add GROQ_API_KEY and DEEPGRAM_API_KEY
python server.py
```

Then open **http://localhost:8000**.

---

## Using Chanakya

1. **Ask.** Type a question, tap a starter chip, or tap the **mic** and speak. Words appear as you talk, and the question is sent when you pause for about 1.5 s. Press **Enter** to send early.
2. **Watch and listen.** The tutor speaks each step while drawing it. Talking (or pressing **Stop**) interrupts it.
3. **Explore in 3D.** Drag to orbit, scroll to zoom. The toolbar has a **2D/3D** switch, **auto-rotate** and **reset view**.
4. **Check yourself.** Answer the quiz card. If you get it wrong, tap **Explain it another way**.
5. **Go deeper.** Tap a follow-up chip, or **One level deeper on this**.

**Top bar**

| Control | What it does |
|---|---|
| Basic / Standard / Deep dive | How long and detailed the lesson is |
| Fast / Deep | `gpt-oss-20b` (quick) or `gpt-oss-120b` (richer) |
| Speaker | Mute or unmute the tutor's voice |
| Person | Learner profile, per-topic progress, what the tutor has noticed, reset memory |

**Good questions to try:** "How does blood flow through the heart?", "What are the parts of a flower and how does pollination work?", "Explain the cross product in 3D", "Visualize z = x² − y²", "How do birds fly?", "Show me the structure of DNA", and in Deep dive, "Why is the derivative of sin x equal to cos x?"

---

## Configuration

All settings live in `.env` (see `.env.example`). Restart the server after changing them.

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | *(required)* | Groq API key |
| `DEEPGRAM_API_KEY` | *(empty)* | Deepgram key. Without it, the voice falls back to the browser's speech and the mic is disabled. |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Default model (`openai/gpt-oss-20b` or `openai/gpt-oss-120b`) |
| `GROQ_REASONING_EFFORT` | `low` | `low` / `medium` / `high`. Higher gives more careful lessons but a slower first step. Deep dive always uses at least `medium`. |
| `DEEPGRAM_VOICE` | `aura-2-thalia-en` | Text-to-speech voice |
| `DEEPGRAM_STT_MODEL` | `nova-3` | Speech-to-text model |
| `DEEPGRAM_STT_LANGUAGE` | `en` (`.env.example` sets `multi`) | `en` for English only, `multi` for code-switching such as Hinglish |
| `PORT` | `8000` | Local port (the server binds to 127.0.0.1 only) |

---

## Project structure

```
chanakya/
├── server.py            FastAPI app: lesson streaming, TTS, live-STT proxy, memory API, JSON/LaTeX repair
├── prompts.py           The tutor's system prompt: lesson protocol, 2D/3D vocabulary, model catalogue, depth rules
├── memory.py            Local learner memory (data/memory.json)
├── requirements.txt
├── .env.example         Configuration template (copy to .env)
├── start.bat / start.sh One-step setup and launch
├── static/
│   ├── index.html       Page layout and import map (CDN modules, no build step)
│   ├── style.css        All styling
│   ├── app.js           Orchestrator: stream → speech prefetch → synced playback, quiz, mic, settings
│   ├── board.js         2D whiteboard renderer (tldraw), hand-drawn animation, KaTeX and plot shapes
│   ├── scene3d.js       3D stage (three.js): every 3D object/action, models, flows, camera, auto-framing
│   ├── models3d.js      Procedural model library (heart, flower, cell, bird, ...) with parts, routes, hinges
│   ├── kit3d.js         Shared 3D toolkit: colours, materials, metaballs, tubes, lofted bodies, leaves
│   ├── labels3d.js      Non-overlapping 3D label layout with callout columns and leader lines
│   └── voice.js         Deepgram TTS with browser fallback; streaming microphone transcription
├── data/                Created at runtime; holds memory.json (your learner data)
└── docs/
    ├── ARCHITECTURE.md      How the pieces fit together
    ├── LESSON_PROTOCOL.md   Full reference of events, 2D shapes, 3D objects/actions and models
    ├── API.md               HTTP and WebSocket endpoints
    ├── EXTENDING.md         Adding models, shapes, depth levels; tuning the prompt
    └── TROUBLESHOOTING.md   Common problems and fixes
```

---

## Documentation

- **[Architecture](docs/ARCHITECTURE.md):** the streaming pipeline, voice/drawing sync, 3D engine, memory.
- **[Lesson protocol](docs/LESSON_PROTOCOL.md):** everything the tutor can emit, with examples.
- **[API](docs/API.md):** server endpoints.
- **[Extending](docs/EXTENDING.md):** add a new 3D model or shape and teach the tutor to use it.
- **[Troubleshooting](docs/TROUBLESHOOTING.md):** keys, mic, blank 3D view, caching, slow lessons.

---

## Privacy and costs

- Questions and conversation history go to **Groq**; spoken text and microphone audio go to **Deepgram**. Nothing else leaves your machine.
- API keys stay on the server: the browser never sees them, because the microphone stream is proxied through `/api/listen`.
- Learner memory is a plain JSON file in `data/`. Delete it, or use **Reset memory** in the profile drawer, to start fresh.
- Groq and Deepgram bill per use according to your plans. Deep dive lessons use more tokens than Basic.

## Limitations

- One learner per installation (no accounts).
- Free-form 3D objects the tutor builds itself (subjects with no ready-made model) can come out rough. Adding a model gives reliable results: see [Extending](docs/EXTENDING.md).
- Content accuracy depends on the language model. Deep dive (more reasoning) is the safer choice for precise diagrams.
- The browser needs internet access for the CDN-hosted libraries.
