# MeshVault MCP Server

Drive the MeshVault 3D viewer from any MCP client (Claude Desktop, Claude Code, Cursor,
VS Code, …). The server runs a headless, GPU-optional viewer and exposes **thirteen
tools** — a deliberately thin surface routed through the viewer's self-describing
control API (one-tool-per-command surfaces measurably degrade agent performance).

An agent can: load a model from a **URL or a local file path** (multi-file assets load
textured), COMPOSE multi-object scenes (`load_model {add:true}` + placement commands,
persisted as `.mvscene` manifests via `save_scene`/`load_scene`), **CREATE from
nothing** — add primitives, sculpt them with world-space brushes, paint real texture
layers, and aim by screenshot coordinates (`pick`) — get a structured text
description (no vision needed), discover and run any of the ~100 viewer commands
(camera, render modes, lighting/IBL, transforms, cross-sections, measurement,
animation, per-object placement, sculpt/paint, regional inspect/simplify/repair,
texture forensics + UV repair, part detection/splitting, pivots/parenting, and the
scene keyframe timeline), compare models geometrically, get PNG
screenshots back as proper MCP image content, and share a session with a human both
ways — push what it sees into the running app (`open_in_app`), or pick up what the
human sees (`get_app_state`).

> Not speaking MCP? The local server also exposes `GET /api/screenshot` — a plain
> authenticated HTTP endpoint returning a PNG render (same presets, same confinement)
> for curl/scripts. See [docs/api.md](api.md#get-apiscreenshot).

> No install at all? Agents with plain browser automation can drive the hosted viewer at
> <https://www.lpalbou.info/MeshVault/> via `window.mv` (URL-loaded models only, no
> backend tools) — see that site's `llms.txt`. This MCP server is the full-featured path.

## Install

```bash
pip install "meshvault[mcp]"       # >= 0.3.1 (open_in_app + presets need >= 0.4.0)
playwright install chromium        # one-time headless browser download
```

Or from a source checkout:

```bash
git clone https://github.com/lpalbou/MeshVault && cd MeshVault
pip install -e ".[mcp]" && playwright install chromium
```

This adds two optional dependencies (`mcp`, `playwright`) and the `meshvault-mcp`
console script. Nothing else in MeshVault requires them.

## Client configuration

All major clients use the same `mcpServers` JSON shape; only the file location differs.

