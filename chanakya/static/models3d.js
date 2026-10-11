// Library of procedural 3D models for subjects that basic shapes can't do justice:
// anatomy, plants, cells, DNA, neurons, the eye.
//
// Each builder returns { group, parts, paths } in math coordinates (z up, front = -y):
//   parts: [{ name, label, obj|null, anchor:[x,y,z] }]  name is what the tutor targets ("heart.aorta");
//          anchor is the point a label's leader line touches. obj null = a named spot without its own mesh.
//   paths: { name: [[x,y,z], ...] }  routes for the "flow" action (blood, air, water, nerve impulses).
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { blobGeometry, bodyGeometry, paintGeometry, tube, lathe, ellipsoid, leaf, material, v, rng, num, applyRotate } from './kit3d.js'

const title = (name) => name.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function builder() {
  const group = new THREE.Group()
  const parts = []
  const paths = {}
  const hinges = [] // parts that swing about a joint for the "flap" action (wings, tails)
  /** hinge: { pivot:[x,y,z], axis:[x,y,z], sign:+1|-1 } makes the part rotate about that joint. */
  const part = (name, objs, anchor, label, hinge = null) => {
    const g = new THREE.Group()
    g.name = name
    for (const o of [objs].flat()) if (o) g.add(o)
    if (hinge) {
      const p = v(hinge.pivot)
      g.children.forEach((c) => c.position.sub(p))
      g.position.copy(p)
      hinges.push({ obj: g, axis: v(hinge.axis).normalize(), sign: hinge.sign ?? 1 })
    }
    group.add(g)
    parts.push({ name, label: label ?? title(name), obj: g, anchor })
    return g
  }
  const spot = (name, anchor, label) => parts.push({ name, label: label ?? title(name), obj: null, anchor })
  return { group, parts, paths, hinges, part, spot }
}

function cone(from, to, r, mat) {
  const a = v(from), b = v(to)
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, a.distanceTo(b), 24).translate(0, a.distanceTo(b) / 2, 0), mat)
  m.position.copy(a)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  return m
}
const bodyMesh = (spine, w, h, color, belly) => {
  const geo = bodyGeometry(spine, w, h, { color, belly })
  return geo && new THREE.Mesh(geo, org(color, 1, { vertexColors: !!geo.attributes.color }))
}

const org = (color, opacity = 1, extra = {}) => material(color, { finish: 'organic', opacity, ...extra })
const blob = (spec, color, opacity = 1) => {
  const geo = blobGeometry(spec)
  return geo && new THREE.Mesh(geo, org(color, opacity, { vertexColors: !!geo.attributes.color }))
}
const sphere = (c, r, mat, seg = 24) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.ceil(seg * 0.7)), mat)
  m.position.copy(v(c))
  return m
}
const add = (a, b) => a.map((x, i) => x + b[i])
const scale = (a, k) => a.map((x) => x * k)
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l) }

// Random branching (roots, dendrites, bronchioles, tree limbs). Returns the tip points.
function branches(out, start, dir, { len, r, depth, spread = 0.6, shrink = 0.72, gravity = [0, 0, 0], kids = 2, rand, mat, tips = [] }) {
  const d = norm(add(dir, gravity))
  const mid = add(start, add(scale(d, len * 0.5), [(rand() - 0.5) * len * 0.15, (rand() - 0.5) * len * 0.15, (rand() - 0.5) * len * 0.15]))
  const end = add(start, scale(d, len))
  const t = tube([start, mid, end], [r, r * 0.85, r * shrink], mat, { radial: 8 })
  if (t) out.push(t)
  if (depth <= 0) { tips.push(end); return tips }
  for (let k = 0; k < kids; k++) {
    // a random direction perpendicular-ish to d, mixed in by `spread`
    const rnd = norm([rand() - 0.5, rand() - 0.5, rand() - 0.5])
    const nd = norm(add(d, scale(rnd, spread * (0.7 + rand() * 0.6))))
    branches(out, end, nd, { len: len * (0.65 + rand() * 0.15), r: r * shrink, depth: depth - 1, spread, shrink, gravity, kids, rand, mat, tips })
  }
  return tips
}

// ---------------------------------------------------------------- heart

function heart() {
  const B = builder()
  const muscle = '#b23a32', muscle2 = '#c24a3d', atria = '#9e2f2f', artery = '#d1342f', vein = '#3d5fc4'
  B.part('right-ventricle', blob({ balls: [[-0.55, -0.25, 1.25, 0.8], [-0.3, -0.35, 0.75, 0.62], [-0.05, -0.3, 0.35, 0.4]] }, muscle2), [-0.75, -0.95, 1.05])
  B.part('left-ventricle', blob({ balls: [[0.45, 0.1, 1.2, 0.88], [0.4, 0.05, 0.6, 0.62], [0.45, 0, 0.1, 0.32]] }, muscle), [1.2, -0.25, 0.95])
  B.part('right-atrium', blob({ balls: [[-1.0, 0, 2.05, 0.55], [-0.9, 0.1, 2.4, 0.4], [-1.1, -0.3, 2.15, 0.28]] }, atria), [-1.5, -0.15, 2.05])
  B.part('left-atrium', blob({ balls: [[0.75, 0.4, 2.15, 0.5], [0.95, 0.05, 2.3, 0.24]] }, atria), [1.2, 0.2, 2.3])
  B.part('aorta', [
    tube([[0.05, 0, 1.8], [0, -0.05, 2.6], [0.15, 0.05, 3.2], [0.6, 0.3, 3.45], [1.05, 0.55, 3.2], [1.2, 0.65, 2.5], [1.2, 0.7, 1.4]], [0.32, 0.32, 0.31, 0.3, 0.28, 0.26, 0.25], org(artery)),
    tube([[0.2, 0.1, 3.3], [0.12, 0.1, 4.0]], [0.11, 0.09], org(artery)),
    tube([[0.5, 0.25, 3.45], [0.5, 0.3, 4.05]], [0.09, 0.08], org(artery)),
    tube([[0.82, 0.42, 3.4], [0.92, 0.45, 4.0]], [0.09, 0.08], org(artery)),
  ], [0.6, 0.3, 3.78])
  B.part('pulmonary-artery', [
    tube([[-0.3, -0.45, 1.7], [-0.2, -0.45, 2.4], [0.05, -0.3, 2.85]], [0.27, 0.27, 0.25], org(vein)),
    tube([[0.05, -0.3, 2.85], [0.6, 0, 2.85], [1.4, 0.2, 2.7]], [0.19, 0.18, 0.16], org(vein)),
    tube([[0.05, -0.3, 2.85], [-0.3, 0.25, 2.8], [-1.3, 0.4, 2.7]], [0.19, 0.18, 0.16], org(vein)),
  ], [-0.25, -0.75, 2.3])
  B.part('superior-vena-cava', tube([[-0.95, 0.05, 2.3], [-0.95, 0.05, 3.0], [-0.9, 0.05, 3.8]], 0.24, org(vein)), [-0.95, -0.2, 3.45])
  B.part('inferior-vena-cava', tube([[-0.95, 0.15, 1.8], [-0.95, 0.2, 1.1], [-0.9, 0.25, 0.4]], 0.26, org(vein)), [-1.0, 0.0, 0.5])
  B.part('pulmonary-veins', [
    tube([[0.85, 0.5, 2.25], [1.5, 0.85, 2.4]], 0.1, org('#a8323e')),
    tube([[0.85, 0.55, 2.0], [1.5, 0.9, 1.9]], 0.1, org('#a8323e')),
    tube([[0.55, 0.6, 2.2], [-0.1, 1.0, 2.35]], 0.1, org('#a8323e')),
  ], [1.5, 0.85, 2.4])
  B.spot('apex', [0.45, -0.05, -0.22])
  // valves sit between chambers and at the exits; shown as named spots (highlight drops a glowing marker)
  B.spot('tricuspid-valve', [-0.72, -0.2, 1.72])
  B.spot('pulmonary-valve', [-0.3, -0.5, 1.75])
  B.spot('mitral-valve', [0.62, 0.25, 1.78])
  B.spot('aortic-valve', [0.05, -0.05, 1.82])
  B.spot('septum', [0.02, -0.55, 0.95], 'Septum')
  // routes through the chambers; make the heart see-through (opacity ~0.35) when showing flow
  B.paths['body-to-lungs'] = [[-0.9, 0.05, 3.8], [-0.95, 0.05, 2.6], [-0.95, 0, 2.05], [-0.5, -0.3, 1.2], [-0.25, -0.4, 1.4], [-0.2, -0.45, 2.4], [0.05, -0.3, 2.85], [-0.3, 0.25, 2.8], [-1.3, 0.4, 2.7]]
  B.paths['lungs-to-body'] = [[1.5, 0.85, 2.4], [0.8, 0.45, 2.2], [0.5, 0.1, 1.2], [0.4, 0.05, 0.6], [0.1, 0, 1.4], [0, -0.05, 2.6], [0.15, 0.05, 3.2], [0.6, 0.3, 3.45], [1.05, 0.55, 3.2], [1.2, 0.7, 1.4]]
  B.paths.blood = [...B.paths['body-to-lungs'], ...B.paths['lungs-to-body']]
  return B
}

