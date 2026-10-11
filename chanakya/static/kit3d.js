// Shared 3D building blocks: colours, materials, math-coordinate helpers and organic geometry
// (metaball blobs, tapered tubes, lathes, leaves, ellipsoids) used by the scene and the model library.
//
// Math coordinates: x right, y into the screen, z up. three.js is y-up, so points go through v().
import * as THREE from 'three'
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

export const COLORS = {
  black: '#1d1d1d', grey: '#9fa8b2', blue: '#4465e9', 'light-blue': '#4ba1f1',
  red: '#e03131', 'light-red': '#f87777', green: '#099268', 'light-green': '#40c057',
  orange: '#e16919', yellow: '#f1ac4b', violet: '#ae3ec9', 'light-violet': '#e085f4',
  white: '#f4f4f4',
  // natural tones so organic subjects don't come out in primary colours
  skin: '#e8b796', pink: '#f2a5b5', 'dark-red': '#9b1c1c', brown: '#7a5230', 'dark-green': '#2f6b2f',
  tan: '#d2b48c', cream: '#f3ead3', bone: '#e9e4d4', flesh: '#d9777b', gold: '#d4a017',
}
const COLOR_ALIASES = { purple: 'violet', gray: 'grey', cyan: 'light-blue', teal: 'green' }
export const hex = (c, d = 'blue') => {
  if (typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim())) return c.trim()
  return COLORS[COLOR_ALIASES[c] ?? c] ?? COLORS[d] ?? d
}

export const num = (x, d = 0) => (Number.isFinite(+x) ? +x : d)
export const clampN = (x, d, lo, hi) => Math.max(lo, Math.min(hi, num(x, d)))
export const isVec = (p) => Array.isArray(p) && p.length >= 3
// math (x, y, z-up) -> three (x, y-up, -z)
export const v = (p, d = [0, 0, 0]) => {
  const [x, y, z] = isVec(p) ? p : d
  return new THREE.Vector3(num(x), num(z), -num(y))
}
export const UP = new THREE.Vector3(0, 1, 0)
export const darker = (c, k = 0.72) => '#' + new THREE.Color(hex(c)).multiplyScalar(k).getHexString()

// Deterministic randomness so a model looks the same every time it is drawn.
export function rng(seed = 7) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- materials ----------

// finish: standard | matte | glossy | organic | glass | metal. Target opacity lives in userData for fade-ins.
export function material(color, { opacity = 1, emissive = false, finish = 'standard', vertexColors = false } = {}) {
  const base = { color: hex(color), transparent: true, opacity: 0, side: THREE.DoubleSide, vertexColors }
  let m
  switch (finish) {
    case 'organic':
      m = new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.4, sheen: 0.6, sheenColor: new THREE.Color('#ffffff'), sheenRoughness: 0.5 })
      break
    case 'glossy':
      m = new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.15 })
      break
    case 'glass':
      m = new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.05, metalness: 0, clearcoat: 1, depthWrite: false })
      opacity = Math.min(opacity, 0.3)
      break
    case 'metal':
      m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.3, metalness: 0.85 })
      break
    case 'matte':
      m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.95, metalness: 0 })
      break
    default:
      m = new THREE.MeshStandardMaterial({ ...base, roughness: 0.45, metalness: 0.05 })
  }
  if (vertexColors) m.color.set('#ffffff')
  if (emissive) m.emissive = new THREE.Color(hex(color)).multiplyScalar(0.3)
  m.userData.opacity = clampN(opacity, 1, 0.03, 1)
  if (m.userData.opacity < 0.99) m.depthWrite = false // see-through shells must not hide what's inside
  return m
}

// Rotation given in degrees about the math x, y, z axes (applied x, then y, then z).
export function applyRotate(obj, rot) {
  if (!Array.isArray(rot)) return
  const [rx, ry, rz] = rot.map((a) => THREE.MathUtils.degToRad(num(a)))
  const q = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), rz)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), ry))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rx))
  obj.quaternion.premultiply(q)
}

// ---------- metaball blobs ----------

const cubes = new Map() // resolution -> reusable MarchingCubes field
function field(res) {
  if (!cubes.has(res)) cubes.set(res, new MarchingCubes(res, new THREE.MeshBasicMaterial(), false, false, 200000))
  return cubes.get(res)
}

/**
 * Smooth organic surface from overlapping spheres (and capsules), like clay.
 * balls: [[x,y,z,r], ...] math coords; segs: [[[x,y,z],[x,y,z],r1,r2], ...]
 * colors: optional per-ball colours (blended smoothly across the surface)
 * smooth: 0 (tight) .. 1 (very melted). wrinkle: amplitude of a folded surface (brain, coral).
 * squash: [sx,sy,sz] math scale applied afterwards (e.g. flatten a torso front-to-back).
 */
