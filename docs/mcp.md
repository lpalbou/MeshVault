# MeshVault MCP Server

Drive the MeshVault 3D viewer from any MCP client (Claude Desktop, Claude Code, Cursor,
VS Code, …). The server runs a headless, GPU-optional viewer and exposes **nine tools** —
a deliberately thin surface routed through the viewer's self-describing control API
(one-tool-per-command surfaces measurably degrade agent performance).

An agent can: load a model from a **URL or a local file path** (multi-file assets load
textured), get a structured text description (no vision needed), discover and run any
of the ~50 viewer commands (camera, render modes, lighting/IBL, transforms,
cross-sections, measurement, animation), compare models geometrically, get PNG
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
| `screenshot` | Render the model as MCP **image content** (PNG, 16–8192 px), with a JSON metadata text block first. `best_view: true` moves to the model's most detailed angle (the chosen azimuth/elevation/score come back in the metadata). `views: ["front","left","45,20"]` captures several angles — presets or "azimuth,elevation" degrees — in ONE call, images returned in order. `preset: "studio"\|"neutral"\|"dark"` pins the **full** lighting/background state to a documented look first, so renders are comparable across sessions and agents (see below). |
| `open_in_app` | Push the model you are inspecting — plus your current camera pose — into the **running MeshVault app** (`meshvault`), live, so a human co-reviews exactly what you see. Discovers the app via `~/.meshvault/app_session.json` (override: `MESHVAULT_APP_URL` + `MESHVAULT_TOKEN`). Returns `{clients, deep_link}`; when no tab is connected, hand the human the `deep_link` (the app honors `?path=`/`?dir=` deep links). |
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
```

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