// ---------------------------------------------------------------- human body

function human({ organs = false, color = '#e2b08f' } = {}) {
  const B = builder()
  const skinOpacity = organs ? 0.2 : 1
  const skin = () => material(color, { finish: organs ? 'glass' : 'organic', opacity: skinOpacity })
  const skinBlob = (spec) => { const g = blobGeometry(spec); return g && new THREE.Mesh(g, skin()) }
  B.part('head', [
    skinBlob({ balls: [[0, 0, 3.64, 0.26], [0, -0.04, 3.52, 0.21], [0, 0.04, 3.7, 0.24]], segs: [[[0, 0, 3.25], [0, 0, 3.45], 0.1, 0.1]] }),
  ], [0.2, -0.2, 3.7])
  B.part('torso', skinBlob({
    balls: [[0, 0, 2.85, 0.36], [-0.2, 0, 2.92, 0.28], [0.2, 0, 2.92, 0.28], [-0.36, 0, 3.05, 0.15], [0.36, 0, 3.05, 0.15],
      [0, 0, 2.45, 0.3], [0, 0, 2.18, 0.27], [0, 0, 1.95, 0.3], [-0.17, 0, 1.9, 0.24], [0.17, 0, 1.9, 0.24]],
    squash: [1, 0.62, 1], smooth: 0.5,
  }), [0.35, -0.2, 2.6], 'Torso')
  for (const s of [1, -1]) {
    const side = s > 0 ? 'left' : 'right' // the body's own left is on the viewer's right (+x)
    B.part(`${side}-arm`, [
      tube([[s * 0.38, 0, 3.05], [s * 0.5, 0, 2.62], [s * 0.6, -0.02, 2.32], [s * 0.66, -0.05, 1.98], [s * 0.7, -0.06, 1.75]], [0.12, 0.1, 0.085, 0.07, 0.058], skin()),
      ellipsoid([s * 0.72, -0.06, 1.62], [0.04, 0.08, 0.12], skin()),
    ], [s * 0.66, -0.1, 2.3])
    B.part(`${side}-leg`, [
      tube([[s * 0.17, 0, 1.85], [s * 0.2, 0, 1.4], [s * 0.21, 0, 1.0], [s * 0.21, 0.01, 0.55], [s * 0.21, 0.02, 0.13]], [0.17, 0.14, 0.105, 0.085, 0.06], skin()),
      ellipsoid([s * 0.21, -0.1, 0.05], [0.07, 0.16, 0.05], skin()),
    ], [s * 0.3, -0.1, 1.1])
  }
  if (organs) {
    B.part('brain', ellipsoid([0, 0.01, 3.68], [0.19, 0.23, 0.14], org('#f0a7b4')), [0.15, -0.15, 3.78])
    B.part('lungs', [
      ellipsoid([-0.15, 0.02, 2.9], [0.13, 0.12, 0.26], org('#f19ca5', 0.85)),
      ellipsoid([0.16, 0.02, 2.9], [0.12, 0.12, 0.25], org('#f19ca5', 0.85)),
    ], [-0.27, -0.05, 2.95])
    B.part('heart', blob({ balls: [[0.05, -0.08, 2.78, 0.09], [0.0, -0.07, 2.86, 0.08], [0.08, -0.08, 2.7, 0.06]] }, '#b8302b'), [0.12, -0.16, 2.78])
    B.part('liver', ellipsoid([-0.11, -0.03, 2.52], [0.2, 0.12, 0.09], org('#8d3b2f'), [0, 15, 0]), [-0.28, -0.1, 2.52])
    B.part('stomach', blob({ balls: [[0.13, -0.04, 2.47, 0.09], [0.08, -0.05, 2.38, 0.075], [0.18, -0.03, 2.53, 0.06]] }, '#e39b77'), [0.22, -0.1, 2.45])
    const coil = []
    for (let i = 0; i <= 60; i++) {
      const t = i / 60
      coil.push([0.18 * Math.sin(t * Math.PI * 7) * (1 - 0.3 * Math.sin(t * 9)), -0.06 + 0.04 * Math.cos(t * 23), 2.3 - t * 0.3])
    }
    B.part('intestines', tube(coil, 0.035, org('#e7a39a')), [0.18, -0.12, 2.15])
    B.part('kidneys', [
      ellipsoid([-0.11, 0.09, 2.3], [0.045, 0.035, 0.075], org('#99403d')),
      ellipsoid([0.11, 0.09, 2.31], [0.045, 0.035, 0.075], org('#99403d')),
    ], [0.15, 0.1, 2.3])
    B.part('bladder', sphere([0, -0.05, 1.9], 0.06, org('#e8c06a')), [0.08, -0.1, 1.88])
    B.part('spine', tube([[0, 0.16, 3.35], [0, 0.13, 2.8], [0, 0.17, 2.3], [0, 0.15, 1.95]], 0.03, org('#e9e4d4')), [0, 0.2, 2.6])
    B.paths.digestion = [[0, -0.02, 3.4], [0, 0.02, 3.0], [0.05, -0.02, 2.6], [0.13, -0.04, 2.47], ...coil.filter((_, i) => i % 3 === 0)]
  }
  return B
}

// ---------------------------------------------------------------- lungs

function lungs() {
  const B = builder()
  const rand = rng(11)
  const rings = []
  for (let z = 3.6; z > 2.85; z -= 0.12) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.022, 8, 28), org('#f3ead3'))
    r.position.copy(v([0, 0, z]))
    r.rotation.x = Math.PI / 2
    rings.push(r)
  }
  B.part('trachea', [tube([[0, 0, 3.75], [0, 0, 2.75]], 0.12, org('#e6d3bf')), ...rings], [0.15, -0.1, 3.3])
  const tree = [], tips = []
  const bronchus = '#d98e8e'
  B.part('bronchi', [
    tube([[0, 0, 2.75], [0.25, 0.02, 2.5], [0.55, 0.05, 2.25]], [0.1, 0.09, 0.08], org(bronchus)),
    tube([[0, 0, 2.75], [-0.25, 0.02, 2.55], [-0.55, 0.05, 2.3]], [0.1, 0.09, 0.08], org(bronchus)),
  ], [-0.3, -0.05, 2.55])
  for (const s of [1, -1]) {
    branches(tree, [s * 0.55, 0.05, 2.25], [s * 0.4, 0, -1], { len: 0.45, r: 0.06, depth: 4, spread: 0.9, shrink: 0.7, rand, mat: org('#e0a3a3'), tips })
  }
  B.part('bronchioles', tree, tips[3])
  B.part('right-lung', blob({ balls: [[-0.8, 0.05, 2.55, 0.42], [-0.85, 0.05, 2.0, 0.6], [-0.85, 0.05, 1.4, 0.66], [-0.6, 0.05, 1.3, 0.5]], squash: [1, 0.78, 1] }, '#f19ca5', 0.42), [-1.5, -0.1, 1.7])
  B.part('left-lung', blob({ balls: [[0.8, 0.05, 2.55, 0.38], [0.88, 0.08, 2.0, 0.55], [0.92, 0.05, 1.4, 0.6], [0.65, 0.15, 1.35, 0.4]], squash: [1, 0.78, 1] }, '#f19ca5', 0.42), [1.52, -0.1, 1.7])
  const tip = tips.reduce((a, b) => (b[1] < a[1] ? b : a)) // the front-most tip is easiest to see
  const sacs = []
  for (let i = 0; i < 8; i++) sacs.push(sphere(add(tip, [(rand() - 0.5) * 0.14, (rand() - 0.5) * 0.14, (rand() - 0.5) * 0.14]), 0.045, org('#f7b6c0')))
  B.part('alveoli', sacs, tip)
  const dome = lathe([[0, 0.86], [0.6, 0.8], [1.0, 0.64], [1.35, 0.42], [1.6, 0.2]], org('#c0504d', 0.85))
  dome.scale.set(1, 1, 0.78)
  B.part('diaphragm', dome, [0.3, -1.1, 0.5])
  B.paths.air = [[0, 0, 3.75], [0, 0, 2.75], [0.25, 0.02, 2.5], [0.55, 0.05, 2.25], tip]
  return B
}

