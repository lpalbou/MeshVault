/**
 * Scene timeline — keyframe animation authoring for agents (backlog 046).
 *
 * Architecture (from adversarial design review):
 * - HAND-ROLLED interpolator, not THREE.AnimationMixer: per-keyframe easing is
 *   unrepresentable in KeyframeTrack (one mode per track), and Mixer.setTime
 *   multiplies by timeScale — seek(5) at speed 2 lands at t=10, corrupting the
 *   agent's seek → screenshot contract. sampleTimeline(t) is exact by construction.
 * - Keyframes store the object's LOGICAL local TRS (pivot-factored,
 *   parent-relative): interpolating logical values and composing the pivot per
 *   frame makes a keyed wing sweep a true arc about its root; interpolating
 *   composed wrapper values would cut chords through it.
 * - Playback writes wrapper TRS via _composeWrapper directly — NEVER through
 *   setObjectTransform (its per-call scene-rig rebuild is a GC storm at 60 Hz).
 *   The rig is sized ONCE at play from the swept keyframe box.
 * - basePlacement: the first track on an object snapshots its pose; stop/clear
 *   restore it — otherwise transient animation poses leak into manifests.
 */

import * as THREE from "three";

export const TIMELINE_MAX_TRACKS = 64;      // objects with tracks
export const TIMELINE_MAX_KEYS = 256;       // keys per channel

const EASINGS = {
    linear: (u) => u,
    step: () => 0,                     // hold the segment's start value
    ease_in: (u) => u * u,
    ease_out: (u) => u * (2 - u),
    ease_in_out: (u) => (u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2),
};

export function createTimeline() {
    return {
        duration: 0,          // seconds; 0 = derived from max key time
        time: 0,
        playing: false,
        loop: true,
        // objectId -> { position:[{t,v:[3],easing}], rotation:[{t,v:quat[4],easing}],
        //               scale:[{t,v:[3],easing}] } — keys sorted by t.
        tracks: new Map(),
    };
}

function effectiveDuration(tl) {
    if (tl.duration > 0) return tl.duration;
    let max = 0;
    for (const channels of tl.tracks.values()) {
        for (const keys of Object.values(channels)) {
            if (keys.length) max = Math.max(max, keys[keys.length - 1].t);
        }
    }
    return max;
}

/** Ensure the timeline exists on the viewer (lazy). */
function tl(viewer) {
    if (!viewer._timeline) viewer._timeline = createTimeline();
    return viewer._timeline;
}

function requireEntry(viewer, id) {
    const entry = viewer._entryById(id);
    if (!entry) throw new Error(`No object with id ${id}. Use list_objects.`);
    return entry;
}

/** Angle (degrees) between two quaternions — the slerp arc length. */
function quatAngleDeg(a, b) {
    const qa = new THREE.Quaternion(...a);
    const qb = new THREE.Quaternion(...b);
    return THREE.MathUtils.radToDeg(qa.angleTo(qb));
}

/**
 * set_keyframe — key the given channels (or capture the current pose) at `time`.
 * Values are LOGICAL local TRS. Returns quantified feedback + rotation teaching.
 */
