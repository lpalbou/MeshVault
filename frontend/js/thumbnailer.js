/**
 * Thumbnailer — lazy, cached, client-side rendering of grid thumbnails.
 *
 * Strategy (backlog 014): the browser already owns a correct Three.js pipeline, so
 * we render previews here into a small offscreen renderer and persist them via the
 * backend cache. On a second visit the GET returns the cached PNG instantly and we
 * never re-render.
 *
 * Cost control: a single shared renderer, a bounded queue processed one item at a
 * time, and generation driven by an IntersectionObserver in the grid so only visible
 * cards are ever rendered.
 */

import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

const THUMB_SIZE = 256;
const DB_NAME = "meshvault-thumbnails";
const STORE = "thumbs";

/**
 * Minimal IndexedDB key→dataURL store. Thumbnails persist in the *browser* (not the
 * server), so previews survive reloads while keeping the backend stateless — aligned
 * with the light/hybrid direction. Keys embed size+mtime so an edited asset misses the
 * stale entry and re-renders.
 */
function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(key) {
    try {
        const db = await openDb();
        return await new Promise((resolve) => {
            const tx = db.transaction(STORE, "readonly");
            const r = tx.objectStore(STORE).get(key);
            r.onsuccess = () => resolve(r.result || null);
            r.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

async function idbPut(key, dataUrl) {
    try {
        const db = await openDb();
        await new Promise((resolve) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(dataUrl, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch {
        /* best-effort cache; ignore quota/availability errors */
    }
}

export class Thumbnailer {
    constructor() {
        this._queue = [];
        this._busy = false;
        this._renderer = null;
        this._scene = null;
        this._camera = null;
        // Track in-flight/served requests so the same asset is not rendered twice.
        this._requested = new Set();
    }

    /** Stable identity key for an asset (dedupe within a render pass). */
    static keyForAsset(asset) {
        return asset.is_in_archive
            ? `${asset.archive_path}!${asset.inner_path}`
            : asset.path;
    }

    /** Cache key with invalidation: identity + size + mtime. */
    static cacheKey(asset) {
        return `${Thumbnailer.keyForAsset(asset)}|${asset.size ?? 0}|${asset.mtime ?? 0}`;
    }

    /**
     * Request a thumbnail for an asset into the given <img> element.
     * Tries the server cache first; only renders on a cache miss.
     */
    request(asset, imgEl) {
        const key = Thumbnailer.keyForAsset(asset);
        if (this._requested.has(key)) return;
        this._requested.add(key);
        this._queue.push({ asset, imgEl, key });
        this._pump();
    }

    /** Drop pending work (e.g. when the folder changes). */
    reset() {
        this._queue = [];
        this._requested.clear();
    }

    async _pump() {
        if (this._busy) return;
        this._busy = true;
        try {
            while (this._queue.length > 0) {
                const job = this._queue.shift();
                // Skip if the image was detached (card scrolled away & re-rendered).
                if (!job.imgEl.isConnected) continue;
                try {
                    await this._process(job);
                } catch (err) {
                    // A failed thumbnail is non-fatal: the card keeps its icon.
                    console.debug("Thumbnail failed:", job.key, err);
                }
                // Yield so the UI stays responsive between renders.
                await new Promise((r) => setTimeout(r, 15));
            }
        } finally {
            this._busy = false;
        }
    }

    async _process(job) {
        const { asset, imgEl } = job;
        const cacheKey = Thumbnailer.cacheKey(asset);

        // 1. Cache hit in the browser?
        const cached = await idbGet(cacheKey);
        if (cached) {
            imgEl.src = cached;         // stored as a data: URL — nothing to revoke
            imgEl.classList.add("loaded");
            return;
        }

        // 2. Miss → resolve to a loadable URL, render, persist to IndexedDB.
        const resolved = await this._resolveAsset(asset);
        if (!resolved) return;
        const { url, ext } = resolved;
        const object = await this._load(url, ext);
        if (!object) return;

        const dataUrl = this._render(object);
        this._disposeObject(object);
        if (!dataUrl) return;

        imgEl.src = dataUrl;
        imgEl.classList.add("loaded");
        idbPut(cacheKey, dataUrl);      // fire-and-forget
    }

    async _resolveAsset(asset) {
        const ext = (asset.extension || "").toLowerCase();
        if (asset.is_in_archive) {
            const prep = await fetch(
                `/api/asset/prepare_archive?archive_path=${encodeURIComponent(asset.archive_path)}` +
                `&inner_path=${encodeURIComponent(asset.inner_path)}`
            );
            if (!prep.ok) return null;
            const data = await prep.json();
            return { url: data.file_url, ext: (data.actual_extension || ext) };
        }
        return { url: `/api/asset/file?path=${encodeURIComponent(asset.path)}`, ext };
    }

    async _load(url, ext) {
        // Only the cheap, dependency-light formats are worth rendering as thumbnails.
        // Others fall back to their format icon (no thumbnail) to keep browsing fast.
        switch (ext) {
            case ".glb":
            case ".gltf": {
                const gltf = await new GLTFLoader().loadAsync(url);
                return gltf.scene;
            }
            case ".obj":
                return await new OBJLoader().loadAsync(url);
            case ".stl": {
                const geo = await new STLLoader().loadAsync(url);
                geo.computeVertexNormals();
                return this._wrapGeometry(geo);
            }
            case ".ply": {
                const geo = await new PLYLoader().loadAsync(url);
                if (!geo.hasAttribute("normal")) geo.computeVertexNormals();
                return this._wrapGeometry(geo, geo.hasAttribute("color"));
            }
            case ".fbx":
                return await new FBXLoader().loadAsync(url);
            default:
                return null;
        }
    }

    _wrapGeometry(geo, vertexColors = false) {
        const mat = new THREE.MeshStandardMaterial({
            color: vertexColors ? 0xffffff : 0x9aa0a6,
            vertexColors,
            roughness: 0.65,
            metalness: 0.1,
            side: THREE.DoubleSide,
        });
        const group = new THREE.Group();
        group.add(new THREE.Mesh(geo, mat));
        return group;
    }

    _ensureRenderer() {
        if (this._renderer) return;
        this._renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,
            preserveDrawingBuffer: true,
        });
        this._renderer.setSize(THUMB_SIZE, THUMB_SIZE);
        this._renderer.setClearColor(0x000000, 0);

        this._scene = new THREE.Scene();
        const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 1.1);
        this._scene.add(hemi);
        const key = new THREE.DirectionalLight(0xffffff, 1.4);
        key.position.set(2, 3, 2);
        this._scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.5);
        fill.position.set(-2, 1, -1);
        this._scene.add(fill);

        this._camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10000);
    }

    _render(object) {
        this._ensureRenderer();
        const scene = this._scene;
        scene.add(object);

        // Frame the object: fit its bounding sphere in view along a 3/4 angle.
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) {
            scene.remove(object);
            return null;
        }
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const r = sphere.radius || 1;
        const dist = r / Math.sin((this._camera.fov * Math.PI) / 180 / 2) * 1.15;
        const dir = new THREE.Vector3(1, 0.7, 1).normalize();
        this._camera.position.copy(sphere.center).addScaledVector(dir, dist);
        this._camera.lookAt(sphere.center);
        this._camera.near = Math.max(0.001, dist - r * 2);
        this._camera.far = dist + r * 2;
        this._camera.updateProjectionMatrix();

        this._renderer.render(scene, this._camera);
        const dataUrl = this._renderer.domElement.toDataURL("image/png");
        scene.remove(object);
        return dataUrl;
    }

    _disposeObject(object) {
        object.traverse((child) => {
            if (child.isMesh) {
                child.geometry?.dispose();
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                for (const m of mats) {
                    if (!m) continue;
                    for (const k of Object.keys(m)) {
                        if (m[k] && m[k].isTexture) m[k].dispose();
                    }
                    m.dispose();
                }
            }
        });
    }
}
