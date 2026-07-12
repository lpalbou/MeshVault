# 0053 — The abstract3d → MeshVault pipeline as one documented recipe

- **State**: completed
- **Created**: 2026-07-11
- **Completed**: 2026-07-12 (v0.8.0)

## Completion

All three deliverables shipped, exercised end-to-end from a REAL text prompt
("a wooden treasure chest with a curved lid" → TripoSR, ~2.5 min, watertight
131k-triangle bundle):

- `examples/t23d_pipeline.md` — the agent recipe (ratio-based decision gates,
  12-trap field-verified list, screenshot discipline, MCP-vs-raw-surface
  notes).
- `examples/t23d_pipeline.py` — the library-shaped variant over the new
  `backend/headless_viewer.HeadlessSession` facade (extracted per the design
  review so `mcp_server._Runtime` and embedders share ONE load path — the
  blackpixel embedding reference). abstract3d runs as a CLI subprocess in its
  own env; `--bundle` reuse is the resource-negotiation path (a Hunyuan
  harness was mid-diffusion on the shared GPU throughout this work).
- `examples/t23d_pipeline_report.md` + committed contact sheet; full proof
  packs out-of-repo (`~/MeshVault_assets/proofs/t23d_pipeline/run_chest*`).

The FRESH-AGENT gauntlet (acceptance criterion) produced the full artifact
chain unaided and found 7 doc defects + 6 doc-vs-script disagreements — all
folded back. Its two most valuable: `explode_view` verdicts were meaningless
on parented parts (ENGINE bug: subtree-union boxes gave parent and child one
centroid — fixed with model-scoped boxes + hierarchy-aware world targets;
minGapWorld now +1.408 and factor-scaling), and the chest-lid cut default was
a mislabeled guess (measured seam 43.3% vs the naive 62% — now a 45% class
prior with pick-first guidance; hinge placement is THE judgment point of the
chain). The optimize gate also gained the uniform-density branch (over-budget
uniform meshes route to GLOBAL simplify — the relative gate can never fire on
them by design).

Final audit: verdict records complete and honest; export round-trip
re-verified independently (1 clip, triangles conserved, deterministic
paused-clip render). SHIP WITH NOTES — the one note (report table mixed v1
wall times with v2 outcomes) fixed same-day.

Honest run shape (declared before the run, held): repair NO-OP, optimize
NO-OP with numbers, articulation real (fused component → plane cut),
animation real, round-trip verified. One judgment point in the whole chain.
- **Origin**: user-confirmed direction (2026-07-11): "t23d generate → intake →
  repair → adaptive-optimize → articulate → animate → export, packaged as a
  single documented recipe. Everything exists now; nobody has run the chain
  end-to-end from a text prompt yet."

## Context

Every stage shipped between 045 and 047 but has only been exercised piecewise.
The recipe is the integration test for the whole thesis — an agent takes a
text prompt and returns a repaired, optimized, articulated, animated GLB with
proofs. Two forward-looking constraints from the user:

- abstract3d is expected to deliver BETTER models out of the box over time —
  the recipe must degrade gracefully into "intake was already clean, repair
  stage was a no-op with evidence", not assume broken input.
- These capabilities are candidates for integration into **blackpixel** (the
  user's app unifying image and video); the recipe should therefore be
  callable as a LIBRARY-SHAPED flow (steps in, artifacts out), not only prose.

## Deliverable

1. `examples/t23d_pipeline.md` — the agent recipe: exact MCP tool sequence per
   stage with decision points (when to simplify, when to split, what proof to
   capture), written against the 13-tool surface.
2. `examples/t23d_pipeline.py` — a scripted version driving the same flow over
   the control API (abstract3d CLI/API call → load → get_mesh_stats/fix_mesh →
   inspect_region → simplify_region → detect_parts/split/set_pivot →
   set_keyframe ladder → export_model), each stage emitting its proof artifact
   into an output folder with an INDEX.md (047 proof-pack conventions).
3. One full run committed as evidence (prompt → final animated GLB), including
   the timing and where the chain needed judgment vs automation — this is the
   field report that tells us what blackpixel would actually consume.

## Constraints

- Resource negotiation with abstract3d on the same machine (MPS busy →
  generation queues; MeshVault stages are CPU/SwiftShader — the 046/047
  protocol: check abstract3d's queue before generating, reuse existing outputs
  when equivalent).
- No special-casing per model: stage decisions must come from inspection
  numbers (density percentiles, openEdges, partition counts), not from
  knowing the test asset.

## Acceptance

- A fresh agent given only the recipe doc + a text prompt produces the full
  artifact chain unaided; the scripted variant reproduces it headless.
