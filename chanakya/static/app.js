// Orchestrator: streams a lesson from the server and plays each step's voice + drawing in sync.
import katex from 'katex'
import {
  createIcons, Activity, ArrowRight, ArrowUp, Atom, BookOpen, Box, Brain, ChartSpline, ChevronDown, ChevronRight,
  ChevronsUpDown, CircleCheck, CircleX, CornerDownRight, Eraser, FlaskConical, GitBranch, GraduationCap, Layers,
  Lightbulb, Link2, List, Magnet, Mic, Moon, NotebookPen, Orbit, Presentation, Rotate3d, RotateCcw, Scan, Search,
  Sigma, Sparkles, Sprout, Square, Sun, Telescope, Trash2, TriangleAlert, TriangleRight, UserRound, Volume2,
  VolumeX, Wind, X, Zap,
} from 'lucide'
import { mountBoard } from './board.js'
// scene3d.js (three.js + the model library) is imported on demand, the first time 3D is opened.
import { synthesize, speak, stopSpeaking, LiveMic } from './voice.js'
import { CURRICULUM_TREE, TOPICS, SUBJECTS } from './curriculum.js'

const ICONS = {
  Activity, ArrowRight, ArrowUp, Atom, BookOpen, Box, Brain, ChartSpline, ChevronDown, ChevronRight,
  ChevronsUpDown, CircleCheck, CircleX, CornerDownRight, Eraser, FlaskConical, GitBranch, GraduationCap, Layers,
  Lightbulb, Link2, List, Magnet, Mic, Moon, NotebookPen, Orbit, Presentation, Rotate3d, RotateCcw, Scan, Search,
  Sigma, Sparkles, Sprout, Square, Sun, Telescope, Trash2, TriangleAlert, TriangleRight, UserRound, Volume2,
  VolumeX, Wind, X, Zap,
}
const renderIcons = () => createIcons({ icons: ICONS })
const ic = (name) => `<i data-lucide="${name}"></i>`

const $ = (sel) => document.querySelector(sel)
const transcript = $('#transcript')
const questionEl = $('#question')
const sendBtn = $('#send')
const micBtn = $('#mic')

// ---------- small persistence helpers (best effort) ----------
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

renderIcons()
const board = await mountBoard($('#board'))

// ---------- 3D stage: built on first use, not at start-up ----------
let scene = null
let dark = false
let loadingScene = null
function getScene() {
  loadingScene ??= import('./scene3d.js').then((m) => {
    scene = m.mountScene($('#scene3d'))
    scene.setTheme(dark) // the stage is built after the theme was chosen, so apply it now
    return scene
  })
  return loadingScene
}

// ---------- Theme (Dark / Light) Switcher ----------
let currentTheme = store.get('chanakya-theme', null)
if (!currentTheme) {
  currentTheme = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
}

function applyTheme(theme) {
  currentTheme = theme
  document.documentElement.setAttribute('data-theme', theme)
  store.set('chanakya-theme', theme)
  const themeBtn = $('#theme-toggle')
  if (themeBtn) {
    themeBtn.setAttribute('title', theme === 'dark' ? 'Switch to Light mode' : 'Switch to Dark mode')
    themeBtn.innerHTML = theme === 'dark' ? ic('sun') : ic('moon')
    renderIcons()
  }
  dark = theme === 'dark'
  board.setTheme(dark)
  scene?.setTheme(dark)
}

applyTheme(currentTheme)

$('#theme-toggle')?.addEventListener('click', () => {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark')
})

const history = [] // [{role, content}] sent back to the model for follow-ups
let current = null // AbortController for the lesson in progress
let currentTopic = ''
const page = [] // steps drawn on the current page, so a 2D/3D switch can re-create them
let lastQuestion = ''
let userMode = null // mode the learner picked by hand; overrides the tutor's meta.mode
let lastKind = '' // to group consecutive tutor bubbles under one avatar

// Render text with inline $...$ / $$...$$ LaTeX.
function withMath(text) {
  return String(text).split(/(\$\$[\s\S]+?\$\$|\$[^$]+?\$)/g).map((part) => {
    const m = part.match(/^\$\$([\s\S]+)\$\$$/) || part.match(/^\$([^$]+)\$$/)
    if (!m) return escapeHtml(part)
    return katex.renderToString(m[1], { throwOnError: false, displayMode: part.startsWith('$$') })
  }).join('')
}

// Turn inline $...$ math into words so TTS doesn't read out symbols ("3 squared plus 4 squared").
function speakable(text) {
  const words = (tex) => tex
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, ' $1 over $2 ')
    .replace(/\\sqrt\{([^{}]*)\}/g, ' square root of $1 ')
    .replace(/\^\{?2\}?/g, ' squared ')
    .replace(/\^\{?3\}?/g, ' cubed ')
    .replace(/\^\{([^{}]*)\}|\^(\w)/g, ' to the power $1$2 ')
    .replace(/\\(times|cdot)/g, ' times ')
    .replace(/\\(pi|theta|alpha|beta|lambda|mu|sigma|Delta|delta)/g, ' $1 ')
    .replace(/\\(le|leq)\b/g, ' is at most ').replace(/\\(ge|geq)\b/g, ' is at least ')
    .replace(/=/g, ' equals ').replace(/\+/g, ' plus ').replace(/(\S)\s*-\s*/g, '$1 minus ')
    .replace(/[\\{}_]/g, ' ')
  return String(text)
    .replace(/\$\$([\s\S]+?)\$\$|\$([^$]+?)\$/g, (_, a, b) => words(a ?? b))
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------- transcript ----------

