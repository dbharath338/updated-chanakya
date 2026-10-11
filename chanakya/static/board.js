// Whiteboard: renders the tutor's shape commands onto tldraw, animated like hand drawing.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Tldraw, BaseBoxShapeUtil, HTMLContainer, T, toRichText, createShapeId } from 'tldraw'
import katex from 'katex'
import { compile } from 'mathjs'

const h = React.createElement

export const BOARD = { w: 1000, h: 640 }

const COLORS = {
  black: '#1d1d1d', grey: '#9fa8b2', blue: '#4465e9', 'light-blue': '#4ba1f1',
  red: '#e03131', 'light-red': '#f87777', green: '#099268', 'light-green': '#40c057',
  orange: '#e16919', yellow: '#f1ac4b', violet: '#ae3ec9', 'light-violet': '#e085f4',
}
// Models sometimes use everyday colour names that tldraw lacks.
const COLOR_ALIASES = { purple: 'violet', pink: 'light-red', gray: 'grey', brown: 'orange', cyan: 'light-blue', teal: 'green', gold: 'yellow' }
const color = (c) => {
  c = COLOR_ALIASES[c] ?? c
  return c in COLORS ? c : 'black'
}
const SIZES = new Set(['s', 'm', 'l', 'xl'])
const MATH_FONT = { s: 20, m: 28, l: 38, xl: 50 }
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d)

// ---------- custom KaTeX shape ----------

// ---------- custom KaTeX shape ----------

class MathShapeUtil extends BaseBoxShapeUtil {
  static type = 'math'
  static props = { w: T.number, h: T.number, latex: T.string, color: T.string, fontSize: T.number }

  getDefaultProps() {
    return { w: 200, h: 60, latex: '', color: 'black', fontSize: 28 }
  }

  canEdit() { return false }
  canResize() { return false }

  component(shape) {
    const { latex, fontSize } = shape.props
    const html = katex.renderToString(latex, { throwOnError: false, displayMode: true })
    return h(HTMLContainer, {
      className: 'math-shape',
      style: { width: shape.props.w, height: shape.props.h, fontSize, color: COLORS[shape.props.color] ?? COLORS.black },
    }, h('div', { dangerouslySetInnerHTML: { __html: html } }))
  }

  indicator(shape) {
    return h('rect', { width: shape.props.w, height: shape.props.h })
  }
}

function measureLatex(latex, fontSize) {
  const el = document.createElement('div')
  el.className = 'math-shape'
  el.style.cssText = `position:absolute;visibility:hidden;left:-9999px;font-size:${fontSize}px`
  el.innerHTML = katex.renderToString(latex, { throwOnError: false, displayMode: true })
  document.body.appendChild(el)
  const { width, height } = el.getBoundingClientRect()
  el.remove()
  return { w: Math.ceil(width) + 8, h: Math.ceil(height) + 8 }
}

// ---------- interactive 2D to 3D solid shape ----------

const FORMULAS = {
  cylinder: { title: '2D Circle ➔ 3D Cylinder', formula: 'V = \\pi r^2 h', desc: 'Flat 2D Circle (\\pi r^2) extruded along height h' },
  cube: { title: '2D Square ➔ 3D Cube', formula: 'V = s^3', desc: 'Flat 2D Square (s^2) extruded along depth s' },
  cone: { title: '2D Triangle/Circle ➔ 3D Cone', formula: 'V = \\frac{1}{3}\\pi r^2 h', desc: 'Circular base tapering to apex at height h' },
  sphere: { title: '2D Circle ➔ 3D Sphere', formula: 'V = \\frac{4}{3}\\pi r^3', desc: '2D Circle revolved 360° around central axis' },
  pyramid: { title: '2D Square ➔ 3D Pyramid', formula: 'V = \\frac{1}{3} A_{base} h', desc: 'Flat 2D Square base pulled to top vertex' },
  prism: { title: '2D Triangle ➔ 3D Prism', formula: 'V = A_{tri} \\times L', desc: '2D Triangle face extruded along depth L' },
  revolution: { title: '2D Curve ➔ Solid of Revolution', formula: 'V = \\pi \\int [f(x)]^2 dx', desc: '2D Profile curve revolved around the axis' },
  molecule: { title: '2D Lewis ➔ 3D VSEPR Molecule', formula: '\\theta = 104.5^\\circ \\quad \\text{H}_2\\text{O}', desc: 'Electron repulsion pushes atoms into 3D spatial geometry' },
  atom: { title: 'Bohr Atom & Orbitals', formula: 'E_n = -\\frac{13.6\\text{ eV}}{n^2}', desc: 'Quantized electron shells (n=1, n=2) around nucleus' },
  magnet: { title: 'Magnetic Dipole & Flux Lines', formula: '\\vec{F} = q(\\vec{v} \\times \\vec{B})', desc: '3D Looping magnetic field lines from North to South' },
}