export function setKeyframe(viewer, opts) {
    const timeline = tl(viewer);
    const entry = requireEntry(viewer, opts.id);
    if (timeline.playing) pauseTimeline(viewer);   // never capture a moving pose

    const time = opts.time;
    if (!(time >= 0)) throw new Error("set_keyframe requires time >= 0 (seconds)");

    const hasExplicit = opts.position || opts.rotation || opts.quaternion
        || opts.scale !== undefined;
    if (!hasExplicit && !opts.capture) {
        throw new Error(
            "set_keyframe: pass position/rotation/scale values, or capture:true "
            + "to key the object's CURRENT pose (pose with set_object_transform "
            + "or look_at first, then capture).");
    }

    if (!timeline.tracks.has(opts.id)) {
        if (timeline.tracks.size >= TIMELINE_MAX_TRACKS) {
            throw new Error(`Timeline cap: max ${TIMELINE_MAX_TRACKS} animated objects.`);
        }
        timeline.tracks.set(opts.id, { position: [], rotation: [], scale: [] });
        // First track on this object: snapshot the pose so stop/clear can
        // restore it (transient animation poses must never leak into manifests).
        entry.basePlacement = {
            p: entry.logical.p.clone(),
            q: entry.logical.q.clone(),
            s: entry.logical.s.clone(),
        };
    }
    const channels = timeline.tracks.get(opts.id);
    const easing = opts.easing || "linear";
    if (!EASINGS[easing]) {
        throw new Error(`Unknown easing '${easing}'. Use ${Object.keys(EASINGS).join("|")}.`);
    }

    const upsert = (keys, value) => {
        if (keys.length >= TIMELINE_MAX_KEYS) {
            throw new Error(`Timeline cap: max ${TIMELINE_MAX_KEYS} keys per channel.`);
        }
        const existing = keys.findIndex((k) => Math.abs(k.t - time) < 1e-6);
        const key = { t: time, v: value, easing };
        if (existing >= 0) keys[existing] = key;
        else {
            keys.push(key);
            keys.sort((a, b) => a.t - b.t);
        }
    };

    const written = [];
    const L = entry.logical;
    const d2r = Math.PI / 180;

    // capture:true keys all three channels unless `channels` narrows it —
    // capturing rotation-only joints avoids constant position/scale tracks
    // bloating timelines and exports (T1 artist finding).
    let captureSet = null;
    if (opts.capture && !hasExplicit) {
        captureSet = new Set(opts.channels || ["position", "rotation", "scale"]);
        for (const ch of captureSet) {
            if (!["position", "rotation", "scale"].includes(ch)) {
                throw new Error(`Unknown channel '${ch}'. Use position|rotation|scale.`);
            }
        }
    }

    if (opts.position || (captureSet && captureSet.has("position"))) {
        const v = opts.position || [L.p.x, L.p.y, L.p.z];
        upsert(channels.position, [v[0], v[1], v[2]]);
        written.push("position");
    }
    let quatValue = null;
    if (opts.quaternion) {
        quatValue = new THREE.Quaternion(...opts.quaternion).normalize();
    } else if (opts.rotation) {
        quatValue = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            opts.rotation[0] * d2r, opts.rotation[1] * d2r, opts.rotation[2] * d2r, "XYZ"));
    } else if (captureSet && captureSet.has("rotation")) {
        quatValue = L.q.clone();
    }
    let note;
    if (quatValue) {
        const arr = [quatValue.x, quatValue.y, quatValue.z, quatValue.w];
        // Store the REQUESTED Euler degrees alongside (when given): quaternions
        // cannot distinguish 0° from 360° — the requested-angle record is what
        // makes full-turn mistakes detectable at all.
        const eulerReq = opts.rotation ? [...opts.rotation] : null;
        const keys = channels.rotation;
        const idx = keys.findIndex((k) => k.t > time);
        const neighbors = [];
        if (keys.length) {
            const before = idx === -1 ? keys[keys.length - 1] : keys[idx - 1];
            const after = idx === -1 ? null : keys[idx];
            if (before && Math.abs(before.t - time) > 1e-6) neighbors.push(before);
            if (after) neighbors.push(after);
        }
        for (const n of neighbors) {
            const quatDeg = quatAngleDeg(n.v, arr);
            // THE silent killer (T2 finding): an exact 360° step quaternion-
            // round-trips to IDENTITY — the segment plays as no motion at all,
            // and the old >120° quaternion check mathematically cannot see it.
            // Detect from the REQUESTED Euler deltas.
            if (eulerReq && n.e) {
                const axisDelta = Math.max(
                    Math.abs(eulerReq[0] - n.e[0]),
                    Math.abs(eulerReq[1] - n.e[1]),
                    Math.abs(eulerReq[2] - n.e[2]));
                if (axisDelta >= 90 && quatDeg < 5) {
                    note = `WARNING: the keys at t=${n.t} and t=${time} differ by `
                        + `${Math.round(axisDelta)}° in requested angles but are `
                        + "IDENTICAL in rotation space (360° = 0°) — this segment "
                        + "will NOT move. Key full turns in steps ≤120°: e.g. a "
                        + "720° spin as 0/90/180/.../720.";
                    continue;
                }
                if (axisDelta > 120) {
                    note = `rotation step to the key at t=${n.t} is ${Math.round(axisDelta)}° `
                        + "as requested — interpolation takes the SHORT arc and cannot "
                        + "exceed 180°/segment. Use steps ≤120° (e.g. 0/90/180/270/360 "
                        + "for a full spin).";
                    continue;
                }
            }
            if (quatDeg > 120) {
                note = `rotation delta to the key at t=${n.t} is ${Math.round(quatDeg)}° — `
                    + "interpolation takes the SHORT arc (a 270° turn plays as −90°). "
                    + "Use steps ≤120° (e.g. 0/90/180/270/360 for a full spin).";
            }
        }
        const key = { t: time, v: arr, easing };
        if (eulerReq) key.e = eulerReq;
        // upsert with the extra euler record
        if (keys.length >= TIMELINE_MAX_KEYS) {
            throw new Error(`Timeline cap: max ${TIMELINE_MAX_KEYS} keys per channel.`);
        }
        const existing = keys.findIndex((k) => Math.abs(k.t - time) < 1e-6);
        if (existing >= 0) keys[existing] = key;
        else {
            keys.push(key);
            keys.sort((a, b) => a.t - b.t);
        }
        written.push("rotation");
    }
    if (opts.scale !== undefined || (captureSet && captureSet.has("scale"))) {
        let v;
        if (typeof opts.scale === "number") v = [opts.scale, opts.scale, opts.scale];
        else if (Array.isArray(opts.scale)) v = [opts.scale[0], opts.scale[1], opts.scale[2]];
        else v = [L.s.x, L.s.y, L.s.z];
        upsert(channels.scale, v);
        written.push("scale");
    }

    const keyCount = channels.position.length + channels.rotation.length
        + channels.scale.length;
    const result = { objectId: opts.id, time, channels: written, keyCount,
                     duration: Math.round(effectiveDuration(timeline) * 1000) / 1000 };
    if (note) result.note = note;
    return result;
}

