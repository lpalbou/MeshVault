/**
 * Timeline bar — the human view over the scene keyframe timeline (backlog 046,
 * keyframe AUTHORING added by 054).
 *
 * A thin VIEW + command issuer: it never advances time itself (the render loop
 * owns the only clock) and every mutation goes through the same control-API
 * commands agents use (set_keyframe/delete_keyframe/set_timeline/seek).
 *
 * Review-driven rules (054):
 * - The bar shows whenever a MODEL is loaded (not only when tracks exist) —
 *   otherwise the Key button's home doesn't exist before the first key.
 * - Tick marks carry the EXACT stored key time in their dataset; display
 *   rounding must never round the value sent to delete_keyframe (1e-6 match).
 * - A tick is the union across objects: its context menu lists per-object
 *   delete entries (deleting with the wrong id removes 0 keys).
 * - When the clip animation bar (animated GLBs) and this bar are both
 *   visible, this one stacks above it instead of overlapping.
 */

import { pauseTimeline, playTimeline, seekTimeline } from "./viewer/timeline.js";

export class TimelinePanel {
    /**
     * @param viewer Viewer3D
     * @param api    ViewerControlAPI (mutations; may be null for read-only use)
     * @param deps   {showToast}
     */
    constructor(viewer, api = null, deps = {}) {
        this._viewer = viewer;
        this._api = api;
        this._toast = deps.showToast || (() => {});
        this._bar = document.getElementById("timeline-bar");
        this._playBtn = document.getElementById("timeline-play-btn");
        this._scrub = document.getElementById("timeline-scrub");
        this._ticks = document.getElementById("timeline-ticks");
        this._timeEl = document.getElementById("timeline-time");
        this._keyBtn = document.getElementById("timeline-key-btn");
        this._durInput = document.getElementById("timeline-duration");
        this._emptyHint = document.getElementById("timeline-empty-hint");
        this._menu = null;
        if (!this._bar) return;

        this._playBtn.addEventListener("click", () => {
            const tl = viewer._timeline;
            if (!tl || tl.tracks.size === 0) return;
            if (tl.playing) pauseTimeline(viewer);
            else playTimeline(viewer, {});
            this._refresh();
        });
        this._scrub.addEventListener("input", () => {
            const tl = viewer._timeline;
            if (!tl) return;
            const dur = this._duration();
            if (dur <= 0) return;
            if (tl.playing) pauseTimeline(viewer);
            seekTimeline(viewer, { time: (this._scrub.value / 100) * dur });
            this._refresh();
        });

        if (this._keyBtn && api) {
            this._keyBtn.addEventListener("click", () => this._keyActiveObject());
        }
        if (this._durInput && api) {
            this._durInput.addEventListener("change", () => this._applyDuration());
        }
        document.addEventListener("click", () => this._closeMenu());

        // Poll the shared store (~5 Hz visible refresh; the 3D view itself is
        // driven by the render loop, this is only the widget).
        setInterval(() => this._refresh(), 200);
    }

    // ------------------------------------------------------------------
    // Authoring
    // ------------------------------------------------------------------

    async _keyActiveObject() {
        const v = this._viewer;
        const entry = v._activeEntry();
        if (!entry) {
            this._toast("Load an object first", "info");
            return;
        }
        const tl = v._timeline;
        const time = tl ? Math.round(tl.time * 1000) / 1000 : 0;
        const r = await this._api.execute({
            action: "set_keyframe",
            params: { id: entry.id, time, capture: true },
        });
        if (!r.ok) {
            this._toast(r.error, "error");
            return;
        }
        const note = r.result && r.result.note;
        // Honest scope hint while an imported GLB clip is driving inner nodes:
        // ● keys the OBJECT's placement, not the clip's pose (audit note).
        const anim = this._viewer.getState().animation || {};
        const clipHint = anim.hasAnimations && anim.playing
            ? " (the playing clip animates the model's inner nodes — ● keys the "
              + "object's placement only)"
            : "";
        this._toast(`Keyed '${entry.name}' @ ${time.toFixed(2)}s`
            + (note ? ` — ${note}` : "") + clipHint, "info");
        // First key at t=0 leaves duration 0: the scrub thumb would drag and
        // snap back doing nothing (a lying control — gauntlet finding), and
        // the second key becomes unreachable. Give the timeline a workable
        // default duration; the field adjusts it.
        if (this._duration() <= 0) {
            await this._api.execute({
                action: "set_timeline", params: { duration: 5 } });
            this._toast("Timeline duration set to 5s — scrub to place the "
                + "next key (adjust in the seconds field)", "info");
        }
        this._refresh(true);
    }

    async _applyDuration() {
        const v = this._viewer;
        const requested = parseFloat(this._durInput.value);
        if (!(requested > 0)) return;
        // Clamp to the last key time: a shorter duration wraps playback early
        // and pushes tick marks past the track's right edge.
        const lastKey = this._lastKeyTime();
        const duration = Math.max(requested, lastKey);
        const r = await this._api.execute({
            action: "set_timeline", params: { duration } });
        if (!r.ok) {
            this._toast(r.error, "error");
            return;
        }
        if (duration !== requested) {
            this._toast(`Duration clamped to the last key (${duration.toFixed(2)}s)`, "info");
            this._durInput.value = String(duration);
        }
        this._refresh(true);
    }