function render3DSolid(ctx, w, h, solid, morph, rotX, rotY, baseColor, wireframe) {
  ctx.clearRect(0, 0, w, h)
  const cx = w / 2, cy = h / 2 - 12
  const scale = Math.min(w, h) * 0.33
  const camDist = 3.8

  // 3D rotation + perspective projection helper
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY)
  const cosX = Math.cos(rotX), sinX = Math.sin(rotX)

  function project(x, y, z) {
    const x1 = x * cosY + z * sinY
    const z1 = -x * sinY + z * cosY
    const y2 = y * cosX - z1 * sinX
    const z2 = y * sinX + z1 * cosX
    const factor = camDist / (camDist + z2)
    return {
      px: cx + x1 * scale * factor,
      py: cy + y2 * scale * factor,
      z: z2,
    }
  }

  // Soft light direction (top-right-front)
  const light = { x: 0.45, y: -0.65, z: 0.6 }
  const lightLen = Math.hypot(light.x, light.y, light.z)
  light.x /= lightLen; light.y /= lightLen; light.z /= lightLen

  // Geometry builder according to solid type & morph ratio (0 = flat 2D, 1 = full 3D)
  const faces = []
  const edges = []
  const m = Math.max(0.001, Math.min(1, morph))

  if (solid === 'cylinder') {
    const N = 24
    const R = 0.95
    const H = 1.35 * m
    const topPts = [], botPts = []
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2
      const x = Math.cos(a) * R, z = Math.sin(a) * R
      topPts.push({ x, y: -H / 2, z })
      botPts.push({ x, y: H / 2, z })
    }
    faces.push({ pts: botPts, normal: { x: 0, y: 1, z: 0 }, isCap: true })
    faces.push({ pts: [...topPts].reverse(), normal: { x: 0, y: -1, z: 0 }, isCap: true })
    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N
      const p1 = botPts[i], p2 = botPts[next], p3 = topPts[next], p4 = topPts[i]
      const midA = ((i + 0.5) / N) * Math.PI * 2
      faces.push({
        pts: [p1, p2, p3, p4],
        normal: { x: Math.cos(midA), y: 0, z: Math.sin(midA) },
        isSide: true,
      })
    }
  } else if (solid === 'cone') {
    const N = 24
    const R = 1.05
    const H = 1.45 * m
    const basePts = []
    const apex = { x: 0, y: -H / 2, z: 0 }
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2
      basePts.push({ x: Math.cos(a) * R, y: H / 2, z: Math.sin(a) * R })
    }
    faces.push({ pts: basePts, normal: { x: 0, y: 1, z: 0 }, isCap: true })
    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N
      const p1 = basePts[i], p2 = basePts[next]
      const midA = ((i + 0.5) / N) * Math.PI * 2
      faces.push({
        pts: [p1, p2, apex],
        normal: { x: Math.cos(midA) * 0.8, y: -0.5, z: Math.sin(midA) * 0.8 },
      })
    }
  } else if (solid === 'sphere') {
    const latN = 10, lonN = 18, R = 1.0
    for (let i = 0; i < latN; i++) {
      const lat1 = (i / latN - 0.5) * Math.PI
      const lat2 = ((i + 1) / latN - 0.5) * Math.PI
      const y1 = Math.sin(lat1) * R, y2 = Math.sin(lat2) * R
      const r1 = Math.cos(lat1) * R, r2 = Math.cos(lat2) * R
      for (let j = 0; j < lonN; j++) {
        const lon1 = (j / lonN) * Math.PI * 2 * m
        const lon2 = ((j + 1) / lonN) * Math.PI * 2 * m
        const p1 = { x: Math.cos(lon1) * r1, y: y1, z: Math.sin(lon1) * r1 }
        const p2 = { x: Math.cos(lon2) * r1, y: y1, z: Math.sin(lon2) * r1 }
        const p3 = { x: Math.cos(lon2) * r2, y: y2, z: Math.sin(lon2) * r2 }
        const p4 = { x: Math.cos(lon1) * r2, y: y2, z: Math.sin(lon1) * r2 }
        faces.push({ pts: [p1, p2, p3, p4] })
      }
    }
  } else if (solid === 'pyramid') {
    const S = 1.05, H = 1.35 * m
    const b1 = { x: -S, y: H / 2, z: -S }, b2 = { x: S, y: H / 2, z: -S }
    const b3 = { x: S, y: H / 2, z: S }, b4 = { x: -S, y: H / 2, z: S }
    const apex = { x: 0, y: -H / 2, z: 0 }
    faces.push({ pts: [b1, b2, b3, b4], normal: { x: 0, y: 1, z: 0 } })
    faces.push({ pts: [b1, b2, apex], normal: { x: 0, y: -0.6, z: -0.8 } })
    faces.push({ pts: [b2, b3, apex], normal: { x: 0.8, y: -0.6, z: 0 } })
    faces.push({ pts: [b3, b4, apex], normal: { x: 0, y: -0.6, z: 0.8 } })
    faces.push({ pts: [b4, b1, apex], normal: { x: -0.8, y: -0.6, z: 0 } })
  } else if (solid === 'prism') {
    const S = 1.0, D = 1.3 * m
    const f1 = { x: -S, y: 0.7, z: -D / 2 }, f2 = { x: S, y: 0.7, z: -D / 2 }, f3 = { x: 0, y: -0.7, z: -D / 2 }
    const b1 = { x: -S, y: 0.7, z: D / 2 }, b2 = { x: S, y: 0.7, z: D / 2 }, b3 = { x: 0, y: -0.7, z: D / 2 }
    faces.push({ pts: [f1, f2, f3], normal: { x: 0, y: 0, z: -1 } })
    faces.push({ pts: [b1, b3, b2], normal: { x: 0, y: 0, z: 1 } })
    faces.push({ pts: [f1, b1, b2, f2], normal: { x: 0, y: 1, z: 0 } })
    faces.push({ pts: [f2, b2, b3, f3], normal: { x: 0.8, y: -0.6, z: 0 } })
    faces.push({ pts: [f3, b3, b1, f1], normal: { x: -0.8, y: -0.6, z: 0 } })
  } else if (solid === 'molecule') {
    // VSEPR Water / Methane: morph pushes atoms from 2D plane into 3D spatial bond angles
    const O = { x: 0, y: 0, z: 0 }
    const angle = (104.5 * Math.PI) / 180
    const h1 = { x: Math.sin(angle / 2) * 1.1, y: 0, z: -Math.cos(angle / 2) * 1.1 * m }
    const h2 = { x: -Math.sin(angle / 2) * 1.1, y: 0, z: -Math.cos(angle / 2) * 1.1 * m }
    const lone = { x: 0, y: 0.9 * m, z: 0.6 * m }
    // Draw bond cylinders as quadrilaterals
    faces.push({ pts: [{ x: -0.1, y: 0, z: 0 }, { x: 0.1, y: 0, z: 0 }, { x: h1.x + 0.1, y: 0, z: h1.z }, { x: h1.x - 0.1, y: 0, z: h1.z }] })
    faces.push({ pts: [{ x: -0.1, y: 0, z: 0 }, { x: 0.1, y: 0, z: 0 }, { x: h2.x + 0.1, y: 0, z: h2.z }, { x: h2.x - 0.1, y: 0, z: h2.z }] })
    // Atoms as polygonal approximation
    const makeAtom = (c, r) => {
      const pts = []
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2
        pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r, z: c.z })
      }
      return { pts }
    }
    faces.push(makeAtom(O, 0.42))
    faces.push(makeAtom(h1, 0.28))
    faces.push(makeAtom(h2, 0.28))
    if (m > 0.3) faces.push(makeAtom(lone, 0.25))
  } else if (solid === 'atom') {
    // Bohr atom: nucleus + tilted electron rings
    const N = { x: 0, y: 0, z: 0 }
    const makeRing = (r, tiltX, tiltY) => {
      const pts = []
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2
        pts.push({
          x: Math.cos(a) * r,
          y: Math.sin(a) * r * Math.cos(tiltX * m),
          z: Math.sin(a) * r * Math.sin(tiltX * m),
        })
      }
      return { pts }
    }
    faces.push(makeRing(1.1, 0.6, 0))
    faces.push(makeRing(1.1, -0.6, 0))
    faces.push(makeRing(1.4, 1.2, 0))
    // Nucleus
    const pts = []
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      pts.push({ x: Math.cos(a) * 0.35, y: Math.sin(a) * 0.35, z: 0 })
    }
    faces.push({ pts })
  } else if (solid === 'magnet') {
    // Bar magnet + magnetic field loops
    const L = 0.8
    const n = [
      { x: -0.4, y: -L, z: -0.3 }, { x: 0.4, y: -L, z: -0.3 }, { x: 0.4, y: 0, z: -0.3 }, { x: -0.4, y: 0, z: -0.3 },
      { x: -0.4, y: -L, z: 0.3 }, { x: 0.4, y: -L, z: 0.3 }, { x: 0.4, y: 0, z: 0.3 }, { x: -0.4, y: 0, z: 0.3 },
    ]
    faces.push({ pts: [n[0], n[1], n[2], n[3]], normal: { x: 0, y: 0, z: -1 } })
    faces.push({ pts: [n[4], n[7], n[6], n[5]], normal: { x: 0, y: 0, z: 1 } })
    faces.push({ pts: [n[0], n[4], n[5], n[1]], normal: { x: 0, y: -1, z: 0 } })
    // South pole
    const s = [
      { x: -0.4, y: 0, z: -0.3 }, { x: 0.4, y: 0, z: -0.3 }, { x: 0.4, y: L, z: -0.3 }, { x: -0.4, y: L, z: -0.3 },
      { x: -0.4, y: 0, z: 0.3 }, { x: 0.4, y: 0, z: 0.3 }, { x: 0.4, y: L, z: 0.3 }, { x: -0.4, y: L, z: 0.3 },
    ]
    faces.push({ pts: [s[0], s[1], s[2], s[3]], normal: { x: 0, y: 0, z: -1 } })
    faces.push({ pts: [s[4], s[7], s[6], s[5]], normal: { x: 0, y: 0, z: 1 } })
    faces.push({ pts: [s[2], s[6], s[7], s[3]], normal: { x: 0, y: 1, z: 0 } })
    // Magnetic field line loops in 3D
    for (const ang of [0, Math.PI / 3, -Math.PI / 3]) {
      const loop = []
      for (let i = 0; i < 20; i++) {
        const t = (i / 20) * Math.PI * 2
        const rad = 1.35 * (1.1 - 0.4 * Math.sin(t) ** 2)
        loop.push({
          x: Math.cos(t) * rad * Math.cos(ang * m),
          y: Math.sin(t) * (L * 1.5),
          z: Math.cos(t) * rad * Math.sin(ang * m),
        })
      }
      faces.push({ pts: loop })
    }
  } else {
    // default: cube / cuboid
    const S = 0.95, D = 0.95 * m
    const p = [
      { x: -S, y: -S, z: -D }, { x: S, y: -S, z: -D }, { x: S, y: S, z: -D }, { x: -S, y: S, z: -D },
      { x: -S, y: -S, z: D }, { x: S, y: -S, z: D }, { x: S, y: S, z: D }, { x: -S, y: S, z: D },
    ]
    faces.push({ pts: [p[0], p[1], p[2], p[3]], normal: { x: 0, y: 0, z: -1 } })
    faces.push({ pts: [p[4], p[7], p[6], p[5]], normal: { x: 0, y: 0, z: 1 } })
    faces.push({ pts: [p[0], p[4], p[5], p[1]], normal: { x: 0, y: -1, z: 0 } })
    faces.push({ pts: [p[2], p[6], p[7], p[3]], normal: { x: 0, y: 1, z: 0 } })
    faces.push({ pts: [p[1], p[5], p[6], p[2]], normal: { x: 1, y: 0, z: 0 } })
    faces.push({ pts: [p[0], p[3], p[7], p[4]], normal: { x: -1, y: 0, z: 0 } })
  }

  // Project all face vertices and calculate average depth Z
  const renderedFaces = faces.map((f) => {
    const projPts = f.pts.map((pt) => project(pt.x, pt.y, pt.z))
    const avgZ = projPts.reduce((sum, p) => sum + p.z, 0) / projPts.length
    return { ...f, projPts, avgZ }
  })

  // Painter's algorithm: sort faces from furthest to nearest
  renderedFaces.sort((a, b) => b.avgZ - a.avgZ)

  // Draw 2D ground/grid shadow or guide plane
  ctx.save()
  ctx.strokeStyle = '#e2e8f0'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  const g1 = project(-1.4, 0.9, -1.4), g2 = project(1.4, 0.9, -1.4)
  const g3 = project(1.4, 0.9, 1.4), g4 = project(-1.4, 0.9, 1.4)
  ctx.moveTo(g1.px, g1.py); ctx.lineTo(g2.px, g2.py); ctx.lineTo(g3.px, g3.py); ctx.lineTo(g4.px, g4.py); ctx.closePath()
  ctx.stroke()
  ctx.restore()

  // Draw faces
  const hex = COLORS[baseColor] || COLORS.blue
  for (const f of renderedFaces) {
    if (f.projPts.length < 3) continue
    ctx.beginPath()
    ctx.moveTo(f.projPts[0].px, f.projPts[0].py)
    for (let i = 1; i < f.projPts.length; i++) ctx.lineTo(f.projPts[i].px, f.projPts[i].py)
    ctx.closePath()

    let norm = f.normal
    if (!norm) {
      // Calculate normal via cross product
      const p0 = f.pts[0], p1 = f.pts[1], p2 = f.pts[2]
      const v1 = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z }
      const v2 = { x: p2.x - p0.x, y: p2.y - p0.y, z: p2.z - p0.z }
      norm = {
        x: v1.y * v2.z - v1.z * v2.y,
        y: v1.z * v2.x - v1.x * v2.z,
        z: v1.x * v2.y - v1.y * v2.x,
      }
      const len = Math.hypot(norm.x, norm.y, norm.z) || 1
      norm.x /= len; norm.y /= len; norm.z /= len
    }

    // World to rotated normal
    const nx1 = norm.x * cosY + norm.z * sinY
    const nz1 = -norm.x * sinY + norm.z * cosY
    const ny2 = norm.y * cosX - nz1 * sinX
    const nz2 = norm.y * sinX + nz1 * cosX
    const dot = Math.max(0.18, nx1 * light.x + ny2 * light.y + nz2 * light.z)

    if (!wireframe) {
      ctx.fillStyle = hex
      ctx.globalAlpha = 0.28 + dot * 0.55
      ctx.fill()
    }

    ctx.strokeStyle = hex
    ctx.globalAlpha = wireframe ? 0.85 : 0.95
    ctx.lineWidth = wireframe ? 1.4 : 1.8
    ctx.stroke()
  }

  // Draw 2D indicator overlay when morph is near 0
  if (morph < 0.25) {
    ctx.save()
    ctx.fillStyle = '#e03131'
    ctx.font = '600 13px Inter, sans-serif'
    ctx.fillText('2D Base Cross-Section', 16, 32)
    ctx.restore()
  }
}

