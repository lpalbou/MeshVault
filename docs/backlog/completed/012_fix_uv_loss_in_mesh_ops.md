# 012 — Fix UV Loss in Simplify and Recompute-Normals

**Priority**: High
**Effort**: Small
**Category**: Bug / Viewer
**Target**: v0.1.1
**Created**: 2026-07-05

## Summary

Two mesh operations silently destroy texture coordinates, so textured models come out
untextured after the op. "Recompute smooth normals" backs up UVs and then never restores them;
"Simplify" deletes UVs and never restores them. Both are advertised features.

## Reason / evidence (confirmed 2026-07-05)

- Recompute normals clones the UV buffer then discards it (clone-and-forget bug):

```2280:2288:frontend/js/viewer_3d.js
                const hadUV = geo.hasAttribute("uv");
                const uvBackup = hadUV ? geo.getAttribute("uv").clone() : null;
                if (hadUV) geo.deleteAttribute("uv");
                child.geometry = BufferGeometryUtils.mergeVertices(geo, 0.0001);
                child.geometry.computeVertexNormals();
```

- Simplify deletes `normal` and `uv` before decimation and never restores UV
  (`frontend/js/viewer_3d.js` ~2576-2578).
- The FAQ discloses UV loss for *normals* only, and never for *simplify*. README/architecture
  advertise both without disclosing lossiness.

## Current code reality

- UVs are dropped to force vertex merging at seams. That is intentional *for the merge step*,
  but the UVs must be re-attached (or seams preserved) afterward.

## Scope

- Recompute-normals: re-attach the backed-up UV attribute after `mergeVertices` when index
  mapping allows, or use a merge that preserves UV seams so UVs survive.
- Simplify: preserve UVs through decimation (Three.js `SimplifyModifier` limitations may
  require an alternate approach or explicit UV re-projection). At minimum, do not silently
  discard them.
- If a given op genuinely cannot preserve UVs for a mesh, warn the user in the UI rather than
  degrading silently.

## Non-goals

- Rewriting the simplification algorithm for quality. This item is about not destroying UVs.

## Acceptance criteria / validation

- A textured GLB (e.g. `/Users/albou/3d/cmm89efit0002la04k8427nm3.glb`) still renders its
  texture after recompute-normals and after simplify.
- If preservation is impossible for a mesh, the user sees an explicit warning.
- FAQ/README/architecture updated to match actual behavior.


---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

recomputeNormals and simplify now delete only `normal`+`tangent` before `mergeVertices` and keep `uv`, so textured meshes stay textured and smoothing stops at genuine UV seams; old geometry disposed to avoid GPU leaks. `frontend/js/viewer_3d.js`.