export function blobGeometry({ balls = [], segs = [], colors = null, smooth = 0.4, wrinkle = 0, wrinkleFreq = 9, squash = null, res = 0 } = {}) {
  const all = balls.filter((b) => Array.isArray(b) && b.length >= 4).map((b) => ({ p: v(b), r: Math.max(0.01, num(b[3], 0.5)), c: colors?.[balls.indexOf(b)] }))
  for (const s of segs) {
    if (!Array.isArray(s) || !isVec(s[0]) || !isVec(s[1])) continue
    const a = v(s[0]), b = v(s[1]), r1 = Math.max(0.01, num(s[2], 0.2)), r2 = Math.max(0.01, num(s[3], r1))
    const n = Math.max(2, Math.ceil(a.distanceTo(b) / (Math.min(r1, r2) * 0.45)))
    for (let i = 0; i <= n; i++) all.push({ p: a.clone().lerp(b, i / n), r: r1 + ((r2 - r1) * i) / n, c: s[4] })
  }
  if (!all.length) return null

  const subtract = 60 - 45 * clampN(smooth, 0.4, 0, 1) // lower subtract = wider blending
  const iso = 80
  const box = new THREE.Box3()
  for (const b of all) box.expandByPoint(b.p.clone().addScalar(b.r)).expandByPoint(b.p.clone().subScalar(b.r))
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const maxR = Math.max(...all.map((b) => b.r))
  const L = Math.max(size.x, size.y, size.z) + maxR * 1.2 + 0.2
  const resolution = res || Math.round(Math.max(40, Math.min(84, (L / Math.min(...all.map((b) => b.r))) * 7)))
  const mc = field(resolution)
  mc.reset()
  mc.isolation = iso
  for (const b of all) {
    const rn = b.r / L
    const u = new THREE.Vector3().subVectors(b.p, center).divideScalar(L).addScalar(0.5)
    mc.addBall(u.x, u.y, u.z, (iso + subtract) * rn * rn, subtract)
  }
  mc.update()

  const count = mc.count
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3)
  for (let i = 0; i < count * 3; i += 3) {
    pos[i] = center.x + (mc.positionArray[i] * L) / 2
    pos[i + 1] = center.y + (mc.positionArray[i + 1] * L) / 2
    pos[i + 2] = center.z + (mc.positionArray[i + 2] * L) / 2
    nor[i] = mc.normalArray[i]; nor[i + 1] = mc.normalArray[i + 1]; nor[i + 2] = mc.normalArray[i + 2]
  }
  let geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))

  if (wrinkle) {
    // weld the triangle soup first so the folded surface gets smooth (not faceted) normals
    geo.deleteAttribute('normal')
    geo = mergeVertices(geo, 1e-5)
    geo.computeVertexNormals()
    foldSurface(geo, wrinkle, wrinkleFreq)
  }
  if (all.some((b) => b.c)) paintByNearest(geo, all)
  if (squash) squashGeometry(geo, squash, center)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  return geo
}

// Push vertices along their normals with ridged noise: brain gyri, coral, bark.
function foldSurface(geo, amp, freq) {
  const p = geo.attributes.position, n = geo.attributes.normal
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) * freq, y = p.getY(i) * freq, z = p.getZ(i) * freq
    const ridge = Math.abs(Math.sin(x + Math.sin(y * 1.3) * 1.7) + Math.sin(y * 0.9 + Math.sin(z * 1.1) * 1.9) + Math.sin(z * 1.2 + Math.sin(x * 0.8) * 1.5)) / 3
    const d = amp * (ridge - 0.45)
    p.setXYZ(i, p.getX(i) + n.getX(i) * d, p.getY(i) + n.getY(i) * d, p.getZ(i) + n.getZ(i) * d)
  }
  geo.computeVertexNormals()
}

function paintByNearest(geo, balls) {
  const p = geo.attributes.position
  const cols = balls.map((b) => new THREE.Color(hex(b.c ?? '#cccccc')))
  const out = new Float32Array(p.count * 3)
  const q = new THREE.Vector3(), c = new THREE.Color()
  for (let i = 0; i < p.count; i++) {
    q.fromBufferAttribute(p, i)
    let wsum = 0
    c.setRGB(0, 0, 0)
    balls.forEach((b, k) => {
      if (!b.c) return
      const w = (b.r / Math.max(1e-3, q.distanceTo(b.p))) ** 6
      wsum += w
      c.r += cols[k].r * w; c.g += cols[k].g * w; c.b += cols[k].b * w
    })
    out.set(wsum ? [c.r / wsum, c.g / wsum, c.b / wsum] : [0.8, 0.8, 0.8], i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3))
}