class Solid3DShapeUtil extends BaseBoxShapeUtil {
  static type = 'solid3d'
  static props = {
    w: T.number,
    h: T.number,
    solid: T.string,
    label: T.string,
    color: T.string,
    morph: T.number,
    autoRotate: T.boolean,
    wireframe: T.boolean,
  }

  getDefaultProps() {
    return {
      w: 430,
      h: 350,
      solid: 'cylinder',
      label: '2D to 3D Extrusion',
      color: 'blue',
      morph: 1,
      autoRotate: true,
      wireframe: false,
    }
  }

  canEdit() { return false }
  canResize() { return true }

  component(shape) {
    const { w, h: shapeH, solid = 'cylinder', label, color: shapeColor, morph = 1 } = shape.props
    const canvasRef = React.useRef(null)
    const [rotX, setRotX] = React.useState(0.42)
    const [rotY, setRotY] = React.useState(0.55)
    const [localMorph, setLocalMorph] = React.useState(morph)
    const [autoSpin, setAutoSpin] = React.useState(true)
    const [wireframe, setWireframe] = React.useState(false)
    const dragRef = React.useRef({ isDragging: false, startX: 0, startY: 0, lastX: 0, lastY: 0 })

    // Sync external animation updates to localMorph
    React.useEffect(() => {
      setLocalMorph(morph)
    }, [morph])

    // Auto-spin animation loop
    React.useEffect(() => {
      let animId
      const tick = () => {
        if (autoSpin && !dragRef.current.isDragging) {
          setRotY((r) => r + 0.008)
        }
        animId = requestAnimationFrame(tick)
      }
      animId = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(animId)
    }, [autoSpin])

    // Canvas drawing whenever rotation or morph changes
    React.useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      render3DSolid(ctx, w, shapeH - 58, solid, localMorph, rotX, rotY, shapeColor, wireframe)
    }, [w, shapeH, solid, localMorph, rotX, rotY, shapeColor, wireframe])

    // Pointer events for interactive 3D orbit
    const onPointerDown = (e) => {
      e.stopPropagation()
      dragRef.current = { isDragging: true, startX: e.clientX, startY: e.clientY, lastRotX: rotX, lastRotY: rotY }
      canvasRef.current?.setPointerCapture?.(e.pointerId)
    }

    const onPointerMove = (e) => {
      if (!dragRef.current.isDragging) return
      e.stopPropagation()
      const dx = (e.clientX - dragRef.current.startX) * 0.012
      const dy = (e.clientY - dragRef.current.startY) * 0.012
      setRotY(dragRef.current.lastRotY + dx)
      setRotX(Math.max(-1.4, Math.min(1.4, dragRef.current.lastRotX + dy)))
    }

    const onPointerUp = (e) => {
      if (dragRef.current.isDragging) {
        e.stopPropagation()
        dragRef.current.isDragging = false
        try { canvasRef.current?.releasePointerCapture?.(e.pointerId) } catch {}
      }
    }

    const info = FORMULAS[solid] || FORMULAS.cylinder
    const formulaHtml = katex.renderToString(info.formula, { throwOnError: false })

    return h(HTMLContainer, {
      className: 'solid3d-container',
      style: { width: w, height: shapeH, pointerEvents: 'all' },
    }, [
      // Top header with title & KaTeX formula
      h('div', { key: 'head', className: 'solid3d-header' }, [
        h('div', { key: 'title', className: 'solid3d-title' }, [
          h('span', { key: 'badge', className: 'solid3d-badge' }, '3D View'),
          h('span', { key: 'txt' }, label || info.title),
        ]),
        h('div', {
          key: 'formula',
          className: 'solid3d-formula',
          dangerouslySetInnerHTML: { __html: formulaHtml },
        }),
      ]),

      // 3D Canvas element
      h('canvas', {
        key: 'canvas',
        ref: canvasRef,
        width: w,
        height: Math.max(120, shapeH - 62),
        className: 'solid3d-canvas',
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        title: 'Click and drag to rotate in 3D',
      }),

      // Interactive control dock
      h('div', { key: 'controls', className: 'solid3d-controls' }, [
        h('div', { key: 'morph-slider', className: 'solid3d-slider-group' }, [
          h('button', {
            key: 'btn-2d',
            type: 'button',
            className: `solid3d-mini-btn ${localMorph <= 0.05 ? 'active' : ''}`,
            onClick: (e) => { e.stopPropagation(); setLocalMorph(0) },
          }, '2D Flat'),
          h('input', {
            key: 'slider',
            type: 'range',
            min: 0,
            max: 1,
            step: 0.02,
            value: localMorph,
            className: 'solid3d-slider',
            onChange: (e) => { e.stopPropagation(); setLocalMorph(parseFloat(e.target.value)) },
            onPointerDown: (e) => e.stopPropagation(),
          }),
          h('button', {
            key: 'btn-3d',
            type: 'button',
            className: `solid3d-mini-btn ${localMorph >= 0.95 ? 'active' : ''}`,
            onClick: (e) => { e.stopPropagation(); setLocalMorph(1) },
          }, '3D Solid'),
        ]),

        h('div', { key: 'actions', className: 'solid3d-actions' }, [
          h('button', {
            key: 'spin',
            type: 'button',
            className: `solid3d-icon-btn ${autoSpin ? 'on' : ''}`,
            title: autoSpin ? 'Pause auto-rotation' : 'Play auto-rotation',
            onClick: (e) => { e.stopPropagation(); setAutoSpin(!autoSpin) },
          }, autoSpin ? '⏸' : '▶'),
          h('button', {
            key: 'wire',
            type: 'button',
            className: `solid3d-icon-btn ${wireframe ? 'on' : ''}`,
            title: 'Toggle wireframe',
            onClick: (e) => { e.stopPropagation(); setWireframe(!wireframe) },
          }, wireframe ? 'Solid' : 'Wire'),
          h('button', {
            key: 'reset',
            type: 'button',
            className: 'solid3d-icon-btn',
            title: 'Reset camera angle',
            onClick: (e) => { e.stopPropagation(); setRotX(0.42); setRotY(0.55) },
          }, '↺'),
        ]),
      ]),
    ])
  }

  indicator(shape) {
    return h('rect', { width: shape.props.w, height: shape.props.h })
  }
}