// ---------------------------------------------------------------- brain

function brain({ lobes = true } = {}) {
  const B = builder()
  const lobeColor = (x, y, z) => (y < -0.3 && z > 1.8 ? '#f4a261' : y > 0.6 ? '#8fbf6a' : z < 1.95 ? '#7fb3e0' : '#e9c46a')
  for (const s of [1, -1]) {
    const geo = blobGeometry({
      balls: [[s * 0.5, -0.95, 2.15, 0.55], [s * 0.52, -0.4, 2.4, 0.72], [s * 0.52, 0.35, 2.4, 0.72], [s * 0.48, 0.95, 2.15, 0.55], [s * 0.64, -0.35, 1.7, 0.48], [s * 0.62, 0.2, 1.65, 0.45]],
      wrinkle: 0.13, wrinkleFreq: 11, smooth: 0.45, res: 84,
    })
    if (lobes) paintGeometry(geo, lobeColor)
    B.part(`${s > 0 ? 'left' : 'right'}-hemisphere`, new THREE.Mesh(geo, org('#e8a9ae', 1, { vertexColors: lobes })), [s * 1.0, 0, 2.6])
  }
  B.spot('frontal-lobe', [0.55, -1.42, 2.2])
  B.spot('parietal-lobe', [0.55, 0.1, 3.08])
  B.spot('occipital-lobe', [0.45, 1.45, 2.15])
  B.spot('temporal-lobe', [1.1, -0.35, 1.55])
  B.part('cerebellum', blob({ balls: [[0.32, 1.0, 1.32, 0.36], [-0.32, 1.0, 1.32, 0.36]], wrinkle: 0.03, wrinkleFreq: 22 }, '#d68aa0'), [0.55, 1.25, 1.1])
  B.part('brainstem', tube([[0, 0.45, 1.6], [0, 0.55, 1.1], [0, 0.62, 0.45]], [0.2, 0.16, 0.13], org('#d4a5a5')), [0.15, 0.55, 0.8])
  return B
}

// ---------------------------------------------------------------- tree

function tree({ type = 'deciduous', roots = true } = {}) {
  const B = builder()
  const rand = rng(5)
  const bark = org('#6f4a2a')
  if (type === 'pine') {
    B.part('trunk', tube([[0, 0, 0], [0, 0, 3.8]], [0.2, 0.06], bark), [0.2, -0.15, 0.6])
    const layers = []
    for (let i = 0; i < 5; i++) {
      const z = 0.9 + i * 0.6, r = 1.25 - i * 0.22
      layers.push(lathe([[r, 0], [r * 0.55, 0.25], [0, 0.95]], org(i % 2 ? '#2f6b3a' : '#2a5e33'), { base: [0, 0, z] }))
    }
    B.part('needles', layers, [0.9, -0.5, 2.1], 'Needle-covered branches')
    B.paths.water = [[0, 0, -0.6], [0, 0, 0], [0, 0, 2.5], [0.6, 0, 2.4]]
  } else {
    B.part('trunk', tube([[0, 0, 0], [0.05, 0, 0.9], [0, 0.04, 1.7]], [0.3, 0.22, 0.17], bark), [0.32, -0.15, 0.6])
    const limbs = [], tips = []
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4
      branches(limbs, [0, 0.04, 1.65], [Math.cos(a) * 0.7, Math.sin(a) * 0.7, 1], { len: 0.9, r: 0.13, depth: 2, spread: 0.7, shrink: 0.66, kids: 2, rand, mat: bark, tips })
    }
    B.part('branches', limbs, tips[0] && add(scale(tips[0], 0.7), [0, 0, 0.5]))
    const geo = blobGeometry({ balls: tips.map((t) => [...t, 0.48 + rand() * 0.2]), wrinkle: 0.06, wrinkleFreq: 6, smooth: 0.55 })
    paintGeometry(geo, (x, y, z) => (z > 3.3 ? '#5aa548' : z > 2.7 ? '#4a9440' : '#3b7f37'))
    const top = tips.reduce((a, b) => (b[2] > a[2] ? b : a))
    B.part('leaves', new THREE.Mesh(geo, org('#ffffff', 1, { vertexColors: true })), add(top, [0.3, -0.3, 0.4]), 'Leaves (canopy)')
    B.paths.water = [[0.3, -0.2, -0.9], [0, 0, -0.2], [0.05, 0, 0.9], [0, 0.04, 1.65], ...[tips[0]]]
  }
  if (roots) {
    const rootMeshes = [], rootTips = []
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2
      branches(rootMeshes, [0, 0, 0.05], [Math.cos(a), Math.sin(a), -0.6], { len: 0.55, r: 0.1, depth: 2, spread: 0.6, shrink: 0.6, gravity: [0, 0, -0.4], rand, mat: org('#8a6a4a'), tips: rootTips })
    }
    B.part('roots', rootMeshes, rootTips[0])
    const soil = new THREE.Mesh(new THREE.CircleGeometry(2.2, 48), material('#8b6b47', { opacity: 0.3, finish: 'matte' }))
    soil.rotation.x = -Math.PI / 2
    B.part('soil', soil, [1.9, -0.6, 0], 'Soil')
  }
  return B
}

// ---------------------------------------------------------------- flower

function flower({ petals = 6, color = '#e85d9e', roots = true } = {}) {
  const B = builder()
  const green = '#4c9a2a'
  const head = [0, 0, 2.35]
  B.part('stem', tube([[0, 0, 0], [0.05, 0, 0.8], [-0.03, 0, 1.6], head], 0.045, org(green)), [0.1, -0.05, 1.3])
  B.part('leaf', [
    leaf([0.03, 0, 0.7], [0.75, -0.1, 1.2], { width: 0.42, color: '#3d8b37', curl: 0.3 }),
    leaf([-0.02, 0, 1.1], [-0.7, 0.1, 1.55], { width: 0.4, color: '#3d8b37', curl: 0.3 }),
  ], [0.5, -0.08, 1.08])
  B.part('receptacle', sphere(head, 0.1, org('#5a9e32')), [0.12, -0.05, 2.3])
  const sepals = [], pet = []
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3
    sepals.push(leaf(head, [Math.cos(a) * 0.36, Math.sin(a) * 0.36, 2.22], { width: 0.1, color: '#4f9a35', curl: -0.2, rib: false }))
  }
  B.part('sepals', sepals, [0.33, -0.12, 2.2])
  const n = Math.max(3, Math.min(12, Math.round(num(petals, 6))))
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    pet.push(leaf([Math.cos(a) * 0.05, Math.sin(a) * 0.05, 2.38], [Math.cos(a) * 0.78, Math.sin(a) * 0.78, 2.62], { width: 0.52, color, curl: 0.35, fold: 0.06, shape: 'petal', rib: false }))
  }
  B.part('petals', pet, [Math.cos(-Math.PI / 2) * 0.7, -0.7, 2.6])
  const stamens = []
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.25
    const tip = [Math.cos(a) * 0.22, Math.sin(a) * 0.22, 2.78]
    stamens.push(tube([[Math.cos(a) * 0.07, Math.sin(a) * 0.07, 2.38], tip], 0.01, org('#f1e3b3'), { caps: false }))
    stamens.push(ellipsoid(tip, [0.028, 0.028, 0.045], org('#f2b01e')))
  }
  B.part('stamens', stamens, [0.25, -0.12, 2.8], 'Stamens (anther + filament)')
  B.spot('anther', [-0.2, -0.1, 2.82])
  B.part('pistil', [
    ellipsoid([0, 0, 2.43], [0.07, 0.07, 0.09], org('#7cb342')),
    tube([[0, 0, 2.5], [0, 0, 2.86]], 0.016, org('#a5c94a'), { caps: false }),
    sphere([0, 0, 2.88], 0.038, org('#c0ca33')),
  ], [0, -0.05, 2.9], 'Pistil (stigma, style, ovary)')
  B.spot('stigma', [0, 0, 2.92])
  B.spot('ovary', [0.05, -0.06, 2.42])
  B.spot('style', [0.02, -0.03, 2.68])
  // pollen drifts from an anther across to the stigma; the pollen tube then grows down to the ovary
  B.paths.pollen = [[0.19, -0.11, 2.8], [0.45, -0.4, 3.1], [0.2, -0.25, 3.15], [0, 0, 2.9]]
  B.paths['pollen-tube'] = [[0, 0, 2.89], [0, 0, 2.7], [0, 0, 2.5], [0, 0, 2.43]]
  if (roots) {
    const rand = rng(3), rootMeshes = [], tips = []
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2
      branches(rootMeshes, [0, 0, 0], [Math.cos(a) * 0.5, Math.sin(a) * 0.5, -1], { len: 0.35, r: 0.025, depth: 2, spread: 0.7, shrink: 0.6, rand, mat: org('#c8a165'), tips })
    }
    B.part('roots', rootMeshes, tips[0])
    const soil = new THREE.Mesh(new THREE.CircleGeometry(1.1, 40), material('#8b6b47', { opacity: 0.3, finish: 'matte' }))
    soil.rotation.x = -Math.PI / 2
    B.group.add(soil)
    B.paths.water = [tips[0], [0, 0, 0], [0.05, 0, 0.8], [-0.03, 0, 1.6], head, [0, -0.75, 2.6]]
  }
  return B
}

