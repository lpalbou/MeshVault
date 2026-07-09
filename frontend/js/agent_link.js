/**
 * AgentLink — deep links + live agent push for the MeshVault app.
 *
 * Two responsibilities (both sides of the same "shared session" feature):
 *
 * 1. DEEP LINKS: honor `?path=` (select + load an asset) and `?dir=` (open a folder)
 *    URL parameters over the localStorage "last directory" default, and keep the URL
 *    in sync as the user navigates, so any moment of a session is shareable/reloadable.
 *    Archive members use the same composite key the app uses internally:
 *    `?path=/abs/pack.zip!inner/model.obj`.
 *
 * 2. AGENT PUSH: subscribe to the app's `/api/events` SSE stream and handle
 *    `open_asset` messages published by headless agents (MCP `open_in_app`), loading
 *    the pushed model and applying the agent's camera pose so a human co-reviewer
 *    sees exactly what the agent sees.
 *
 * The module owns URL/event plumbing only — actual loading goes through the same
 * App._onAssetSelected flow as a sidebar click, so related files (MTL/textures),
 * recents, and export state behave identically to a human-initiated load.
 */

import { ARCHIVE_KEY_RE, assetKey } from "./file_browser.js";

// Formats the viewer can load (matches the backend's SUPPORTED_MODEL_EXTENSIONS).
const MODEL_EXT_RE = /\.(obj|fbx|gltf|glb|stl|ply|dae|3mf|usdz)$/i;

export class AgentLink {
    /**
     * @param {object} deps
     * @param {import("./file_browser.js").FileBrowser} deps.fileBrowser
     * @param {(asset:object)=>Promise<void>} deps.openAsset - App's asset-load flow
     * @param {(camera:object)=>void} deps.applyCamera - apply {position,target,fov}
     * @param {()=>string|null} deps.getLoadedAssetKey - key of the loaded asset
     * @param {(msg:string, type?:string)=>void} deps.showToast
     */
    constructor(deps) {
        this._fileBrowser = deps.fileBrowser;
        this._openAsset = deps.openAsset;
        this._openScene = deps.openScene || null;
        this._applyCamera = deps.applyCamera;
        this._getLoadedAssetKey = deps.getLoadedAssetKey;
        this._toast = deps.showToast;
        this._eventSource = null;
    }

    // ==========================================================
    // Deep links (?path= / ?dir=)
    // ==========================================================

    /**
     * Handle the URL parameters once at boot. URL wins over the localStorage
     * default (the whole point of a deep link); on any failure we fall back by
     * returning false so the caller can run the normal goLastOrHome() start.
     *
     * @returns {Promise<boolean>} true if the URL fully determined the start view.
     */
    async boot() {
        const params = new URLSearchParams(window.location.search);
        const scene = params.get("scene");
        const path = params.get("path");
        const dir = params.get("dir");

        try {
            if (scene && this._openScene) {
                await this._openScene(scene);
                return true;
            }
            if (path) {
                await this.openPath(path, null);
                return true;
            }
            if (dir) {
                // browse() reports failure via its return value (it renders the
                // error in the sidebar) — on failure fall back to the normal start.
                if (await this._fileBrowser.browse(dir)) return true;
                this._toast(`Deep link failed: cannot open ${dir}`, "error");
            }
        } catch (err) {
            console.error("Deep link failed:", err);
            this._toast(`Deep link failed: ${err.message}`, "error");
        }
        return false;
    }

