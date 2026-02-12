/**
 * Main Application Entry Point
 *
 * Wires together the FileBrowser, Viewer3D, and ExportPanel components.
 * Handles global state and inter-component communication.
 */

import { FileBrowser } from "./file_browser.js";
import { Viewer3D } from "./viewer_3d.js";
import { ExportPanel } from "./export_panel.js";


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
        this._fileBrowser = new FileBrowser(
            this._elements.fileList,
            this._elements.currentPath,
            (asset) => this._onAssetSelected(asset),
            (text) => this._updateStatus(text)
        );

        this._viewer = new Viewer3D(
            this._elements.viewerContainer,
            (stats) => this._updateViewerInfo(stats)
        );

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

        // --- Start (resume last directory, or home) ---
        this._fileBrowser.goLastOrHome();
    }

    /**
     * Called when a 3D asset is selected in the file browser.
     * Loads the asset in the 3D viewer and shows the export controls.
     */
    async _onAssetSelected(asset) {
        this._lastLoadedAsset = asset;

        // Show loading overlay
        this._elements.loadingOverlay.style.display = "flex";
        this._elements.viewerPlaceholder.style.display = "none";

        try {
            let url;
            let relatedFiles = asset.related_files || [];
            let sourcePath = asset.path;

            // The actual format to load (may differ if FBX was auto-converted to OBJ)
            let loadExtension = asset.extension;

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

            // Prepare options for the viewer
            const options = { relatedFiles, sourcePath };

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

    /**
     * Update the viewer info bar with model statistics.
     */
    _updateViewerInfo(stats) {
        this._elements.infoVertices.textContent = `${stats.vertices.toLocaleString()} vertices`;
        this._elements.infoFaces.textContent = `${stats.faces.toLocaleString()} faces`;
        // Show bounding box dimensions (W × H × D)
        if (stats.width !== undefined) {
            const fmt = (v) => v < 0.01 ? v.toExponential(1) : v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : v.toFixed(0);
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
        const btn = document.getElementById("wireframe-toggle");
        btn.addEventListener("click", () => {
            const current = this._viewer.getWireframe();
            this._viewer.setWireframe(!current);
            btn.classList.toggle("active", !current);
        });
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
}


// --- Boot ---
document.addEventListener("DOMContentLoaded", () => {
    window.app = new App();
});