// ---------------------------------------------------------------- cells

function cell({ type = 'animal' } = {}) {
  const B = builder()
  const rand = rng(17)
  const plant = type === 'plant'
  if (plant) {
    const wall = new THREE.Mesh(new RoundedBoxGeometry(3.6, 2.4, 2.4, 4, 0.3), material('#7cb342', { opacity: 0.22, finish: 'glossy' }))
    B.part('cell-wall', wall, [1.8, -0.6, 1.0])
    const mem = new THREE.Mesh(new RoundedBoxGeometry(3.4, 2.2, 2.2, 4, 0.26), material('#c5e1a5', { opacity: 0.14, finish: 'glass' }))
    B.part('cell-membrane', mem, [-1.7, -0.6, -0.9])
    B.part('vacuole', blob({ balls: [[-0.25, 0.1, 0, 0.75], [0.35, 0.1, 0.05, 0.65]], squash: [1.1, 1, 0.9] }, '#7fc8f0', 0.45), [0.1, -0.7, 0.1], 'Central vacuole')
    const chl = []
    for (const p of [[1.25, -0.6, 0.6], [-1.3, -0.5, 0.65], [1.2, 0.5, -0.6], [-1.2, 0.5, -0.55], [0.3, -0.75, -0.75], [-0.6, 0.6, 0.75]]) {
      chl.push(ellipsoid(p, [0.26, 0.15, 0.11], org('#2e7d32', 0.75), [0, 0, rand() * 180]))
      for (let k = -1; k <= 1; k++) {
        const s = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 12), org('#1b5e20'))
        s.position.copy(v(add(p, [k * 0.12, 0, 0])))
        chl.push(s)
      }
    }
    B.part('chloroplasts', chl, [1.25, -0.75, 0.6])
  } else {
    // a gently irregular membrane
    const geo = new THREE.IcosahedronGeometry(2, 5)
    const p = geo.attributes.position
    for (let i = 0; i < p.count; i++) {
      const q = new THREE.Vector3().fromBufferAttribute(p, i)
      q.multiplyScalar(1 + 0.05 * Math.sin(q.x * 1.7) * Math.cos(q.y * 1.3) + 0.03 * Math.sin(q.z * 2.3))
      p.setXYZ(i, q.x, q.y * 0.85, q.z)
    }
    geo.computeVertexNormals()
    B.part('cell-membrane', new THREE.Mesh(geo, material('#9ad1f5', { opacity: 0.16, finish: 'glass' })), [1.4, -0.9, 1.0])
  }
  const nucleusAt = plant ? [0.85, 0.3, 0.3] : [0.1, 0, 0.1]
  const nr = plant ? 0.45 : 0.62
  B.part('nucleus', sphere(nucleusAt, nr, org('#7b5ea7', 0.55), 36), add(nucleusAt, [nr * 0.7, -nr * 0.7, 0]))
  B.part('nucleolus', sphere(add(nucleusAt, [0.12, -0.1, 0.1]), nr * 0.32, org('#4a3570')), add(nucleusAt, [0.12, -0.1, 0.1]))
  // rough ER: wavy sheets wrapped around the nucleus, studded with ribosomes
  const er = [], dots = []
  for (let k = 0; k < 3; k++) {
    const R = nr + (plant ? 0.12 + k * 0.1 : 0.2 + k * 0.14), pts = []
    for (let i = 0; i <= 28; i++) {
      const a = -0.5 + (i / 28) * 2.6
      pts.push(add(nucleusAt, [Math.cos(a) * R, Math.sin(a) * R * 0.9, 0.12 * Math.sin(i * 1.3) - 0.1 * k]))
      if (i % 2 === 0) dots.push(add(pts.at(-1), [0, 0, 0.06]))
    }
    er.push(tube(pts, 0.045, org('#5dade2', 0.9), { radial: 8 }))
  }
  const ribo = new THREE.InstancedMesh(new THREE.SphereGeometry(0.03, 8, 6), org('#34495e'), dots.length + 40)
  const m4 = new THREE.Matrix4()
  dots.forEach((d, i) => ribo.setMatrixAt(i, m4.makeTranslation(v(d))))
  for (let i = 0; i < 40; i++) {
    const p = [(rand() - 0.5) * 2.8, (rand() - 0.5) * 1.8, (rand() - 0.5) * 1.8]
    ribo.setMatrixAt(dots.length + i, m4.makeTranslation(v(p)))
  }
  B.part('endoplasmic-reticulum', er, add(nucleusAt, [-nr - 0.45, -0.3, 0.1]), 'Rough ER')
  B.part('ribosomes', ribo, dots[4] ?? [0, 0, 0])
  const golgiAt = plant ? [-0.9, -0.55, -0.6] : [-1.15, -0.45, 0.35]
  const golgi = []
  for (let k = 0; k < 4; k++) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.42 - k * 0.04, 0.045, 8, 24, 2.3), org('#f5b041'))
    t.position.copy(v(add(golgiAt, [k * 0.1, 0, 0])))
    t.rotation.set(0, Math.PI / 2, 0.4)
    t.scale.set(1, 1, 0.5)
    golgi.push(t)
  }
  B.part('golgi-apparatus', golgi, add(golgiAt, [0, -0.4, 0.2]))
  const mito = []
  const mitoAt = plant ? [[-1.3, -0.1, -0.6], [0.6, 0.6, 0.7]] : [[1.2, -0.5, -0.5], [-0.6, 0.6, -0.8], [0.9, 0.6, 0.9], [-1.1, 0.2, -0.3]]
  for (const p of mitoAt) {
    const g = new THREE.Group()
    const shell = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.34, 8, 16), org('#e67e22', 0.6))
    shell.rotation.z = Math.PI / 2
    g.add(shell)
    const cr = []
    for (let i = 0; i <= 20; i++) cr.push([-0.24 + (i / 20) * 0.48, 0, 0.08 * Math.sin(i * 1.6)])
    g.add(tube(cr, 0.018, org('#a04000'), { radial: 6 }))
    g.position.copy(v(p))
    applyRotate(g, [rand() * 60, rand() * 60, rand() * 180])
    mito.push(g)
  }
  B.part('mitochondria', mito, add(mitoAt[0], [0.1, -0.15, 0.15]))
  if (!plant) {
    B.part('lysosomes', [[-0.4, -0.8, -0.6], [0.6, -0.9, 0.2], [-1.3, 0.1, 0.9]].map((p) => sphere(p, 0.14, org('#c0392b'))), [0.6, -1.0, 0.2])
    const cent = new THREE.Group()
    for (const rot of [[0, 0, 0], [90, 0, 0]]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 9), org('#16a085'))
      applyRotate(c, rot)
      cent.add(c)
    }
    cent.position.copy(v([0.95, 0.4, -0.55]))
    B.part('centrosome', cent, [0.95, 0.4, -0.55])
  }
  return B
}

// ---------------------------------------------------------------- DNA

function dna({ turns = 2 } = {}) {
  const B = builder()
  const rand = rng(23)
  const T = Math.max(1, Math.min(4, num(turns, 2))), H = 4, R = 0.85, total = T * Math.PI * 2
  const at = (t, phase) => [R * Math.cos(t + phase), R * Math.sin(t + phase), (t / total) * H]
  const s1 = [], s2 = []
  for (let i = 0; i <= 120 * T; i++) {
    const t = (i / (120 * T)) * total
    s1.push(at(t, 0)); s2.push(at(t, Math.PI * 0.78)) // offset < 180 degrees gives major and minor grooves
  }
  B.part('backbone', [tube(s1, 0.08, org('#f39c12')), tube(s2, 0.08, org('#2e86de'))], at(total * 0.2, 0), 'Sugar-phosphate backbone')
  const BASE = { A: '#e74c3c', T: '#f1c40f', G: '#27ae60', C: '#8e44ad' }
  const PAIR = { A: 'T', T: 'A', G: 'C', C: 'G' }
  const rungs = [], first = {}
  const steps = Math.round(10 * T)
  for (let i = 0; i < steps; i++) {
    const t = ((i + 0.5) / steps) * total
    const a = at(t, 0), b = at(t, Math.PI * 0.78), m = scale(add(a, b), 0.5)
    const base = 'ATGC'[Math.floor(rand() * 4)]
    rungs.push(tube([a, m], 0.05, org(BASE[base]), { caps: false }), tube([m, b], 0.05, org(BASE[PAIR[base]]), { caps: false }))
    first[base] ??= scale(add(a, m), 0.5)
    first[PAIR[base]] ??= scale(add(m, b), 0.5)
    first.bond ??= m
  }
  B.part('base-pairs', rungs, first.bond, 'Base pairs')
  for (const [k, name] of [['A', 'adenine'], ['T', 'thymine'], ['G', 'guanine'], ['C', 'cytosine']]) if (first[k]) B.spot(name, first[k])
  B.spot('hydrogen-bonds', first.bond)
  B.spot('major-groove', at(total * 0.62, Math.PI * 1.39).map((x, i) => (i < 2 ? x * 1.15 : x)))
  B.spot('minor-groove', at(total * 0.4, Math.PI * 0.39).map((x, i) => (i < 2 ? x * 1.1 : x)))
  return B
}

