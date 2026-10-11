"""Self-check for the offline lesson library.

Run:  python -m lessons.validate

Verifies every lesson against what the renderers actually support, so an
offline lesson can never emit a shape the board or the 3D stage would ignore:

  * every `draw` kind is one board.js handles, every `draw3d` kind one scene3d.js handles
  * the fields each kind needs are present (points, from/to, x/y/w/h, ...)
  * ids used by move/rotate/highlight/opacity/remove/flow were registered earlier
  * model names exist in models3d.js, and so do the parts and routes addressed as "id.part"
  * $...$ maths is balanced and LaTeX braces match
  * the matcher sends each curriculum prompt to its own lesson
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from . import LESSONS, BY_ID, build_events, events_for, match

ROOT = Path(__file__).resolve().parent.parent
MODELS_JS = ROOT / "static" / "models3d.js"
CURRICULUM_JS = ROOT / "static" / "curriculum.js"
INDEX_HTML = ROOT / "static" / "index.html"

BOARD_KINDS = {"text", "math", "rect", "ellipse", "triangle", "diamond", "circle", "line", "arrow",
               "solid3d", "3d", "mesh3d", "plot"}
SCENE_KINDS = {"axes", "point", "sphere", "ellipsoid", "box", "cylinder", "cone", "torus", "plane",
               "polygon", "vector", "line", "circle", "ellipse", "curve", "tube", "blob", "body",
               "lathe", "leaf", "petal", "fin", "model", "surface", "field", "label", "note",
               "camera", "spin", "flow", "move", "rotate", "flap", "pulse", "opacity", "highlight",
               "remove"}

REQUIRED_2D = {
    "text": ("x", "y", "text"),
    "math": ("x", "y", "latex"),
    "rect": ("x", "y", "w", "h"), "ellipse": ("x", "y", "w", "h"),
    "triangle": ("x", "y", "w", "h"), "diamond": ("x", "y", "w", "h"),
    "circle": ("cx", "cy", "r"),
    "line": ("points",), "arrow": ("from", "to"), "plot": ("fn",),
}

# The 3D stage addresses geometry differently: a circle/ellipse lives at `center`.
REQUIRED_3D = {
    "point": ("at",), "sphere": ("center", "r"), "ellipsoid": ("center", "radii"),
    "box": ("center", "size"), "cylinder": ("from", "to", "r"), "cone": ("from", "to", "r"),
    "torus": ("center", "r", "tube"), "plane": ("point", "normal"), "polygon": ("points",),
    "vector": ("from", "to"), "circle": ("center", "r"), "ellipse": ("center",),
    "line": ("points",), "body": ("spine", "width", "height"), "tube": ("points",),
    "field": ("fx", "fy", "fz"), "model": ("name",), "move": ("id",),
    "rotate": ("id", "axis", "angle"), "highlight": ("id",), "opacity": ("id", "value"),
    "remove": ("id",), "pulse": ("id",), "flap": ("id",),
}

ID_ACTIONS = {"move", "rotate", "highlight", "opacity", "remove", "pulse", "flap"}


def _models_catalogue() -> tuple[set[str], dict[str, set[str]], dict[str, set[str]]]:
    """(model names, parts by model, flow routes by model) read out of models3d.js."""
    if not MODELS_JS.exists():
        return set(), {}, {}
    src = MODELS_JS.read_text()
    names = set(re.findall(r"^function (\w+)\(", src, re.M))
    export = re.search(r"export const MODELS = \{([^}]*)\}", src, re.S)
    if export:
        names &= {n.strip() for n in export.group(1).replace("\n", " ").split(",") if n.strip()}
    parts: dict[str, set[str]] = {}
    routes: dict[str, set[str]] = {}
    for name in names:
        m = re.search(rf"^function {name}\(.*?^\}}", src, re.M | re.S)
        body = m.group(0) if m else ""
        parts[name] = set(re.findall(r"B\.part\(\s*'([^']+)'", body))
        routes[name] = set(re.findall(r"B\.paths\[\s*'([^']+)'\s*\]", body))
    return names, parts, routes


def _check_latex(text: str, where: str, errors: list[str]) -> None:
    if text.count("$") % 2:
        errors.append(f"{where}: unbalanced $ in {text[:60]!r}")
    for chunk in re.findall(r"\$([^$]*)\$", text):
        if chunk.count("{") != chunk.count("}"):
            errors.append(f"{where}: unbalanced braces in ${chunk[:50]}$")
        if re.search(r"(?<!\\)\\$", chunk):
            errors.append(f"{where}: dangling backslash in ${chunk[:50]}$")


def validate_shape(shape: dict, where: str, errors: list[str], surface: str) -> None:
    kind = shape.get("kind")
    allowed = BOARD_KINDS if surface == "draw" else SCENE_KINDS
    if kind not in allowed:
        errors.append(f"{where}: unsupported {surface} kind {kind!r}")
        return
    required = (REQUIRED_2D if surface == "draw" else REQUIRED_3D).get(kind, ())
    for field in required:
        if shape.get(field) in (None, "", []):
            errors.append(f"{where}: {kind} is missing '{field}'")
    if kind == "note" and not (shape.get("latex") or shape.get("text")):
        errors.append(f"{where}: note needs latex or text")
    if kind == "label" and not (shape.get("target") or (shape.get("at") and (shape.get("text") or shape.get("latex")))):
        errors.append(f"{where}: label needs a target, or at + text/latex")
    if kind == "curve" and not (shape.get("points") or (shape.get("x") and shape.get("y") and shape.get("z"))):
        errors.append(f"{where}: curve needs points, or x/y/z in t")
    if kind == "surface" and not (shape.get("fn") or (shape.get("x") and shape.get("y") and shape.get("z"))):
        errors.append(f"{where}: surface needs fn, or x/y/z in u,v")
    if kind == "flow" and not shape.get("path"):
        errors.append(f"{where}: flow needs a path")
    if kind == "plot" and shape.get("fn"):
        if re.search(r"[{}]", str(shape["fn"])):
            errors.append(f"{where}: plot fn should use math.js syntax, not braces")
    for key in ("latex", "text", "label"):
        if isinstance(shape.get(key), str):
            _check_latex(shape[key], f"{where} {kind}.{key}", errors)


def validate_lesson(lesson: dict) -> list[str]:
    errors: list[str] = []
    names, parts, routes = _models_catalogue()
    lid = lesson["id"]
    if lid not in BY_ID:
        errors.append(f"{lid}: not indexed")
    if lesson.get("mode") not in ("2d", "3d"):
        errors.append(f"{lid}: mode must be 2d or 3d")
    if not lesson.get("steps"):
        errors.append(f"{lid}: has no steps")
    if not lesson.get("checks"):
        errors.append(f"{lid}: has no check")

    for depth in ("basic", "standard", "deep"):
        registered: set[str] = set()
        model_ids: dict[str, str] = {}
        for ev in events_for(lesson, depth):
            if ev["type"] == "step":
                say = ev.get("say", "")
                if not say.strip():
                    errors.append(f"{lid}/{depth}: a step says nothing")
                if len(say) > 600:
                    errors.append(f"{lid}/{depth}: say is {len(say)} chars, the server caps it at 600")
                where = f"{lid}/{depth}/{say[:28]!r}"
                for shape in ev.get("draw", []):
                    validate_shape(shape, where, errors, "draw")
                for shape in ev.get("draw3d", []):
                    validate_shape(shape, where, errors, "draw3d")
                    kind = shape.get("kind")
                    if kind == "model":
                        name = str(shape.get("name", "")).lower()
                        if names and name not in names:
                            errors.append(f"{where}: unknown model {name!r}")
                        mid = str(shape.get("id") or name)
                        registered.add(mid)
                        model_ids[mid] = name
                    elif shape.get("id"):
                        registered.add(str(shape["id"]))
                    if kind in ID_ACTIONS:
                        target = str(shape.get("id", ""))
                        base = target.split(".")[0]
                        if base not in registered:
                            errors.append(f"{where}: '{kind}' targets id {target!r}, which was never drawn")
                        elif "." in target:
                            model = model_ids.get(base)
                            part = target.split(".", 1)[1]
                            if model and parts.get(model) and part not in parts[model]:
                                errors.append(f"{where}: model {model!r} has no part {part!r}")
                    if kind == "flow" and isinstance(shape.get("path"), str):
                        mid, _, route = str(shape["path"]).partition(".")
                        model = model_ids.get(mid)
                        if model and routes.get(model) and route not in routes[model]:
                            errors.append(f"{where}: model {model!r} has no flow route {route!r}")
                    if kind == "label" and isinstance(shape.get("target"), str):
                        base, _, part = shape["target"].partition(".")
                        model = model_ids.get(base)
                        if model and part and parts.get(model) and part not in parts[model]:
                            errors.append(f"{where}: model {model!r} has no part {part!r}")
            elif ev["type"] == "check":
                if len(ev["options"]) < 2:
                    errors.append(f"{lid}/{depth}: check needs at least two options")
                if not 0 <= ev["answer"] < len(ev["options"]):
                    errors.append(f"{lid}/{depth}: answer index out of range")
                for field in ("question", "explain", *ev["options"]):
                    _check_latex(field, f"{lid}/{depth} check", errors)
            elif ev["type"] == "suggest":
                if not ev["items"]:
                    errors.append(f"{lid}/{depth}: suggest has no items")
    return errors


def validate_matching() -> list[str]:
    """Every curriculum card sends its prompt; the matcher must return that same topic."""
    errors: list[str] = []
    if not CURRICULUM_JS.exists():
        return ["static/curriculum.js not found"]
    src = CURRICULUM_JS.read_text()
    # (?:(?!id: ').)*? keeps a match inside one subtopic block, so domain headings
    # (which have an id but no mode/prompt of their own) are never picked up.
    pairs = re.findall(
        r"id: '([a-z0-9\-]+)',(?:(?!id: ').)*?mode: '(?:2d|3d)',\s*\n\s*prompt: '(.*?)',",
        src, re.S)
    missing = [topic_id for topic_id, _ in pairs if topic_id not in BY_ID]
    if missing:
        errors.append(f"no offline lesson for curriculum topic(s): {', '.join(missing)}")
    for topic_id, prompt in pairs:
        if topic_id not in BY_ID:
            continue
        hits = match(prompt.replace("\\'", "'"), 1)
        got = hits[0][0]["id"] if hits else None
        if got != topic_id:
            errors.append(f"prompt for {topic_id} matched {got!r} instead: {prompt[:70]!r}")
    return errors


def validate_starter_chips() -> list[str]:
    """The chips on the empty landing page must all have an offline lesson."""
    errors: list[str] = []
    if not INDEX_HTML.exists():
        return ["static/index.html not found"]
    for question in re.findall(r'data-q="([^"]+)"', INDEX_HTML.read_text()):
        hits = match(question, 1)
        if not hits:
            errors.append(f"starter chip has no offline lesson: {question[:60]!r}")
    return errors


def main() -> int:
    errors: list[str] = []
    for lesson in LESSONS:
        errors += validate_lesson(lesson)
    errors += validate_matching()
    errors += validate_starter_chips()
    ids = [l["id"] for l in LESSONS]
    if len(ids) != len(set(ids)):
        errors.append("duplicate lesson ids")
    if errors:
        print(f"{len(errors)} problem(s) in the offline lesson library:\n")
        for e in errors:
            print(f"  - {e}")
        return 1
    total_steps = sum(len(l["steps"]) for l in LESSONS)
    print(f"OK: {len(LESSONS)} offline lessons, {total_steps} authored steps, "
          f"{sum(len(l['checks']) for l in LESSONS)} checks - all events render.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
