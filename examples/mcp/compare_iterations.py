"""Compare successive iterations of the same asset (e.g. a reconstruction pipeline).

This is the exact workflow used to analyze three face-reconstruction iterations: load
each model in turn, collect describe_scene + get_mesh_stats, and print a comparison
table with deltas. Connectivity QA alone is NOT a quality verdict — a topologically
perfect mesh can be visual garbage — so the numeric surface statistics (dihedral
roughness, edge distribution) carry the comparison.

Usage:
    python compare_iterations.py v1.glb v2.glb [v3.glb ...]
"""

import asyncio
import sys
from pathlib import Path

from _client import meshvault_session, result_json, viewer

COLUMNS = [
    ("triangles",      lambda d, t: f"{d['model']['triangles']:,}"),
    ("attr vertices",  lambda d, t: f"{d['model']['vertices']:,}"),
    ("textures",       lambda d, t: str(d["model"]["textureCount"])),
    ("dims (W×H×D)",   lambda d, t: "×".join(str(d["model"]["dimensions"][k]) for k in ("width", "height", "depth"))),
    ("QA issues",      lambda d, t: ", ".join(i["code"] for i in d["issues"]) or "none"),
    ("surface u²",     lambda d, t: str(t["surfaceArea"])),
    ("volume u³",      lambda d, t: str(t["volume"])),
    ("dihedral mean°", lambda d, t: str(t["dihedral"]["meanDeg"])),
    ("edge median",    lambda d, t: str(t["edgeLength"]["median"])),
    ("open edges",     lambda d, t: str(t["openEdges"])),
]


def unique_tags(paths: list[str]) -> list[str]:
    """Short display tags, guaranteed unique (dir name, then stem, then a suffix)."""
    tags = []
    for p in paths:
        base = Path(p).parent.name or Path(p).stem
        if base in tags:
            base = f"{base}/{Path(p).stem}"
        while base in tags:
            base += "'"
        tags.append(base)
    return tags


async def main(paths: list[str]):
    rows = {}
    tags_for = dict(zip(paths, unique_tags(paths)))
    async with meshvault_session() as s:
        for p in paths:
            tag = tags_for[p]
            r = result_json(await s.call_tool("load_model", {"source": p}))
            if not r.get("ok"):
                print(f"{tag}: LOAD FAILED — {r.get('error')}"); continue
            stats = (await viewer(s, "get_mesh_stats"))["result"]
            total = stats.get("total", {}) if not stats.get("skipped") else {}
            rows[tag] = (r["description"], total)
            print(f"loaded {tag}: {r['description']['summary'][:100]}")

    if len(rows) < 2:
        print("Need at least two successfully loaded models to compare."); return

    print()
    tags = list(rows)
    header = f"{'metric':<16}" + "".join(f"{t:>24}" for t in tags)
    print(header); print("-" * len(header))
    for label, fn in COLUMNS:
        cells = []
        for t in tags:
            desc, total = rows[t]
            try:
                cells.append(fn(desc, total))
            except (KeyError, TypeError):
                cells.append("—")
        # Truncate long cells (e.g. issue lists) so columns stay aligned.
        cells = [c if len(c) <= 23 else c[:20] + "…" for c in cells]
        print(f"{label:<16}" + "".join(f"{c:>24}" for c in cells))

    # Highlight geometry identity: identical triangle counts + dims often mean the
    # iteration changed only materials/textures (worth calling out explicitly).
    sigs = [(rows[t][0]["model"]["triangles"],
             tuple(rows[t][0]["model"]["dimensions"].values())) for t in tags]
    for i in range(1, len(sigs)):
        if sigs[i] == sigs[i - 1]:
            print(f"\nNOTE: {tags[i-1]} → {tags[i]}: identical triangle count and dimensions — "
                  f"geometry likely unchanged (texture/material-only iteration).")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        root = Path(__file__).resolve().parents[2] / "frontend/testmodels"
        args = [str(root / "helmet.glb"), str(root / "helmet_draco.glb")]
    asyncio.run(main(args))
