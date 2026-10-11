// 3D stage: renders the tutor's 3D commands with three.js, animated in step with speech.
//
// The model works in math coordinates (x right, y into the screen, z up), roughly -4..4.
// three.js is y-up, so every point goes through v() on the way in (see kit3d.js).
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js'
import katex from 'katex'
import { compile } from 'mathjs'
import { animate } from './board.js'
import { hex, num, clampN, isVec, v, UP, material, applyRotate, blobGeometry, bodyGeometry, tube, lathe, ellipsoid, leaf } from './kit3d.js'
import { buildModel } from './models3d.js'
import { LabelLayer } from './labels3d.js'

const easeOut = (t) => 1 - (1 - t) ** 3
const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2

const BACKGROUND = '#fbfaf6'
const DEFAULT_CAMERA = { pos: [7, -9, 6], target: [0, 0, 0] }

function compileFn(expr) {
  try {
    const f = compile(String(expr ?? '0'))
    return (scope) => {
      try {
        const y = Number(f.evaluate(scope))
        return Number.isFinite(y) ? y : NaN
      } catch { return NaN }
    }
  } catch { return null }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const labelHtml = (s) => (s.latex ? katex.renderToString(String(s.latex), { throwOnError: false }) : escapeHtml(s.label ?? s.text ?? ''))

function setFade(obj, t) {
  obj.traverse((o) => {
    for (const m of o.material ? [o.material].flat() : []) {
      if (m.userData.opacity == null) continue
      m.opacity = m.userData.opacity * t
      const see = m.opacity < 0.999
      if (m.transparent !== see) { m.transparent = see; m.needsUpdate = true }
    }
    for (const it of o.userData.labelItems ?? []) it.fade = t
  })
}

function dispose(obj) {
  obj.traverse((o) => {
    if (!o.userData.sharedGeometry) o.geometry?.dispose()
    for (const m of o.material ? [o.material].flat() : []) m.dispose()
  })
}

// Wrap an object built in absolute coordinates so its anchor (for move/rotate/pop) is its own centre.
function centered(obj) {
  const box = new THREE.Box3().setFromObject(obj)
  const g = new THREE.Group()
  if (box.isEmpty()) { g.add(obj); return g }
  const c = box.getCenter(new THREE.Vector3())
  obj.position.sub(c)
  g.position.copy(c)
  g.add(obj)
  g.userData.labelAt = box.max.clone().sub(c).multiplyScalar(0.7)
  return g
}

// A cylinder of unit length along +y, base at the origin, so scale.y draws it out like a pen stroke.
const UNIT_ROD = new THREE.CylinderGeometry(1, 1, 1, 16, 1).translate(0, 0.5, 0)
const UNIT_CONE = new THREE.ConeGeometry(1, 1, 20, 1).translate(0, 0.5, 0)

function rod(a, b, r, mat) {
  const dir = b.clone().sub(a)
  const mesh = new THREE.Mesh(UNIT_ROD, mat)
  mesh.position.copy(a)
  mesh.quaternion.setFromUnitVectors(UP, dir.clone().normalize())
  mesh.scale.set(r, dir.length(), r)
  mesh.userData.length = dir.length()
  mesh.userData.sharedGeometry = true
  return mesh
}

// ---------- scene ----------

export class Scene3D {
  constructor(el) {
    this.el = el
    this.visible = false
    this.objects = new Map() // tutor-given id -> Object3D (models also register "id.part")
    this.parts = new Map() // "id.part" -> { part, model }
    this.labelIds = new Map() // id -> label item, so labels can be removed
    this.flows = []
    this.notesEl = el.querySelector('.notes3d')

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    this.renderer.setClearColor(BACKGROUND)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    // label layer sits over the canvas and also takes the mouse for orbiting
    const labelsEl = document.createElement('div')
    labelsEl.className = 'labels3d'
    el.prepend(this.renderer.domElement, labelsEl)
    this.labels = new LabelLayer(labelsEl)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500)
    this.controls = new OrbitControls(this.camera, labelsEl)
    this.controls.enableDamping = true
    this.controls.autoRotateSpeed = 1.2

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#c9c2b0', 1.5))
    const sun = new THREE.DirectionalLight('#ffffff', 1.7)
    sun.position.set(6, 12, 8)
    this.scene.add(sun)
    const fill = new THREE.DirectionalLight('#fff4e6', 0.6)
    fill.position.set(-8, 4, -6)
    this.scene.add(fill)
    const rim = new THREE.DirectionalLight('#ffffff', 0.5)
    rim.position.set(0, 3, -10)
    this.scene.add(rim)

    this.grid = new THREE.GridHelper(10, 10, '#d9d2c2', '#ebe6da')
    this.scene.add(this.grid)

    this.root = new THREE.Group()
    this.scene.add(this.root)
    this.resetCamera()

    new ResizeObserver(() => this.resize()).observe(el)
    this.resize()
    const loop = (now) => {
      requestAnimationFrame(loop)
      if (!this.visible) return
      this.controls.update()
      this.updateFlows(now)
      this.renderer.render(this.scene, this.camera)
      this.labels.layout(this.scene, this.camera, this.width, this.height, this.avoidRects())
    }
    requestAnimationFrame(loop)
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.el
    if (!w || !h) return
    this.width = w
    this.height = h
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    // narrow screens: pull back so the -5..5 world still fits
    this.camera.fov = w / h < 1 ? 60 : 45
    this.camera.updateProjectionMatrix()
  }

  setTheme(dark) {
    const bg = dark ? '#090d16' : '#fbfaf6'
    this.scene.background = new THREE.Color(bg)
    this.renderer.setClearColor(bg)
    if (this.grid) {
      this.scene.remove(this.grid)
      this.grid.geometry.dispose()
      this.grid = new THREE.GridHelper(10, 10, dark ? '#475569' : '#d9d2c2', dark ? '#1e293b' : '#ebe6da')
      this.scene.add(this.grid)
    }
  }

  // Screen areas labels must stay clear of: the formula column and the board toolbar.
  avoidRects() {
    const base = this.el.getBoundingClientRect()
    const rel = (el) => {
      if (!el || !el.offsetParent) return null
      const r = el.getBoundingClientRect()
      return r.width && r.height ? { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height } : null
    }
    return [rel(this.notesEl.childElementCount ? this.notesEl : null), rel(document.querySelector('.board-tools'))]
  }

  setVisible(on) {
    this.visible = on
    this.el.classList.toggle('hidden', !on)
    if (on) this.resize()
  }

  resetCamera() {
    this.camera.position.copy(v(DEFAULT_CAMERA.pos))
    this.controls.target.copy(v(DEFAULT_CAMERA.target))
    this.controls.update()
  }

  // Fly the camera (keeping its viewing direction) so everything drawn fits on screen.
  async frame(ms = 600, signal) {
    const box = new THREE.Box3().setFromObject(this.root)
    if (box.isEmpty()) return this.resetCamera()
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    if (!Number.isFinite(sphere.radius) || !Number.isFinite(sphere.center.x)) return // never fly the camera into NaN
    const vfov = THREE.MathUtils.degToRad(this.camera.fov)
    // vertical and horizontal fit worked out separately; callout columns need ~40% of the width
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect)
    const r = Math.max(sphere.radius, 0.8)
    const sideRoom = this.labels.items.some((i) => i.callout) ? 0.6 : 0.92
    const dist = Math.max(r / Math.sin(vfov / 2) * 1.06, r / Math.sin(hfov / 2) / sideRoom)
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    await this.moveCamera({}, ms, signal, sphere.center.clone().addScaledVector(dir, dist), sphere.center)
  }

  // True when every corner of the drawn content projects inside the viewport.
  fits() {
    const box = new THREE.Box3().setFromObject(this.root)
    if (box.isEmpty() || ![box.min.x, box.max.x, box.min.y, box.max.y].every(Number.isFinite)) return true
    this.camera.updateMatrixWorld()
    const p = new THREE.Vector3()
    const margin = this.labels.items.some((i) => i.callout) ? 0.62 : 1 // callouts need side room
    let span = 0
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(this.camera)
      if (Math.abs(p.x) > margin || Math.abs(p.y) > 1 || p.z > 1) return false
      span = Math.max(span, Math.abs(p.x) / margin, Math.abs(p.y))
    }
    return span > 0.6 // also refit when the content only fills a small part of the view
  }

  spin(on) {
    this.controls.autoRotate = on ?? !this.controls.autoRotate
    return this.controls.autoRotate
  }

  clear() {
    for (const child of [...this.root.children]) {
      this.root.remove(child)
      dispose(child)
    }
    this.objects.clear()
    this.parts.clear()
    this.labelIds.clear()
    this.flows = []
    this.labels.clear()
    this.notesEl.innerHTML = ''
    this.grid.visible = true
    this.controls.autoRotate = false
    this.resetCamera()
  }

  // Draw a list of 3D commands over roughly `durationMs` (the length of the spoken sentence).
  async render(items, durationMs, signal, camera) {
    const tasks = []
    if (camera) tasks.push(this.moveCamera(camera, Math.min(2200, durationMs * 0.6), signal))
    if (items?.length) {
      tasks.push((async () => {
        const budget = Math.max(300, (durationMs * 0.85) / items.length)
        for (const s of items) {
          if (signal?.aborted) return
          try {
            await this.draw(s, budget, signal)
          } catch (err) {
            console.warn('[scene3d] skipped', s, err)
          }
        }
      })())
    }
    await Promise.all(tasks)
    // like the 2D board's keepInView: if the tutor drew off-screen, zoom out (unless it chose the shot)
    if (!camera && items?.length && !signal?.aborted && !this.fits()) await this.frame(500, signal)
  }

  // pos/target are math coordinates; p1/t1 (three.js vectors) override them when given.
  async moveCamera({ pos, target }, ms, signal, p1, t1) {
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone()
    p1 ??= isVec(pos) ? v(pos) : p0.clone()
    t1 ??= isVec(target) ? v(target) : t0.clone()
    await animate(ms, signal, (t) => {
      const k = easeOut(t)
      this.camera.position.lerpVectors(p0, p1, k)
      this.controls.target.lerpVectors(t0, t1, k)
    })
  }

  // Adds a finished object to the scene, registers its id and plays its entrance.
  async add(s, obj, entrance, budget, signal) {
    obj.userData.spec = s
    if (s.kind !== 'axes') applyRotate(obj, s.rotate)
    if (s.id) this.register(String(s.id), obj)
    this.root.add(obj)
    if (s.label || s.latex) this.attachLabel(obj, s)
    setFade(obj, 0)
    await entrance(obj, Math.min(budget, 700), signal)
    setFade(obj, 1)
  }

  register(id, obj) {
    const old = this.objects.get(id)
    if (old && old !== obj) {
      old.parent?.remove(old)
      dispose(old)
    }
    this.objects.set(id, obj)
  }

  attachLabel(obj, s, at, opts = {}) {
    return this.labels.add(obj, labelHtml(s), { color: hex(s.color, 'black'), local: at ?? obj.userData.labelAt, ...opts })
  }

  // "heart.aorta" -> { obj (what to animate), anchor (where labels point), model }
  resolve(target) {
    // exact id first ("P", "Planet"); then "Heart.Left Ventricle" / "heart.left_ventricle" -> "heart.left-ventricle"
    const raw = String(target ?? '').trim()
    const norm = raw.toLowerCase().replace(/[\s_]+/g, '-')
    let key = this.parts.has(raw) || this.objects.has(raw) ? raw : norm
    if (!this.parts.has(key) && !this.objects.has(key) && key.includes('.')) {
      // close enough: "bird.tail" -> "bird.tail-feathers", "heart.chest" -> a part whose label mentions it
      const [id, word] = [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)]
      const hit = [...this.parts.entries()].find(([k, p]) => k.startsWith(id + '.') && (k.slice(id.length + 1).includes(word) || p.part.label.toLowerCase().includes(word.replace(/-/g, ' '))))
      if (hit) key = hit[0]
    }
    const part = this.parts.get(key)
    if (part) return { obj: part.part.obj ?? part.part.anchorObj, anchor: part.part.anchorObj, model: part.model, label: part.part.label, isSpot: !part.part.obj }
    const obj = this.objects.get(key)
    return obj ? { obj, anchor: obj, model: null } : null
  }

  async draw(s, budget, signal) {
    const pop = (obj, ms, sig) => {
      const s1 = obj.scale.clone()
      return animate(ms, sig, (t) => {
        obj.scale.copy(s1).multiplyScalar(Math.max(0.001, easeOutBack(t)))
        setFade(obj, Math.min(1, t * 2))
      })
    }
    const fade = (obj, ms, sig) => animate(ms, sig, (t) => setFade(obj, t))
    const mat = (fallback, extra = {}) => material(s.color ?? fallback, { opacity: s.opacity, finish: s.finish, ...extra })

    switch (s.kind) {
      case 'axes': {
        const n = clampN(s.size, 4, 1, 10)
        const g = new THREE.Group()
        const axes = [['x', [n, 0, 0], 'red'], ['y', [0, n, 0], 'green'], ['z', [0, 0, n], 'blue']]
        for (const [name, tip, c] of axes) {
          const neg = tip.map((t) => -t * 0.6)
          const arrow = this.arrow(v(neg), v(tip), c, 0.022)
          this.attachLabel(arrow, { label: name, color: c }, v(tip).sub(v(neg)).multiplyScalar(1.03), { axis: true })
          g.add(arrow)
        }
        if (s.grid === false) this.grid.visible = false
        // one set of axes per page: drawing them again replaces the old set
        await this.add({ ...s, id: 'axes', label: undefined, latex: undefined }, g, fade, budget, signal)
        return
      }

      case 'point': {
        const g = new THREE.Group()
        g.position.copy(v(s.at))
        g.add(new THREE.Mesh(new THREE.SphereGeometry(clampN(s.r, 0.09, 0.02, 1), 20, 14), material(s.color ?? 'black', { emissive: true })))
        await this.add(s, g, pop, budget, signal)
        return
      }

      case 'sphere': {
        const g = new THREE.Group()
        g.position.copy(v(s.center))
        const r = clampN(s.r, 1, 0.02, 20)
        g.add(new THREE.Mesh(new THREE.SphereGeometry(r, 48, 32), mat('blue')))
        if (s.wireframe) g.add(this.wire(new THREE.SphereGeometry(r * 1.002, 16, 12), s.color))
        g.userData.labelAt = new THREE.Vector3(r * 0.7, r * 0.7, 0)
        await this.add(s, g, pop, budget, signal)
        return
      }

      case 'ellipsoid': {
        const g = new THREE.Group()
        g.position.copy(v(s.center))
        const radii = Array.isArray(s.radii) ? s.radii : [s.r ?? 1, s.r ?? 1, s.r ?? 1]
        g.add(ellipsoid([0, 0, 0], radii, mat('pink', { finish: s.finish ?? 'organic' })))
        g.userData.labelAt = new THREE.Vector3(num(radii[0], 1) * 0.7, num(radii[2], 1) * 0.7, 0)
        await this.add(s, g, pop, budget, signal)
        return
      }

      case 'box': {
        const [sx, sy, sz] = (Array.isArray(s.size) ? s.size : [1, 1, 1]).map((x) => clampN(x, 1, 0.01, 20))
        const g = new THREE.Group()
        g.position.copy(v(s.center))
        const geo = new THREE.BoxGeometry(sx, sz, sy)
        g.add(new THREE.Mesh(geo, mat('blue')))
        g.add(this.edges(geo, s.edgeColor ?? 'black'))
        g.userData.labelAt = new THREE.Vector3(sx / 2, sz / 2, 0)
        await this.add(s, g, pop, budget, signal)
        return
      }

      case 'cylinder': case 'cone': {
        const a = v(s.from, [0, 0, 0]), b = v(s.to, [0, 0, 1])
        const r = clampN(s.r, s.kind === 'cone' ? 0.5 : 0.1, 0.005, 20)
        const g = new THREE.Group()
        g.position.copy(a)
        const dir = b.clone().sub(a)
        const mesh = new THREE.Mesh(s.kind === 'cone' ? UNIT_CONE : UNIT_ROD, mat('blue'))
        mesh.userData.sharedGeometry = true
        mesh.quaternion.setFromUnitVectors(UP, dir.clone().normalize())
        mesh.scale.set(r, 0.001, r)
        g.add(mesh)
        g.userData.labelAt = dir.clone().multiplyScalar(0.5).add(new THREE.Vector3(r, 0, 0))
        const L = dir.length()
        await this.add(s, g, (obj, ms, sig) => animate(ms, sig, (t) => {
          mesh.scale.y = Math.max(0.001, L * easeOut(t))
          setFade(obj, Math.min(1, t * 3))
        }), budget, signal)
        return
      }

      case 'torus': {
        const g = new THREE.Group()
        g.position.copy(v(s.center))
        const R = clampN(s.r, 1.5, 0.05, 20), tubeR = clampN(s.tube, 0.3, 0.01, 10)
        const mesh = new THREE.Mesh(new THREE.TorusGeometry(R, tubeR, 24, 72), mat('blue'))
        mesh.rotation.x = Math.PI / 2 // lie flat in the math xy-plane
        g.add(mesh)
        g.userData.labelAt = new THREE.Vector3(R + tubeR, tubeR, 0)
        await this.add(s, g, pop, budget, signal)
        return
      }

      case 'plane': {
        const [w, hh] = Array.isArray(s.size) ? s.size.map((x) => clampN(x, 6, 0.1, 30)) : [clampN(s.size, 6, 0.1, 30), clampN(s.size, 6, 0.1, 30)]
        const g = new THREE.Group()
        g.position.copy(v(s.point))
        const geo = new THREE.PlaneGeometry(w, hh)
        g.add(new THREE.Mesh(geo, material(s.color ?? 'light-blue', { opacity: s.opacity ?? 0.35 })))
        g.add(this.edges(geo, s.color ?? 'light-blue'))
        g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v(s.normal, [0, 0, 1]).normalize())
        g.userData.labelAt = new THREE.Vector3(w / 2, hh / 2, 0)
        await this.add(s, g, pop, budget, signal)
        return
      }

      case 'polygon': {
        const pts = (s.points ?? []).filter(isVec).map((p) => v(p))
        if (pts.length < 3) return
        const pos = []
        for (let i = 1; i < pts.length - 1; i++) pos.push(...pts[0].toArray(), ...pts[i].toArray(), ...pts[i + 1].toArray())
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        geo.computeVertexNormals()
        const inner = new THREE.Group()
        inner.add(new THREE.Mesh(geo, material(s.color ?? 'yellow', { opacity: s.opacity ?? 0.6 })))
        pts.forEach((p, i) => inner.add(rod(p, pts[(i + 1) % pts.length], 0.015, material(s.edgeColor ?? s.color ?? 'yellow'))))
        await this.add(s, centered(inner), fade, budget, signal)
        return
      }

      case 'vector': {
        const a = v(s.from, [0, 0, 0]), b = v(s.to, [1, 0, 0])
        const g = this.arrow(a, b, s.color ?? 'blue', clampN(s.r, 0.035, 0.005, 0.5))
        g.userData.labelAt = b.clone().sub(a)
        const [shaft, head] = g.children
        const L = shaft.userData.length
        await this.add(s, g, (obj, ms, sig) => animate(ms, sig, (t) => {
          const k = easeOut(t)
          shaft.scale.y = Math.max(0.001, L * k)
          head.position.copy(shaft.position).addScaledVector(head.userData.dir, L * k)
          setFade(obj, Math.min(1, t * 3))
        }), budget, signal)
        return
      }

      case 'line': {
        const pts = (s.points ?? []).filter(isVec).map((p) => v(p))
        if (pts.length < 2) return
        if (s.closed) pts.push(pts[0])
        const r = clampN(s.r, 0.025, 0.003, 0.5)
        const g = new THREE.Group()
        const segs = []
        for (let i = 0; i < pts.length - 1; i++) {
          const seg = rod(pts[i], pts[i + 1], r, material(s.color ?? 'black'))
          seg.scale.y = 0.001
          segs.push(seg)
          g.add(seg)
        }
        g.userData.labelAt = pts.at(-1).clone()
        await this.add(s, g, async (obj, ms, sig) => {
          setFade(obj, 1)
          for (const seg of segs) {
            await animate(ms / segs.length, sig, (t) => { seg.scale.y = Math.max(0.001, seg.userData.length * t) })
          }
        }, budget, signal)
        return
      }

      case 'circle': case 'ellipse': {
        // flat ring in the plane z = center z (orbits, cross-sections)
        const [cx, cy, cz] = isVec(s.center) ? s.center.map((n) => num(n)) : [0, 0, 0]
        const rx = clampN(s.rx ?? s.r, 1, 0.01, 20), ry = clampN(s.ry ?? s.r, rx, 0.01, 20)
        await this.draw({ ...s, kind: 'curve', closed: true, x: `${cx} + ${rx}*cos(t)`, y: `${cy} + ${ry}*sin(t)`, z: `${cz}`, tmin: 0, tmax: 2 * Math.PI, points: undefined }, budget, signal)
        return
      }

      case 'curve': case 'tube': {
        // curve: thin line; tube: thick, optionally tapering (vessels, stems, limbs, roots)
        let pts
        if (Array.isArray(s.points)) {
          pts = s.points.filter(isVec)
        } else {
          const fx = compileFn(s.x ?? 't'), fy = compileFn(s.y ?? '0'), fz = compileFn(s.z ?? '0')
          if (!fx || !fy || !fz) return
          const t0 = num(s.tmin, 0), t1 = num(s.tmax, 2 * Math.PI)
          const N = clampN(s.samples, 200, 20, 600)
          pts = []
          for (let i = 0; i <= N; i++) {
            const t = t0 + ((t1 - t0) * i) / N
            const p = [fx({ t }), fy({ t }), fz({ t })]
            if (p.every(Number.isFinite)) pts.push(p)
          }
        }
        if (pts.length < 2) return
        const thick = s.kind === 'tube'
        const radii = Array.isArray(s.r) ? s.r.map((r) => clampN(r, 0.1, 0.003, 3)) : clampN(s.r, thick ? 0.12 : 0.03, 0.003, 3)
        const t = tube(pts, radii, material(s.color ?? (thick ? 'flesh' : 'blue'), { opacity: s.opacity, finish: s.finish ?? (thick ? 'organic' : 'standard') }), { closed: !!s.closed, radial: thick ? 18 : 10, caps: thick })
        if (!t) return
        const geo = t.userData.drawable, radial = t.userData.radial
        const g = centered(t)
        g.userData.labelAt = v(pts.at(-1)).sub(g.position)
        const total = geo.index.count, caps = t.children.slice(1)
        geo.setDrawRange(0, 0)
        caps.forEach((c) => (c.visible = false))
        await this.add(s, g, (obj, ms, sig) => {
          setFade(obj, 1)
          return animate(Math.max(ms, 900), sig, (k) => {
            geo.setDrawRange(0, Math.ceil((total * k) / (radial * 6)) * radial * 6)
          })
        }, budget, signal)
        geo.setDrawRange(0, Infinity)
        caps.forEach((c) => (c.visible = true))
        return
      }

      case 'blob': {
        // smooth organic shape from overlapping spheres/capsules (organs, bodies, fruit, cells)
        const geo = blobGeometry({ balls: s.balls, segs: s.segments, colors: s.colors, smooth: s.smooth, wrinkle: num(s.wrinkle, 0), squash: s.squash })
        if (!geo) return
        const mesh = new THREE.Mesh(geo, mat('pink', { finish: s.finish ?? 'organic', vertexColors: !!geo.attributes.color }))
        await this.add(s, centered(mesh), pop, budget, signal)
        return
      }

      case 'body': {
        // streamlined body along a spine with a width/height profile: fish, birds, insects, worms, vegetables
        const geo = bodyGeometry(s.spine ?? s.points ?? [], s.width, s.height, { belly: s.belly, color: s.color ?? 'grey' })
        if (!geo) return
        const mesh = new THREE.Mesh(geo, mat('grey', { finish: s.finish ?? 'organic', vertexColors: !!geo.attributes.color }))
        await this.add(s, centered(mesh), pop, budget, signal)
        return
      }

      case 'lathe': {
        // surface of revolution from a side profile [[radius, height], ...]: vases, trunks, bulbs, bones
        const mesh = lathe(s.profile, mat('tan', { finish: s.finish ?? 'organic' }), { axis: s.axis })
        if (!mesh) return
        const g = new THREE.Group()
        g.position.copy(v(s.base))
        g.add(mesh)
        mesh.geometry.computeBoundingBox()
        g.userData.labelAt = mesh.geometry.boundingBox.max.clone().multiplyScalar(0.8)
        await this.add(s, g, pop, budget, signal)
        return
      }

      case 'leaf': case 'petal': case 'fin': {
        const l = leaf(s.base ?? [0, 0, 0], s.tip ?? [1, 0, 0.3], { width: s.width, color: s.color ?? ({ petal: '#e85d9e', fin: '#8aa9c1' }[s.kind] ?? '#3d8b37'), curl: s.curl, fold: s.fold, shape: s.kind === 'petal' ? 'petal' : 'leaf', normal: s.normal, opacity: s.opacity, rib: s.kind !== 'fin' })
        if (!l) return
        await this.add(s, centered(l), pop, budget, signal)
        return
      }

      case 'model':
        await this.model(s, budget, signal, pop)
        return

      case 'surface': {
        const geo = this.surfaceGeometry(s)
        if (!geo) return
        const g = new THREE.Group()
        const m = material(s.color ?? 'light-blue', { opacity: s.opacity ?? 0.85, finish: s.finish, vertexColors: !!(s.colormap && geo.attributes.color) })
        g.add(new THREE.Mesh(geo, m))
        if (s.wireframe !== false) g.add(this.wire(geo, s.colormap ? 'black' : s.color ?? 'blue', 0.18))
        geo.computeBoundingBox()
        g.userData.labelAt = geo.boundingBox.max.clone()
        await this.add(s, g, (obj, ms, sig) => animate(Math.max(ms, 900), sig, (t) => {
          obj.scale.set(1, Math.max(0.001, easeOut(t)), 1) // rises out of the floor
          setFade(obj, Math.min(1, t * 2))
        }), budget, signal)
        return
      }

      case 'field': {
        // Vector field F(x,y,z) sampled on a grid; arrows scaled relative to the strongest sample.
        const fx = compileFn(s.fx ?? '0'), fy = compileFn(s.fy ?? '0'), fz = compileFn(s.fz ?? '0')
        if (!fx || !fy || !fz) return
        const R = clampN(s.range, 2, 0.5, 6), n = Math.round(clampN(s.n, 4, 2, 7))
        const flat = s.plane === true // only the z=0 layer
        const samples = []
        let maxLen = 0
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < (flat ? 1 : n); k++) {
          const x = -R + (2 * R * i) / (n - 1), y = -R + (2 * R * j) / (n - 1), z = flat ? 0 : -R + (2 * R * k) / (n - 1)
          const F = [fx({ x, y, z }), fy({ x, y, z }), fz({ x, y, z })]
          if (!F.every(Number.isFinite)) continue
          const len = Math.hypot(...F)
          maxLen = Math.max(maxLen, len)
          samples.push([[x, y, z], F, len])
        }
        if (!maxLen) return
        const g = new THREE.Group()
        const scale = (((2 * R) / (n - 1)) * 0.8) / maxLen
        for (const [p, F, len] of samples) {
          if (len < maxLen * 1e-3) continue
          const a = v(p), b = v([p[0] + F[0] * scale, p[1] + F[1] * scale, p[2] + F[2] * scale])
          const dir = b.clone().sub(a)
          g.add(new THREE.ArrowHelper(dir.clone().normalize(), a, dir.length(), hex(s.color ?? 'violet'), Math.min(0.25, dir.length() * 0.35), Math.min(0.12, dir.length() * 0.2)))
        }
        await this.add(s, g, (obj, ms, sig) => animate(ms, sig, (t) => obj.scale.setScalar(Math.max(0.001, easeOut(t)))), budget, signal)
        return
      }

      case 'label': {
        const html = { ...s }
        if (s.target) {
          // callout on a model part (or any object), laid out beside the model with a leader line
          const r = this.resolve(s.target)
          if (!r) return console.warn('[scene3d] label target not found', s.target)
          if (!s.text && !s.latex) html.label = r.label ?? String(s.target).split('.').pop()
          if (r.anchor.userData.labelItems?.some((i) => i.callout && this.labels.items.includes(i))) return // already labelled
          // model parts gather beside their model; loose objects share columns beside the whole scene
          const item = this.attachLabel(r.anchor, html, null, { callout: true, owner: r.model ?? this.root })
          if (s.id) this.labelIds.set(String(s.id), item)
          item.fade = 0
          await animate(Math.min(budget, 400), signal, (t) => (item.fade = t))
          item.fade = 1
          return
        }
        const g = new THREE.Group()
        g.position.copy(v(s.at))
        await this.add({ ...s, label: s.text ?? s.label }, g, fade, budget, signal)
        return
      }

      case 'note':
        this.note(s)
        return

      case 'camera':
        await this.moveCamera(s, Math.min(2200, budget * 2), signal)
        return

      case 'spin':
        this.spin(s.on !== false)
        if (s.speed) this.controls.autoRotateSpeed = clampN(s.speed, 1.2, 0.1, 10)
        return

      case 'flow':
        this.flow(s)
        return

      case 'move': {
        const obj = this.resolve(s.id)?.obj
        if (!obj) return
        const from = obj.position.clone()
        if (Array.isArray(s.path)) {
          // follow a list of waypoints (e.g. a planet along its orbit)
          const pts = s.path.filter(isVec).map((p) => v(p))
          if (pts.length < 2) return
          const path = new THREE.CatmullRomCurve3(pts, !!s.closed)
          const loops = clampN(s.loops, 1, 1, 5)
          await animate(Math.max(budget, 1500), signal, (t) => obj.position.copy(path.getPointAt((t * loops) % 1 || (t ? 1 : 0))))
        } else {
          const to = v(s.to, [from.x, -from.z, from.y])
          await animate(Math.max(budget, 600), signal, (t) => obj.position.lerpVectors(from, to, easeOut(t)))
        }
        return
      }

      case 'rotate': {
        const obj = this.resolve(s.id)?.obj
        if (!obj) return
        const axis = v(s.axis, [0, 0, 1]).normalize()
        const angle = THREE.MathUtils.degToRad(num(s.angle, 90))
        const q0 = obj.quaternion.clone()
        const q = new THREE.Quaternion()
        await animate(Math.max(budget, 800), signal, (t) => {
          q.setFromAxisAngle(axis, angle * easeOut(t))
          obj.quaternion.copy(q).multiply(q0)
        })
        return
      }

      case 'flap': {
        // beat a model's hinged parts (wings, tail, fins) about their joints
        const model = this.objects.get(String(s.id))?.userData.model
        if (!model?.hinges?.length) return
        const times = clampN(s.times, 4, 1, 20), amp = THREE.MathUtils.degToRad(clampN(s.angle, 35, 5, 80))
        const base = model.hinges.map((h) => h.obj.quaternion.clone())
        const q = new THREE.Quaternion()
        await animate(Math.max(budget, times * 450), signal, (t) => model.hinges.forEach((h, i) => {
          q.setFromAxisAngle(h.axis, h.sign * amp * Math.sin(Math.PI * 2 * times * t))
          h.obj.quaternion.copy(base[i]).premultiply(q)
        }))
        model.hinges.forEach((h, i) => h.obj.quaternion.copy(base[i]))
        return
      }

      case 'pulse': {
        // rhythmic swell, e.g. a heartbeat or a breathing lung
        const obj = this.resolve(s.id)?.obj
        if (!obj) return
        const times = clampN(s.times, 3, 1, 12), amp = clampN(s.amount, 0.07, 0.01, 0.4)
        const s0 = obj.scale.clone()
        await animate(Math.max(budget, times * 750), signal, (t) => {
          const beat = (t * times) % 1
          obj.scale.copy(s0).multiplyScalar(1 + amp * Math.sin(Math.PI * Math.min(1, beat * 2.2)) ** 2)
        })
        obj.scale.copy(s0)
        return
      }

      case 'opacity': {
        // fade an object or model part to see inside it (value 1 restores it)
        const obj = this.resolve(s.id)?.obj
        if (!obj) return
        const target = clampN(s.value ?? s.opacity, 0.4, 0.05, 1)
        const mats = []
        obj.traverse((o) => { for (const m of o.material ? [o.material].flat() : []) if (m.userData.opacity != null) mats.push(m) })
        const from = mats.map((m) => m.userData.opacity)
        for (const m of mats) m.userData.base ??= m.userData.opacity
        await animate(Math.min(budget, 700), signal, (t) => mats.forEach((m, i) => {
          m.userData.opacity = from[i] + (m.userData.base * target - from[i]) * t
          m.opacity = m.userData.opacity
          m.transparent = true
        }))
        for (const m of mats) { m.depthWrite = m.userData.opacity > 0.99; m.needsUpdate = true }
        return
      }

      case 'highlight': {
        const r = this.resolve(s.id ?? s.target)
        if (!r) return
        await this.highlight(r, s, budget, signal)
        return
      }

      case 'remove': {
        const label = this.labelIds.get(String(s.id))
        if (label) { this.labels.remove(label); this.labelIds.delete(String(s.id)); return }
        const obj = this.resolve(s.id)?.obj
        if (!obj) return
        await animate(Math.min(budget, 400), signal, (t) => setFade(obj, 1 - t))
        obj.parent?.remove(obj)
        dispose(obj)
        this.objects.delete(String(s.id))
        return
      }

      default:
        console.warn('[scene3d] unknown kind', s.kind)
    }
  }

  // ---------- models ----------

  async model(s, budget, signal, pop) {
    const B = buildModel(s.name, s)
    if (!B) return console.warn('[scene3d] unknown model', s.name)
    const inner = B.group
    for (const p of B.parts) {
      p.anchorObj = new THREE.Object3D()
      p.anchorObj.position.copy(v(p.anchor ?? [0, 0, 0]))
      // anchors ride on their part, so a label follows a flapping wing and vanishes with a removed part
      if (p.obj) { p.anchorObj.position.sub(p.obj.position); p.obj.add(p.anchorObj) } else inner.add(p.anchorObj)
    }
    const box = new THREE.Box3().setFromObject(inner)
    const size = box.getSize(new THREE.Vector3())
    inner.position.sub(box.getCenter(new THREE.Vector3()))
    const outer = new THREE.Group()
    outer.add(inner)
    const k = clampN(s.size, 4, 0.3, 12) / Math.max(size.x, size.y, size.z, 1e-3)
    outer.scale.setScalar(k)
    // stands on the floor unless told otherwise
    outer.position.copy(v(isVec(s.center) ? s.center : [0, 0, (size.y * k) / 2]))
    if (s.opacity != null) {
      const f = clampN(s.opacity, 1, 0.05, 1)
      inner.traverse((o) => {
        for (const m of o.material ? [o.material].flat() : []) {
          if (m.userData.opacity == null) continue
          m.userData.opacity *= f
          m.depthWrite = m.userData.opacity > 0.99
        }
      })
    }
    const id = String(s.id ?? String(s.name).toLowerCase())
    outer.userData.model = { name: s.name, paths: B.paths, hinges: B.hinges, inner }
    for (const p of B.parts) {
      this.parts.set(`${id}.${p.name}`, { part: p, model: outer })
      if (p.obj) this.objects.set(`${id}.${p.name}`, p.obj)
    }
    await this.add({ ...s, id, label: undefined, latex: undefined }, outer, pop, budget, signal)
    const wanted = s.labels === true ? B.parts.map((p) => p.name) : Array.isArray(s.labels) ? s.labels.map(String) : []
    for (const name of wanted) {
      const p = B.parts.find((q) => q.name === name)
      if (p && !p.anchorObj.userData.labelItems?.length) this.attachLabel(p.anchorObj, { label: p.label, color: 'black' }, null, { callout: true, owner: outer })
    }
  }

  async highlight(r, s, budget, signal) {
    const target = new THREE.Color(hex(s.color ?? 'yellow'))
    const mats = []
    if (!r.isSpot) r.obj.traverse((o) => { if (o.material?.emissive) mats.push(o.material) })
    if (!mats.length) {
      // a named spot (or something without lit materials): drop a glowing marker on it
      const ws = r.anchor.getWorldScale(new THREE.Vector3()).x || 1
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.16 / ws, 24, 16), new THREE.MeshBasicMaterial({ color: target, transparent: true, opacity: 0, depthWrite: false }))
      r.anchor.add(glow)
      await animate(Math.max(budget, 900), signal, (t) => {
        glow.material.opacity = 0.25 + 0.45 * Math.sin(Math.PI * ((t * 2) % 1))
        glow.scale.setScalar(1 + 0.4 * Math.sin(Math.PI * t))
      })
      glow.material.opacity = 0.45
      return
    }
    const start = mats.map((m) => m.emissive.clone())
    await animate(Math.max(budget, 900), signal, (t) => {
      const k = 0.55 * Math.sin(Math.PI * ((t * 2) % 1)) + 0.25 * t
      mats.forEach((m, i) => m.emissive.copy(start[i]).lerp(target, Math.min(1, k)))
    })
    mats.forEach((m, i) => m.emissive.copy(start[i]).lerp(target, 0.12)) // stays faintly lit
  }

  // Particles streaming along a path, looping until the page is cleared: blood, air, water, impulses.
  flow(s) {
    let pts, parent = this.root
    if (typeof s.path === 'string') {
      const [id, name] = s.path.split(/\.(?=[^.]+$)/)
      const model = this.objects.get(id)?.userData.model
      const route = model?.paths?.[name]
      if (!route) return console.warn('[scene3d] flow path not found', s.path)
      pts = route.map((p) => v(p))
      parent = model.inner
    } else {
      // waypoints may be [x,y,z] or part targets like "flower.anther" (their anchor's position)
      this.root.updateMatrixWorld(true)
      pts = (s.path ?? []).map((p) => {
        if (isVec(p)) return v(p)
        const r = typeof p === 'string' && this.resolve(p)
        return r ? this.root.worldToLocal(r.anchor.getWorldPosition(new THREE.Vector3())) : null
      }).filter(Boolean)
    }
    if (pts.length < 2) return
    const curve = new THREE.CatmullRomCurve3(pts, !!s.closed, 'centripetal')
    const g = new THREE.Group()
    parent.add(g)
    const ws = g.getWorldScale(new THREE.Vector3()).x || 1
    const n = Math.round(clampN(s.count, 12, 1, 60))
    const geo = new THREE.SphereGeometry(clampN(s.r, 0.06, 0.01, 0.5) / ws, 12, 8)
    const m = new THREE.MeshStandardMaterial({ color: hex(s.color ?? 'red'), emissive: new THREE.Color(hex(s.color ?? 'red')).multiplyScalar(0.5), roughness: 0.3 })
    for (let i = 0; i < n; i++) g.add(new THREE.Mesh(geo, m))
    const f = { group: g, curve, n, period: clampN(s.seconds, 4, 0.5, 30) * 1000, start: performance.now() }
    this.flows.push(f)
    if (s.id) this.register(String(s.id), g)
  }

  updateFlows(now) {
    this.flows = this.flows.filter((f) => {
      for (let o = f.group; o; o = o.parent) if (o === this.root) return true
      return false // its model (or the flow itself) was removed
    })
    for (const f of this.flows) {
      const t = (now - f.start) / f.period
      f.group.children.forEach((p, i) => {
        const u = (t + i / f.n) % 1
        f.curve.getPointAt(u, p.position)
        p.scale.setScalar(Math.max(0.001, Math.min(1, u * 12, (1 - u) * 12)))
      })
    }
  }

  // ---------- helpers ----------

  // Shaft + cone head; children[0] is the shaft, children[1] the head (vector entrance animates both).
  arrow(a, b, c, r = 0.035) {
    const g = new THREE.Group()
    g.position.copy(a)
    const dir = b.clone().sub(a)
    const L = dir.length() || 0.001
    const unit = dir.clone().normalize()
    const headLen = Math.min(L * 0.35, r * 7)
    const m = material(c)
    const shaft = rod(new THREE.Vector3(), unit.clone().multiplyScalar(L - headLen), r, m)
    shaft.userData.length = L - headLen
    const head = new THREE.Mesh(UNIT_CONE, m)
    head.userData.sharedGeometry = true
    head.quaternion.setFromUnitVectors(UP, unit)
    head.scale.set(r * 2.6, headLen, r * 2.6)
    head.position.copy(unit.clone().multiplyScalar(L - headLen))
    head.userData.dir = unit
    g.add(shaft, head)
    return g
  }

  edges(geo, c) {
    const m = new THREE.LineBasicMaterial({ color: hex(c, 'black'), transparent: true, opacity: 0 })
    m.userData.opacity = 0.7
    return new THREE.LineSegments(new THREE.EdgesGeometry(geo), m)
  }

  wire(geo, c, opacity = 0.35) {
    const m = new THREE.LineBasicMaterial({ color: hex(c, 'black'), transparent: true, opacity: 0 })
    m.userData.opacity = opacity
    return new THREE.LineSegments(new THREE.WireframeGeometry(geo), m)
  }

  surfaceGeometry(s) {
    const res = Math.round(clampN(s.samples, 48, 8, 120))
    let sample
    if (s.fn != null) {
      const f = compileFn(s.fn)
      if (!f) return null
      const x0 = num(s.xmin, -2), x1 = num(s.xmax, 2), y0 = num(s.ymin, -2), y1 = num(s.ymax, 2)
      const zlo = num(s.zmin, -6), zhi = num(s.zmax, 6)
      sample = (u, w, out) => {
        const x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * w
        const z = f({ x, y })
        out.copy(v([x, y, Number.isFinite(z) ? Math.max(zlo, Math.min(zhi, z)) : 0]))
      }
    } else {
      const fx = compileFn(s.x), fy = compileFn(s.y), fz = compileFn(s.z)
      if (!fx || !fy || !fz) return null
      const u0 = num(s.umin, 0), u1 = num(s.umax, 2 * Math.PI), v0 = num(s.vmin, 0), v1 = num(s.vmax, Math.PI)
      sample = (a, b, out) => {
        const scope = { u: u0 + (u1 - u0) * a, v: v0 + (v1 - v0) * b }
        const p = [fx(scope), fy(scope), fz(scope)].map((n) => (Number.isFinite(n) ? n : 0))
        out.copy(v(p))
      }
    }
    const geo = new ParametricGeometry(sample, res, res)
    if (s.colormap) {
      // blue (low) -> green -> yellow -> red (high), by height
      const pos = geo.attributes.position
      let lo = Infinity, hi = -Infinity
      for (let i = 0; i < pos.count; i++) { lo = Math.min(lo, pos.getY(i)); hi = Math.max(hi, pos.getY(i)) }
      const colors = []
      const c = new THREE.Color()
      for (let i = 0; i < pos.count; i++) {
        const t = hi > lo ? (pos.getY(i) - lo) / (hi - lo) : 0.5
        c.setHSL(0.66 * (1 - t), 0.75, 0.55)
        colors.push(c.r, c.g, c.b)
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    }
    return geo
  }

  // Formulas and short notes stack in a column over the right edge of the 3D view.
  note(s) {
    const el = document.createElement('div')
    el.className = 'note3d'
    el.style.color = hex(s.color, 'black')
    const latex = String(s.latex ?? '')
    // models sometimes put a plain sentence in "latex", which KaTeX would render without spaces
    const wordy = latex && !/[\\^_={}]/.test(latex) && latex.trim().split(/\s+/).length >= 3
    el.innerHTML = latex && !wordy
      ? katex.renderToString(latex, { throwOnError: false, displayMode: true })
      : escapeHtml(wordy ? latex : s.text ?? '')
    if (s.size === 'l' || s.size === 'xl') el.classList.add('big')
    this.notesEl.appendChild(el)
    // shrink long formulas to the column width instead of scrolling sideways
    const inner = el.firstElementChild
    if (inner && inner.scrollWidth > el.clientWidth - 22) {
      const k = Math.max(0.55, (el.clientWidth - 22) / inner.scrollWidth)
      el.style.fontSize = `${parseFloat(getComputedStyle(el).fontSize) * k}px`
    }
    while (this.notesEl.children.length > 8) this.notesEl.firstElementChild.remove()
  }
}

export function mountScene(el) {
  return new Scene3D(el)
}
