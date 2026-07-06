"""Compare one reference model against N candidates GEOMETRICALLY (shape registration).

Unlike compare_iterations.py (which tabulates per-model stats), this uses the
compare_models tool: it registers each candidate onto the reference and reports how the
shapes actually relate — identical / near-identical / modified / different — with the
recovered scale and rotation, robust to pose and unit differences.

Usage:
    python compare_shapes.py reference.glb candidate1.glb [candidate2.glb ...]
"""

import asyncio
import sys
from pathlib import Path

from _client import meshvault_session, result_json


async def main(reference: str, candidates: list[str]):
    async with meshvault_session() as s:
        r = result_json(await s.call_tool("compare_models", {
            "reference": reference, "candidates": candidates}))
        if not r.get("ok"):
            print(f"compare failed: {r.get('error')}"); return

        ref = r["reference"]
        print(f"reference: {Path(reference).name} — {ref['triangles']:,} tris\n")

        for c in r["comparisons"]:
            name = Path(c["source"]).name if "/" in c["source"] else c["source"]
            if not c.get("ok"):
                print(f"  {name}: ERROR — {c['error']}"); continue
            d, a = c["distances"], c["alignment"]
            flags = []
            if c.get("borderline"):
                flags.append("BORDERLINE")
            if c.get("warnings"):
                flags.append(f"{len(c['warnings'])} warning(s)")
            flag_str = f"  [{', '.join(flags)}]" if flags else ""
            print(f"  {name}: {c['classification'].upper()}{flag_str}")
            print(f"      chamfer(norm) {d['chamferMeanNormalized']}  "
                  f"p95 {d['chamferP95Normalized']}  asymmetry {d['asymmetry']}")
            if a:
                print(f"      scale ×{a['scaleRatio']}  rotation {a['rotationDeg']}°")
            st = c["structural"]["triangles"]
            print(f"      triangles {st['reference']:,} → {st['candidate']:,} "
                  f"({st['deltaPct']:+}%)")
            for w in c.get("warnings", []):
                print(f"      ! {w}")
            print()

        print("Most → least similar to the reference:")
        for i, rk in enumerate(r["rankingBySimilarity"], 1):
            name = Path(rk["source"]).name if "/" in rk["source"] else rk["source"]
            print(f"  {i}. {name} — {rk['classification']} ({rk['chamferMeanNormalized']})")


if __name__ == "__main__":
    if len(sys.argv) >= 3:
        asyncio.run(main(sys.argv[1], sys.argv[2:]))
    else:
        root = Path(__file__).resolve().parents[2] / "frontend/testmodels"
        asyncio.run(main(str(root / "helmet.glb"),
                         [str(root / "helmet_draco.glb"), str(root / "ktx.glb")]))
