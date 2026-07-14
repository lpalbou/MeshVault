#!/usr/bin/env python3
"""
MeshVault pilot — a local-LLM agent (LM Studio) driving MeshVault over MCP,
with an interactive REPL you can talk to WHILE it works.

    python examples/pilot/meshvault_pilot.py                 # interactive REPL
    python examples/pilot/meshvault_pilot.py --once "add a red sphere"
    python examples/pilot/meshvault_pilot.py --model qwen/qwen3.6-35b-a3b

Requirements (see README.md):
- LM Studio running its local server (default http://127.0.0.1:1234/v1) with a
  tool-calling model loaded (Qwen 3.5/3.6 class works well) and a context
  window of at least 16k tokens.
- MeshVault installed with the mcp extra (meshvault-mcp on PATH or in .venv).

REPL semantics:
- Type an instruction and the agent works on it, narrating tool calls and
  quantified results as they happen.
- Type WHILE it works to interrupt: the current run stops at the next safe
  boundary (dangling tool calls are repaired), your message is delivered, and
  the agent continues with your correction in mind.
- `stop` interrupts without a new instruction; `quit` exits cleanly.
- Screenshots the agent takes are saved under the session directory and their
  paths printed — the model reads the metadata (it is text-only); you look at
  the pixels. Better: open the MeshVault app and take the observation seat to
  watch the agent live (its session is labeled "pilot: <model>").
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import shutil
import sys
import time
import urllib.request
from pathlib import Path

from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import BaseTool
from langgraph.errors import GraphRecursionError
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver

try:                                    # langgraph ≥1.0 moved the prebuilt agent
    from langchain.agents import create_agent as create_react_agent
except ImportError:
    from langgraph.prebuilt import create_react_agent

REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_PATH = REPO_ROOT / ".cursor" / "skills" / "meshvault-live-editing" / "SKILL.md"
DEFAULT_LMSTUDIO = "http://127.0.0.1:1234/v1"

SYSTEM_PROMPT = """You are a 3D artist-technician piloting MeshVault (a 3D viewer/editor) \
through MCP tools. A human talks to you through a text REPL and may be watching your \
work LIVE in the MeshVault app (observation seat), so keep working steadily and narrate \
briefly.

## Your tools
- load_model / describe_scene / get_state / screenshot / export_model / open_in_app
- viewer_execute {action, params}: THE workhorse — every scene/edit command.
- list_viewer_commands: full schemas. Call it once early if you plan to edit.

## Command cheatsheet (viewer_execute actions)
Scene: add_primitive {kind: box|sphere|cylinder|cone|torus|plane, params, name}, \
list_objects, set_active_object {id}, remove_object, place_object, set_object_transform \
{position, rotation, scale}, set_parent, set_pivot, unload.
Look: set_camera {position, target, fov}, orbit {azimuth, elevation, scope}, \
find_best_view, set_render_mode {mode: shaded|clay|wireframe|textured}, get_bounds.
Aim (never guess coordinates): pick {x, y, width, height} from a screenshot pixel; \
raycast {origin, direction}; inspect_region {center, radius}.
Sculpt: sculpt {tool: draw|inflate|smooth|flatten|pinch|grab|hinge, center, radius, \
strength, direction, falloff}, sculpt_stroke {path, ...}. Radii are WORLD units — read \
get_bounds first; typical radius ≈ 5-15% of the object size.
Adaptive resolution (adjust mesh density on the fly):
- inspect_region {center, radius} or {grid: 3} → edgeLength median/p95 + density map.
- refine_region {center, radius, detail_rel|target_edge} → densify before fine detail \
(target_edge ≈ brush radius / 5).
- regularize_region {center, radius, target_edge?} → equalize stretched facets AFTER \
heavy grabs (read stretchedEdges before/after; explicit target_edge on mixed regions).
- simplify_region {center, radius, ratio} → coarsen over-dense areas (ratio = keep).
Paint: fill_paint {color, texture_size: 512|1024|2048|4096} once to create a layer, \
then paint {center, radius, color, opacity}, paint_stroke {path|points, ...}, \
blur_paint, clone_paint {from, to, radius}, undo_paint. texture_size tiers: \
low=512 medium=1024 high=2048 xhigh=4096 — pick per quality need.
Repair: fix_mesh {operations: [degenerate, normals]}, get_mesh_stats, detect_symmetry \
+ mirror_paint.
Animate: set_keyframe {time, position?, rotation?, morphs?, capture?}, set_timeline \
{duration}, play/pause, split_object for articulation.

