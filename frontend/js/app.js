/**
 * Main Application Entry Point
 *
 * Wires together the FileBrowser, Viewer3D, and ExportPanel components.
 * Handles global state and inter-component communication.
 */

import { FileBrowser, assetKey } from "./file_browser.js";
import { Viewer3D } from "./viewer_3d.js";
import { ExportPanel } from "./export_panel.js";
import { Thumbnailer } from "./thumbnailer.js";
import { ModelComparer } from "./compare.js";
import { AgentLink } from "./agent_link.js";
import { ScenePanel } from "./scene_panel.js";


class App {
    constructor() {
        // --- DOM References ---
        this._elements = {
            fileList: document.getElementById("file-list"),
            currentPath: document.getElementById("current-path"),
            btnGoUp: document.getElementById("btn-go-up"),
            btnGoHome: document.getElementById("btn-go-home"),
            viewerContainer: document.getElementById("viewer-3d"),
            viewerPlaceholder: document.getElementById("viewer-placeholder"),
            loadingOverlay: document.getElementById("loading-overlay"),
            viewerInfo: document.getElementById("viewer-info"),
            infoVertices: document.getElementById("info-vertices"),
            infoFaces: document.getElementById("info-faces"),
            infoSize: document.getElementById("info-size"),
            assetControls: document.getElementById("asset-controls"),
            assetNameInput: document.getElementById("asset-name-input"),
            exportPathInput: document.getElementById("export-path-input"),
            exportBtn: document.getElementById("export-btn"),
            statusText: document.getElementById("status-text"),
            toastContainer: document.getElementById("toast-container"),
            sidebarResize: document.getElementById("sidebar-resize"),
            sidebar: document.getElementById("sidebar"),
        };

        // --- Initialize Components ---
        this._thumbnailer = new Thumbnailer();
        this._fileBrowser = new FileBrowser(
            this._elements.fileList,
            this._elements.currentPath,
            (asset) => this._onAssetSelected(asset),
            (text) => this._updateStatus(text),
            (asset) => this._onExportRequested(asset),
            this._thumbnailer,
            (asset) => this._onCompareRequested(asset),
            (asset) => this._onAddToScene(asset),
        );

        this._viewer = new Viewer3D(
            this._elements.viewerContainer,
            (stats) => this._updateViewerInfo(stats),
            {
                // The full app resolves a model's resource references (textures, MTL)
                // through the backend, which confines and serves them. This is the same
                // behavior as before — now injected explicitly so the viewer core stays
                // backend-agnostic (the standalone bundle injects a client-only resolver).
                resolveResource: (ref) =>
                    `/api/asset/related?path=${encodeURIComponent(ref)}`,
            }
        );

        // Shape comparison (backlog 041): compare another asset against the loaded model.
        this._comparer = new ModelComparer(this._viewer, (m, t) => this._showToast(m, t));

        // Scene composition UI (objects panel + gizmo + click-select), backlog 042.
        this._scenePanel = new ScenePanel(this._viewer, {
            showToast: (m, t) => this._showToast(m, t),
            onSaveScene: () => this._saveScene(),
        });

        this._exportPanel = new ExportPanel(
            {
                controls: this._elements.assetControls,
                nameInput: this._elements.assetNameInput,
                pathInput: this._elements.exportPathInput,
                exportBtn: this._elements.exportBtn,
            },
            (msg, type) => this._showToast(msg, type),
            // Modified OBJ getter
            () => {
                if (this._viewer.isModelModified) {
                    return this._viewer.exportAsOBJ();
                }
                return null;
            },
            // Refresh file browser after successful export
            () => this._fileBrowser.browse(this._fileBrowser.currentPath)
        );

        // --- Reload Button (reload asset from disk) ---
        document.getElementById("btn-reload").addEventListener("click", () => {
            if (this._lastLoadedAsset) {
                this._onAssetSelected(this._lastLoadedAsset);
            }
        });

        // --- Reset Model Button (undo all transforms, not camera) ---
        document.getElementById("btn-reset-view").addEventListener("click", () => {
            this._viewer.resetModel();
            this._resetScaleControl();
            this._showToast("Model transforms reset", "info");
        });

        // --- Recenter (model only, not camera) ---
        document.getElementById("btn-recenter").addEventListener("click", () => {
            this._viewer.recenterModel();
            this._showToast("Model centered at (0, 0, 0)", "info");
        });

        // --- Ground (model only, not camera) ---
        document.getElementById("btn-ground").addEventListener("click", () => {
            this._viewer.groundModel();
            this._showToast("Model grounded at Y=0", "info");
        });

        // --- Auto-Orient (model only, not camera) ---
        document.getElementById("btn-auto-orient").addEventListener("click", () => {
            this._viewer.autoOrientModel();
            this._showToast("Model oriented (Y = up)", "info");
        });

        // --- Rotation buttons ---
        document.querySelectorAll(".rot-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const axis = btn.dataset.axis;
                const angle = parseInt(btn.dataset.angle, 10);
                this._viewer.rotateModel(axis, angle);
                const sign = angle > 0 ? "+" : "";
                this._showToast(`Rotated ${sign}${angle}° around ${axis.toUpperCase()}`, "info");
            });
        });

        // --- Simplify (LOD) ---
        this._initSimplifyControl();

        // --- Recompute normals ---
        document.getElementById("btn-recompute-normals").addEventListener("click", () => {
            const hide = this._showProcessing("Recomputing normals…");
            setTimeout(() => {
                this._viewer.recomputeNormals();
                hide();
                this._showToast("Normals recomputed", "info");
            }, 50);
        });

        // --- Export (Save As) modal ---
        this._initSaveAsModal();

        // --- Bind Navigation Buttons ---
        this._elements.btnGoUp.addEventListener("click", () => {
            this._fileBrowser.goUp();
        });
        this._elements.btnGoHome.addEventListener("click", () => {
            this._fileBrowser.goHome();
        });

        // --- Sidebar Resize ---
        this._initSidebarResize();

        // --- Sidebar Controls ---
        this._initSearchFilter();
        this._initSortSelect();
        this._initViewModeToggle();

        // --- Screenshot ---
        document.getElementById("screenshot-btn").addEventListener("click", () => {
            this._viewer.screenshot();
        });

        // --- Viewer Toolbar ---
        this._initNavModeToggle();
        this._initGridToggle();
        this._initAxisToggle();
        this._initWireframeToggle();
        this._initNormalsToggle();
        this._initTextureFolderPicker();
        this._initMaterialsPanel();
        this._initLightControls();
        this._initBackgroundSwatches();

        // --- Scale Control ---
        this._initScaleControl();

        // --- Phase 1/2 features ---
        this._initAnimationControls();
        this._initMeasurement();
        this._initDragAndDrop();
        this._initRecentFiles();

        // --- Agent link: deep links (?path=/?dir=/?scene=) + live agent push (SSE) ---
        this._agentLink = new AgentLink({
            fileBrowser: this._fileBrowser,
            openAsset: (asset) => this._onAssetSelected(asset),
            openScene: (path) => this._loadSceneFile(path),
            applyCamera: (cam) => this._applyAgentCamera(cam),
            getLoadedAssetKey: () =>
                this._lastLoadedAsset ? assetKey(this._lastLoadedAsset) : null,
            showToast: (m, t) => this._showToast(m, t),
        });
        this._fileBrowser.setNavigateListener((path) => this._agentLink.syncDir(path));
        this._agentLink.connect();

        // Reverse bridge: report what the human is looking at (asset + camera) so
        // agents can pick up the session headless (MCP get_app_state).
        this._agentLink.startStateReporting(() => {
            if (!this._lastLoadedAsset) return null;
            const cam = this._viewer.getState().camera;
            return {
                path: assetKey(this._lastLoadedAsset),
                name: `${this._lastLoadedAsset.name}${this._lastLoadedAsset.extension}`,
                camera: { position: cam.position, target: cam.target, fov: cam.fov },
            };
        });

        // --- Start: URL deep link wins over the localStorage default ---
        this._agentLink.boot().then((handled) => {
            if (!handled) this._fileBrowser.goLastOrHome();
        });
    }

    /**
     * Apply a camera pose pushed by an agent ({position, target?, fov?} — the same
     * shape get_camera/set_camera use), so the human sees the agent's exact view.
     */
    _applyAgentCamera(cam) {
        if (!cam || !Array.isArray(cam.position)) return;
        this._viewer.setCamera(
            cam.position,
            Array.isArray(cam.target) ? cam.target : undefined,
            typeof cam.fov === "number" ? cam.fov : undefined,
        );
    }

    /**
     * Export requested from the file browser context menu.
     *
     * Goal: same entry point as the top Export button (Save As modal),
     * but anchored to the asset the user right-clicked.
     */
    async _onExportRequested(asset) {
        if (!asset) {
            this._showToast("No asset selected", "error");
            return;
        }

        // If the requested asset isn't currently loaded, load it first so GLB export is available.
        const sameAsset = this._lastLoadedAsset &&
            this._lastLoadedAsset.path === asset.path &&
            this._lastLoadedAsset.inner_path === asset.inner_path &&
            this._lastLoadedAsset.archive_path === asset.archive_path;

        if (!sameAsset) {
            await this._onAssetSelected(asset);
        }

        // Open the Save As modal (same flow as top-bar Export button).
        const exportBtn = document.getElementById("export-btn");
        if (exportBtn) exportBtn.click();
    }

    /**
     * Called when the user picks "Compare to loaded model" on an asset. Builds a
     * loadable URL for the candidate (same rules as _onAssetSelected) and hands it to
     * the comparer, which samples both models, registers them, and paints a heatmap.
     */
    async _onCompareRequested(asset) {
        if (!this._viewer._currentModel) {
            this._showToast("Load a model first, then compare another to it", "error");
            return;
        }
        try {
            let url;
            let ext = asset.extension;
            if (asset.is_in_archive) {
                const prep = await fetch(
                    `/api/asset/prepare_archive?archive_path=${encodeURIComponent(asset.archive_path)}` +
                    `&inner_path=${encodeURIComponent(asset.inner_path)}`);
                if (!prep.ok) throw new Error("Failed to extract candidate from archive");
                const p = await prep.json();
                url = p.file_url;
                if (p.actual_extension) ext = p.actual_extension;
            } else {
                url = `/api/asset/file?path=${encodeURIComponent(asset.path)}`;
            }
            await this._comparer.compare({ url, extension: ext, name: `${asset.name}${asset.extension}` });
        } catch (err) {
            console.error("Compare request failed:", err);
            this._showToast(`Compare failed: ${err.message}`, "error");
        }
    }

    /**
     * Resolve an asset (plain file or archive member) to a loadable URL + viewer
     * options. Shared by replace-load, add-to-scene, and scene-manifest loads so
     * FBX auto-conversion, archive extraction, related files, and the persistent
     * source descriptor behave identically everywhere.
     */
    async _resolveAssetForLoad(asset) {
        let url;
        let relatedFiles = asset.related_files || [];
        let sourcePath = asset.path;

        // The actual format to load (may differ if FBX was auto-converted to OBJ)
        let loadExtension = asset.extension;

        // Persistent source identity for scene manifests (backlog 042).
        const source = asset.is_in_archive
            ? { kind: "archive", archivePath: asset.archive_path, innerPath: asset.inner_path }
            : { kind: "file", path: asset.path };

        if (asset.is_in_archive) {
            // For archived assets, use the prepare endpoint to extract
            // and get resolved temp filesystem paths for all files
            const prepareUrl = `/api/asset/prepare_archive?archive_path=${
                encodeURIComponent(asset.archive_path)
            }&inner_path=${encodeURIComponent(asset.inner_path)}`;

            const prepResp = await fetch(prepareUrl);
            if (!prepResp.ok) {
                const err = await prepResp.json();
                throw new Error(err.detail || "Failed to extract from archive");
            }

            const prepared = await prepResp.json();
            url = prepared.file_url;
            // Use the resolved temp paths instead of archive-internal paths
            relatedFiles = prepared.related_files || [];
            sourcePath = prepared.file_path || asset.path;
            // Use actual extension (may be .obj if FBX was auto-converted)
            if (prepared.actual_extension) {
                loadExtension = prepared.actual_extension;
            }
        } else {
            url = `/api/asset/file?path=${encodeURIComponent(asset.path)}`;
            // For FBX files on disk, the backend may auto-convert old versions
            // to OBJ. Check the response content-type to detect this.
            if (asset.extension.toLowerCase() === ".fbx") {
                try {
                    const headResp = await fetch(url, { method: "HEAD" });
                    const ct = headResp.headers.get("content-type") || "";
                    if (ct.includes("obj")) {
                        loadExtension = ".obj";
                    }
                } catch { /* ignore, will try as FBX */ }
            }
        }

        return {
            url,
            loadExtension,
            options: {
                relatedFiles,
                sourcePath,
                source,
                name: `${asset.name}${asset.extension}`,
            },
        };
    }

    /**
     * Composed-scene guard: replacing a multi-object scene must be a deliberate
     * act, not a stray sidebar click (a 30-minute composition would die silently).
     */
    _confirmSceneReplace(what) {
        const count = this._viewer._objects ? this._viewer._objects.length : 0;
        if (count <= 1) return true;
        return window.confirm(
            `Replace the current scene (${count} objects) with ${what}?\n` +
            `Use right-click → "Add to scene" to compose instead, or Save the scene first.`);
    }

    /**
     * Called when a 3D asset is selected in the file browser.
     * Loads the asset in the 3D viewer and shows the export controls.
     */
    async _onAssetSelected(asset) {
        // Scene manifests rebuild a whole composition — their own flow entirely.
        if (String(asset.extension).toLowerCase() === ".mvscene") {
            await this._loadSceneFile(asset.path);
            return;
        }

        if (!this._confirmSceneReplace(`"${asset.name}${asset.extension}"`)) return;

        // Selecting a new model ends any active comparison (heatmap belongs to the old one).
        if (this._comparer && this._comparer.isActive) this._comparer.clear();

        this._lastLoadedAsset = asset;

        // Show loading overlay
        this._elements.loadingOverlay.style.display = "flex";
        this._elements.viewerPlaceholder.style.display = "none";

        try {
            const { url, loadExtension, options } = await this._resolveAssetForLoad(asset);

            // Load the model (use loadExtension which may differ from original
            // if backend auto-converted an old FBX to OBJ)
            await this._viewer.loadModel(url, loadExtension, options);

            // Show export controls
            this._exportPanel.setAsset(
                asset,
                this._fileBrowser.currentPath
            );

            // Update size in viewer info
            this._elements.infoSize.textContent = this._formatSize(asset.size);
            this._elements.viewerInfo.style.display = "flex";

            // Show scale control and reset to 1.0
            this._resetScaleControl();

            // Record in recent files (dedup, most-recent-first, capped).
            this._pushRecentFile(asset);

            // Keep the URL shareable: it now deep-links to this exact asset.
            this._agentLink.syncAsset(asset);

            // A fresh model loads as mesh+texture — reset the render-mode button.
            if (this._resetRenderModeUI) this._resetRenderModeUI();

            this._updateStatus(`Loaded: ${asset.name}${asset.extension}`);
        } catch (err) {
            console.error("Failed to load asset:", err);
            this._showToast(`Failed to load: ${err.message}`, "error");
            this._elements.viewerPlaceholder.style.display = "flex";
            this._updateStatus(`Error loading asset`);
        } finally {
            this._elements.loadingOverlay.style.display = "none";
        }
    }

    // ==========================================================
    // Scene composition (backlog 042)
    // ==========================================================

    /** Context menu → "Add to scene": co-load without clearing (composition). */
    async _onAddToScene(asset) {
        // An empty viewer has nothing to compose with — behave like a normal load.
        if (!this._viewer._objects.length) {
            await this._onAssetSelected(asset);
            return;
        }
        this._elements.loadingOverlay.style.display = "flex";
        try {
            const { url, loadExtension, options } = await this._resolveAssetForLoad(asset);
            const result = await this._viewer.addModel(url, loadExtension, options);
            if (result.discarded) return;
            const count = this._viewer._objects.length;
            this._updateStatus(`Added: ${asset.name}${asset.extension} (${count} objects in scene)`);
            this._showToast(`Added to scene: ${asset.name}${asset.extension}`, "info");
        } catch (err) {
            console.error("Add to scene failed:", err);
            this._showToast(`Add to scene failed: ${err.message}`, "error");
        } finally {
            this._elements.loadingOverlay.style.display = "none";
        }
    }

    /** Load a .mvscene manifest and rebuild the composition (replaces the scene). */
    async _loadSceneFile(path) {
        if (!this._confirmSceneReplace(`the scene file "${path.split("/").pop()}"`)) return;

        this._elements.loadingOverlay.style.display = "flex";
        this._elements.viewerPlaceholder.style.display = "none";
        try {
            const resp = await fetch(`/api/scene/load?path=${encodeURIComponent(path)}`);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `Scene load failed (${resp.status})`);
            }
            const { manifest } = await resp.json();
            const { loaded, failed } = await this._applySceneManifest(manifest);

            this._elements.viewerInfo.style.display = "flex";
            this._resetScaleControl();
            if (this._resetRenderModeUI) this._resetRenderModeUI();
            this._agentLink.syncScene(path);
            this._updateStatus(`Scene loaded: ${loaded} object${loaded === 1 ? "" : "s"}`
                + (failed.length ? ` (${failed.length} unavailable)` : ""));
            if (failed.length) {
                this._showToast(`${failed.length} object(s) unavailable: `
                    + failed.slice(0, 3).join(", ")
                    + (failed.length > 3 ? "…" : ""), "error");
            }
        } catch (err) {
            console.error("Scene load failed:", err);
            this._showToast(`Scene load failed: ${err.message}`, "error");
            this._elements.viewerPlaceholder.style.display = "flex";
        } finally {
            this._elements.loadingOverlay.style.display = "none";
        }
    }

    /**
     * Rebuild a scene from a manifest: add every resolvable object with its saved
     * placement/visibility/opacity, then restore scene lighting/environment/
     * background. One unavailable object degrades per-object, never the scene.
     */
    async _applySceneManifest(manifest) {
        this._viewer.unload();
        if (this._comparer && this._comparer.isActive) this._comparer.clear();

        let loaded = 0;
        const failed = [];
        const browseCache = new Map();

        for (const obj of manifest.objects || []) {
            try {
                const src = obj.source || {};
                let resolved;
                if (src.kind === "file") {
                    const asset = await this._assetFromPath(src.path, browseCache);
                    resolved = await this._resolveAssetForLoad(asset);
                } else if (src.kind === "archive") {
                    const inner = src.innerPath || "";
                    resolved = await this._resolveAssetForLoad({
                        is_in_archive: true,
                        archive_path: src.archivePath,
                        inner_path: inner,
                        path: src.archivePath,
                        name: (obj.name || inner).replace(/\.[^.]+$/, ""),
                        extension: "." + inner.split(".").pop().toLowerCase(),
                        related_files: [],
                    });
                } else if (src.kind === "url") {
                    const ext = "." + String(src.url).split(".").pop().split("?")[0].toLowerCase();
                    resolved = {
                        url: src.url, loadExtension: ext,
                        options: { relatedFiles: [], source: src, name: obj.name },
                    };
                } else {
                    throw new Error("unsupported source");
                }

                const result = await this._viewer.addModel(resolved.url, resolved.loadExtension, {
                    ...resolved.options,
                    name: obj.name || resolved.options.name,
                    transform: obj.transform,
                    frame: false,
                });
                if (result.objectId !== undefined) {
                    if (obj.visible === false) this._viewer.setObjectVisible(result.objectId, false);
                    if (typeof obj.opacity === "number" && obj.opacity < 1) {
                        this._viewer.setObjectOpacity(result.objectId, obj.opacity);
                    }
                }
                loaded++;
            } catch (err) {
                console.warn("Scene object unavailable:", obj.name, err);
                failed.push(obj.name || "(unnamed)");
            }
        }

        const lighting = manifest.lighting;
        if (lighting) {
            this._viewer.setLighting({
                azimuth: lighting.keyAzimuth, elevation: lighting.keyElevation,
                key_intensity: lighting.keyIntensity, fill_intensity: lighting.fillIntensity,
                ambient: lighting.ambientIntensity, exposure: lighting.exposure,
            });
        }
        if (manifest.environment) this._viewer.setEnvironment(manifest.environment);
        if (typeof manifest.background === "string") this._viewer.setBackground(manifest.background);
        this._viewer.frameAll();

        return { loaded, failed };
    }

    /**
     * Full asset record for an absolute path, via the guarded browse endpoint —
     * the listing carries related_files (MTL/textures), which manifests don't.
     * Results are cached per parent directory for multi-object scene loads.
     */
    async _assetFromPath(path, cache = new Map()) {
        const dir = path.slice(0, path.lastIndexOf("/")) || "/";
        if (!cache.has(dir)) {
            const resp = await fetch(`/api/browse?path=${encodeURIComponent(dir)}`);
            if (!resp.ok) throw new Error(`folder unavailable: ${dir}`);
            cache.set(dir, (await resp.json()).assets || []);
        }
        const base = path.split("/").pop();
        const asset = cache.get(dir).find(
            (a) => !a.is_in_archive && a.path.split("/").pop() === base);
        if (!asset) throw new Error(`not found: ${path}`);
        return asset;
    }

    /** Save the composed scene as a .mvscene file in the current browse directory. */
    async _saveScene() {
        const manifest = this._viewer.getSceneManifest();
        if (!manifest.objects.length) {
            this._showToast("Nothing to save — the scene has no persistable objects", "error");
            return;
        }
        if (manifest.skippedVolatile && manifest.skippedVolatile.length) {
            this._showToast(`Not saved (drag-dropped, no file path): `
                + manifest.skippedVolatile.join(", "), "info");
        }
        const name = window.prompt("Scene name (.mvscene):", "scene");
        if (!name) return;
        const targetDir = this._fileBrowser.currentPath;

        const save = async (overwrite) => fetch("/api/scene/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target_dir: targetDir, name, manifest, overwrite }),
        });

        try {
            let resp = await save(false);
            if (resp.status === 409) {
                if (!window.confirm(`"${name}.mvscene" exists — overwrite?`)) return;
                resp = await save(true);
            }
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || `save failed (${resp.status})`);
            }
            const data = await resp.json();
            this._showToast(`Scene saved: ${data.path.split("/").pop()} `
                + `(${data.objects} objects)`, "info");
            // Refresh the listing FIRST (its navigate hook syncs ?dir=), then pin
            // the more specific ?scene= deep link as the final URL state.
            await this._fileBrowser.browse(targetDir);
            this._agentLink.syncScene(data.path);
        } catch (err) {
            console.error("Scene save failed:", err);
            this._showToast(`Scene save failed: ${err.message}`, "error");
        }
    }

    /**
     * Update the viewer info bar with model statistics.
     */
    _updateViewerInfo(stats) {
        this._elements.infoVertices.textContent = `${stats.vertices.toLocaleString()} vertices`;
        this._elements.infoFaces.textContent = `${stats.faces.toLocaleString()} faces`;
        // Show bounding box dimensions (W × H × D)
        if (stats.width !== undefined) {
            const fmt = (v) => v === 0 ? "0" : v < 0.01 ? v.toExponential(1) : v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : v.toFixed(0);
            document.getElementById("info-dims").textContent =
                `${fmt(stats.width)} × ${fmt(stats.height)} × ${fmt(stats.depth)}`;
        }
    }

    /**
     * Update the status text in the top bar.
     */
    _updateStatus(text) {
        this._elements.statusText.textContent = text;
    }

    /**
     * Show a toast notification.
     */
    _showToast(message, type = "info") {
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.textContent = message;
        this._elements.toastContainer.appendChild(toast);

        // Auto-remove after 4 seconds
        setTimeout(() => {
            toast.classList.add("fade-out");
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    /**
     * Show the full-screen loading overlay with a custom message.
     * Returns a function to hide it.
     */
    _showProcessing(message) {
        const overlay = this._elements.loadingOverlay;
        const msgEl = document.getElementById("loading-message");
        msgEl.textContent = message;
        overlay.style.display = "flex";
        return () => {
            overlay.style.display = "none";
            msgEl.textContent = "Loading asset...";
        };
    }

    /**
     * Format file size for display.
     */
    _formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /** Escape HTML special characters for safe interpolation. */
    _escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text == null ? "" : String(text);
        return div.innerHTML;
    }

    /**
     * Initialize the sidebar search/filter input.
     */
    _initSearchFilter() {
        const input = document.getElementById("search-filter");
        this._fileBrowser.setFilterInput(input);
    }

    /**
     * Initialize the sort selector.
     */
    _initSortSelect() {
        const select = document.getElementById("sort-select");
        // Restore saved preference
        select.value = this._fileBrowser.getSortMode();
        select.addEventListener("change", () => {
            this._fileBrowser.setSortMode(select.value);
        });
    }

    /**
     * Initialize the list/grid view mode toggle.
     */
    _initViewModeToggle() {
        const btnList = document.getElementById("btn-view-list");
        const btnGrid = document.getElementById("btn-view-grid");

        const update = (mode) => {
            this._fileBrowser.setViewMode(mode);
            btnList.classList.toggle("active", mode === "list");
            btnGrid.classList.toggle("active", mode === "grid");
        };

        btnList.addEventListener("click", () => update("list"));
        btnGrid.addEventListener("click", () => update("grid"));

        // Restore saved preference
        const saved = this._fileBrowser.getViewMode();
        if (saved === "grid") update("grid");
    }

    /**
     * Initialize the Orbit / FPV navigation mode toggle.
     */
    _initNavModeToggle() {
        const btn = document.getElementById("nav-mode-toggle");
        const iconOrbit = document.getElementById("nav-icon-orbit");
        const iconFpv = document.getElementById("nav-icon-fpv");

        const updateIcon = (mode) => {
            if (mode === "fpv") {
                iconOrbit.style.display = "none";
                iconFpv.style.display = "block";
                btn.classList.add("active");
                btn.title = "Switch to Orbit mode";
            } else {
                iconOrbit.style.display = "block";
                iconFpv.style.display = "none";
                btn.classList.remove("active");
                btn.title = "Switch to FPV mode";
            }
        };

        btn.addEventListener("click", () => {
            const current = this._viewer.getNavMode();
            const next = current === "orbit" ? "fpv" : "orbit";
            this._viewer.setNavMode(next);
            updateIcon(next);
            this._showToast(
                next === "fpv"
                    ? "FPV mode: W/Shift forward, S/Ctrl backward, A/D yaw, E/Q altitude, mouse drag to look"
                    : "Orbit mode: mouse to orbit/zoom/pan",
                "info"
            );
        });

        // Listen for programmatic mode changes (e.g., spacebar reset)
        this._elements.viewerContainer.addEventListener("navmodechange", (e) => {
            updateIcon(e.detail.mode);
        });
    }

    /**
     * Initialize the grid visibility toggle.
     */
    _initGridToggle() {
        const btn = document.getElementById("grid-toggle");
        btn.addEventListener("click", () => {
            const current = this._viewer.getGridVisible();
            this._viewer.setGridVisible(!current);
            btn.classList.toggle("active", !current);
        });
    }

    /**
     * Initialize the axis helper toggle.
     */
    _initAxisToggle() {
        const btn = document.getElementById("axis-toggle");
        btn.addEventListener("click", () => {
            const current = this._viewer.getAxisVisible();
            this._viewer.setAxisVisible(!current);
            btn.classList.toggle("active", !current);
        });
    }

    /**
     * Initialize the wireframe toggle button.
     */
    _initWireframeToggle() {
        // Cycle the three view modes the user asked for: mesh+texture → mesh → wireframe.
        const btn = document.getElementById("rendermode-toggle");
        if (!btn) return;
        const badge = document.getElementById("rendermode-badge");
        const modes = [
            { mode: "textured", label: "T", title: "Render mode: mesh + texture (click → mesh)" },
            { mode: "solid", label: "M", title: "Render mode: mesh only (click → wireframe)" },
            { mode: "wireframe", label: "W", title: "Render mode: wireframe (click → mesh + texture)" },
        ];
        let idx = 0;
        const apply = () => {
            const m = modes[idx];
            this._viewer.setRenderMode(m.mode);
            if (badge) badge.textContent = m.label;
            btn.title = m.title;
            btn.classList.toggle("active", m.mode !== "textured");
        };
        btn.addEventListener("click", () => {
            idx = (idx + 1) % modes.length;
            apply();
        });
        // A newly loaded model starts textured (the engine resets it); keep the button in sync.
        this._resetRenderModeUI = () => {
            idx = 0;
            if (badge) badge.textContent = modes[0].label;
            btn.title = modes[0].title;
            btn.classList.remove("active");
        };
    }

    /**
     * Initialize the normals visualization toggle.
     */
    _initNormalsToggle() {
        const btn = document.getElementById("normals-toggle");
        btn.addEventListener("click", () => {
            const current = this._viewer.getNormalsVisible();
            this._viewer.setNormalsVisible(!current);
            btn.classList.toggle("active", !current);
        });
    }

    /**
     * Initialize the background color swatches.
     */
    _initBackgroundSwatches() {
        const swatches = document.querySelectorAll("#bg-swatches .bg-swatch");
        swatches.forEach((swatch) => {
            swatch.addEventListener("click", () => {
                const color = swatch.dataset.color;
                this._viewer.setBackground(color);
                swatches.forEach((s) => s.classList.remove("active"));
                swatch.classList.add("active");
            });
        });
    }

    /**
     * Initialize the model scale slider control.
     */
    _initScaleControl() {
        const slider = document.getElementById("model-scale");
        const display = document.getElementById("model-scale-val");
        const container = document.getElementById("scale-control");

        this._scaleSlider = slider;
        this._scaleDisplay = display;
        this._scaleContainer = container;

        slider.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            display.textContent = `${val.toFixed(2)}×`;
            this._viewer.setModelScale(val);
            this._updateScaleSliderVisual(val);
        });

        // Initialize gradient fill for default value.
        this._updateScaleSliderVisual(parseFloat(slider.value));
    }

    /**
     * Reset the scale control to 1.0 and show it.
     */
    _resetScaleControl() {
        this._scaleSlider.value = 1;
        this._scaleDisplay.textContent = "1.00×";
        this._scaleContainer.style.display = "flex";
        this._viewer.setModelScale(1);
        this._updateScaleSliderVisual(1);
    }

    /**
     * Update scale slider visual fill based on current value.
     */
    _updateScaleSliderVisual(value) {
        if (!this._scaleSlider) return;
        const min = parseFloat(this._scaleSlider.min || "0");
        const max = parseFloat(this._scaleSlider.max || "1");
        const v = Math.min(max, Math.max(min, value));
        const pct = ((v - min) / (max - min)) * 100;
        this._scaleSlider.style.setProperty("--scale-pct", `${pct}%`);
    }

    /**
     * Initialize the mesh simplification (LOD) control.
     */
    _initSimplifyControl() {
        const btn = document.getElementById("btn-simplify");
        const popover = document.getElementById("simplify-popover");
        const slider = document.getElementById("simplify-ratio");
        const ratioDisplay = document.getElementById("simplify-ratio-val");
        const currentDisplay = document.getElementById("simplify-current");
        const targetDisplay = document.getElementById("simplify-target");
        const btnApply = document.getElementById("simplify-apply");
        const btnCancel = document.getElementById("simplify-cancel");

        let currentVertCount = 0;

        const openPopover = () => {
            currentVertCount = this._viewer.getTotalVertexCount();
            currentDisplay.textContent = currentVertCount.toLocaleString();
            slider.value = 50;
            ratioDisplay.textContent = "50%";
            targetDisplay.textContent = Math.floor(currentVertCount * 0.5).toLocaleString();
            popover.style.display = "block";
        };

        const closePopover = () => {
            popover.style.display = "none";
        };

        btn.addEventListener("click", () => {
            if (popover.style.display !== "none") {
                closePopover();
            } else {
                openPopover();
            }
        });

        slider.addEventListener("input", () => {
            const pct = parseInt(slider.value, 10);
            ratioDisplay.textContent = `${pct}%`;
            targetDisplay.textContent = Math.floor(currentVertCount * pct / 100).toLocaleString();
        });

        btnCancel.addEventListener("click", closePopover);

        btnApply.addEventListener("click", async () => {
            const ratio = parseInt(slider.value, 10) / 100;
            closePopover();

            // Show processing overlay
            const overlay = this._elements.loadingOverlay;
            const msgEl = document.getElementById("loading-message");
            const cancelBtn = document.getElementById("loading-cancel-btn");
            msgEl.textContent = "Simplifying mesh…";
            overlay.style.display = "flex";

            // Show the red cancel button inside the overlay
            const abortController = new AbortController();
            cancelBtn.style.display = "inline-block";
            cancelBtn.onclick = () => {
                abortController.abort();
                cancelBtn.textContent = "Cancelling…";
                cancelBtn.disabled = true;
            };

            try {
                const result = await this._viewer.simplifyModel(ratio, abortController.signal);

                if (result.cancelled) {
                    this._showToast("Simplification cancelled", "info");
                } else {
                    this._showToast(
                        `Simplified: ${result.before.toLocaleString()} → ${result.after.toLocaleString()} vertices`,
                        "success"
                    );
                }
            } catch (err) {
                this._showToast(`Simplification failed: ${err.message}`, "error");
            } finally {
                overlay.style.display = "none";
                msgEl.textContent = "Loading asset...";
                cancelBtn.style.display = "none";
                cancelBtn.textContent = "Cancel";
                cancelBtn.disabled = false;
                cancelBtn.onclick = null;
            }
        });
    }

    /**
     * Initialize the texture folder picker.
     * Opens the folder browser modal. When a folder is selected,
     * scans it for textures and applies them to the current model.
     */
    _initTextureFolderPicker() {
        const btn = document.getElementById("texture-folder-btn");

        btn.addEventListener("click", () => {
            // Reuse the Save As modal for folder browsing
            const modal = document.getElementById("folder-modal");
            const pathDisplay = document.getElementById("folder-modal-path");
            const listContainer = document.getElementById("folder-modal-list");
            const nameInput = document.getElementById("modal-name-input");
            const btnSave = document.getElementById("folder-modal-select");
            const btnCancel = document.getElementById("folder-modal-cancel");
            const btnClose = document.getElementById("folder-modal-close");
            const headerEl = modal.querySelector(".modal-header h3");
            const filenameRow = modal.querySelector(".modal-filename");

            // Reconfigure modal for texture folder selection
            const origTitle = headerEl.textContent;
            const origBtnText = btnSave.textContent;
            headerEl.textContent = "Select texture folder";
            btnSave.textContent = "Apply textures";
            filenameRow.style.display = "none";

            let currentPath = this._fileBrowser.currentPath || "";

            const loadFolder = async (path) => {
                try {
                    const url = path
                        ? `/api/browse?path=${encodeURIComponent(path)}`
                        : "/api/browse";
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error("Failed to browse");
                    const data = await resp.json();
                    currentPath = data.current_path;
                    pathDisplay.textContent = currentPath;
                    listContainer.innerHTML = "";

                    if (data.parent_path) {
                        const upItem = document.createElement("div");
                        upItem.className = "modal-folder-item go-up";
                        upItem.innerHTML = `<span class="folder-icon">◀</span> ..`;
                        upItem.addEventListener("click", () => loadFolder(data.parent_path));
                        listContainer.appendChild(upItem);
                    }

                    for (const folder of data.folders) {
                        const item = document.createElement("div");
                        item.className = "modal-folder-item";
                        item.innerHTML = `<span class="folder-icon">📁</span> ${folder.name}`;
                        item.addEventListener("click", () => loadFolder(folder.path));
                        listContainer.appendChild(item);
                    }
                } catch (err) {
                    listContainer.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
                }
            };

            const closeAndRestore = () => {
                modal.style.display = "none";
                headerEl.textContent = origTitle;
                btnSave.textContent = origBtnText;
                filenameRow.style.display = "";
                // Remove temp listeners
                btnSave.removeEventListener("click", onApply);
                btnCancel.removeEventListener("click", closeAndRestore);
                btnClose.removeEventListener("click", closeAndRestore);
            };

            const onApply = async () => {
                closeAndRestore();
                const hide = this._showProcessing("Scanning & applying textures…");

                try {
                    // Scan the folder for textures
                    const scanResp = await fetch("/api/scan_textures", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ path: currentPath }),
                    });

                    if (!scanResp.ok) {
                        hide();
                        this._showToast("Failed to scan folder", "error");
                        return;
                    }

                    const scanData = await scanResp.json();

                    if (scanData.count === 0) {
                        hide();
                        this._showToast("No textures found in selected folder", "error");
                        return;
                    }

                    // Apply textures to the model
                    const applied = await this._viewer.applyTextureFolder(scanData.textures);
                    hide();

                    if (applied > 0) {
                        this._showToast(
                            `Applied ${applied} texture(s) from ${scanData.count} found`,
                            "success"
                        );
                    } else {
                        this._showToast(
                            `${scanData.count} textures found but none matched model materials`,
                            "info"
                        );
                    }
                } catch (err) {
                    hide();
                    this._showToast(`Texture loading failed: ${err.message}`, "error");
                }
            };

            btnSave.addEventListener("click", onApply);
            btnCancel.addEventListener("click", closeAndRestore);
            btnClose.addEventListener("click", closeAndRestore);

            modal.style.display = "flex";
            loadFolder(currentPath);
        });
    }

    /**
     * Initialize the material inspector panel.
     *
     * Architecture note: each material card stores a live reference to the
     * THREE.Material object. The property rows use data-attributes that map
     * directly to material properties. This means a future editor only needs
     * to swap the value <span> with a <input>/<slider> and call
     * material[prop] = newValue — no data model changes needed.
     */
    _initMaterialsPanel() {
        const toggleBtn = document.getElementById("materials-toggle");
        const panel = document.getElementById("materials-panel");
        const listContainer = document.getElementById("materials-list");
        const countDisplay = document.getElementById("materials-count");
        const header = panel.querySelector(".light-panel-header");

        let outsideListener = null;
        const closePanel = () => {
            panel.style.display = "none";
            toggleBtn.classList.remove("active");
            if (outsideListener) {
                document.removeEventListener("mousedown", outsideListener, true);
                outsideListener = null;
            }
        };

        // Toggle show/hide
        toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const visible = panel.style.display !== "none";
            if (visible) {
                closePanel();
            } else {
                this._renderMaterialsList(listContainer, countDisplay);
                panel.style.display = "flex";
                toggleBtn.classList.add("active");

                // Close on click outside (panel or toggle button)
                setTimeout(() => {
                    outsideListener = (ev) => {
                        if (!panel.contains(ev.target) && !toggleBtn.contains(ev.target)) {
                            closePanel();
                        }
                    };
                    document.addEventListener("mousedown", outsideListener, true);
                }, 0);
            }
        });

        // Draggable by header
        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;

        header.addEventListener("mousedown", (e) => {
            isDragging = true;
            dragOffsetX = e.clientX - panel.offsetLeft;
            dragOffsetY = e.clientY - panel.offsetTop;
            document.body.style.userSelect = "none";
            e.preventDefault();
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            panel.style.left = `${e.clientX - dragOffsetX}px`;
            panel.style.top = `${e.clientY - dragOffsetY}px`;
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.userSelect = "";
            }
        });
    }

    /**
     * Render the materials list into the panel.
     * Each card shows material properties and the meshes using it.
     * Data-attributes on property rows enable future editing.
     */
    _renderMaterialsList(container, countDisplay) {
        const materials = this._viewer.getMaterialsInfo();
        container.innerHTML = "";
        countDisplay.textContent = `(${materials.length})`;

        if (materials.length === 0) {
            container.innerHTML = '<div class="empty-state">No materials found</div>';
            return;
        }

        for (const mat of materials) {
            const card = document.createElement("div");
            card.className = "mat-card";
            // Store material reference for future editing
            card._materialRef = mat.material;
            card._meshRefs = mat.meshes;

            const meshNames = mat.meshes
                .map((m) => m.name || "unnamed")
                .slice(0, 3)
                .join(", ");
            const meshExtra = mat.meshes.length > 3
                ? ` +${mat.meshes.length - 3} more`
                : "";

            card.innerHTML = `
                <div class="mat-card-header">
                    <div class="mat-color-swatch" style="background:${mat.color};"></div>
                    <div class="mat-card-name" title="${mat.name}">${mat.name}</div>
                    <div class="mat-card-type">${mat.type.replace("Mesh", "").replace("Material", "")}</div>
                </div>
                <div class="mat-props">
                    <div class="mat-prop" data-prop="color">
                        <span class="mat-prop-label">Color</span>
                        <span class="mat-prop-value">${mat.color}</span>
                    </div>
                    <div class="mat-prop" data-prop="roughness">
                        <span class="mat-prop-label">Rough</span>
                        <span class="mat-prop-value">${mat.roughness.toFixed(2)}</span>
                    </div>
                    <div class="mat-prop" data-prop="metalness">
                        <span class="mat-prop-label">Metal</span>
                        <span class="mat-prop-value">${mat.metalness.toFixed(2)}</span>
                    </div>
                    <div class="mat-prop" data-prop="opacity">
                        <span class="mat-prop-label">Alpha</span>
                        <span class="mat-prop-value">${mat.opacity.toFixed(2)}</span>
                    </div>
                    <div class="mat-prop">
                        <span class="mat-prop-label">Texture</span>
                        <span class="mat-prop-value ${mat.hasMap ? "has-texture" : ""}">${mat.hasMap ? "Yes" : "No"}</span>
                    </div>
                    <div class="mat-prop">
                        <span class="mat-prop-label">Normal</span>
                        <span class="mat-prop-value ${mat.hasNormalMap ? "has-texture" : ""}">${mat.hasNormalMap ? "Yes" : "No"}</span>
                    </div>
                </div>
                <div class="mat-meshes">${mat.meshes.length} mesh${mat.meshes.length !== 1 ? "es" : ""}: ${meshNames}${meshExtra}</div>
            `;

            container.appendChild(card);
        }
    }

    /**
     * Initialize the light control panel: toggle, sliders, reset.
     */
    _initLightControls() {
        const toggleBtn = document.getElementById("light-toggle");
        const panel = document.getElementById("light-panel");

        // Slider elements
        const sliders = {
            azimuth: document.getElementById("light-azimuth"),
            elevation: document.getElementById("light-elevation"),
            keyIntensity: document.getElementById("light-key-intensity"),
            fillIntensity: document.getElementById("light-fill-intensity"),
            ambientIntensity: document.getElementById("light-ambient-intensity"),
            exposure: document.getElementById("light-exposure"),
        };

        // Value display elements
        const displays = {
            azimuth: document.getElementById("light-azimuth-val"),
            elevation: document.getElementById("light-elevation-val"),
            keyIntensity: document.getElementById("light-key-val"),
            fillIntensity: document.getElementById("light-fill-val"),
            ambientIntensity: document.getElementById("light-ambient-val"),
            exposure: document.getElementById("light-exposure-val"),
        };

        // Default values for reset
        const defaults = {
            azimuth: 45, elevation: 60,
            keyIntensity: 1.2, fillIntensity: 0.5,
            ambientIntensity: 0.3, exposure: 1.2,
        };

        // Toggle panel visibility
        let outsideListener = null;
        const closePanel = () => {
            panel.style.display = "none";
            toggleBtn.classList.remove("active");
            if (outsideListener) {
                document.removeEventListener("mousedown", outsideListener, true);
                outsideListener = null;
            }
        };

        toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const visible = panel.style.display !== "none";
            if (visible) {
                closePanel();
            } else {
                panel.style.display = "block";
                toggleBtn.classList.add("active");
                // Close on click outside (panel or toggle button)
                setTimeout(() => {
                    outsideListener = (ev) => {
                        if (!panel.contains(ev.target) && ev.target !== toggleBtn) {
                            closePanel();
                        }
                    };
                    document.addEventListener("mousedown", outsideListener, true);
                }, 0);
            }
        });

        // Wire each slider to its viewer method
        sliders.azimuth.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            displays.azimuth.textContent = `${val}°`;
            this._viewer.setKeyLightAzimuth(val);
        });

        sliders.elevation.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            displays.elevation.textContent = `${val}°`;
            this._viewer.setKeyLightElevation(val);
        });

        sliders.keyIntensity.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            displays.keyIntensity.textContent = val.toFixed(2);
            this._viewer.setKeyLightIntensity(val);
        });

        sliders.fillIntensity.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            displays.fillIntensity.textContent = val.toFixed(2);
            this._viewer.setFillLightIntensity(val);
        });

        sliders.ambientIntensity.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            displays.ambientIntensity.textContent = val.toFixed(2);
            this._viewer.setAmbientIntensity(val);
        });

        sliders.exposure.addEventListener("input", (e) => {
            const val = parseFloat(e.target.value);
            displays.exposure.textContent = val.toFixed(2);
            this._viewer.setExposure(val);
        });

        // Reset button
        document.getElementById("light-reset").addEventListener("click", () => {
            for (const [key, defaultVal] of Object.entries(defaults)) {
                sliders[key].value = defaultVal;
                sliders[key].dispatchEvent(new Event("input"));
            }
        });
    }

    /**
     * Initialize sidebar resize drag behavior.
     */
    /**
     * Initialize the Save As modal — opened by the Export button.
     * Lets user browse for a folder and set a filename, then saves.
     */
    _initSaveAsModal() {
        const modal = document.getElementById("folder-modal");
        const pathDisplay = document.getElementById("folder-modal-path");
        const listContainer = document.getElementById("folder-modal-list");
        const nameInput = document.getElementById("modal-name-input");
        const btnSave = document.getElementById("folder-modal-select");
        const btnCancel = document.getElementById("folder-modal-cancel");
        const btnClose = document.getElementById("folder-modal-close");
        const exportBtn = document.getElementById("export-btn");

        let currentModalPath = "";

        const extLabel = document.querySelector(".modal-ext");
        const formatHint = document.getElementById("format-hint");
        const formatBtns = document.querySelectorAll("#export-format-toggle .format-btn");

        // Track selected export format
        let selectedFormat = "glb"; // default

        const FORMAT_HINTS = {
            original: "Copy source file(s) as-is",
            obj: "Geometry only — no materials or textures",
            glb: "Single file · geometry + materials + textures",
        };

        // Wire format toggle buttons
        formatBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                formatBtns.forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                selectedFormat = btn.dataset.format;
                formatHint.textContent = FORMAT_HINTS[selectedFormat] || "";
                // Update filename extension
                updateFilenameForFormat();
            });
        });

        const updateFilenameForFormat = () => {
            const asset = this._exportPanel._currentAsset;
            const baseName = asset ? asset.name : "model";
            if (selectedFormat === "glb") {
                nameInput.value = baseName + ".glb";
                extLabel.textContent = "";
            } else if (selectedFormat === "obj") {
                nameInput.value = baseName + ".obj";
                extLabel.textContent = "";
            } else {
                // original
                const ext = asset ? asset.extension : ".obj";
                nameInput.value = baseName + ext;
                extLabel.textContent = "";
            }
        };

        const openModal = () => {
            const asset = this._exportPanel._currentAsset;
            // Pre-fill path with source directory
            currentModalPath = this._fileBrowser.currentPath || "";

            // Default to GLB if model has been modified, otherwise keep last choice
            const isModified = this._viewer.isModelModified;
            if (isModified && selectedFormat === "original") {
                // Switch to GLB since original won't include modifications
                selectedFormat = "glb";
                formatBtns.forEach((b) => {
                    b.classList.toggle("active", b.dataset.format === "glb");
                });
            }

            // "Original" option disabled when model is modified
            formatBtns.forEach((b) => {
                if (b.dataset.format === "original") {
                    b.disabled = isModified;
                    b.title = isModified
                        ? "Not available — model has been modified"
                        : "Keep original format (copy source file)";
                    if (isModified) b.style.opacity = "0.4";
                    else b.style.opacity = "";
                }
            });

            formatHint.textContent = FORMAT_HINTS[selectedFormat] || "";
            updateFilenameForFormat();

            modal.style.display = "flex";
            loadFolder(currentModalPath);
        };

        const closeModal = () => {
            modal.style.display = "none";
        };

        const loadFolder = async (path) => {
            try {
                const url = path
                    ? `/api/browse?path=${encodeURIComponent(path)}`
                    : "/api/browse";
                const resp = await fetch(url);
                if (!resp.ok) throw new Error("Failed to browse");
                const data = await resp.json();

                currentModalPath = data.current_path;
                pathDisplay.textContent = currentModalPath;

                listContainer.innerHTML = "";

                // Go up item
                if (data.parent_path) {
                    const upItem = document.createElement("div");
                    upItem.className = "modal-folder-item go-up";
                    upItem.innerHTML = `<span class="folder-icon">◀</span> ..`;
                    upItem.addEventListener("click", () => loadFolder(data.parent_path));
                    listContainer.appendChild(upItem);
                }

                // Folder items
                for (const folder of data.folders) {
                    const item = document.createElement("div");
                    item.className = "modal-folder-item";
                    item.innerHTML = `<span class="folder-icon">📁</span> ${folder.name}`;
                    item.addEventListener("click", () => loadFolder(folder.path));
                    listContainer.appendChild(item);
                }

                if (!data.parent_path && data.folders.length === 0) {
                    listContainer.innerHTML = '<div class="empty-state">No accessible folders</div>';
                }
            } catch (err) {
                listContainer.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
            }
        };

        // Export button opens the modal
        exportBtn.addEventListener("click", openModal);
        btnCancel.addEventListener("click", closeModal);
        btnClose.addEventListener("click", closeModal);
        modal.addEventListener("click", (e) => {
            if (e.target === modal) closeModal();
        });

        // Save button triggers the actual export
        btnSave.addEventListener("click", async () => {
            const fullName = nameInput.value.trim();
            if (!fullName) {
                this._showToast("Please enter a file name", "error");
                nameInput.focus();
                return;
            }

            // Strip extension for the export API
            const dotIdx = fullName.lastIndexOf(".");
            const newName = dotIdx > 0 ? fullName.substring(0, dotIdx) : fullName;

            closeModal();

            if (selectedFormat === "glb") {
                // GLB: export from viewer, send binary to backend
                await this._exportGLB(currentModalPath, newName);
            } else if (selectedFormat === "obj") {
                // OBJ: export modified geometry as OBJ text
                document.getElementById("asset-name-input").value = newName;
                document.getElementById("export-path-input").value = currentModalPath;
                await this._exportPanel._onExport();
            } else {
                // Original: copy source file(s)
                document.getElementById("asset-name-input").value = newName;
                document.getElementById("export-path-input").value = currentModalPath;
                await this._exportPanel._onExport();
            }
        });

        // Enter in name input triggers save
        nameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") btnSave.click();
        });

        // Global Save shortcut: Ctrl+S / Cmd+S
        // - If modal is closed: open Save dialog with prefilled values.
        // - If modal is open: trigger save immediately.
        document.addEventListener("keydown", (e) => {
            const isSaveKey = (e.key === "s" || e.key === "S");
            if (!isSaveKey || (!e.ctrlKey && !e.metaKey) || e.altKey) return;

            e.preventDefault();
            e.stopPropagation();

            if (!this._exportPanel._currentAsset) {
                this._showToast("No asset selected", "error");
                return;
            }

            const modalOpen = modal.style.display !== "none";
            if (modalOpen) {
                btnSave.click();
            } else {
                openModal();
            }
        });
    }

    /**
     * Export current model as GLB (binary glTF) with embedded materials & textures.
     * The GLB is generated client-side by Three.js GLTFExporter, then sent
     * to the backend as binary to write to the chosen directory.
     */
    async _exportGLB(targetDir, baseName) {
        const hide = this._showProcessing("Exporting GLB…");
        try {
            const glbData = await this._viewer.exportAsGLB();
            if (!glbData) {
                hide();
                this._showToast("No model to export", "error");
                return;
            }

            // Send binary GLB to backend for writing to disk
            const blob = new Blob([glbData], { type: "model/gltf-binary" });
            const formData = new FormData();
            formData.append("file", blob, `${baseName}.glb`);
            formData.append("target_dir", targetDir);
            formData.append("file_name", `${baseName}.glb`);

            const response = await fetch("/api/export_glb", {
                method: "POST",
                body: formData,
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || "GLB export failed");
            }

            const result = await response.json();
            hide();
            this._showToast(
                `Exported ${baseName}.glb (${this._formatSize(result.file_size)}) to ${result.output_path}`,
                "success"
            );
            // Refresh file browser
            this._fileBrowser.browse(this._fileBrowser.currentPath);
        } catch (err) {
            hide();
            console.error("GLB export error:", err);
            this._showToast(`Export failed: ${err.message}`, "error");
        }
    }

    _initSidebarResize() {
        const handle = this._elements.sidebarResize;
        const sidebar = this._elements.sidebar;
        let isResizing = false;

        handle.addEventListener("mousedown", (e) => {
            isResizing = true;
            handle.classList.add("active");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        });

        document.addEventListener("mousemove", (e) => {
            if (!isResizing) return;
            const newWidth = Math.max(220, Math.min(600, e.clientX));
            sidebar.style.width = `${newWidth}px`;
        });

        document.addEventListener("mouseup", () => {
            if (isResizing) {
                isResizing = false;
                handle.classList.remove("active");
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            }
        });
    }

    // ==========================================================
    // Animation controls (017)
    // ==========================================================

    _initAnimationControls() {
        const bar = document.getElementById("animation-bar");
        const select = document.getElementById("anim-clip-select");
        const playBtn = document.getElementById("anim-play-btn");
        const scrub = document.getElementById("anim-scrub");
        const speed = document.getElementById("anim-speed");
        const timeLabel = document.getElementById("anim-time");
        if (!bar) return;

        // The viewer emits "animations" whenever a model loads (empty ⇒ hide bar).
        this._elements.viewerContainer.addEventListener("animations", (e) => {
            const clips = e.detail.clips || [];
            if (clips.length === 0) {
                bar.style.display = "none";
                return;
            }
            bar.style.display = "flex";
            select.innerHTML = clips
                .map((c) => `<option value="${c.index}">${this._escapeHtml(c.name)}</option>`)
                .join("");
            select.style.display = clips.length > 1 ? "" : "none";
            scrub.value = 0;
            speed.value = "1";
            this._setAnimPlayIcon(true);
        });

        select.addEventListener("change", () => {
            this._viewer.playAnimation(parseInt(select.value, 10));
            this._setAnimPlayIcon(true);
        });

        playBtn.addEventListener("click", () => {
            const playing = this._viewer.toggleAnimationPlay();
            this._setAnimPlayIcon(playing);
        });

        scrub.addEventListener("input", () => {
            const dur = this._viewer.getAnimationDuration();
            this._viewer.setAnimationTime((parseFloat(scrub.value) / 100) * dur);
            this._setAnimPlayIcon(false);
        });

        speed.addEventListener("change", () => {
            this._viewer.setAnimationSpeed(parseFloat(speed.value));
        });

        // Drive the scrubber + time label from playback (~10 fps is plenty).
        setInterval(() => {
            if (bar.style.display === "none" || !this._viewer.hasAnimations()) return;
            const dur = this._viewer.getAnimationDuration();
            const t = this._viewer.getAnimationTime();
            if (dur > 0 && document.activeElement !== scrub) {
                scrub.value = Math.min(100, (t / dur) * 100);
            }
            timeLabel.textContent = `${t.toFixed(1)}s / ${dur.toFixed(1)}s`;
        }, 100);
    }

    _setAnimPlayIcon(playing) {
        const playBtn = document.getElementById("anim-play-btn");
        if (!playBtn) return;
        playBtn.textContent = playing ? "⏸" : "▶";
        playBtn.title = playing ? "Pause" : "Play";
    }

    // ==========================================================
    // Measurement (020)
    // ==========================================================

    _initMeasurement() {
        const btn = document.getElementById("measure-toggle");
        if (!btn) return;
        btn.addEventListener("click", () => {
            const active = this._viewer.toggleMeasureMode();
            btn.classList.toggle("active", active);
            this._showToast(
                active
                    ? "Measure: click two points on the model to measure distance"
                    : "Measure mode off",
                "info"
            );
        });
    }

    // ==========================================================
    // Drag-and-drop load (019)
    // ==========================================================

    _initDragAndDrop() {
        const zone = document.getElementById("viewer-container");
        if (!zone) return;
        const supported = [".obj", ".fbx", ".gltf", ".glb", ".stl", ".ply", ".dae", ".3mf", ".usdz"];

        // `dragleave` fires when moving over child elements and doesn't fire reliably when
        // a drag is abandoned outside the window, so tracking it directly leaves the
        // overlay stuck. Instead we set the "drag-over" state on every `dragover` and
        // clear it with a short watchdog timer that each `dragover` keeps resetting — once
        // dragover events stop (drag left the zone, ended, or was cancelled anywhere), the
        // timer fires and clears the state. Drop clears it immediately.
        let clearTimer = null;
        const setDrag = () => {
            zone.classList.add("drag-over");
            if (clearTimer) clearTimeout(clearTimer);
            clearTimer = setTimeout(() => zone.classList.remove("drag-over"), 120);
        };
        const clearDrag = () => {
            if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
            zone.classList.remove("drag-over");
        };

        const onDragOver = (e) => {
            if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
                e.preventDefault();
                setDrag();
            }
        };
        const onDrop = async (e) => {
            e.preventDefault();
            clearDrag();
            const files = Array.from(e.dataTransfer.files || []);
            if (files.length === 0) return;
            const file = files[0];
            const ext = "." + file.name.split(".").pop().toLowerCase();
            if (!supported.includes(ext)) {
                this._showToast(`Unsupported format for drag-drop: ${ext}`, "error");
                return;
            }
            await this._loadDroppedFile(file, ext);
        };

        zone.addEventListener("dragover", onDragOver);
        zone.addEventListener("drop", onDrop);
        // Belt-and-suspenders: any drag ending/leaving the document clears the overlay.
        zone.addEventListener("dragleave", (e) => { if (!e.relatedTarget) clearDrag(); });
        window.addEventListener("dragend", clearDrag);
        window.addEventListener("drop", clearDrag);
        document.addEventListener("mouseleave", clearDrag);
    }

    /**
     * Load a dropped File directly from an in-memory object URL. This bypasses the
     * filesystem API (the file may live outside the allowed root), so it is a
     * genuine local-preview path that respects the sandbox: nothing is written.
     */
    async _loadDroppedFile(file, ext) {
        if (!this._confirmSceneReplace(`the dropped file "${file.name}"`)) return;
        this._elements.loadingOverlay.style.display = "flex";
        this._elements.viewerPlaceholder.style.display = "none";
        let objectUrl = null;
        try {
            objectUrl = URL.createObjectURL(file);
            await this._viewer.loadModel(objectUrl, ext, { relatedFiles: [], sourcePath: file.name });
            this._elements.infoSize.textContent = this._formatSize(file.size);
            this._elements.viewerInfo.style.display = "flex";
            this._resetScaleControl();
            if (this._resetRenderModeUI) this._resetRenderModeUI();
            this._updateStatus(`Loaded (dropped): ${file.name}`);
        } catch (err) {
            console.error("Drop load failed:", err);
            this._showToast(`Failed to load dropped file: ${err.message}`, "error");
            this._elements.viewerPlaceholder.style.display = "flex";
        } finally {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            this._elements.loadingOverlay.style.display = "none";
        }
    }

    // ==========================================================
    // Recent files (019)
    // ==========================================================

    _initRecentFiles() {
        this._recentKey = "meshvault_recentFiles";
        this._renderRecentFiles();
    }

    _pushRecentFile(asset) {
        try {
            const key = assetKey(asset);
            let recent = JSON.parse(localStorage.getItem(this._recentKey) || "[]");
            recent = recent.filter((r) => r._key !== key);
            recent.unshift({
                _key: key, name: asset.name, extension: asset.extension,
                path: asset.path, size: asset.size ?? 0, is_in_archive: !!asset.is_in_archive,
                archive_path: asset.archive_path || null, inner_path: asset.inner_path || null,
                related_files: asset.related_files || [],
            });
            recent = recent.slice(0, 12);
            localStorage.setItem(this._recentKey, JSON.stringify(recent));
            this._renderRecentFiles();
        } catch { /* localStorage may be unavailable; recents are best-effort */ }
    }

    _renderRecentFiles() {
        const container = document.getElementById("recent-files");
        if (!container) return;
        let recent = [];
        try {
            recent = JSON.parse(localStorage.getItem(this._recentKey) || "[]");
        } catch { recent = []; }
        if (recent.length === 0) {
            container.style.display = "none";
            return;
        }
        container.style.display = "block";
        container.innerHTML =
            `<div class="recent-title">Recent</div>` +
            recent.map((r, i) =>
                `<button class="recent-item" data-idx="${i}" title="${this._escapeHtml(r.path)}">` +
                `<span class="recent-name">${this._escapeHtml(r.name)}</span>` +
                `<span class="recent-ext">${this._escapeHtml(r.extension)}</span></button>`
            ).join("");
        container.querySelectorAll(".recent-item").forEach((btn) => {
            btn.addEventListener("click", () => {
                const idx = parseInt(btn.dataset.idx, 10);
                this._onAssetSelected(recent[idx]);
            });
        });
    }
}


// --- Boot ---
document.addEventListener("DOMContentLoaded", () => {
    window.app = new App();
});
