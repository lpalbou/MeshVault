# MeshVault MCP Server

Drive the MeshVault 3D viewer from any MCP client (Claude Desktop, Claude Code, Cursor,
VS Code, …). The server runs a headless, GPU-optional viewer and exposes **seven tools** —
a deliberately thin surface routed through the viewer's self-describing control API
(one-tool-per-command surfaces measurably degrade agent performance).

An agent can: load a model from a **URL or a local file path**, get a structured text
description (no vision needed), discover and run any of the ~48 viewer commands (camera,
render modes, lighting/IBL, transforms, cross-sections, measurement, animation), and get
PNG screenshots back as proper MCP image content.

## Install

```bash
pip install "meshvault[mcp]"       # from the next PyPI release onward
playwright install chromium        # one-time headless browser download
```

Until a release including the MCP server is published, install from source:

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
| `load_model` | Load a model from an http(s) **URL** or an absolute **local file path**. Returns the load result *plus* a full scene description in one call. URLs are fetched by the browser first; on CORS failure the server downloads the file itself (512 MB cap) and serves it locally. |
| `describe_scene` | Structured TEXT snapshot: summary sentence, live inventory, bounds + real-world size hint, hierarchy, materials, detected geometry issues (missing normals/UVs, degenerate faces, watertightness, flipped normals, scale sanity), current view. The recommended first observation — no vision needed. |
| `viewer_execute` | Passthrough to any viewer command (`{action, params}`): camera presets/orbit, `find_best_view` (semantic front + auto-upright), render modes, lighting + IBL, clipping planes, rotate/center/ground/simplify, measurement, animation. Returns `{ok, result | error}`, never throws. |
| `list_viewer_commands` | Every action with its parameter schema (types, ranges, defaults). Call once, then use `viewer_execute`. |
| `get_state` | Compact state snapshot (model, camera, display, animation, lighting) — verify a command's effect without a screenshot. |
| `compare_models` | Compare ONE reference against N candidates (1–8) **geometrically**, via shape registration — not screenshots. Per candidate: `alignment` (uniform scale ratio, rotation angle, translation — how it had to be transformed to match; unit mismatches surface as the scale ratio), `distances` (symmetric chamfer mean/p95 + Hausdorff, normalized by the reference bbox diagonal, floor-corrected for sampling noise; `asymmetry` flags missing/extra regions), `classification` (identical / near_identical / same_shape_modified / different, with `borderline` + `warnings`), and `structural` count/inventory deltas. Returns `rankingBySimilarity`. Reference or candidates may be paths or URLs; `align:false` compares in place (detects pose changes). |
| `screenshot` | Render the model as MCP **image content** (PNG, 16–8192 px), with a JSON metadata text block first. `best_view: true` moves to the model's most detailed angle (the chosen azimuth/elevation/score come back in the metadata). `views: ["front","left","45,20"]` captures several angles — presets or "azimuth,elevation" degrees — in ONE call, images returned in order. |

Typical flow:

```
load_model { source: "/path/to/model.glb" }        → loads + describes in one call
viewer_execute { action: "get_mesh_stats" }         → numeric surface quality + defect locations
screenshot { best_view: true }                      → hero shot from the semantic front
screenshot { views: ["front","left","45,20"] }      → walkaround in one call
viewer_execute { action: "focus",
                 params: { id: 0 } }                → frame a specific part
compare_models { reference: "v1.glb",
                 candidates: ["v2.glb","v3.glb"] }  → geometric diff of iterations
```

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