// ---------------------------------------------------------------- neuron

function neuron() {
  const B = builder()
  const rand = rng(31)
  const pink = '#e07a9f'
  B.part('cell-body', blob({ balls: [[0, 0, 0, 0.45], [0.15, 0.05, 0.1, 0.35], [-0.1, -0.05, -0.08, 0.32], [0.38, 0, 0, 0.18]], wrinkle: 0.02, wrinkleFreq: 14 }, pink, 0.8), [-0.2, -0.45, 0.25], 'Cell body (soma)')
  B.part('nucleus', sphere([0.02, -0.05, 0.05], 0.17, org('#6c3483')), [0.02, -0.2, 0.1])
  const den = [], tips = []
  for (let k = 0; k < 6; k++) {
    const a = Math.PI * 0.45 + (k / 5) * Math.PI * 1.1
    const dir = [Math.cos(a), (rand() - 0.5) * 0.8, Math.sin(a)]
    branches(den, scale(norm(dir), 0.35), dir, { len: 0.55, r: 0.07, depth: 2, spread: 0.8, shrink: 0.62, rand, mat: org(pink), tips })
  }
  B.part('dendrites', den, tips[2])
  const axonPts = [[0.45, 0, 0], [1.2, 0.05, 0.05], [2.2, -0.05, 0], [3.2, 0.05, -0.05], [3.9, 0, 0]]
  const axon = tube(axonPts, 0.06, org('#e59866'))
  B.part('axon', axon, [2.2, -0.15, -0.15])
  B.spot('axon-hillock', [0.55, -0.05, 0.08])
  const path = axon.userData.path, myelin = []
  let nodeAt = null
  for (let x = 0.24; x < 0.9; x += 0.13) {
    const u0 = x, u1 = Math.min(0.9, x + 0.1)
    const a = path.getPointAt(u0), b = path.getPointAt(u1)
    const caps = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, a.distanceTo(b) - 0.12, 6, 14), org('#f7dc6f'))
    caps.position.copy(a).add(b).multiplyScalar(0.5)
    caps.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
    myelin.push(caps)
    if (!nodeAt && x > 0.45) { const n = path.getPointAt(u1 + 0.015); nodeAt = [n.x, -n.z, n.y] }
  }
  B.part('myelin-sheath', myelin, [1.6, -0.15, 0.12])
  if (nodeAt) B.spot('node-of-ranvier', nodeAt)
  const term = []
  for (let k = 0; k < 4; k++) {
    const a = -0.8 + (k / 3) * 1.6
    const end = [4.45, Math.sin(a) * 0.3, Math.cos(a + 1.5) * 0.45]
    term.push(tube([[3.9, 0, 0], [4.15, Math.sin(a) * 0.15, Math.cos(a + 1.5) * 0.2], end], [0.04, 0.025], org('#e59866')))
    term.push(sphere(end, 0.085, org('#c0392b')))
  }
  B.part('axon-terminals', term, [4.5, -0.2, 0.3])
  B.paths.impulse = [[0.3, 0, 0], ...axonPts.slice(1), [4.45, 0, 0]]
  return B
}

// ---------------------------------------------------------------- eye (cut open on the viewer's side)

function eye({ iris = '#2e86c1', cutaway = true } = {}) {
  const B = builder()
  const R = 1.2
  // SphereGeometry poles lie on three's y-axis; rotate so the pole points to the front (math -y).
  const shell = (r, t0, t1, mat) => {
    const g = new THREE.SphereGeometry(r, 56, 40, cutaway ? -Math.PI / 2 : 0, cutaway ? Math.PI : Math.PI * 2, t0, t1 - t0)
    g.rotateX(Math.PI / 2)
    return new THREE.Mesh(g, mat)
  }
  B.part('sclera', shell(R, 0.13 * Math.PI, Math.PI, org('#f5efe6')), [-0.6, 0.2, 1.05])
  B.part('choroid', shell(R * 0.975, 0.2 * Math.PI, Math.PI, org('#5b2a1e')), [-0.2, 0.5, -1.05])
  B.part('retina', shell(R * 0.95, 0.3 * Math.PI, Math.PI, org('#d35400')), [-0.1, 0.9, 0.62])
  const cornea = shell(0.62, 0, 0.36 * Math.PI, material('#d6eaf8', { finish: 'glass', opacity: 0.35 }))
  cornea.position.copy(v([0, -0.78, 0]))
  B.part('cornea', cornea, [-0.1, -1.4, 0.35])
  const ringGeo = new THREE.RingGeometry(0.17, 0.52, 48, 1, cutaway ? Math.PI / 2 : 0, cutaway ? Math.PI : Math.PI * 2)
  const ir = new THREE.Mesh(ringGeo, org(iris))
  ir.position.copy(v([0, -1.0, 0]))
  B.part('iris', ir, [-0.35, -1.02, 0.3])
  B.spot('pupil', [0, -1.02, 0])
  B.part('lens', ellipsoid([0, -0.8, 0], [0.4, 0.17, 0.4], org('#f8e3b8', 0.75)), [0, -0.8, -0.38])
  const cil = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.07, 10, 40, cutaway ? Math.PI : Math.PI * 2), org('#8e3b1e'))
  cil.position.copy(v([0, -0.82, 0]))
  cil.rotation.z = cutaway ? Math.PI / 2 : 0
  B.part('ciliary-body', cil, [0, -0.82, 0.55])
  B.part('optic-nerve', tube([[0, 1.1, -0.12], [0, 1.6, -0.2], [0.05, 2.1, -0.32]], [0.17, 0.16, 0.15], org('#efd5a8')), [0.05, 1.9, -0.3])
  B.spot('fovea', [0, 1.13, 0])
  B.spot('optic-disc', [0, 1.12, -0.13], 'Optic disc (blind spot)')
  B.spot('vitreous-humour', [-0.4, 0.3, 0.2])
  B.paths['light-top'] = [[0, -3.2, 0.42], [0, -1.35, 0.4], [0, -0.82, 0.22], [0, 1.12, 0]]
  B.paths['light-bottom'] = [[0, -3.2, -0.42], [0, -1.35, -0.4], [0, -0.82, -0.22], [0, 1.12, 0]]
  return B
}

// ---------------------------------------------------------------- fish (head toward +x)

