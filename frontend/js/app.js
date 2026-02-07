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
            // Modified OBJ getter: returns OBJ text if model was modified
            () => {
                if (this._viewer.isModelModified) {
                    return this._viewer.exportAsOBJ();
                }
                return null;
            }
        );

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
        this._initViewModeToggle();

        // --- Viewer Toolbar ---
        this._initNavModeToggle();
        this._initGridToggle();
        this._initAxisToggle();
        this._initWireframeToggle();
        this._initLightControls();
        this._initBackgroundSwatches();

        // --- Scale Control ---
        this._initScaleControl();

        // --- Start ---
        this._fileBrowser.goHome();
    }

    /**
     * Called when a 3D asset is selected in the file browser.
     * Loads the asset in the 3D viewer and shows the export controls.
     */
    async _onAssetSelected(asset) {
        // Show loading overlay
        this._elements.loadingOverlay.style.display = "flex";
        this._elements.viewerPlaceholder.style.display = "none";

        try {
            let url;
            let relatedFiles = asset.related_files || [];

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
            const options = { relatedFiles };

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
        });
    }

    /**
     * Reset the scale control to 1.0 and show it.
     */
    _resetScaleControl() {
        this._scaleSlider.value = 1;
        this._scaleDisplay.textContent = "1.00×";
        this._scaleContainer.style.display = "flex";
        this._viewer.setModelScale(1);
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
        toggleBtn.addEventListener("click", () => {
            const visible = panel.style.display !== "none";
            panel.style.display = visible ? "none" : "block";
            toggleBtn.classList.toggle("active", !visible);
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
