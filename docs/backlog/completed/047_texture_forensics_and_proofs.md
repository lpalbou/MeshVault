# 0047 — Texture forensics, screen-space repair, articulation/animation proofs

- **State**: completed (2026-07-11, v0.7.0, with 045/046)
- **Origin**: user validation feedback on 046 — (1) the portrait repair must
  address the UV misalignment ("eyes too high"; shift vs stretch = open
  question for the agent to investigate with full access to visuals, texture
  and UV coordinates over MCP); (2) ALWAYS show proofs for finished work
  (e.g. Jupiter textures at each resolution); (3) articulation proofs =
  EXPLODED views + the GLB for every task; (4) animations need standard
  serialize/deserialize + in-app play/pause. 3 adversarial agents, 5 cycles,
  each cycle a significant improvement.

## Cycle log (finding → fix)

0. **Phase 0 tooling**: `pick.uv`, `get_texture` MCP tool (UV wireframe +
   markers), `transform_uv`, `explode_view`, proofs folder.
1. **Forensics agent** measured the misalignment at 3 landmarks (eyes ~+0.026v,
   mouth ~+0.013v — a per-chart warp, not a shift) and shipped an honest
   compromise (+0.015 global; mouth aligned, bleed introduced). Asks → built:
   island-scoped `transform_uv {island_of}`, `preview_uv_transform` bleed
   dry-run, chart outline + zoom crop in `get_texture`.
2. **Island agent** validated the island tools mechanically (exact scoping,
   accurate dry-runs, exact reverts) and FALSIFIED the per-chart repair for
   this asset class: 4,424 non-semantic Voronoi islands (eye and mouth share
   island #40) — every UV move trades alignment for seam blotches. Reverted to
   a pixel-identical baseline (honest negative result). Also delivered the
   Jupiter LoD ladder (4 GLBs 347 KB→3.39 MB, texel densities halving; band
   content soft, so visual degradation subtle). Asks → built: `get_uv_islands`
   (fragmentation warning up front), `project_paint` (screen-space texel
   repair — the correct fix class), marker ergonomics, stricter bleed verdict.
3. **Articulation agent** delivered the exploded-proof pack: robot arm
   (8 parts), starship swing wings, sportscar rear wheels — hero/exploded/
   articulated renders + GLBs, triangle conservation exact. Asks → built:
   `split_object {side}` (axis form extracted only the + half — silent wrong
   extraction), `keep_active`, `explode_view` world offsets + `minGapWorld`
   numeric separation verdict.
4. **Persistence agent** proved both animation formats round-trip (.mvscene
   4,056 B restoring 3 tracks; animated GLB 166 KB auto-playing on reload) and
   the app plays/pauses both (browser-verified: timeline bar + standard
   animation bar). Repaired the portrait eyes with `project_paint`
   (localized, no atlas damage; left eye limited by source-corrupted texture).
   FOUND CRITICAL: the exporter's unconditional UV V-flip scrambled every
   glTF→GLB round-trip → FIXED (flip conditional on texture flipY; regression
   test on TEXCOORD_0 V-range). Asks → built: `surface_offset` world-unit
   projection offsets, Euler round-trip in manifests.
5. **Audit agent**: re-generated the GLBs invalidated by the V-flip bug with
   the fixed exporter, audited every artifact, wrote
   `~/MeshVault_assets/proofs/INDEX.md` (the user's validation entry point).

## Honest limitations (recorded)

- The portrait's LEFT eye texture is corrupted at the source (specular streaks
  baked over the iris) — realignment relocates damage; restoration needs
  inpainting-class tools.
- Global/island UV surgery is the WRONG repair for fragmented Voronoi atlases
  — `get_uv_islands` now warns; `project_paint` is the correct class.
- `project_paint` bakes current shading into copied texels (use the neutral
  preset) and ignores occlusion (convex, camera-facing regions).
- Cut faces stay hollow; `.mvscene` persists timeline/hierarchy but not paint.

## Verification

Browser suites 35/35 + 33/33 after every fix round; V-flip regression verified
(source vs re-export TEXCOOORD_0 V-range identical; paint-layer exports still
convert); app play/pause proven by DOM probes + screenshots; proof pack
assembled and indexed.
