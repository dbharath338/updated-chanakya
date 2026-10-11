"""Offline lesson library.

Hand-authored lessons for every curriculum topic, in exactly the same event
protocol the language model emits (docs/LESSON_PROTOCOL.md). The server streams
these whenever the model cannot answer - rate limited, no API key, offline - so
a question always comes back with a lesson instead of an error.

Public API:
    topics()                 -> list of {id, title, mode, subject}
    get(lesson_id)           -> lesson dict or None
    match(question)          -> (lesson, score) best match, score 0 if nothing fits
    related(lesson, n)       -> nearby topic titles, for the "go deeper" chips
    build_events(question, depth) -> list of protocol events for the best match
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher

from .chemistry import CHEMISTRY
from .maths import MATHS
from .physics import PHYSICS

SUBJECT_OF = {"math-": "Mathematics", "phys-": "Physics", "chem-": "Chemistry"}

LESSONS: list[dict] = [*MATHS, *PHYSICS, *CHEMISTRY]
BY_ID: dict[str, dict] = {lesson["id"]: lesson for lesson in LESSONS}

# Depth presets mirror the model's behaviour: basic is a short tour, standard is
# the whole authored lesson, deep dive adds the extra pages and a second check.
DEPTH_STEPS = {"basic": 4, "standard": 99, "deep": 99}
DEPTH_CHECKS = {"basic": 1, "standard": 1, "deep": 2}

_STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "of", "in", "on", "at", "to", "for",
    "and", "or", "with", "how", "what", "why", "when", "where", "which", "do", "does", "did", "can",
    "could", "would", "should", "i", "me", "my", "you", "your", "it", "its", "this", "that", "these",
    "those", "explain", "show", "tell", "give", "please", "about", "into", "from", "by", "as", "us",
    "we", "step", "steps", "way", "some", "any", "all", "not", "no", "yes", "also", "just", "very",
    "get", "make", "makes", "use", "uses", "using", "than", "then", "there", "here", "their",
}

def _stem(word: str) -> str:
    """Very light stemming: enough for plurals and -es, without mangling short words."""
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith(("ses", "xes", "zes", "ches", "shes")) and len(word) > 4:
        return word[:-2]
    if word.endswith("s") and not word.endswith(("ss", "us", "is")) and len(word) > 3:
        return word[:-1]
    return word


# Words that carry subject meaning, so "explain the pythagorean theorem visually" still matches.
def _tokens(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9][a-z0-9+\-./^]*", text.lower())
    kept = {w for w in words if w not in _STOPWORDS and len(w) > 1}
    return kept | {_stem(w) for w in kept}  # both forms, so plurals match singular keywords


def topics() -> list[dict]:
    """The library as a browsable index."""
    return [
        {
            "id": lesson["id"],
            "title": lesson["topic"],
            "mode": lesson["mode"],
            "subject": _subject(lesson["id"]),
            "keywords": lesson.get("keywords", []),
        }
        for lesson in LESSONS
    ]


def _subject(lesson_id: str) -> str:
    for prefix, name in SUBJECT_OF.items():
        if lesson_id.startswith(prefix):
            return name
    return "General"


def get(lesson_id: str) -> dict | None:
    return BY_ID.get(str(lesson_id).strip().lower())


def _score(lesson: dict, question: str, words: set[str]) -> float:
    """Keyword hits dominate; fuzzy title similarity breaks ties and catches typos."""
    text = question.lower()
    score = 0.0
    for kw in lesson.get("keywords", []):
        k = kw.lower()
        if k in text:
            score += 2.0 + 0.5 * (len(k.split()) - 1)  # multi-word phrases are stronger evidence
        else:
            score += sum(1.0 for part in _tokens(k) if part in words) * 0.6
    title = lesson["topic"].lower()
    score += sum(1.5 for part in _tokens(title) if part in words)
    score += sum(1.0 for part in re.split(r"[-_]", lesson["id"]) if part in words and part not in ("math", "phys", "chem"))
    score += SequenceMatcher(None, title, text).ratio() * 1.5
    return score


def match(question: str, limit: int = 4) -> list[tuple[dict, float]]:
    """Ranked matches, best first. Empty list means nothing in the library fits."""
    words = _tokens(question)
    scored = [(lesson, _score(lesson, question, words)) for lesson in LESSONS]
    scored = [(lesson, s) for lesson, s in scored if s >= 2.0]
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return scored[:limit]


def best_match(question: str) -> tuple[dict | None, float]:
    hits = match(question, 1)
    return hits[0] if hits else (None, 0.0)


def related(lesson: dict | None, n: int = 3) -> list[str]:
    """Neighbouring topics, used for the follow-up chips of an offline lesson."""
    if lesson is None:
        return []
    subject = _subject(lesson["id"])
    pool = [l for l in LESSONS if _subject(l["id"]) == subject and l["id"] != lesson["id"]]
    idx = next((i for i, l in enumerate(LESSONS) if l["id"] == lesson["id"]), 0)
    pool.sort(key=lambda l: abs(next(i for i, x in enumerate(LESSONS) if x["id"] == l["id"]) - idx))
    return [l["topic"] for l in pool[:n]]


# ---------- event building ----------

def _steps(lesson: dict, depth: str) -> list[dict]:
    include_deep = depth == "deep"
    limit = DEPTH_STEPS.get(depth, 99)
    out = []
    for step in lesson.get("steps", []):
        if step.get("deep") and not include_deep:
            continue
        out.append(step)
        if len(out) >= limit:
            break
    return out


def _meta(page: dict | None, lesson: dict, first: bool) -> dict:
    src = page or lesson
    return {
        "type": "meta",
        "topic": str(src.get("topic") or lesson["topic"])[:80],
        "mode": "3d" if str(src.get("mode", lesson["mode"])).lower() == "3d" else "2d",
        "clear": bool(src.get("clear", first)),
    }


def events_for(lesson: dict, depth: str = "standard") -> list[dict]:
    """Turn one authored lesson into protocol events (meta/step/check/suggest)."""
    depth = depth if depth in DEPTH_STEPS else "standard"
    events: list[dict] = [_meta(None, lesson, True)]

    for i, step in enumerate(_steps(lesson, depth)):
        if i and step.get("page"):
            events.append(_meta(step["page"], lesson, False))
        ev: dict = {"type": "step", "say": str(step.get("say", ""))[:600]}
        if step.get("draw"):
            ev["draw"] = step["draw"]
        if step.get("draw3d"):
            ev["draw3d"] = step["draw3d"]
        if step.get("camera"):
            ev["camera"] = step["camera"]
        events.append(ev)

    for check in lesson.get("checks", [])[: DEPTH_CHECKS.get(depth, 1)]:
        events.append({"type": "check", **check})

    suggest = list(lesson.get("suggest", []))
    if depth == "deep":
        suggest = suggest[:1] + [f"How is {t} connected to this?" for t in related(lesson, 2)]
    if suggest:
        events.append({"type": "suggest", "items": suggest[:4]})
    return events


def build_events(question: str, depth: str = "standard") -> tuple[list[dict], dict | None]:
    """Events for the question, plus the lesson used (None when nothing matched)."""
    lesson, _ = best_match(question)
    if lesson is None:
        return [], None
    return events_for(lesson, depth), lesson


def no_match_events(question: str) -> list[dict]:
    """A helpful reply when the library has nothing on this question."""
    near = [lesson["topic"] for lesson, _ in match(question, 3)]
    picks = near or [lesson["topic"] for lesson in LESSONS[:3]]
    return [
        {"type": "meta", "topic": "Offline lesson library", "mode": "2d", "clear": True},
        {
            "type": "step",
            "say": "I could not reach the language model, and I do not have a built-in lesson on that exact question yet. "
                   "My offline library covers the curriculum topics, so try one of the suggestions below, or open the Topics Index.",
            "draw": [
                {"kind": "text", "x": 40, "y": 30, "text": "Offline lessons available", "size": "l"},
                {"kind": "text", "x": 40, "y": 120, "text": "The model is unavailable right now.", "size": "m", "color": "grey"},
                {"kind": "text", "x": 40, "y": 160, "text": "Pick a topic from the built-in library:", "size": "m"},
                *[{"kind": "text", "x": 40, "y": 220 + i * 45, "text": f"{i + 1}. {title}", "size": "m", "color": "blue"}
                  for i, title in enumerate(picks[:6])],
                {"kind": "text", "x": 40, "y": 540, "text": f"{len(LESSONS)} topics ready offline, no API needed", "size": "s", "color": "green"},
            ],
        },
        {"type": "suggest", "items": picks[:4]},
    ]


def titles() -> list[str]:
    return [lesson["topic"] for lesson in LESSONS]


def stats() -> dict:
    by_subject: dict[str, int] = {}
    for lesson in LESSONS:
        by_subject[_subject(lesson["id"])] = by_subject.get(_subject(lesson["id"]), 0) + 1
    return {
        "lessons": len(LESSONS),
        "steps": sum(len(l.get("steps", [])) for l in LESSONS),
        "by_subject": by_subject,
    }