**Cursor** — `~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "meshvault": {
      "command": "meshvault-mcp"
    }
  }
}
```

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "meshvault": {
      "command": "meshvault-mcp"
    }
  }
}
```

**Claude Code** — `.mcp.json` at the project root (shared with the team) or via
`claude mcp add meshvault -- meshvault-mcp`.

If `meshvault-mcp` is not on the client's PATH, use the absolute path to the script (or
`"command": "python", "args": ["-m", "backend.mcp_server"]` with the appropriate
interpreter and working directory).

## Tools

| Tool | Purpose |
|------|---------|
| `load_model` | Load a model from an http(s) **URL** or an absolute **local file path**. Returns the load result *plus* a full scene description in one call. Multi-file assets load **textured**: the model's directory companions (OBJ→MTL→textures via `mtllib` parsing, `.gltf`→`.bin`, FBX textures) are served alongside it and resolve like normal relative URLs. URLs are fetched by the browser first; on CORS failure the server downloads the file itself (512 MB cap) and serves it locally. |
| `describe_scene` | Structured TEXT snapshot: summary sentence, live inventory, bounds + real-world size hint, hierarchy, materials, detected geometry issues (missing normals/UVs, degenerate faces, watertightness, flipped normals, scale sanity), current view. The recommended first observation — no vision needed. |
| `viewer_execute` | Passthrough to any viewer command (`{action, params}`): camera presets/orbit, `find_best_view` (semantic front + auto-upright), render modes, lighting + IBL, clipping planes, rotate/center/ground/simplify, measurement, animation. Returns `{ok, result | error}`, never throws. Note: `get_camera` / `set_camera {position, target, fov}` are viewer **commands** invoked through this tool (`viewer_execute {action:"get_camera"}`), not top-level MCP tools. |
| `list_viewer_commands` | Every action with its parameter schema (types, ranges, defaults). Call once, then use `viewer_execute`. |
| `get_state` | Compact state snapshot (model, camera, display, animation, lighting) — verify a command's effect without a screenshot. |
| `compare_models` | Compare ONE reference against N candidates (1–8) **geometrically**, via shape registration — not screenshots. Per candidate: `alignment` (uniform scale ratio, rotation angle, translation — how it had to be transformed to match; unit mismatches surface as the scale ratio), `distances` (symmetric chamfer mean/p95 + Hausdorff, normalized by the reference bbox diagonal, floor-corrected for sampling noise; `asymmetry` flags missing/extra regions), `classification` (identical / near_identical / same_shape_modified / different, with `borderline` + `warnings`), and `structural` count/inventory deltas. Returns `rankingBySimilarity`. Reference or candidates may be paths or URLs; `align:false` compares in place (detects pose changes). |
| `screenshot` | Render the model as MCP **image content** (PNG, 16–8192 px), with a JSON metadata text block first. `best_view: true` moves to the model's most detailed angle (the chosen azimuth/elevation/score come back in the metadata). `views: ["front","left","45,20"]` captures several angles — presets or "azimuth,elevation" degrees — in ONE call (scene-scoped framing: safe on composed scenes), images returned in order. `preset: "studio"\|"neutral"\|"dark"` pins the **full** lighting/background state to a documented look first, so renders are comparable across sessions and agents (see below). `ssao: false` + a small size (e.g. 192×192) = cheap proof render for sculpt/paint loops. `times: [0, 0.5, 1, ...]` (≤12) returns ONE **motion contact sheet** — the timeline sought to each time, tiles labeled, camera auto-framed to the whole swept motion — THE cheap animation preview. |
| `get_texture` | The active object's texture rendered in **TEXTURE SPACE** as MCP image content: the image + the mesh's UV wireframe (green), crosshair `markers` at picked UVs, an orange outline of the chart under `outline_island_of`, and a `crop_center`/`crop_size` zoom. THE texture-to-mesh misalignment diagnostic — `pick` gives a surface point's `.uv`; if its marker sits offset from the matching texture feature, repair with `transform_uv` (coherent atlases) or `project_paint` (fragmented atlases — check `get_uv_islands` first). |
| `export_model` | Write the visible scene to a **GLB file** — the persistence path for sculpted geometry, painted textures, articulation and timeline animation (none survive in `.mvscene`). `animation` (auto when the timeline has tracks) exports glTF animations (30 fps resampled, pivots composed, hierarchy preserved); `texture_size` (number or `low/medium/high/xhigh`) caps texture resolution on write — the non-destructive LoD path. UV convention handled per texture source (glTF round-trips are bit-exact). Verify: re-`load_model` the file → `get_state().animation` + a screenshot. |
| `save_scene` | Persist the composed scene as a `.mvscene` manifest: per-object source + placement transform + visibility/opacity, plus scene lighting/environment/background — **v2** adds hierarchy (`parent`), pivots, and the keyframe timeline (index-based references, bounded). Objects from volatile sources (drag-drops, split parts) can't persist and are reported; sculpt/paint deltas need `export_model`. |
| `load_scene` | Rebuild a composed scene from a `.mvscene` file (replaces the current scene). Unresolvable objects degrade per-object; the rest load. Archive-member sources are app-only. |
| `open_in_app` | Push the model you are inspecting — plus your current camera pose — into the **running MeshVault app** (`meshvault`), live, so a human co-reviews exactly what you see. Discovers the app via `~/.meshvault/app_session.json` (override: `MESHVAULT_APP_URL` + `MESHVAULT_TOKEN`). Returns `{clients, deep_link}`; when no tab is connected, hand the human the `deep_link` (the app honors `?path=`/`?dir=`/`?scene=` deep links). |
| `get_app_state` | The reverse of `open_in_app`: read **what the human is looking at** in the running app — current asset path, camera pose, and freshness (`age_seconds`). Continue their session headless: `load_model` the returned path, then `viewer_execute {action:"set_camera"}` with the returned camera. |

Typical flow:

```
load_model { source: "/path/to/model.glb" }        → loads + describes in one call
viewer_execute { action: "get_mesh_stats" }         → numeric surface quality + defect locations
screenshot { best_view: true, preset: "studio" }    → reproducible hero shot from the semantic front
screenshot { views: ["front","left","45,20"] }      → walkaround in one call
viewer_execute { action: "focus",
                 params: { id: 0 } }                → frame a specific part
