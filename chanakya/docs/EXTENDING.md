# Extending Chanakya

Most improvements come down to two moves: **give the renderer a new capability**, then **tell the tutor about it** in `prompts.py`. The model only uses what the prompt describes.

- [Add a 3D model](#add-a-3d-model)
- [Add a 3D object or action kind](#add-a-3d-object-or-action-kind)
- [Add a 2D shape](#add-a-2d-shape)
- [Add or change a depth level](#add-or-change-a-depth-level)
- [Tuning the tutor's behaviour](#tuning-the-tutors-behaviour)
- [Development tips](#development-tips)

---

## Add a 3D model

Ready-made models give the most reliable results for organic subjects. The language model is good at choosing and labelling a model, and poor at sculpting one from coordinates.

### 1. Write a builder in `static/models3d.js`

A builder returns the result of `builder()`, filled with parts. Work in **math coordinates** (x right, y into the screen, z up, front = −y), at roughly 4 units in size; the scene re-centres and scales it automatically.

```js
// ---------------------------------------------------------------- kidney

function kidney({ color = '#9c3d3d' } = {}) {
  const B = builder()
  // a bean: balls along a curve, melted together
  B.part('cortex', blob({ balls: [[0, 0, 2.6, 0.7], [0.35, 0, 2.0, 0.75], [0.3, 0, 1.3, 0.7], [-0.05, 0, 0.8, 0.6]], squash: [1, 0.6, 1] }, color),
    [0.95, -0.2, 1.9])                                   // anchor: where the label line touches
  B.part('renal-artery', tube([[-0.3, 0, 1.75], [-1.2, 0.05, 1.8]], 0.12, org('#d1342f')), [-1.1, 0, 1.8])
  B.part('renal-vein', tube([[-0.3, -0.12, 1.55], [-1.2, -0.15, 1.5]], 0.13, org('#3d5fc4')), [-1.1, -0.15, 1.5])
  B.part('ureter', tube([[-0.25, 0, 1.4], [-0.4, 0, 0.6], [-0.35, 0, -0.4]], [0.09, 0.06, 0.05], org('#e8c06a')), [-0.4, 0, 0.2])
  B.spot('hilum', [-0.25, -0.1, 1.6])                    // a named point without its own mesh
  B.paths.urine = [[-0.2, 0, 1.6], [-0.4, 0, 0.6], [-0.35, 0, -0.4]]   // route for the "flow" action
  return B
}
```

Then register it:

```js
export const MODELS = { heart, human, ..., insect, kidney }
```

**Builder API**

| Call | Meaning |
|---|---|
| `B.part(name, meshOrList, anchor, label?, hinge?)` | A named, targetable part. `anchor` is the label point. `label` defaults to the name in title case. `hinge = {pivot, axis, sign}` makes it swing for `flap` and rotate about the joint |
| `B.spot(name, anchor, label?)` | A named point (labelled, or highlighted with a glowing marker) |
| `B.paths[name] = [[x,y,z], ...]` | A flow route in model space |

**Helpers available in `models3d.js`** (from `kit3d.js` or local):

| Helper | Use |
|---|---|
| `org(color, opacity?)` | Organic-looking material (also `material(color, {finish, opacity})`) |
| `blob({balls, segs, smooth, wrinkle, squash, colors}, color, opacity?)` | Metaball shape (organs, fruit, bodies) |
| `bodyMesh(spine, widths, heights, color, belly)` | Streamlined body lofted along a spine (animals) |
| `tube(points, radii, material, {caps, radial})` | Tapered tube (vessels, limbs, stems) |
| `lathe(profile, material, {base})` | Surface of revolution |
| `ellipsoid(center, radii, material, rotate?)` | Ellipsoid |
| `leaf(base, tip, {width, color, curl, fold, normal, shape, rib, opacity})` | Leaf, petal, fin or wing |
| `sphere(center, r, material)`, `cone(from, to, r, material)` | Basics |
| `branches(out, start, dir, {...})` | Random branching (roots, dendrites, bronchioles) |
| `paintGeometry(geo, (x,y,z) => color)` | Colour regions (lobes, stripes, layers) |
| `rng(seed)` | Deterministic randomness, so the model looks the same every time |

### 2. Check it in the browser console

```js
chanakya.play({type:'meta', mode:'3d', clear:true, topic:'Kidney'})
chanakya.play({type:'step', say:'A kidney.', draw3d:[{kind:'model', name:'kidney', labels:true}]})
chanakya.play({type:'step', say:'Urine.', draw3d:[{kind:'flow', path:'kidney.urine', color:'#e8c06a'}]})
```

Orbit around it and check that the anchors sit on the right spots and the labels read well.

### 3. Teach the tutor

In `prompts.py`, add a line to the model catalogue (under "Models and their parts"):

```
- kidney: cortex, renal-artery, renal-vein, ureter, hilum. Flow path: urine.
```

Restart the server (`prompts.py` is read at start-up) and ask about the subject.

---

## Add a 3D object or action kind

1. **Renderer:** add a `case 'yourkind':` to `Scene3D.draw()` in `static/scene3d.js`. Build a `THREE.Object3D` in math coordinates (use `v()` for points and `material()` for materials), then call `await this.add(s, obj, entrance, budget, signal)`. `add` applies `rotate`, registers the `id`, attaches `label`/`latex` and plays the entrance (`pop`, `fade` or your own animation, built with `animate(ms, signal, t => ...)`). If the geometry is built in absolute coordinates, wrap it with `centered(obj)` so moves and rotations pivot on its centre.
2. **Actions** usually resolve their target with `this.resolve(s.id)`, which returns `{obj, anchor, model}`.
3. **Prompt:** describe the new kind in the "3D scene" section of `prompts.py` with a one-line example. If it is easy to misuse, add it to an example lesson.
4. **Server:** nothing to do. `draw3d` items pass through `clean_event` (top-level `latex` fields are repaired; at most 14 items per step).

## Add a 2D shape

Add a `case` to `Board.drawShape()` in `static/board.js` (tldraw shapes, or a custom `ShapeUtil` like `MathShapeUtil`), then document it in the "2D whiteboard" section of `prompts.py`.

## Add or change a depth level

1. `prompts.py` → `DEPTHS`: name and rules (step count, structure, number of checks).
2. `server.py` → `DEPTH_SETTINGS`: token budget and reasoning effort.
3. `static/index.html` → a button in `#depth-switch` with `data-depth="yourlevel"`.

## Tuning the tutor's behaviour

The tutor's behaviour lives almost entirely in `prompts.py`:

- **Examples matter most.** The model copies the shape of Examples A-D closely. If it keeps making a mistake, add or adjust a short example rather than another rule.
- Keep rules concrete: "label each part only once" works better than "avoid clutter".
- Correctness rules belong next to the thing they govern (see the coordinate-correctness line under "Teaching style").
- After editing, restart the server and test the same question at several depths.

Other knobs: `GROQ_REASONING_EFFORT` (quality versus latency), `temperature` in `lesson_stream()` (0.5), and the history limits `MAX_HISTORY_MESSAGES` / `MAX_HISTORY_CHARS` in `server.py`.

## Development tips

- **No build step.** Edit a file and reload the page. Static files are served with `Cache-Control: no-cache`.
- **Restart the server** after changing any `.py` file.
- **Console handles:** `chanakya.play(event)`, `chanakya.ask(question)`, `chanakya.scene`, `chanakya.board`, `chanakya.setView('3d')`.
- **Debugging a lesson:** capture what the model sent with `curl -N` against `/api/lesson` (see [API.md](API.md)), then replay individual events with `chanakya.play`.
- **Renderer warnings** appear in the browser console with a `[scene3d]` or `[board]` prefix, for example unknown kinds or missing label targets. A failing shape is skipped; the lesson keeps going.
- **Library versions** are pinned in the import map in `static/index.html` (three.js 0.169.0, tldraw 3.15.6, KaTeX 0.16.11, math.js 13.2.0, Lucide 0.469.0).
