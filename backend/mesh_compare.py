"""
mesh_compare — shape registration + geometric distance between two surface point sets.

Purpose (backlog 039): let agents compare 3D objects GEOMETRICALLY — "same shape,
rotated and rescaled" vs "same shape, locally modified" vs "different object" — which
neither screenshots nor count tables can decide.

Pipeline (numpy only; no scipy):
1. Normalize: centroids to origin; uniform scale ratio from RMS radii (unit-mismatch
   detection: a meters-vs-centimeters export is the SAME shape, scale 100).
2. Initial rotation: PCA axis alignment. Eigenvectors are sign-ambiguous, so all 4
   proper-rotation sign combinations are scored and the best seeds the refinement
   (plus identity, in case PCA axes are degenerate — e.g. spheres).
3. ICP refinement: nearest-neighbor correspondences (chunked brute-force — exact, and
   plenty fast at ~4k samples) + Kabsch SVD for the optimal rotation each iteration.
4. Metrics on the registered clouds: symmetric chamfer (mean/p95) and Hausdorff
   (max-min) distances, normalized by the REFERENCE bounding-box diagonal so results
   are comparable across model scales.

All heuristics (classification thresholds) are documented at the definition and
reported alongside the raw numbers — agents can apply their own thresholds.
"""

from __future__ import annotations

import numpy as np

# Classification thresholds on the normalized symmetric chamfer distance IN EXCESS of
# the sampling floor (fraction of the reference bbox diagonal). Heuristic, documented,
# and calibrated on measured pairs (Draco-compressed copy 0.0002; full remesh of the
# same head 0.0057; two genuinely different objects 0.03+):
# identical: residual at sampling-noise level (exact copies, lossy compression).
# near_identical: minor decimation / remesh of the same object.
# same_shape_modified: same object with substantial local edits.
# different: registration could not make the surfaces agree.
CLASS_THRESHOLDS = (
    (0.002, "identical"),
    (0.008, "near_identical"),
    (0.025, "same_shape_modified"),
    (float("inf"), "different"),
)

# Secondary classifier on the p95 excess: local edits concentrate distance in the tail
# while barely moving the mean (a 5%-of-surface patch displaced 2% of the bbox moves the
# mean by ~0.0005 — invisible — but the p95/tail sees it). Thresholds are ~4× the mean
# thresholds, reflecting the tail's higher variance.
P95_THRESHOLDS = (
    (0.008, "identical"),
    (0.032, "near_identical"),
    (0.1, "same_shape_modified"),
    (float("inf"), "different"),
)

ICP_MAX_ITER = 40
ICP_TOL = 1e-7
ICP_TRIM = 0.8      # keep the best 80% of correspondences in each Kabsch update —
                    # robustness to partial overlap (missing regions otherwise drag
                    # rotation/scale; adversarial finding: 53° phantom rotation)
NN_CHUNK = 512      # rows per brute-force distance block (memory bound)
REG_MAX_POINTS = 4096  # ICP runs on at most this many points; distances use full sets


def compare_point_sets(reference: np.ndarray, candidate: np.ndarray,
                       align: bool = True,
                       reference_alt: np.ndarray | None = None) -> dict:
    """Register `candidate` onto `reference` and measure the residual shape distance.

    Args:
        reference: (n,3) float array — surface samples of the reference model.
        candidate: (m,3) float array — surface samples of the model to compare.
        align: if False, skip registration (compare in-place — detects pose changes).
        reference_alt: optional second, independent sampling of the SAME reference
            surface (different seed). Used to MEASURE the sampling floor — the chamfer
            two samplings of an identical surface produce — so classification judges the
            EXCESS distance above that floor instead of mistaking sampling noise for
            shape difference.

    Returns a JSON-safe dict: alignment {scaleRatio, rotationDeg, translation,
    iterations, converged}, distances (normalized + absolute + floor), classification.
    """
    ref = np.asarray(reference, dtype=np.float64)
    cand = np.asarray(candidate, dtype=np.float64)
    if ref.ndim != 2 or ref.shape[1] != 3 or len(ref) < 8:
        raise ValueError("reference must be (n>=8, 3) points")
    if cand.ndim != 2 or cand.shape[1] != 3 or len(cand) < 8:
        raise ValueError("candidate must be (m>=8, 3) points")
    if not (np.isfinite(ref).all() and np.isfinite(cand).all()):
        raise ValueError("point sets contain NaN/Inf values")
    alt = None
    if reference_alt is not None:
        alt = np.asarray(reference_alt, dtype=np.float64)
        # A poisoned floor sample must never silently force "identical" — validate it
        # exactly like the primary inputs (adversarial finding: one NaN in alt turned
        # helmet-vs-sphere into "identical").
        if alt.ndim != 2 or alt.shape[1] != 3 or len(alt) < 8 or not np.isfinite(alt).all():
            raise ValueError("reference_alt must be finite (k>=8, 3) points")

    # numpy on macOS Accelerate emits spurious matmul RuntimeWarnings (results verified
    # exact against known transforms); keep them out of the MCP stderr stream.
    with np.errstate(all="ignore"):
        return _compare(ref, cand, align, alt)