// Colour vertices with a function of their math position (lobes, layers, gradients).
export function paintGeometry(geo, fn) {
  const p = geo.attributes.position
  const out = new Float32Array(p.count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < p.count; i++) {
    c.set(hex(fn(p.getX(i), -p.getZ(i), p.getY(i)))) // back to math x, y, z
    out.set([c.r, c.g, c.b], i * 3)
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3))
  return geo
}

function squashGeometry(geo, [sx, sy, sz], center) {
  const m = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z)
  m.premultiply(new THREE.Matrix4().makeScale(num(sx, 1), num(sz, 1), num(sy, 1)))
  m.premultiply(new THREE.Matrix4().makeTranslation(center.x, center.y, center.z))
  geo.applyMatrix4(m)
}

// ---------- tubes, lathes, leaves, ellipsoids ----------

/**
 * Smooth tube along a path whose radius can change along its length: vessels, limbs, stems, roots, nerves.
 * radii: a number, or a list sampled evenly along the path. Ends are capped with spheres.
 */
export function tube(points, radii, mat, { closed = false, radial = 14, caps = true } = {}) {
  const pts = points.filter(isVec).map((p) => v(p))
  if (pts.length < 2) return null
  const rs = (Array.isArray(radii) ? radii : [radii]).map((r) => Math.max(0.003, num(r, 0.05)))
  const R = (u) => {
    if (rs.length === 1) return rs[0]
    const x = u * (rs.length - 1), i = Math.min(rs.length - 2, Math.floor(x))
    return rs[i] + (rs[i + 1] - rs[i]) * (x - i)
  }
  const path = new THREE.CatmullRomCurve3(pts, closed, 'centripetal')
  const len = path.getLength()
  const segments = Math.max(8, Math.min(400, Math.ceil(len / (Math.min(...rs) * 1.2)) + pts.length * 4))
  const geo = new THREE.TubeGeometry(path, segments, 1, radial, closed)
  const p = geo.attributes.position
  const c = new THREE.Vector3(), q = new THREE.Vector3()
  for (let i = 0; i <= segments; i++) {
    const u = i / segments
    path.getPointAt(u, c)
    const r = R(u)
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j
      q.fromBufferAttribute(p, k).sub(c).multiplyScalar(r).add(c)
      p.setXYZ(k, q.x, q.y, q.z)
    }
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  const g = new THREE.Group()
  const mesh = new THREE.Mesh(geo, mat)
  g.add(mesh)
  if (caps && !closed) {
    for (const [pt, r] of [[pts[0], R(0)], [pts.at(-1), R(1)]]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(r, radial, 10), mat)
      cap.position.copy(pt)
      g.add(cap)
    }
  }
  g.userData.path = path
  g.userData.drawable = geo // index ordered along the path, so setDrawRange reveals it like a pen
  g.userData.radial = radial
  return g
}

/**
 * A smooth streamlined body lofted along a spine: fish, birds, worms, insects, carrots, bananas, boats.
 * widths / heights: full thickness side-to-side and top-to-bottom at evenly spaced points along the spine
 * (each a number or a list). belly: optional underside colour, blended in like countershading.
 */
export function bodyGeometry(spine, widths, heights, { belly = null, color = '#888888', radial = 28 } = {}) {
  const pts = spine.filter(isVec).map((p) => v(p))
  if (pts.length < 2) return null
  const list = (x, d) => (Array.isArray(x) ? x : [x ?? d]).map((n) => Math.max(0.005, num(n, d)))
  const ws = list(widths, 0.5), hs = list(heights, 0.5)
  const sample = (arr, u) => {
    if (arr.length === 1) return arr[0]
    const x = u * (arr.length - 1), i = Math.min(arr.length - 2, Math.floor(x)), f = x - i
    const s = f * f * (3 - 2 * f) // smoothstep so the outline has no kinks
    return arr[i] + (arr[i + 1] - arr[i]) * s
  }
  const path = new THREE.CatmullRomCurve3(pts, false, 'centripetal')
  const rings = Math.max(24, Math.min(160, Math.round(path.getLength() * 30)))
  const pos = [], col = [], idx = []
  const top = new THREE.Color(hex(color)), under = new THREE.Color(hex(belly ?? color)), c = new THREE.Color()
  const T = new THREE.Vector3(), U = new THREE.Vector3(), S = new THREE.Vector3(), P = new THREE.Vector3()
  for (let i = 0; i <= rings; i++) {
    const u = i / rings
    path.getPointAt(u, P)
    path.getTangentAt(u, T)
    // "up" is world up made perpendicular to the spine (falls back to sideways for a vertical spine)
    U.copy(UP).addScaledVector(T, -UP.dot(T))
    if (U.lengthSq() < 1e-4) U.set(1, 0, 0).addScaledVector(T, -T.x)
    U.normalize()
    S.crossVectors(T, U).normalize()
    // round the nose and tail tips off a little
    const end = Math.min(1, Math.sin((Math.PI / 2) * Math.min(1, Math.min(u, 1 - u) * 4.4)) ** 0.35 + 0.05)
    const w = (sample(ws, u) / 2) * end, h = (sample(hs, u) / 2) * end
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2
      const q = P.clone().addScaledVector(S, Math.cos(a) * w).addScaledVector(U, Math.sin(a) * h)
      pos.push(q.x, q.y, q.z)
      c.copy(top).lerp(under, Math.max(0, Math.min(1, 0.5 - Math.sin(a) * 0.9)))
      col.push(c.r, c.g, c.b)
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1
    idx.push(a, b, a + 1, a + 1, b, b + 1)
  }
  // close both ends with a small fan
  for (const [ring, flip] of [[0, true], [rings, false]]) {
    const start = ring * (radial + 1)
    path.getPointAt(ring / rings, P)
    const center = pos.length / 3
    pos.push(P.x, P.y, P.z)
    col.push(...col.slice(start * 3, start * 3 + 3))
    for (let j = 0; j < radial; j++) idx.push(...(flip ? [center, start + j + 1, start + j] : [center, start + j, start + j + 1]))
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  if (belly) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  geo.computeBoundingBox()
  return geo
}

/** Surface of revolution from a profile [[radius, height], ...] around the vertical axis through base. */
export function lathe(profile, mat, { base = [0, 0, 0], segments = 48, axis = null } = {}) {
  const pts = (profile ?? []).filter((p) => Array.isArray(p) && p.length >= 2).map(([r, h]) => new THREE.Vector2(Math.max(0, num(r)), num(h)))
  if (pts.length < 2) return null
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, segments), mat)
  mesh.position.copy(v(base))
  if (isVec(axis)) mesh.quaternion.setFromUnitVectors(UP, v(axis).normalize())
  return mesh
}

