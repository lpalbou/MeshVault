/**
 * Export Panel Component
 *
 * Manages the asset rename/export controls in the top bar.
 * Handles:
 * - Displaying the current asset name for editing
 * - Export path input
 * - Export button click -> API call
 * - Modified model export (OBJ from viewer) when model has been transformed
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
     * @param {Function} getModifiedOBJ - Returns OBJ string if model is modified, null otherwise
     */
    constructor(elements, showToast, getModifiedOBJ, onExportSuccess) {
        this._controls = elements.controls;
        this._nameInput = elements.nameInput;
        this._pathInput = elements.pathInput;
        this._exportBtn = elements.exportBtn;
        this._showToast = showToast;
        this._getModifiedOBJ = getModifiedOBJ || (() => null);
        this._onExportSuccess = onExportSuccess || (() => {});

        this._currentAsset = null;

        // Note: Export button click is handled by the Save As modal in app.js.
        // ExportPanel._onExport() is called programmatically by the modal's Save button.
    }

    /**
     * Set the current asset for the export panel.
     * Shows the controls and populates the name field.
     */
    setAsset(asset, currentBrowsePath) {
        this._currentAsset = asset;
        this._controls.style.display = "flex";
        this._nameInput.value = asset.name;
        // Always pre-fill with the source directory
        this._pathInput.value = currentBrowsePath || "";
    }

    /** Hide the export controls */
    hide() {
        this._controls.style.display = "none";
        this._currentAsset = null;
    }

    /**
     * Handle export button click.
     *
     * If the model has been modified (recentered, oriented, scaled),
     * exports the modified OBJ from the viewer instead of the source file.
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

        this._exportBtn.disabled = true;

        try {
            // Check if model has been modified — export modified OBJ instead
            const modifiedOBJ = this._getModifiedOBJ();
            let response;

            if (modifiedOBJ) {
                // Export the modified geometry as OBJ
                response = await fetch("/api/export_modified", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        target_dir: targetDir,
                        new_name: newName,
                        obj_content: modifiedOBJ,
                    }),
                });
            } else {
                // Export original source file(s)
                const asset = this._currentAsset;
                response = await fetch("/api/export", {
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
            }

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || "Export failed");
            }

            const result = await response.json();
            const suffix = modifiedOBJ ? " (modified)" : "";
            this._showToast(
                `Exported${suffix} ${result.files_exported.length} file(s) to ${result.output_path}`,
                "success"
            );
            // Refresh the file browser to show the new file
            this._onExportSuccess();
        } catch (err) {
            console.error("Export error:", err);
            this._showToast(`Export failed: ${err.message}`, "error");
        } finally {
            this._exportBtn.disabled = false;
        }
    }
}
