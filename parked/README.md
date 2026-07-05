# Parked code

Code that was implemented and reviewed but **deliberately not wired into the app**.
Kept here so the work isn't lost when/if the need becomes real. Not imported anywhere;
excluded from the runtime and the frontend bundle.

## Contents

- `library_index.py` — SQLite catalog: cross-folder search, tags, collections.
- `library_search.js` — the global search panel UI for the above.
- `thumbnail_cache.py` — server-side on-disk PNG cache for thumbnails.
- `test_library_index.py`, `test_thumbnail_cache.py` — their tests.

## Why parked

- **Library index / search / tags / collections**: speculative. Per-folder browse + the
  existing filter already cover "look at the models in a folder". Cross-folder search and
  tagging only pay off at library scale (thousands of assets across many folders), a need
  that isn't proven, and the SQLite file + background thread add server-side state that
  works against the light/embeddable + hybrid direction. See `docs/backlog/proposed/015`, `016`.
- **Server thumbnail cache**: thumbnails are kept, but the cache moved to the browser
  (IndexedDB) so the backend stays stateless. This server implementation is the fallback
  if a shared/multi-client cache is ever wanted.

## To revive

Re-promote the relevant backlog item to `planned/`, move the file(s) back into
`backend/` / `frontend/js/` / `tests/`, and re-add the endpoints + wiring (see the item's
history section for what was removed).