    /**
     * Open an asset by path (or `archive!inner` key): browse its parent directory
     * (so the sidebar shows the context and the asset entry carries its
     * related_files), select it, load it, then optionally apply a camera pose.
     */
    async openPath(pathOrKey, camera = null) {
        // Scene manifests get their own loader (they rebuild a whole composition).
        if (/\.mvscene$/i.test(pathOrKey) && this._openScene) {
            await this._openScene(pathOrKey);
            return;
        }

        const archive = pathOrKey.match(ARCHIVE_KEY_RE);

        // A path that is neither an archive member nor a model file is treated as
        // a directory (`?path=` used where `?dir=` was meant — be forgiving).
        if (!archive && !MODEL_EXT_RE.test(pathOrKey)) {
            if (!await this._fileBrowser.browse(pathOrKey)) {
                throw new Error(`Cannot open: ${pathOrKey}`);
            }
            return;
        }

        const containerDir = this._dirname(archive ? archive[1] : pathOrKey);
        if (!containerDir) throw new Error(`Not an absolute path: ${pathOrKey}`);

        if (!await this._fileBrowser.browse(containerDir)) {
            throw new Error(`Cannot open folder: ${containerDir}`);
        }

        const asset = this._fileBrowser.findAsset(pathOrKey);
        if (!asset) throw new Error(`Asset not found: ${pathOrKey}`);

        this._fileBrowser.highlightAsset(asset);
        await this._openAsset(asset);
        if (camera) this._applyCamera(camera);
    }

    // ==========================================================
    // URL sync (keep the address bar shareable as the user navigates)
    // ==========================================================

    /** Reflect a loaded asset in the URL (replaceState — no history spam). */
    syncAsset(asset) {
        this._replaceQuery(`?path=${encodeURIComponent(assetKey(asset))}`);
    }

    /**
     * Reflect the browsed directory in the URL. Loading an asset browses its parent
     * first and then syncs `?path=` on success, so "last writer wins" naturally
     * leaves the most specific state in the address bar.
     */
    syncDir(dirPath) {
        this._replaceQuery(`?dir=${encodeURIComponent(dirPath)}`);
    }

    /** Reflect a loaded/saved scene file in the URL (deep-linkable composition). */
    syncScene(scenePath) {
        this._replaceQuery(`?scene=${encodeURIComponent(scenePath)}`);
    }

    _replaceQuery(query) {
        try {
            window.history.replaceState(null, "", window.location.pathname + query);
        } catch { /* history API unavailable (rare embeds) — URL sync is best-effort */ }
    }

    // ==========================================================
    // Reverse bridge: report "what the human is looking at"
    // ==========================================================

    /**
     * Periodically report the current asset + camera to the server so agents can
     * pick up the human's subject (MCP get_app_state). Deduplicated by content —
     * getState() rounds camera values, so a settled view posts nothing.
     *
     * @param {()=>object|null} getReport - returns {path, name, camera} or null
     */
    startStateReporting(getReport, intervalMs = 2000) {
        if (this._reportTimer) return;
        this._lastReport = "";
        this._reportTimer = setInterval(async () => {
            let report = null;
            try { report = getReport(); } catch { return; }
            if (!report) return;
            const body = JSON.stringify(report);
            if (body === this._lastReport) return;
            this._lastReport = body;
            try {
                await fetch("/api/agent/state", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body,
                });
            } catch { /* loopback hiccup — the next tick retries */ }
        }, intervalMs);
    }

    // ==========================================================
    // Live agent push (SSE)
    // ==========================================================

    /** Subscribe to agent events. EventSource reconnects automatically on errors. */
    connect() {
        if (this._eventSource) return;
        try {
            this._eventSource = new EventSource("/api/events");
        } catch (err) {
            console.warn("Agent events unavailable:", err);
            return;
        }
        this._eventSource.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }
            if (msg.type === "open_asset") this._handleOpen(msg);
        };
    }

    async _handleOpen(msg) {
        const name = msg.path.split("/").pop();
        // Same model already on screen: don't reload, just move the camera.
        if (this._getLoadedAssetKey() === msg.path) {
            if (msg.camera) {
                this._applyCamera(msg.camera);
                this._toast(`Agent (${msg.source}) moved the view on ${name}`, "info");
            }
            return;
        }
        this._toast(`Agent (${msg.source}) is sharing: ${name}`, "info");
        try {
            // openPath loads through the app's normal flow, which also syncs ?path=.
            await this.openPath(msg.path, msg.camera);
        } catch (err) {
            console.error("Agent open failed:", err);
            this._toast(`Agent open failed: ${err.message}`, "error");
        }
    }

    /** POSIX dirname ("" for relative/rootless input — callers treat that as invalid). */
    _dirname(p) {
        const i = p.lastIndexOf("/");
        return i > 0 ? p.slice(0, i) : (i === 0 ? "/" : "");
    }
}