// ---------- animation helpers ----------

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve()
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

function animate(ms, signal, onFrame) {
  return new Promise((resolve) => {
    const start = performance.now()
    const tick = (now) => {
      // rAF timestamps can predate `start`, so clamp to [0, 1]
      const t = Math.max(0, Math.min(1, (now - start) / ms))
      try {
        onFrame(t)
      } catch (err) {
        console.warn('[board] animation frame failed', err)
        return resolve() // never leave the lesson waiting on a broken animation
      }
      if (t >= 1 || signal?.aborted) return resolve()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

// Spread points so freehand strokes look smooth and can be revealed progressively.
function densify(points, step = 6) {
  const out = []
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1]
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step))
    for (let k = 0; k < n; k++) out.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n])
  }
  if (points.length) out.push(points[points.length - 1])
  return out
}

// ---------- board ----------

export class Board {
  constructor(editor) {
    this.editor = editor
    this.fit(false)
    window.addEventListener('resize', () => this.fit(false))
  }

  fit(animated = true) {
    this.editor.zoomToBounds(
      { x: 0, y: 0, w: BOARD.w, h: BOARD.h },
      { inset: 24, animation: animated ? { duration: 250 } : undefined },
    )
  }

  clear() {
    const ids = [...this.editor.getCurrentPageShapeIds()]
    if (ids.length) this.editor.deleteShapes(ids)
    this.fit(false)
  }

