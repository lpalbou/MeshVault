# MeshVault Viewer — light static site (GitHub Pages)

A client-only, server-less build of the MeshVault 3D viewer: `index.html` loads the
self-contained bundle `meshvault-viewer.js` (Three.js included), supports drag-and-drop /
file-open / `?src=<url>`, and exposes the control API on `window.mv` for embedders and
AI agents. Nothing is uploaded — models are read in the browser.

## Build

```bash
npm ci
npm run build          # produces web/meshvault-viewer.js (from frontend/js/viewer/standalone.js)
```

Serve locally to test:

```bash
cd web && python3 -m http.server 8799   # → http://localhost:8799
```

The two files that make up the deployable site are `web/index.html` and the built
`web/meshvault-viewer.js`. The bundle is self-contained (no source dependency), so those
two files ARE the entire site.

## Deploy — option A: this repo's `gh-pages` (simplest)

The workflow `.github/workflows/pages.yml` builds the bundle and publishes `web/` to the
`gh-pages` branch on every push to `main` that touches the viewer/site (and via manual
"Run workflow"). To finish setup once:

1. Push these files to `main` (the workflow needs `contents: write`, already set).
2. GitHub → **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   Branch: **`gh-pages`** / `(root)`.
3. Site goes live at `https://<user>.github.io/<repo>/` (e.g. `.../meshvault/`).

Relative asset paths are used, so it works under the `/<repo>/` sub-path with no config.

## Deploy — option B: its OWN repo

Because the bundle is self-contained, a dedicated public repo can host just the two built
files. Two ways:

- **Manual (no build in the new repo):** create the repo, then copy `web/index.html` and
  the built `web/meshvault-viewer.js` into it (rename to `index.html` + `meshvault-viewer.js`
  at the repo root), add an empty `.nojekyll`, push to `main`, and enable Pages on `main`.
  Re-run whenever you rebuild the bundle here.

- **CI push to the external repo:** in `.github/workflows/pages.yml`, add to the
  `peaceiris/actions-gh-pages` step:
  ```yaml
  external_repository: <user>/<viewer-repo>
  deploy_key: ${{ secrets.PAGES_DEPLOY_KEY }}   # an SSH deploy key with write access
  ```
  (Generate a key pair; add the public key as a Deploy Key with write access on the target
  repo, and the private key as the `PAGES_DEPLOY_KEY` secret on this repo.) The built site
  is then pushed to the target repo's `gh-pages` branch automatically.

## Custom domain

Add a `web/CNAME` file containing your domain (e.g. `viewer.example.com`); it will be
copied into the published site. Configure the DNS `CNAME`/`A` records per GitHub's docs.

## Embedding elsewhere

```html
<iframe src="https://<user>.github.io/<repo>/?src=https://host/model.glb"
        width="800" height="600" style="border:0"></iframe>
```
Or import the bundle directly and drive it via the control API:
```js
import { createViewer } from "https://<user>.github.io/<repo>/meshvault-viewer.js";
const mv = createViewer(document.getElementById("app"));
await mv.execute({ action: "load", params: { url: "model.glb" } });
```