function fish({ color = '#4f7fa3', belly = '#ece6d6' } = {}) {
  const B = builder()
  const finC = '#8aa9c1'
  const fin = (base, tip, width, normal, c = finC) => leaf(base, tip, { width, color: c, normal, curl: 0.05, fold: 0.05, rib: false, opacity: 0.92 })
  B.part('body', bodyMesh([[1.6, 0, 1], [1.1, 0, 1.02], [0.3, 0, 1.05], [-0.6, 0, 1.0], [-1.4, 0, 0.98]], [0.05, 0.5, 0.62, 0.4, 0.12], [0.05, 0.8, 1.0, 0.6, 0.2], color, belly), [0.2, -0.32, 1.05])
  B.part('caudal-fin', [fin([-1.35, 0, 0.98], [-2.1, 0, 1.5], 0.45, [0, -1, 0]), fin([-1.35, 0, 0.98], [-2.1, 0, 0.45], 0.45, [0, -1, 0])], [-1.95, 0, 1.3], 'Caudal (tail) fin', { pivot: [-1.35, 0, 0.98], axis: [0, 0, 1] })
  B.part('dorsal-fin', fin([0.4, 0, 1.48], [-0.4, 0, 1.85], 0.45, [0, -1, 0]), [-0.1, 0, 1.75])
  B.part('pectoral-fin', fin([0.75, -0.27, 0.85], [0.25, -0.62, 0.62], 0.28, [0, 0, 1]), [0.35, -0.55, 0.66], 'Pectoral fin', { pivot: [0.75, -0.27, 0.85], axis: [1, 0, 0] })
  B.part('pelvic-fin', fin([0.2, -0.12, 0.58], [-0.15, -0.3, 0.32], 0.2, [0, -1, 0.3]), [-0.05, -0.25, 0.38])
  B.part('anal-fin', fin([-0.55, 0, 0.72], [-1.0, 0, 0.5], 0.28, [0, -1, 0]), [-0.85, 0, 0.55])
  B.part('eye', [sphere([1.22, -0.2, 1.12], 0.09, material('#111111', { finish: 'glossy' })), sphere([1.215, -0.17, 1.12], 0.115, org('#d9d2b8'))], [1.24, -0.27, 1.14])
  B.part('gill-cover', tube([[0.92, -0.3, 1.32], [0.82, -0.33, 1.0], [0.92, -0.29, 0.7]], 0.02, org('#2b4a63')), [0.83, -0.34, 1.0], 'Gill cover (operculum)')
  const line = []
  for (let i = 0; i <= 12; i++) {
    const x = 0.85 - (i / 12) * 2.1
    const half = 0.31 * Math.sin(Math.PI * Math.min(1, (x + 1.4) / 3.0)) + 0.06
    line.push([x, -half - 0.005, 1.08 - (i / 12) * 0.08])
  }
  B.part('lateral-line', tube(line, 0.01, org('#1f3a52'), { caps: false }), line[6])
  B.spot('mouth', [1.6, 0, 0.98])
  B.paths.water = [[2.2, 0, 0.98], [1.6, 0, 0.98], [1.1, 0, 0.98], [0.85, -0.25, 0.95], [0.5, -0.7, 0.9]]
  return B
}

// ---------------------------------------------------------------- bird (head toward +x, wings along y)

function bird({ color = '#7a5c3e', belly = '#e8d8bf' } = {}) {
  const B = builder()
  const wingC = '#6b4f35'
  B.part('body', bodyMesh([[1.55, 0, 1.95], [1.25, 0, 1.85], [0.8, 0, 1.6], [0, 0, 1.45], [-0.8, 0, 1.45], [-1.2, 0, 1.5]], [0.45, 0.5, 0.65, 0.78, 0.5, 0.25], [0.45, 0.48, 0.7, 0.82, 0.5, 0.18], color, belly), [0.1, -0.42, 1.3])
  B.spot('head', [1.5, -0.25, 2.1])
  B.part('beak', cone([1.72, 0, 1.93], [2.12, 0, 1.87], 0.09, org('#e0a030')), [2.05, 0, 1.9])
  B.part('eyes', [sphere([1.62, 0.17, 2.02], 0.05, material('#111111', { finish: 'glossy' })), sphere([1.62, -0.17, 2.02], 0.05, material('#111111', { finish: 'glossy' }))], [1.63, -0.2, 2.03], 'Eye')
  for (const s of [1, -1]) {
    const side = s > 0 ? 'left' : 'right'
    const pieces = [leaf([0.45, s * 0.28, 1.65], [-0.35, s * 2.1, 1.75], { width: 0.95, color: wingC, normal: [0, 0, 1], curl: 0.08, fold: 0.04 })]
    for (let k = 0; k < 4; k++) {
      pieces.push(leaf([-0.05 - k * 0.12, s * 1.55, 1.72], [-0.75 - k * 0.18, s * (2.35 - k * 0.12), 1.72], { width: 0.2, color: k % 2 ? '#4e3a27' : '#5a432e', normal: [0, 0, 1], curl: 0.02, rib: true }))
    }
    B.part(`${side}-wing`, pieces, [0.0, s * 1.3, 1.72], `${side === 'left' ? 'Left' : 'Right'} wing`, { pivot: [0.4, s * 0.3, 1.66], axis: [1, 0, 0], sign: s })
  }
  B.spot('primary-feathers', [-0.85, -2.2, 1.72], 'Primary (flight) feathers')
  const tail = []
  for (let k = -2; k <= 2; k++) tail.push(leaf([-1.05, 0, 1.5], [-1.95, k * 0.22, 1.45], { width: 0.24, color: '#5d432c', normal: [0, 0, 1], curl: -0.05 }))
  B.part('tail-feathers', tail, [-1.8, -0.35, 1.47])
  const legs = []
  for (const s of [1, -1]) {
    legs.push(tube([[0.15, s * 0.15, 1.12], [0.05, s * 0.16, 0.85], [0.15, s * 0.16, 0.55]], [0.04, 0.03, 0.025], org('#c98a3a')))
    for (const toe of [[0.45, s * 0.2], [0.4, s * 0.05], [-0.1, s * 0.16]]) legs.push(tube([[0.15, s * 0.16, 0.55], [toe[0], toe[1], 0.5]], 0.018, org('#c98a3a')))
  }
  B.part('legs', legs, [0.1, -0.16, 0.8])
  B.spot('breast-muscles', [0.9, -0.2, 1.3], 'Breast (flight) muscles')
  B.paths['air-over-wing'] = [[1.4, -1.2, 1.7], [0.6, -1.2, 1.95], [-0.2, -1.2, 1.92], [-1.4, -1.2, 1.6]]
  B.paths['air-under-wing'] = [[1.4, -1.2, 1.55], [0.4, -1.2, 1.55], [-0.4, -1.2, 1.6], [-1.4, -1.2, 1.55]]
  return B
}

// ---------------------------------------------------------------- insect (butterfly or bee; head toward +x)

function insect({ type = 'butterfly' } = {}) {
  const B = builder()
  const bee = type === 'bee'
  const dark = '#2b2420'
  B.part('head', sphere([1.0, 0, 1.5], 0.2, org(bee ? dark : '#3a2f28')), [1.05, -0.12, 1.66])
  B.part('compound-eyes', [sphere([1.08, 0.15, 1.56], 0.1, material('#1a1a1a', { finish: 'glossy' })), sphere([1.08, -0.15, 1.56], 0.1, material('#1a1a1a', { finish: 'glossy' }))], [1.1, -0.24, 1.58])
  B.part('thorax', ellipsoid([0.55, 0, 1.5], [0.3, 0.24, 0.24], org(bee ? '#c99a2e' : '#4a3a30')), [0.55, -0.24, 1.62])
  const abd = bodyGeometry([[0.25, 0, 1.5], [-0.25, 0, 1.45], [-1.05, 0, 1.33]], [0.32, 0.46, 0.12], [0.32, 0.42, 0.12], { color: '#444444' })
  // stripes for a bee, plain for a butterfly
  paintGeometry(abd, (x) => (bee ? (Math.floor((x + 2) * 4.2) % 2 ? '#f2b705' : dark) : '#3d3029'))
  B.part('abdomen', new THREE.Mesh(abd, org('#ffffff', 1, { vertexColors: true })), [-0.5, -0.24, 1.38])
  const ant = []
  for (const s of [1, -1]) {
    ant.push(tube([[1.12, s * 0.07, 1.66], [1.35, s * 0.2, 2.0], [1.6, s * 0.38, 2.25]], 0.014, org(dark)))
    if (!bee) ant.push(sphere([1.6, s * 0.38, 2.25], 0.04, org(dark)))
  }
  B.part('antennae', ant, [1.45, -0.27, 2.1])
  const legs = []
  for (const [x, dx] of [[0.72, 0.25], [0.55, 0], [0.38, -0.25]]) {
    for (const s of [1, -1]) legs.push(tube([[x, s * 0.12, 1.34], [x + dx * 0.5, s * 0.55, 1.25], [x + dx, s * 0.72, 0.72]], [0.03, 0.022, 0.016], org(dark)))
  }
  B.part('legs', legs, [0.8, -0.65, 0.95], 'Legs (6, on the thorax)')
  const wingCol = bee ? '#dfe9f3' : '#f28c28', wingCol2 = bee ? '#e6eef6' : '#e0701b', op = bee ? 0.45 : 0.96
  for (const s of [1, -1]) {
    B.part(s > 0 ? 'left-forewing' : 'right-forewing', leaf([0.62, s * 0.18, 1.62], bee ? [-0.2, s * 1.25, 1.9] : [0.35, s * 1.95, 2.05], { width: bee ? 0.5 : 1.25, color: wingCol, normal: [0, 0, 1], curl: 0.05, fold: 0.02, opacity: op, rib: bee }), [0.4, s * 1.2, 1.9], 'Forewing', { pivot: [0.6, s * 0.18, 1.62], axis: [1, 0, 0], sign: s })
    B.part(s > 0 ? 'left-hindwing' : 'right-hindwing', leaf([0.45, s * 0.18, 1.55], bee ? [-0.35, s * 0.85, 1.7] : [-0.6, s * 1.45, 1.6], { width: bee ? 0.35 : 1.0, color: wingCol2, normal: [0, 0, 1], curl: 0.03, fold: 0.02, opacity: op, rib: bee }), [-0.3, s * 0.9, 1.62], 'Hindwing', { pivot: [0.45, s * 0.18, 1.55], axis: [1, 0, 0], sign: s })
  }
  if (bee) {
    B.part('stinger', cone([-1.05, 0, 1.33], [-1.3, 0, 1.3], 0.03, org(dark)), [-1.25, 0, 1.3])
  } else {
    const coil = []
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 4, r = 0.12 * (1 - i / 48)
      coil.push([1.16 + r * Math.sin(a) * 0.4, 0, 1.33 - r * Math.cos(a)])
    }
    B.part('proboscis', tube(coil, 0.012, org(dark), { caps: false }), [1.2, -0.05, 1.22], 'Proboscis (feeding tube)')
  }
  return B
}

