"""Explore a model part by part: describe → focus each mesh → screenshot.

Shows the part-level exploration loop: describe_scene gives every mesh a stable id and
world placement; `focus {id}` frames it (rescaling clip planes so tiny parts stay
visible); a screenshot per part gives the evidence. Also demonstrates focusing a defect
location reported by get_mesh_stats.

Usage:
    python explore_parts.py /absolute/path/model.glb [output_dir]
"""

import asyncio
import sys
from pathlib import Path

from _client import meshvault_session, result_json, result_images, viewer


async def main(source: str, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    async with meshvault_session() as s:
        r = result_json(await s.call_tool("load_model", {"source": source}))
        if not r.get("ok"):
            print(f"Load failed: {r.get('error')}"); return
        parts = r["description"]["meshes"]["items"]
        print(f"{r['description']['model']['name']}: {len(parts)} part(s) shown "
              f"(+{r['description']['meshes']['omitted']} omitted)")

        # Visit each part: focus (keeps view direction, adapts near/far) + capture.
        for part in parts:
            f = await viewer(s, "focus", id=part["id"], fill=0.8)
            if not f.get("ok"):
                print(f"  part {part['id']} ({part['name']}): focus failed — {f.get('error')}")
                continue
            shot = await s.call_tool("screenshot", {"width": 512, "height": 512})
            path = out_dir / f"part_{part['id']}_{part['name'].replace('/', '_')[:32]}.png"
            path.write_bytes(result_images(shot)[0])
            print(f"  part {part['id']} ({part['name']}): {part['triangles']:,} tris "
                  f"at {f['result']['center']} → {path.name}")

        # Bonus: if the QA found defects, go LOOK at one.
        stats = (await viewer(s, "get_mesh_stats"))["result"]
        if not stats.get("skipped"):
            for kind, pts in stats["total"]["issuePoints"].items():
                if pts:
                    await viewer(s, "focus", point=pts[0], radius=0.05)
                    shot = await s.call_tool("screenshot", {"width": 512, "height": 512})
                    (out_dir / f"defect_{kind}.png").write_bytes(result_images(shot)[0])
                    print(f"  defect close-up: {kind} at {pts[0]} → defect_{kind}.png")
                    break

        await viewer(s, "reset_camera")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else str(
        Path(__file__).resolve().parents[2] / "frontend/testmodels/machine.glb")
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("./parts_out")
    asyncio.run(main(src, out))
