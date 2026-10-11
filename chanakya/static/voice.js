// Voice: the browser's own speech by default, Deepgram when a key is configured.
//
// Nothing here is required for a lesson to work. Without DEEPGRAM_API_KEY the
// tutor speaks with speechSynthesis and the microphone uses the browser's
// SpeechRecognition - both free, both local to the browser, neither rate limited.
// The server tells us which engine is available through /api/health.

let voiceMode = 'browser' // 'browser' | 'deepgram', set from /api/health
let deepgramOk = true // flips off on the first 503, so we stop asking

export function setVoiceMode(mode) {
  voiceMode = mode === 'deepgram' ? 'deepgram' : 'browser'
  if (voiceMode === 'browser') deepgramOk = false
}

export const usingDeepgram = () => voiceMode === 'deepgram' && deepgramOk

// Fetch speech audio for a sentence. Resolves to an object URL, or null to use the browser voice.
export async function synthesize(text, signal) {
  if (!text?.trim() || !usingDeepgram()) return null
  try {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    })
    if (r.status === 503) deepgramOk = false // no key configured: stop trying
    if (!r.ok) return null
    return URL.createObjectURL(await r.blob())
  } catch {
    return null
  }
}

const estimateMs = (text) => Math.max(1200, (text.split(/\s+/).length / 2.6) * 1000)

// Start speaking. Returns { durationMs, done } as soon as the length is known,
// so the board can pace its drawing to the speech.
export async function speak(text, audioUrl, { enabled = true, signal } = {}) {
  if (!enabled || signal?.aborted || !text?.trim()) {
    return { durationMs: estimateMs(text || ''), done: Promise.resolve() }
  }

  if (audioUrl) {
    const audio = new Audio(audioUrl)
    await new Promise((res) => {
      if (audio.readyState >= 1) return res()
      const timer = setTimeout(res, 800)
      audio.addEventListener('loadedmetadata', () => { clearTimeout(timer); res() }, { once: true })
      audio.addEventListener('error', () => { clearTimeout(timer); res() }, { once: true })
    })
    const durationMs = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : estimateMs(text)
    const done = new Promise((res) => {
      let finished = false
      const finish = () => { if (finished) return; finished = true; URL.revokeObjectURL(audioUrl); res() }
      const safety = setTimeout(finish, durationMs + 1000)
      audio.addEventListener('ended', () => { clearTimeout(safety); finish() }, { once: true })
      audio.addEventListener('error', () => { clearTimeout(safety); finish() }, { once: true })
      signal?.addEventListener('abort', () => { clearTimeout(safety); audio.pause(); finish() }, { once: true })
      // If autoplay is blocked, 'ended' never fires: keep the lesson moving on a timer.
      audio.play().catch(() => setTimeout(finish, durationMs))
    })
    return { durationMs, done }
  }

  // Browser voice
  if (!('speechSynthesis' in window)) return { durationMs: estimateMs(text), done: Promise.resolve() }
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 1.05
  const durationMs = estimateMs(text)
  const done = new Promise((res) => {
    let finished = false
    const finish = () => { if (finished) return; finished = true; res() }
    const safety = setTimeout(finish, durationMs + 1500)
    u.onend = () => { clearTimeout(safety); finish() }
    u.onerror = () => { clearTimeout(safety); finish() }
    signal?.addEventListener('abort', () => { clearTimeout(safety); speechSynthesis.cancel(); finish() }, { once: true })
  })
  try {
    speechSynthesis.speak(u)
  } catch {
    return { durationMs, done: Promise.resolve() }
  }
  return { durationMs, done }
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel()
}

// ---------- live transcription ----------

const Recognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null

// Reports words as they are recognised. Uses Deepgram's streaming API through
// /api/listen when a key is configured, and the browser's own recognition otherwise.
// onText(text, isFinal) fires with the full running transcript (finalised words + current guess);
// onUtteranceEnd(text) fires after ~1.5 s of silence; onLevel(0..1) drives the input meter.
export class LiveMic {
  constructor({ onText, onUtteranceEnd, onLevel, onError } = {}) {
    this.cb = { onText, onUtteranceEnd, onLevel, onError }
    this.active = false
    this.engine = null
  }

  get text() {
    return [...(this.finals ?? []), this.interim].filter(Boolean).join(' ').trim()
  }

  async start() {
    if (this.active) return
    this.finals = []
    this.interim = ''
    this.handoff = false
    if (usingDeepgram()) {
      try {
        await this.startDeepgram()
        return
      } catch (err) {
        // The proxy hands us back to the browser when no key is configured.
        if (!this.handoff) throw err
        this.engine = null
      }
    }
    await this.startBrowser()
  }

  // ---------- Deepgram (streaming, through the local proxy) ----------

