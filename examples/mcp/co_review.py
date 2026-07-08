"""Co-review: inspect a model headless, then push it into the human's running app.

The shared-session workflow (backlog 043): an agent critiques a model in its own
headless viewer, and when it finds something worth a human's eyes it calls
`open_in_app` — every open MeshVault tab loads the SAME file with the agent's EXACT
camera pose. No screenshots to pass around, no paths to copy into the sidebar.

Run:
    1. Start the app in another terminal:  meshvault
       (it publishes ~/.meshvault/app_session.json for discovery)
    2. Open http://localhost:8420 in a browser.
    3. python co_review.py [model_path]

If no tab is connected, the script prints the returned deep link instead — opening
it reproduces the same model (the app honors ?path= URL parameters).
"""

import asyncio
import sys
from pathlib import Path

from _client import meshvault_session, result_json, viewer

DEFAULT_MODEL = str(
    Path(__file__).resolve().parents[2] / "frontend" / "testmodels" / "helmet.glb")


async def main():
    model = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL

    async with meshvault_session() as s:
        # 1. Load and understand the model headless (no vision needed).
        load = result_json(await s.call_tool("load_model", {"source": model}))
        if not load.get("ok"):
            print("load failed:", load.get("error"))
            return
        summary = load.get("description", {}).get("summary", "(no summary)")
        print("loaded:", summary)

        # 2. Frame what deserves human eyes — here, the semantic front.
        best = await viewer(s, "find_best_view")
        print("best view:", {k: best.get("result", {}).get(k)
                             for k in ("azimuth", "elevation")})

        # 3. Push model + camera into the running app.
        push = result_json(await s.call_tool("open_in_app", {}))
        if not push.get("ok"):
            print("open_in_app failed:", push.get("error"))
            return
        if push.get("clients", 0) > 0:
            print(f"pushed to {push['clients']} app tab(s) — the human now sees "
                  f"exactly this view (camera_sent={push['camera_sent']}).")
        else:
            print("app is running but no tab is connected; share this deep link:")
            print(" ", push.get("deep_link"))


if __name__ == "__main__":
    asyncio.run(main())
