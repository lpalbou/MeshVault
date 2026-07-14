/**
 * AiBar — the in-app AI: a Spotlight-style command bar + progress panel.
 *
 * The user presses ⌘K (or the AI toolbar button), types an instruction
 * ("add a red sphere and put a dent in it"), and a local-LLM agent
 * (backend/ai_pilot.py, LM Studio) edits THIS tab's scene live:
 *
 *   bar → POST /api/ai/instruct → agent loop → SSE {type:"ai_command"} →
 *   this module executes it on the tab's ViewerControlAPI →
 *   POST /api/ai/result → agent continues → {type:"ai_progress"} → panel.
 *
 * Contracts that matter:
 * - Only the INITIATING tab executes commands: ai_command carries client_id;
 *   other tabs ignore it (two tabs racing the same brush would double-apply).
 * - While a task runs, the bar stays available: a new instruction is a
 *   mid-run course correction (queued into the agent's conversation), the
 *   Esc key or Stop button halts at the next safe boundary.
 * - Execution reuses the SAME control API humans and MCP agents use — the
 *   agent cannot do anything a human couldn't click.
 */

// Per-TAB identity that survives reloads (sessionStorage is tab-scoped):
// a mid-task reload would otherwise change the id and orphan the running
// task's commands ("tab did not answer" until timeout).
const CLIENT_ID = (() => {
    try {
        let id = sessionStorage.getItem("mv_ai_client_id");
        if (!id) {
            id = `tab-${Math.random().toString(36).slice(2, 10)}`;
            sessionStorage.setItem("mv_ai_client_id", id);
        }
        return id;
    } catch {
        return `tab-${Math.random().toString(36).slice(2, 10)}`;
    }
})();

export class AiBar {
    /**
     * @param {object} deps
     * @param {import("./viewer/control_api.js").ViewerControlAPI} deps.api
     * @param {(msg:string, type?:string)=>void} deps.showToast
     */
    constructor(deps) {
        this._api = deps.api;
        this._toast = deps.showToast;
        this._running = false;
        this._transcript = [];
        this._initDom();
    }

    /** Wire the SSE messages this module owns (called from AgentLink's stream). */
    handleEvent(msg) {
        if (msg.type === "ai_command") {
            this._execute(msg);
        } else if (msg.type === "ai_progress") {
            this._progress(msg);
        }
    }

    // ==========================================================
    // Command execution (the agent's hands in this tab)
    // ==========================================================

    async _execute(msg) {
        if (msg.client_id && msg.client_id !== CLIENT_ID) return;
        const command = msg.command || {};
        let result;
        try {
            result = await this._api.execute({
                action: command.action, params: command.params || {},
            });
        } catch (err) {
            result = { ok: false, error: String(err && err.message || err) };
        }
        try {
            await fetch("/api/ai/result", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: msg.id, result }),
            });
        } catch { /* backend gone — its timeout answers honestly */ }
    }

    // ==========================================================
    // Spotlight bar
    // ==========================================================

    _initDom() {
        this._bar = document.getElementById("ai-bar");
        this._input = document.getElementById("ai-bar-input");
        this._hint = document.getElementById("ai-bar-hint");
        this._panel = document.getElementById("ai-panel");
        this._feed = document.getElementById("ai-feed");
        this._status = document.getElementById("ai-status");
        this._toggle = document.getElementById("ai-toggle");
        this._stopBtn = document.getElementById("ai-stop");

        if (this._toggle) {
            this._toggle.addEventListener("click", () => this.toggleBar());
        }
        if (this._stopBtn) {
            this._stopBtn.addEventListener("click", () => this._stop());
        }
        const closeBtn = document.getElementById("ai-panel-close");
        if (closeBtn) {
            closeBtn.addEventListener("click", () => {
                this._panel.style.display = "none";
            });
        }

        document.addEventListener("keydown", (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                this.toggleBar();
            } else if (e.key === "Escape" && this._barVisible()) {
                this.hideBar();
            }
        });

        if (this._input) {
            this._input.addEventListener("keydown", (e) => {
                e.stopPropagation();   // the app has global key handlers
                if (e.key === "Enter" && this._input.value.trim()) {
                    this._send(this._input.value.trim());
                } else if (e.key === "Escape") {
                    this.hideBar();
                }
            });
        }
    }

    _barVisible() {
        return this._bar && this._bar.style.display !== "none"
            && this._bar.style.display !== "";
    }

    toggleBar() {
        if (this._barVisible()) this.hideBar();
        else this.showBar();
    }

    showBar() {
        if (!this._bar) return;
        this._bar.style.display = "flex";
        if (this._hint) {
            this._hint.textContent = this._running
                ? "task running — a new instruction is a course correction, Stop halts"
                : "describe a scene change — a local model does it live (⌘K closes)";
        }
        this._input.value = "";
        this._input.focus();
    }

    hideBar() {
        if (this._bar) this._bar.style.display = "none";
        if (this._input) this._input.blur();
    }

    async _send(text) {
        this.hideBar();
        this._openPanel();
        try {
            const r = await fetch("/api/ai/instruct", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ instruction: text, client_id: CLIENT_ID }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                const detail = data.detail || `HTTP ${r.status}`;
                this._appendLine("error", detail);
                this._toast(`AI: ${detail}`, "error");
                return;
            }
            this._appendLine("user", text);
            if (data.queued) {
                this._toast("Correction delivered to the running task", "info");
            }
        } catch (err) {
            this._toast(`AI unreachable: ${err.message}`, "error");
        }
    }

    async _stop() {
        try {
            await fetch("/api/ai/stop", { method: "POST" });
        } catch { /* backend gone */ }
    }

    // ==========================================================
    // Progress panel
    // ==========================================================

    _openPanel() {
        if (this._panel) this._panel.style.display = "flex";
    }

    _progress(msg) {
        if (msg.kind === "start") {
            this._running = true;
            this._openPanel();
        }
        if (msg.kind === "done") this._running = false;
        if (this._status) {
            this._status.textContent = this._running ? "working…" : "idle";
            this._status.classList.toggle("ai-live", this._running);
        }
        this._appendLine(msg.kind, msg.text || "");
    }

    _appendLine(kind, text) {
        if (!this._feed) return;
        const div = document.createElement("div");
        div.className = `ai-line ai-${kind}`;
        const prefix = { user: "you", start: "·", say: "ai", tool: "→",
                         result: "·", shot: "📷", done: "✓", error: "✗" }[kind] || "·";
        div.textContent = `${prefix} ${text}`;
        this._feed.appendChild(div);
        while (this._feed.childElementCount > 200) {
            this._feed.removeChild(this._feed.firstChild);
        }
        this._feed.scrollTop = this._feed.scrollHeight;
    }
}