// ---------------------------------------------------------------- chemistry: molecule (water, methane, benzene, carbon dioxide)

function molecule({ type = 'water' } = {}) {
  const B = builder()
  const kind = String(type).toLowerCase()

  if (kind === 'methane') {
    const cPos = [0, 0, 1.8]
    B.part('carbon', sphere(cPos, 0.42, material('#333333', { finish: 'glossy' })), [0, -0.45, 1.95], 'Carbon (C)')
    const hRel = [
      [0.72, 0.72, 0.72],
      [0.72, -0.72, -0.72],
      [-0.72, 0.72, -0.72],
      [-0.72, -0.72, 0.72],
    ]
    const hMeshes = [], bonds = []
    hRel.forEach(([dx, dy, dz], i) => {
      const pos = [cPos[0] + dx, cPos[1] + dy, cPos[2] + dz]
      hMeshes.push(sphere(pos, 0.25, material('#f5f5f5', { finish: 'glossy' })))
      bonds.push(tube([cPos, pos], 0.065, material('#94a3b8', { finish: 'glossy' })))
      B.spot(`hydrogen-${i + 1}`, pos, `Hydrogen ${i + 1} (H)`)
    })
    B.part('hydrogens', hMeshes, [0.72, -0.72, 1.08], 'Hydrogens (4 × H)')
    B.part('covalent-bonds', bonds, [0.36, -0.36, 1.44], 'Covalent bonds (109.5° tetrahedral)')
    B.paths['electron-density'] = [
      [cPos[0] + hRel[0][0], cPos[1] + hRel[0][1], cPos[2] + hRel[0][2]],
      cPos,
      [cPos[0] + hRel[1][0], cPos[1] + hRel[1][1], cPos[2] + hRel[1][2]],
      cPos,
      [cPos[0] + hRel[2][0], cPos[1] + hRel[2][1], cPos[2] + hRel[2][2]],
      cPos,
      [cPos[0] + hRel[3][0], cPos[1] + hRel[3][1], cPos[2] + hRel[3][2]],
    ]
  } else if (kind === 'benzene') {
    const R = 1.3, cPos = [0, 0, 1.8]
    const carbons = [], hydrogens = [], bonds = []
    const cCoords = [], hCoords = []
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      const cx = Math.cos(a) * R, cy = Math.sin(a) * R
      const hx = Math.cos(a) * (R + 0.9), hy = Math.sin(a) * (R + 0.9)
      cCoords.push([cx, cy, cPos[2]])
      hCoords.push([hx, hy, cPos[2]])
      carbons.push(sphere([cx, cy, cPos[2]], 0.32, material('#333333', { finish: 'glossy' })))
      hydrogens.push(sphere([hx, hy, cPos[2]], 0.22, material('#f5f5f5', { finish: 'glossy' })))
      bonds.push(tube([[cx, cy, cPos[2]], [hx, hy, cPos[2]]], 0.05, material('#94a3b8', { finish: 'glossy' })))
    }
    for (let i = 0; i < 6; i++) {
      const next = (i + 1) % 6
      bonds.push(tube([cCoords[i], cCoords[next]], 0.07, material('#94a3b8', { finish: 'glossy' })))
    }
    B.part('carbons', carbons, [R, 0, cPos[2] + 0.3], 'Carbon ring (6 × C)')
    B.part('hydrogens', hydrogens, [R + 0.9, 0, cPos[2] + 0.3], 'Hydrogens (6 × H)')
    B.part('bonds', bonds, [R * 0.5, R * 0.86, cPos[2]], 'Aromatic C-C and C-H bonds')

    // Delocalized pi electron rings above and below
    const piCloud = []
    for (const dz of [0.35, -0.35]) {
      const pts = []
      for (let i = 0; i <= 24; i++) {
        const a = (i / 24) * Math.PI * 2
        pts.push([Math.cos(a) * (R * 0.85), Math.sin(a) * (R * 0.85), cPos[2] + dz])
      }
      piCloud.push(tube(pts, 0.12, material('#a855f7', { finish: 'glass', opacity: 0.45 }), { closed: true }))
    }
    B.part('pi-cloud', piCloud, [0, 0, cPos[2] + 0.45], 'Delocalized π-electron cloud')
    B.paths['electron-density'] = cCoords
  } else if (kind === 'carbon-dioxide') {
    const cPos = [0, 0, 1.8]
    B.part('carbon', sphere(cPos, 0.38, material('#333333', { finish: 'glossy' })), [0, -0.4, 1.95], 'Carbon (C)')
    const oLeft = [-1.4, 0, 1.8], oRight = [1.4, 0, 1.8]
    B.part('oxygen-1', sphere(oLeft, 0.34, material('#e03131', { finish: 'glossy' })), [-1.4, -0.35, 1.9], 'Oxygen 1 (O)')
    B.part('oxygen-2', sphere(oRight, 0.34, material('#e03131', { finish: 'glossy' })), [1.4, -0.35, 1.9], 'Oxygen 2 (O)')
    const bonds = [
      tube([[-1.3, 0.08, 1.8], [-0.1, 0.08, 1.8]], 0.045, material('#94a3b8', { finish: 'glossy' })),
      tube([[-1.3, -0.08, 1.8], [-0.1, -0.08, 1.8]], 0.045, material('#94a3b8', { finish: 'glossy' })),
      tube([[0.1, 0.08, 1.8], [1.3, 0.08, 1.8]], 0.045, material('#94a3b8', { finish: 'glossy' })),
      tube([[0.1, -0.08, 1.8], [1.3, -0.08, 1.8]], 0.045, material('#94a3b8', { finish: 'glossy' })),
    ]
    B.part('double-bonds', bonds, [0.7, 0.1, 1.8], 'Linear double bonds (180°)')
  } else {
    // Default: Water molecule (H2O, bent 104.5°)
    const oPos = [0, 0, 1.8]
    B.part('oxygen', sphere(oPos, 0.42, material('#e03131', { finish: 'glossy' })), [0, -0.45, 1.95], 'Oxygen (O)')
    const h1Pos = [0.85, 0, 1.15], h2Pos = [-0.85, 0, 1.15]
    B.part('hydrogen-1', sphere(h1Pos, 0.26, material('#f5f5f5', { finish: 'glossy' })), [0.85, -0.3, 1.25], 'Hydrogen 1 (H)')
    B.part('hydrogen-2', sphere(h2Pos, 0.26, material('#f5f5f5', { finish: 'glossy' })), [-0.85, -0.3, 1.25], 'Hydrogen 2 (H)')
    const bonds = [
      tube([oPos, h1Pos], 0.07, material('#94a3b8', { finish: 'glossy' })),
      tube([oPos, h2Pos], 0.07, material('#94a3b8', { finish: 'glossy' })),
    ]
    B.part('covalent-bonds', bonds, [0.42, 0, 1.48], 'Covalent O-H bonds (104.5°)')
    // Lone electron pair clouds
    const lonePairs = [
      ellipsoid([0, 0.75, 2.35], [0.28, 0.38, 0.28], material('#60a5fa', { finish: 'glass', opacity: 0.45 })),
      ellipsoid([0, -0.75, 2.35], [0.28, 0.38, 0.28], material('#60a5fa', { finish: 'glass', opacity: 0.45 })),
    ]
    B.part('lone-pairs', lonePairs, [0, -0.8, 2.45], 'Lone electron pairs (repels bonds)')
    B.paths['dipole-moment'] = [h1Pos, oPos, [0, 0, 2.5], oPos, h2Pos]
  }

  return B
}

// ---------------------------------------------------------------- physics/chemistry: atom (Bohr model & electron shells)

