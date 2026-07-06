# 039 — Agent capture ergonomics: multi-view MCP screenshots, best-view metadata, A/B compare

**Priority**: Medium-High
**Effort**: Medium
**Category**: MCP / agent workflows
**Status**: Done (2026-07-06) — A/B compare shipped as `compare_models`; browser pooling deferred
**Created**: 2026-07-06

## Delivered 2026-07-06

- Multi-view capture: MCP `screenshot {views: ["front","left","45,20", ...]}` — presets
  or "azimuth,elevation" degrees, images returned in order, ONE call. Capped at 12
  views/call (a 20-view probe took 72 s and ~14 MB — over some MCP clients' result
  limits); empty list is an explicit error, invalid specs error before rendering.
- `best_view` metadata: the chosen azimuth/elevation/score now return in a JSON metadata
  text block that precedes the image(s) in every screenshot result.
- Vertex-count bases documented (get_state = welded unique; describe = attribute sum).
- `load_model` race fixed (serialized load→describe).

## A/B compare — DONE (2026-07-06)

Shipped as the `compare_models` MCP tool + `sample_points` viewer command +
`backend/mesh_compare.py` registration engine (see CHANGELOG). Geometric 1-vs-N
comparison with classification, alignment recovery, similarity ranking; 4-agent
adversarial review, unit tests in `tests/test_mesh_compare.py`, example in
`examples/mcp/compare_shapes.py`.

## Remaining (moved forward)

- Shared browser pool / GPU path for >5 concurrent sessions (~0.9 GB RSS each today) —
  see `proposed/browser-free/`.
- Automated tests for `backend/mcp_server.py` MCP surface (the compare ENGINE is now
  tested; the server tools are still exercised only manually / by the examples).
- Partial-overlap registration (robust to >25% missing region) — documented limitation.

## Summary

Capture is the dominant cost and friction source in real agent sessions (85% of a 92 s
inspection was rendering; a 45-shot materials battery took ~10 minutes on software GL).
Three concrete ergonomics gaps from the field test:

1. **`capture_views`/`turntable` are unusable over MCP** — their data-URL payloads are
   truncated by design in `viewer_execute`. Every angle costs two calls
   (orbit + screenshot). The MCP `screenshot` tool should accept a `views` list (or a
   sibling `capture` tool) returning MULTIPLE MCP image contents in one result.
2. **`screenshot {best_view:true}` discards the metadata** — the chosen azimuth/
   elevation/score are computed then thrown away, and the call took 62 s with no way to
   reuse the result. Return the view metadata alongside the image, and/or cache the
   scoring per model.
3. **No A/B comparison** — the viewer is single-slot, so comparing pipeline iterations
   (the single most natural MCP use case observed) is manual bookkeeping across loads.
   Options: a `compare_models {a, b}` MCP tool producing a joint numeric diff
   (counts/bounds/materials/issues delta) + optional side-by-side renders; or a second
   viewer slot in the harness page.

## Also worth noting (performance, not blocking)

- ~0.9 GB RSS per MCP session (own Chromium); ≤5 concurrent agents is the honest limit.
  A shared browser pool / GPU rendering path would lift it — separate item if needed.
- `get_state.model.vertices` (loader stats) vs `describe_scene` (attribute sum) counts
  differ without explanation; align or document (small fix, could land independently).

## Evidence

- Concurrency field test (2026-07-06): timings table, truncation repro, memory profile.
- Geometry + materials field tests independently flagged multi-view capture and compare.