    async _deleteKey(objectId, name, t) {
        const r = await this._api.execute({
            action: "delete_keyframe",
            params: { id: objectId, time: t },   // EXACT stored t — never rounded
        });
        this._toast(r.ok ? `Deleted key @ ${t.toFixed(2)}s (${name})` : r.error,
            r.ok ? "info" : "error");
        this._refresh(true);
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    _duration() {
        const tl = this._viewer._timeline;
        if (!tl) return 0;
        if (tl.duration > 0) return tl.duration;
        return this._lastKeyTime();
    }

    _lastKeyTime() {
        const tl = this._viewer._timeline;
        let max = 0;
        if (!tl) return 0;
        for (const channels of tl.tracks.values()) {
            for (const keys of Object.values(channels)) {
                if (keys.length) max = Math.max(max, keys[keys.length - 1].t);
            }
        }
        return max;
    }

    /** Exact key times (unrounded) → the objects keyed at each. */
    _keyIndex() {
        const v = this._viewer;
        const tl = v._timeline;
        const byTime = new Map();   // exact t -> [{id, name}]
        if (!tl) return byTime;
        for (const [id, channels] of tl.tracks) {
            const entry = v._objects.find((o) => o.id === id);
            const name = entry ? entry.name : `object ${id}`;
            const seen = new Set();
            for (const keys of Object.values(channels)) {
                for (const k of keys) {
                    if (seen.has(k.t)) continue;
                    seen.add(k.t);
                    let list = byTime.get(k.t);
                    if (!list) { list = []; byTime.set(k.t, list); }
                    if (!list.some((x) => x.id === id)) list.push({ id, name });
                }
            }
        }
        return byTime;
    }

    _refresh(force) {
        const v = this._viewer;
        const tl = v._timeline;
        const hasModel = v._objects.length > 0;
        const hasTracks = tl && tl.tracks.size > 0;

        // 054: the bar is the Key button's home — visible whenever a model is
        // loaded, with a muted empty state before the first key.
        this._bar.style.display = hasModel ? "flex" : "none";
        if (!hasModel) return;

        // Stack above the clip animation bar when both are visible (they share
        // bottom:64px otherwise — an animated GLB plus a keyed placement shows
        // both at once).
        const animBar = document.getElementById("animation-bar");
        const stacked = animBar && animBar.style.display !== "none";
        this._bar.style.bottom = stacked ? "112px" : "64px";

        if (this._emptyHint) {
            this._emptyHint.style.display = hasTracks ? "none" : "inline";
        }
        this._playBtn.disabled = !hasTracks;
        this._scrub.disabled = !hasTracks;

        if (!hasTracks) {
            this._playBtn.textContent = "▶";
            this._timeEl.textContent = "";
            if (this._tickSig !== "empty") {
                this._tickSig = "empty";
                this._ticks.innerHTML = "";
            }
            return;
        }

        const dur = this._duration();
        this._playBtn.textContent = tl.playing ? "⏸" : "▶";
        if (dur > 0) {
            this._scrub.value = String((tl.time / dur) * 100);
            this._timeEl.textContent = `${tl.time.toFixed(1)}s / ${dur.toFixed(1)}s`;
        }
        if (this._durInput && document.activeElement !== this._durInput) {
            this._durInput.value = String(Math.round(dur * 100) / 100);
        }

        const byTime = this._keyIndex();
        const sig = [...byTime.keys()].sort((a, b) => a - b).join(",") + "|" + dur;
        if (sig !== this._tickSig || force) {
            this._tickSig = sig;
            this._ticks.innerHTML = "";
            {
                // A single key at t=0 gives duration 0 — ticks must still
                // render (at 0%), or the first key is invisible and looks lost.
                const denom = dur > 0 ? dur : 1;
                for (const [t, objs] of byTime) {
                    const tick = document.createElement("div");
                    tick.className = "timeline-tick";
                    tick.style.left = `${Math.min(100, (t / denom) * 100)}%`;
                    tick.title = `key @ ${t.toFixed(2)}s (${objs.map(o => o.name).join(", ")})`
                        + " — click to seek, right-click to delete";
                    tick.dataset.t = String(t);   // EXACT time for deletion
                    tick.addEventListener("click", (e) => {
                        e.stopPropagation();
                        if (tl.playing) pauseTimeline(this._viewer);
                        seekTimeline(this._viewer, { time: t });
                        this._refresh();
                    });
                    tick.addEventListener("contextmenu", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this._openMenu(e, t, objs);
                    });
                    this._ticks.appendChild(tick);
                }
            }
        }
    }

    _openMenu(e, t, objs) {
        this._closeMenu();
        if (!this._api) return;
        const menu = document.createElement("div");
        menu.className = "timeline-tick-menu";
        for (const { id, name } of objs) {
            const row = document.createElement("button");
            row.className = "timeline-tick-menu-row";
            row.textContent = `Delete key @ ${t.toFixed(2)}s — ${name}`;
            row.addEventListener("click", (ev) => {
                ev.stopPropagation();
                this._closeMenu();
                this._deleteKey(id, name, t);
            });
            menu.appendChild(row);
        }
        document.body.appendChild(menu);
        const rect = this._bar.getBoundingClientRect();
        menu.style.left = `${Math.min(e.clientX, window.innerWidth - 240)}px`;
        menu.style.top = `${rect.top - menu.offsetHeight - 6}px`;
        this._menu = menu;
    }

    _closeMenu() {
        if (this._menu) {
            this._menu.remove();
            this._menu = null;
        }
    }
}
