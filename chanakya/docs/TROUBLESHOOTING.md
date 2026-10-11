# Troubleshooting

### A banner says "Add GROQ_API_KEY / DEEPGRAM_API_KEY to .env"

The server didn't find the keys. Check that:
- the file is named exactly `.env` (not `.env.txt`), in the project root next to `server.py`;
- the lines look like `GROQ_API_KEY=gsk_...` with no quotes or spaces around `=`;
- you **restarted** the server after editing.

`GET http://localhost:8000/api/health` shows which keys were loaded.

### "No lesson came back" or an error bubble mentioning Groq

- An invalid key gives an authentication error. Create a new key at https://console.groq.com/keys.
- Rate limits or quota: wait a minute, switch to **Fast**, or use a lower depth.
- A lesson that stops halfway in Deep dive usually means the token budget ran out. Raise `max_tokens` for `deep` in `DEPTH_SETTINGS` (`server.py`).

### The tutor's voice sounds robotic, or the mic button is greyed out

Without `DEEPGRAM_API_KEY` the app uses the browser's built-in voice and disables the microphone. Add the key and restart.

### The microphone doesn't work

- Allow microphone access when the browser asks (or via the padlock icon in the address bar).
- Use `http://localhost:8000` exactly. Browsers only allow microphone access on `localhost` or HTTPS.
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

- Deep dive uses more reasoning. Expect several seconds before the first step.
- `GROQ_REASONING_EFFORT=medium/high` slows every lesson; `low` is fastest.
- **Fast** (`gpt-oss-20b`) starts quicker than **Deep** (`gpt-oss-120b`).

### Port 8000 is already in use

Set `PORT=8001` (or any free port) in `.env`, restart, and open that port instead.

### `pip install` fails

Use Python 3.10 or newer (`python --version`). On Windows, if `python` opens the Microsoft Store, install Python from python.org and tick "Add python.exe to PATH".

### Reset everything

Stop the server, delete the `data/` folder (learner memory) and, if needed, the `.venv/` folder, then run `start.bat` / `start.sh` again.
