"""Inspect one model end-to-end and produce a text report + evidence images.

The canonical agent workflow: load → describe (structure, no vision) → mesh statistics
(numeric quality) → hero shot from the semantic front + a clay view (form reading).

Usage:
    python inspect_model.py /absolute/path/or/url/model.glb [output_dir]
"""

import asyncio
import json
import sys
from pathlib import Path

from _client import meshvault_session, result_json, result_images, viewer


async def main(source: str, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    async with meshvault_session() as s:
        # 1. Load — the result already embeds a full scene description.
        r = result_json(await s.call_tool("load_model", {"source": source}))
        if not r.get("ok"):
            print(f"Load failed: {r.get('error')}"); return
        desc = r["description"]
        print(desc["summary"])
        print()

        # 2. Structure: parts, materials, declared issues.
        for m in desc["meshes"]["items"]:
            print(f"  mesh {m['id']}: {m['name']} — {m['triangles']:,} tris at {m['center']} size {m['size']}")
        for mat in desc["materials"]["items"]:
            tex = mat.get("textures") or {}
            texs = ", ".join(f"{k} {v['width']}x{v['height']}" for k, v in tex.items()) or "untextured"
            flag = " [viewer-adjusted: authored " + json.dumps(mat["authored"]) + "]" if mat.get("modifiedByViewer") else ""
            print(f"  material {mat['name']}: {mat['type']}, metal {mat['metalness']}, rough {mat['roughness']}, {texs}{flag}")
        for issue in desc["issues"]:
            print(f"  issue [{issue['severity']}] {issue['code']}: {issue['message'][:80]}")
        print()

        # 3. Numeric quality (comparable across iterations of the same asset).
        stats = (await viewer(s, "get_mesh_stats"))["result"]
        if not stats.get("skipped"):
            t = stats["total"]
            print(f"  surface {t['surfaceArea']} u², volume {t['volume']} u³, "
                  f"dihedral roughness mean {t['dihedral']['meanDeg']}° (p95 {t['dihedral']['p95Deg']}°), "
                  f"slivers {t['sliverPct']}%, open edges {t['openEdges']}")
            for kind, pts in t["issuePoints"].items():
                if pts:
                    print(f"  {kind} sample locations (use focus {{point}}): {pts[:3]}")
        print()

        # 4. Evidence: hero shot from the semantic front, then a clay view.
        r = await s.call_tool("screenshot", {"width": 768, "height": 768, "best_view": True})
        meta = result_json(r)
        (out_dir / "hero.png").write_bytes(result_images(r)[0])
        print(f"  hero.png captured from best view {meta.get('best_view')}")

        await viewer(s, "set_render_mode", mode="solid")
        r = await s.call_tool("screenshot", {"width": 768, "height": 768})
        (out_dir / "clay.png").write_bytes(result_images(r)[0])
        print(f"  clay.png captured (solid mode — pure form, no texture)")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else str(
        Path(__file__).resolve().parents[2] / "frontend/testmodels/helmet.glb")
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("./inspect_out")
    asyncio.run(main(src, out))
