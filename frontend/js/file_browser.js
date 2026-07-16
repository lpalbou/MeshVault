/**
 * File Browser Component
 * 
 * Handles filesystem navigation, folder browsing, and asset listing.
 * Communicates with the backend API to fetch directory contents and
 * emits events when assets or folders are selected.
 */

// SVG icons for the file list
const ICONS = {
    folder: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
    </svg>`,
    obj: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
    </svg>`,
    fbx: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <path d="M12 8v8"/>
        <path d="M8 12h8"/>
    </svg>`,
    gltf: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="9"/>
        <path d="M12 3v18"/>
        <path d="M3 12h18"/>
        <path d="M12 3c4 3.5 4 14.5 0 18"/>
        <path d="M12 3c-4 3.5-4 14.5 0 18"/>
    </svg>`,
    glb: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="9"/>
        <path d="M12 3v18"/>
        <path d="M3 12h18"/>
        <path d="M12 3c4 3.5 4 14.5 0 18"/>
        <path d="M12 3c-4 3.5-4 14.5 0 18"/>
    </svg>`,
    stl: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
        <line x1="12" y1="22" x2="12" y2="15.5"/>
        <line x1="22" y1="8.5" x2="12" y2="15.5"/>
        <line x1="2" y1="8.5" x2="12" y2="15.5"/>
    </svg>`,
    max: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <path d="M7 8l5 4-5 4"/><line x1="14" y1="16" x2="18" y2="16"/>
    </svg>`,
    ply: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
        <circle cx="12" cy="12" r="2" fill="currentColor"/>
    </svg>`,
    dae: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
    </svg>`,
    "3mf": `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7v10l10 5 10-5V7L12 2z"/><path d="M12 12L2 7"/><path d="M12 12l10-5"/><path d="M12 12v10"/>
    </svg>`,
    usdz: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="9"/><path d="M8 12a4 4 0 018 0"/><path d="M12 3v3"/>
    </svg>`,
    unity: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7v10l10 5 10-5V7L12 2z"/>
        <path d="M12 12L2 7"/><path d="M12 12l10-5"/>
        <path d="M12 12v10"/>
    </svg>`,
    archive: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="4" width="20" height="16" rx="2"/>
        <path d="M12 4v16"/>
        <rect x="10" y="9" width="4" height="4" rx="1"/>
    </svg>`,
};


/**
 * Composite identity for an asset. Plain files are keyed by absolute path;
 * archive members by `archive_path!inner_path`. This is the app-wide convention
 * (recent files, deep links `?path=`, agent push) — defined here, at the data
 * owner, so every consumer shares the exact same key.
 */
export function assetKey(asset) {
    return asset.is_in_archive
        ? `${asset.archive_path}!${asset.inner_path}`
        : asset.path;
}

/** Split an `archive!inner` key: [full, archive_path, inner_path] or null. */
export const ARCHIVE_KEY_RE = /^(.*?\.(?:zip|rar|unitypackage))!(.+)$/i;


export class FileBrowser {
    /**
     * @param {HTMLElement} container - The file list container element
     * @param {HTMLElement} pathDisplay - Element showing current path
     * @param {Function} onAssetSelect - Callback when an asset is selected
     * @param {Function} onStatusUpdate - Callback to update status text
     * @param {Function} [onExportRequest] - Callback when user requests export from context menu
     */
    constructor(container, pathDisplay, onAssetSelect, onStatusUpdate, onExportRequest = null, thumbnailer = null, onCompareRequest = null, onAddToScene = null) {
        this._container = container;
        this._pathDisplay = pathDisplay;
        this._onAssetSelect = onAssetSelect;
        this._onStatusUpdate = onStatusUpdate;
        this._onExportRequest = onExportRequest;
        // Optional: "Compare to loaded model" context action (backlog 041).
        this._onCompareRequest = onCompareRequest;
        // Optional: "Add to scene" context action (composition, backlog 042).
        this._onAddToScene = onAddToScene;
        // Optional lazy thumbnail renderer for grid view (backlog 014).
        this._thumbnailer = thumbnailer;
        this._thumbObserver = null;
        this._currentPath = null;
        this._parentPath = null;
        // Previously visited directories (Back button), most recent last.
        this._history = [];
        this._selectedElement = null;
        // Cached data for filtering
        this._currentFolders = [];
        this._currentAssets = [];
        // View mode: 'list' or 'grid'
        this._viewMode = localStorage.getItem("meshvault_viewMode") || "list";
        // Sort mode
        this._sortMode = localStorage.getItem("meshvault_sortMode") || "name";
        // Current search filter
        this._filterText = "";

        // Suppress browser default context menu on the sidebar
        this._container.addEventListener("contextmenu", (e) => {
            e.preventDefault();
        });

        // Hover tooltip (archive context) — created lazily.
        this._archiveTooltipEl = null;
        this._archiveTooltipTimer = null;
        this._archiveTooltipAnchor = null;

        // Hide tooltip on scroll (e.g. sidebar scroll)
        this._container.addEventListener("scroll", () => this._hideArchiveTooltip(), { passive: true });
    }