  setTheme(dark) {
    try {
      this.editor.user.updateUserPreferences({ isDarkMode: !!dark })
    } catch {}
  }

  // Draw a list of shapes over roughly `durationMs` (the length of the spoken sentence).
  async render(shapes, durationMs, signal) {
    if (!shapes?.length) return
    const budget = Math.max(250, (durationMs * 0.85) / shapes.length)
    for (const s of shapes) {
      if (signal?.aborted) return
      try {
        await this.drawShape(s, budget, signal)
      } catch (err) {
        console.warn('[board] skipped shape', s, err)
      }
      this.keepInView()
    }
  }

  // If the tutor drew past the board edges, zoom out so everything stays visible.
  keepInView() {
    const b = this.editor.getCurrentPageBounds()
    if (!b) return
    const overflow = b.minX < -10 || b.minY < -10 || b.maxX > BOARD.w + 10 || b.maxY > BOARD.h + 10
    if (!overflow) return
    const x = Math.min(0, b.minX), y = Math.min(0, b.minY)
    this.editor.zoomToBounds(
      { x, y, w: Math.max(BOARD.w, b.maxX) - x, h: Math.max(BOARD.h, b.maxY) - y },
      { inset: 24, animation: { duration: 300 } },
    )
  }

  quiet(fn) {
    // Animation frames should not flood the undo stack.
    this.editor.run(fn, { history: 'ignore' })
  }

