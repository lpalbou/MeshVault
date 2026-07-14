"""
In-app AI pilot — a local-LLM agent that edits the scene in the USER'S tab.

The Spotlight-style command bar (frontend) posts an instruction; this manager
runs a tool-calling loop against LM Studio's OpenAI-compatible server and
executes every tool call INSIDE the initiating browser tab:

    instruct → LLM tool_call → SSE {type:"ai_command"} → tab executes on its
    live viewer (the same ViewerControlAPI humans and MCP agents use) → tab
    POSTs the result back → loop continues → progress streams to the tab.

Design constraints (deliberate):
- No new Python dependencies: stdlib urllib in a worker thread talks to
  LM Studio. The rest is asyncio.
- The command bridge reuses the app's EventBroadcaster (SSE /api/events).
  That channel is lossy for slow clients, so every command awaits its result
  with a timeout — a dropped frame surfaces as an honest timeout error, never
  a hang.
- One task at a time. New instructions DURING a run are injected as user
  messages at the next loop boundary (the REPL-interrupt pattern from
  examples/pilot), so a human can course-correct without killing the task.
- The model is text-only: screenshots the agent takes are saved server-side
  and the model receives a text note (path + size); the human sees the pixels
  in their own viewport anyway — it is THEIR scene.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

DEFAULT_LMSTUDIO = os.environ.get("MESHVAULT_AI_URL", "http://127.0.0.1:1234/v1")
SHOT_DIR = Path(os.environ.get("MESHVAULT_AI_SHOTS", "/tmp/meshvault_ai_shots"))

STEP_CAP = 80                 # tool calls per instruction (runaway guard)
COMMAND_TIMEOUT_S = 60.0      # tab-side execution wait (screenshots are slow)
TASK_TIMEOUT_S = 20 * 60
LLM_TIMEOUT_S = 600           # local models: prompt processing can be minutes
MAX_TOOL_RESULT_CHARS = 4000  # keep the context lean; big payloads are truncated

_SKILL_PATH = (Path(__file__).resolve().parent.parent
               / ".cursor" / "skills" / "meshvault-live-editing" / "SKILL.md")

SYSTEM_PROMPT = """You are the MeshVault in-app AI: a 3D artist-technician editing the \
scene LIVE in the user's own viewer tab. The user watches every change as it happens — \
work steadily, no filler talk.

## Tools
- viewer_execute {action, params}: every scene/edit command (add_primitive, sculpt, \
paint, set_camera, set_object_transform, fill_paint, raycast, get_bounds, ...).
- list_viewer_commands {}: full schemas — call it once BEFORE your first edit.
- screenshot {width?, height?}: renders the user's current view; you receive a text \
note (you are text-only) — rely on quantified results and the user's eyes.

## Method (strict)
1. ONE tool call at a time; the scene is stateful and order matters.
2. See before touching: list_objects / get_bounds / describe what is loaded.
3. Never guess world coordinates: raycast / get_bounds / inspect_region first.
4. READ every result: {ok, result|error}. Quantified feedback (painted, meanAlpha, \
affected, stretchedEdges) is the truth. affected=0 means you missed — adjust.
5. Errors teach: the message usually names the fix (world units, active object...). \
NEVER retry the exact same failing call — change the action or the params. If an \
action is 'Unknown', it DOES NOT EXIST; use the suggestion in the error or pick \
from the cheatsheet below.
6. The sculpt loop: probe → sculpt → regularize_region → paint.
7. Radii are WORLD units (read get_bounds; a brush is typically 5-15% of the size).
8. Primitives: add_primitive {kind, params, name, transform:{position, rotation, \
scale}} — name every part; set_active_object {id|name} before painting a part.
9. COLORS ARE CSS HEX STRINGS ("#ff0000"), never arrays. To color a whole object: \
set_active_object then fill_paint {color: "#ff0000"}.
10. Keep text replies to ONE short sentence between tool calls; finish with a 1-3 \
sentence summary of what changed. Never invent success.

## Command cheatsheet (viewer_execute actions — these EXIST, guessed names do not)
add_primitive, list_objects, set_active_object, remove_object, set_object_transform, \
place_object, ground_object, set_parent, set_pivot, fill_paint, paint, paint_stroke, \
blur_paint, clone_paint, undo_paint, sculpt, sculpt_stroke, refine_region, \
regularize_region, simplify_region, inspect_region, inspect_texture, fix_mesh, \
get_mesh_stats, get_bounds, raycast, pick, set_camera, orbit, frame_all, set_view, \
find_best_view, set_render_mode, set_lighting, set_background, set_environment, \
set_keyframe, set_timeline, play_timeline, describe_scene, batch.