export function deleteKeyframe(viewer, { id, time, channel } = {}) {
    const timeline = tl(viewer);
    requireEntry(viewer, id);
    const channels = timeline.tracks.get(id);
    if (!channels) throw new Error(`Object ${id} has no timeline tracks.`);
    const names = channel ? [channel] : ["position", "rotation", "scale"];
    let removed = 0;
    for (const name of names) {
        if (!channels[name]) throw new Error(`Unknown channel '${name}'. Use position|rotation|scale.`);
        if (time === undefined) {
            removed += channels[name].length;
            channels[name] = [];
        } else {
            const before = channels[name].length;
            channels[name] = channels[name].filter((k) => Math.abs(k.t - time) > 1e-6);
            removed += before - channels[name].length;
        }
    }
    if (!channels.position.length && !channels.rotation.length && !channels.scale.length) {
        timeline.tracks.delete(id);
    }
    return { objectId: id, removed };
}

/** Compact, agent-readable timeline dump (rotations as derived Euler degrees). */
export function getTimeline(viewer) {
    const timeline = tl(viewer);
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const tracks = [];
    for (const [objectId, channels] of timeline.tracks) {
        const entry = viewer._entryById(objectId);
        const track = { objectId, name: entry ? entry.name : "(removed)" };
        for (const [name, keys] of Object.entries(channels)) {
            if (!keys.length) continue;
            track[name] = keys.map((k) => {
                const out = { t: r3(k.t) };
                if (name === "rotation") {
                    // Prefer the REQUESTED angles (k.e) — derived Euler cannot
                    // distinguish 360° from 0° and would hide full-turn keys.
                    if (k.e) {
                        out.v = k.e.map(r3);
                    } else {
                        const e = new THREE.Euler().setFromQuaternion(
                            new THREE.Quaternion(...k.v), "XYZ");
                        const r2d = 180 / Math.PI;
                        out.v = [r3(e.x * r2d), r3(e.y * r2d), r3(e.z * r2d)];
                        out.derived = true;
                    }
                } else {
                    out.v = k.v.map(r3);
                }
                if (k.easing !== "linear") out.easing = k.easing;
                return out;
            });
        }
        tracks.push(track);
    }
    return {
        duration: r3(effectiveDuration(timeline)),
        time: r3(timeline.time),
        playing: timeline.playing,
        loop: timeline.loop,
        tracks,
        // Rotations converted from stored quaternions for readability.
        rotationDerived: true,
    };
}