  async drawShape(s, budget, signal) {
    const e = this.editor
    const id = createShapeId()
    const c = color(s.color)

    switch (s.kind) {
      case 'text': {
        const full = String(s.text ?? '')
        const size = SIZES.has(s.size) ? s.size : 'm'
        e.createShape({ id, type: 'text', x: num(s.x), y: num(s.y),
          props: { richText: toRichText(''), color: c, size, font: 'draw', autoSize: true } })
        await animate(Math.min(budget, full.length * 35), signal, (t) => {
          const n = Math.ceil(full.length * t)
          this.quiet(() => e.updateShape({ id, type: 'text', props: { richText: toRichText(full.slice(0, n)) } }))
        })
        return
      }

      case 'math': {
        const fontSize = MATH_FONT[s.size] ?? MATH_FONT.m
        const latex = String(s.latex ?? '')
        const { w, h: hh } = measureLatex(latex, fontSize)
        e.createShape({ id, type: 'math', x: num(s.x), y: num(s.y), opacity: 0,
          props: { latex, w, h: hh, color: c, fontSize } })
        await animate(Math.min(budget, 400), signal, (t) => this.quiet(() => e.updateShape({ id, type: 'math', opacity: t })))
        return
      }

      case 'rect': case 'ellipse': case 'triangle': case 'diamond': case 'circle': {
        const isCircle = s.kind === 'circle'
        const r = num(s.r, 50)
        const x = isCircle ? num(s.cx) - r : num(s.x)
        const y = isCircle ? num(s.cy) - r : num(s.y)
        const w = isCircle ? 2 * r : Math.max(10, num(s.w, 100))
        const hh = isCircle ? 2 * r : Math.max(10, num(s.h, 100))
        e.createShape({ id, type: 'geo', x, y, opacity: 0, props: {
          geo: isCircle ? 'ellipse' : s.kind === 'rect' ? 'rectangle' : s.kind,
          w, h: hh, color: c, fill: s.fill ? 'semi' : 'none', size: 'm', font: 'draw',
          richText: toRichText(String(s.label ?? '')),
        } })
        await animate(Math.min(budget, 450), signal, (t) => this.quiet(() => e.updateShape({ id, type: 'geo', opacity: t })))
        return
      }

      case 'line': {
        const pts = (s.points ?? []).filter((p) => Array.isArray(p) && p.length >= 2).map(([x, y]) => [num(x), num(y)])
        if (pts.length < 2) return
        if (s.closed) pts.push(pts[0])
        await this.stroke(pts, c, budget, signal)
        return
      }

      case 'arrow': {
        const [x1, y1] = (s.from ?? [0, 0]).map((v) => num(v))
        const [x2, y2] = (s.to ?? [100, 0]).map((v) => num(v))
        e.createShape({ id, type: 'arrow', x: x1, y: y1, props: {
          start: { x: 0, y: 0 }, end: { x: 0.1, y: 0.1 }, color: c, size: 'm', font: 'draw', text: '',
        } })
        await animate(Math.min(budget, 600), signal, (t) => this.quiet(() =>
          e.updateShape({ id, type: 'arrow', props: { end: { x: (x2 - x1) * t || 0.1, y: (y2 - y1) * t || 0.1 } } })))
        if (s.label) e.updateShape({ id, type: 'arrow', props: { text: String(s.label) } })
        return
      }

      case 'solid3d': case '3d': case 'mesh3d': {
        const sw = Math.max(260, num(s.w, 420)), sh = Math.max(220, num(s.h, 340))
        const solidType = String(s.solid || 'cylinder')
        const solidColor = color(s.color || 'blue')
        const solidLabel = String(s.label || FORMULAS[solidType]?.title || '2D to 3D Extrusion')
        e.createShape({
          id,
          type: 'solid3d',
          x: num(s.x, 60),
          y: num(s.y, 100),
          props: {
            w: sw,
            h: sh,
            solid: solidType,
            label: solidLabel,
            color: solidColor,
            morph: 0,
            autoRotate: s.autoRotate ?? true,
            wireframe: Boolean(s.wireframe),
          },
        })
        // Smoothly animate the 2D cross-section into the 3D solid over the spoken duration
        const morphTime = Math.min(budget, 1400)
        await animate(morphTime, signal, (t) => {
          this.quiet(() => e.updateShape({ id, type: 'solid3d', props: { morph: t } }))
        })
        return
      }

      case 'plot':
        await this.plot(s, budget, signal)
        return

      default:
        console.warn('[board] unknown shape kind', s.kind)
    }
  }