The user may send corrections mid-task — adapt immediately, do not restart from \
scratch unless asked."""


# ---------------------------------------------------------------------------
# LM Studio (OpenAI-compatible) — stdlib client, called in a worker thread
# ---------------------------------------------------------------------------

def _http_json(url: str, body: Optional[dict] = None, timeout: float = 30.0):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def lmstudio_pick_model(base_url: str, requested: str | None = None) -> str | None:
    """Prefer the model already resident in LM Studio memory (JIT loads of
    tens of GB are not something a Spotlight command should trigger unasked),
    else fall back to a Qwen-class instruct model."""
    root = base_url.rstrip("/").removesuffix("/v1")
    loaded, available = [], []
    try:
        data = _http_json(root + "/api/v0/models", timeout=4).get("data", [])
        for m in data:
            mid = m.get("id", "")
            if "embed" in mid.lower() or "rerank" in mid.lower():
                continue
            available.append(mid)
            if m.get("state") == "loaded":
                loaded.append(mid)
    except Exception:
        try:
            data = _http_json(base_url.rstrip("/") + "/models", timeout=4).get("data", [])
            available = [m.get("id", "") for m in data]
        except Exception:
            return None
    if requested:
        for m in available:
            if requested.lower() in m.lower():
                return m
        return None
    if loaded:
        return loaded[0]
    for pref in ("qwen3.6", "qwen3.5", "qwen3"):
        for m in available:
            if pref in m.lower():
                return m
    return available[0] if available else None


TOOLS_SPEC = [
    {"type": "function", "function": {
        "name": "viewer_execute",
        "description": "Run one viewer control-API command in the user's tab.",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string"},
            "params": {"type": "object"},
        }, "required": ["action"]},
    }},
    {"type": "function", "function": {
        "name": "list_viewer_commands",
        "description": "List every viewer command with its parameter schema.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "screenshot",
        "description": "Render the user's current view (you receive a text note).",
        "parameters": {"type": "object", "properties": {
            "width": {"type": "number"}, "height": {"type": "number"},
        }},
    }},
]


class AiTask:
    def __init__(self, instruction: str, client_id: str):
        self.id = uuid.uuid4().hex[:12]
        self.instruction = instruction
        self.client_id = client_id
        self.state = "running"          # running | done | error | stopped
        self.started_at = time.time()
        self.steps = 0
        self.summary = ""
        self.transcript: list[dict] = []   # [{kind, text, ts}] tail for the panel
        self.tab_timeouts = 0              # consecutive — dead-tab detector


class AiPilotManager:
    """One in-app agent task at a time; command bridge to the initiating tab."""

    def __init__(self, broadcaster):
        self._broadcaster = broadcaster
        self.task: Optional[AiTask] = None
        self._runner: Optional[asyncio.Task] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._inbox: list[str] = []
        self._stop = False

    # -- HTTP-facing ----------------------------------------------------------

    def status(self) -> dict:
        t = self.task
        if not t:
            return {"ok": True, "task": None}
        return {"ok": True, "task": {
            "id": t.id, "state": t.state, "steps": t.steps,
            "instruction": t.instruction[:400],
            "summary": t.summary,
            "elapsed": round(time.time() - t.started_at, 1),
            "transcript": t.transcript[-40:],
        }}

    def instruct(self, instruction: str, client_id: str) -> dict:
        instruction = instruction.strip()
        if not instruction:
            raise ValueError("empty instruction")
        if len(instruction) > 4000:
            raise ValueError("instruction too long (4000 chars max)")
        if self.task and self.task.state == "running":
            # Mid-run correction: inject at the next loop boundary.
            self._inbox.append(instruction)
            self._note("user", instruction)
            return {"ok": True, "queued": True, "task_id": self.task.id}
        model = lmstudio_pick_model(DEFAULT_LMSTUDIO,
                                    os.environ.get("MESHVAULT_AI_MODEL"))
        if model is None:
            raise RuntimeError(
                "No local model reachable — start LM Studio's server "
                f"({DEFAULT_LMSTUDIO}) with a model loaded, then retry.")
        self.task = AiTask(instruction, client_id)
        self._stop = False
        self._inbox.clear()
        self._runner = asyncio.create_task(self._run(model))
        return {"ok": True, "queued": False, "task_id": self.task.id,
                "model": model}

    def stop(self) -> dict:
        if not (self.task and self.task.state == "running"):
            return {"ok": True, "stopped": False}
        self._stop = True
        for fut in self._pending.values():
            if not fut.done():
                fut.cancel()
        return {"ok": True, "stopped": True}

    def deliver_result(self, command_id: str, result: dict) -> bool:
        fut = self._pending.pop(command_id, None)
        if fut and not fut.done():
            fut.set_result(result)
            return True
        return False

    # -- progress fan-out -------------------------------------------------------

    def _note(self, kind: str, text: str, **extra):
        if self.task:
            self.task.transcript.append({"kind": kind, "text": text[:500],
                                         "ts": round(time.time(), 2)})
        self._broadcaster.publish({"type": "ai_progress", "kind": kind,
                                   "text": text[:500],
                                   "task_id": self.task.id if self.task else None,
                                   **extra})

    # -- tab-side command execution ---------------------------------------------

    async def _run_in_tab(self, command: dict) -> dict:
        cid = uuid.uuid4().hex[:10]
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[cid] = fut
        delivered = self._broadcaster.publish({
            "type": "ai_command", "id": cid,
            "client_id": self.task.client_id if self.task else "",
            "command": command,
        })
        if delivered == 0:
            self._pending.pop(cid, None)
            return {"ok": False, "error": "no app tab connected — is the "
                                          "MeshVault tab still open?"}
        try:
            result = await asyncio.wait_for(fut, timeout=COMMAND_TIMEOUT_S)
            if self.task:
                self.task.tab_timeouts = 0
            return result
        except asyncio.TimeoutError:
            self._pending.pop(cid, None)
            if self.task:
                self.task.tab_timeouts += 1
            return {"ok": False, "error": f"tab did not answer within "
                                          f"{COMMAND_TIMEOUT_S:.0f}s"}
        except asyncio.CancelledError:
            return {"ok": False, "error": "stopped by the user"}

    async def _tool(self, name: str, args: dict) -> str:
        """Execute one model tool call; returns the (truncated) result JSON."""
        if name == "list_viewer_commands":
            result = await self._run_in_tab({"action": "list_commands",
                                             "params": {}})
        elif name == "screenshot":
            w = int(args.get("width") or 512)
            h = int(args.get("height") or 512)
            w, h = max(64, min(w, 1536)), max(64, min(h, 1536))
            result = await self._run_in_tab({"action": "screenshot",
                                             "params": {"width": w, "height": h,
                                                        "ssao": False}})
            data = result.get("result")
            if result.get("ok") and isinstance(data, str) and "," in data:
                SHOT_DIR.mkdir(parents=True, exist_ok=True)
                p = SHOT_DIR / f"{self.task.id}_{self.task.steps:03d}.png"
                try:
                    p.write_bytes(base64.b64decode(data.split(",", 1)[1]))
                    self._note("shot", f"screenshot saved: {p}", path=str(p))
                    return json.dumps({"ok": True, "note":
                                       f"screenshot rendered ({w}x{h}) and saved "
                                       f"to {p}. You are text-only: judge by "
                                       "quantified results; the user sees the "
                                       "live viewport."})
                except Exception as e:
                    return json.dumps({"ok": False, "error": f"save failed: {e}"})
            return json.dumps(result)[:MAX_TOOL_RESULT_CHARS]
        elif name == "viewer_execute":
            action = str(args.get("action", ""))
            if not re.fullmatch(r"[a-z0-9_]{1,64}", action):
                return json.dumps({"ok": False,
                                   "error": f"invalid action '{action[:64]}'"})
            params = args.get("params")
            result = await self._run_in_tab({"action": action,
                                             "params": params if isinstance(params, dict) else {}})
        else:
            return json.dumps({"ok": False, "error": f"unknown tool {name}"})
        out = json.dumps(result, default=str)
        if len(out) > MAX_TOOL_RESULT_CHARS:
            out = out[:MAX_TOOL_RESULT_CHARS] + "… [truncated]"
        return out

    # -- the agent loop -----------------------------------------------------------

    async def _run(self, model: str):
        task = self.task
        self._note("start", f"working on it (model: {model})", model=model)
        # Interactive loop: embed only the skill's GOLDEN RULES, not the whole
        # field guide — a 10k-token system prompt costs minutes of prompt
        # processing PER TURN on local models (measured with an 80B: 60-140s a
        # turn), which kills the "Spotlight" feel. The full guide stays in the
        # REPL pilot, which is built for long autonomous sessions.
        skill = ""
        try:
            text = _SKILL_PATH.read_text().split("---", 2)[-1]
            start = text.find("## Golden rules")
            end = text.find("## Session setup")
            if 0 <= start < end:
                skill = "\n\n" + text[start:end].strip()
        except Exception:
            pass
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT + skill},
            {"role": "user", "content": task.instruction},
        ]
        url = DEFAULT_LMSTUDIO.rstrip("/") + "/chat/completions"
        repeat_sig, repeat_n = None, 0   # failing-call loop detector
        try:
            while True:
                if self._stop:
                    task.state = "stopped"
                    self._note("done", "stopped by the user")
                    return
                if time.time() - task.started_at > TASK_TIMEOUT_S:
                    task.state = "error"
                    self._note("done", "task timeout (20 min) — stopping")
                    return
                if task.steps >= STEP_CAP:
                    task.state = "error"
                    self._note("done", f"step cap ({STEP_CAP}) reached — stopping")
                    return
                if task.tab_timeouts >= 3:
                    # The initiating tab is gone (closed/reloaded past its
                    # session) — burning the remaining steps on 60s timeouts
                    # would look like a hang. Stop honestly instead.
                    task.state = "error"
                    self._note("done", "the initiating tab stopped answering "
                                       "(closed or reloaded?) — task aborted")
                    return
                # Mid-run corrections from the Spotlight bar.
                while self._inbox:
                    messages.append({"role": "user", "content": self._inbox.pop(0)})

                body = {"model": model, "messages": messages,
                        "tools": TOOLS_SPEC, "temperature": 0.2}
                resp = await asyncio.to_thread(_http_json, url, body, LLM_TIMEOUT_S)
                msg = (resp.get("choices") or [{}])[0].get("message") or {}
                content = (msg.get("content") or "").strip()
                calls = msg.get("tool_calls") or []
                messages.append({"role": "assistant",
                                 "content": msg.get("content") or "",
                                 **({"tool_calls": calls} if calls else {})})
                if content:
                    self._note("say", content)
                if not calls:
                    task.summary = content or "(no summary)"
                    task.state = "done"
                    self._note("done", task.summary or "done")
                    return
                for call in calls:
                    if self._stop:
                        break
                    fn = (call.get("function") or {})
                    name = fn.get("name", "")
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except ValueError:
                        args = {}
                    task.steps += 1
                    label = name
                    if name == "viewer_execute":
                        label = f"{args.get('action', '?')}"
                    self._note("tool", f"→ {label} "
                               + json.dumps(args.get("params", args))[:180])
                    out = await self._tool(name, args)
                    ok = '"ok": true' in out or "'ok': True" in out
                    self._note("result", ("· " if ok else "✗ ") + out[:220])
                    messages.append({"role": "tool",
                                     "tool_call_id": call.get("id", ""),
                                     "content": out})
                    # Loop breaker: local models can ping-pong the same failing
                    # call indefinitely — after the 2nd identical failure,
                    # inject a hard course-correction as a user message.
                    sig = f"{name}:{json.dumps(args, sort_keys=True)}"
                    if not ok:
                        repeat_n = repeat_n + 1 if sig == repeat_sig else 1
                        repeat_sig = sig
                        if repeat_n >= 2:
                            messages.append({"role": "user", "content":
                                "STOP: you have now sent that exact failing "
                                "call twice. It will never succeed. Re-read "
                                "the error, use a DIFFERENT action or params "
                                "from the cheatsheet, or finish and report "
                                "what you could not do."})
                            self._note("say", "[loop breaker injected]")
                            repeat_n = 0
                    else:
                        repeat_sig, repeat_n = None, 0
        except Exception as e:
            task.state = "error"
            self._note("done", f"agent error: {e}")
        finally:
            if task.state == "running":
                task.state = "error"
