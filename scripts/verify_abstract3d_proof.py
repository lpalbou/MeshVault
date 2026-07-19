"""Independent verification of abstract3d's proof artifacts (commons #3187).

Loads each GLB in meshvault-mcp, captures a 512x512 neutral-preset screenshot,
and extracts quantified facts: inventory, bounds, mesh stats, surface area,
geometry-QA flags. Writes PNGs + report.json to /tmp/meshvault_verify_20260719.
"""
import asyncio
import base64
import json
import os

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = "/Users/albou/tmp/abstractframework/abstract3d/out/abstractcore-proof-20260719"
OUT = "/tmp/meshvault_verify_20260719"
FILES = ["generated.glb", "modified.glb", "scene.glb"]


def text_of(res):
    for c in res.content:
        if getattr(c, "type", "") == "text":
            return c.text
    return ""


def json_of(res):
    return json.loads(text_of(res))


async def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    server = StdioServerParameters(
        command=os.path.join(REPO, ".venv", "bin", "meshvault-mcp"),
        env={**os.environ, "MESHVAULT_SESSION_LABEL": "verify: abstract3d proof artifacts"},
    )
    report = {}
    async with stdio_client(server) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            for name in FILES:
                path = os.path.join(ART, name)
                await s.call_tool("load_model", {"source": path})

                desc = json_of(await s.call_tool("describe_scene", {}))
                bounds = json_of(await s.call_tool(
                    "viewer_execute", {"action": "get_bounds", "params": {}}))
                stats = json_of(await s.call_tool(
                    "viewer_execute", {"action": "get_mesh_stats", "params": {}}))
                # sample_points reports total surface area (rotation-invariant scale check)
                area = json_of(await s.call_tool(
                    "viewer_execute", {"action": "sample_points", "params": {"count": 16}}))

                shot = await s.call_tool("screenshot", {
                    "width": 512, "height": 512, "preset": "neutral", "best_view": True,
                })
                for c in shot.content:
                    if getattr(c, "type", "") == "image":
                        with open(os.path.join(OUT, name + ".png"), "wb") as f:
                            f.write(base64.b64decode(c.data))

                report[name] = {
                    "describe": desc.get("result", desc),
                    "bounds": bounds.get("result", bounds),
                    "mesh_stats": stats.get("result", stats),
                    "surface_area": (area.get("result") or {}).get("surfaceArea"),
                }
                print(f"--- {name} verified")

    with open(os.path.join(OUT, "report.json"), "w") as f:
        json.dump(report, f, indent=2)

    # Scale checks: rotation about Y preserves the Y extent (exact 1.5 expected);
    # surface area is fully rotation-invariant (1.5^2 = 2.25 expected).
    g = report["generated.glb"]; m = report["modified.glb"]
    gy = g["bounds"]["size"][1]; my = m["bounds"]["size"][1]
    print(f"Y-extent: generated={gy:.4f} modified={my:.4f} ratio={my/gy:.4f} (expect 1.5)")
    if g["surface_area"] and m["surface_area"]:
        print(f"surface area ratio={m['surface_area']/g['surface_area']:.4f} (expect 2.25)")
    print("report.json + 3 PNGs in", OUT)


if __name__ == "__main__":
    asyncio.run(main())