  async startDeepgram() {
    this.engine = 'deepgram'
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/api/listen`)
    this.closed = new Promise((res) => this.ws.addEventListener('close', res, { once: true }))
    this.ws.onmessage = (e) => this.handle(JSON.parse(e.data))
    // The server answers immediately with either a Deepgram stream or "use the
    // browser instead", so wait for one of those before touching the recorder.
    const handedOff = new Promise((res) => { this.resolveHandoff = res })
    await Promise.race([
      new Promise((res, rej) => {
        this.ws.addEventListener('open', res, { once: true })
        this.ws.addEventListener('error', () => rej(new Error('Could not reach the transcription service')), { once: true })
      }),
      handedOff,
    ])
    if (this.handoff) throw new Error('handoff-to-browser')

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    this.media = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.media.ondataavailable = (e) => {
      if (e.data.size && this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data)
    }
    this.media.start(250) // small chunks = low latency
    this.startMeter(this.stream)
    this.active = true
  }

  handle(msg) {
    if (msg.type === 'transcript') {
      if (msg.final) {
        if (msg.text) this.finals.push(msg.text)
        this.interim = ''
      } else {
        this.interim = msg.text
      }
      this.cb.onText?.(this.text, msg.final)
    } else if (msg.type === 'utterance_end') {
      if (this.text) this.cb.onUtteranceEnd?.(this.text)
    } else if (msg.type === 'use_browser') {
      // Server has no Deepgram key: hand over to the browser's own recognition.
      this.handoff = true
      deepgramOk = false
      voiceMode = 'browser'
      this.resolveHandoff?.()
      this.teardown()
    } else if (msg.type === 'error') {
      this.cb.onError?.(new Error(msg.message))
    }
  }

  // ---------- browser speech recognition (no API, no key) ----------

  async startBrowser() {
    if (!Recognition) {
      throw new Error('This browser has no speech recognition. Type your question instead, or use Chrome or Edge.')
    }
    this.engine = 'browser'
    // Permission first, so the meter and the recogniser share one prompt.
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })

    this.rec = new Recognition()
    this.rec.continuous = true
    this.rec.interimResults = true
    this.rec.lang = navigator.language || 'en-US'

    this.rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript.trim()
        if (!chunk) continue
        if (e.results[i].isFinal) {
          this.finals.push(chunk)
          this.interim = ''
          this.armPause()
        } else {
          this.interim = chunk
        }
      }
      this.cb.onText?.(this.text, true)
    }
    this.rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.cb.onError?.(new Error('Microphone access was blocked. Allow it in your browser to talk.'))
      } else if (e.error === 'network') {
        this.cb.onError?.(new Error("Browser speech recognition needs a network connection. Type your question instead."))
      }
      this.active = false
    }
    // Chrome stops on its own after a pause: finish the utterance rather than hang.
    this.rec.onend = () => {
      if (!this.active) return
      if (this.text) this.finishUtterance()
      else { try { this.rec.start() } catch { this.active = false } }
    }

    this.rec.start()
    this.startMeter(this.stream)
    this.active = true
  }

  // Pause-to-send, matching the Deepgram utterance_end behaviour (~1.5 s of silence).
  armPause() {
    clearTimeout(this.pauseTimer)
    this.pauseTimer = setTimeout(() => this.finishUtterance(), 1500)
  }

  finishUtterance() {
    clearTimeout(this.pauseTimer)
    if (!this.active) return
    const text = this.text
    this.active = false
    this.teardown()
    if (text) this.cb.onUtteranceEnd?.(text)
  }

  // Stop listening, wait for the last words to be finalised, and return the transcript.
  async stop() {
    if (!this.active) return this.text
    clearTimeout(this.pauseTimer)
    const engine = this.engine
    this.active = false
    if (engine === 'deepgram') {
      if (this.media?.state !== 'inactive') {
        await new Promise((res) => { this.media.onstop = res; this.media.stop() })
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }))
        await Promise.race([this.closed, new Promise((res) => setTimeout(res, 2500))])
      }
    } else {
      // Give the recogniser a moment to flush its last interim words.
      await new Promise((res) => setTimeout(res, 250))
    }
    this.teardown()
    return this.text
  }

  // Abandon without waiting for a transcript.
  cancel() {
    if (!this.active) return
    clearTimeout(this.pauseTimer)
    this.active = false
    this.teardown()
  }

  teardown() {
    cancelAnimationFrame(this.raf)
    if (this.media?.state !== 'inactive') { try { this.media.stop() } catch {} }
    if (this.rec) { try { this.rec.onend = null; this.rec.abort() } catch {} this.rec = null }
    this.audioCtx?.close().catch(() => {})
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close()
    this.cb.onLevel?.(0)
  }

  startMeter(stream) {
    this.audioCtx = new AudioContext()
    const analyser = this.audioCtx.createAnalyser()
    analyser.fftSize = 512
    this.audioCtx.createMediaStreamSource(stream).connect(analyser)
    const data = new Uint8Array(analyser.fftSize)
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (const v of data) sum += ((v - 128) / 128) ** 2
      this.cb.onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 4))
      this.raf = requestAnimationFrame(tick)
    }
    tick()
  }
}
