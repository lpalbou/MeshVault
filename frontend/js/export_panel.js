/**
 * Export Panel Component
 *
 * Manages the asset rename/export controls in the top bar.
 * Handles:
 * - Displaying the current asset name for editing
 * - Export path input
 * - Export button click -> API call
 * - Toast notifications for success/error
 */

export class ExportPanel {
    /**
     * @param {object} elements - DOM elements
     * @param {HTMLElement} elements.controls - The controls container
     * @param {HTMLInputElement} elements.nameInput - Asset name input
     * @param {HTMLInputElement} elements.pathInput - Export path input
     * @param {HTMLButtonElement} elements.exportBtn - Export button
     * @param {Function} showToast - Function to show toast messages
     */
    constructor(elements, showToast) {
        this._controls = elements.controls;
        this._nameInput = elements.nameInput;
        this._pathInput = elements.pathInput;
        this._exportBtn = elements.exportBtn;
        this._showToast = showToast;

        this._currentAsset = null;

        this._exportBtn.addEventListener("click", () => this._onExport());

        // Enter key in inputs triggers export
        this._nameInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") this._onExport();
        });
        this._pathInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") this._onExport();
        });
    }

    /**
     * Set the current asset for the export panel.
     * Shows the controls and populates the name field.
     *
     * @param {object} asset - The asset data from the API
     * @param {string} currentBrowsePath - Current browse directory path
     */
    setAsset(asset, currentBrowsePath) {
        this._currentAsset = asset;
        this._controls.style.display = "flex";

        // Set the name input to the asset's current name
        this._nameInput.value = asset.name;

        // Set default export path to current browse directory
        if (!this._pathInput.value) {
            this._pathInput.value = currentBrowsePath || "";
        }
    }

    /** Hide the export controls */
    hide() {
        this._controls.style.display = "none";
        this._currentAsset = null;
    }

    /**
     * Handle export button click.
     * Validates inputs and calls the export API.
     */
    async _onExport() {
        if (!this._currentAsset) {
            this._showToast("No asset selected", "error");
            return;
        }

        const newName = this._nameInput.value.trim();
        if (!newName) {
            this._showToast("Please enter a name for the asset", "error");
            this._nameInput.focus();
            return;
        }

        const targetDir = this._pathInput.value.trim();
        if (!targetDir) {
            this._showToast("Please enter an export directory", "error");
            this._pathInput.focus();
            return;
        }

        // Disable the button during export
        this._exportBtn.disabled = true;
        this._exportBtn.textContent = "Exporting...";

        try {
            const asset = this._currentAsset;
            const response = await fetch("/api/export", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    source_path: asset.path,
                    target_dir: targetDir,
                    new_name: newName,
                    is_in_archive: asset.is_in_archive || false,
                    archive_path: asset.archive_path || null,
                    inner_path: asset.inner_path || null,
                    related_files: asset.related_files || [],
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || "Export failed");
            }

            const result = await response.json();
            this._showToast(
                `Exported ${result.files_exported.length} file(s) to ${result.output_path}`,
                "success"
            );
        } catch (err) {
            console.error("Export error:", err);
            this._showToast(`Export failed: ${err.message}`, "error");
        } finally {
            this._exportBtn.disabled = false;
            this._exportBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                Export
            `;
        }
    }
}
