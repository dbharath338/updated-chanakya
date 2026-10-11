"""End-to-end tests for the lesson pipeline's failure handling.

Reproduces the real Groq 429 (tokens-per-day exhausted) and checks that a lesson
still comes back, with a friendly notice instead of a raw provider error.

Run:  python tests/test_lesson_fallback.py     (no pytest needed)
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx

import server
from server import LessonRequest, lesson_stream

RATE_LIMIT_BODY = {
    "error": {
        "message": "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` "
                   "service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 197363, "
                   "Requested 7531. Please try again in 35m14.208s. Need more tokens? Upgrade to "
                   "Dev Tier today at https://console.groq.com/settings/billing",
        "type": "tokens",
        "code": "rate_limit_exceeded",
    }
}


def rate_limit_error(model: str = "openai/gpt-oss-120b"):
    from groq import RateLimitError

    request = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    response = httpx.Response(429, request=request, json=RATE_LIMIT_BODY)
    message = RATE_LIMIT_BODY["error"]["message"].replace("gpt-oss-120b", model.split("/")[-1])
    return RateLimitError(message, response=response, body=RATE_LIMIT_BODY)


class FakeCompletions:
    """Stands in for groq.chat.completions: raises, or yields a canned lesson."""

    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.calls: list[str] = []

    async def create(self, *, model, **kwargs):
        self.calls.append(model)
        outcome = self.behaviour(model)
        if isinstance(outcome, Exception):
            raise outcome
        return FakeStream(outcome)


class FakeStream:
    def __init__(self, chunks):
        self.chunks = chunks

    def __aiter__(self):
        async def gen():
            for text in self.chunks:
                yield FakeChunk(text)
        return gen()


class FakeChunk:
    def __init__(self, text):
        self.choices = [type("C", (), {"delta": type("D", (), {"content": text})()})]


class FakeGroq:
    def __init__(self, behaviour):
        self.completions = FakeCompletions(behaviour)
        self.chat = type("Chat", (), {"completions": self.completions})()


def collect(events: list[dict]) -> dict:
    """Summarise a streamed lesson."""
    return {
        "types": [e["type"] for e in events],
        "notices": [e["message"] for e in events if e["type"] == "notice"],
        "errors": [e["message"] for e in events if e["type"] == "error"],
        "steps": [e for e in events if e["type"] == "step"],
        "topic": next((e["topic"] for e in events if e["type"] == "meta"), None),
    }


async def run(question: str, behaviour, depth: str = "standard") -> tuple[dict, float, list[str]]:
    """Drive lesson_stream with a fake provider; return (summary, seconds, models called)."""
    fake = FakeGroq(behaviour)
    original_client, original_flag = server.groq, server.LLM_ENABLED
    server.groq, server.LLM_ENABLED = fake, True
    try:
        started = time.monotonic()
        events = []
        async for line in lesson_stream(LessonRequest(question=question, depth=depth)):
            ev = json.loads(line)
            if ev["type"] != "done":
                events.append(ev)
        return collect(events), time.monotonic() - started, fake.completions.calls
    finally:
        server.groq, server.LLM_ENABLED = original_client, original_flag


CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, ok, detail))


async def main() -> int:
    # ---- 1. the exact error from the report: tokens-per-day exhausted ----
    summary, seconds, calls = await run(
        "Explain the Pythagorean theorem", lambda model: rate_limit_error(model))
    notice = summary["notices"][0] if summary["notices"] else ""
    check("429 TPD: no error event", not summary["errors"], str(summary["errors"]))
    check("429 TPD: a lesson still arrives", len(summary["steps"]) >= 4, f"{len(summary['steps'])} steps")
    check("429 TPD: correct topic chosen", summary["topic"] == "Pythagorean theorem", str(summary["topic"]))
    check("429 TPD: friendly notice", "tokens per day" in notice and "35 minutes" in notice, notice[:120])
    check("429 TPD: no raw provider text", "org_x" not in notice and "429" not in notice, notice[:120])
    check("429 TPD: fell back to the other model", calls == ["openai/gpt-oss-120b", "openai/gpt-oss-20b"], str(calls))
    check("429 TPD: did not wait for the quota reset", seconds < 5, f"{seconds:.2f}s")
    check("429 TPD: quiz still included", "check" in summary["types"], str(summary["types"][-3:]))

    # ---- 2. transient network failure: bounded retries, then offline ----
    attempts = {"n": 0}

    def flaky(model):
        attempts["n"] += 1
        return Exception("Connection error.") if attempts["n"] <= 3 else [
            '{"type":"meta","topic":"Derivatives","mode":"2d","clear":true}',
            '{"type":"step","say":"A derivative measures how fast something changes.","draw":[]}',
        ]
    summary, seconds, calls = await run("Explain derivatives", flaky)
    check("transient: retries the same model", calls.count("openai/gpt-oss-120b") == 3, str(calls))
    check("transient: recovers when the model answers", summary["topic"] == "Derivatives", str(summary["topic"]))
    check("transient: no notice after recovery", not summary["notices"], str(summary["notices"]))
    check("transient: backoff is bounded", seconds < 6, f"{seconds:.2f}s")

    # ---- 3. every attempt fails: offline lesson, still no dead end ----
    summary, _, _ = await run("Explain the cross product of two vectors in 3D",
                              lambda model: Exception("Connection error."))
    check("all fail: offline lesson plays", summary["topic"] == "Vectors, dot and cross product", str(summary["topic"]))
    check("all fail: notice not error", summary["notices"] and not summary["errors"], str(summary["errors"]))
    check("all fail: 3D content survives", any(s.get("draw3d") for s in summary["steps"]), "no draw3d")

    # ---- 4. a question outside the library: helpful reply, never a blank page ----
    summary, _, _ = await run("Explain the French Revolution", lambda model: rate_limit_error(model))
    check("no match: still answers", len(summary["steps"]) == 1 and summary["steps"][0]["say"], "no step")
    check("no match: offers real topics", "suggest" in summary["types"], str(summary["types"]))
    check("no match: no error event", not summary["errors"], str(summary["errors"]))

    # ---- 5. mid-lesson drop keeps what was drawn instead of restarting ----
    class MidwayStream:
        """Yields three events, then the connection dies mid-lesson."""

        def __init__(self, chunks):
            self.chunks = chunks

        def __aiter__(self):
            async def gen():
                for text in self.chunks:
                    yield FakeChunk(text)
                raise Exception("stream disconnected")
            return gen()

    midway_calls = []

    async def create_midway(**kwargs):
        midway_calls.append(kwargs["model"])
        return MidwayStream([
            '{"type":"meta","topic":"Quadratic equations","mode":"2d","clear":true}',
            '{"type":"step","say":"A quadratic has the form a x squared plus b x plus c.","draw":[]}',
            '{"type":"step","say":"Its graph is a parabola.","draw":[]}',
        ])

    fake = FakeGroq(lambda model: None)
    fake.chat.completions.create = create_midway
    original = (server.groq, server.LLM_ENABLED)
    server.groq, server.LLM_ENABLED = fake, True
    try:
        events = [json.loads(l) async for l in lesson_stream(
            LessonRequest(question="quadratic equations", depth="standard"))]
    finally:
        server.groq, server.LLM_ENABLED = original
    summary = collect([e for e in events if e["type"] != "done"])
    check("mid-lesson drop: keeps partial lesson", len(summary["steps"]) == 2, f"{len(summary['steps'])} steps")
    check("mid-lesson drop: does not replay from the top", len(midway_calls) == 1, str(midway_calls))
    check("mid-lesson drop: explains, no restart", summary["notices"] and "part way" in summary["notices"][0],
          str(summary["notices"])[:120])
    check("mid-lesson drop: no error event", not summary["errors"], str(summary["errors"]))

    # ---- 6. AI_MODE=offline never touches the network ----
    calls_made = []
    server.LLM_ENABLED = False
    server.groq = FakeGroq(lambda model: calls_made.append(model) or rate_limit_error(model))
    try:
        events = [json.loads(l) async for l in lesson_stream(
            LessonRequest(question="Explain the Pythagorean theorem", depth="deep"))]
    finally:
        server.groq = None
    summary = collect([e for e in events if e["type"] != "done"])
    check("offline mode: zero API calls", not calls_made, str(calls_made))
    check("offline mode: deep dive gives extra steps", len(summary["steps"]) >= 6, f"{len(summary['steps'])} steps")
    check("offline mode: two checks in deep dive", summary["types"].count("check") == 2, str(summary["types"]))
    check("offline mode: says why", "offline" in (summary["notices"][0].lower() if summary["notices"] else ""),
          str(summary["notices"])[:120])

    failed = [c for c in CHECKS if not c[1]]
    for name, ok, detail in CHECKS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"\n          {detail}" if not ok and detail else ""))
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