def _compare(ref: np.ndarray, cand: np.ndarray, align: bool,
             ref_alt: np.ndarray | None) -> dict:

    diag = float(np.linalg.norm(ref.max(axis=0) - ref.min(axis=0)))
    if diag <= 0:
        raise ValueError("reference has zero extent")

    warnings: list[str] = []
    ref_c = ref.mean(axis=0)
    cand_c = cand.mean(axis=0)
    mirror_note = None

    if align:
        r0 = ref - ref_c
        c0 = cand - cand_c
        # Uniform scale from RMS radii (robust to sampling density differences).
        rms_ref = float(np.sqrt((r0 ** 2).sum(axis=1).mean()))
        rms_cand = float(np.sqrt((c0 ** 2).sum(axis=1).mean()))
        scale = rms_ref / rms_cand if rms_cand > 0 else 1.0
        c0 = c0 * scale

        # Registration accuracy saturates well below full sample counts; running ICP on
        # a capped subsample keeps large compares off the O(n²)·iterations cliff
        # (adversarial finding: 16384-sample ICP took 165 s). Distances below are still
        # measured on the FULL sets.
        r_reg = _subsample(r0, REG_MAX_POINTS)
        c_reg = _subsample(c0, REG_MAX_POINTS)

        R_total, iters, converged = _best_alignment(r_reg, c_reg)
        registered = (c0 @ R_total.T) + ref_c

        # Mirror probe: the search uses proper rotations only (correct — a mirrored
        # object is NOT the same object), but chiral parts then land in fuzzy classes
        # with no explanation. One extra ICP from a reflected start measures how much
        # better an IMPROPER fit would be, so left/right-hand pairs are called out.
        M = np.diag([-1.0, 1.0, 1.0])
        R_m, _, _ = _best_alignment(r_reg, c_reg @ M.T)
        mirror_mean = float(_nn_dist((c_reg @ M.T) @ R_m.T, r_reg).mean())
        proper_mean = float(_nn_dist(c_reg @ R_total.T, r_reg).mean())
        if mirror_mean < 0.5 * proper_mean and proper_mean / diag > 0.001:
            mirror_note = _r(mirror_mean / diag, 6)
            warnings.append(
                "A mirrored (reflected) alignment fits much better than any rotation — "
                "the candidate may be a mirror image of the reference (e.g. left/right pair).")

        # Full registration map: candidate point x -> scale · R · x + t.
        t_vec = ref_c - scale * (R_total @ cand_c)
        # Column-major 4x4 (three.js Matrix4.fromArray order) combining scale·R and t,
        # so the app can apply the alignment to the candidate's group directly.
        sR = scale * R_total
        matrix4 = [
            sR[0, 0], sR[1, 0], sR[2, 0], 0.0,
            sR[0, 1], sR[1, 1], sR[2, 1], 0.0,
            sR[0, 2], sR[1, 2], sR[2, 2], 0.0,
            t_vec[0], t_vec[1], t_vec[2], 1.0,
        ]
        alignment = {
            "scaleRatio": _r(scale, 6),
            "rotationDeg": _r(_rotation_angle_deg(R_total), 2),
            "rotationMatrix": [[_r(R_total[i, j], 8) for j in range(3)] for i in range(3)],
            "translation": [_r(v, 5) for v in t_vec],
            "matrix4": [_r(v, 8) for v in matrix4],  # column-major, for THREE.Matrix4.fromArray
            "iterations": iters,
            "converged": bool(converged),
        }
        if mirror_note is not None:
            alignment["mirrorFitNormalized"] = mirror_note
    else:
        registered = cand
        alignment = None

    d_c2r = _nn_dist(registered, ref)   # candidate → reference
    d_r2c = _nn_dist(ref, registered)   # reference → candidate (detects missing parts)
    chamfer_mean = float((d_c2r.mean() + d_r2c.mean()) / 2)
    chamfer_p95 = float((np.percentile(d_c2r, 95) + np.percentile(d_r2c, 95)) / 2)
    hausdorff = float(max(d_c2r.max(), d_r2c.max()))

    # Sampling floor: even two samplings of the SAME surface have nonzero chamfer
    # (finite sample count). Classify on the distance in EXCESS of that floor — for the
    # mean AND the p95 (a purely mean-based classifier is blind to local edits that the
    # tail statistics see; adversarial finding).
    floor_mean = 0.0
    floor_p95 = 0.0
    if ref_alt is not None:
        d1 = _nn_dist(ref_alt, ref)
        d2 = _nn_dist(ref, ref_alt)
        floor_mean = float((d1.mean() + d2.mean()) / 2)
        floor_p95 = float((np.percentile(d1, 95) + np.percentile(d2, 95)) / 2)
        if abs(len(ref_alt) - len(cand)) > 0.5 * len(cand):
            warnings.append(
                "Sampling floor was measured at a very different sample density than the "
                "candidate — the floor correction may be inaccurate.")
    else:
        warnings.append(
            "No reference_alt sampling provided: the sampling-noise floor is unknown "
            "and classification will overestimate differences at these sample counts.")

    norm_mean = max(0.0, chamfer_mean - floor_mean) / diag
    norm_p95 = max(0.0, chamfer_p95 - floor_p95) / diag
    cls_mean = _classify(norm_mean, CLASS_THRESHOLDS)
    cls_p95 = _classify(norm_p95, P95_THRESHOLDS)
    # Take the WORSE of the two verdicts: mean catches global drift, p95 catches
    # concentrated local edits the mean dilutes.
    order = ["identical", "near_identical", "same_shape_modified", "different"]
    classification = max(cls_mean, cls_p95, key=order.index)

    # Boundary honesty: a scalar threshold cannot separate "heavily modified same
    # object" from "similar different object" in the band around the last boundary
    # (measured overlap in real data). Flag it instead of pretending confidence.
    borderline = any(
        thr * 0.7 <= norm_mean <= thr * 1.3
        for thr, _ in CLASS_THRESHOLDS if thr != float("inf"))
    if borderline:
        warnings.append(
            "The measurement sits near a classification boundary — treat the label as "
            "uncertain and confirm visually (screenshot both models).")

    result = {
        "alignment": alignment,
        "distances": {
            "normalizedBy": "reference bbox diagonal",
            "bboxDiagonal": _r(diag, 5),
            "chamferMean": _r(chamfer_mean, 6),
            "samplingFloor": _r(floor_mean, 6),
            "samplingFloorNote": "chamfer between two independent samplings of the SAME "
                                 "reference surface; *Normalized values are the excess "
                                 "above this floor, divided by the reference bbox diagonal",
            "chamferMeanNormalized": _r(norm_mean, 6),
            "chamferP95": _r(chamfer_p95, 6),
            "chamferP95Normalized": _r(norm_p95, 6),
            "hausdorff": _r(hausdorff, 6),
            "hausdorffNormalized": _r(hausdorff / diag, 6),
            "hausdorffNote": "Hausdorff (worst-case) is NOT floor-corrected — expect a "
                             "nonzero value (~0.02-0.05 of diagonal) even for identical "
                             "surfaces at finite sampling; use it to compare candidates, "
                             "not as an absolute error.",
            # Asymmetry flags shape SUBSETS: candidate→ref small but ref→cand large
            # means the candidate is missing regions the reference has (or vice versa).
            "asymmetry": _r(float(abs(d_c2r.mean() - d_r2c.mean())) / diag, 6),
        },
        "classification": classification,
        "borderline": borderline,
        "classificationScale": [
            {"maxNormalizedChamfer": thr if thr != float("inf") else None, "label": label}
            for thr, label in CLASS_THRESHOLDS
        ],
    }
    if warnings:
        result["warnings"] = warnings
    return result