  // Freehand stroke revealed progressively, like a pen moving.
  async stroke(points, c, budget, signal) {
    const e = this.editor
    const id = createShapeId()
    const dense = densify(points)
    const [ox, oy] = dense[0]
    const rel = dense.map(([x, y]) => ({ x: x - ox, y: y - oy, z: 0.5 }))
    const seg = (n) => [{ type: 'free', points: rel.slice(0, Math.max(2, n)) }]
    e.createShape({ id, type: 'draw', x: ox, y: oy,
      props: { segments: seg(2), color: c, size: 'm', isComplete: false, isPen: false } })
    await animate(Math.min(budget, 300 + dense.length * 4), signal, (t) => this.quiet(() =>
      e.updateShape({ id, type: 'draw', props: { segments: seg(Math.ceil(rel.length * t)) } })))
    this.quiet(() => e.updateShape({ id, type: 'draw', props: { segments: seg(rel.length), isComplete: true } }))
  }

  async plot(s, budget, signal) {
    const x0 = num(s.x, 60), y0 = num(s.y, 120)
    const w = Math.max(80, num(s.w, 400)), hh = Math.max(80, num(s.h, 300))
    let xmin = num(s.xmin, -5), xmax = num(s.xmax, 5)
    if (xmax <= xmin) [xmin, xmax] = [-5, 5]

    let f
    try { f = compile(String(s.fn ?? 'x')) } catch { return }
    const N = 160
    const samples = []
    for (let i = 0; i <= N; i++) {
      const x = xmin + ((xmax - xmin) * i) / N
      let y
      try { y = Number(f.evaluate({ x })) } catch { y = NaN }
      samples.push([x, Number.isFinite(y) ? y : NaN])
    }
    const ys = samples.map(([, y]) => y).filter(Number.isFinite)
    if (!ys.length) return
    let ymin = Number.isFinite(+s.ymin) ? +s.ymin : Math.min(...ys)
    let ymax = Number.isFinite(+s.ymax) ? +s.ymax : Math.max(...ys)
    if (s.ymin == null && s.ymax == null) {
      // include y=0 so the x-axis is visible, and pad a little
      ymin = Math.min(ymin, 0); ymax = Math.max(ymax, 0)
      const pad = (ymax - ymin || 2) * 0.1
      ymin -= pad; ymax += pad
    }
    const X = (x) => x0 + ((x - xmin) / (xmax - xmin)) * w
    const Y = (y) => y0 + hh - ((y - ymin) / (ymax - ymin)) * hh
    const axisBudget = Math.min(500, budget * 0.25)

    // axes (through 0 when visible, otherwise along the box edge)
    const ax = Math.min(Math.max(0, ymin), ymax), ay = Math.min(Math.max(0, xmin), xmax)
    await this.drawShape({ kind: 'arrow', from: [x0, Y(ax)], to: [x0 + w + 12, Y(ax)], color: 'grey' }, axisBudget, signal)
    await this.drawShape({ kind: 'arrow', from: [X(ay), y0 + hh], to: [X(ay), y0 - 12], color: 'grey' }, axisBudget, signal)

    // split the curve wherever it is undefined or leaves the box
    const runs = [[]]
    for (const [x, y] of samples) {
      if (!Number.isFinite(y) || y < ymin || y > ymax) { if (runs.at(-1).length) runs.push([]); continue }
      runs.at(-1).push([X(x), Y(y)])
    }
    const curveBudget = budget * 0.6
    for (const run of runs.filter((r) => r.length > 1)) {
      await this.stroke(run, color(s.color ?? 'blue'), curveBudget / runs.length, signal)
    }
    if (s.label) {
      await this.drawShape({ kind: 'text', x: x0 + w - 60, y: y0 - 30, text: s.label, size: 's', color: s.color ?? 'blue' }, 300, signal)
    }
  }
}

export function mountBoard(el) {
  return new Promise((resolve) => {
    createRoot(el).render(h(Tldraw, {
      shapeUtils: [MathShapeUtil, Solid3DShapeUtil],
      inferDarkMode: false,
      // the always-open style panel covers the top-right of the lesson area
      components: { StylePanel: null },
      onMount: (editor) => resolve(new Board(editor)),
    }))
  })
}

export { sleep, animate }
