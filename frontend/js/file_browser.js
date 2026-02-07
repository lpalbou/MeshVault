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
    archive: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="4" width="20" height="16" rx="2"/>
        <path d="M12 4v16"/>
        <rect x="10" y="9" width="4" height="4" rx="1"/>
    </svg>`,
};


export class FileBrowser {
    /**
     * @param {HTMLElement} container - The file list container element
     * @param {HTMLElement} pathDisplay - Element showing current path
     * @param {Function} onAssetSelect - Callback when an asset is selected
     * @param {Function} onStatusUpdate - Callback to update status text
     */
    constructor(container, pathDisplay, onAssetSelect, onStatusUpdate) {
        this._container = container;
        this._pathDisplay = pathDisplay;
        this._onAssetSelect = onAssetSelect;
        this._onStatusUpdate = onStatusUpdate;
        this._currentPath = null;
        this._parentPath = null;
        this._selectedElement = null;
    }

    /** Get the current browsing path */
    get currentPath() {
        return this._currentPath;
    }

    /**
     * Browse to a specific directory.
     * Fetches the directory contents from the API and renders them.
     */
    async browse(path) {
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

            // Update the path display
            this._pathDisplay.textContent = this._currentPath;
            this._pathDisplay.title = this._currentPath;

            // Render the file list
            this._render(data.folders, data.assets);

            const assetCount = data.assets.length;
            const folderCount = data.folders.length;
            this._onStatusUpdate(
                `${folderCount} folder${folderCount !== 1 ? "s" : ""}, ` +
                `${assetCount} asset${assetCount !== 1 ? "s" : ""}`
            );
        } catch (err) {
            console.error("Browse error:", err);
            this._onStatusUpdate(`Error: ${err.message}`);
            this._container.innerHTML = `
                <div class="empty-state">
                    <p>Could not load directory</p>
                    <p style="font-size: 11px; margin-top: 8px;">${err.message}</p>
                </div>
            `;
        }
    }

    /** Navigate to the parent directory */
    goUp() {
        if (this._parentPath) {
            this.browse(this._parentPath);
        }
    }

    /** Navigate to the home directory */
    async goHome() {
        try {
            const response = await fetch("/api/default_path");
            const data = await response.json();
            this.browse(data.path);
        } catch {
            this.browse(null);
        }
    }

    /**
     * Render the file list from folders and assets data.
     */
    _render(folders, assets) {
        this._container.innerHTML = "";
        this._selectedElement = null;

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

            for (const asset of assets) {
                this._container.appendChild(this._createAssetItem(asset));
            }
        }

        // Empty state
        if (folders.length === 0 && assets.length === 0) {
            this._container.innerHTML = `
                <div class="empty-state">No folders or 3D assets found</div>
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

        return item;
    }

    /**
     * Create an asset list item element.
     */
    _createAssetItem(asset) {
        const item = document.createElement("div");
        item.className = "file-item";
        item.dataset.type = "asset";

        const ext = asset.extension.replace(".", "").toLowerCase();
        const iconClass = `asset-${ext}`;
        const icon = ICONS[ext] || ICONS.obj;

        // Build meta text
        const sizeTxt = this._formatSize(asset.size);
        let metaParts = [sizeTxt, asset.extension];
        if (asset.is_in_archive) {
            metaParts.push("📦 in archive");
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

        return item;
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

    /**
     * Escape HTML special characters.
     */
    _escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }
}