def _classify(value: float, thresholds) -> str:
    return next(label for thr, label in thresholds if value <= thr)


def _subsample(pts: np.ndarray, cap: int) -> np.ndarray:
    """Deterministic subsample for registration (points are already in random order
    from area-weighted sampling, so a stride pick is unbiased)."""
    if len(pts) <= cap:
        return pts
    idx = np.linspace(0, len(pts) - 1, cap).astype(np.int64)
    return pts[idx]


def _best_alignment(r0: np.ndarray, c0: np.ndarray):
    """Best rotation over all initializations (identity + PCA sign combos)."""
    best = None
    for R_init in _initial_rotations(r0, c0):
        R, iters, converged, mean_d = _icp(c0 @ R_init.T, r0)
        R_total = R @ R_init
        if best is None or mean_d < best[3]:
            best = (R_total, iters, converged, mean_d)
    return best[0], best[1], best[2]


# ---------------------------------------------------------------------------
# Registration internals
# ---------------------------------------------------------------------------

def _initial_rotations(ref0: np.ndarray, cand0: np.ndarray):
    """Candidate starting rotations: identity + PCA alignments (4 proper sign combos).

    PCA aligns principal axes but each eigenvector's sign is arbitrary; of the 8 sign
    choices, 4 are proper rotations (det=+1). Identity is kept because PCA axes are
    unstable for near-symmetric shapes (spheres, cubes) where it can only hurt.
    """
    yield np.eye(3)
    try:
        e_ref = _pca_axes(ref0)
        e_cand = _pca_axes(cand0)
    except np.linalg.LinAlgError:
        return
    for s0 in (1, -1):
        for s1 in (1, -1):
            signs = np.array([s0, s1, s0 * s1], dtype=np.float64)  # keeps det=+1
            R = e_ref @ np.diag(signs) @ e_cand.T
            if np.linalg.det(R) < 0:  # numerical safety
                continue
            yield R