compare_models { reference: "v1.glb",
                 candidates: ["v2.glb","v3.glb"] }  → geometric diff of iterations
open_in_app {}                                      → human co-views your model + camera, live
get_app_state {}                                    → what is the HUMAN looking at? (path+camera)
load_model { source: "b.glb", add: true,
             transform: {position: [2,0,0]} }       → compose a scene (does NOT clear)
save_scene { path: "/abs/scene.mvscene" }           → persist the composition
```

### Composing scenes (backlog 042)

`load_model` REPLACES the scene by default; `add: true` composes. Placement lives on
a per-object wrapper — never baked into geometry — and is driven through viewer
commands (`viewer_execute`): `list_objects`, `set_active_object {id}`,
`set_object_transform {id, position, quaternion|rotation, scale}`,
`set_object_visible/opacity`, `remove_object`, `reset_object_transform`, `frame_all`,
`get_scene_manifest`. Rules an agent must know:

- Single-object commands (describe/stats/transform-bakes/focus/animation) target the
  **ACTIVE** object — the one loaded/added last, or chosen with `set_active_object`.
  `describe_scene` says this explicitly and adds a `scene` section with per-object
  summaries and scene totals when more than one object is loaded.
- Camera presets/`orbit`/`frame` frame the ACTIVE object; use `frame_all` before
  scene-wide screenshots.
- `compare_models` refuses to run while a composed scene is loaded (its sequential
  loads would destroy it) — `save_scene` first, or `unload`.
- Vertex-bake ops (`center`/`ground`/`rotate`/`auto_orient`/`simplify`) normalize the
  active object in its OWN local frame and are blocked on skinned models; use
  `set_object_transform` for scene placement.
- GLB export includes every VISIBLE object with placements applied (authored
  materials, never viewer overrides); OBJ export stays active-object-only.

### Sculpting, painting, primitives (backlog 045)

Agents create and modify 3D content through `viewer_execute` — the same brush both a
generator and a repair agent would use. All brushes are **world-space**; get
coordinates from `pick` (screenshot pixel → surface point), `raycast` (world ray →
surface point), `get_bounds`, or describe_scene mesh centers.

```
viewer_execute { action: "add_primitive",
                 params: { kind: "sphere", color: "#c08850" } }
viewer_execute { action: "sculpt",
                 params: { tool: "draw", center: [0,0.9,0], radius: 0.3,
                           strength: 0.15 } }          → {affected, maxDisplacement, newSize}
viewer_execute { action: "paint",
                 params: { center: [0,1,0.4], radius: 0.2, color: "#aa2200",
                           opacity: 0.9 } }            → {painted, meanAlpha}
screenshot { width: 256, height: 256, ssao: false }    → cheap proof render
viewer_execute { action: "pick",
                 params: { x: 0.44, y: 0.6, width: 256, height: 256 } }
                                                       → {point, normal, objectId}