## Method (follow strictly)
0. ONE tool call at a time, always. MeshVault is stateful and order matters — \
parallel calls race (a describe issued with an add returns the PRE-add scene).
1. See before touching: describe_scene + get_bounds; screenshot to judge visually \
(you receive its METADATA; the human sees the pixels — ask them, or trust numbers).
2. Never guess world coordinates: pick / raycast / inspect_region / get_bounds.
3. After every mutation READ THE RESULT: {ok, result|error}. Results carry quantified \
feedback (painted, meanAlpha, stretchedEdges, affected...). meanAlpha ≈ 0 means \
invisible paint; affected = 0 means the brush missed — adjust, don't repeat blindly.
4. Errors are teaching errors: read them, they usually name the fix.
5. The sculpt loop: probe → sculpt → regularize_region → paint.
6. Report difficulties honestly in one short line ("grab keeps missing — the region \
is coarser than the brush; refining first"). Never invent success.
7. Keep replies SHORT: one or two sentences between tool calls. No markdown headers.

When the user interrupts you mid-work, treat their message as a course correction and
adapt immediately. When a task is done, summarize what changed in 2-3 sentences and
suggest ONE next step."""


# ---------------------------------------------------------------------------
# LM Studio discovery
# ---------------------------------------------------------------------------

def lmstudio_catalog(base_url: str) -> list[dict]:
    """Model catalog with state + modality (LM Studio /api/v0 extension)."""
    root = base_url.rstrip("/").removesuffix("/v1")
    try:
        with urllib.request.urlopen(root + "/api/v0/models", timeout=4) as r:
            return [m for m in json.loads(r.read()).get("data", [])
                    if m.get("type") not in ("embeddings",)
                    and "embed" not in m.get("id", "").lower()
                    and "rerank" not in m.get("id", "").lower()]
    except Exception:
        try:
            with urllib.request.urlopen(base_url.rstrip("/") + "/models",
                                        timeout=4) as r:
                return [{"id": m["id"], "state": "unknown", "type": "llm"}
                        for m in json.loads(r.read()).get("data", [])]
        except Exception:
            return []


def pick_model(catalog: list[dict], requested: str | None) -> dict:
    """Choose {id, type, state}. 3D editing is VISUAL work: a model that can
    LOOK at its screenshots corrects itself; a blind one declares victory on
    a white blob (Falcon field lesson). So: explicit request wins; otherwise
    a loaded VLM > the preferred Qwen VLM (JIT load accepted) > loaded LLM >
    newest Qwen."""
    def find(pred):
        return next((m for m in catalog if pred(m)), None)

    if requested:
        m = (find(lambda m: m["id"] == requested)
             or find(lambda m: requested.lower() in m["id"].lower()))
        if not m:
            raise SystemExit(f"Model '{requested}' not found in LM Studio. "
                             f"Available: {', '.join(x['id'] for x in catalog) or '(none)'}")
        return m
    m = (find(lambda m: m.get("state") == "loaded" and m.get("type") == "vlm")
         or find(lambda m: m.get("type") == "vlm" and "qwen3.6" in m["id"].lower())
         or find(lambda m: m.get("state") == "loaded")
         or find(lambda m: "qwen3.6" in m["id"].lower())
         or find(lambda m: "qwen3" in m["id"].lower())
         or (catalog[0] if catalog else None))
    if not m:
        raise SystemExit("LM Studio has no models — load one (e.g. Qwen 3.6 "
                         "35B) and enable the local server, then retry.")
    return m


# ---------------------------------------------------------------------------
# Tool result presentation: keep the model's context lean and the human informed
# ---------------------------------------------------------------------------

class ScreenshotSaver:
    """Extract images from MCP tool results and save PNGs to the session dir.

    Vision models (LM Studio type "vlm"): the image is queued and a
    pre_model_hook injects it as a USER-role image block before the model's
    next reasoning step — the OpenAI chat format does not carry images in
    TOOL-role messages, so the tool result itself becomes a short text note.
    Text-only models: the note says honestly that the model cannot see it.
    """

    def __init__(self, session_dir: Path, vision: bool):
        self.dir = session_dir
        self.vision = vision
        self.count = 0
        self.pending: list[str] = []      # base64 PNGs awaiting injection

    def rewrite(self, tool_name: str, content):
        if not isinstance(content, list):
            return content
        out = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "image":
                self.count += 1
                path = self.dir / f"{self.count:03d}_{tool_name}.png"
                payload = block.get("base64") or block.get("data") or ""
                try:
                    path.write_bytes(base64.b64decode(payload))
                    print(f"   [image saved: {path}]")
                except Exception as e:
                    out.append({"type": "text", "text": f"[image save failed: {e}]"})
                    continue
                if self.vision:
                    self.pending.append(payload)
                    out.append({"type": "text",
                                "text": f"[render #{self.count} captured — the "
                                        "image follows in the next user message. "
                                        "LOOK at it and judge before continuing.]"})
                else:
                    out.append({"type": "text",
                                "text": f"[image #{self.count} saved to {path} — "
                                        "the human can view it; you cannot. Rely on "
                                        "metadata and quantified results.]"})
            else:
                out.append(block)
        return out

    def drain_hook(self, state):
        """pre_model_hook: turn queued screenshots into a user-role image
        message injected ahead of the next LLM call."""
        if not self.pending:
            return {}
        blocks = [{"type": "text",
                   "text": f"[{len(self.pending)} render(s) from your last "
                           "screenshot call. Judge them concretely: shape, "
                           "proportions, paint contrast. Name what is wrong "
                           "before your next edit.]"}]
        for b64 in self.pending:
            blocks.append({"type": "image_url",
                           "image_url": {"url": f"data:image/png;base64,{b64}"}})
        self.pending.clear()
        return {"messages": [HumanMessage(content=blocks)]}


def brief(value, limit: int = 300) -> str:
    s = value if isinstance(value, str) else json.dumps(value, default=str)
    s = " ".join(s.split())
    return s if len(s) <= limit else s[:limit] + "…"


# ---------------------------------------------------------------------------
# The REPL app
# ---------------------------------------------------------------------------

class Pilot:
    def __init__(self, agent, session_dir: Path):
        self.agent = agent
        self.session_dir = session_dir
        # ~= 200 model turns (each turn is a model node + a tools node).
        # Vision builds spend turns on look-judge-fix loops — worth it.
        self.config = {"configurable": {"thread_id": "repl"},
                       "recursion_limit": 400}
        self.inbox: asyncio.Queue[str] = asyncio.Queue()
        self.interrupt = asyncio.Event()

    # -- input side ----------------------------------------------------------

    async def read_input(self):
        loop = asyncio.get_running_loop()
        while True:
            try:
                line = await loop.run_in_executor(None, sys.stdin.readline)
            except (EOFError, KeyboardInterrupt):
                line = "quit\n"
            line = (line or "quit").strip()
            if not line:
                continue
            await self.inbox.put(line)
            self.interrupt.set()

    # -- output side ----------------------------------------------------------

    def _print_step(self, update: dict):
        for node, payload in update.items():
            for msg in (payload or {}).get("messages", []):
                kind = getattr(msg, "type", "")
                if kind == "ai":
                    text = (msg.content if isinstance(msg.content, str)
                            else " ".join(b.get("text", "") for b in msg.content
                                          if isinstance(b, dict)))
                    if text.strip():
                        print(f"\nagent> {text.strip()}")
                    for tc in getattr(msg, "tool_calls", None) or []:
                        print(f"  → {tc['name']} {brief(tc.get('args', {}), 220)}")
                elif kind == "tool":
                    content = msg.content
                    if isinstance(content, list):
                        content = " ".join(b.get("text", "") for b in content
                                           if isinstance(b, dict))
                    ok = "✗" if '"ok": false' in str(content).lower() \
                        or "'ok': false" in str(content).lower() else "·"
                    print(f"  {ok} {msg.name}: {brief(content, 260)}")

    # -- state repair after interruption --------------------------------------

    def _repair_dangling_tool_calls(self):
        """An interrupted run can leave an AIMessage with tool_calls that never
        got ToolMessages — the OpenAI message format rejects the next turn.
        Close them with explicit 'interrupted' results (honest, resumable)."""
        state = self.agent.get_state(self.config)
        msgs = state.values.get("messages", [])
        if not msgs:
            return
        answered = {m.tool_call_id for m in msgs if isinstance(m, ToolMessage)}
        last_ai = next((m for m in reversed(msgs) if getattr(m, "type", "") == "ai"),
                       None)
        if last_ai is None:
            return
        repairs = [ToolMessage(
                       content="[interrupted by the user before this tool ran]",
                       tool_call_id=tc["id"], name=tc.get("name", "tool"))
                   for tc in (getattr(last_ai, "tool_calls", None) or [])
                   if tc.get("id") and tc["id"] not in answered]
        if repairs:
            self.agent.update_state(self.config, {"messages": repairs})

    # -- one agent run ---------------------------------------------------------

    async def run_turn(self, user_text: str) -> bool:
        """Stream one agent turn; returns False if the user interrupted."""
        self.interrupt.clear()
        stream = self.agent.astream(
            {"messages": [HumanMessage(content=user_text)]},
            self.config, stream_mode="updates")
        interrupted = False
        try:
            async for update in stream:
                self._print_step(update)
                if self.interrupt.is_set():
                    interrupted = True
                    break
        except GraphRecursionError:
            # Long builds legitimately hit the step budget mid-flight. The
            # scene state is REAL and persisted (MCP session lives on) — ask
            # the agent to land the plane instead of discarding the work.
            print("\n[step budget reached — asking the agent to wrap up]")
            self._repair_dangling_tool_calls()
            wrap = self.agent.astream(
                {"messages": [HumanMessage(content=
                    "You hit the step budget. STOP building. In at most 3 tool "
                    "calls: take one screenshot, export the current state with "
                    "export_model (the path from the original task), and give "
                    "your honest summary of what is done vs missing.")]},
                self.config, stream_mode="updates")
            try:
                async for update in wrap:
                    self._print_step(update)
            except GraphRecursionError:
                print("[wrap-up also hit the budget — state is preserved]")
            finally:
                await wrap.aclose()
        finally:
            await stream.aclose()
        if interrupted:
            self._repair_dangling_tool_calls()
            print("\n[paused — your message goes to the agent now]")
        return not interrupted

    # -- main loop --------------------------------------------------------------

    async def repl(self, first_task: str | None):
        reader = asyncio.create_task(self.read_input())
        print("\nMeshVault pilot ready. Type instructions; type WHILE it works to "
              "interrupt; 'stop' pauses; 'quit' exits.")
        print(f"Screenshots land in {self.session_dir}\n")
        pending = first_task
        try:
            while True:
                if pending is None:
                    print("you> ", end="", flush=True)
                    pending = await self.inbox.get()
                text = pending
                pending = None
                if text.lower() in ("quit", "exit"):
                    break
                if text.lower() == "stop":
                    continue
                await self.run_turn(text)
                # Deliver anything typed during the run as the next turn.
                if not self.inbox.empty():
                    pending = await self.inbox.get()
        finally:
            reader.cancel()


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------

def find_mcp_command() -> str:
    candidates = [
        REPO_ROOT / ".venv-mcp" / "bin" / "meshvault-mcp",
        REPO_ROOT / ".venv" / "bin" / "meshvault-mcp",
        Path(shutil.which("meshvault-mcp") or ""),
    ]
    for c in candidates:
        if c and c.is_file():
            return str(c)
    raise SystemExit("meshvault-mcp not found — install with pip install -e '.[mcp]'")


async def amain(args):
    catalog = lmstudio_catalog(args.lmstudio)
    chosen = pick_model(catalog, args.model)
    model_id = chosen["id"]
    vision = chosen.get("type") == "vlm"
    if chosen.get("state") != "loaded":
        print(f"note: {model_id} is not loaded in LM Studio yet — the first "
              "call triggers a JIT load (can take minutes / tens of GB).")
    print(f"LM Studio model: {model_id} ({'VISION' if vision else 'text-only'})")
    if not vision:
        print("warning: text-only model — 3D editing is visual work; the agent "
              "cannot judge its renders. Prefer a VLM (e.g. qwen3.6-35b).")

    session_dir = Path(args.session_dir or
                       f"/tmp/mv_pilot_{time.strftime('%Y%m%d_%H%M%S')}")
    session_dir.mkdir(parents=True, exist_ok=True)
    saver = ScreenshotSaver(session_dir, vision)

    llm = ChatOpenAI(model=model_id, base_url=args.lmstudio, api_key="lm-studio",
                     temperature=0.2, timeout=600)

    client = MultiServerMCPClient({
        "meshvault": {
            "command": find_mcp_command(),
            "args": [],
            "transport": "stdio",
            "env": {**os.environ,
                    "MESHVAULT_SESSION_LABEL": f"pilot: {model_id.split('/')[-1]}"},
        }
    })

    # ONE persistent MCP session for the whole REPL — sessionless tool calls
    # would spawn a fresh headless viewer per call and lose all scene state.
    async with client.session("meshvault") as session:
        tools = await load_mcp_tools(session)

        # Route image-bearing results through the saver (screenshot etc.) and
        # SERIALIZE all tool execution: MeshVault is stateful — if the model
        # emits parallel calls anyway, racing them corrupts read-after-write
        # ordering (observed: describe_scene overtaking add_primitive).
        tool_lock = asyncio.Lock()
        for tool in tools:
            orig = tool.coroutine
            if orig is None:
                continue

            def wrap(orig_fn, tool_ref: BaseTool):
                async def run(**kwargs):
                    async with tool_lock:
                        result = await orig_fn(**kwargs)
                    if isinstance(result, tuple) and len(result) == 2:
                        content, artifacts = result
                        return saver.rewrite(tool_ref.name, content), artifacts
                    return saver.rewrite(tool_ref.name, result)
                return run
            tool.coroutine = wrap(orig, tool)

        skill = ""
        if SKILL_PATH.is_file():
            skill = "\n\n## Field guide (distilled from live sessions)\n" \
                    + SKILL_PATH.read_text().split("---", 2)[-1]
        vision_note = ""
        if vision:
            vision_note = (
                "\n\n## You can SEE\n"
                "Screenshots you take arrive as images in the next user "
                "message. The verification loop is MANDATORY: after every "
                "build/sculpt/paint phase, screenshot (512x512, ssao:false is "
                "cheap), LOOK at it, name concretely what is wrong (shape, "
                "proportion, color, contrast), fix it, and re-shoot. Never "
                "declare a phase done without having seen it. Use views "
                "[\"front\",\"top\",\"iso\"] to judge proportions like an artist "
                "turning the easel.")
        agent = create_react_agent(
            llm, tools, prompt=SYSTEM_PROMPT + vision_note + skill,
            pre_model_hook=saver.drain_hook,
            checkpointer=MemorySaver())
        pilot = Pilot(agent, session_dir)

        if args.once:
            ok = await pilot.run_turn(args.once)
            return 0 if ok else 1
        await pilot.repl(args.task)
    return 0


def main():
    ap = argparse.ArgumentParser(description="LM Studio agent piloting MeshVault over MCP")
    ap.add_argument("--lmstudio", default=os.environ.get("LMSTUDIO_URL", DEFAULT_LMSTUDIO),
                    help="LM Studio OpenAI-compatible base URL")
    ap.add_argument("--model", default=os.environ.get("LMSTUDIO_MODEL"),
                    help="model id or substring (default: newest Qwen loaded)")
    ap.add_argument("--task", default=None, help="first instruction, then REPL")
    ap.add_argument("--once", default=None,
                    help="run ONE instruction non-interactively and exit")
    ap.add_argument("--session-dir", default=None, help="where screenshots are saved")
    args = ap.parse_args()
    try:
        raise SystemExit(asyncio.run(amain(args)))
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
