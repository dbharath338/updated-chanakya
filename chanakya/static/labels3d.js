// Screen-space label layout for the 3D stage. Runs every frame:
// - labels on a model's parts become callouts, stacked in tidy columns left and right of the model
//   with leader lines back to the exact spot (like a textbook diagram);
// - other labels take the nearest free spot around their anchor, getting a leader line if pushed away;
// - nothing overlaps another label, the notes column or the toolbar; axis letters dim rather than move far.
import * as THREE from 'three'

const SVG = 'http://www.w3.org/2000/svg'
const EDGE = 8

const overlapArea = (a, b, pad = 3) => {
  const w = Math.min(a.x + a.w + pad, b.x + b.w + pad) - Math.max(a.x - pad, b.x - pad)
  const h = Math.min(a.y + a.h + pad, b.y + b.h + pad) - Math.max(a.y - pad, b.y - pad)
  return w > 0 && h > 0 ? w * h : 0
}

function attached(obj, scene) {
  for (let o = obj; o; o = o.parent) if (o === scene) return true
  return false
}

function visible(obj) {
  for (let o = obj; o; o = o.parent) if (!o.visible) return false
  return true
}

export class LabelLayer {
  constructor(el) {
    this.el = el
    this.svg = document.createElementNS(SVG, 'svg')
    this.svg.classList.add('leaders')
    el.appendChild(this.svg)
    this.items = []
    this.tmp = new THREE.Vector3()
    this.box = new THREE.Box3()
  }

  /**
   * obj: the Object3D the label follows; local: offset in obj's local space.
   * callout: lay out in columns beside `owner` (the whole model) with a leader line.
   */
  add(obj, html, { color = '#1d1d1d', local = null, callout = false, owner = null, axis = false } = {}) {
    const el = document.createElement('div')
    el.className = `label3d${axis ? ' axis' : ''}${callout ? ' callout' : ''}`
    el.style.setProperty('--c', color)
    el.innerHTML = html
    el.style.display = 'none'
    this.el.appendChild(el)
    const line = document.createElementNS(SVG, 'path')
    line.setAttribute('stroke', color)
    const dot = document.createElementNS(SVG, 'circle')
    dot.setAttribute('fill', color)
    this.svg.append(line, dot)
    const item = { obj, local: local?.clone() ?? new THREE.Vector3(), el, line, dot, callout, owner: owner ?? obj, axis, w: 0, h: 0, cand: -1, fade: 1 }
    ;(obj.userData.labelItems ??= []).push(item)
    this.items.push(item)
    return item
  }

  remove(item) {
    item.el.remove(); item.line.remove(); item.dot.remove()
    this.items = this.items.filter((i) => i !== item)
  }

  clear() {
    for (const i of [...this.items]) this.remove(i)
  }

  layout(scene, camera, W, H, avoid = []) {
    const placed = avoid.filter(Boolean).map((r) => ({ ...r }))
    const live = []
    for (const it of [...this.items]) {
      if (!attached(it.obj, scene)) { this.remove(it); continue }
      const p = this.tmp.copy(it.local).applyMatrix4(it.obj.matrixWorld).project(camera)
      if (p.z > 1 || p.z < -1 || Math.abs(p.x) > 1.25 || Math.abs(p.y) > 1.25 || !visible(it.obj) || it.fade < 0.02) { hide(it); continue }
      if (!it.w) {
        it.el.style.display = ''
        it.w = it.el.offsetWidth; it.h = it.el.offsetHeight
        if (!it.w) { hide(it); continue }
      }
      it.ax = ((p.x + 1) / 2) * W
      it.ay = ((1 - p.y) / 2) * H
      live.push(it)
    }
    const owners = new Map()
    for (const it of live) if (it.callout) owners.set(it.owner, [...(owners.get(it.owner) ?? []), it])
    for (const [owner, list] of owners) this.columns(owner, list, camera, W, H, placed)
    for (const it of live.filter((i) => !i.callout).sort((a, b) => a.axis - b.axis)) this.nearby(it, W, H, placed)
  }

