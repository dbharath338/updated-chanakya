# Troubleshooting

### An amber note says "Groq's tokens per day limit is used up ... playing the built-in offline lesson instead"

That is the fallback working, not a failure. Your Groq quota for that model is exhausted, so the app
switched model, and then served the lesson from the built-in library - which needs no API at all.
You still get the talk-while-drawing lesson, the quiz and the follow-ups.

- The note tells you roughly when the quota resets. There is no need to wait: keep asking.
- **Fast** (`gpt-oss-20b`) and **Deep** (`gpt-oss-120b`) have separate quotas, and both are tried
  automatically before the offline library is used.
- To stop calling Groq entirely, set `AI_MODE=offline` in `.env` and restart. Every lesson then comes
  from the library: zero API calls, zero rate limits, zero cost. Set it back to `auto` any time.

### A banner explains which engines are in use

Both API keys are optional. The banner is informational:

| Banner | Meaning |
|---|---|
| "No `GROQ_API_KEY` ... lessons come from the built-in library" | No key, so the offline library teaches all 42 curriculum topics |
| "The AI is switched off (`AI_MODE=offline`)" | You asked for no API calls; set `AI_MODE=auto` to use the model again |
| "Using your browser's built-in voice" | No Deepgram key, so speech and the mic use the browser's own engines |

To add a key later: the file must be named exactly `.env` (not `.env.txt`), sit next to `server.py`,
use `GROQ_API_KEY=gsk_...` with no quotes or spaces around `=`, and the server must be **restarted**.
`GET http://localhost:8000/api/health` shows what was loaded.

### "No lesson came back"

This should no longer happen - the offline library answers when the model cannot. If you do see it:

- the question was interrupted (the **Stop** button, or you started talking);
- the browser could not reach the local server at all. Check the server is running and reload.

Other provider problems are handled automatically:

- An invalid key is reported in the amber note ("the Groq API key was rejected") and the offline lesson plays.
- A lesson that stops halfway in Deep dive usually means the token budget ran out; the note says so and
  what was already drawn is kept. Raise `max_tokens` for `deep` in `DEPTH_SETTINGS` (`server.py`) if it recurs.

### The tutor's voice sounds robotic

Without `DEEPGRAM_API_KEY` the app uses your browser's built-in speech synthesis, which varies by
browser and operating system (Chrome and Edge sound best; each has an "enhanced" voice you can
download in its settings). The microphone still works - it uses the browser's own speech recognition
instead of Deepgram. Add the key and restart for the natural voice.

### The microphone doesn't work

- Allow microphone access when the browser asks (or via the padlock icon in the address bar).
- Use `http://localhost:8000` exactly. Browsers only allow microphone access on `localhost` or HTTPS.
- Without Deepgram, the mic uses the browser's `SpeechRecognition`, which Chrome and Edge support and
  Firefox does not. On Firefox, type the question instead, or add `DEEPGRAM_API_KEY`.
- Check that the right input device is selected in your operating system's sound settings.
- For mixed-language speech (such as Hinglish), set `DEEPGRAM_STT_LANGUAGE=multi`.

### No sound from the tutor

Browsers block audio until you interact with the page. Click anywhere or ask a question first. Also check the speaker toggle in the top bar.

### Changes to JS/CSS don't show up

Do a hard reload (**Ctrl+Shift+R** / **Cmd+Shift+R**). The server sends `no-cache` headers, but a tab opened before that change may still hold old modules. For `.py` changes, restart the server.

### The page is blank, or the whiteboard / 3D view never appears

The frontend loads React, tldraw, three.js, KaTeX and other libraries from CDNs (esm.sh, jsdelivr, unpkg). Check your internet connection, firewall or ad blocker, and look at the browser console (F12) for failed imports.

### The 3D view is empty or the camera is lost

Press **Reset view** (the frame icon in the toolbar). It re-frames everything drawn. If one shape is broken, it is skipped and a `[scene3d]` warning appears in the console.

### Labels point at the wrong place, or a label is missing

The console shows `[scene3d] label target not found heart.xyz` when the tutor used a part name that doesn't exist. Near-misses are matched automatically (`bird.tail` → `bird.tail-feathers`). For a part the tutor keeps asking for, add it as a part or spot in `models3d.js` and to the catalogue in `prompts.py` (see [EXTENDING.md](EXTENDING.md)).

### A free-form 3D object looks wrong

Subjects without a ready-made model are built by the language model from basic organic shapes, and its spatial reasoning is limited. Options: ask with Deep dive (more reasoning), rephrase to an existing model ("show a bird" rather than "show a sparrow"), or add a model for the subject.

### The first step takes a long time to start

- Offline lessons start instantly; anything slow here is the model being used.
- Deep dive uses more reasoning. Expect several seconds before the first step.
- `GROQ_REASONING_EFFORT=medium/high` slows every lesson; `low` is fastest.
- **Fast** (`gpt-oss-20b`) starts quicker than **Deep** (`gpt-oss-120b`).

### Port 8000 is already in use

Set `PORT=8001` (or any free port) in `.env`, restart, and open that port instead.

### `pip install` fails

Use Python 3.10 or newer (`python --version`). On Windows, if `python` opens the Microsoft Store, install Python from python.org and tick "Add python.exe to PATH".

### Reset everything

Stop the server, delete the `data/` folder (learner memory) and, if needed, the `.venv/` folder, then run `start.bat` / `start.sh` again.
