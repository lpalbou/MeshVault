# 0053 — The abstract3d → MeshVault pipeline as one documented recipe

- **State**: planned
- **Created**: 2026-07-11
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
