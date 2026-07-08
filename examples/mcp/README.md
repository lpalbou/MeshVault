# MeshVault MCP — usage examples

Runnable, self-contained examples of driving MeshVault through its MCP server, written
the way an AI agent actually uses it. Each script connects over stdio, does one job,
and prints a report; evidence images land in an output directory.

## Setup

```bash
pip install "meshvault[mcp]"       # once the next release ships the extra;
playwright install chromium        # from a source checkout today: pip install -e ".[mcp]"
```

The examples spawn `meshvault-mcp` from PATH. To run against a source checkout instead:

```bash
export MESHVAULT_MCP_COMMAND="python -m backend.mcp_server"
export MESHVAULT_MCP_CWD="/path/to/meshvault"
```

Every script runs with no arguments (using the bundled test models) or takes a model
path/URL:

| Script | What it demonstrates |
|--------|----------------------|
| `inspect_model.py` | The canonical flow: `load_model` → structure + materials + QA issues → `get_mesh_stats` numbers → hero shot from the semantic front + clay view. |
| `compare_iterations.py` | Comparing pipeline iterations of the same asset: one table of geometry/texture/quality metrics per version, with deltas called out (including "geometry unchanged, texture-only iteration" detection). |
| `compare_shapes.py` | GEOMETRIC 1-vs-N comparison via shape registration (`compare_models`): classifies each candidate as identical / near-identical / modified / different, recovers scale + rotation, and ranks candidates by similarity — robust to pose and unit differences. |
| `explore_parts.py` | Part-level exploration: stable mesh ids from `describe_scene`, `focus {id}` per part, plus focusing a defect location reported by `get_mesh_stats`. |
| `hero_shots.py` | Multi-view capture in one call (`screenshot {views:[...]}`) and the `best_view` semantic-front shot with its metadata. |
| `co_review.py` | Shared session with a human: inspect headless, then `open_in_app` pushes the model + the agent's exact camera into the running `meshvault` app (falls back to printing a `?path=` deep link when no tab is connected). |
| `_client.py` | The ~40-line plumbing all examples share (session, JSON/text/image content helpers). |

## How an agent actually uses this — a real session

This is the (condensed) transcript of a real investigation: three iterations of a
face-reconstruction pipeline (`3d2` → `3d3` → `3d4`), analyzed **without opening a
single viewer window**.

**1. Load + first read (one call each).** `load_model {source}` returns the full
description; the summaries already carried the headline:

> `3d2`: 1 mesh, 1 material (**untextured**), 125,882 triangles … no geometry issues
> `3d3`: 1 mesh, 1 material (**1 texture**), 125,882 triangles … no geometry issues
> `3d4`: 1 mesh, 1 material (1 texture), **126,296** triangles … issues: degenerate_faces, not_watertight, non_manifold_edges

**2. Text-only reasoning.** Identical triangle counts and dimensions between 3d2 and
3d3 → the second iteration changed *no geometry*, it only added a 2048×2048 UV bake
(`materials.items[].textures` shows the resolution; `authored` showed the asset shipped
`metalness: 1.0` that the viewer clamps for display — an authoring bug in the asset).
3d4 is a genuine remesh: new counts, axes swapped (W×H×D 0.996×0.748×0.662 →
0.662×0.748×0.996), and connectivity defects appeared.

**3. Numbers where connectivity lies.** The topologically *perfect* mesh (3d2) was
visually the worst — a mass of depth spikes — while the visually best iteration (3d4)
carried the only QA warnings. `get_mesh_stats` adds the numeric layer (surface area,
volume for closed meshes, edge distribution, dihedral roughness) for tracking iterations
of the same asset. Be honest about its limits: dihedral roughness is a RELATIVE
indicator (hard-edged models legitimately score high, and dense spiky scans can score
low), so screenshots remain the arbiter for perceptual quality — the stats tell you
*what changed*, the images tell you *whether it looks right*.

**4. Eyes only where needed.** `screenshot {best_view:true}` for hero shots,
`{views:["front","left","90,10"]}` for walkarounds, `set_render_mode solid` for form
reading, `focus {point}` on defect locations from `issuePoints` to look at the 30 open
edges directly.

**Verdict from that session** (three independent agents + aggregate): v2→v3 texture-only,
v3→v4 real remesh — big perceptual win, small topological regression, plus an
unannounced 90° axis swap that would break downstream consumers.

## Practical notes

- Prefer `describe_scene`/`get_mesh_stats` over screenshots: they're ~100× faster
  (milliseconds vs seconds on software GL) and text is what agents reason over.
- Address parts by **id**, not name — real-world mesh names are mostly loader garbage
  (`mesh_0`, UUIDs, `(unnamed)`).
- `set_lighting` sweeps look inert while IBL is on; `set_environment {enabled:false}`
  first.
- Clear measurements (`clear_measurement`) before clean captures.
- Budget ~1 GB RAM per concurrent MCP session (own headless Chromium); ≤5 parallel
  sessions is the comfortable range.