```

Rules an agent must know:

- **Primitives** (`add_primitive`): box/sphere/cylinder/cone/torus/plane/capsule with
  sculpt-friendly segment defaults and non-overlapping, paint-safe UV atlases. `color`
  is honored exactly. Unknown `params` keys are rejected; segments cap at 256/axis.
  Cylinder/cone caps are triangle fans — paintable, poor sculpting targets.
- **Sculpt** (`sculpt`, `sculpt_stroke` ≤64 points/call): tools draw / inflate /
  smooth / flatten / pinch / grab / **hinge**; `radius` world units or `radius_rel`
  (fraction of the object's bounding-sphere radius — scale-free). `hinge` is the
  POSE brush (049 field ask): `{pivot, axis, angle_deg}` rotates the brush region
  RIGIDLY about the pivot line, falloff-weighted — a jaw drop or wing flex in one
  stamp where radial grabs translate a blob and smear the lips; `center`+`radius`
  still select the region (chin), the pivot is the rotation origin (jaw hinge).
  Edits are seam-safe (welded positions), instancing-aware, and correct under any
  placement. Quantified returns ({affected, maxDisplacement, newSize}) let you
  steer without a render; a missed brush is an ERROR that says how to fix it.
  `reset` restores pre-sculpt geometry. Skinned models are refused. Strokes take
  explicit `points` OR a parametric `path` ({type:"circle", center, axis, radius,
  sweep_deg?} / {type:"line", from, to}) that the server samples at the correct
  density — rings, bands, arcs and lines with zero external math.
- **Paint** (`paint`, `paint_stroke`, `fill_paint`, `clear_paint`): real
  CanvasTexture layers over the existing texture (or authored base color). `opacity`
  is the MAX alpha per call (overlapping stamps never exceed it — no double-blend
  artifacts); `meanAlpha` in the result flags near-invisible paint before you spend a
  render. `shape:"square"` stamps crisp tangent-plane quads (checkers, panels);
  `max_normal_angle` stops paint wrapping around hard edges (≈45° for boxes). Colors
  blend in sRGB and land exactly as requested. Requires UVs (primitives always
  qualify; STL/PLY error clearly). Budgeted at ~16M texels per session.
- **Aim** (`pick`, `raycast`): `pick {x, y, width, height}` converts normalized
  screenshot coordinates (y DOWN, top-left origin) into a surface point — ALWAYS pass
  that screenshot's width/height, and re-pick after camera moves. `raycast {origin,
  direction}` is the camera-independent variant.
- **Batch** (`batch {commands: [...]≤32}`): one round-trip for stamp sequences
  (e.g. 8 raycasts + 8 paint stamps). Stops at first error by default; cannot nest.
- **Cameras for tableaus**: `orbit` / `set_view` accept `scope:"scene"` to frame the
  whole composition from any angle; `frame_all` keeps the current direction.
- **Persistence**: sculpt/paint deltas are session state. `.mvscene` manifests
  rebuild pristine sources — `save_scene` warns (`unsaved paint/edits`) when the
  scene carries unexported work; `viewer_execute {action:"export_glb"}` bakes
  sculpted geometry AND painted textures into a self-contained file. `list_objects`
  exposes `painted` / `sculpted` / `modified` (union) flags per object — a precise
  audit trail without a screenshot.

### Inspect, repair, articulate, animate (backlog 046)

All through `viewer_execute`; quantified returns everywhere (renders cost seconds
on SwiftShader, numbers cost nothing).

```
viewer_execute { action: "inspect_region", params: { grid: 4 } }
    → cells sorted by simplification OPPORTUNITY (flat × dense), each with
      ready-to-use center+radius
viewer_execute { action: "simplify_region",
                 params: { center: [...], radius: 0.5, ratio: 0.3 } }
    → {region: {trianglesBefore, trianglesAfter}, achievedRatio, locked{ring, seams}}
      — boundary ring LOCKED (no cracks), UV seams locked (no tears)
viewer_execute { action: "fix_mesh", params: {} }
    → per-op counts + {openEdges, degenerate} before/after deltas