    /** Get the current browsing path */
    get currentPath() {
        return this._currentPath;
    }

    /** Whether the current directory has a reachable parent (up is possible). */
    get hasParent() {
        return Boolean(this._parentPath);
    }

    /** Whether there is a previously visited folder to go back to. */
    get hasBack() {
        return this._history.length > 0;
    }

    /**
     * Register a navigation listener, called with the resolved path after every
     * successful browse(). Used by the app to keep the URL in sync (deep links).
     */
    setNavigateListener(cb) {
        this._onNavigate = cb;
    }

    /**
     * Find an asset of the CURRENT directory by path or `archive!inner` key.
     *
     * Exact key match first. If that fails, fall back to comparing basenames:
     * the server canonicalizes paths (e.g. /tmp → /private/tmp on macOS,
     * symlinks, case), so a caller-spelled path can differ from the canonical
     * asset path even though both name the same file. Within a single browsed
     * directory the filename identifies the asset exactly, so this fallback is
     * still a precise match — not a heuristic.
     */
    findAsset(pathOrKey) {
        const exact = this._currentAssets.find((a) => assetKey(a) === pathOrKey);
        if (exact) return exact;

        const archive = pathOrKey.match(ARCHIVE_KEY_RE);
        const base = (p) => p.slice(p.lastIndexOf("/") + 1);
        if (archive) {
            const [, archivePath, innerPath] = archive;
            return this._currentAssets.find((a) =>
                a.is_in_archive &&
                base(a.archive_path || "") === base(archivePath) &&
                a.inner_path === innerPath) || null;
        }
        return this._currentAssets.find((a) =>
            !a.is_in_archive && base(a.path) === base(pathOrKey)) || null;
    }

    /**
     * Programmatically highlight an asset's row/card (what a click does, minus the
     * load). Returns false when the asset is not rendered (e.g. filtered out).
     */
    highlightAsset(asset) {
        const key = assetKey(asset);
        for (const el of this._container.querySelectorAll("[data-key]")) {
            if (el.dataset.key === key) {
                this._setSelected(el);
                el.scrollIntoView({ block: "nearest" });
                return true;
            }
        }
        return false;
    }

    /**
     * Browse to a specific directory.
     * Fetches the directory contents from the API and renders them.
     * @param {string|null} path - Directory to open (null = server default).
     * @param {boolean} recordHistory - false when invoked by goBack(), so the
     *     Back navigation itself never pollutes the history it consumes.
     * @returns {Promise<boolean>} true on success (errors render in the sidebar).
     */
    async browse(path, recordHistory = true) {
        // Captured before navigation: on success this becomes the Back target.
        const prevPath = this._currentPath;
        try {
            this._onStatusUpdate("Loading...");

            const url = path
                ? `/api/browse?path=${encodeURIComponent(path)}`
                : "/api/browse";

            const response = await fetch(url);
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || "Failed to browse directory");
            }

            const data = await response.json();
            this._currentPath = data.current_path;
            this._parentPath = data.parent_path;

            // Record where we came from — only real moves (refreshes of the
            // same directory, e.g. after rename/delete, are not "back" steps).
            if (recordHistory && prevPath && prevPath !== this._currentPath) {
                this._history.push(prevPath);
                if (this._history.length > 100) this._history.shift();
            }

