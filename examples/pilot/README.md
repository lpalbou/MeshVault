# MeshVault pilot — local-LLM agent with a live REPL

A LangGraph agent, powered by a local model served by LM Studio, that pilots
MeshVault through the `meshvault-mcp` tools. You get a text REPL: give it
tasks, interrupt it mid-work, discuss while it edits — and optionally watch
every stroke live in the MeshVault app through the observation seat.

## Prerequisites

1. **LM Studio** with the local server enabled (default
   `http://127.0.0.1:1234/v1`) and — strongly recommended — a **vision**
   tool-calling model (LM Studio type `vlm`), e.g. Qwen 3.6 35B (MoE, VLM).
   3D editing is visual work: a vision model receives every screenshot it
   takes as an actual image (injected as a user-role image message before its
   next reasoning step) and self-corrects — the field experiment showed a
   text-only 80B declaring a white blob "the Falcon, complete", while the
   vision 35B caught its own thin mandibles and replaced them. Memory
   guidance: a 35B-A3B 4-bit quant needs roughly 20 GB; prefer a context
   length ≥ 16k (image turns consume context quickly; 8k gets tight fast).

   Model choice is **memory-polite with a vision preference**: explicit
   `--model <substring>` wins; otherwise a LOADED vlm > the preferred Qwen
   vlm (accepting the JIT-load cost) > any loaded model > newest Qwen. The
   pilot prints `(VISION)` or a text-only warning at startup.
2. **MeshVault with the MCP extra** in this repo:

```bash
pip install -e '.[mcp]'          # or use the repo's .venv-mcp
python -m playwright install chromium
```

3. Optional but recommended — the **MeshVault app** running, to watch the
   agent live:

```bash
MESHVAULT_TOKEN=dev meshvault --port 8442
# open http://127.0.0.1:8442/ → eye icon → Watch "pilot: <model>"
```

## Run

```bash
python examples/pilot/meshvault_pilot.py                     # pick newest Qwen
python examples/pilot/meshvault_pilot.py --model qwen3.5     # substring match
python examples/pilot/meshvault_pilot.py --task "add a sphere and paint it red"
python examples/pilot/meshvault_pilot.py --once "load /path/model.glb and describe it"
```

## Using the REPL

- Type an instruction and watch the tool calls stream:

```
you> add a torus and sculpt three bumps on top, then paint them gold
agent> Adding the torus and checking its bounds first.
  → viewer_execute {"action": "add_primitive", "params": {"kind": "torus"}}
  · viewer_execute: {"ok": true, "result": {"id": "obj_1", ...}}
```

- **Interrupt anytime**: type while it works. The run pauses at the next safe
  boundary, unfinished tool calls are closed as "interrupted", and your
  message becomes its next input — course corrections land immediately.
- `stop` pauses without giving a new task; `quit` exits.
- Screenshots are saved under the session directory (path printed at startup)
  because local models are text-only here: the agent works from the numbers
  (`painted`, `meanAlpha`, `stretchedEdges`, bounds), you look at the pixels —
  or take the observation seat for the live view.

## How it works

- `langchain-mcp-adapters` opens ONE persistent stdio session to
  `meshvault-mcp` (a fresh session per call would lose the scene between
  calls), so the agent's headless viewer accumulates state across the whole
  conversation.
- The system prompt embeds the field-tested skill
  (`.cursor/skills/meshvault-live-editing/SKILL.md`): probe before touching,
  quantified feedback after every mutation, the sculpt → regularize → paint
  loop, adaptive-resolution playbook.
- `MESHVAULT_SESSION_LABEL` names the observe-seat session after the model, so
  the app lists it as `pilot: qwen3.6-35b`.
- Every tool returns `{ok, result|error}` — the REPL prints a compact line per
  call (`·` ok / `✗` refused) so you can follow the agent's reasoning about
  failures in real time.

## Prefer not to leave the app? Use the in-app AI instead

The same local-LLM loop is built into the MeshVault app itself: press **⌘K**
(or the sparkle button in the toolbar) and type an instruction — the agent
edits the scene in YOUR tab, live, using the same control API. The pilot REPL
remains the right tool for long autonomous sessions and scripted experiments;
the in-app bar is for quick "do this now" edits while you browse. See
`docs/mcp.md` (§ In-app AI).