viewer_execute { action: "clone_paint",
                 params: { from: [clean donor], to: [defect], radius: 0.08 } }
    → {cloned, meanAlpha} — world-space heal brush (donor within 45° of the
      defect's surface orientation; blur_paint softens the boundary)

viewer_execute { action: "detect_parts" }        → parts + partitionId (honesty
      notes: fused single-component meshes are NORMAL for image-to-3D output)
viewer_execute { action: "split_object", params: { axis: "y", at: 1.29 } }
    → {created: [{objectId, suggestedPivot, ...}], openEdgesAdded, capped, note}
      (plane cuts CAP by default — flat median-rim-colored caps close both
      sides, sweeps open wide; cap:false opts back into HOLLOW faces)
viewer_execute { action: "set_pivot", params: { id: 2, point: <suggestedPivot> } }
viewer_execute { action: "set_parent", params: { id: 2, parent_id: 1 } }
viewer_execute { action: "set_keyframe",
                 params: { id: 2, time: 0.8, rotation: [-12, 0, 0],
                           easing: "ease_in_out" } }
    → teaching notes on short-arc (>120° steps) AND the 360°=identity trap
screenshot { times: [0, 0.5, 1, 1.5, 2, 2.5] }   → auto-framed motion sheet
export_model { path: "/abs/nod.glb", texture_size: "medium" }
```

Traps the tools teach in-line: brushes target the ACTIVE object (after a split
the NEW part is active — miss errors name the object your point actually sits
on); full-turn rotation keys collapse to identity (key ≤120° steps); sculpt/
paint/pick refuse while the timeline plays; `reset` after a split restores the
SPLIT state.

### Morph targets — the talking face (backlog 049)

```
viewer_execute { action: "begin_morph" }             → base pose snapshot
   … sculpt the pose (hinge = the jaw/flap brush) …
viewer_execute { action: "capture_morph", params: { name: "jaw_open" } }
    → {deltaVertices, maxDelta, budget} — base auto-restores for the next pose
viewer_execute { action: "set_morph", params: { name: "jaw_open", weight: 0.6 } }
viewer_execute { action: "set_keyframe",
                 params: { id: 1, time: 0.8, morphs: { jaw_open: 0.8 } } }
export_model { path: "/abs/talk.glb" }               → glTF morph targets + weight tracks
```

Semantics an agent must know (all learned in live field tests): morphs ride
`export_glb`/`export_model` — NOT `.mvscene`; `reset`/`simplify`/`split_object`
DROP them loudly. Reloaded GLB morphs are **drive-only**: `set_morph` and
keyframes work on them (`result.source: "imported"`), `capture_morph`/
`delete_morph` don't, and `begin_morph` refuses so imported targets are never
discarded. Sculpting refuses while ANY influence is nonzero (imported or
captured); plain paint aims at the DISPLAYED morphed surface; blur/clone/mirror
heal brushes refuse while morphed (their correspondences are base-space).
Budgets: ≤8 morphs/object, a session delta budget, and a GPU render-cost budget
(vertices × morphs — every target is shaded every frame; the teaching error
says to simplify first or delete poses. On software renderers the ceiling is
~512k vertex-morphs; exceeding it used to wedge the viewer beyond recovery).

### Render presets (`screenshot { preset }`)

A preset pins **every** pixel-affecting lighting/background variable (IBL enabled +
intensity, key/fill/ambient light intensities, key light direction, tone-mapping
exposure, background color) to fixed documented values, so two screenshots of the same
model from the same angle are comparable across sessions, machines, and agents — even
when a session tweaked its lights beforehand. Measured cross-session reproducibility:
mean per-channel difference 0.03/255 on SwiftShader. The preset stays active for the
session afterwards (state, not a temporary override).

| Preset | Look | Values |
|--------|------|--------|
| `studio` | The app's factory look — balanced key/fill + IBL | env 1.0 · key 1.2 @ az 45°/el 60° · fill 0.5 · ambient 0.3 · exposure 1.2 · bg `#33373f` |
| `neutral` | Even, low-contrast light on mid-gray — for color/texture comparison | env 1.0 · key 0.8 @ az 45°/el 55° · fill 0.6 · ambient 0.5 · exposure 1.0 · bg `#808080` |
| `dark` | Presentation hero — stronger key on near-black | env 1.2 · key 1.5 @ az 45°/el 60° · fill 0.4 · ambient 0.2 · exposure 1.1 · bg `#0d0d1a` |

### Sharing a session with a human (`open_in_app` / `get_app_state`)

The MCP viewer is headless; the human's `meshvault` app is a separate process. When
both run on the same machine as the same user, the bridge works in both directions:

1. The app publishes `{url, token}` to `~/.meshvault/app_session.json` (0600) at launch.
2. `open_in_app` reads it and POSTs your current model path + camera to the app's
   `/api/agent/open` endpoint (path-confined + token-authenticated like every API route).
3. Every open app tab receives the push over `/api/events` (SSE) and loads the same
   file with your exact camera pose. If the same model is already on screen, only the
   camera moves.
4. In the other direction, tabs report their asset + camera (~2 s cadence) to
   `/api/agent/state`; `get_app_state` reads it so you can load the human's model and
   reproduce their exact view headless.

Notes: the pushed model must exist as a **local file** (URL-loaded models: the CORS
fallback's temp download is pushable; direct browser loads are not — export first).
If the app runs confined (`MESHVAULT_ROOT`), the push is rejected for paths outside
its roots (403). `clients: 0` means no tab was listening — share the returned
`deep_link` instead.

Robustness: the session file is written only after the app has actually bound its
port (a launch that fails to bind publishes nothing), and discovery pid-probes the
file's publisher — a file left behind by an uncleanly killed app (SIGKILL) is
detected as stale, removed, and reported as `stale session file (pid N dead)` instead
of sending pushes to whatever answers that port. To reproduce a camera pose manually,
use the viewer command: `viewer_execute {action:"set_camera", params:{position,
target, fov}}`.

### Being watched (observation seat) and the local-LLM pilot

While the app runs, every MCP session automatically publishes its executed
mutations as an observe-seat session — a human clicks the eye icon in the app
and watches your strokes live (persistent influence ring + tool readout).
Set `MESHVAULT_SESSION_LABEL` in the server's environment to name your session
in that list (default `mcp`).

`examples/pilot/` ships a complete local-agent reference: a LangGraph REPL
agent on LM Studio (Qwen-class models) that drives these tools with
interruption support — type while it works to redirect it. See
`examples/pilot/README.md`.

### In-app AI (Spotlight command bar)

The app embeds the same local-LLM loop with zero setup beyond LM Studio:
press **⌘K** (or the sparkle toolbar button), type "add a red sphere and dig
a crater into it", and a backend agent (`backend/ai_pilot.py`) executes every
tool call **inside your own tab** — you watch your scene change live, no
observation seat needed. The AI panel (top right) streams the transcript;
Stop halts at the next safe boundary; typing a new ⌘K instruction while a
task runs delivers it as a mid-task course correction.

Configuration (environment of the `meshvault` process):

- `MESHVAULT_AI_URL` — OpenAI-compatible server (default
  `http://127.0.0.1:1234/v1`, LM Studio's default).
- `MESHVAULT_AI_MODEL` — model id substring; default prefers whatever is
  already loaded in LM Studio memory (memory-polite), falling back to a
  Qwen-class model.

Honest limits: the agent is text-only (screenshots are saved to
`/tmp/meshvault_ai_shots`, it works from quantified results); one task runs
at a time; a task dies honestly if its tab closes (three consecutive 60 s
command timeouts).

### Interpreting `compare_models`

- **classification** is the headline: `identical` (exact/compressed copy), `near_identical`
  (minor decimation/remesh), `same_shape_modified` (same object, substantial edits),
  `different`. When `borderline: true` or `warnings` is present, treat the label as
  uncertain and confirm with screenshots — a scalar distance cannot cleanly separate
  "heavily modified same object" from "similar different object".
- **distances** are normalized by the reference bounding-box diagonal, so they compare
  across scales. `*Normalized` chamfer values are the EXCESS above the sampling-noise
  floor (measured from two samplings of the reference); Hausdorff is raw (nonzero even
  for identical surfaces at finite sampling — use it relatively).
- **alignment.scaleRatio** catches unit mismatches (a meters-vs-centimeters export reads
  as scale 0.01, classification still identical). **rotationDeg** is reliable for
  asymmetric shapes; for near-symmetric shapes (spheres, cubes) the angle is ambiguous
  and should not be trusted (classification still is).
- Registration uses deterministic area-weighted surface samples, so results are
  reproducible. Increase `samples` for finer detail; the default 4096 is the sweet spot
  (higher counts cost roughly quadratic time in the numpy registration).
- **Known limits**: registration of a candidate that overlaps only PARTIALLY with the
  reference (a large missing region, or a scan of a fragment) is ill-posed — the
  `alignment` rotation/scale can be wrong; rely on `asymmetry` (which flags the missing
  region) and `classification` there, not the transform. Near-symmetric shapes give
  ambiguous rotation angles. Mirror images are reported via a `warnings` note, not
  registered as identical (a left/right pair is not the same object).

Runnable, commented examples — including a real multi-model investigation workflow —
live in [`examples/mcp/`](../examples/mcp/README.md).

Formats: `.obj .fbx .gltf .glb` (incl. Draco / KTX2-Basis / Meshopt compressed) `.stl
.ply .dae .3mf .usdz`.

## Behavior and limits

- **Transport**: stdio. All logging goes to stderr; stdout carries only JSON-RPC.
- **Large payloads**: strings over ~2 KB inside `viewer_execute` results (data-URL images
  from `capture_views`/`turntable`, `export_glb` payloads) are truncated with an
  explanatory note — use the `screenshot` tool (single or `views` batch, max 12 per call)
  for images.
- **Parallel calls in one session**: only `load_model`'s load→describe pair is
  serialized. Other tools fired concurrently with a load are safe but may observe the
  previous model (one shared scene) — sequence your calls when it matters.
- **Failed loads keep the current model**: a bad URL/path returns `{ok:false, …}` and the
  previously loaded model stays intact.
- **Lifecycle**: the browser and loopback file server start lazily on the first tool call
  (~5–7 s once) and shut down with the client session; subsequent calls are fast
  (JSON commands ~10 ms; renders depend on resolution and GPU/SwiftShader).

## Remote servers (SSH, no display)

The server is fully headless — no display server, no GPU, no window manager required.
On a fresh Linux box:

```bash
pip install "meshvault[mcp]"          # or from source: pip install -e ".[mcp]"
playwright install --with-deps chromium   # --with-deps pulls the system libraries
```

Then either run it over SSH stdio directly from your local MCP client:

```json
{
  "mcpServers": {
    "meshvault-remote": {
      "command": "ssh",
      "args": ["user@server", "meshvault-mcp"]
    }
  }
}
```

…or use it inside agents running on the server itself (same config, `"command":
"meshvault-mcp"`).

Sizing guidance (measured): ~0.9 GB RAM per session (own headless Chromium), first tool
call ~6 s (browser start), JSON tools ~10 ms, screenshots seconds-range on software GL.
Plan roughly one CPU core + 1 GB per concurrent agent session; ≤5 parallel sessions per
host is the comfortable range. Load models by absolute path on the SERVER's filesystem,
or by URL.

## Security notes

- The internal HTTP server binds **loopback only** on an ephemeral port; it serves the
  viewer bundle (path-confined to the package's `frontend/`) and explicitly registered
  model files under unguessable 128-bit tokens. Nothing is reachable off-host.
- `load_model` accepts any local path readable by the user running the server — same
  trust model as the agent having shell access. Point the client config at a restricted
  user if that matters in your setup.
- The CORS-fallback download fetches arbitrary URLs server-side (512 MB cap). This is
  fine for a local single-user tool; do not front this server with untrusted callers.

## Troubleshooting

- *"Could not launch Chromium"* → run `playwright install chromium`.
- First call is slow → lazy browser start; subsequent calls are fast.
- A URL loads in your browser but fails here with a CORS mention and a download error →
  the host likely blocks non-browser user agents; download the file and load it by path.
