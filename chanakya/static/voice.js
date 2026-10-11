// Voice: Deepgram TTS/STT through the local server, with browser speech as a fallback.

let deepgramOk = true

// Fetch speech audio for a sentence. Resolves to an object URL, or null to use the browser voice.
export async function synthesize(text, signal) {
  if (!text?.trim() || !deepgramOk) return null
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

  // Browser fallback
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

// Streams the mic to /api/listen and reports words as they are recognised.
// onText(text, isFinal) fires with the full running transcript (finalised words + current guess);
// onUtteranceEnd(text) fires after ~1.5 s of silence; onLevel(0..1) drives the input meter.
export class LiveMic {
  constructor({ onText, onUtteranceEnd, onLevel, onError } = {}) {
    this.cb = { onText, onUtteranceEnd, onLevel, onError }
    this.active = false
  }

  get text() {
    return [...this.finals, this.interim].filter(Boolean).join(' ').trim()
  }

  async start() {
    if (this.active) return
    this.finals = []
    this.interim = ''
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/api/listen`)
    this.closed = new Promise((res) => this.ws.addEventListener('close', res, { once: true }))
    this.ws.onmessage = (e) => this.handle(JSON.parse(e.data))
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true })
      this.ws.addEventListener('error', () => rej(new Error('Could not reach the transcription service')), { once: true })
    })

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    this.media = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.media.ondataavailable = (e) => {
      if (e.data.size && this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data)
    }
    this.media.start(250) // small chunks = low latency
    this.startMeter()
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
    } else if (msg.type === 'error') {
      this.cb.onError?.(new Error(msg.message))
    }
  }

  // Stop listening, wait for the last words to be finalised, and return the transcript.
  async stop() {
    if (!this.active) return this.text
    this.active = false
    if (this.media?.state !== 'inactive') {
      await new Promise((res) => { this.media.onstop = res; this.media.stop() })
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }))
      await Promise.race([this.closed, new Promise((res) => setTimeout(res, 2500))])
    }
    this.cleanup()
    return this.text
  }

  // Abandon without waiting for a transcript.
  cancel() {
    if (!this.active) return
    this.active = false
    if (this.media?.state !== 'inactive') this.media.stop()
    this.cleanup()
  }

  cleanup() {
    cancelAnimationFrame(this.raf)
    this.audioCtx?.close().catch(() => {})
    this.stream?.getTracks().forEach((t) => t.stop())
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close()
    this.cb.onLevel?.(0)
  }

  startMeter() {
    this.audioCtx = new AudioContext()
    const analyser = this.audioCtx.createAnalyser()
    analyser.fftSize = 512
    this.audioCtx.createMediaStreamSource(this.stream).connect(analyser)
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
