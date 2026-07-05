/**
 * LibrarySearch — global, cross-folder search UI backed by the SQLite index.
 *
 * The sidebar filter only matches the open directory. This panel queries the whole
 * indexed library (name + extension + tag filters) and lets the user trigger a
 * background reindex. Selecting a result loads it in the viewer via the same
 * onAssetSelect path used by the file browser.
 */

export class LibrarySearch {
    constructor(onAssetSelect, onStatus) {
        this._onAssetSelect = onAssetSelect;
        this._onStatus = onStatus;
        this._debounce = null;

        this._panel = document.getElementById("library-search-panel");
        this._input = document.getElementById("lib-search-input");
        this._extFilter = document.getElementById("lib-search-ext");
        this._results = document.getElementById("lib-search-results");
        this._reindexBtn = document.getElementById("lib-reindex-btn");
        this._statusEl = document.getElementById("lib-search-status");
        this._toggleBtn = document.getElementById("library-search-toggle");

        if (!this._panel) return;
        this._wire();
        this._refreshStatus();
    }

    _wire() {
        this._toggleBtn?.addEventListener("click", () => {
            const open = this._panel.style.display !== "flex";
            this._panel.style.display = open ? "flex" : "none";
            this._toggleBtn.classList.toggle("active", open);
            if (open) {
                this._input.focus();
                this._refreshStatus();
            }
        });

        const run = () => {
            clearTimeout(this._debounce);
            this._debounce = setTimeout(() => this._search(), 200);
        };
        this._input.addEventListener("input", run);
        this._extFilter.addEventListener("change", run);

        this._reindexBtn.addEventListener("click", () => this._reindex());
    }

    async _refreshStatus() {
        try {
            const resp = await fetch("/api/library/status");
            const data = await resp.json();
            if (data.indexing) {
                this._statusEl.textContent = "Indexing…";
                setTimeout(() => this._refreshStatus(), 1000);
            } else {
                this._statusEl.textContent = `${data.count.toLocaleString()} assets indexed`;
            }
        } catch {
            this._statusEl.textContent = "Index unavailable";
        }
    }

    async _reindex() {
        this._reindexBtn.disabled = true;
        this._statusEl.textContent = "Starting index…";
        try {
            await fetch("/api/library/reindex", { method: "POST" });
            await this._pollReindex();
        } finally {
            this._reindexBtn.disabled = false;
        }
    }

    async _pollReindex() {
        const resp = await fetch("/api/library/status");
        const data = await resp.json();
        if (data.indexing) {
            this._statusEl.textContent = "Indexing…";
            setTimeout(() => this._pollReindex(), 1000);
        } else {
            const s = data.last || {};
            this._statusEl.textContent =
                `${data.count.toLocaleString()} assets (` +
                `+${s.added || 0} / ~${s.updated || 0} / -${s.pruned || 0})`;
            this._search();
        }
    }

    async _search() {
        const raw = this._input.value.trim();
        const ext = this._extFilter.value;
        const params = new URLSearchParams();
        // A leading "#" searches by tag (e.g. "#hero"); otherwise it's a name search.
        if (raw.startsWith("#")) {
            const tag = raw.slice(1).trim().toLowerCase();
            if (tag) params.set("tag", tag);
        } else if (raw) {
            params.set("q", raw);
        }
        if (ext) params.set("ext", ext);
        params.set("limit", "200");

        try {
            const resp = await fetch(`/api/library/search?${params.toString()}`);
            const data = await resp.json();
            this._renderResults(data.results || []);
        } catch (err) {
            this._results.innerHTML =
                `<div class="empty-state">Search failed: ${err.message}</div>`;
        }
    }

    _renderResults(results) {
        if (results.length === 0) {
            this._results.innerHTML = `<div class="empty-state">No matches</div>`;
            return;
        }
        this._results.innerHTML = "";
        for (const r of results) {
            const row = document.createElement("div");
            row.className = "lib-result";
            const ext = r.extension.replace(".", "");
            const location = r.is_in_archive
                ? `📦 ${this._basename(r.archive_path)}`
                : this._dirname(r.path);
            row.innerHTML =
                `<span class="lib-result-name">${this._escape(r.name)}</span>` +
                `<span class="lib-result-ext badge-${ext}">${ext}</span>` +
                `<span class="lib-result-loc" title="${this._escape(r.path)}">${this._escape(location)}</span>` +
                (r.tags && r.tags.length
                    ? `<span class="lib-result-tags">${r.tags.map((t) => `#${this._escape(t)}`).join(" ")}</span>`
                    : "");
            row.addEventListener("click", () => {
                this._onAssetSelect(this._toAsset(r));
                this._onStatus(`Loaded from search: ${r.name}`);
            });
            row.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                this._promptTag(r);
            });
            this._results.appendChild(row);
        }
    }

    async _promptTag(r) {
        const tag = prompt(`Add tag to "${r.name}" (right-click again to manage):`, "");
        if (tag === null) return;
        const trimmed = tag.trim();
        if (!trimmed) return;
        try {
            await fetch("/api/tags/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: r.path, tag: trimmed }),
            });
            this._onStatus(`Tagged "${r.name}" #${trimmed.toLowerCase()}`);
            this._search();
        } catch (err) {
            this._onStatus(`Tag failed: ${err.message}`);
        }
    }

    _toAsset(r) {
        return {
            name: r.name, extension: r.extension, path: r.path,
            size: r.size, is_in_archive: r.is_in_archive,
            archive_path: r.archive_path, inner_path: r.inner_path,
            related_files: [],
        };
    }

    _basename(p) { return p ? String(p).split(/[/\\]/).pop() : ""; }
    _dirname(p) {
        if (!p) return "";
        const parts = String(p).split(/[/\\]/);
        parts.pop();
        return parts.slice(-2).join("/");
    }
    _escape(t) {
        const d = document.createElement("div");
        d.textContent = t == null ? "" : String(t);
        return d.innerHTML;
    }
}