def _pca_axes(pts: np.ndarray) -> np.ndarray:
    """Right-handed principal axes (columns), largest variance first."""
    cov = np.cov(pts.T)
    w, v = np.linalg.eigh(cov)
    v = v[:, np.argsort(w)[::-1]]
    if np.linalg.det(v) < 0:
        v[:, 2] = -v[:, 2]
    return v


def _icp(src: np.ndarray, dst: np.ndarray):
    """Trimmed point-to-point ICP (rotation only — inputs are pre-centered/scaled).

    Each iteration keeps only the best ICP_TRIM fraction of correspondences for the
    Kabsch update: with partial overlap (a candidate missing a region), the unmatched
    points' bogus correspondences otherwise pull the rotation far off (measured 53° on
    a region-deleted copy that needed no rotation at all).
    """
    R_total = np.eye(3)
    cur = src
    prev_mean = np.inf
    iters = 0
    converged = False
    keep = max(8, int(len(src) * ICP_TRIM))
    for iters in range(1, ICP_MAX_ITER + 1):
        matched = dst[_nn_idx(cur, dst)]
        dists = np.linalg.norm(cur - matched, axis=1)
        sel = np.argpartition(dists, keep - 1)[:keep]
        R = _kabsch(cur[sel], matched[sel])
        cur = cur @ R.T
        R_total = R @ R_total
        mean_d = float(dists.mean())
        if abs(prev_mean - mean_d) < ICP_TOL:
            converged = True
            break
        prev_mean = mean_d
    return R_total, iters, converged, float(_nn_dist(cur, dst).mean())


def _kabsch(P: np.ndarray, Q: np.ndarray) -> np.ndarray:
    """Optimal rotation mapping P onto Q (both centered) — SVD of the cross-covariance."""
    H = P.T @ Q
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d])
    return Vt.T @ D @ U.T


def _nn_idx(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """Index of the nearest point in B for every point of A (chunked exact search)."""
    out = np.empty(len(A), dtype=np.int64)
    b_sq = (B ** 2).sum(axis=1)
    for i in range(0, len(A), NN_CHUNK):
        chunk = A[i:i + NN_CHUNK]
        d2 = ((chunk ** 2).sum(axis=1))[:, None] + b_sq[None, :] - 2.0 * (chunk @ B.T)
        out[i:i + NN_CHUNK] = d2.argmin(axis=1)
    return out


def _nn_dist(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """Distance to the nearest point in B for every point of A."""
    idx = _nn_idx(A, B)
    return np.linalg.norm(A - B[idx], axis=1)


def _rotation_angle_deg(R: np.ndarray) -> float:
    """Total rotation angle of a rotation matrix (axis-angle magnitude)."""
    tr = float(np.trace(R))
    c = max(-1.0, min(1.0, (tr - 1.0) / 2.0))
    return float(np.degrees(np.arccos(c)))


def _r(v: float, nd: int) -> float:
    return round(float(v), nd)
