/**
 * Timeline bar — the human view over the scene keyframe timeline (backlog 046).
 *
 * A thin VIEW: it never advances time itself (the render loop owns the only
 * clock — a second rAF clock would double-advance or fight demand rendering);
 * it polls the shared timeline store while visible and issues the same
 * play/pause/seek the agent commands use.
 */

import { pauseTimeline, playTimeline, seekTimeline } from "./viewer/timeline.js";

export class TimelinePanel {
    constructor(viewer) {
        this._viewer = viewer;
        this._bar = document.getElementById("timeline-bar");
        this._playBtn = document.getElementById("timeline-play-btn");
        this._scrub = document.getElementById("timeline-scrub");
        this._ticks = document.getElementById("timeline-ticks");
        this._timeEl = document.getElementById("timeline-time");
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

        // Poll the shared store (~5 Hz visible refresh; the 3D view itself is
        // driven by the render loop, this is only the widget).
        setInterval(() => this._refresh(), 200);
    }

    _duration() {
        const tl = this._viewer._timeline;
        if (!tl) return 0;
        if (tl.duration > 0) return tl.duration;
        let max = 0;
        for (const channels of tl.tracks.values()) {
            for (const keys of Object.values(channels)) {
                if (keys.length) max = Math.max(max, keys[keys.length - 1].t);
            }
        }
        return max;
    }

    _refresh() {
        const tl = this._viewer._timeline;
        const hasTracks = tl && tl.tracks.size > 0;
        this._bar.style.display = hasTracks ? "flex" : "none";
        if (!hasTracks) return;
        const dur = this._duration();
        this._playBtn.textContent = tl.playing ? "⏸" : "▶";
        if (dur > 0) {
            this._scrub.value = String((tl.time / dur) * 100);
            this._timeEl.textContent = `${tl.time.toFixed(1)}s / ${dur.toFixed(1)}s`;
        }
        // Keyframe tick marks (union of all key times).
        const times = new Set();
        for (const channels of tl.tracks.values()) {
            for (const keys of Object.values(channels)) {
                for (const k of keys) times.add(Math.round(k.t * 100) / 100);
            }
        }
        const sig = [...times].sort((a, b) => a - b).join(",") + "|" + dur;
        if (sig !== this._tickSig) {
            this._tickSig = sig;
            this._ticks.innerHTML = "";
            if (dur > 0) {
                for (const t of times) {
                    const tick = document.createElement("div");
                    tick.className = "timeline-tick";
                    tick.style.left = `${(t / dur) * 100}%`;
                    tick.title = `key @ ${t}s`;
                    this._ticks.appendChild(tick);
                }
            }
        }
    }
}