function atom({ element = 'lithium' } = {}) {
  const B = builder()
  const center = [0, 0, 1.8]

  // Nucleus: cluster of protons (red) and neutrons (blue)
  const nucleons = []
  const nCoords = [
    [0, 0, 0], [0.15, 0.12, 0.1], [-0.14, 0.14, -0.1], [0.12, -0.15, -0.1],
    [-0.15, -0.12, 0.12], [0, 0.18, 0], [0, -0.18, 0],
  ]
  nCoords.forEach(([dx, dy, dz], i) => {
    const isProton = i % 2 === 0
    const col = isProton ? '#e03131' : '#3b82f6'
    nucleons.push(sphere([center[0] + dx, center[1] + dy, center[2] + dz], 0.14, material(col, { finish: 'glossy' })))
  })
  B.part('nucleus', nucleons, [0, -0.3, 1.95], 'Nucleus (Protons + Neutrons)')

  // Electron shells (n=1 and n=2)
  const shells = [], electrons = []
  const makeRing = (r, tiltX, tiltY) => {
    const pts = []
    const N = 36
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2
      const x = Math.cos(a) * r
      const y = Math.sin(a) * r * Math.cos(tiltX)
      const z = Math.sin(a) * r * Math.sin(tiltX)
      pts.push([center[0] + x, center[1] + y, center[2] + z])
    }
    return pts
  }

  const ring1 = makeRing(0.95, 0.4, 0)
  const ring2 = makeRing(1.65, -0.55, 0)
  const ring3 = makeRing(1.65, 0.75, 0)
  shells.push(tube(ring1, 0.015, material('#93c5fd', { finish: 'standard', opacity: 0.7 }), { closed: true }))
  shells.push(tube(ring2, 0.015, material('#93c5fd', { finish: 'standard', opacity: 0.7 }), { closed: true }))
  shells.push(tube(ring3, 0.015, material('#93c5fd', { finish: 'standard', opacity: 0.7 }), { closed: true }))
  B.part('electron-shells', shells, [1.65, 0, 1.8], 'Quantized electron shells (n=1, n=2)')

  // Electrons along the rings
  electrons.push(sphere(ring1[0], 0.09, material('#fbbf24', { finish: 'glossy' })))
  electrons.push(sphere(ring1[18], 0.09, material('#fbbf24', { finish: 'glossy' })))
  electrons.push(sphere(ring2[9], 0.09, material('#fbbf24', { finish: 'glossy' })))
  B.part('electrons', electrons, [ring2[9][0] + 0.15, ring2[9][1], ring2[9][2]], 'Electrons (e⁻ in orbitals)')

  B.paths['electron-orbit'] = ring2
  return B
}

// ---------------------------------------------------------------- physics: magnet (dipole & 3D magnetic field lines)

function magnet() {
  const B = builder()
  const center = [0, 0, 1.8]

  // North pole (red) and South pole (blue)
  const nMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.7, 0.5),
    material('#e03131', { finish: 'glossy' }),
  )
  nMesh.position.copy(v([center[0], center[1] - 0.4, center[2]]))
  B.part('north-pole', nMesh, [center[0], center[1] - 0.78, center[2]], 'North pole (N)')

  const sMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.7, 0.5),
    material('#2563eb', { finish: 'glossy' }),
  )
  sMesh.position.copy(v([center[0], center[1] + 0.4, center[2]]))
  B.part('south-pole', sMesh, [center[0], center[1] + 0.78, center[2]], 'South pole (S)')

  // 3D Magnetic field lines looping from North to South in multiple planes
  const fieldLines = []
  const mainLoop = []
  const angles = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]
  angles.forEach((theta, idx) => {
    for (const rad of [1.2, 1.85]) {
      const pts = []
      const N = 32
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * Math.PI * 2
        // Elliptical dipole field lines looping along Y from N to S
        const y = center[1] + Math.sin(t) * (rad * 0.95)
        const radOut = rad * (1.1 - 0.5 * Math.sin(t) ** 2)
        const x = center[0] + Math.cos(t) * radOut * Math.cos(theta)
        const z = center[2] + Math.cos(t) * radOut * Math.sin(theta)
        pts.push([x, y, z])
      }
      if (idx === 0 && rad === 1.2) mainLoop.push(...pts)
      fieldLines.push(tube(pts, 0.016, material('#a855f7', { finish: 'glossy', opacity: 0.8 }), { closed: true }))
    }
  })
  B.part('field-lines', fieldLines, [1.5, 0, 1.8], 'Magnetic flux lines (B-field: N ➔ S)')
  B.paths['magnetic-flux'] = mainLoop
  return B
}

// ---------------------------------------------------------------- chemistry: crystal (NaCl FCC lattice)

function crystal() {
  const B = builder()
  const center = [0, 0, 1.8]
  const d = 0.8
  const naIons = [], clIons = [], bonds = []

  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        const isNa = (Math.abs(x) + Math.abs(y) + Math.abs(z)) % 2 === 0
        const pt = [center[0] + x * d, center[1] + y * d, center[2] + z * d]
        if (isNa) {
          naIons.push(sphere(pt, 0.16, material('#a855f7', { finish: 'glossy' })))
        } else {
          clIons.push(sphere(pt, 0.22, material('#22c55e', { finish: 'glossy' })))
        }

        // Bonds along grid lines
        if (x < 1) bonds.push(tube([pt, [pt[0] + d, pt[1], pt[2]]], 0.035, material('#cbd5e1')))
        if (y < 1) bonds.push(tube([pt, [pt[0], pt[1] + d, pt[2]]], 0.035, material('#cbd5e1')))
        if (z < 1) bonds.push(tube([pt, [pt[0], pt[1], pt[2] + d]], 0.035, material('#cbd5e1')))
      }
    }
  }

  B.part('sodium-ions', naIons, [center[0] + d, center[1] + d, center[2] + d + 0.2], 'Sodium ions (Na⁺)')
  B.part('chloride-ions', clIons, [center[0] + d, center[1], center[2] + d + 0.2], 'Chloride ions (Cl⁻)')
  B.part('ionic-bonds', bonds, [center[0], center[1] - d, center[2]], 'Ionic crystal lattice (FCC)')
  return B
}

// ---------------------------------------------------------------- physics: pendulum (harmonic motion)

function pendulum() {
  const B = builder()
  const pivot = [0, 0, 3.2]
  const bob = [0.95, 0, 1.3]

  B.part('pivot', [sphere(pivot, 0.12, material('#475569', { finish: 'metal' })), cone([pivot[0], pivot[1], pivot[2] + 0.3], pivot, 0.25, material('#64748b'))], pivot, 'Fixed pivot')
  B.part('rod', tube([pivot, bob], 0.032, material('#94a3b8', { finish: 'metal' })), [0.48, 0, 2.25], 'Pendulum arm (length L)')
  B.part('bob', sphere(bob, 0.32, material('#eab308', { finish: 'metal' })), [bob[0] + 0.35, bob[1], bob[2]], 'Bob mass (m)')

  // Physical vectors
  // Velocity vector (tangential, green)
  const vArrow = tube([bob, [bob[0] - 0.65, bob[1], bob[2] + 0.48]], 0.04, material('#22c55e', { finish: 'glossy' }))
  B.part('velocity-vector', vArrow, [bob[0] - 0.65, 0, bob[2] + 0.52], 'Velocity vector (v)')

  // Gravity vector (downward, red)
  const gArrow = tube([bob, [bob[0], bob[1], bob[2] - 0.85]], 0.04, material('#ef4444', { finish: 'glossy' }))
  B.part('gravity-vector', gArrow, [bob[0] + 0.1, 0, bob[2] - 0.88], 'Gravity force (F_g = mg)')

  // Restoring force (towards equilibrium, blue)
  const rArrow = tube([bob, [bob[0] - 0.55, bob[1], bob[2] + 0.05]], 0.04, material('#3b82f6', { finish: 'glossy' }))
  B.part('restoring-force', rArrow, [bob[0] - 0.58, 0, bob[2] + 0.08], 'Restoring force (F = -mg sin θ)')

  B.paths['swing-trajectory'] = [
    [0.95, 0, 1.3],
    [0.5, 0, 1.15],
    [0, 0, 1.1],
    [-0.5, 0, 1.15],
    [-0.95, 0, 1.3],
  ]
  return B
}

export const MODELS = {
  heart, human, lungs, brain, tree, flower, cell, dna, neuron, eye, fish, bird, insect,
  molecule, atom, magnet, crystal, pendulum,
}

export function buildModel(name, opts = {}) {
  const make = MODELS[String(name ?? '').toLowerCase()]
  return make ? make(opts) : null
}
