/**
 * 3D Viewer Component
 *
 * High-quality Three.js-based 3D model viewer with:
 * - PBR-quality lighting (hemisphere + multiple directional lights)
 * - Soft shadows with shadow mapping
 * - SSAO postprocessing for ambient occlusion
 * - Tone mapping for better dynamic range
 * - Anti-aliasing (MSAA)
 * - OrbitControls for interactive viewing
 * - Auto-framing to fit models to view
 * - Ground plane with shadow reception
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { TGALoader } from "three/addons/loaders/TGALoader.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { SimplifyModifier } from "three/addons/modifiers/SimplifyModifier.js";
import { VertexNormalsHelper } from "three/addons/helpers/VertexNormalsHelper.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";


export class Viewer3D {
    /**
     * @param {HTMLElement} container - The container element for the 3D canvas
     * @param {Function} onInfoUpdate - Callback to update viewer info (vertices, faces)
     */
    constructor(container, onInfoUpdate) {
        this._container = container;
        this._onInfoUpdate = onInfoUpdate;
        this._animationId = null;
        this._currentModel = null;
        this._mixers = []; // Animation mixers for FBX
        this._clock = new THREE.Clock();

        // Load guard: prevents race conditions when clicking assets rapidly
        this._loadId = 0;

        // Navigation mode: 'orbit' (default) or 'fpv' (drone)
        this._navMode = "orbit";
        this._keysPressed = new Set();
        this._moveSpeed = 1.0; // Adapted per model size
        this._yawSpeed = 1.5;  // Radians per second for A/D yaw
        // FPV mouse look state
        this._fpvMouseDown = false;
        this._fpvYaw = 0;
        this._fpvPitch = 0;
        // Stored initial view for spacebar reset
        this._initialCameraPos = new THREE.Vector3();
        this._initialTarget = new THREE.Vector3();

        this._initScene();
        this._initLights();
        this._initGround();
        this._initRenderer();
        this._initControls();
        this._initPivotPick();
        this._initKeyboardNav();
        this._initFPVMouseLook();
        this._initPostProcessing();
        this._startRenderLoop();

        // Handle resize
        this._resizeObserver = new ResizeObserver(() => this._onResize());
        this._resizeObserver.observe(this._container);
    }

    /**
     * Load a 3D model from a URL.
     *
     * @param {string} url - URL to the 3D file
     * @param {string} extension - File extension (.obj, .fbx)
     * @param {object} options - Additional loading options
     * @param {string[]} options.relatedFiles - Related file paths
     * @param {string} options.sourcePath - Absolute source file path for resolving
     *                                     relative resource references
     * @returns {Promise<{vertices: number, faces: number}>}
     */
    async loadModel(url, extension, options = {}) {
        // Increment load ID to guard against race conditions
        // (user clicking multiple assets rapidly)
        const thisLoadId = ++this._loadId;

        // Remove previous model and reset all viewer state
        this._clearModel();
        this._resetViewerState();

        const ext = extension.toLowerCase();

        let object;
        try {
            if (ext === ".obj") {
                object = await this._loadOBJ(url, options);
            } else if (ext === ".fbx") {
                object = await this._loadFBX(url, options);
            
            } else if (ext === ".gltf" || ext === ".glb") {
                object = await this._loadGLTF(url, options);
            } else if (ext === ".stl") {
                object = await this._loadSTL(url);
            } else {
                throw new Error(`Unsupported format: ${ext}`);
            }
        } catch (loadErr) {
            console.error(`Failed to load ${ext} model:`, loadErr);
            throw loadErr;
        }

        // If another load was started while we were loading, discard this result
        if (thisLoadId !== this._loadId) {
            this._disposeObject(object);
            return { vertices: 0, faces: 0 };
        }

        // Apply high-quality materials and settings
        this._enhanceModel(object);

        // Add to scene
        this._scene.add(object);
        this._currentModel = object;

        // Save a snapshot of the original geometry for Reset
        this._saveOriginalGeometry();

        // Re-apply persistent scene settings to the new model
        this._applySceneSettings();

        // Auto-frame the model
        this._frameModel(object);

        // Compute stats
        const stats = this._computeStats(object);
        this._onInfoUpdate(stats);

        return stats;
    }

    /** Remove the current model from the scene */
    _clearModel() {
        if (this._currentModel) {
            this._scene.remove(this._currentModel);
            this._disposeObject(this._currentModel);
            this._currentModel = null;
        }
        this._mixers = [];
        this._clearNormalsHelpers();
    }

    /**
     * Reset all viewer state when loading a new model.
     * Ensures clean slate: camera, navigation mode, FPV angles, scale, keys.
     */
    _resetViewerState() {
        // Switch back to orbit mode if in FPV
        if (this._navMode === "fpv") {
            this._navMode = "orbit";
            this._controls.enabled = true;
            this._fpvMouseDown = false;
            this._container.dispatchEvent(new CustomEvent("navmodechange", {
                detail: { mode: "orbit" }
            }));
        }

        // Clear keyboard state
        this._keysPressed.clear();

        // Reset FPV angles
        this._fpvYaw = 0;
        this._fpvPitch = 0;

        // Reset modified flag
        this._modelModified = false;

        // Reset camera to default position (will be overridden by _frameModel)
        this._camera.position.set(3, 2.5, 4);
        this._controls.target.set(0, 0.5, 0);
        this._controls.update();
    }

    /**
     * Re-apply persistent scene settings (wireframe, grid, axis, background)
     * to the newly loaded model. These settings survive across model loads.
     */
    _applySceneSettings() {
        // Wireframe: apply current state to the new model's meshes
        if (this._wireframeEnabled) {
            this.setWireframe(true);
        }

        // Normals: recreate helpers for the new model
        if (this._normalsVisible) {
            this.setNormalsVisible(true);
        }

        // Grid and axis visibility are already preserved on their scene objects.
        // Background is also already preserved on the scene.
    }

    /** Dispose of an object and its children recursively */
    _disposeObject(obj) {
        obj.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach((m) => this._disposeMaterial(m));
                } else {
                    this._disposeMaterial(child.material);
                }
            }
        });
    }

    _disposeMaterial(material) {
        for (const key of Object.keys(material)) {
            const value = material[key];
            if (value && typeof value === "object" && value.isTexture) {
                value.dispose();
            }
        }
        material.dispose();
    }

    /** Clean up the entire viewer */
    destroy() {
        if (this._animationId) {
            cancelAnimationFrame(this._animationId);
        }
        this._keysPressed.clear();
        this._resizeObserver.disconnect();
        this._clearModel();
        this._renderer.dispose();
        this._composer.dispose();
    }

    // ==========================================
    // Scene Setup
    // ==========================================

    _initScene() {
        this._scene = new THREE.Scene();

        // Subtle dark gradient background
        this._scene.background = new THREE.Color(0x0d0d1a);

        // Fog for depth perception
        this._scene.fog = new THREE.FogExp2(0x0d0d1a, 0.008);

        // Camera
        this._camera = new THREE.PerspectiveCamera(
            45,
            this._getAspect(),
            0.01,
            1000
        );
        this._camera.position.set(3, 2.5, 4);
    }

    _initLights() {
        // Hemisphere light for natural ambient
        this._hemiLight = new THREE.HemisphereLight(0xc8d8f0, 0x3a3a5c, 0.6);
        this._hemiLight.position.set(0, 20, 0);
        this._scene.add(this._hemiLight);

        // Key light (main directional) with shadows
        this._keyLight = new THREE.DirectionalLight(0xfff5e6, 1.2);
        this._keyLight.position.set(5, 8, 6);
        this._keyLight.castShadow = true;
        this._keyLight.shadow.mapSize.width = 2048;
        this._keyLight.shadow.mapSize.height = 2048;
        this._keyLight.shadow.camera.near = 0.1;
        this._keyLight.shadow.camera.far = 50;
        this._keyLight.shadow.camera.left = -10;
        this._keyLight.shadow.camera.right = 10;
        this._keyLight.shadow.camera.top = 10;
        this._keyLight.shadow.camera.bottom = -10;
        this._keyLight.shadow.bias = -0.001;
        this._keyLight.shadow.normalBias = 0.02;
        this._scene.add(this._keyLight);

        // Fill light (softer, from opposite side)
        this._fillLight = new THREE.DirectionalLight(0xb0c4de, 0.5);
        this._fillLight.position.set(-4, 4, -3);
        this._scene.add(this._fillLight);

        // Rim light (back light for edge definition)
        this._rimLight = new THREE.DirectionalLight(0x8090c0, 0.4);
        this._rimLight.position.set(0, 3, -6);
        this._scene.add(this._rimLight);

        // Ambient light as base fill
        this._ambientLight = new THREE.AmbientLight(0x404060, 0.3);
        this._scene.add(this._ambientLight);

        // Key light orientation state (azimuth/elevation in radians)
        // Default: ~45° azimuth, ~60° elevation — matches initial position (5, 8, 6)
        this._keyLightAzimuth = Math.PI / 4;
        this._keyLightElevation = Math.PI / 3;
        this._keyLightRadius = 10; // Updated when model is loaded
        this._modelCenter = new THREE.Vector3(0, 0.5, 0);
    }

    _initGround() {
        // Ground plane to receive shadows
        const groundGeo = new THREE.PlaneGeometry(50, 50);
        const groundMat = new THREE.ShadowMaterial({
            opacity: 0.3,
            color: 0x000000,
        });
        const ground = new THREE.Mesh(groundGeo, groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = 0;
        ground.receiveShadow = true;
        this._scene.add(ground);
        this._ground = ground;

        // Grid helper — created dynamically in _rebuildGrid(), scaled to model
        this._gridVisible = false;
        this._grid = null;
        this._currentBgHex = "#0d0d1a";

        // Axis helper (starts hidden, toggled via UI)
        this._axisVisible = false;
        this._axisGroup = new THREE.Group();
        this._axisGroup.visible = false;
        this._scene.add(this._axisGroup);
        this._buildAxisHelper(2);
    }

    /**
     * Rebuild the grid to match the current model size and background.
     *
     * SOTA practice: grid extends ~8x the model footprint with cell
     * size proportional to model dimensions. This ensures the grid
     * is always visible and provides meaningful spatial reference
     * regardless of model scale.
     */
    _rebuildGrid(modelMaxDim, groundY) {
        // Remove existing grid
        if (this._grid) {
            this._scene.remove(this._grid);
            this._grid.dispose();
            this._grid = null;
        }

        // Grid size: 8x the largest model dimension, minimum 10 units
        const gridSize = Math.max(modelMaxDim * 8, 10);

        // Divisions: aim for cells roughly 1/20th of model size
        // with a minimum of 20 and maximum of 200 divisions
        const cellSize = Math.max(modelMaxDim / 10, 0.01);
        const divisions = Math.min(200, Math.max(20, Math.round(gridSize / cellSize)));

        // Choose colors based on background luminance
        const bgColor = new THREE.Color(this._currentBgHex);
        const lum = bgColor.r * 0.299 + bgColor.g * 0.587 + bgColor.b * 0.114;
        const isDark = lum < 0.4;

        const mainColor = isDark ? 0x5577bb : 0x666688;
        const subColor = isDark ? 0x334466 : 0x9999aa;
        const opacity = isDark ? 0.5 : 0.4;

        const grid = new THREE.GridHelper(gridSize, divisions, mainColor, subColor);
        grid.position.y = groundY + 0.001;
        grid.position.x = this._modelCenter.x;
        grid.position.z = this._modelCenter.z;
        grid.material.opacity = opacity;
        grid.material.transparent = true;
        grid.visible = this._gridVisible;
        this._scene.add(grid);
        this._grid = grid;
    }

    /**
     * Build the axis helper with colored lines and text labels.
     * X = red, Y = green, Z = blue (standard convention).
     */
    _buildAxisHelper(size) {
        // Clear previous
        while (this._axisGroup.children.length > 0) {
            const c = this._axisGroup.children[0];
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
            this._axisGroup.remove(c);
        }

        const axes = [
            { dir: new THREE.Vector3(1, 0, 0), color: 0xff4444, label: "X" },
            { dir: new THREE.Vector3(0, 1, 0), color: 0x44dd44, label: "Y" },
            { dir: new THREE.Vector3(0, 0, 1), color: 0x4488ff, label: "Z" },
        ];

        for (const axis of axes) {
            // Line
            const points = [
                new THREE.Vector3(0, 0, 0),
                axis.dir.clone().multiplyScalar(size),
            ];
            const geo = new THREE.BufferGeometry().setFromPoints(points);
            const mat = new THREE.LineBasicMaterial({
                color: axis.color,
                linewidth: 2,
                depthTest: false,
            });
            const line = new THREE.Line(geo, mat);
            line.renderOrder = 999;
            this._axisGroup.add(line);

            // Label sprite
            const sprite = this._makeTextSprite(
                axis.label, axis.color, size
            );
            sprite.position.copy(axis.dir.clone().multiplyScalar(size * 1.15));
            sprite.renderOrder = 1000;
            this._axisGroup.add(sprite);
        }
    }

    /**
     * Create a text sprite for axis labels.
     */
    _makeTextSprite(text, color, size) {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.font = "bold 48px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#" + new THREE.Color(color).getHexString();
        ctx.fillText(text, 32, 32);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;

        const mat = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.setScalar(size * 0.3);
        return sprite;
    }

    _initRenderer() {
        this._renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            preserveDrawingBuffer: true,  // Required for screenshot (toDataURL)
            powerPreference: "high-performance",
        });
        this._renderer.setSize(
            this._container.clientWidth,
            this._container.clientHeight
        );
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this._renderer.shadowMap.enabled = true;
        this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this._renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this._renderer.toneMappingExposure = 1.2;
        this._renderer.outputColorSpace = THREE.SRGBColorSpace;

        this._container.appendChild(this._renderer.domElement);
    }

    _initControls() {
        this._controls = new OrbitControls(
            this._camera,
            this._renderer.domElement
        );
        this._controls.enableDamping = true;
        this._controls.dampingFactor = 0.08;
        this._controls.enablePan = true;
        this._controls.enableZoom = true;
        this._controls.minDistance = 0.01;
        this._controls.maxDistance = 1000;
        this._controls.target.set(0, 0.5, 0);
        this._controls.update();
    }

    /**
     * Initialize right-click-to-set-pivot behavior.
     *
     * A quick right-click (without dragging) raycasts onto the model
     * surface and sets the orbit controls target to that point.
     * Right-drag still works as pan (handled by OrbitControls).
     * Spacebar reset restores the original pivot.
     */
    _initPivotPick() {
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();
        let rightDownPos = null;
        let rightDownTime = 0;
        const CLICK_THRESHOLD_PX = 5;   // Max pixel movement to count as click
        const CLICK_THRESHOLD_MS = 300; // Max hold time to count as click

        // Suppress browser context menu on the viewer
        this._renderer.domElement.addEventListener("contextmenu", (e) => {
            e.preventDefault();
        });

        this._renderer.domElement.addEventListener("mousedown", (e) => {
            if (e.button === 2) {
                rightDownPos = { x: e.clientX, y: e.clientY };
                rightDownTime = performance.now();
            }
        });

        this._renderer.domElement.addEventListener("mouseup", (e) => {
            if (e.button !== 2 || !rightDownPos) return;

            const dx = e.clientX - rightDownPos.x;
            const dy = e.clientY - rightDownPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const elapsed = performance.now() - rightDownTime;

            rightDownPos = null;

            // Only treat as a pivot-pick if it was a quick click, not a drag
            if (dist > CLICK_THRESHOLD_PX || elapsed > CLICK_THRESHOLD_MS) return;

            // No model loaded — nothing to raycast against
            if (!this._currentModel) return;

            // Compute normalized device coordinates from click position
            const rect = this._renderer.domElement.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            raycaster.setFromCamera(mouse, this._camera);

            // Collect all meshes from the current model
            const meshes = [];
            this._currentModel.traverse((child) => {
                if (child.isMesh) meshes.push(child);
            });

            const hits = raycaster.intersectObjects(meshes, false);
            if (hits.length > 0) {
                const point = hits[0].point;
                this._controls.target.copy(point);
                this._controls.update();
            }
        });
    }

    /**
     * Initialize keyboard navigation.
     *
     * In Orbit mode: only Spacebar (reset view) is active.
     * In FPV mode: full drone controls:
     *   W/S = forward/backward (along camera's true look direction)
     *   A/D = yaw left/right (rotate the drone)
     *   ↑/↓ = pitch up/down
     *   ←/→ = yaw left/right
     *   E/Shift = altitude up, Q/Ctrl = altitude down
     *   Spacebar = reset view
     */
    _initKeyboardNav() {
        // Make the container focusable so it captures keyboard events
        this._container.setAttribute("tabindex", "0");
        this._container.style.outline = "none";

        this._container.addEventListener("keydown", (e) => {
            const key = e.key.toLowerCase();

            // Spacebar: reset view (both modes)
            if (e.code === "Space") {
                e.preventDefault();
                this._resetView();
                return;
            }

            // Only process nav keys in FPV mode
            if (this._navMode !== "fpv") return;

            const navKeys = [
                "w", "a", "s", "d", "q", "e",
                "arrowup", "arrowdown", "arrowleft", "arrowright",
                "shift", "control",
            ];
            if (navKeys.includes(key)) {
                e.preventDefault();
                this._keysPressed.add(key);
            }
        });

        this._container.addEventListener("keyup", (e) => {
            this._keysPressed.delete(e.key.toLowerCase());
        });

        // Clear keys when focus is lost to prevent stuck movement
        this._container.addEventListener("blur", () => {
            this._keysPressed.clear();
        });

        // Auto-focus the viewer when mouse enters, so keyboard works immediately
        this._container.addEventListener("mouseenter", () => {
            this._container.focus();
        });
    }

    /**
     * Initialize FPV mouse look behavior.
     *
     * In FPV mode, left-click drag rotates the camera (yaw + pitch).
     * Mouse sensitivity is tuned for smooth control.
     */
    _initFPVMouseLook() {
        const canvas = this._renderer.domElement;
        const sensitivity = 0.003;

        canvas.addEventListener("mousedown", (e) => {
            if (this._navMode !== "fpv") return;
            if (e.button === 0) { // Left button
                this._fpvMouseDown = true;
                e.preventDefault();
            }
        });

        canvas.addEventListener("mousemove", (e) => {
            if (!this._fpvMouseDown || this._navMode !== "fpv") return;

            this._fpvYaw -= e.movementX * sensitivity;
            this._fpvPitch -= e.movementY * sensitivity;

            // Clamp pitch to avoid flipping (-85° to +85°)
            const limit = Math.PI * 0.47;
            this._fpvPitch = Math.max(-limit, Math.min(limit, this._fpvPitch));

            this._updateFPVCamera();
        });

        canvas.addEventListener("mouseup", (e) => {
            if (e.button === 0) this._fpvMouseDown = false;
        });

        canvas.addEventListener("mouseleave", () => {
            this._fpvMouseDown = false;
        });
    }

    /**
     * Update camera orientation from FPV yaw/pitch angles.
     */
    _updateFPVCamera() {
        // Build direction vector from yaw and pitch
        const dir = new THREE.Vector3(
            Math.sin(this._fpvYaw) * Math.cos(this._fpvPitch),
            Math.sin(this._fpvPitch),
            Math.cos(this._fpvYaw) * Math.cos(this._fpvPitch)
        );

        // Camera looks at a point 1 unit ahead in that direction
        const target = this._camera.position.clone().add(dir);
        this._camera.lookAt(target);
    }

    /**
     * Apply FPV drone movement each frame.
     *
     * W/Shift = move forward along camera's TRUE look direction
     * S/Ctrl  = move backward
     * A/D and ←/→ = yaw (rotate the drone left/right)
     * ↑/↓ = pitch (tilt the drone up/down)
     * E = altitude up, Q = altitude down
     */
    _applyFPVMovement(delta) {
        if (this._navMode !== "fpv") return;
        if (this._keysPressed.size === 0) return;

        const speed = this._moveSpeed * delta;
        const yawRate = this._yawSpeed * delta;
        const pitchRate = this._yawSpeed * 0.6 * delta;

        // Camera's true forward direction (where it's pointing, including pitch)
        const forward = new THREE.Vector3();
        this._camera.getWorldDirection(forward);

        // World up
        const up = new THREE.Vector3(0, 1, 0);

        const move = new THREE.Vector3();

        // Forward / backward along camera's true look direction
        // W and Shift = forward thrust, S and Ctrl = backward thrust
        if (this._keysPressed.has("w") || this._keysPressed.has("shift")) {
            move.add(forward.clone().multiplyScalar(speed));
        }
        if (this._keysPressed.has("s") || this._keysPressed.has("control")) {
            move.add(forward.clone().multiplyScalar(-speed));
        }

        // Yaw: A/D and arrow left/right ROTATE the drone
        if (this._keysPressed.has("a") || this._keysPressed.has("arrowleft")) {
            this._fpvYaw += yawRate;
        }
        if (this._keysPressed.has("d") || this._keysPressed.has("arrowright")) {
            this._fpvYaw -= yawRate;
        }

        // Pitch: arrow up/down tilt the drone
        if (this._keysPressed.has("arrowup")) {
            this._fpvPitch += pitchRate;
        }
        if (this._keysPressed.has("arrowdown")) {
            this._fpvPitch -= pitchRate;
        }

        // Clamp pitch
        const limit = Math.PI * 0.47;
        this._fpvPitch = Math.max(-limit, Math.min(limit, this._fpvPitch));

        // Altitude (E = up, Q = down)
        if (this._keysPressed.has("e")) {
            move.add(up.clone().multiplyScalar(speed));
        }
        if (this._keysPressed.has("q")) {
            move.add(up.clone().multiplyScalar(-speed));
        }

        // Apply translation
        if (move.lengthSq() > 0) {
            this._camera.position.add(move);
        }

        // Apply rotation
        this._updateFPVCamera();
    }

    // ==========================================
    // Mode Switching
    // ==========================================

    /**
     * Set the navigation mode.
     * @param {'orbit'|'fpv'} mode
     */
    setNavMode(mode) {
        if (mode === this._navMode) return;

        this._keysPressed.clear();

        if (mode === "fpv") {
            // Switching to FPV: extract yaw/pitch from current camera orientation
            const dir = new THREE.Vector3();
            this._camera.getWorldDirection(dir);
            this._fpvYaw = Math.atan2(dir.x, dir.z);
            this._fpvPitch = Math.asin(
                Math.max(-1, Math.min(1, dir.y))
            );

            // Disable orbit controls
            this._controls.enabled = false;

        } else {
            // Switching to Orbit: re-enable orbit controls
            // Set orbit target to a point in front of the camera
            const dir = new THREE.Vector3();
            this._camera.getWorldDirection(dir);
            const dist = this._camera.position.distanceTo(this._modelCenter);
            this._controls.target.copy(
                this._camera.position.clone().add(dir.multiplyScalar(dist * 0.5))
            );
            this._controls.enabled = true;
            this._controls.update();
        }

        this._navMode = mode;
        this._fpvMouseDown = false;
    }

    /** Get the current navigation mode. */
    getNavMode() {
        return this._navMode;
    }

    /**
     * Reset the camera to the initial framed view (spacebar).
     * Also switches back to orbit mode.
     */
    _resetView() {
        this._camera.position.copy(this._initialCameraPos);
        this._controls.target.copy(this._initialTarget);
        this._controls.enabled = true;
        this._controls.update();

        // Reset to orbit mode
        if (this._navMode === "fpv") {
            this._navMode = "orbit";
            this._fpvMouseDown = false;
            this._keysPressed.clear();
            // Notify the UI toggle (via custom event)
            this._container.dispatchEvent(new CustomEvent("navmodechange", {
                detail: { mode: "orbit" }
            }));
        }
    }

    _initPostProcessing() {
        this._composer = new EffectComposer(this._renderer);

        // Render pass
        const renderPass = new RenderPass(this._scene, this._camera);
        this._composer.addPass(renderPass);

        // SSAO pass for ambient occlusion
        const ssaoPass = new SSAOPass(
            this._scene,
            this._camera,
            this._container.clientWidth,
            this._container.clientHeight
        );
        ssaoPass.kernelRadius = 0.5;
        ssaoPass.minDistance = 0.001;
        ssaoPass.maxDistance = 0.1;
        ssaoPass.output = SSAOPass.OUTPUT.Default;
        this._composer.addPass(ssaoPass);
        this._ssaoPass = ssaoPass;

        // Output pass for correct color space
        const outputPass = new OutputPass();
        this._composer.addPass(outputPass);
    }

    // ==========================================
    // Model Loading
    // ==========================================

    _loadOBJ(url, options = {}) {
        return new Promise((resolve, reject) => {
            const manager = new THREE.LoadingManager();
            const relatedFiles = options.relatedFiles || [];

            // Check if there's a .mtl file among related files
            const mtlFile = relatedFiles.find((f) =>
                f.toLowerCase().endsWith(".mtl")
            );

            if (mtlFile) {
                // Load with material
                const mtlUrl = `/api/asset/related?path=${encodeURIComponent(mtlFile)}`;

                // We need to determine the base path for the MTL loader
                // to resolve texture paths relative to the MTL file
                const mtlLoader = new MTLLoader(manager);

                // Override the resource path to use our API
                mtlLoader.setResourcePath("");

                fetch(mtlUrl)
                    .then((res) => res.text())
                    .then((mtlText) => {
                        // Rewrite texture paths in the MTL to use our API
                        const mtlDir = mtlFile.substring(
                            0,
                            mtlFile.lastIndexOf("/") + 1
                        ) || mtlFile.substring(
                            0,
                            mtlFile.lastIndexOf("\\") + 1
                        );
                        const rewrittenMtl = this._rewriteMtlTexturePaths(
                            mtlText,
                            mtlDir
                        );

                        const materials = mtlLoader.parse(rewrittenMtl, "");
                        materials.preload();

                        const objLoader = new OBJLoader(manager);
                        objLoader.setMaterials(materials);
                        objLoader.load(
                            url,
                            (obj) => resolve(obj),
                            undefined,
                            (err) => {
                                // Fallback: load without materials
                                console.warn("MTL load failed, loading OBJ without materials:", err);
                                const fallbackLoader = new OBJLoader();
                                fallbackLoader.load(url, resolve, undefined, reject);
                            }
                        );
                    })
                    .catch(() => {
                        // Fallback: load without materials
                        const objLoader = new OBJLoader();
                        objLoader.load(url, resolve, undefined, reject);
                    });
            } else {
                // Load without material
                const objLoader = new OBJLoader(manager);
                objLoader.load(url, resolve, undefined, reject);
            }
        });
    }

    _loadFBX(url, options = {}) {
        return new Promise((resolve, reject) => {
            // Set up a loading manager that redirects texture requests
            // through our API. This is essential for archived assets where
            // textures are extracted to a temp directory.
            const manager = new THREE.LoadingManager();
            const relatedFiles = options.relatedFiles || [];
            const sourcePath = options.sourcePath || null;

            // Build filename -> absolute path map from extracted related files.
            const textureMap = {};
            for (const f of relatedFiles) {
                if (!this._isTextureFilePath(f)) continue;
                const filename = f.split("/").pop().split("\\").pop().toLowerCase();
                if (!(filename in textureMap)) {
                    textureMap[filename] = f;
                }
            }

            // Always install URL resolver for FBX resources.
            // This handles:
            // 1) Archive-related files (from relatedFiles map)
            // 2) Direct FBX files using relative texture paths next to sourcePath
            // 3) Absolute filesystem paths embedded in FBX
            manager.setURLModifier((resourceUrl) => {
                const resolvedPath = this._resolveFBXResourcePath(
                    resourceUrl,
                    sourcePath,
                    textureMap
                );
                if (resolvedPath) {
                    return `/api/asset/related?path=${encodeURIComponent(resolvedPath)}`;
                }
                return resourceUrl;
            });

            const loader = new FBXLoader(manager);
            loader.load(
                url,
                async (object) => {
                    try {
                        // Handle FBX animations
                        if (object.animations && object.animations.length > 0) {
                            const mixer = new THREE.AnimationMixer(object);
                            const action = mixer.clipAction(object.animations[0]);
                            action.play();
                            this._mixers.push(mixer);
                        }

                        // Fallback for FBX exports that omit texture links:
                        // if no maps are bound, auto-assign from related files
                        // by filename conventions (_d, _n, _ao, etc.).
                        if (relatedFiles.length > 0) {
                            await this._autoBindFBXTextures(object, relatedFiles);
                        }

                        resolve(object);
                    } catch (err) {
                        console.error("FBX post-load processing error:", err);
                        // Still resolve with the object even if animations fail
                        resolve(object);
                    }
                },
                undefined,
                (err) => {
                    console.error("FBX loader error:", err);
                    reject(new Error(
                        `FBX loading failed: ${err?.message || err || "Unknown error. The file may use an unsupported FBX version."}`
                    ));
                }
            );
        });
    }

    /**
     * Resolve an FBX-referenced resource URL to an absolute filesystem path.
     * Returns null when the URL should not be rewritten.
     */
    _resolveFBXResourcePath(resourceUrl, sourcePath, textureMap) {
        if (!resourceUrl) return null;
        const trimmed = String(resourceUrl).trim();
        if (!trimmed) return null;

        // Ignore external/data URLs.
        if (/^(data:|blob:|https?:\/\/)/i.test(trimmed)) return null;

        // Already resolved through our API, or the main model URL itself.
        if (
            trimmed.startsWith("/api/asset/related?") ||
            trimmed.startsWith("/api/asset/file?")
        ) {
            return null;
        }

        let clean = trimmed.split("?")[0].split("#")[0];

        // Malformed FBX refs sometimes come as "/api/asset/<filename>".
        // Keep /api/asset/file and /api/asset/related untouched, but salvage
        // bare "/api/asset/<name>" by stripping the prefix and resolving it.
        if (clean.startsWith("/api/asset/")) {
            if (
                clean.startsWith("/api/asset/file") ||
                clean.startsWith("/api/asset/related")
            ) {
                return null;
            }
            clean = clean.slice("/api/asset/".length);
        } else if (clean.startsWith("/api/")) {
            return null;
        }
        const filename = clean.split("/").pop().split("\\").pop();
        if (filename) {
            const match = textureMap[filename.toLowerCase()];
            if (match) return this._normalizeFsPath(match);
        }

        // Absolute filesystem path embedded in FBX.
        if (/^[a-zA-Z]:[\\/]/.test(clean) || clean.startsWith("/")) {
            return this._normalizeFsPath(clean);
        }

        // Relative path from source FBX directory.
        if (sourcePath) {
            const sourceNorm = this._normalizeFsPath(sourcePath);
            const idx = sourceNorm.lastIndexOf("/");
            const baseDir = idx >= 0 ? sourceNorm.slice(0, idx) : "";
            if (baseDir) {
                return this._resolveRelativeFsPath(baseDir, clean);
            }
        }

        return null;
    }

    _normalizeFsPath(path) {
        const raw = String(path).replace(/\\/g, "/");
        const isUnixAbs = raw.startsWith("/");

        const out = [];
        const parts = raw.split("/");
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part || part === ".") {
                if (i === 0 && isUnixAbs) out.push("");
                continue;
            }
            if (part === "..") {
                if (
                    out.length > 0 &&
                    out[out.length - 1] !== "" &&
                    out[out.length - 1] !== ".."
                ) {
                    out.pop();
                }
                continue;
            }
            out.push(part);
        }
        if (isUnixAbs && out[0] !== "") out.unshift("");
        return out.join("/");
    }

    _resolveRelativeFsPath(baseDir, relPath) {
        const rel = String(relPath).replace(/\\/g, "/");
        if (/^[a-zA-Z]:[\\/]/.test(relPath) || rel.startsWith("/")) {
            return this._normalizeFsPath(rel);
        }
        return this._normalizeFsPath(`${baseDir}/${rel}`);
    }

    /**
     * Auto-bind textures for FBX files when texture links are missing.
     *
     * Robust logic:
     * - Supports TGA (common in DCC exports)
     * - Scores texture candidates per material name (including numeric tokens)
     * - Assigns maps per material instead of one global texture for all
     * - Gracefully falls back when naming conventions are inconsistent
     */
    async _autoBindFBXTextures(object, relatedFiles) {
        const textureEntries = (relatedFiles || [])
            .filter((p) => this._isTextureFilePath(p))
            .map((p) => this._buildTextureEntry(p));
        if (textureEntries.length === 0) return 0;

        // Deduplicate material instances across meshes.
        const materials = [];
        const seen = new Set();
        object.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
                if (!mat || seen.has(mat)) continue;
                seen.add(mat);
                materials.push(mat);
            }
        });

        const textureCache = new Map();
        let needsUv2 = false;
        let applied = 0;

        for (const mat of materials) {
            const matName = mat.name || "";
            let changed = false;
            this._sanitizeMaterialTextureSlots(mat);

            const pick = (slot) => this._pickBestTextureEntry(textureEntries, matName, slot);

            const currentMapName = this._extractTextureFilename(mat.map);
            const mapLooksWrong = this._isLikelyNonColorTextureName(currentMapName);
            if (!this._isUsableTexture(mat.map) || mapLooksWrong) {
                const entry = pick("map");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.SRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    // Avoid replacing with the same likely-wrong file.
                    if (!(mapLooksWrong && currentMapName && entry?.fileLower === currentMapName)) {
                        mat.map = tex;
                        changed = true;
                    }
                }
            }

            if (!this._isUsableTexture(mat.normalMap)) {
                const entry = pick("normalMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.LinearSRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.normalMap = tex;
                    // DirectX normal maps have inverted green channel.
                    if (entry?.isDirectX) {
                        mat.normalScale = new THREE.Vector2(1, -1);
                    }
                    changed = true;
                }
            }

            if (!this._isUsableTexture(mat.aoMap)) {
                const entry = pick("aoMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.LinearSRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.aoMap = tex;
                    mat.aoMapIntensity = 1.0;
                    needsUv2 = true;
                    changed = true;
                }
            }

            if (mat.roughness !== undefined && !this._isUsableTexture(mat.roughnessMap)) {
                const entry = pick("roughnessMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.LinearSRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.roughnessMap = tex;
                    mat.roughness = Math.max(0.45, mat.roughness);
                    changed = true;
                }
            }

            if (mat.metalness !== undefined && !this._isUsableTexture(mat.metalnessMap)) {
                const entry = pick("metalnessMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.LinearSRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.metalnessMap = tex;
                    mat.metalness = Math.min(0.2, mat.metalness);
                    changed = true;
                }
            }

            if (!this._isUsableTexture(mat.bumpMap)) {
                const entry = pick("bumpMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.LinearSRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.bumpMap = tex;
                    mat.bumpScale = 0.05;
                    changed = true;
                }
            }

            if (!this._isUsableTexture(mat.emissiveMap)) {
                const entry = pick("emissiveMap");
                const tex = await this._loadTextureFromAbsPath(
                    entry?.path,
                    THREE.SRGBColorSpace,
                    textureCache
                );
                if (tex) {
                    mat.emissiveMap = tex;
                    if (mat.emissive && this._isVeryDark(mat.emissive)) {
                        mat.emissive.set(0xffffff);
                    }
                    if (mat.emissiveIntensity !== undefined) {
                        mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 1.0);
                    }
                    changed = true;
                }
            }

            if (changed) {
                mat.needsUpdate = true;
                applied += 1;
            }
        }

        // AO maps require uv2 in Three.js. Copy uv -> uv2 when missing.
        if (needsUv2) {
            object.traverse((child) => {
                if (!child.isMesh || !child.geometry) return;
                if (child.geometry.hasAttribute("uv") && !child.geometry.hasAttribute("uv2")) {
                    child.geometry.setAttribute("uv2", child.geometry.getAttribute("uv").clone());
                }
            });
        }

        return applied;
    }

    _isUsableTexture(tex) {
        if (!tex || !tex.isTexture) return false;
        const img = tex.image || tex.source?.data || null;
        if (!img) return false;
        if (
            typeof img.width === "number" &&
            typeof img.height === "number" &&
            (img.width === 0 || img.height === 0)
        ) {
            return false;
        }
        return true;
    }

    _extractTextureFilename(tex) {
        if (!tex || !tex.isTexture) return "";
        const img = tex.image || tex.source?.data || null;
        const src = img?.currentSrc || img?.src || "";
        if (!src) return "";
        try {
            let raw = String(src);
            if (raw.includes("/api/asset/related?")) {
                const m = raw.match(/[?&]path=([^&]+)/);
                if (m && m[1]) {
                    raw = decodeURIComponent(m[1]);
                }
            }
            raw = raw.split("?")[0].split("#")[0];
            return raw.split("/").pop().split("\\").pop().toLowerCase();
        } catch {
            return "";
        }
    }

    _isLikelyNonColorTextureName(name) {
        if (!name) return false;
        const stem = String(name).toLowerCase().replace(/\.[^.]+$/, "");
        return /(^|[_\-\s])(normal|nrm|nor|rough|roughness|metal|metallic|ao|occlusion|height|disp|displacement|bump|spec|specular|gloss|glossiness|emissive|emission|mask|alpha|opacity|id|wire|g|s)([_\-\s]|$)/.test(stem);
    }

    _sanitizeMaterialTextureSlots(material) {
        if (!material) return false;
        const textureSlots = [
            "map",
            "normalMap",
            "aoMap",
            "roughnessMap",
            "metalnessMap",
            "bumpMap",
            "emissiveMap",
            "alphaMap",
        ];
        let changed = false;
        for (const slot of textureSlots) {
            const tex = material[slot];
            if (tex && tex.isTexture && !this._isUsableTexture(tex)) {
                material[slot] = null;
                changed = true;
            }
        }
        if (changed) {
            material.needsUpdate = true;
        }
        return changed;
    }

    _isTextureFilePath(path) {
        const lower = path.toLowerCase();
        return (
            lower.endsWith(".png") ||
            lower.endsWith(".jpg") ||
            lower.endsWith(".jpeg") ||
            lower.endsWith(".tga") ||
            lower.endsWith(".bmp") ||
            lower.endsWith(".webp") ||
            lower.endsWith(".gif") ||
            lower.endsWith(".tif") ||
            lower.endsWith(".tiff")
        );
    }

    _buildTextureEntry(path) {
        const file = path.split("/").pop().split("\\").pop();
        const fileLower = file.toLowerCase();
        const stemLower = fileLower.replace(/\.[^.]+$/, "");
        return {
            path,
            fileLower,
            stemLower,
            slot: this._classifyTextureSlotFromPath(path),
            tokens: this._tokenizeName(stemLower),
            isDirectX: stemLower.includes("directx") || stemLower.includes("_dx"),
            isOpenGL: stemLower.includes("opengl") || stemLower.includes("_ogl"),
        };
    }

    _tokenizeName(name) {
        const raw = (name || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim()
            .split(/\s+/)
            .filter(Boolean);

        // Normalize numeric tokens so "01" and "1" match.
        return raw.map((tok) => (/^\d+$/.test(tok) ? String(parseInt(tok, 10)) : tok));
    }

    _scoreTextureEntry(materialName, entry, targetSlot) {
        const materialTokens = this._tokenizeName(materialName);
        const tokenSet = new Set(materialTokens);

        let score = 0;

        // Slot fitness
        if (entry.slot === targetSlot) {
            score += 60;
        } else if (targetSlot === "map" && entry.slot === "other") {
            score += 25;
        } else if (entry.slot === "other") {
            score += 5;
        } else {
            score -= 15;
        }

        // Token overlap between material and texture names
        let overlap = 0;
        for (const token of entry.tokens) {
            if (tokenSet.has(token)) {
                overlap += 1;
                score += /^\d+$/.test(token) ? 10 : 6;
            }
        }

        // Weak fallback by compact-string containment
        if (overlap === 0) {
            const matCompact = materialTokens.join("");
            const texCompact = entry.tokens.join("");
            if (matCompact && texCompact) {
                if (matCompact.includes(texCompact) || texCompact.includes(matCompact)) {
                    score += 8;
                }
            }
        } else {
            score += overlap * 2;
        }

        // Prefer OpenGL normals over DirectX normals in Three.js.
        if (targetSlot === "normalMap") {
            if (entry.isOpenGL) score += 8;
            if (entry.isDirectX) score -= 4;
        }

        // Avoid obviously wrong diffuse picks.
        if (targetSlot === "map") {
            if (/(diffuse|albedo|basecolor|base_color|color|col)/.test(entry.stemLower)) {
                score += 20;
            }
            if (this._isLikelyNonColorTextureName(entry.fileLower)) {
                score -= 35;
            }
        }

        return score;
    }

    _pickBestTextureEntry(entries, materialName, targetSlot) {
        if (!entries || entries.length === 0) return null;

        let best = null;
        let bestScore = -Infinity;
        for (const entry of entries) {
            const score = this._scoreTextureEntry(materialName, entry, targetSlot);
            if (score > bestScore) {
                bestScore = score;
                best = entry;
            }
        }

        // If scoring is weak, prefer deterministic slot fallback.
        if (bestScore < 15) {
            const slotCandidates = entries.filter((entry) => (
                entry.slot === targetSlot ||
                (targetSlot === "map" && entry.slot === "other")
            ));
            if (slotCandidates.length === 0) return null;
            if (targetSlot === "normalMap") {
                return (
                    slotCandidates.find((entry) => entry.isOpenGL) ||
                    slotCandidates.find((entry) => !entry.isDirectX) ||
                    slotCandidates[0]
                );
            }
            return slotCandidates[0];
        }

        return best;
    }

    async _loadTextureFromAbsPath(absPath, colorSpace, cache = null) {
        if (!absPath) return null;

        const cacheKey = `${absPath}|${colorSpace || "none"}`;
        if (cache && cache.has(cacheKey)) {
            return cache.get(cacheKey);
        }

        const promise = new Promise((resolve) => {
            const url = `/api/asset/related?path=${encodeURIComponent(absPath)}`;
            const lower = absPath.toLowerCase();
            const onLoad = (tex) => {
                if (!tex) return resolve(null);
                if (colorSpace) tex.colorSpace = colorSpace;
                tex.needsUpdate = true;
                resolve(tex);
            };
            const onError = () => resolve(null);

            if (lower.endsWith(".tga")) {
                const loader = new TGALoader();
                loader.load(url, onLoad, undefined, onError);
            } else {
                const loader = new THREE.TextureLoader();
                loader.load(url, onLoad, undefined, onError);
            }
        });

        if (cache) {
            cache.set(cacheKey, promise);
        }
        return promise;
    }

    /**
     * Classify a texture file into the most likely material slot.
     */
    _classifyTextureSlotFromPath(path) {
        const file = path.split("/").pop().split("\\").pop().toLowerCase();
        const stem = file.replace(/\.[^.]+$/, "");

        if (/(^|[_\-\s])(n|nor|nrm|normal|normalmap)([_\-\s]|$)/.test(stem)) {
            return "normalMap";
        }
        if (/(^|[_\-\s])(ao|occlusion|ambientocclusion)([_\-\s]|$)/.test(stem)) {
            return "aoMap";
        }
        if (/(^|[_\-\s])(emissive|emission|emit|glow)([_\-\s]|$)/.test(stem)) {
            return "emissiveMap";
        }
        if (/(^|[_\-\s])(rough|roughness|rgh|gloss|glossiness|spec|specular|g|s)([_\-\s]|$)/.test(stem)) {
            return "roughnessMap";
        }
        if (/(^|[_\-\s])(metal|metallic|mtl|met)([_\-\s]|$)/.test(stem)) {
            return "metalnessMap";
        }
        if (/(^|[_\-\s])(height|disp|displacement|bump)([_\-\s]|$)/.test(stem)) {
            return "bumpMap";
        }
        if (/(^|[_\-\s])(d|diff|diffuse|albedo|basecolor|base_color|color|col)([_\-\s]|$)/.test(stem)) {
            return "map";
        }

        // For unlabeled color textures (e.g. "Asteroids_01.jpg"), default to map.
        if (/\.(png|jpg|jpeg|tga|bmp|webp|gif|tif|tiff)$/.test(file)) {
            return "map";
        }

        return "other";
    }

    _loadSTL(url) {
        return new Promise((resolve, reject) => {
            const loader = new STLLoader();
            loader.load(
                url,
                (geometry) => {
                    // STLLoader returns a BufferGeometry, not a mesh
                    // Wrap it in a mesh with a default material
                    geometry.computeVertexNormals();
                    const material = new THREE.MeshStandardMaterial({
                        color: 0x808080,
                        roughness: 0.6,
                        metalness: 0.1,
                        side: THREE.DoubleSide,
                    });
                    const mesh = new THREE.Mesh(geometry, material);
                    const group = new THREE.Group();
                    group.add(mesh);
                    resolve(group);
                },
                undefined,
                (err) => {
                    console.error("STL loader error:", err);
                    reject(new Error(
                        `STL loading failed: ${err?.message || err || "Unknown error"}`
                    ));
                }
            );
        });
    }

    _loadGLTF(url) {
        return new Promise((resolve, reject) => {
            const loader = new GLTFLoader();
            loader.load(
                url,
                (gltf) => {
                    try {
                        const object = gltf.scene;
                        // Handle GLTF animations
                        if (gltf.animations && gltf.animations.length > 0) {
                            const mixer = new THREE.AnimationMixer(object);
                            const action = mixer.clipAction(gltf.animations[0]);
                            action.play();
                            this._mixers.push(mixer);
                        }
                        resolve(object);
                    } catch (err) {
                        console.error("GLTF post-load error:", err);
                        resolve(gltf.scene);
                    }
                },
                undefined,
                (err) => {
                    console.error("GLTF loader error:", err);
                    reject(new Error(
                        `GLTF loading failed: ${err?.message || err || "Unknown error"}`
                    ));
                }
            );
        });
    }

    /**
     * Rewrite texture file paths in an MTL file to use our API endpoint.
     */
    _rewriteMtlTexturePaths(mtlText, mtlDir) {
        // Match lines like: map_Kd texture.png
        const textureKeywords = [
            "map_Ka", "map_Kd", "map_Ks", "map_Ns", "map_d",
            "map_bump", "bump", "disp", "decal", "map_Pr",
            "map_Pm", "norm",
        ];

        const lines = mtlText.split("\n");
        const rewritten = lines.map((line) => {
            const trimmed = line.trim();
            for (const keyword of textureKeywords) {
                if (trimmed.startsWith(keyword + " ")) {
                    const texPath = trimmed.substring(keyword.length + 1).trim();
                    // Build full path
                    const fullPath = mtlDir + texPath;
                    const apiUrl = `/api/asset/related?path=${encodeURIComponent(fullPath)}`;
                    return `${keyword} ${apiUrl}`;
                }
            }
            return line;
        });

        return rewritten.join("\n");
    }

    // ==========================================
    // Model Enhancement
    // ==========================================

    /**
     * Enhance loaded model with better materials, shadows, etc.
     */
    _enhanceModel(object) {
        object.traverse((child) => {
            if (child.isMesh) {
                // Enable shadows
                child.castShadow = true;
                child.receiveShadow = true;

                // Ensure geometry has normals for proper lighting
                if (child.geometry && !child.geometry.attributes.normal) {
                    child.geometry.computeVertexNormals();
                }

                // Upgrade materials for better rendering
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material = child.material.map((m) =>
                            this._upgradeMaterial(m)
                        );
                    } else {
                        child.material = this._upgradeMaterial(child.material);
                    }
                }
            }
        });
    }

    /**
     * Upgrade a basic material to MeshStandardMaterial for PBR rendering.
     * Preserves existing textures and colors.
     */
    _upgradeMaterial(material) {
        this._sanitizeMaterialTextureSlots(material);

        // Skip if already a standard/physical material
        if (
            material.isMeshStandardMaterial ||
            material.isMeshPhysicalMaterial
        ) {
            // Fix unreasonably dark colors that make the model invisible
            this._fixDarkColor(material);
            material.envMapIntensity = 0.5;
            material.needsUpdate = true;
            return material;
        }

        // Create a new MeshStandardMaterial preserving existing properties
        let color = material.color
            ? material.color.clone()
            : new THREE.Color(0x808080);

        const params = {
            color: color,
            roughness: 0.6,
            metalness: 0.1,
            envMapIntensity: 0.5,
            side: THREE.DoubleSide,
        };

        // Preserve textures if any
        if (this._isUsableTexture(material.map)) params.map = material.map;
        if (this._isUsableTexture(material.normalMap)) params.normalMap = material.normalMap;
        if (this._isUsableTexture(material.bumpMap)) params.bumpMap = material.bumpMap;
        if (this._isUsableTexture(material.alphaMap)) params.alphaMap = material.alphaMap;
        if (material.emissive) params.emissive = material.emissive.clone();
        if (this._isUsableTexture(material.emissiveMap)) {
            params.emissiveMap = material.emissiveMap;
            if (!params.emissive || this._isVeryDark(params.emissive)) {
                params.emissive = new THREE.Color(0xffffff);
            }
            params.emissiveIntensity = material.emissiveIntensity !== undefined
                ? Math.max(material.emissiveIntensity, 1.0)
                : 1.0;
        }
        if (material.transparent) params.transparent = true;
        if (material.opacity !== undefined) params.opacity = material.opacity;

        // If material has specular/emissive color but very dark diffuse,
        // use the specular or emissive as the base color instead
        if (material.specular && this._isVeryDark(color)) {
            if (!this._isVeryDark(material.specular)) {
                params.color = material.specular.clone();
            }
        }
        if (material.emissive && this._isVeryDark(color)) {
            if (!this._isVeryDark(material.emissive)) {
                params.color = material.emissive.clone();
            }
        }

        const upgraded = new THREE.MeshStandardMaterial(params);

        // Fix dark color after creation
        this._fixDarkColor(upgraded);

        // Dispose old material
        material.dispose();

        return upgraded;
    }

    /**
     * Check if a color is unreasonably dark (nearly black).
     */
    _isVeryDark(color) {
        if (!color) return true;
        const lum = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
        return lum < 0.15;
    }

    /**
     * Fix materials that are too dark to see properly.
     *
     * Many FBX models from asset stores use very dark diffuse colors
     * because they were designed for engines with IBL/environment maps.
     * In our PBR setup without env maps, these appear nearly black.
     *
     * For untextured materials: enforce a minimum brightness.
     */
    _fixDarkColor(material) {
        let changed = false;
        this._sanitizeMaterialTextureSlots(material);

        // Some FBX exports set transparent=true with very low opacity even for
        // opaque meshes. In a preview viewer this makes assets nearly invisible.
        if (material.transparent && !material.alphaMap && material.opacity < 0.2) {
            material.transparent = false;
            material.opacity = 1.0;
            changed = true;
        }

        // In a no-IBL preview environment, very metallic materials can look
        // almost black. Clamp extreme values when no metalness/roughness maps
        // are provided.
        if (
            material.metalness !== undefined &&
            material.roughness !== undefined &&
            !material.envMap
        ) {
            const hasMetalnessMap = this._isUsableTexture(material.metalnessMap);
            const hasRoughnessMap = this._isUsableTexture(material.roughnessMap);
            const hasColorMap = this._isUsableTexture(material.map);

            // In preview mode without IBL, aggressively metallic materials can
            // collapse to near-black. Keep a conservative metallic response.
            if (!hasMetalnessMap && material.metalness > 0.5) {
                material.metalness = hasColorMap ? 0.25 : 0.12;
                changed = true;
            }

            // Also avoid ultra-smooth surfaces that look black/mirror-like under
            // missing or partial texture setups.
            if (!hasRoughnessMap && material.roughness < 0.45) {
                material.roughness = hasColorMap ? 0.5 : 0.6;
                changed = true;
            }
        }

        if (material.color) {
            const lum = material.color.r * 0.299 + material.color.g * 0.587 + material.color.b * 0.114;
            const hasColorMap = this._isUsableTexture(material.map);

            if (hasColorMap) {
                // Textured materials should usually use a neutral (white)
                // diffuse multiplier. Near-black multipliers crush textures.
                if (lum < 0.25) {
                    material.color.set(0xffffff);
                    changed = true;
                }
            } else {
                if (lum < 0.15) {
                    // Boost to a visible neutral gray
                    material.color.set(0x808080);
                    changed = true;
                } else if (lum < 0.35) {
                    // Slightly dark — brighten proportionally
                    const boost = 0.4 / lum;
                    material.color.r = Math.min(1, material.color.r * boost);
                    material.color.g = Math.min(1, material.color.g * boost);
                    material.color.b = Math.min(1, material.color.b * boost);
                    changed = true;
                }
            }
        }

        if (changed) {
            material.needsUpdate = true;
        }
    }

    // ==========================================
    // Camera & Framing
    // ==========================================

    /**
     * Auto-frame the camera to fit the model in view.
     */
    _frameModel(object) {
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        // Store model center and light radius for light orientation controls
        this._modelCenter.copy(center);
        const maxDim = Math.max(size.x, size.y, size.z);
        this._keyLightRadius = maxDim * 3;

        // Update axis helper scale + position to match model
        const axisSize = maxDim * 0.5;
        this._buildAxisHelper(axisSize);
        this._axisGroup.position.copy(center);
        this._axisGroup.position.y = box.min.y;

        // Position ground at the bottom of the model
        const minY = box.min.y;
        this._ground.position.y = minY;

        // Rebuild grid scaled to model (SOTA: extends well beyond footprint)
        this._rebuildGrid(maxDim, minY);

        // Calculate optimal camera distance
        const fov = this._camera.fov * (Math.PI / 180);
        let distance = maxDim / (2 * Math.tan(fov / 2));
        distance *= 1.8; // Add some padding

        // Position camera
        const direction = new THREE.Vector3(1, 0.6, 1).normalize();
        this._camera.position.copy(
            center.clone().add(direction.multiplyScalar(distance))
        );

        // Update controls target
        this._controls.target.copy(center);
        this._controls.update();

        // Update shadow camera to match model size
        const shadowPad = maxDim * 2;
        this._keyLight.shadow.camera.left = -shadowPad;
        this._keyLight.shadow.camera.right = shadowPad;
        this._keyLight.shadow.camera.top = shadowPad;
        this._keyLight.shadow.camera.bottom = -shadowPad;
        this._keyLight.shadow.camera.far = distance * 4;
        this._keyLight.shadow.camera.updateProjectionMatrix();

        // Position the key light using azimuth/elevation
        this._updateKeyLightPosition();

        // Update fog density based on model size
        this._scene.fog.density = 0.5 / maxDim;

        // Update camera near/far
        this._camera.near = distance * 0.001;
        this._camera.far = distance * 10;
        this._camera.updateProjectionMatrix();

        // Store initial view for spacebar reset
        this._initialCameraPos.copy(this._camera.position);
        this._initialTarget.copy(this._controls.target);

        // Set keyboard movement speed proportional to model size
        // so navigation feels natural regardless of model scale
        this._moveSpeed = maxDim * 1.5;
    }

    // ==========================================
    // Light Controls (public API)
    // ==========================================

    /**
     * Update the key light position from current azimuth/elevation.
     * Uses spherical coordinates orbiting around the model center.
     */
    _updateKeyLightPosition() {
        const r = this._keyLightRadius;
        const az = this._keyLightAzimuth;
        const el = this._keyLightElevation;

        // Spherical to cartesian (Y-up)
        const x = this._modelCenter.x + r * Math.cos(el) * Math.cos(az);
        const y = this._modelCenter.y + r * Math.sin(el);
        const z = this._modelCenter.z + r * Math.cos(el) * Math.sin(az);

        this._keyLight.position.set(x, y, z);
        this._keyLight.target.position.copy(this._modelCenter);
        this._keyLight.target.updateMatrixWorld();
    }

    /**
     * Set the key light azimuth (horizontal angle in degrees, 0-360).
     * 0° = front-right, 90° = front-left, 180° = back-left, 270° = back-right.
     */
    setKeyLightAzimuth(degrees) {
        this._keyLightAzimuth = (degrees * Math.PI) / 180;
        this._updateKeyLightPosition();
    }

    /**
     * Set the key light elevation (vertical angle in degrees, 5-90).
     * 5° = nearly horizontal, 90° = directly overhead.
     */
    setKeyLightElevation(degrees) {
        this._keyLightElevation = (degrees * Math.PI) / 180;
        this._updateKeyLightPosition();
    }

    /** Set key light intensity (0-3). Default: 1.2. */
    setKeyLightIntensity(value) {
        this._keyLight.intensity = value;
    }

    /** Set fill light intensity (0-2). Default: 0.5. */
    setFillLightIntensity(value) {
        this._fillLight.intensity = value;
    }

    /** Set ambient light intensity (0-2). Default: 0.3. */
    setAmbientIntensity(value) {
        this._ambientLight.intensity = value;
        this._hemiLight.intensity = value * 2; // Hemisphere scales proportionally
    }

    /** Set tone mapping exposure (0.3-4). Default: 1.2. */
    setExposure(value) {
        this._renderer.toneMappingExposure = value;
    }

    /**
     * Set the model scale uniformly.
     * @param {number} scale - Scale factor (e.g., 0.25, 0.5, 1.0, 2.0)
     */
    setModelScale(scale) {
        if (this._currentModel) {
            this._currentModel.scale.setScalar(scale);
        }
    }

    /**
     * Toggle wireframe rendering on all meshes.
     * @param {boolean} enabled - Whether to show wireframe
     */
    setWireframe(enabled) {
        if (this._currentModel) {
            this._currentModel.traverse((child) => {
                if (child.isMesh && child.material) {
                    const mats = Array.isArray(child.material)
                        ? child.material
                        : [child.material];
                    mats.forEach((m) => { m.wireframe = enabled; });
                }
            });
        }
        this._wireframeEnabled = enabled;
    }

    /** Get wireframe state. */
    getWireframe() {
        return this._wireframeEnabled || false;
    }

    /**
     * Toggle vertex normals visualization.
     * Shows colored lines from each vertex in the direction of its normal.
     * Useful for debugging shading issues and verifying normal directions.
     *
     * @param {boolean} enabled
     */
    setNormalsVisible(enabled) {
        // Remove existing helpers
        this._clearNormalsHelpers();

        if (enabled && this._currentModel) {
            this._normalsHelpers = [];
            const box = new THREE.Box3().setFromObject(this._currentModel);
            const size = box.getSize(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            // Normal line length proportional to model size
            const normalLength = maxDim * 0.02;

            this._currentModel.traverse((child) => {
                if (child.isMesh && child.geometry) {
                    const helper = new VertexNormalsHelper(child, normalLength, 0x44ddff);
                    this._scene.add(helper);
                    this._normalsHelpers.push(helper);
                }
            });
        }

        this._normalsVisible = enabled;
    }

    /** Get normals display state. */
    getNormalsVisible() {
        return this._normalsVisible || false;
    }

    /** Remove all normals helper objects from the scene. */
    _clearNormalsHelpers() {
        if (this._normalsHelpers) {
            for (const h of this._normalsHelpers) {
                this._scene.remove(h);
                h.dispose();
            }
            this._normalsHelpers = [];
        }
    }

    /**
     * Set the viewer background color.
     * Also updates fog and grid colors to match for visual consistency.
     * Grid adapts: light grid lines on dark backgrounds, dark on light.
     * @param {string} hex - CSS hex color (e.g. "#1a1a1a")
     */
    setBackground(hex) {
        const color = new THREE.Color(hex);
        this._scene.background = color;
        this._scene.fog.color.copy(color);
        this._currentBgHex = hex;

        // Adapt grid colors based on background luminance
        this._updateGridColors();
    }

    /**
     * Update grid colors to contrast with the background.
     * Rebuilds the grid with the current model dimensions and new colors.
     */
    _updateGridColors() {
        if (!this._grid || !this._currentModel) return;

        // Rebuild grid with current model bounds + new background colors
        const box = new THREE.Box3().setFromObject(this._currentModel);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        this._rebuildGrid(maxDim, box.min.y);
    }

    /**
     * Toggle grid visibility.
     * @param {boolean} visible
     */
    setGridVisible(visible) {
        this._gridVisible = visible;
        if (this._grid) this._grid.visible = visible;
    }

    /** Get grid visibility. */
    getGridVisible() {
        return this._gridVisible;
    }

    /**
     * Toggle axis helper visibility.
     * @param {boolean} visible
     */
    setAxisVisible(visible) {
        this._axisVisible = visible;
        this._axisGroup.visible = visible;
    }

    // ==========================================
    // Model Transform (recenter, orient, reset, export)
    // ==========================================

    /** Whether the model has been modified (recentered, oriented, scaled). */
    get isModelModified() {
        return this._modelModified || false;
    }

    /**
     * Save a snapshot of all geometry positions + mesh transforms
     * so we can restore them on Reset.
     */
    _saveOriginalGeometry() {
        this._originalState = [];
        if (!this._currentModel) return;

        this._currentModel.updateMatrixWorld(true);

        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const posAttr = child.geometry.attributes.position;
                this._originalState.push({
                    mesh: child,
                    positions: new Float32Array(posAttr.array),
                    // Save mesh local transform
                    position: child.position.clone(),
                    rotation: child.rotation.clone(),
                    scale: child.scale.clone(),
                });
            }
        });

        // Save root transform
        this._originalRootPos = this._currentModel.position.clone();
        this._originalRootRot = this._currentModel.rotation.clone();
        this._originalRootScale = this._currentModel.scale.clone();
    }

    /**
     * Reset model to its original state (undo all recenter/orient/scale).
     * Does NOT touch the camera.
     */
    resetModel() {
        if (!this._currentModel || !this._originalState) return;

        // Restore each mesh's geometry and transform
        for (const saved of this._originalState) {
            const posAttr = saved.mesh.geometry.attributes.position;
            posAttr.array.set(saved.positions);
            posAttr.needsUpdate = true;

            saved.mesh.position.copy(saved.position);
            saved.mesh.rotation.copy(saved.rotation);
            saved.mesh.scale.copy(saved.scale);
            saved.mesh.updateMatrix();

            saved.mesh.geometry.computeVertexNormals();
            saved.mesh.geometry.computeBoundingBox();
            saved.mesh.geometry.computeBoundingSphere();
        }

        // Restore root transform
        this._currentModel.position.copy(this._originalRootPos);
        this._currentModel.rotation.copy(this._originalRootRot);
        this._currentModel.scale.copy(this._originalRootScale);

        this._modelModified = false;
    }

    /**
     * Bake all world transforms into geometry vertex positions.
     * After this, all mesh and root transforms are identity,
     * and vertices contain actual world-space coordinates.
     */
    _bakeWorldTransforms() {
        this._currentModel.updateMatrixWorld(true);

        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                child.geometry.applyMatrix4(child.matrixWorld);
                child.position.set(0, 0, 0);
                child.rotation.set(0, 0, 0);
                child.scale.set(1, 1, 1);
                child.updateMatrix();
            }
        });

        // Reset all intermediate groups and root
        this._currentModel.traverse((node) => {
            if (!node.isMesh) {
                node.position.set(0, 0, 0);
                node.rotation.set(0, 0, 0);
                node.scale.set(1, 1, 1);
                node.updateMatrix();
            }
        });
    }

    /**
     * Center the model so its bounding box center is at (0, 0, 0).
     * Does NOT touch the camera.
     */
    recenterModel() {
        if (!this._currentModel) return;

        // Bake transforms so we work with clean geometry
        this._bakeWorldTransforms();

        // Compute center
        const box = new THREE.Box3().setFromObject(this._currentModel);
        const center = box.getCenter(new THREE.Vector3());

        // Shift all vertices so center is at origin
        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                child.geometry.translate(-center.x, -center.y, -center.z);
                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }
        });

        this._modelModified = true;
    }

    /**
     * Auto-orient the model using PCA (Principal Component Analysis).
     *
     * Aligns the model so its "up" direction (smallest variance axis)
     * coincides with the Y axis. Does NOT touch the camera.
     */
    /**
     * Ground the model: center on X/Z and place it on the ground plane.
     * The lowest geometry point is at Y=0 (model sits on a surface).
     * Does NOT touch the camera.
     */
    groundModel() {
        if (!this._currentModel) return;

        this._bakeWorldTransforms();

        const box = new THREE.Box3().setFromObject(this._currentModel);
        const center = box.getCenter(new THREE.Vector3());

        // Center X and Z, shift Y so min.y = 0
        const offsetX = -center.x;
        const offsetZ = -center.z;
        const offsetY = -box.min.y; // Lift so lowest point touches Y=0

        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                child.geometry.translate(offsetX, offsetY, offsetZ);
                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }
        });

        this._modelModified = true;
    }

    /**
     * Rotate the model by a given angle around an axis.
     * Bakes the rotation directly into the geometry vertices.
     * Does NOT touch the camera.
     *
     * @param {'x'|'y'|'z'} axis - The rotation axis
     * @param {number} angleDeg - Rotation angle in degrees (e.g., 90, -90)
     */
    /**
     * Recompute smooth vertex normals for all meshes.
     *
     * Steps:
     * 1. Delete existing normals (they prevent vertex merging at hard edges)
     * 2. Merge vertices at the same position (creates indexed geometry)
     * 3. Compute vertex normals by averaging face normals at shared vertices
     *
     * This turns faceted/flat shading into fully smooth shading.
     */
    recomputeNormals() {
        if (!this._currentModel) return;

        // If normals are displayed, turn them off first (will re-add after)
        const hadNormals = this._normalsVisible;
        if (hadNormals) this.setNormalsVisible(false);

        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const geo = child.geometry;

                // 1. Remove existing normals so mergeVertices only compares positions
                geo.deleteAttribute("normal");

                // 2. Also remove UVs temporarily for merge (preserving them prevents
                //    merging at UV seams which keeps faces split)
                const hadUV = geo.hasAttribute("uv");
                const uvBackup = hadUV ? geo.getAttribute("uv").clone() : null;
                if (hadUV) geo.deleteAttribute("uv");

                // 3. Merge vertices at same position (tolerance handles float noise)
                child.geometry = BufferGeometryUtils.mergeVertices(geo, 0.0001);

                // 4. Compute smooth normals on the merged geometry
                child.geometry.computeVertexNormals();

                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }
        });

        this._modelModified = true;

        // Re-enable normals display if it was on
        if (hadNormals) this.setNormalsVisible(true);
    }

    rotateModel(axis, angleDeg) {
        if (!this._currentModel) return;

        this._bakeWorldTransforms();

        const angleRad = (angleDeg * Math.PI) / 180;
        const rotMatrix = new THREE.Matrix4();

        if (axis === "x") rotMatrix.makeRotationX(angleRad);
        else if (axis === "y") rotMatrix.makeRotationY(angleRad);
        else if (axis === "z") rotMatrix.makeRotationZ(angleRad);

        // Compute centroid to rotate around model center
        const box = new THREE.Box3().setFromObject(this._currentModel);
        const center = box.getCenter(new THREE.Vector3());

        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const posAttr = child.geometry.attributes.position;
                if (!posAttr) return;

                for (let i = 0; i < posAttr.count; i++) {
                    const v = new THREE.Vector3().fromBufferAttribute(posAttr, i);
                    v.sub(center);
                    v.applyMatrix4(rotMatrix);
                    v.add(center);
                    posAttr.setXYZ(i, v.x, v.y, v.z);
                }
                posAttr.needsUpdate = true;
                child.geometry.computeVertexNormals();
                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }
        });

        this._modelModified = true;
    }

    autoOrientModel() {
        if (!this._currentModel) return;

        // Bake transforms first
        this._bakeWorldTransforms();

        // 1. Collect all vertex positions
        const positions = [];
        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const posAttr = child.geometry.attributes.position;
                if (!posAttr) return;
                for (let i = 0; i < posAttr.count; i++) {
                    positions.push(new THREE.Vector3().fromBufferAttribute(posAttr, i));
                }
            }
        });

        if (positions.length < 3) return;

        // 2. Compute centroid
        const centroid = new THREE.Vector3();
        for (const p of positions) centroid.add(p);
        centroid.divideScalar(positions.length);

        // 3. Compute covariance matrix
        let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
        for (const p of positions) {
            const dx = p.x - centroid.x;
            const dy = p.y - centroid.y;
            const dz = p.z - centroid.z;
            cxx += dx * dx; cxy += dx * dy; cxz += dx * dz;
            cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
        }
        const n = positions.length;
        cxx /= n; cxy /= n; cxz /= n; cyy /= n; cyz /= n; czz /= n;

        // 4. Find eigenvectors
        const eigenvectors = this._computeEigenvectors3x3(
            cxx, cxy, cxz, cyy, cyz, czz
        );

        // 5. Sort: largest → X, medium → Z, smallest → Y (up)
        eigenvectors.sort((a, b) => b.value - a.value);

        const ex = eigenvectors[0].vector.normalize();
        const ey = eigenvectors[2].vector.normalize(); // smallest → up
        const ez = eigenvectors[1].vector.normalize();

        // Ensure right-handed + Y points up
        const cross = new THREE.Vector3().crossVectors(ex, ey);
        if (cross.dot(ez) < 0) ez.negate();
        if (ey.y < 0) { ey.negate(); ez.negate(); }

        // Rotation matrix
        const rotMatrix = new THREE.Matrix4().makeBasis(ex, ey, ez);
        const invRot = rotMatrix.clone().invert();

        // 6. Apply rotation to all vertices (centered at centroid)
        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const posAttr = child.geometry.attributes.position;
                if (!posAttr) return;

                for (let i = 0; i < posAttr.count; i++) {
                    const v = new THREE.Vector3().fromBufferAttribute(posAttr, i);
                    v.sub(centroid);
                    v.applyMatrix4(invRot);
                    v.add(centroid); // Keep position, only rotate
                    posAttr.setXYZ(i, v.x, v.y, v.z);
                }
                posAttr.needsUpdate = true;
                child.geometry.computeVertexNormals();
                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }
        });

        this._modelModified = true;
    }

    /**
     * Compute eigenvectors of a 3x3 symmetric matrix via power iteration + deflation.
     */
    _computeEigenvectors3x3(a00, a01, a02, a11, a12, a22) {
        const mat = [
            [a00, a01, a02],
            [a01, a11, a12],
            [a02, a12, a22],
        ];

        const results = [];

        for (let round = 0; round < 3; round++) {
            let v = [Math.random(), Math.random(), Math.random()];
            let eigenvalue = 0;

            for (let iter = 0; iter < 100; iter++) {
                const w = [
                    mat[0][0] * v[0] + mat[0][1] * v[1] + mat[0][2] * v[2],
                    mat[1][0] * v[0] + mat[1][1] * v[1] + mat[1][2] * v[2],
                    mat[2][0] * v[0] + mat[2][1] * v[1] + mat[2][2] * v[2],
                ];
                const len = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
                if (len < 1e-10) break;
                v = [w[0] / len, w[1] / len, w[2] / len];
                eigenvalue = len;
            }

            results.push({
                value: eigenvalue,
                vector: new THREE.Vector3(v[0], v[1], v[2]),
            });

            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    mat[i][j] -= eigenvalue * v[i] * v[j];
                }
            }
        }

        return results;
    }

    /**
     * Export the current model as OBJ text.
     * Bakes all transforms into the output.
     */
    /**
     * Extract all materials from the current model with mesh references.
     *
     * Returns an array of material descriptors:
     * {
     *   id: number,              // Unique index
     *   name: string,            // Material name or auto-generated
     *   material: THREE.Material, // Direct reference (for future editing)
     *   meshes: THREE.Mesh[],    // Meshes using this material
     *   color: string,           // Hex color (#rrggbb)
     *   roughness: number,
     *   metalness: number,
     *   opacity: number,
     *   transparent: boolean,
     *   wireframe: boolean,
     *   type: string,            // e.g. "MeshStandardMaterial"
     *   hasMap: boolean,         // Has diffuse texture
     *   hasNormalMap: boolean,
     * }
     *
     * The material references are live — editing them affects the scene
     * immediately (foundation for future material editor).
     */
    getMaterialsInfo() {
        if (!this._currentModel) return [];

        // Use a Map to deduplicate materials (same material instance on multiple meshes)
        const matMap = new Map();
        let autoId = 0;

        this._currentModel.traverse((child) => {
            if (!child.isMesh || !child.material) return;

            const mats = Array.isArray(child.material)
                ? child.material
                : [child.material];

            for (const mat of mats) {
                if (!matMap.has(mat)) {
                    matMap.set(mat, {
                        id: autoId++,
                        name: mat.name || `Material_${autoId}`,
                        material: mat, // Live reference for future editing
                        meshes: [],
                        color: mat.color ? "#" + mat.color.getHexString() : "#808080",
                        roughness: mat.roughness !== undefined ? mat.roughness : 0.5,
                        metalness: mat.metalness !== undefined ? mat.metalness : 0.0,
                        opacity: mat.opacity !== undefined ? mat.opacity : 1.0,
                        transparent: !!mat.transparent,
                        wireframe: !!mat.wireframe,
                        type: mat.type || "Unknown",
                        hasMap: !!mat.map,
                        hasNormalMap: !!mat.normalMap,
                    });
                }
                matMap.get(mat).meshes.push(child);
            }
        });

        return Array.from(matMap.values());
    }

    /**
     * Get the total unique vertex count of the current model.
     * Uses the stats computed by _computeStats (which deduplicates).
     */
    getTotalVertexCount() {
        if (!this._currentModel) return 0;
        const stats = this._computeStats(this._currentModel);
        return stats.vertices;
    }

    /**
     * Simplify model geometry — async, cancellable, processes one mesh at a time.
     *
     * @param {number} targetRatio - 0.0–1.0 ratio of vertices to keep
     * @param {AbortSignal} signal - AbortController signal to cancel
     * @returns {Promise<{before: number, after: number}>}
     */
    async simplifyModel(targetRatio, signal) {
        if (!this._currentModel) return { before: 0, after: 0 };

        const modifier = new SimplifyModifier();
        let totalBefore = 0;
        let totalAfter = 0;

        const hadNormals = this._normalsVisible;
        if (hadNormals) this.setNormalsVisible(false);

        // Bake world transforms first
        this._bakeWorldTransforms();

        // Collect meshes to process
        const meshes = [];
        this._currentModel.traverse((child) => {
            if (child.isMesh && child.geometry) meshes.push(child);
        });

        // Process one mesh at a time with yield to UI between each
        for (let i = 0; i < meshes.length; i++) {
            // Check for cancellation
            if (signal && signal.aborted) {
                return { before: totalBefore, after: totalAfter, cancelled: true };
            }

            const child = meshes[i];
            let geo = child.geometry;

            // Merge vertices
            geo.deleteAttribute("normal");
            if (geo.hasAttribute("uv")) geo.deleteAttribute("uv");
            geo = BufferGeometryUtils.mergeVertices(geo, 0.0001);

            const vertCount = geo.attributes.position.count;
            totalBefore += vertCount;

            const targetCount = Math.max(4, Math.floor(vertCount * targetRatio));
            const removeCount = vertCount - targetCount;

            if (removeCount <= 0) {
                child.geometry.dispose();
                child.geometry = geo;
                child.geometry.computeVertexNormals();
                totalAfter += vertCount;
            } else {
                try {
                    const simplified = modifier.modify(geo, removeCount);
                    child.geometry.dispose();
                    child.geometry = simplified;
                    totalAfter += simplified.attributes.position.count;
                } catch (err) {
                    console.warn(`Simplification failed for mesh ${child.name}:`, err);
                    child.geometry.dispose();
                    child.geometry = geo;
                    totalAfter += vertCount;
                }

                child.geometry.computeVertexNormals();
                child.geometry.computeBoundingBox();
                child.geometry.computeBoundingSphere();
            }

            // Yield to UI after each mesh (allows cancel button to be clicked)
            await new Promise((r) => setTimeout(r, 10));
        }

        this._modelModified = true;
        if (hadNormals) this.setNormalsVisible(true);

        const stats = this._computeStats(this._currentModel);
        this._onInfoUpdate(stats);

        return { before: totalBefore, after: totalAfter };
    }

    /**
     * Apply textures from a scanned texture folder.
     *
     * Takes a map of lowercase filename → server path (from /api/scan_textures),
     * scans all materials for missing texture maps, and attempts to load
     * matching textures by filename (case-insensitive).
     *
     * @param {Object} textureMap - { "filename.png": "/abs/path/filename.png", ... }
     * @returns {number} Number of textures applied
     */
    async applyTextureFolder(textureMap) {
        if (!this._currentModel) return 0;

        let applied = 0;
        const textureCache = new Map();

        const loadTexture = async (path, prop) => {
            const colorSpace = (prop === "map" || prop === "emissiveMap")
                ? THREE.SRGBColorSpace
                : THREE.LinearSRGBColorSpace;
            return this._loadTextureFromAbsPath(path, colorSpace, textureCache);
        };

        // Scan all materials for missing maps
        const mapProps = ["map", "normalMap", "roughnessMap", "metalnessMap",
                          "aoMap", "emissiveMap", "bumpMap", "displacementMap",
                          "alphaMap", "envMap", "lightMap"];

        for (const matInfo of this.getMaterialsInfo()) {
            const mat = matInfo.material;
            let matChanged = false;

            // Check each texture slot
            for (const prop of mapProps) {
                // Skip if already has a texture loaded
                if (mat[prop]) continue;

                // Check if there's a reference we can try to resolve
                // For materials without explicit references, try common naming
                // conventions: {materialName}_diffuse, {materialName}_normal, etc.
                const conventions = this._getTextureConventions(matInfo.name, prop);

                for (const name of conventions) {
                    const match = textureMap[name.toLowerCase()];
                    if (match) {
                        const tex = await loadTexture(match, prop);
                        if (tex) {
                            mat[prop] = tex;
                            matChanged = true;
                            applied++;
                            break;
                        }
                    }
                }
            }

            // Also try to assign a diffuse map if nothing was found via conventions
            // by matching any texture with a similar name to the material
            if (!mat.map && !matChanged) {
                const matName = matInfo.name.toLowerCase().replace(/[_\s-]/g, "");
                for (const [filename, filepath] of Object.entries(textureMap)) {
                    const cleanFile = filename.replace(/[_\s-]/g, "").replace(/\.\w+$/, "");
                    if (cleanFile.includes(matName) || matName.includes(cleanFile)) {
                        const tex = await loadTexture(filepath, "map");
                        if (tex) {
                            mat.map = tex;
                            matChanged = true;
                            applied++;
                            break;
                        }
                    }
                }
            }

            if (matChanged) {
                mat.needsUpdate = true;
            }
        }

        return applied;
    }

    /**
     * Generate texture filename conventions for a material + channel.
     * Tries common naming patterns used by 3D tools.
     */
    _getTextureConventions(materialName, channel) {
        const name = materialName.replace(/\s+/g, "_");
        const channelNames = {
            map: ["diffuse", "basecolor", "base_color", "color", "albedo", "diff", "col"],
            normalMap: ["normal", "norm", "nrm", "bump"],
            roughnessMap: ["roughness", "rough", "rgh"],
            metalnessMap: ["metalness", "metallic", "metal", "met"],
            aoMap: ["ao", "ambient_occlusion", "occlusion", "occ"],
            emissiveMap: ["emissive", "emission", "emit", "glow"],
            bumpMap: ["bump", "height", "disp"],
            displacementMap: ["displacement", "disp", "height"],
            alphaMap: ["alpha", "opacity", "mask", "transparency"],
        };

        const suffixes = channelNames[channel] || [];
        const results = [];
        const exts = [".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tiff"];

        for (const suffix of suffixes) {
            for (const ext of exts) {
                results.push(`${name}_${suffix}${ext}`);
                results.push(`${suffix}${ext}`);
            }
        }

        return results;
    }

    /**
     * Capture the current 3D view as a PNG and trigger download.
     */
    screenshot() {
        // Render one frame with preserveDrawingBuffer
        this._renderer.render(this._scene, this._camera);
        const dataUrl = this._renderer.domElement.toDataURL("image/png");
        const link = document.createElement("a");
        link.download = "meshvault_screenshot.png";
        link.href = dataUrl;
        link.click();
    }

    exportAsOBJ() {
        if (!this._currentModel) return null;
        this._currentModel.updateMatrixWorld(true);
        const exporter = new OBJExporter();
        return exporter.parse(this._currentModel);
    }

    /** Get axis helper visibility. */
    getAxisVisible() {
        return this._axisVisible;
    }

    /** Get current light settings for UI synchronization. */
    getLightSettings() {
        return {
            keyAzimuth: Math.round((this._keyLightAzimuth * 180) / Math.PI),
            keyElevation: Math.round((this._keyLightElevation * 180) / Math.PI),
            keyIntensity: this._keyLight.intensity,
            fillIntensity: this._fillLight.intensity,
            ambientIntensity: this._ambientLight.intensity,
            exposure: this._renderer.toneMappingExposure,
        };
    }

    // ==========================================
    // Render Loop
    // ==========================================

    _startRenderLoop() {
        const animate = () => {
            this._animationId = requestAnimationFrame(animate);

            const delta = this._clock.getDelta();

            // Apply FPV drone movement (only active in FPV mode)
            this._applyFPVMovement(delta);

            // Update orbit controls (damping, etc. — only when enabled)
            if (this._controls.enabled) {
                this._controls.update();
            }

            // Update animation mixers (FBX)
            for (const mixer of this._mixers) {
                mixer.update(delta);
            }

            // Render with postprocessing
            this._composer.render();
        };
        animate();
    }

    _onResize() {
        const width = this._container.clientWidth;
        const height = this._container.clientHeight;

        if (width === 0 || height === 0) return;

        this._camera.aspect = width / height;
        this._camera.updateProjectionMatrix();

        this._renderer.setSize(width, height);
        this._composer.setSize(width, height);

        // Update SSAO pass resolution
        if (this._ssaoPass) {
            this._ssaoPass.setSize(width, height);
        }
    }

    // ==========================================
    // Utilities
    // ==========================================

    _getAspect() {
        return (
            this._container.clientWidth / this._container.clientHeight || 1
        );
    }

    /**
     * Compute model statistics (vertices, faces).
     */
    _computeStats(object) {
        let bufferVerts = 0;
        let faces = 0;
        const uniqueSet = new Set();

        object.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const geo = child.geometry;
                const posAttr = geo.attributes.position;
                if (posAttr) {
                    bufferVerts += posAttr.count;

                    // Count unique vertex positions (rounded to avoid float noise)
                    for (let i = 0; i < posAttr.count; i++) {
                        const key = `${posAttr.getX(i).toFixed(5)},${posAttr.getY(i).toFixed(5)},${posAttr.getZ(i).toFixed(5)}`;
                        uniqueSet.add(key);
                    }
                }
                if (geo.index) {
                    faces += geo.index.count / 3;
                } else if (posAttr) {
                    faces += posAttr.count / 3;
                }
            }
        });

        const uniqueVerts = uniqueSet.size;

        // Compute bounding box dimensions
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());

        return {
            vertices: Math.round(uniqueVerts),
            faces: Math.round(faces),
            bufferVertices: Math.round(bufferVerts),
            width: size.x,
            height: size.y,
            depth: size.z,
        };
    }
}