  screenBox(owner, camera, W, H) {
    this.box.setFromObject(owner)
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    const { min, max } = this.box
    for (let i = 0; i < 8; i++) {
      const p = this.tmp.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).project(camera)
      if (p.z > 1) continue
      const x = ((p.x + 1) / 2) * W, y = ((1 - p.y) / 2) * H
      b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x); b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y)
    }
    if (!Number.isFinite(b.minX)) Object.assign(b, { minX: W / 2, maxX: W / 2, minY: 0, maxY: H })
    b.cx = (b.minX + b.maxX) / 2
    return b
  }

  // Two columns of callouts beside the model, ordered top-to-bottom by their anchors so lines never cross.
  columns(owner, list, camera, W, H, placed) {
    const box = this.screenBox(owner, camera, W, H)
    const sides = { left: [], right: [] }
    for (const it of list) sides[it.ax < box.cx ? 'left' : 'right'].push(it)
    // keep the columns balanced: move the outermost anchors across if one side is crowded
    while (sides.left.length > sides.right.length + 2) sides.right.push(sides.left.sort((a, b) => b.ax - a.ax).shift())
    while (sides.right.length > sides.left.length + 2) sides.left.push(sides.right.sort((a, b) => a.ax - b.ax).shift())
    const gap = 6
    for (const [side, items] of Object.entries(sides)) {
      items.sort((a, b) => a.ay - b.ay)
      for (const it of items) {
        it.x = side === 'right' ? Math.min(W - EDGE - it.w, box.maxX + 28) : Math.max(EDGE, box.minX - 28 - it.w)
        it.y = it.ay - it.h / 2
      }
      let bottom = EDGE - gap
      for (const it of items) {
        it.y = Math.max(it.y, bottom + gap)
        for (const r of placed) if (overlapArea({ x: it.x, y: it.y, w: it.w, h: it.h }, r, 2)) it.y = Math.max(it.y, r.y + r.h + gap)
        bottom = it.y + it.h
      }
      let limit = H - EDGE
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].y + items[i].h > limit) items[i].y = limit - items[i].h
        limit = items[i].y - gap
      }
      for (const it of items) {
        it.y = Math.max(EDGE, it.y)
        placed.push({ x: it.x, y: it.y, w: it.w, h: it.h })
        const ex = side === 'right' ? it.x : it.x + it.w, ey = it.y + it.h / 2
        const kx = side === 'right' ? ex - 12 : ex + 12
        place(it, it.x, it.y, `M${it.ax.toFixed(1)},${it.ay.toFixed(1)} L${kx.toFixed(1)},${ey.toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}`)
      }
    }
  }

  // Try spots around the anchor (last frame's spot first, so labels don't jump while orbiting).
  nearby(it, W, H, placed) {
    const { w, h, ax, ay } = it
    const near = [[10, -h - 4], [10, 4], [-w - 10, -h - 4], [-w - 10, 4], [-w / 2, -h - 12], [-w / 2, 12], [14, -h / 2], [-w - 14, -h / 2]]
    const far = near.map(([dx, dy]) => [dx + Math.sign(dx + w / 2) * 40, dy + Math.sign(dy + h / 2) * 34])
    const cands = [...near, ...(it.axis ? [] : far)]
    const order = cands.map((_, i) => i)
    if (it.cand >= 0 && it.cand < cands.length) order.unshift(...order.splice(it.cand, 1))
    let best = order[0], bestScore = Infinity
    for (const i of order) {
      const r = { x: ax + cands[i][0], y: ay + cands[i][1], w, h }
      let score = r.x < EDGE || r.y < EDGE || r.x + w > W - EDGE || r.y + h > H - EDGE ? 1e7 : 0
      for (const q of placed) score += overlapArea(r, q)
      if (score === 0) { best = i; bestScore = 0; break }
      score += i >= near.length ? 40 : 0
      if (score < bestScore) { best = i; bestScore = score }
    }
    it.cand = best
    it.dim = it.axis && bestScore > 0
    const x = ax + cands[best][0], y = ay + cands[best][1]
    placed.push({ x, y, w, h })
    let d = ''
    if (best >= near.length) {
      const px = Math.max(x, Math.min(ax, x + w)), py = Math.max(y, Math.min(ay, y + h))
      d = `M${ax.toFixed(1)},${ay.toFixed(1)} L${px.toFixed(1)},${py.toFixed(1)}`
    }
    place(it, x, y, d)
  }
}

function place(it, x, y, d) {
  const o = it.fade * (it.dim ? 0.3 : 1)
  it.el.style.display = ''
  it.el.style.opacity = String(o)
  it.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  it.line.setAttribute('d', d)
  it.line.style.opacity = String(o * 0.85)
  it.dot.setAttribute('r', d ? '2.8' : '0')
  it.dot.setAttribute('cx', String(it.ax))
  it.dot.setAttribute('cy', String(it.ay))
  it.dot.style.opacity = String(o)
}

function hide(it) {
  it.el.style.display = 'none'
  it.line.setAttribute('d', '')
  it.dot.setAttribute('r', '0')
}
