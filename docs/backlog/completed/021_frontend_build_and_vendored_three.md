# 021 — Frontend Build + Vendored Three.js (Offline + SRI)

**Priority**: Medium
**Effort**: Medium
**Category**: Architecture / Supply chain
**Status**: Proposed
**Created**: 2026-07-05

## Summary

Three.js is loaded only from jsdelivr via an importmap, with no bundling and no Subresource
Integrity. The app does not load offline, cannot cleanly add npm dependencies, and trusts a CDN
with no integrity check — all of which undercut the advertised `pip install` / `npx meshvault`
"just works" promise.

## Reason

- Code review: `frontend/index.html:11-18` importmap points at `cdn.jsdelivr.net`; offline =
  blank app. No SRI = supply-chain exposure. No bundler = can't tree-shake or add deps.

## Sketch of scope

- Vendor Three.js (and addons actually used) into the package so it ships with pip/npx and works
  offline. Serve from the app's own `/static`.
- Optionally introduce a light build step (esbuild/vite) for bundling + minification; keep the
  zero-config dev story if possible.
- Add SRI/pinned versions for anything still remotely fetched.

## Decision boundaries

- Full bundler vs just-vendor-the-files. Vendoring alone fixes offline + SRI with least churn;
  a bundler is only needed once npm deps grow.

## Dependencies

- Precursor that eases `022` (refactor) and any feature needing npm packages.

---

## Completion

**Status**: Completed · **Completed**: 2026-07-05

Frontend now bundled with **esbuild** (`scripts/build.mjs`, `npm run build`) into a
self-contained `frontend/dist/app.bundle.js` with Three.js vendored in — no CDN, no
importmap, no SRI needed. `frontend/dist/` is committed (un-ignored in `.gitignore`) so it
ships via pip/npx and end users need no Node toolchain. Verified offline: with every
non-localhost request blocked in a headless browser, the app boots and the viewer
initializes with **zero external requests** and no console errors. `three` + `esbuild`
added as `devDependencies` only.

Not yet done (deferred): the second bundle entry point for a standalone embeddable viewer —
that ships with the `022` viewer-core extraction. `scripts/build.mjs` already has the entry
declared (commented) so it's a one-line add once the module exists.
