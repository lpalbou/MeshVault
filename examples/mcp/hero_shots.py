"""Produce a hero-shot set of a model in ONE screenshot call per batch.

Demonstrates the multi-view `screenshot` tool: presets and explicit "azimuth,elevation"
angles in a single call (much cheaper than orbit+screenshot per angle), plus the
`best_view` semantic-front shot with its returned metadata.

Usage:
    python hero_shots.py /absolute/path/model.glb [output_dir]
"""

import asyncio
import sys
from pathlib import Path

from _client import meshvault_session, result_json, result_images


async def main(source: str, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    async with meshvault_session() as s:
        r = result_json(await s.call_tool("load_model", {"source": source}))
        if not r.get("ok"):
            print(f"Load failed: {r.get('error')}"); return
        print(r["description"]["summary"][:120])

        # The semantic front first — metadata tells us which angle won.
        r = await s.call_tool("screenshot", {"width": 1024, "height": 1024, "best_view": True})
        meta = result_json(r)
        (out_dir / "hero_front.png").write_bytes(result_images(r)[0])
        print(f"hero_front.png — best view: {meta.get('best_view')}")

        # Then a full walkaround in one call: 4 presets + 2 custom angles.
        views = ["front", "left", "right", "back", "45,30", "135,-10"]
        r = await s.call_tool("screenshot", {
            "width": 1024, "height": 1024, "views": views, "hide_ground": True})
        images = result_images(r)
        for spec, png in zip(views, images):
            name = f"view_{spec.replace(',', '_')}.png"
            (out_dir / name).write_bytes(png)
            print(f"{name} ({len(png)//1024} KB)")


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else str(
        Path(__file__).resolve().parents[2] / "frontend/testmodels/helmet.glb")
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("./hero_out")
    asyncio.run(main(src, out))