/** Remove tracks (one object or all); restore basePlacement(s). */
export function clearTimeline(viewer, { id } = {}) {
    const timeline = tl(viewer);
    timeline.playing = false;
    const ids = id !== undefined ? [id] : [...timeline.tracks.keys()];
    let cleared = 0;
    for (const objectId of ids) {
        if (!timeline.tracks.has(objectId)) continue;
        timeline.tracks.delete(objectId);
        cleared++;
        const entry = viewer._entryById(objectId);
        if (entry && entry.basePlacement) {
            entry.logical.p.copy(entry.basePlacement.p);
            entry.logical.q.copy(entry.basePlacement.q);
            entry.logical.s.copy(entry.basePlacement.s);
            viewer._composeWrapper(entry);
            entry.basePlacement = null;
        }
    }
    if (timeline.tracks.size === 0) timeline.time = 0;
    viewer._updateSceneRig(viewer._visibleUnionBox());
    viewer.invalidate();
    return { clearedTracks: cleared, remaining: timeline.tracks.size };
}

function sampleChannel(keys, t, interpolate) {
    if (!keys.length) return null;
    if (t <= keys[0].t) return keys[0].v;                     // hold first
    if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;  // hold last
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
    const a = keys[i], b = keys[i + 1];
    const span = b.t - a.t;
    let u = span > 1e-9 ? (t - a.t) / span : 1;
    // Easing lives on the SEGMENT'S START key ("easing out of key i").
    u = (EASINGS[a.easing] || EASINGS.linear)(u);
    return interpolate(a.v, b.v, u);
}