export function ellipsoid(center, radii, mat, rotate) {
  const [rx, ry, rz] = (Array.isArray(radii) ? radii : [radii, radii, radii]).map((r) => Math.max(0.005, num(r, 0.5)))
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), mat)
  mesh.scale.set(rx, rz, ry)
  mesh.position.copy(v(center))
  applyRotate(mesh, rotate)
  return mesh
}

/**
 * A leaf or petal: a curved, slightly folded blade from base to tip, with a midrib.
 * normal: the direction the upper face looks toward (default: up/out). curl > 0 bends the tip up, < 0 down.
 */
export function leaf(base, tip, { width = 0.3, color = '#3d8b37', curl = 0.25, fold = 0.2, shape = 'leaf', normal = null, rib = true, opacity = 1 } = {}) {
  const b = v(base), t = v(tip)
  const L = b.distanceTo(t)
  if (L < 1e-3) return null
  const X = t.clone().sub(b).normalize()
  let N = isVec(normal) ? v(normal).normalize() : UP.clone()
  if (Math.abs(N.dot(X)) > 0.95) N = new THREE.Vector3(0, 0, 1)
  const Y = new THREE.Vector3().crossVectors(N, X).normalize()
  const Z = new THREE.Vector3().crossVectors(X, Y).normalize()
  const W = Math.max(0.01, num(width, 0.3)) / 2
  const nx = 24, ny = 8
  const half = (s) => (shape === 'petal'
    ? W * Math.sin(Math.PI * Math.min(1, s * 0.92 + 0.04)) ** 0.5 * (0.35 + 0.65 * s ** 0.6)
    : W * Math.sin(Math.PI * s) ** 0.8 * (1 - 0.25 * s))
  const pos = [], idx = []
  for (let i = 0; i <= nx; i++) {
    const s = i / nx
    const w = half(s)
    for (let j = 0; j <= ny; j++) {
      const k = (j / ny) * 2 - 1
      const along = s * L
      const lift = num(curl, 0.25) * s * s * L * 0.5 + num(fold, 0.2) * Math.abs(k) * w
      const p = b.clone().addScaledVector(X, along).addScaledVector(Y, k * w).addScaledVector(Z, lift)
      pos.push(p.x, p.y, p.z)
    }
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const a = i * (ny + 1) + j, c = a + ny + 1
    idx.push(a, c, a + 1, a + 1, c, c + 1)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  const g = new THREE.Group()
  g.add(new THREE.Mesh(geo, material(color, { finish: 'organic', opacity })))
  if (rib) {
    const ribPts = []
    for (let i = 0; i <= 8; i++) {
      const s = (i / 8) * 0.95
      const p = b.clone().addScaledVector(X, s * L).addScaledVector(Z, num(curl, 0.25) * s * s * L * 0.5 + 0.004)
      ribPts.push([p.x, -p.z, p.y])
    }
    const r = tube(ribPts, [W * 0.08, W * 0.02], material(darker(color), { finish: 'organic' }), { radial: 6, caps: false })
    if (r) g.add(r)
  }
  return g
}
