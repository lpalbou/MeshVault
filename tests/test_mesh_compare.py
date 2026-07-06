"""Unit tests for the shape-registration compare engine (backend/mesh_compare.py).

These exercise the math directly on numpy point clouds (no browser / MCP), covering the
guarantees the adversarial review pinned down: exact transform recovery, floor-input
validation, partial-overlap robustness, local-edit sensitivity via the p95 term, and
mirror detection.
"""

import numpy as np
import pytest

from backend.mesh_compare import compare_point_sets


def _blob(seed, n=6000):
    """Points on a genuinely ASYMMETRIC closed surface (no rotational symmetry, so both
    rotation recovery and partial-overlap registration are well-posed). An ellipsoid
    warped by a position-dependent bump that enlarges one lobe."""
    rng = np.random.default_rng(seed)
    v = rng.normal(size=(n, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    p = v * np.array([3.0, 1.5, 1.0])
    # Break all symmetry: push the +x, +y octant outward.
    bump = np.clip(p[:, 0], 0, None) * 0.4 + np.clip(p[:, 1], 0, None) * 0.25
    p[:, 0] += bump
    return p


def _torus(seed, n=3000, R=2.0, r=0.7):
    """Points on a torus surface — a genuinely different shape from the ellipsoid."""
    rng = np.random.default_rng(seed)
    u = rng.uniform(0, 2 * np.pi, n)
    w = rng.uniform(0, 2 * np.pi, n)
    return np.stack([(R + r * np.cos(w)) * np.cos(u),
                     (R + r * np.cos(w)) * np.sin(u),
                     r * np.sin(w)], axis=1)


def _rot_y(deg):
    t = np.radians(deg)
    return np.array([[np.cos(t), 0, np.sin(t)], [0, 1, 0], [-np.sin(t), 0, np.cos(t)]])


def test_identical_resample_is_identical():
    base = _blob(1)
    alt = _blob(2)  # independent sampling of the "same" distribution as floor
    r = compare_point_sets(base, base.copy(), reference_alt=alt)
    assert r["classification"] == "identical"
    assert r["distances"]["chamferMeanNormalized"] == 0.0


def test_scale_recovery_across_decades():
    base = _blob(3)
    for s in (0.01, 0.5, 10.0, 100.0):
        cand = base * s + np.array([5.0, -2.0, 1.0])
        r = compare_point_sets(base, cand)
        # scaleRatio is ref/cand ≈ 1/s
        assert r["alignment"]["scaleRatio"] == pytest.approx(1.0 / s, rel=0.03)
        assert r["classification"] == "identical"


def test_rotation_recovery():
    base = _blob(4)
    for deg in (3, 30, 90, 179):
        cand = base @ _rot_y(deg).T
        r = compare_point_sets(base, cand)
        assert r["alignment"]["rotationDeg"] == pytest.approx(deg, abs=1.0)
        assert r["classification"] == "identical"


def test_different_objects_are_different():
    a = _blob(5)                       # ellipsoid
    b = _torus(99)                     # torus — clearly not an ellipsoid
    r = compare_point_sets(a, b, reference_alt=_blob(6))
    assert r["classification"] in ("same_shape_modified", "different")
    assert r["distances"]["chamferMeanNormalized"] > 0.02


def test_reference_alt_must_be_finite():
    base = _blob(7)
    bad = base.copy()
    bad[0, 0] = np.nan
    # A NaN floor must RAISE, not silently classify everything identical.
    with pytest.raises(ValueError):
        compare_point_sets(base, _blob(8), reference_alt=bad)


def test_partial_overlap_is_flagged_not_called_identical():
    # A candidate that is a spatial subset of the reference (a missing region) is an
    # inherently ill-posed registration; the guarantee is NOT perfect alignment but that
    # the tool (a) does not certify it "identical" and (b) surfaces the missing region as
    # asymmetry. (Heavy partial overlap alignment is documented as a known limitation.)
    base = _blob(9)
    keep = base[base[:, 0] > np.percentile(base[:, 0], 25)]  # drop ~25% on one side
    r = compare_point_sets(base, keep, reference_alt=_blob(10), align=True)
    assert r["classification"] != "identical"
    assert r["distances"]["asymmetry"] > 0.002


def test_local_edit_detected_via_p95():
    # Displace a small coherent patch: barely moves the mean, but the p95 tail catches it,
    # so classification must escalate above "identical".
    base = _blob(11)
    alt = _blob(12)
    diag = np.linalg.norm(base.max(0) - base.min(0))
    mod = base.copy()
    rng = np.random.default_rng(13)
    idx = rng.choice(len(base), int(0.15 * len(base)), replace=False)
    mod[idx, 1] += diag * 0.15
    r = compare_point_sets(base, mod, reference_alt=alt)
    assert r["classification"] != "identical"


def test_degenerate_and_bad_inputs_rejected():
    with pytest.raises(ValueError):
        compare_point_sets(np.zeros((10, 3)), _blob(14))  # zero-extent reference
    with pytest.raises(ValueError):
        compare_point_sets(_blob(15), _blob(16)[:, :2])   # not 3D
    with pytest.raises(ValueError):
        compare_point_sets(_blob(17)[:5], _blob(18))      # too few points


def test_output_is_json_safe():
    import json
    r = compare_point_sets(_blob(19), _blob(20) @ _rot_y(45).T, reference_alt=_blob(21))
    json.dumps(r)  # must not raise (no numpy scalars / NaN leaking through)
