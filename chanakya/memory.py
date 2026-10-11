"""Learner memory: a single local JSON file (no auth, one learner per install)."""

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

MAX_NOTES = 30
DEFAULT = {
    "profile": {"name": "", "level": "", "goal": ""},
    "topics": {},  # topic -> {seen, attempts, correct, last}
    "notes": [],  # [{t, note}]
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class MemoryStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}
        return {**json.loads(json.dumps(DEFAULT)), **data}

    def _save(self, data: dict) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    def update_profile(self, profile: dict) -> dict:
        with self._lock:
            data = self.load()
            for key in DEFAULT["profile"]:
                if key in profile:
                    data["profile"][key] = str(profile[key])[:120]
            self._save(data)
            return data

    def touch_topic(self, topic: str) -> None:
        topic = topic.strip()[:80]
        if not topic:
            return
        with self._lock:
            data = self.load()
            t = data["topics"].setdefault(topic, {"seen": 0, "attempts": 0, "correct": 0})
            t["seen"] += 1
            t["last"] = _now()
            self._save(data)

    def record_answer(self, topic: str, correct: bool) -> dict:
        topic = topic.strip()[:80] or "general"
        with self._lock:
            data = self.load()
            t = data["topics"].setdefault(topic, {"seen": 0, "attempts": 0, "correct": 0})
            t["attempts"] += 1
            t["correct"] += int(bool(correct))
            t["last"] = _now()
            self._save(data)
            return data

    def add_note(self, note: str) -> None:
        note = note.strip()[:300]
        if not note:
            return
        with self._lock:
            data = self.load()
            data["notes"] = (data["notes"] + [{"t": _now(), "note": note}])[-MAX_NOTES:]
            self._save(data)

    def reset(self) -> dict:
        with self._lock:
            data = json.loads(json.dumps(DEFAULT))
            self._save(data)
            return data

    def summary_for_prompt(self) -> str:
        data = self.load()
        p = data["profile"]
        lines = []
        if any(p.values()):
            lines.append(
                f"Name: {p['name'] or 'unknown'} | Level: {p['level'] or 'unknown'} | Goal: {p['goal'] or 'unknown'}"
            )
        weak = [
            (name, t) for name, t in data["topics"].items()
            if t.get("attempts") and t["correct"] / t["attempts"] < 0.6
        ]
        if weak:
            lines.append("Struggling with: " + ", ".join(
                f"{n} ({t['correct']}/{t['attempts']} correct)" for n, t in weak[-8:]
            ))
        strong = [
            n for n, t in data["topics"].items()
            if t.get("attempts", 0) >= 2 and t["correct"] / t["attempts"] >= 0.8
        ]
        if strong:
            lines.append("Comfortable with: " + ", ".join(strong[-8:]))
        if data["notes"]:
            lines.append("Observations from past sessions:")
            lines += [f"- {n['note']}" for n in data["notes"][-8:]]
        return "\n".join(lines) or "New learner, nothing known yet."
