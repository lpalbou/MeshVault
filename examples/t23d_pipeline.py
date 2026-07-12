#!/usr/bin/env python3
"""The abstract3d → MeshVault pipeline as one library-shaped script (backlog 053).

    text prompt → t23d generate → intake → repair → adaptive-optimize
                → articulate → animate → export (animated GLB) → verify

Every stage ALWAYS runs its inspection (cheap numbers) and CONDITIONALLY runs
its mutation — the per-stage verdict record {numbers_before, decision, action,
numbers_after} is the proof either way. A clean input produces honest no-ops
with evidence, never forced mutations. All gates are ratios/parameters, not
absolute counts derived from any test asset.

Architecture: composes backend.headless_viewer.HeadlessSession — the same
loader/executor the MCP server uses — so this file doubles as the reference
for embedding MeshVault's pipeline in another application. abstract3d runs as
a CLI subprocess in its OWN environment (its torch/MLX stack must not import
into this process); the generation contract is the bundle directory
(scene.glb + metadata.json). The agent-driven version of this same flow is
documented in examples/t23d_pipeline.md.

Resource negotiation (same machine as abstract3d): TripoSR only by default;
never launches heavy backends; refuses to generate while another abstract3d
GPU job is running unless --force-generate; --bundle reuses an existing
generation and launches nothing.

Prereqs: poetry install (MeshVault) + `playwright install chromium`;
`abstract3d` CLI on PATH or --abstract3d-bin (only when generating).

Usage:
  python examples/t23d_pipeline.py "a wooden treasure chest with a curved lid"
  python examples/t23d_pipeline.py --bundle ~/out/chest   # reuse a generation
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# Allow running from a source checkout without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.headless_viewer import HeadlessSession  # noqa: E402
from backend.mesh_compare import compare_point_sets  # noqa: E402

import numpy as np  # noqa: E402


# ---------------------------------------------------------------------------
# Verdict records: the machine-checkable spine of the whole run.
# ---------------------------------------------------------------------------

class Report:
    def __init__(self, out_dir: Path):
        self.out_dir = out_dir
        self.stages: list[dict] = []
        self._t0 = time.monotonic()

    def stage(self, name: str, *, numbers_before, decision: str, action: str,
              numbers_after=None, artifacts=None, judgment: bool = False,
              wall_s: float | None = None):
        rec = {
            "stage": name,
            "numbers_before": numbers_before,
            "decision": decision,
            "action": action,
            "numbers_after": numbers_after,
            "artifacts": artifacts or [],
            "judgment": judgment,   # True where a human/agent choice entered
            "wall_s": round(wall_s, 1) if wall_s is not None else None,
        }
        self.stages.append(rec)
        print(f"[{name}] {decision} -> {action}"
              + (f"  ({rec['wall_s']}s)" if rec["wall_s"] else ""))
        return rec

    def write(self, meta: dict):
        payload = {
            "meta": meta,
            "total_wall_s": round(time.monotonic() - self._t0, 1),
            "stages": self.stages,
        }
        (self.out_dir / "verdicts.json").write_text(json.dumps(payload, indent=2))
        lines = [f"# t23d pipeline run — {meta.get('run_id')}", "",
                 f"Prompt: **{meta.get('prompt')}**", "",
                 f"Bundle: `{meta.get('bundle')}`", "",
                 "| stage | decision | action | judgment | wall (s) |",
                 "|-------|----------|--------|----------|----------|"]
        for s in self.stages:
            lines.append(f"| {s['stage']} | {s['decision']} | {s['action']} | "
                         f"{'yes' if s['judgment'] else '—'} | {s['wall_s'] or '—'} |")
        lines += ["", "## Artifacts", ""]
        for s in self.stages:
            for a in s["artifacts"]:
                lines.append(f"- `{a}` ({s['stage']})")
        lines += ["", "Full numbers: `verdicts.json`.", ""]
        (self.out_dir / "INDEX.md").write_text("\n".join(lines))


# ---------------------------------------------------------------------------
# Stage 0 — generate (abstract3d t23d, subprocess, own env)
# ---------------------------------------------------------------------------

def abstract3d_busy() -> str | None:
    """Best-effort check for a running abstract3d GPU job (shared MPS)."""
    try:
        out = subprocess.run(["pgrep", "-fl", "abstract3d|harness.py|hy3dgen"],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    lines = [l for l in out.splitlines() if "pgrep" not in l and l.strip()]
    return lines[0][:120] if lines else None


def generate(args, report: Report) -> Path:
    if args.bundle:
        bundle = Path(args.bundle).expanduser()
        glb = bundle / "scene.glb"
        if not glb.is_file():
            sys.exit(f"--bundle {bundle} has no scene.glb")
        report.stage("generate", numbers_before=None,
                     decision="bundle supplied — reuse, launch nothing "
                              "(resource-negotiation path)",
                     action=f"reused {glb}",
                     artifacts=[str(glb)])
        return glb

    busy = abstract3d_busy()
    if busy and not args.force_generate:
        sys.exit(
            f"An abstract3d GPU job appears to be running:\n  {busy}\n"
            "Generation shares the MPS device. Either reuse an existing bundle "
            "(--bundle <dir>), wait for the job to finish, or pass "
            "--force-generate to proceed anyway (TripoSR + the image stage are "
            "comparatively light but WILL contend).")

    out_dir = report.out_dir / "bundle"
    cmd = [args.abstract3d_bin, "t23d", args.prompt,
           "--output-dir", str(out_dir),
           "--backend", args.backend,
           "--device", args.device,
           "--format", "glb"]
    t0 = time.monotonic()
    print("[generate] running:", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if proc.returncode != 0:
        sys.exit(f"abstract3d t23d failed (exit {proc.returncode}):\n"
                 f"{proc.stderr[-2000:]}\n"
                 "Hint: --bundle <dir> reuses an existing generation.")
    glb = out_dir / "scene.glb"
    if not glb.is_file():
        candidates = list(out_dir.rglob("scene.glb"))
        if not candidates:
            sys.exit(f"t23d reported success but no scene.glb under {out_dir}")
        glb = candidates[0]
    meta = {}
    meta_file = glb.parent / "metadata.json"
    if meta_file.is_file():
        try:
            meta = json.loads(meta_file.read_text())
        except Exception:
            pass
    # TripoSR bundle metadata carries topology facts (is_watertight, face
    # counts) and postprocess_warnings — there is no `quality_verdict` key
    # (gauntlet finding: the earlier doc claimed one).
    topo = meta.get("topology", {}) if isinstance(meta.get("topology"), dict) else {}
    report.stage("generate", numbers_before=None,
                 decision=f"no bundle given; device free (busy check: {busy or 'idle'})",
                 action=f"t23d '{args.prompt}' via {args.backend}",
                 numbers_after={"bytes": glb.stat().st_size,
                                "watertight": topo.get("is_watertight"),
                                "warnings": meta.get("postprocess_warnings"),
                                "backend": meta.get("backend") or args.backend},
                 artifacts=[str(glb)], wall_s=time.monotonic() - t0)
    return glb


# ---------------------------------------------------------------------------
# The MeshVault stages
# ---------------------------------------------------------------------------

async def run_pipeline(args, report: Report, glb: Path):
    session = HeadlessSession()
    out = report.out_dir

    async def mv(action, params=None):
        r = await session.execute(action, params)
        if not r.get("ok"):
            raise RuntimeError(f"{action} failed: {r.get('error')}")
        return r.get("result")

    async def shot(name, *, azimuth=35, elevation=18, size=384):
        await mv("orbit", {"azimuth": azimuth, "elevation": elevation,
                           "scope": "scene"})
        png = await session.capture_png(size, size, ssao=False)
        p = out / name
        p.write_bytes(png)
        return str(p)

    try:
        # ---- intake ------------------------------------------------------
        t0 = time.monotonic()
        r = await session.load_local(glb)
        if not r.get("ok"):
            raise RuntimeError(f"load failed: {r.get('error')}")
        await session.apply_render_preset("studio")
        desc = await mv("describe_scene", {"maxItems": 6})
        stats = await mv("get_mesh_stats")
        bounds = await mv("get_bounds")
        tri = desc["model"]["triangles"]
        total = stats.get("total", {}) if not stats.get("skipped") else {}
        intake_numbers = {
            "triangles": tri,
            "meshes": desc["model"]["meshCount"],
            "materials": desc["model"]["materialCount"],
            "size": bounds["size"],
            "openEdges": total.get("openEdges"),
            "degenerate": total.get("degenerate"),
            "statsSkipped": bool(stats.get("skipped")),
            "issues": desc.get("issues", []),
        }
        report.stage("intake", numbers_before=None,
                     decision="inspection only (intake never mutates)",
                     action="load + describe_scene + get_mesh_stats",
                     numbers_after=intake_numbers,
                     artifacts=[await shot("1_intake.png")],
                     wall_s=time.monotonic() - t0)

        # ---- repair --------------------------------------------------------
        t0 = time.monotonic()
        fix = await mv("fix_mesh", {})
        deltas = fix.get("issues", {})
        noop = all((v.get("before") == v.get("after")) for v in deltas.values()
                   if isinstance(v, dict))
        report.stage("repair",
                     numbers_before={"openEdges": intake_numbers["openEdges"],
                                     "degenerate": intake_numbers["degenerate"]},
                     decision="fix_mesh default ops always run (cheap); "
                              + ("deltas were zero — honest NO-OP"
                                 if noop else "defects found and fixed"),
                     action=f"fix_mesh -> {json.dumps(fix.get('operations', []))[:160]}",
                     numbers_after=deltas,
                     wall_s=time.monotonic() - t0)

        # ---- adaptive optimize --------------------------------------------
        t0 = time.monotonic()
        survey = await mv("inspect_region", {"grid": 4})
        cells = survey.get("cells", [])
        densities = [c["triPerUnit2"] for c in cells if c.get("triangles", 0) > 0]
        median_density = float(np.median(densities)) if densities else 0
        qualifying = [
            c for c in cells
            if c.get("triangles", 0) > 0
            and c["triPerUnit2"] >= args.density_ratio * median_density
            and c.get("dihedralMeanDeg", 99) < args.flat_deg
        ]
        over_budget = tri > args.triangle_budget
        opt_numbers = {"triangles": tri, "budget": args.triangle_budget,
                       "medianDensity": round(median_density, 1),
                       "qualifyingCells": len(qualifying)}
        if over_budget and qualifying:
            # Chamfer fingerprint BEFORE mutation (compare_models refuses
            # composed scenes, and sampling must precede articulation anyway).
            before_pts = np.array((await mv("sample_points",
                                            {"count": 4096, "seed": 7}))["points"])
            done = []
            for c in qualifying[:args.max_regions]:
                r = await mv("simplify_region", {
                    "center": c["center"], "radius": c["radius"],
                    "ratio": args.simplify_ratio})
                done.append({"center": c["center"],
                             "achievedRatio": r.get("achievedRatio"),
                             "before": r.get("before"), "after": r.get("after")})
            after_pts = np.array((await mv("sample_points",
                                           {"count": 4096, "seed": 7}))["points"])
            cmp = compare_point_sets(before_pts, after_pts, align=False)
            new_tri = (await mv("describe_scene", {"maxItems": 2,
                                                   "checks": False}))["model"]["triangles"]
            report.stage("optimize", numbers_before=opt_numbers,
                         decision=f"triangles {tri} > budget {args.triangle_budget} AND "
                                  f"{len(qualifying)} cells ≥{args.density_ratio}× median "
                                  f"density with dihedral < {args.flat_deg}°",
                         action=f"simplify_region × {len(done)}",
                         numbers_after={"triangles": new_tri, "regions": done,
                                        "chamferMeanNormalized":
                                            cmp["distances"]["chamferMeanNormalized"],
                                        "classification": cmp["classification"]},
                         artifacts=[await shot("3_optimized.png")],
                         wall_s=time.monotonic() - t0)
        elif over_budget:
            # UNIFORM density over budget (the marching-cubes norm): no region
            # is MORE justified to decimate than another, so the adaptive gate
            # correctly finds nothing — the right tool is GLOBAL simplify
            # (gauntlet finding: the old table left over-budget uniform meshes
            # untouched).
            ratio = args.triangle_budget / tri
            r = await mv("simplify", {"ratio": max(0.1, min(0.9, ratio))})
            new_tri = (await mv("describe_scene", {"maxItems": 2,
                                                   "checks": False}))["model"]["triangles"]
            report.stage("optimize", numbers_before=opt_numbers,
                         decision=f"triangles {tri} > budget {args.triangle_budget} but "
                                  "density is UNIFORM (no cell ≥ ratio × median) — "
                                  "global simplify, not regional",
                         action=f"simplify {{ratio: {max(0.1, min(0.9, ratio)):.2f}}}",
                         numbers_after={"triangles": new_tri},
                         artifacts=[await shot("3_optimized.png")],
                         wall_s=time.monotonic() - t0)
            tri = new_tri
        else:
            report.stage("optimize", numbers_before=opt_numbers,
                         decision=f"triangles {tri} ≤ budget {args.triangle_budget} — "
                                  "honest NO-OP",
                         action="survey only (grid table in verdicts.json)",
                         numbers_after={"cells": cells[:6]},
                         wall_s=time.monotonic() - t0)

        # ---- texture inspection (report-only by default) -------------------
        t0 = time.monotonic()
        tex = await mv("inspect_texture")
        islands = None
        try:
            islands = (await mv("get_uv_islands", {}))
        except RuntimeError:
            pass
        report.stage("texture", numbers_before=None,
                     decision="inspection + report (mutation only against a "
                              "visually identified defect — none is assumed)",
                     action="inspect_texture + get_uv_islands",
                     numbers_after={"materials": tex.get("materials", tex),
                                    "islandCount": (islands or {}).get("islandCount")},
                     wall_s=time.monotonic() - t0)

        # ---- articulate -----------------------------------------------------
        t0 = time.monotonic()
        parts = await mv("detect_parts")
        plist = sorted(parts.get("parts", []),
                       key=lambda p: p["triangles"], reverse=True)
        second_frac = (plist[1]["triangles"] / max(1, tri)) if len(plist) > 1 else 0
        lid_id = base_id = None
        if len(plist) >= 2 and second_frac >= args.part_min_frac:
            sel = await mv("split_object", {
                "parts": [plist[1]["partId"]],
                "partitionId": parts["partitionId"]})
            created = sel["created"][0]
            lid_id = created["objectId"]
            pivot = created.get("suggestedPivot")
            decision = (f"detect_parts found {len(plist)} parts "
                        f"(2nd = {second_frac:.0%} of triangles ≥ "
                        f"{args.part_min_frac:.0%}) — split by parts")
            judgment = False
        else:
            # Plane cut at a prompt-implied hinge — THE judgment point of this
            # pipeline (an agent decides it from screenshots + pick; the script
            # exposes it as parameters — the default is a class prior, MEASURE
            # the real seam with pick when eyes are available).
            b = await mv("get_bounds")
            axis_i = {"x": 0, "y": 1, "z": 2}[args.cut_axis]
            at = b["min"][axis_i] + args.cut_at_frac * b["size"][axis_i]
            sel = await mv("split_object", {"axis": args.cut_axis, "at": at,
                                            "side": "+", "name": "lid"})
            created = sel["created"][0]
            lid_id = created["objectId"]
            pivot = created.get("suggestedPivot")
            # Hinge on the -z edge of the cut (chest-lid class default).
            pivot = [pivot[0], pivot[1], b["min"][2] + 0.03 * b["size"][2]]
            decision = (f"single fused component (detect_parts: {len(plist)} part(s)) "
                        f"— plane cut {args.cut_axis}={at:.3f} "
                        f"({args.cut_at_frac:.0%} of height), hinge at back edge")
            judgment = True
        objs = await mv("list_objects")
        base_id = next(o["id"] for o in objs["objects"] if o["id"] != lid_id)
        await mv("set_pivot", {"id": lid_id, "point": pivot})
        # Separation check BEFORE parenting (a parented child inherits its
        # parent's explode displacement; the verdict is only meaningful on
        # independent objects), then build the hierarchy.
        explode = await mv("explode_view", {"factor": 1.6})
        await mv("explode_view", {"factor": 0})
        await mv("set_parent", {"id": lid_id, "parent_id": base_id})
        report.stage("articulate", numbers_before={"parts": plist,
                                                   "partitionId": parts.get("partitionId")},
                     decision=decision,
                     action=f"split -> lid #{lid_id} / base #{base_id}; pivot {pivot}; "
                            f"openEdgesAdded {sel.get('openEdgesAdded')} "
                            "(cut faces are hollow — sweep kept ≤30°)",
                     numbers_after={"minGapWorld": explode.get("minGapWorld"),
                                    "objects": len(objs["objects"])},
                     artifacts=[await shot("5_articulated.png")],
                     judgment=judgment, wall_s=time.monotonic() - t0)

        # ---- animate --------------------------------------------------------
        t0 = time.monotonic()
        sweep = -abs(args.sweep_deg)          # ≤30°: hollow cut faces stay hidden
        for t, rot in [(0, [0, 0, 0]), (1.2, [sweep, 0, 0]), (2.4, [0, 0, 0])]:
            await mv("set_keyframe", {"id": lid_id, "time": t, "rotation": rot,
                                      "easing": "ease_in_out"})
        # Base turntable in ≤120° arcs (the 360°-identity trap: quaternions
        # cannot encode full turns — key the waypoints).
        for t, yaw in [(0, 0), (1, 90), (2, 180), (3, 270), (4, 360)]:
            await mv("set_keyframe", {"id": base_id, "time": t,
                                      "rotation": [0, yaw, 0], "easing": "linear"})
        await mv("set_timeline", {"duration": 4})
        tl = await mv("get_timeline")
        frames = []
        # FIXED camera across motion frames — varying the azimuth per frame
        # confounds camera motion with object motion (gauntlet finding).
        for i, t in enumerate([0.0, 1.2, 2.6, 3.6]):
            await mv("seek_timeline", {"time": t})
            frames.append(await shot(f"6_motion_t{i}.png", azimuth=35))
        report.stage("animate", numbers_before=None,
                     decision=f"lid sweep {sweep}° (≤30° hollow-face budget) + "
                              "turntable keyed 0/90/180/270/360 (short-arc rule)",
                     action="set_keyframe ×8 + set_timeline {duration:4}",
                     numbers_after={"tracks": tl.get("tracks"),
                                    "duration": tl.get("duration")},
                     artifacts=frames, wall_s=time.monotonic() - t0)

        # ---- export + verify (reload REPLACES the scene — final step only) --
        t0 = time.monotonic()
        target = out / "final_animated.glb"
        exp = await session.export_glb_to_file(target, animation=True)
        if not exp.get("ok"):
            raise RuntimeError(f"export failed: {exp.get('error')}")
        r = await session.load_local(target)
        if not r.get("ok"):
            raise RuntimeError(f"reload failed: {r.get('error')}")
        state_anim = await mv("get_state")
        clips = len((state_anim.get("animation") or {}).get("clips") or [])
        new_tri = (await mv("describe_scene",
                            {"maxItems": 2, "checks": False}))["model"]["triangles"]
        report.stage("export", numbers_before=None,
                     decision="always runs; verification by RELOAD (destroys the "
                              "working scene — deliberately last)",
                     action=f"export_model {target.name} (animation:true) -> reload",
                     numbers_after={"bytes": exp["bytes"], "clipsAfterReload": clips,
                                    "trianglesAfterReload": new_tri},
                     artifacts=[str(target), await shot("7_reloaded.png")],
                     wall_s=time.monotonic() - t0)
    finally:
        await session.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prompt", nargs="?",
                    default="a wooden treasure chest with a curved lid")
    ap.add_argument("--bundle", help="existing abstract3d bundle dir (skips generation)")
    ap.add_argument("--out", help="output/proof dir "
                                  "(default ~/MeshVault_assets/proofs/t23d_pipeline/<run_id>)")
    ap.add_argument("--abstract3d-bin", default="abstract3d")
    ap.add_argument("--backend", default="abstract3d:triposr",
                    help="t23d backend (default TripoSR — the validated light lane; "
                         "heavy backends are never auto-launched)")
    ap.add_argument("--device", default="mps")
    ap.add_argument("--force-generate", action="store_true",
                    help="generate even when another abstract3d GPU job is running")
    # Decision gates — ratios and parameters, never asset-derived constants.
    ap.add_argument("--triangle-budget", type=int, default=150000,
                    help="optimize only above this count (web-delivery class default)")
    ap.add_argument("--density-ratio", type=float, default=2.0,
                    help="a cell qualifies at this multiple of the scene median density")
    ap.add_argument("--flat-deg", type=float, default=20.0,
                    help="…and only when its mean dihedral is below this (flat = "
                         "detail unjustified by curvature)")
    ap.add_argument("--simplify-ratio", type=float, default=0.4)
    ap.add_argument("--max-regions", type=int, default=3)
    ap.add_argument("--part-min-frac", type=float, default=0.05,
                    help="split by detected parts only when the 2nd part has at "
                         "least this fraction of triangles")
    # The documented judgment point (agents decide these from screenshots).
    ap.add_argument("--cut-axis", choices=["x", "y", "z"], default="y")
    ap.add_argument("--cut-at-frac", type=float, default=0.45,
                    help="plane-cut position as a fraction of the bbox extent. "
                         "A CLASS PRIOR, not a measurement — chest-lid seams sit "
                         "just below mid-height (the evidence run measured 43.3%% "
                         "via pick); agents should read the real seam off a "
                         "screenshot instead of trusting this default")
    ap.add_argument("--sweep-deg", type=float, default=25.0,
                    help="lid sweep amplitude (≤30°: split cut faces are hollow)")
    args = ap.parse_args()

    run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.out).expanduser() if args.out else (
        Path.home() / "MeshVault_assets" / "proofs" / "t23d_pipeline" / run_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = Report(out_dir)

    glb = generate(args, report)
    asyncio.run(run_pipeline(args, report, glb))
    report.write({"run_id": run_id, "prompt": args.prompt,
                  "bundle": str(glb.parent), "gates": {
                      "triangle_budget": args.triangle_budget,
                      "density_ratio": args.density_ratio,
                      "flat_deg": args.flat_deg,
                      "part_min_frac": args.part_min_frac,
                      "cut": f"{args.cut_axis}@{args.cut_at_frac}",
                      "sweep_deg": args.sweep_deg}})
    print(f"\nDone. Proof pack: {out_dir}\n  INDEX.md + verdicts.json + renders "
          "+ final_animated.glb")


if __name__ == "__main__":
    main()
