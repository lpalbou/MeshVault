/**
 * Standalone MeshVault viewer — the embeddable, server-less rendering core.
 *
 * This is the second esbuild entry point. It bundles the Three.js engine + the control
 * API into a single self-contained ES module with NO backend dependency, so it can be
 * dropped into any page (or an AI-agent host) and driven entirely from the client.
 *
 * Usage (browser):
 *   import { createViewer } from "./meshvault-viewer.js";
 *   const mv = createViewer(document.getElementById("app"));
 *   await mv.execute({ action: "load", params: { url: "model.glb" } });
 *   await mv.execute({ action: "set_view", params: { preset: "iso" } });
 *   const shot = await mv.execute({ action: "screenshot" }); // PNG data URL
 *
 * It also attaches `window.MeshVaultViewer` for non-module / agent-bridge consumers.
 *
 * Resource resolution: a self-contained file (e.g. GLB with embedded textures, or any
 * URL-addressable asset) needs no resolver — the default returns the reference as-is so
 * relative URLs resolve against the host page. Callers with external textures can inject
 * their own `resolveResource(ref) => url` (e.g. a map of File object URLs).
 */

import { Viewer3D } from "../viewer_3d.js";
import { ViewerControlAPI } from "./control_api.js";

/**
 * Create a viewer + control API bound to a container element.
 *
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {(ref:string)=>string} [options.resolveResource] - map a resource ref to a URL.
 * @param {(event:string,data:any)=>void} [options.onEvent]
 * @returns {{
 *   viewer: Viewer3D,
 *   api: ViewerControlAPI,
 *   execute: (cmd:object)=>Promise<object>,
 *   getState: ()=>object,
 *   getSceneInfo: ()=>object,
 *   listCommands: ()=>object[],
 *   on: (event:string, cb:Function)=>Function,
 *   loadFile: (file:File)=>Promise<object>,
 *   destroy: ()=>void,
 * }}
 */
export function createViewer(container, options = {}) {
    if (!container) throw new Error("createViewer requires a container element");

    // Client-only default resolver: absolute references (http(s)/data/blob/rooted
    // paths) pass through unchanged; RELATIVE references resolve against the current
    // MODEL's URL directory — the way the platform loaders treat multi-file assets
    // (OBJ→MTL→textures, .gltf→.bin). Without this, a relative ref resolved against
    // the HOST PAGE and multi-file models silently loaded untextured (the confirmed
    // MCP bug). `viewer` is assigned below; the closure only runs during loads,
    // long after construction.
    const resolveResource = options.resolveResource || ((ref) => {
        if (/^(https?:|data:|blob:|\/)/i.test(ref)) return ref;
        const base = viewer && viewer.getModelBaseUrl();
        try {
            return base ? new URL(ref, new URL(base, window.location.href)).href : ref;
        } catch {
            return ref;
        }
    });

    const viewer = new Viewer3D(container, options.onInfoUpdate || (() => {}), {
        resolveResource,
        // Vendored Draco/Basis decoders live next to the page (e.g. ./vendor/...), so
        // compressed glTF works offline with no CDN. Override for custom hosting.
        assetBaseUrl: options.assetBaseUrl != null ? options.assetBaseUrl : "",
    });
    const api = new ViewerControlAPI(viewer, { onEvent: options.onEvent });

    return {
        viewer,
        api,
        execute: (cmd) => api.execute(cmd),
        getState: () => api.getState(),
        getSceneInfo: () => api.getSceneInfo(),
        listCommands: () => api.listCommands(),
        on: (event, cb) => api.on(event, cb),

        /**
         * Convenience for local file input / drag-drop: load a File without a server.
         * Creates a temporary object URL, loads, and revokes it after.
         */
        loadFile: async (file) => {
            const ext = "." + file.name.split(".").pop().toLowerCase();
            const url = URL.createObjectURL(file);
            try {
                return await api.execute({
                    action: "load",
                    params: { url, extension: ext, name: file.name },
                });
            } finally {
                URL.revokeObjectURL(url);
            }
        },

        destroy: () => {
            if (typeof api.destroy === "function") api.destroy();
            if (typeof viewer.destroy === "function") viewer.destroy();
        },
    };
}

// Attach a global for script-tag / agent-bridge consumers (no module import needed).
if (typeof window !== "undefined") {
    window.MeshVaultViewer = { createViewer };
}
