/**
 * ModelComparer (backlog 041 v1) — surface the shape-registration engine in the app.
 *
 * Flow: the currently displayed model is the REFERENCE. The user right-clicks another
 * asset → "Compare to loaded model". We sample both surfaces, POST the point sets to
 * /api/compare (the same Python engine the MCP `compare_models` tool uses), then paint a
 * deviation heatmap on the displayed reference and show a verdict panel.
 *
 * Only ONE model is ever displayed — the candidate is loaded into a short-lived offscreen
 * viewer purely to sample its geometry (for registration) and to serve as the distance
 * target (for the heatmap), then disposed. No multi-object scene refactor (that is 041 v2).
 */

import { Viewer3D } from "./viewer_3d.js";
import { samplePoints } from "./viewer/sample_points.js";
import { applyDeviationHeatmap, clearDeviationHeatmap } from "./viewer/heatmap.js";

const SAMPLES = 4096;

export class ModelComparer {
    /**
     * @param {Viewer3D} viewer - the main app viewer (holds the reference model)
     * @param {(msg:string,type?:string)=>void} showToast
     */
    constructor(viewer, showToast) {
        this._viewer = viewer;
        this._toast = showToast || (() => {});
        this._panel = null;
        this._active = false;
    }

    /** True while a heatmap comparison is displayed (so callers can offer "Clear"). */
    get isActive() { return this._active; }

    /**
     * Compare the given candidate against the currently loaded model.
     * @param {object} opts - { url, extension, name } for the candidate
     */
    async compare({ url, extension, name }) {
        const ref = this._viewer._currentModel;
        if (!ref) { this._toast("Load a model first, then compare another to it", "error"); return; }
        if (this._active) this.clear();

        this._showPanel(`Comparing “${name}”…`, null);
        let offscreen = null;
        let container = null;
        try {
            // Sample the reference twice: one set to compare, a second (different seed) to
            // measure the sampling-noise floor so the classifier isn't fooled by it.
            const refPts = samplePoints(this._viewer, { count: SAMPLES, seed: 42 });
            const refAlt = samplePoints(this._viewer, { count: SAMPLES, seed: 1337 });
            if (refPts.error) throw new Error(`reference: ${refPts.error}`);

            // Load the candidate into a hidden offscreen viewer just long enough to
            // sample it and use its geometry as the heatmap distance target.
            container = document.createElement("div");
            container.style.cssText = "position:absolute;width:512px;height:512px;left:-9999px;top:-9999px;";
            document.body.appendChild(container);
            offscreen = new Viewer3D(container, () => {}, {
                resolveResource: (r) => `/api/asset/related?path=${encodeURIComponent(r)}`,
            });
            await offscreen.loadModel(url, extension, { relatedFiles: [], sourcePath: name });
            const candPts = samplePoints(offscreen, { count: SAMPLES, seed: 42 });
            if (candPts.error) throw new Error(`candidate: ${candPts.error}`);

            const report = await this._postCompare({
                reference: refPts.points,
                candidate: candPts.points,
                reference_alt: refAlt.error ? null : refAlt.points,
                align: true,
            });

            // Paint the reference with distance-to-candidate (registered).
            const m4 = report.alignment ? report.alignment.matrix4 : null;
            const diag = report.distances.bboxDiagonal;
            let heat = null;
            try {
                heat = applyDeviationHeatmap(ref, offscreen._currentModel, m4, diag);
                this._active = true;
            } catch (e) {
                console.warn("Heatmap failed (showing verdict only):", e);
            }
            this._renderReport(name, report, heat);
        } catch (err) {
            console.error("Compare failed:", err);
            this._showPanel(`Compare failed: ${err.message}`, null, true);
            this._toast(`Compare failed: ${err.message}`, "error");
        } finally {
            if (offscreen) { try { offscreen.destroy(); } catch { /* ignore */ } }
            if (container && container.parentNode) container.parentNode.removeChild(container);
        }
    }

    /** Remove the heatmap and the panel, restoring the normal view. */
    clear() {
        if (this._viewer._currentModel) clearDeviationHeatmap(this._viewer._currentModel);
        this._active = false;
        if (this._panel) { this._panel.remove(); this._panel = null; }
    }

    async _postCompare(body) {
        const resp = await fetch("/api/compare", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            let detail = resp.statusText;
            try { detail = (await resp.json()).detail || detail; } catch { /* ignore */ }
            throw new Error(detail);
        }
        return resp.json();
    }

    // --- panel UI ---

    _showPanel(title, bodyHtml, isError = false) {
        if (!this._panel) {
            this._panel = document.createElement("div");
            this._panel.className = "compare-panel";
            document.body.appendChild(this._panel);
        }
        this._panel.innerHTML =
            `<div class="compare-panel-head">${this._esc(title)}` +
            `<button class="compare-panel-close" title="Clear comparison">✕</button></div>` +
            (bodyHtml ? `<div class="compare-panel-body${isError ? " error" : ""}">${bodyHtml}</div>` : "");
        this._panel.querySelector(".compare-panel-close").addEventListener("click", () => this.clear());
    }

    _renderReport(name, report, heat) {
        const c = report.classification;
        const d = report.distances;
        const a = report.alignment;
        const labels = {
            identical: ["Identical", "#3ba55d"],
            near_identical: ["Near-identical", "#5b9bd5"],
            same_shape_modified: ["Same shape, modified", "#e0a52b"],
            different: ["Different object", "#d9534f"],
        };
        const [label, color] = labels[c] || [c, "#888"];
        const rows = [];
        rows.push(`<div class="cmp-verdict" style="border-color:${color}"><span style="color:${color}">●</span> ${label}</div>`);
        if (report.borderline) {
            rows.push(`<div class="cmp-warn">Borderline result — confirm visually.</div>`);
        }
        for (const w of report.warnings || []) rows.push(`<div class="cmp-warn">${this._esc(w)}</div>`);

        rows.push(`<table class="cmp-table">`);
        rows.push(this._row("Shape difference", `${(d.chamferMeanNormalized * 100).toFixed(2)}% of size (p95 ${(d.chamferP95Normalized * 100).toFixed(2)}%)`));
        if (d.asymmetry > 0.005) rows.push(this._row("Missing/extra regions", `${(d.asymmetry * 100).toFixed(2)}% (one has geometry the other lacks)`));
        if (a) {
            if (Math.abs(a.scaleRatio - 1) > 0.02) rows.push(this._row("Scale", `×${a.scaleRatio} (candidate rescaled to match)`));
            if (a.rotationDeg > 1) rows.push(this._row("Rotation to align", `${a.rotationDeg}°`));
        }
        if (heat) rows.push(this._row("Deviation (heatmap)", `mean ${heat.mean}, max ${heat.max} ${heat.unit} — blue=match, red≥${heat.rampMax}`));
        const st = report.structural;
        if (st) rows.push(this._row("Triangles", `${fmt(st.triangles.reference)} → ${fmt(st.triangles.candidate)} (${st.triangles.deltaPct >= 0 ? "+" : ""}${st.triangles.deltaPct}%)`));
        rows.push(`</table>`);
        rows.push(`<div class="cmp-hint">Heatmap painted on the loaded model. Click ✕ to restore.</div>`);

        this._showPanel(`Compared with “${name}”`, rows.join(""));
    }

    _row(k, v) { return `<tr><th>${this._esc(k)}</th><td>${this._esc(v)}</td></tr>`; }
    _esc(s) { const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }
}

function fmt(n) { return (n ?? 0).toLocaleString(); }