const lerp3 = (a, b, u) => [
    a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const slerp4 = (a, b, u) => {
    _qa.set(a[0], a[1], a[2], a[3]);
    _qb.set(b[0], b[1], b[2], b[3]);
    _qa.slerp(_qb, u).normalize();
    return [_qa.x, _qa.y, _qa.z, _qa.w];
};

/**
 * Evaluate the timeline at `t` and write every tracked object's wrapper.
 * Pure function of (tracks, t) — deterministic seeks for screenshots.
 */
export function sampleTimeline(viewer, t) {
    const timeline = tl(viewer);
    for (const [objectId, channels] of timeline.tracks) {
        const entry = viewer._entryById(objectId);
        if (!entry) continue;
        const p = sampleChannel(channels.position, t, lerp3);
        const q = sampleChannel(channels.rotation, t, slerp4);
        const s = sampleChannel(channels.scale, t, lerp3);
        if (p) entry.logical.p.set(p[0], p[1], p[2]);
        if (q) entry.logical.q.set(q[0], q[1], q[2], q[3]);
        if (s) entry.logical.s.set(s[0], s[1], s[2]);
        viewer._composeWrapper(entry);
    }
}

export function playTimeline(viewer, { loop } = {}) {
    const timeline = tl(viewer);
    if (timeline.tracks.size === 0) {
        throw new Error("Timeline is empty — set_keyframe first.");
    }
    if (loop !== undefined) timeline.loop = !!loop;
    // Size the light/shadow/grid rig ONCE to the swept animation volume (per
    // frame _updateSceneRig would rebuild grid/axis geometry at 60 Hz).
    const swept = sweptBox(viewer);
    if (swept && !swept.isEmpty()) viewer._updateSceneRig(swept);
    timeline.playing = true;
    viewer.invalidate();   // wakes the demand-driven loop; keep-alive holds it
    return { playing: true, time: Math.round(timeline.time * 1000) / 1000,
             duration: Math.round(effectiveDuration(timeline) * 1000) / 1000,
             loop: timeline.loop };
}

export function pauseTimeline(viewer) {
    const timeline = tl(viewer);
    timeline.playing = false;
    viewer.invalidate();
    return { playing: false, time: Math.round(timeline.time * 1000) / 1000 };
}

export function seekTimeline(viewer, { time } = {}) {
    const timeline = tl(viewer);
    if (!(time >= 0)) throw new Error("seek_timeline requires time >= 0 (seconds)");
    timeline.time = time;
    sampleTimeline(viewer, time);
    viewer.invalidate();
    return { time: Math.round(time * 1000) / 1000 };
}

export function setTimelineDuration(viewer, { duration } = {}) {
    const timeline = tl(viewer);
    if (duration !== undefined) {
        if (!(duration > 0)) throw new Error("duration must be > 0 seconds");
        timeline.duration = duration;
    }
    return { duration: Math.round(effectiveDuration(timeline) * 1000) / 1000 };
}

/** Advance playback by `delta` seconds (render loop only). Returns true while playing. */
export function tickTimeline(viewer, delta) {
    const timeline = viewer._timeline;
    if (!timeline || !timeline.playing) return false;
    const dur = effectiveDuration(timeline);
    if (dur <= 0) { timeline.playing = false; return false; }
    timeline.time += delta;
    if (timeline.time > dur) {
        if (timeline.loop) timeline.time %= dur;
        else { timeline.time = dur; timeline.playing = false; }
    }
    sampleTimeline(viewer, timeline.time);
    return timeline.playing;
}

/** Union of every tracked object's AABB at every key position (rig sizing). */
function sweptBox(viewer) {
    const timeline = viewer._timeline;
    const union = viewer._visibleUnionBox() || new THREE.Box3();
    if (!timeline) return union;
    for (const [objectId, channels] of timeline.tracks) {
        const entry = viewer._entryById(objectId);
        if (!entry) continue;
        const box = new THREE.Box3().setFromObject(entry.wrapper);
        if (box.isEmpty()) continue;
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        for (const k of channels.position) {
            const c = new THREE.Vector3(k.v[0], k.v[1], k.v[2]);
            union.union(new THREE.Box3(
                c.clone().subScalar(sphere.radius), c.clone().addScalar(sphere.radius)));
        }
    }
    return union;
}

/** Timeline block for getState (agents must see WHY the scene is moving). */
export function timelineState(viewer) {
    const timeline = viewer._timeline;
    if (!timeline || timeline.tracks.size === 0) return { tracks: 0 };
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return {
        tracks: timeline.tracks.size,
        playing: timeline.playing,
        time: r3(timeline.time),
        duration: r3(effectiveDuration(timeline)),
        loop: timeline.loop,
    };
}

/** Serialize for manifests (v2) — object refs converted by the caller. */
export function serializeTimeline(viewer) {
    const timeline = viewer._timeline;
    if (!timeline || timeline.tracks.size === 0) return null;
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const tracks = [];
    for (const [objectId, channels] of timeline.tracks) {
        for (const [channel, keys] of Object.entries(channels)) {
            if (!keys.length) continue;
            tracks.push({
                objectId,
                channel,
                keys: keys.map((k) => ({
                    t: r4(k.t), v: k.v.map(r4),
                    // Requested Euler degrees round-trip through manifests so
                    // get_timeline after load_scene shows the AUTHORED angles
                    // (a stored 120° yaw otherwise reads [-180, 60, -180]).
                    ...(k.e ? { e: k.e.map(r4) } : {}),
                    ...(k.easing !== "linear" ? { easing: k.easing } : {}),
                })),
            });
        }
    }
    return { duration: r4(timeline.duration), tracks };
}

/** Rebuild from a manifest (objectId already remapped by the caller). */
export function restoreTimeline(viewer, data) {
    const timeline = tl(viewer);
    timeline.tracks.clear();
    timeline.duration = data.duration || 0;
    timeline.time = 0;
    timeline.playing = false;
    let restored = 0;
    for (const track of data.tracks || []) {
        const entry = viewer._entryById(track.objectId);
        if (!entry) continue;
        if (!timeline.tracks.has(track.objectId)) {
            timeline.tracks.set(track.objectId, { position: [], rotation: [], scale: [] });
            entry.basePlacement = {
                p: entry.logical.p.clone(),
                q: entry.logical.q.clone(),
                s: entry.logical.s.clone(),
            };
        }
        const channels = timeline.tracks.get(track.objectId);
        if (!channels[track.channel]) continue;
        channels[track.channel] = track.keys
            .map((k) => ({ t: k.t, v: k.v, easing: k.easing || "linear",
                           ...(k.e ? { e: k.e } : {}) }))
            .sort((a, b) => a.t - b.t)
            .slice(0, TIMELINE_MAX_KEYS);
        restored++;
    }
    return restored;
}