function append(el, kind) {
  $('#empty')?.remove()
  transcript.appendChild(el)
  lastKind = kind
  renderIcons()
  transcript.scrollTop = transcript.scrollHeight
  return el
}

function addUser(text) {
  const el = document.createElement('div')
  el.className = 'msg user'
  el.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`
  return append(el, 'user')
}

function addTutor(text) {
  const el = document.createElement('div')
  el.className = `msg tutor${lastKind === 'tutor' ? ' cont' : ''}`
  el.innerHTML = `<div class="avatar">${ic('sparkles')}</div><div class="bubble">${withMath(text)}</div>`
  return append(el, 'tutor')
}

function addDivider(text) {
  const el = document.createElement('div')
  el.className = 'divider'
  el.textContent = text
  return append(el, 'divider')
}

function addNote(text) {
  const el = document.createElement('div')
  el.className = 'note'
  el.innerHTML = `${ic('notebook-pen')}<span>Noted: ${escapeHtml(text)}</span>`
  return append(el, 'note')
}

function addError(text) {
  const el = document.createElement('div')
  el.className = 'error'
  el.innerHTML = `${ic('triangle-alert')}<span>${escapeHtml(text)}</span>`
  return append(el, 'error')
}

// ---------- board overlays ----------

function setThinking(text) {
  $('#thinking').classList.toggle('hidden', !text)
  if (text) $('#thinking-text').textContent = text
}

function setLessonActive(active) {
  $('#stop').classList.toggle('hidden', !active)
}

// Subtitle that lights up word by word over the length of the audio.
let captionTimer = null
function showCaption(text, durationMs) {
  const el = $('#caption')
  clearInterval(captionTimer)
  const words = text.split(/\s+/).filter(Boolean)
  el.innerHTML = words.map((w) => `<span class="w">${escapeHtml(w)}</span>`).join(' ')
  el.classList.remove('hidden')
  const spans = el.querySelectorAll('.w')
  let i = 0
  const step = Math.max(80, (durationMs * 0.95) / Math.max(1, words.length))
  spans[0]?.classList.add('on')
  captionTimer = setInterval(() => {
    i += 1
    if (i >= spans.length) return clearInterval(captionTimer)
    spans[i].classList.add('on')
  }, step)
}

function hideCaption() {
  clearInterval(captionTimer)
  $('#caption').classList.add('hidden')
}

// ---------- view: 2D whiteboard or 3D stage ----------

let view = store.get('chanakya.view', '2d')
async function setView(mode, byUser = false) {
  const prev = view
  view = mode === '3d' ? '3d' : '2d'
  if (byUser) userMode = view
  store.set('chanakya.view', view)
  const s = view === '3d' ? await getScene() : scene
  s?.setVisible(view === '3d') // must come first: it un-hides and re-sizes the 3D canvas
  const b = $('#view-toggle')
  if (b) {
    b.innerHTML = view === '3d' ? `${ic('presentation')}<span>2D</span>` : `${ic('box')}<span>3D</span>`
    b.title = view === '3d' ? 'Switch to the whiteboard' : 'Switch to the 3D view'
  }
  document.querySelectorAll('#mode-switch button').forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset.mode === view))
  })
  $('#spin').classList.toggle('hidden', view !== '3d')
  renderIcons()
  if (prev !== view) {
    await replayPage() // carry the page over to the surface we just switched to
    if (byUser) continueInView()
  }
}
function renderSpin(on) { $('#spin').setAttribute('aria-pressed', String(on)) }

// ---------- Cinematic Visual Intro Overlay Effect ----------
function triggerVisualIntro(titleText) {
  const intro = $('#visual-intro')
  if (!intro) return
  const qLower = titleText.toLowerCase()
  const matched = TOPICS.find((t) => qLower.includes(t.title.toLowerCase().split(':')[0]) || qLower.includes(t.id))
  $('#intro-badge').textContent = matched ? `${matched.subject.toUpperCase()} VISUALIZATION` : 'INITIALIZING VISUALIZATION'
  $('#intro-title').textContent = matched ? matched.title : titleText.slice(0, 52)
  $('#intro-desc').textContent = matched ? matched.desc : (view === '3d' ? 'Preparing 3D spatial models & physical vectors…' : 'Preparing interactive whiteboard drawing & derivations…')
  intro.classList.remove('hidden')
  renderIcons()
  setTimeout(() => {
    intro.classList.add('hidden')
  }, 1300)
}

// In 3D mode, flat text/formulas the model put in "draw" go to the notes column instead of a hidden board.
function notesFrom(draw) {
  return (draw ?? []).filter((d) => d.kind === 'math' || d.kind === 'text')
    .map((d) => ({ kind: 'note', latex: d.latex, text: d.text, color: d.color, size: d.size }))
}

// 3D-only items that have a plain 2D equivalent: formula notes and labels become board shapes.
function boardFrom3d(items) {
  const out = []
  let row = 0
  for (const s of items ?? []) {
    // only what we actually place takes a row, so 3D geometry leaves no gap in the formula column
    const place = (shape) => out.push({ ...shape, x: shape.x ?? 560, y: 100 + row++ * 70 })
    if (s.kind === 'note' && (s.latex || s.text)) {
      place(s.latex
        ? { kind: 'math', latex: s.latex, color: s.color, size: s.size }
        : { kind: 'text', text: s.text, color: s.color, size: s.size })
    } else if (s.kind === 'label' && (s.latex || s.text || s.label)) {
      place(s.latex
        ? { kind: 'math', latex: s.latex, color: s.color }
        : { kind: 'text', x: 60, text: s.text ?? s.label, color: s.color, size: 's' })
    }
  }
  return out
}

// Re-create the current page on the surface the learner just switched to: instantly, and silently.
// A budget of 0 makes board.render / scene.render draw everything finished, with no animation.
async function replayPage() {
  if (!page.length) return
  const { signal } = new AbortController()
  if (view === '3d') {
    scene?.clear()
    for (const ev of page) await scene?.render([...notesFrom(ev.draw), ...(ev.draw3d ?? [])], 0, signal)
    await scene?.frame(0)
  } else {
    board.clear()
    for (const ev of page) await board.render([...(ev.draw ?? []), ...boardFrom3d(ev.draw3d)], 0, signal)
    board.fit(false)
    scene?.clear() // free the 3D page's GPU resources; it is rebuilt from `page` when we switch back
  }
}

// The tutor writes 2D and 3D in different vocabularies, so after a switch it keeps producing the old
// one. A lesson still in flight therefore has to be re-requested in the new mode, picking up where it
// left off; when nothing is playing, the replay above is enough.
function continueInView() {
  if (!current) return // nothing is playing: replaying the page is enough
  const surface = view === '3d' ? '3D scene' : '2D whiteboard'
  const said = page.map((e) => e.say).filter(Boolean).join(' ').slice(0, 600)
  ask(said
    ? `We were on "${currentTopic || lastQuestion}". So far you have explained: ${said}\n`
      + `Continue from exactly there, on the ${surface}, without repeating what you already said.`
    : `${lastQuestion}\nAnswer that on the ${surface}.`, view, true)
}

// ---------- settings: model + depth + voice ----------

let model = store.get('chanakya.model', 'openai/gpt-oss-120b')
function renderModel() {
  document.querySelectorAll('#model-switch button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.model === model)))
}
document.querySelectorAll('#model-switch button').forEach((b) => b.addEventListener('click', () => {
  model = b.dataset.model
  store.set('chanakya.model', model)
  renderModel()
}))
renderModel()

let depth = store.get('chanakya.depth', 'standard')
function renderDepth() {
  document.querySelectorAll('#depth-switch button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.depth === depth)))
}
document.querySelectorAll('#depth-switch button').forEach((b) => b.addEventListener('click', () => {
  depth = b.dataset.depth
  store.set('chanakya.depth', depth)
  renderDepth()
}))
renderDepth()

let voiceOn = store.get('chanakya.voice', 'on') === 'on'
function renderVoice() {
  const b = $('#voice-toggle')
  b.setAttribute('aria-pressed', String(voiceOn))
  b.title = voiceOn ? 'Mute tutor voice' : 'Unmute tutor voice'
  b.innerHTML = ic(voiceOn ? 'volume-2' : 'volume-x')
  renderIcons()
}
$('#voice-toggle').addEventListener('click', () => {
  voiceOn = !voiceOn
  store.set('chanakya.voice', voiceOn ? 'on' : 'off')
  if (!voiceOn) stopSpeaking()
  renderVoice()
})
renderVoice()

// ---------- lesson pipeline ----------

function stop() {
  current?.abort()
  current = null
  stopSpeaking()
  hideCaption()
  setThinking('')
  setLessonActive(false)
}

async function ask(question, preferredMode, isContinuation = false) {
  question = question.trim()
  if (!question) return
  if (!isContinuation) lastQuestion = question
  stop()
  // a fresh question lets the tutor choose the mode again; a continuation keeps the one we asked for
  userMode = preferredMode ? (preferredMode === '3d' ? '3d' : '2d') : null
  const ctrl = new AbortController()
  current = ctrl
  const { signal } = ctrl

  if (!isContinuation) {
    addUser(question)
    triggerVisualIntro(question)
  }
  setThinking(depth === 'deep' ? 'Planning a deep dive' : model.includes('120b') ? 'Thinking it through' : 'Thinking')
  setLessonActive(true)
  let keepCurrentPage = isContinuation && page.length > 0

  const queue = [] // [{ev, audio: Promise<url|null>}]
  const received = [] // events to remember in history
  let streamDone = false
  let wake = null
  const notify = () => { wake?.(); wake = null }

  // Producer: read NDJSON events and prefetch speech for each step as it arrives.
  ;(async () => {
    try {
      const r = await fetch('/api/lesson', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history, model, depth }),
        signal,
      })
      if (!r.ok) throw new Error(`Server error ${r.status}`)
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          const ev = JSON.parse(line)
          if (ev.type === 'done') continue
          if (ev.type !== 'error') received.push(ev)
          queue.push({ ev, audio: ev.type === 'step' && voiceOn ? synthesize(speakable(ev.say), signal) : Promise.resolve(null) })
          notify()
        }
      }
    } catch (err) {
      if (!signal.aborted) queue.push({ ev: { type: 'error', message: err.message }, audio: Promise.resolve(null) })
    } finally {
      streamDone = true
      notify()
    }
  })()

  // Consumer: play events strictly in order.
  while (!signal.aborted) {
    if (!queue.length) {
      if (streamDone) break
      await new Promise((res) => { wake = res })
      continue
    }
    const { ev, audio } = queue.shift()
    if (ev.type === 'meta' && keepCurrentPage) {
      keepCurrentPage = false
      ev.clear = false
    }
    await play(ev, audio, signal)
  }

  if (received.some((e) => e.type === 'step')) {
    history.push({ role: 'user', content: isContinuation ? lastQuestion : question })
    history.push({ role: 'assistant', content: received.map((e) => JSON.stringify(e)).join('\n') })
  } else if (!signal.aborted && !received.length) {
    addError('No lesson came back. Try asking again.')
  }
  if (current === ctrl) {
    current = null
    setThinking('')
    setLessonActive(false)
  }
}

async function play(ev, audio, signal) {
  switch (ev.type) {
    case 'meta':
      // a lesson can turn the page several times, switching between 2D and 3D
      if (ev.clear) { board.clear(); scene?.clear(); renderSpin(false); page.length = 0 }
      await setView(userMode ?? ev.mode) // once the learner has chosen a mode, page turns keep it
      if (ev.topic && ev.topic !== currentTopic) addDivider(ev.topic)
      currentTopic = ev.topic || currentTopic
      return

    case 'step': {
      const url = await audio
      if (signal.aborted) return
      page.push(ev)
      setThinking('')
      const el = addTutor(ev.say)
      el.classList.add('speaking')
      const { durationMs, done } = await speak(speakable(ev.say), url, { enabled: voiceOn, signal })
      showCaption(speakable(ev.say), durationMs)
      const draw3d = view === '3d' ? [...notesFrom(ev.draw), ...(ev.draw3d ?? [])] : ev.draw3d
      const draw2d = view === '3d' ? (ev.draw ?? []).filter((d) => d.kind !== 'math' && d.kind !== 'text') : [...(ev.draw ?? []), ...boardFrom3d(ev.draw3d)]
      await Promise.all([
        board.render(draw2d, durationMs, signal),
        scene?.render(draw3d, durationMs, signal, ev.camera),
        done,
      ])
      renderSpin(scene?.controls.autoRotate ?? false)
      el.classList.remove('speaking')
      hideCaption()
      return
    }

    case 'check':
      renderCheck(ev, currentTopic)
      if (voiceOn && !signal.aborted) {
        const line = 'Quick check. Give this one a try.'
        const { done } = await speak(line, await synthesize(line, signal), { signal })
        await done
      }
      return

    case 'suggest':
      renderSuggest(ev.items)
      return

    case 'memory':
      addNote(ev.note)
      refreshMemory()
      return

    case 'error':
      setThinking('')
      addError(ev.message)
  }
}

function renderCheck(ev, topic) {
  const card = document.createElement('div')
  card.className = 'check'
  card.innerHTML = `<div class="check-head">${ic('lightbulb')}Quick check</div><h3>${withMath(ev.question)}</h3>`
  ev.options.forEach((opt, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'opt'
    b.innerHTML = `<span class="letter">${String.fromCharCode(65 + i)}</span><span>${withMath(opt)}</span>`
    b.onclick = () => answer(i)
    card.appendChild(b)
  })
  append(card, 'check')

  async function answer(i) {
    const correct = i === ev.answer
    const buttons = card.querySelectorAll('.opt')
    buttons.forEach((b) => (b.disabled = true))
    buttons[ev.answer].classList.add('right')
    if (!correct) buttons[i].classList.add('wrong')

    const result = document.createElement('div')
    result.className = `result ${correct ? 'ok' : 'no'}`
    result.innerHTML = `${ic(correct ? 'circle-check' : 'circle-x')}<div><strong>${correct ? 'Correct!' : 'Not quite.'}</strong> ${withMath(ev.explain)}</div>`
    card.appendChild(result)

    if (!correct) {
      const again = document.createElement('button')
      again.type = 'button'
      again.className = 'again'
      again.innerHTML = `${ic('rotate-ccw')}Explain it another way`
      again.onclick = () => ask(
        `For the check question "${ev.question}" I answered "${ev.options[i]}", but the right answer was "${ev.options[ev.answer]}". Please explain it a different way.`,
      )
      card.appendChild(again)
    }
    renderIcons()
    transcript.scrollTop = transcript.scrollHeight

    fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic || 'general', correct }),
    }).then(refreshMemory)

    if (voiceOn) {
      const line = correct ? 'Nice, that is right!' : "Not quite. Let's look at why."
      speak(line, await synthesize(line))
    }
  }
}

// Follow-up chips so the learner can drill further into the topic.
function renderSuggest(items) {
  const topic = currentTopic
  const box = document.createElement('div')
  box.className = 'suggest'
  box.innerHTML = `<div class="suggest-head">${ic('telescope')}Go deeper</div>`
  const chip = (label, question, icon, cls = '') => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `chip ${cls}`
    b.innerHTML = `${ic(icon)}<span>${withMath(label)}</span>`
    b.onclick = () => ask(question)
    box.appendChild(b)
  }
  if (topic) {
    chip('One level deeper on this', `Take "${topic}" one level deeper: the next layer of detail, the derivation or mechanism behind it, and where it breaks down.`, 'layers', 'deeper')
  }
  for (const item of items ?? []) chip(item, item, 'arrow-right')
  append(box, 'suggest')
}

// ---------- composer ----------

function autosize() {
  questionEl.style.height = 'auto'
  questionEl.style.height = `${Math.min(questionEl.scrollHeight, 140)}px`
  sendBtn.disabled = !questionEl.value.trim()
}

function submitQuestion() {
  const q = questionEl.value
  if (!q.trim()) return
  questionEl.value = ''
  autosize()
  ask(q)
}

questionEl.addEventListener('input', autosize)
questionEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    if (liveMic.active) finishMic(true)
    else submitQuestion()
  }
})
$('#ask-form').addEventListener('submit', (e) => {
  e.preventDefault()
  if (liveMic.active) finishMic(true)
  else submitQuestion()
})
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => ask(c.dataset.q)))
$('#stop').addEventListener('click', stop)
$('#clear').addEventListener('click', () => { board.clear(); scene?.clear(); renderSpin(false); page.length = 0 })
$('#fit').addEventListener('click', () => (view === '3d' ? scene?.frame() : board.fit()))
$('#view-toggle').addEventListener('click', () => setView(view === '3d' ? '2d' : '3d', true))
$('#spin').addEventListener('click', () => renderSpin(scene?.spin() ?? false))

// ---------- live voice input ----------

const meterBars = document.querySelectorAll('.meter i')
const liveMic = new LiveMic({
  onText: (text) => {
    questionEl.value = text
    autosize()
  },
  onUtteranceEnd: () => finishMic(true), // the learner paused: send what they said
  onLevel: (level) => {
    micBtn.style.setProperty('--level', level.toFixed(3))
    meterBars.forEach((b, i) => { b.style.height = `${4 + level * 12 * (1 - Math.abs(i - 2) * 0.25)}px` })
  },
  onError: (err) => {
    addError(err.message)
    finishMic(false)
  },
})

function setListening(on) {
  micBtn.setAttribute('aria-pressed', String(on))
  micBtn.title = on ? 'Send now' : 'Talk to Chanakya'
  $('#listening').classList.toggle('hidden', !on)
  questionEl.classList.toggle('live', on)
  questionEl.readOnly = on
  questionEl.placeholder = on ? 'Listening…' : 'Ask anything, or tap the mic…'
}

async function startMic() {
  stop() // barge-in: talking interrupts the tutor
  questionEl.value = ''
  autosize()
  setListening(true)
  try {
    await liveMic.start()
  } catch (err) {
    setListening(false)
    addError(err.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your browser to talk.' : err.message)
  }
}

let finishing = false
async function finishMic(send) {
  if (finishing) return
  finishing = true
  try {
    const text = send ? await liveMic.stop() : (liveMic.cancel(), '')
    setListening(false)
    if (send && text) {
      questionEl.value = ''
      autosize()
      ask(text)
    }
  } finally {
    finishing = false
  }
}

micBtn.addEventListener('click', () => (liveMic.active ? finishMic(true) : startMic()))
$('#mic-cancel').addEventListener('click', () => {
  finishMic(false)
  questionEl.value = ''
  autosize()
})

// ---------- specialized curriculum topics index drawer (hierarchy tree & dictionary) ----------

const indexDrawer = $('#index-drawer')
let activeSubject = 'all'
let curriculumView = 'tree' // 'tree' or 'alpha'
let searchQuery = ''
const expandedBranches = new Set(CURRICULUM_TREE.map((b) => b.id))

const openIndex = () => {
  indexDrawer.classList.add('open')
  indexDrawer.setAttribute('aria-hidden', 'false')
  renderCurriculumIndex()
  $('#index-search')?.focus()
}
const closeIndex = () => {
  indexDrawer.classList.remove('open')
  indexDrawer.setAttribute('aria-hidden', 'true')
}

$('#open-index')?.addEventListener('click', openIndex)
$('#top-open-index')?.addEventListener('click', openIndex)
document.querySelectorAll('[data-close-index]').forEach((el) => el.addEventListener('click', closeIndex))

function renderCurriculumIndex() {
  const listEl = $('#index-topic-list')
  if (!listEl) return

  $('#badge-all').textContent = TOPICS.length
  $('#badge-maths').textContent = TOPICS.filter((t) => t.subject === 'maths').length
  $('#badge-physics').textContent = TOPICS.filter((t) => t.subject === 'physics').length
  $('#badge-chemistry').textContent = TOPICS.filter((t) => t.subject === 'chemistry').length
  const floatingBadge = $('#floating-badge-count')
  if (floatingBadge) floatingBadge.textContent = TOPICS.length

  const q = searchQuery.trim().toLowerCase()

  if (curriculumView === 'tree') {
    // ---------------- HIERARCHICAL TREE VIEW ----------------
    const filteredBranches = CURRICULUM_TREE.filter((branch) => {
      if (activeSubject !== 'all' && branch.subject !== activeSubject) return false
      if (!q) return true
      if (branch.title.toLowerCase().includes(q) || branch.desc.toLowerCase().includes(q) || (branch.prereq && branch.prereq.toLowerCase().includes(q))) {
        return true
      }
      return branch.subtopics.some((s) =>
        s.title.toLowerCase().includes(q) ||
        s.desc.toLowerCase().includes(q) ||
        (s.relation && s.relation.toLowerCase().includes(q)) ||
        (s.prereq && s.prereq.toLowerCase().includes(q)) ||
        (s.leads_to && s.leads_to.toLowerCase().includes(q))
      )
    })

    // If searching, auto-expand all matching branches
    if (q) {
      filteredBranches.forEach((b) => expandedBranches.add(b.id))
    }

    if (!filteredBranches.length) {
      listEl.innerHTML = `
        <div class="empty" style="padding: 36px 0;">
          <div class="empty-icon">${ic('search')}</div>
          <h3>No topics or branches found</h3>
          <p class="muted">Try another keyword (e.g. "Bohr", "VSEPR", "Taylor", "Pythagoras") or select another subject tab.</p>
        </div>`
      renderIcons()
      return
    }

    // Group branches by subject
    const subjectGroups = [
      { id: 'maths', name: 'Mathematics', icon: 'sigma' },
      { id: 'physics', name: 'Physics', icon: 'zap' },
      { id: 'chemistry', name: 'Chemistry', icon: 'flask-conical' },
    ].filter((s) => activeSubject === 'all' || activeSubject === s.id)

    let html = ''
    for (const subj of subjectGroups) {
      const domainsInSubj = filteredBranches.filter((b) => b.subject === subj.id)
      if (!domainsInSubj.length) continue

      const totalBranchesInSubj = domainsInSubj.reduce((acc, d) => acc + d.branches.length, 0)
      const totalSubtopicsInSubj = domainsInSubj.reduce((acc, d) => acc + d.branches.reduce((bAcc, b) => bAcc + b.subtopics.length, 0), 0)
      html += `
        <div class="tree-subject-group">
          <div class="tree-subject-heading subject-${subj.id}">
            <div class="tree-subject-title">${ic(subj.icon)} <span>${subj.name} Curriculum</span></div>
            <span class="tree-subject-count">${domainsInSubj.length} Domains · ${totalBranchesInSubj} Branches · ${totalSubtopicsInSubj} Concepts</span>
          </div>`

      domainsInSubj.forEach((domain, dIdx) => {
        const isExpanded = expandedBranches.has(domain.id)
        const totalSubtopics = domain.branches.reduce((acc, b) => acc + b.subtopics.length, 0)
        html += `
          <div class="tree-branch subject-${domain.subject} ${isExpanded ? 'expanded' : ''}" data-branch-id="${domain.id}">
            <button type="button" class="branch-header" data-toggle-branch="${domain.id}">
              <div class="branch-title-row">
                <div class="branch-title-group">
                  <span class="topic-tag tag-${domain.subject}">${domain.subject.toUpperCase()} DOMAIN</span>
                  <span class="branch-title">${escapeHtml(domain.title)}</span>
                </div>
                <span class="branch-chevron">${ic('chevron-down')}</span>
              </div>
              <p class="branch-desc">${escapeHtml(domain.desc)}</p>
              <div class="branch-footer">
                <span class="branch-prereq-badge" title="Domain Foundation: ${escapeHtml(domain.prereq)}">
                  ${ic('corner-down-right')} <strong>Foundation:</strong> ${escapeHtml(domain.prereq)}
                </span>
                <span class="branch-count-badge">${domain.branches.length} Branches · ${totalSubtopics} Concepts</span>
              </div>
            </button>
            <div class="branch-body">`

        domain.branches.forEach((branch, brIdx) => {
          const branchMatches = !q ||
            branch.branch_title.toLowerCase().includes(q) ||
            branch.branch_desc.toLowerCase().includes(q) ||
            branch.relation.toLowerCase().includes(q) ||
            branch.subtopics.some((s) =>
              s.title.toLowerCase().includes(q) ||
              s.desc.toLowerCase().includes(q) ||
              (s.relation && s.relation.toLowerCase().includes(q))
            )
          if (!branchMatches) return

          html += `
              <div class="sub-branch-block">
                <div class="sub-branch-header">
                  <div class="sub-branch-title-row">
                    <div class="sub-branch-title">
                      ${ic('git-branch')}
                      <span>${escapeHtml(branch.branch_title)}</span>
                    </div>
                    <span class="sub-branch-count-tag">${branch.subtopics.length} Divided Concepts</span>
                  </div>
                  <p class="sub-branch-desc">${escapeHtml(branch.branch_desc)}</p>
                  <div class="sub-branch-interlink">
                    ${ic('link-2')}
                    <div><span class="sub-branch-interlink-tag">↳ Interlink:</span>${escapeHtml(branch.relation)}</div>
                  </div>
                </div>

                <div class="tree-rail">
                  <div class="tree-vertical-line"></div>`

          branch.subtopics.forEach((sub, sIdx) => {
            const subMatches = !q ||
              sub.title.toLowerCase().includes(q) ||
              sub.desc.toLowerCase().includes(q) ||
              (sub.relation && sub.relation.toLowerCase().includes(q)) ||
              (sub.prereq && sub.prereq.toLowerCase().includes(q)) ||
              (sub.leads_to && sub.leads_to.toLowerCase().includes(q))
            if (!subMatches) return

            const modeTag = sub.mode === '3d'
              ? `<span class="topic-mode is-3d">${ic('box')} 3D Space</span>`
              : `<span class="topic-mode">${ic('presentation')} 2D Board</span>`

            html += `
                  <div class="tree-node">
                    <div class="tree-connector-arm"></div>
                    <div class="tree-node-dot"></div>
                    <div class="subtopic-node-card" data-prompt="${escapeHtml(sub.prompt)}" data-mode="${sub.mode}">
                      <div class="node-top">
                        <div class="node-title-group">
                          <div class="node-badge-row">
                            <span class="node-step-badge">Concept ${dIdx + 1}.${String.fromCharCode(65 + brIdx)}.${sIdx + 1}</span>
                            ${modeTag}
                          </div>
                          <h4 class="node-title">${escapeHtml(sub.title)}</h4>
                        </div>
                        <div class="node-launch-icon" title="Learn this concept">${ic('arrow-right')}</div>
                      </div>
                      <p class="node-desc">${escapeHtml(sub.desc)}</p>
                      <div class="node-relation-box">
                        ${ic('link-2')}
                        <div><span class="node-relation-label">↳ Relation:</span>${escapeHtml(sub.relation || 'Builds systematically on preceding concepts.')}</div>
                      </div>
                      <div class="node-pathway">
                        <span class="pathway-pill prereq" title="Prerequisite knowledge">
                          ${ic('corner-down-right')} <strong>Prereq:</strong> ${escapeHtml(sub.prereq || 'Foundations')}
                        </span>
                        <span class="pathway-pill leads-to" title="Leads into next concept">
                          ${ic('arrow-right')} <strong>Leads to:</strong> ${escapeHtml(sub.leads_to || 'Advanced applications')}
                        </span>
                      </div>
                    </div>
                  </div>`
          })

          html += `
                </div>
              </div>`
        })

        html += `
            </div>
          </div>`
      })

      html += `</div>`
    }

    listEl.innerHTML = html

    // Wire branch accordion toggle clicks
    listEl.querySelectorAll('[data-toggle-branch]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const branchId = btn.dataset.toggleBranch
        if (expandedBranches.has(branchId)) {
          expandedBranches.delete(branchId)
        } else {
          expandedBranches.add(branchId)
        }
        renderCurriculumIndex()
      })
    })
  } else {
    // ---------------- A-Z DICTIONARY VIEW ----------------
    let filtered = TOPICS.filter((t) => {
      const matchSubj = activeSubject === 'all' || t.subject === activeSubject
      const matchSearch = !q || t.title.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q) || (t.relation && t.relation.toLowerCase().includes(q))
      return matchSubj && matchSearch
    })

    filtered.sort((a, b) => a.title.localeCompare(b.title))

    if (!filtered.length) {
      listEl.innerHTML = `
        <div class="empty" style="padding: 32px 0;">
          <div class="empty-icon">${ic('search')}</div>
          <h3>No topics found</h3>
          <p class="muted">Try another keyword or select a different subject tab.</p>
        </div>`
      renderIcons()
      return
    }

    let html = ''
    let lastLetter = ''
    for (const t of filtered) {
      const letter = t.title[0].toUpperCase()
      if (letter !== lastLetter && !q) {
        lastLetter = letter
        html += `<div class="index-letter-heading">${lastLetter}</div>`
      }
      const subjName = t.subject === 'maths' ? 'Mathematics' : t.subject === 'physics' ? 'Physics' : 'Chemistry'
      const modeTag = t.mode === '3d'
        ? `<span class="topic-mode is-3d">${ic('box')} 3D Space</span>`
        : `<span class="topic-mode">${ic('presentation')} 2D Board</span>`

      html += `
        <div class="index-topic-card subject-${t.subject}" data-prompt="${escapeHtml(t.prompt)}" data-mode="${t.mode}">
          <div>
            <div class="topic-meta">
              <span class="topic-tag tag-${t.subject}">${subjName}</span>
              ${modeTag}
            </div>
            <h4 class="topic-title">${escapeHtml(t.title)}</h4>
            <p class="topic-desc">${escapeHtml(t.desc)}</p>
          </div>
          <div class="topic-arrow">${ic('arrow-right')}</div>
        </div>`
    }
    listEl.innerHTML = html
  }

  // Wire subtopic launch clicks for both views
  listEl.querySelectorAll('.subtopic-node-card, .index-topic-card').forEach((card) => {
    card.addEventListener('click', async () => {
      const p = card.dataset.prompt
      const targetMode = card.dataset.mode
      closeIndex()
      if (targetMode && targetMode !== view) await setView(targetMode)
      ask(p, targetMode)
    })
  })

  // Update Expand All / Collapse All label based on state
  const expandText = $('#expand-toggle-text')
  if (expandText) {
    const allExpanded = CURRICULUM_TREE.every((b) => expandedBranches.has(b.id))
    expandText.textContent = allExpanded ? 'Collapse All' : 'Expand All'
  }

  renderIcons()
}

// Subject filter tabs
document.querySelectorAll('.index-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.index-tab').forEach((t) => t.classList.remove('active'))
    tab.classList.add('active')
    activeSubject = tab.dataset.subject
    renderCurriculumIndex()
  })
})

// View switch buttons (Tree Hierarchy vs A-Z Index)
document.querySelectorAll('.view-switch-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-switch-btn').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    curriculumView = btn.dataset.curriculumView
    renderCurriculumIndex()
  })
})

// Expand/Collapse all branches button
$('#index-expand-toggle')?.addEventListener('click', () => {
  const allExpanded = CURRICULUM_TREE.every((b) => expandedBranches.has(b.id))
  if (allExpanded) {
    expandedBranches.clear()
  } else {
    CURRICULUM_TREE.forEach((b) => expandedBranches.add(b.id))
  }
  renderCurriculumIndex()
})

const searchInp = $('#index-search')
const searchClr = $('#index-search-clear')
searchInp?.addEventListener('input', (e) => {
  searchQuery = e.target.value
  searchClr?.classList.toggle('hidden', !searchQuery)
  renderCurriculumIndex()
})
searchClr?.addEventListener('click', () => {
  searchInp.value = ''
  searchQuery = ''
  searchClr.classList.add('hidden')
  renderCurriculumIndex()
  searchInp.focus()
})

document.querySelectorAll('#mode-switch button').forEach((btn) => {
  btn.addEventListener('click', () => {
    setView(btn.dataset.mode, true)
  })
})

// Initial topic count badge setup
const floatingBadge = $('#floating-badge-count')
if (floatingBadge) floatingBadge.textContent = TOPICS.length

setView(view) // apply the saved mode: without this a reload in 3D kept the 3D stage hidden
  .catch((err) => console.warn('[chanakya] could not start the 3D view', err))

// ---------- profile drawer & memory ----------

const drawer = $('#drawer')
const openDrawer = () => { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); refreshMemory() }
const closeDrawer = () => { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true') }
$('#open-profile').addEventListener('click', openDrawer)
drawer.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeDrawer))
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer() })

async function refreshMemory() {
  const data = await (await fetch('/api/memory')).json()
  const form = $('#profile-form')
  for (const k of ['name', 'level', 'goal']) {
    if (document.activeElement !== form[k]) form[k].value = data.profile[k] || ''
  }

  const topics = Object.entries(data.topics)
  $('#topics').innerHTML = topics.length
    ? topics.map(([name, t]) => {
      const pct = t.attempts ? Math.round((t.correct / t.attempts) * 100) : 0
      const tone = pct >= 80 ? '' : pct >= 50 ? 'mid' : 'low'
      const stat = t.attempts ? `${t.correct}/${t.attempts} correct` : `seen ${t.seen}×`
      return `<div class="topic-row"><div class="top"><span>${escapeHtml(name)}</span><span>${stat}</span></div>
        <div class="bar"><i class="${t.attempts ? tone : ''}" style="width:${t.attempts ? pct : 0}%"></i></div></div>`
    }).join('')
    : '<p class="muted">No topics yet. Ask your first question!</p>'

  $('#notes').innerHTML = data.notes.length
    ? data.notes.slice(-8).reverse().map((n) => `<li>${escapeHtml(n.note)}</li>`).join('')
    : '<li class="muted">Nothing yet.</li>'
}

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const f = e.target
  await fetch('/api/memory/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: f.name.value, level: f.level.value, goal: f.goal.value }),
  })
  refreshMemory()
  closeDrawer()
})

$('#reset-memory').addEventListener('click', async () => {
  await fetch('/api/memory', { method: 'DELETE' })
  refreshMemory()
})

// ---------- startup ----------

fetch('/api/health').then((r) => r.json()).then((h) => {
  const missing = [!h.groq && 'GROQ_API_KEY', !h.deepgram && 'DEEPGRAM_API_KEY'].filter(Boolean)
  if (!missing.length) return
  const alert = $('#alert')
  alert.innerHTML = `${ic('triangle-alert')}<div>Add ${missing.map((k) => `<code>${k}</code>`).join(' and ')} to <code>.env</code>, then restart the server.${
    !h.deepgram ? ' Until then, the voice uses your browser and the mic is off.' : ''}</div>`
  alert.classList.remove('hidden')
  if (!h.deepgram) micBtn.disabled = true
  renderIcons()
})
refreshMemory()

// Debug handle for the browser console, e.g. chanakya.play({type:'step', say:'hi', draw:[...]})
// 3D: chanakya.play({type:'meta', mode:'3d', clear:true}) then chanakya.play({type:'step', say:'hi', draw3d:[{kind:'sphere', center:[0,0,1], r:1}]})
window.chanakya = {
  board,
  get scene() { return scene },
  setView,
  ask,
  stop,
  play: (ev) => play(ev, Promise.resolve(null), new AbortController().signal),
}