            // Remember last directory for next session
            localStorage.setItem("meshvault_lastDir", this._currentPath);

            // Cache data for filtering
            this._currentFolders = data.folders;
            this._currentAssets = data.assets;

            // Clear filter on navigation
            this._filterText = "";
            if (this._filterInput) this._filterInput.value = "";

            // Update the path display (clickable breadcrumb)
            this._renderPathBar();

            // Render the file list
            this._renderFiltered();

            const assetCount = data.assets.length;
            const folderCount = data.folders.length;
            this._onStatusUpdate(
                `${folderCount} folder${folderCount !== 1 ? "s" : ""}, ` +
                `${assetCount} asset${assetCount !== 1 ? "s" : ""}`
            );

            // Notify after a fully successful browse (URL sync for deep links).
            if (this._onNavigate) this._onNavigate(this._currentPath);
            return true;
        } catch (err) {
            console.error("Browse error:", err);
            this._onStatusUpdate(`Error: ${err.message}`);
            this._container.innerHTML = `
                <div class="empty-state">
                    <p>Could not load directory</p>
                    <p style="font-size: 11px; margin-top: 8px;">${err.message}</p>
                </div>
            `;
            return false;
        }
    }

    /**
     * Render the current path as a clickable breadcrumb: every ancestor segment
     * navigates to that directory. The deepest segments stay visible (the bar
     * scrolls to its end); earlier ones are reachable by horizontal scroll.
     */
    _renderPathBar() {
        const el = this._pathDisplay;
        el.innerHTML = "";
        el.title = this._currentPath;

        // Split into ancestor prefixes: "/a/b/c" → ["/", "/a", "/a/b", "/a/b/c"].
        // Works for any absolute POSIX path, including the filesystem root itself.
        const parts = this._currentPath.split("/").filter(Boolean);
        const prefixes = ["/"];
        for (const part of parts) {
            const prev = prefixes[prefixes.length - 1];
            prefixes.push(prev === "/" ? `/${part}` : `${prev}/${part}`);
        }

        prefixes.forEach((prefix, i) => {
            const isLast = i === prefixes.length - 1;
            const seg = document.createElement("span");
            seg.className = `path-seg${isLast ? " current" : ""}`;
            seg.textContent = i === 0 ? "/" : parts[i - 1];
            if (!isLast) {
                seg.title = prefix;
                seg.addEventListener("click", () => this.browse(prefix));
            }
            el.appendChild(seg);
            if (!isLast && i > 0) {
                const sep = document.createElement("span");
                sep.className = "path-sep";
                sep.textContent = "/";
                el.appendChild(sep);
            }
        });

        // Keep the tail (current folder) in view on deep paths.
        el.scrollLeft = el.scrollWidth;
    }

    /** Navigate to the parent directory */
    goUp() {
        if (this._parentPath) {
            this.browse(this._parentPath);
        }
    }

    /**
     * Navigate back to the previously selected folder. Entries that became
     * stale (deleted/unmounted since the visit) are skipped transparently.
     */
    async goBack() {
        while (this._history.length > 0) {
            const prev = this._history.pop();
            if (prev === this._currentPath) continue;
            if (await this.browse(prev, false)) return;
        }
    }

    /** Navigate to the home directory */
    async goHome() {
        try {
            const response = await fetch("/api/default_path");
            const data = await response.json();
            // `home` is the OS home dir whenever the server's trust boundary
            // allows it; `path` (default browse root) is the fallback.
            this.browse(data.home || data.path);
        } catch {
            this.browse(null);
        }
    }

    /** Navigate to the last visited directory, or home if none saved. */
    async goLastOrHome() {
        const lastDir = localStorage.getItem("meshvault_lastDir");
        // browse() reports failure via its return value (it renders the error
        // in the sidebar instead of throwing) — fall back to home on a stale dir.
        if (lastDir && await this.browse(lastDir)) return;
        await this.goHome();
    }

    /** Set the sort mode and re-render. */
    setSortMode(mode) {
        this._sortMode = mode;
        localStorage.setItem("meshvault_sortMode", mode);
        this._renderFiltered();
    }

    /** Get the current sort mode. */
    getSortMode() {
        return this._sortMode;
    }

    /**
     * Sort arrays of folders and assets based on the current sort mode.
     */
    _applySorting(folders, assets) {
        const mode = this._sortMode;

        // Folders: always sorted by name (asc or desc)
        const nameDir = mode === "name-desc" ? -1 : 1;
        folders.sort((a, b) => nameDir * a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

        // Assets: sort by the selected criterion
        switch (mode) {
            case "name":
                assets.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
                break;
            case "name-desc":
                assets.sort((a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: "base" }));
                break;
            case "size":
                assets.sort((a, b) => a.size - b.size);
                break;
            case "size-desc":
                assets.sort((a, b) => b.size - a.size);
                break;
            case "type":
                assets.sort((a, b) => a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name));
                break;
            default:
                break;
        }

        return { folders, assets };
    }

    /**
     * Set a reference to the filter input element (called by App after DOM init).
     */
    setFilterInput(input) {
        this._filterInput = input;
        input.addEventListener("input", () => {
            this._filterText = input.value.trim().toLowerCase();
            this._renderFiltered();
        });
    }

    /** Set the view mode ('list' or 'grid'). */
    setViewMode(mode) {
        this._viewMode = mode;
        localStorage.setItem("meshvault_viewMode", mode);
        this._renderFiltered();
    }

    /** Get the current view mode. */
    getViewMode() {
        return this._viewMode;
    }

    /**
     * Re-render with current filter applied.
     */
    _renderFiltered() {
        const filter = this._filterText;
        let folders = [...this._currentFolders];
        let assets = [...this._currentAssets];

        if (filter) {
            folders = folders.filter((f) =>
                f.name.toLowerCase().includes(filter)
            );
            assets = assets.filter((a) => {
                const n = (a.name || "").toLowerCase();
                if (n.includes(filter)) return true;
                // Archives can contain many similarly-named assets (e.g. Asteroid_2)
                // across different packs. Include archive/container context in search
                // so users can disambiguate by pack name or inner path.
                if (a.is_in_archive) {
                    const arch = this._basename(a.archive_path || "").toLowerCase();
                    const inner = (a.inner_path || "").toLowerCase();
                    if (arch && arch.includes(filter)) return true;
                    if (inner && inner.includes(filter)) return true;
                }
                return false;
            });
        }

        // Apply sorting
        const sorted = this._applySorting(folders, assets);
        this._render(sorted.folders, sorted.assets);
    }

    /**
     * Render the file list from folders and assets data.
     */
    _render(folders, assets) {
        // Revoke any blob URLs held by the cards we are about to discard, so object
        // URLs don't accumulate as the user navigates between folders.
        for (const img of this._container.querySelectorAll(".asset-card-thumb")) {
            if (img._mvObjectUrl) {
                URL.revokeObjectURL(img._mvObjectUrl);
                img._mvObjectUrl = null;
            }
        }

        this._container.innerHTML = "";
        this._selectedElement = null;

        // Reset any pending thumbnail work and rebuild the visibility observer so
        // only cards scrolled into view trigger a render.
        this._resetThumbObserver();

        const isGrid = this._viewMode === "grid";
        this._container.classList.toggle("grid-view", isGrid);

        // Folders section
        if (folders.length > 0) {
            const label = document.createElement("div");
            label.className = "section-label";
            label.textContent = "Folders";
            this._container.appendChild(label);

            for (const folder of folders) {
                this._container.appendChild(this._createFolderItem(folder));
            }
        }

        // Assets section
        if (assets.length > 0) {
            const label = document.createElement("div");
            label.className = "section-label";
            label.textContent = "3D Assets";
            this._container.appendChild(label);

            if (isGrid) {
                const grid = document.createElement("div");
                grid.className = "asset-grid";
                for (const asset of assets) {
                    grid.appendChild(this._createAssetCard(asset));
                }
                this._container.appendChild(grid);
            } else {
                for (const asset of assets) {
                    this._container.appendChild(this._createAssetItem(asset));
                }
            }
        }

        // Empty state
        if (folders.length === 0 && assets.length === 0) {
            const msg = this._filterText
                ? "No results matching filter"
                : "No folders or 3D assets found";
            this._container.innerHTML = `
                <div class="empty-state">${msg}</div>
            `;
        }
    }

    /**
     * Create a folder list item element.
     */
    _createFolderItem(folder) {
        const item = document.createElement("div");
        item.className = "file-item";
        item.dataset.path = folder.path;
        item.dataset.type = "folder";

        item.innerHTML = `
            <div class="file-item-icon folder">${ICONS.folder}</div>
            <div class="file-item-info">
                <div class="file-item-name">${this._escapeHtml(folder.name)}</div>
            </div>
        `;

        // Double-click to navigate into folder
        item.addEventListener("dblclick", () => {
            this.browse(folder.path);
        });

        // Single click just highlights
        item.addEventListener("click", () => {
            this._setSelected(item);
        });

        // Right-click context menu
        item.addEventListener("contextmenu", (e) => {
            this._showContextMenu(e, folder.path, folder.name);
        });

        return item;
    }

    /**
     * Create an asset list item element.
     */
    _createAssetItem(asset) {
        const item = document.createElement("div");
        item.className = "file-item";
        item.dataset.type = "asset";
        item.dataset.key = assetKey(asset);

        const ext = asset.extension.replace(".", "").toLowerCase();
        const iconClass = `asset-${ext}`;
        const icon = ICONS[ext] || ICONS.obj;

        // Build meta text
        const sizeTxt = this._formatSize(asset.size);
        let metaParts = [sizeTxt, asset.extension];
        if (asset.is_in_archive) {
            const arch = this._basename(asset.archive_path || "");
            metaParts.push(arch ? `📦 ${arch}` : "📦 archive");
        }
        if (asset.related_files && asset.related_files.length > 0) {
            metaParts.push(`+${asset.related_files.length} files`);
        }

        // Badge class
        const badgeClass = asset.is_in_archive
            ? "badge-archive"
            : `badge-${ext}`;
        const badgeText = asset.is_in_archive
            ? `${ext} 📦`
            : ext;

        item.innerHTML = `
            <div class="file-item-icon ${asset.is_in_archive ? 'archive' : iconClass}">${asset.is_in_archive ? ICONS.archive : icon}</div>
            <div class="file-item-info">
                <div class="file-item-name">${this._escapeHtml(asset.name)}</div>
                <div class="file-item-meta">${metaParts.join(" · ")}</div>
            </div>
            <span class="file-item-badge ${badgeClass}">${badgeText}</span>
        `;

        // Click to select and load the asset
        item.addEventListener("click", () => {
            this._setSelected(item);
            this._onAssetSelect(asset);
        });

        // Hover tooltip (archive context) — delayed by 1s
        if (asset.is_in_archive) {
            this._attachArchiveTooltip(item, asset);
        }

        // Right-click context menu
        const revealPath = asset.is_in_archive ? asset.archive_path : asset.path;
        const revealName = asset.is_in_archive
            ? asset.archive_path.split("/").pop()
            : asset.path.split("/").pop();
        item.addEventListener("contextmenu", (e) => {
            this._showContextMenu(e, revealPath, revealName, { kind: "asset", asset });
        });

        return item;
    }

    /**
     * Create an asset card element (for grid view).
     */
    _createAssetCard(asset) {
        const card = document.createElement("div");
        card.className = "asset-card";
        card.dataset.type = "asset";
        card.dataset.key = assetKey(asset);

        const ext = asset.extension.replace(".", "").toLowerCase();
        const icon = ICONS[ext] || ICONS.obj;
        const badgeClass = asset.is_in_archive ? "badge-archive" : `badge-${ext}`;
        const badgeText = asset.is_in_archive ? `${ext} 📦` : ext;

        card.innerHTML = `
            <div class="asset-card-icon asset-${ext}">
                ${icon}
                <img class="asset-card-thumb" alt="" />
            </div>
            <div class="asset-card-name">${this._escapeHtml(asset.name)}</div>
            <span class="file-item-badge ${badgeClass}">${badgeText}</span>
        `;

        // Lazy thumbnail: observe the card; render only when it enters the viewport.
        if (this._thumbnailer && this._thumbObserver) {
            const img = card.querySelector(".asset-card-thumb");
            card._thumbAsset = asset;
            card._thumbImg = img;
            this._thumbObserver.observe(card);
        }
        if (asset.is_in_archive) {
            const arch = this._basename(asset.archive_path || "");
            const inner = asset.inner_path || "";
            // Tooltip disambiguation for assets coming from different archives.
            card.title = arch ? `Archive: ${arch}\n${inner}` : `Archive\n${inner}`;
        }

        card.addEventListener("click", () => {
            this._setSelected(card);
            this._onAssetSelect(asset);
        });

        // Hover tooltip (archive context) — delayed by 1s
        if (asset.is_in_archive) {
            this._attachArchiveTooltip(card, asset);
        }

        const cardRevealPath = asset.is_in_archive ? asset.archive_path : asset.path;
        const cardRevealName = cardRevealPath.split("/").pop();
        card.addEventListener("contextmenu", (e) => {
            this._showContextMenu(e, cardRevealPath, cardRevealName, { kind: "asset", asset });
        });

        return card;
    }

    /**
     * Rebuild the IntersectionObserver used to lazily render grid thumbnails.
     * Called on every render so observers never leak across folder changes.
     */
    _resetThumbObserver() {
        if (this._thumbObserver) {
            this._thumbObserver.disconnect();
            this._thumbObserver = null;
        }
        if (this._thumbnailer) this._thumbnailer.reset();
        if (!this._thumbnailer || typeof IntersectionObserver === "undefined") return;

        this._thumbObserver = new IntersectionObserver((entries, obs) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const card = entry.target;
                obs.unobserve(card);
                if (card._thumbAsset && card._thumbImg) {
                    this._thumbnailer.request(card._thumbAsset, card._thumbImg);
                }
            }
        }, { root: this._container, rootMargin: "100px" });
    }

    /**
     * Set the selected item, removing previous selection.
     */
    _setSelected(element) {
        if (this._selectedElement) {
            this._selectedElement.classList.remove("active");
        }
        element.classList.add("active");
        this._selectedElement = element;
    }

    /**
     * Format a file size in bytes to a human-readable string.
     */
    _formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /** Return the last path component (supports / and \\). */
    _basename(p) {
        if (!p) return "";
        return String(p).split(/[/\\\\]/).pop() || "";
    }

    /**
     * Show a context menu with file operations.
     * @param {MouseEvent} event
     * @param {string} filePath - Absolute path to the file/folder
     * @param {string} [fileName] - Display name (for rename prompt)
     */
    _showContextMenu(event, filePath, fileName, context = null) {
        event.preventDefault();
        event.stopPropagation();
        this._dismissContextMenu();

        const menu = document.createElement("div");
        menu.className = "context-menu";

        const ctx = context || {};
        const asset = ctx && ctx.asset ? ctx.asset : null;

        // Header (archive name) — wrap, never truncate
        if (asset && asset.is_in_archive) {
            const archName = this._basename(asset.archive_path || "");
            const header = document.createElement("div");
            header.className = "context-menu-header";
            header.innerHTML =
                `<span class="ctx-archive-icon">📦</span>` +
                `<span class="ctx-archive-name">${this._escapeHtml(archName || "Archive")}</span>`;
            menu.appendChild(header);
        }

        // Position — keep within viewport
        let x = event.clientX;
        let y = event.clientY;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        // --- Export (Save As) ---
        if (asset && typeof this._onExportRequest === "function") {
            this._addContextMenuItem(menu, "Export…", () => {
                this._onExportRequest(asset);
            });
        }

        // Scene manifests are not geometry: no compose/compare actions for them.
        const isScene = asset && String(asset.extension).toLowerCase() === ".mvscene";

        // --- Add to the current scene (composition, backlog 042) ---
        if (asset && !isScene && typeof this._onAddToScene === "function") {
            this._addContextMenuItem(menu, "Add to scene", () => {
                this._onAddToScene(asset);
            });
        }

        // --- Compare to the currently loaded model (backlog 041) ---
        if (asset && !isScene && typeof this._onCompareRequest === "function") {
            this._addContextMenuItem(menu, "Compare to loaded model…", () => {
                this._onCompareRequest(asset);
            });
        }

        // --- Show in file manager ---
        this._addContextMenuItem(menu, "Show in file manager", async () => {
            try {
                await fetch("/api/reveal", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: filePath }),
                });
            } catch (err) {
                console.error("Reveal failed:", err);
            }
        });

        // --- Copy file path ---
        this._addContextMenuItem(menu, "Copy file path", () => {
            navigator.clipboard.writeText(filePath).then(() => {
                this._onStatusUpdate("Path copied to clipboard");
            }).catch(() => {
                // Fallback for older browsers
                const textarea = document.createElement("textarea");
                textarea.value = filePath;
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand("copy");
                document.body.removeChild(textarea);
                this._onStatusUpdate("Path copied to clipboard");
            });
        });

        // --- Rename (inline editing on the item itself) ---
        const displayName = fileName || filePath.split("/").pop();
        this._addContextMenuItem(menu, "Rename", () => {
            this._startInlineRename(event.target.closest(".file-item, .asset-card"), filePath, displayName);
        });

        // --- Duplicate ---
        this._addContextMenuItem(menu, "Duplicate", async () => {
            try {
                const resp = await fetch("/api/duplicate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: filePath }),
                });
                if (!resp.ok) {
                    const err = await resp.json();
                    this._onStatusUpdate(`Duplicate failed: ${err.detail}`);
                } else {
                    const result = await resp.json();
                    this._onStatusUpdate(`Duplicated to ${result.new_path.split("/").pop()}`);
                    this.browse(this._currentPath);
                }
            } catch (err) {
                this._onStatusUpdate(`Duplicate failed: ${err.message}`);
            }
        });

        // Separator
        const sep = document.createElement("div");
        sep.className = "context-menu-sep";
        menu.appendChild(sep);

        // --- Delete ---
        this._addContextMenuItem(menu, "Delete", async () => {
            const ok = confirm(`Delete "${displayName}"?\n\nThis cannot be undone.`);
            if (!ok) return;
            try {
                const resp = await fetch("/api/delete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: filePath }),
                });
                if (!resp.ok) {
                    const err = await resp.json();
                    alert(`Delete failed: ${err.detail}`);
                } else {
                    this.browse(this._currentPath);
                }
            } catch (err) {
                alert(`Delete failed: ${err.message}`);
            }
        }, true);

        document.body.appendChild(menu);
        this._activeContextMenu = menu;

        // Reposition if off-screen
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
        if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;

        // Dismiss on any click outside
        const dismiss = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissContextMenu();
                document.removeEventListener("click", dismiss, true);
                document.removeEventListener("contextmenu", dismiss, true);
            }
        };
        setTimeout(() => {
            document.addEventListener("click", dismiss, true);
            document.addEventListener("contextmenu", dismiss, true);
        }, 0);
    }

    /** Add a single item to a context menu. */
    _addContextMenuItem(menu, label, action, danger = false) {
        const item = document.createElement("div");
        item.className = `context-menu-item${danger ? " danger" : ""}`;
        item.textContent = label;
        item.addEventListener("click", () => {
            this._dismissContextMenu();
            action();
        });
        menu.appendChild(item);
    }

    /**
     * Start inline rename: replace the name text in the file item with
     * an editable input field. Enter confirms, Escape cancels.
     */
    _startInlineRename(itemElement, filePath, currentName) {
        if (!itemElement) return;

        // Find the name element (works for both list and grid items)
        const nameEl = itemElement.querySelector(".file-item-name, .asset-card-name");
        if (!nameEl) return;

        const originalText = nameEl.textContent;
        const input = document.createElement("input");
        input.type = "text";
        input.value = currentName;
        input.className = "inline-rename-input";

        nameEl.textContent = "";
        nameEl.appendChild(input);

        // Delay focus to avoid immediate blur from context menu dismissal
        let committed = false;
        setTimeout(() => {
            input.focus();
            const dotIdx = currentName.lastIndexOf(".");
            input.setSelectionRange(0, dotIdx > 0 ? dotIdx : currentName.length);
        }, 50);

        const restore = () => {
            if (!committed && input.parentElement) {
                nameEl.textContent = originalText;
            }
        };

        const commit = async () => {
            if (committed) return;
            committed = true;
            const newName = input.value.trim();
            if (!newName || newName === currentName) {
                nameEl.textContent = originalText;
                return;
            }
            // Show a temporary "renaming..." state
            nameEl.textContent = newName;
            try {
                const resp = await fetch("/api/rename", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: filePath, new_name: newName }),
                });
                if (!resp.ok) {
                    const err = await resp.json();
                    nameEl.textContent = originalText;
                    this._onStatusUpdate(`Rename failed: ${err.detail}`);
                } else {
                    this.browse(this._currentPath);
                }
            } catch (err) {
                nameEl.textContent = originalText;
                this._onStatusUpdate(`Rename failed: ${err.message}`);
            }
        };

        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
                e.preventDefault();
                commit();
            } else if (e.key === "Escape") {
                restore();
            }
        });

        input.addEventListener("blur", () => {
            // Small delay to allow Enter click to fire first
            setTimeout(() => restore(), 100);
        });

        // Prevent clicks on the input from triggering item selection/loading
        input.addEventListener("click", (e) => e.stopPropagation());
        input.addEventListener("dblclick", (e) => e.stopPropagation());
    }

    /** Remove the active context menu if any. */
    _dismissContextMenu() {
        if (this._activeContextMenu) {
            this._activeContextMenu.remove();
            this._activeContextMenu = null;
        }
    }

    // ==========================================================
    // Hover tooltip (archive context)
    // ==========================================================

    _ensureArchiveTooltip() {
        if (this._archiveTooltipEl) return;
        const el = document.createElement("div");
        el.className = "hover-tooltip";
        el.style.display = "none";
        document.body.appendChild(el);
        this._archiveTooltipEl = el;
    }

    _attachArchiveTooltip(anchorEl, asset) {
        const archName = this._basename(asset.archive_path || "");
        if (!archName) return;

        anchorEl.addEventListener("mouseenter", () => {
            this._hideArchiveTooltip();
            this._archiveTooltipAnchor = anchorEl;
            clearTimeout(this._archiveTooltipTimer);
            this._archiveTooltipTimer = setTimeout(() => {
                // Guard: only show if still hovered
                if (!anchorEl.matches(":hover")) return;
                this._showArchiveTooltip(anchorEl, archName);
            }, 1000);
        });

        anchorEl.addEventListener("mouseleave", () => {
            if (this._archiveTooltipAnchor === anchorEl) {
                clearTimeout(this._archiveTooltipTimer);
                this._archiveTooltipTimer = null;
                this._hideArchiveTooltip();
            }
        });

        // Any click should dismiss tooltip immediately
        anchorEl.addEventListener("mousedown", () => this._hideArchiveTooltip());
    }

    _showArchiveTooltip(anchorEl, archName) {
        this._ensureArchiveTooltip();

        const el = this._archiveTooltipEl;
        el.textContent = `📦 ${archName}`;
        el.style.display = "block";

        const r = anchorEl.getBoundingClientRect();
        const pad = 10;

        // Position near the hovered item, slightly above if possible.
        const desiredLeft = Math.round(r.left + pad);
        const desiredTop = Math.round(r.top - 10);

        // Measure after content applied.
        const tr = el.getBoundingClientRect();

        let left = desiredLeft;
        let top = desiredTop - tr.height;

        // Clamp to viewport, and if not enough space above, place below.
        if (top < 8) top = Math.round(r.bottom + 8);
        if (left + tr.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - tr.width - 8);
        if (top + tr.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - tr.height - 8);

        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }

    _hideArchiveTooltip() {
        clearTimeout(this._archiveTooltipTimer);
        this._archiveTooltipTimer = null;
        this._archiveTooltipAnchor = null;
        if (this._archiveTooltipEl) {
            this._archiveTooltipEl.style.display = "none";
        }
    }

    /**
     * Escape HTML special characters.
     */
    _escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }
}
