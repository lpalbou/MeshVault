"""Smoke-test the meshvault-mcp endpoint: spawn, list tools, run a tiny edit loop.

Run: .venv/bin/python scripts/mcp_smoke.py
Exit 0 = endpoint functional; nonzero = broken (message names the failure).
"""
import asyncio
import json
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

VENV_BIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".venv", "bin")


async def main() -> int:
    server = StdioServerParameters(
        command=os.path.join(VENV_BIN, "meshvault-mcp"),
        env={**os.environ, "MESHVAULT_SESSION_LABEL": "smoke: agora boot check"},
    )
    async with stdio_client(server) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()

            tools = await s.list_tools()
            names = sorted(t.name for t in tools.tools)
            print(f"TOOLS ({len(names)}): {', '.join(names)}")

            # Create → sculpt → paint → verify: the minimal editing loop.
            res = await s.call_tool("viewer_execute", {
                "action": "add_primitive",
                "params": {"kind": "sphere", "name": "smoke_sphere"},
            })
            print("add_primitive:", res.content[0].text[:200])

            res = await s.call_tool("viewer_execute", {"action": "get_bounds", "params": {}})
            print("get_bounds:", res.content[0].text[:200])

            res = await s.call_tool("viewer_execute", {
                "action": "sculpt",
                "params": {"tool": "draw", "center": [0, 0.5, 0], "radius": 0.3, "strength": 0.5},
            })
            print("sculpt:", res.content[0].text[:200])

            res = await s.call_tool("viewer_execute", {
                "action": "fill_paint",
                "params": {"color": "#8899aa", "texture_size": "low"},
            })
            print("fill_paint:", res.content[0].text[:200])

            res = await s.call_tool("viewer_execute", {
                "action": "paint",
                "params": {"center": [0, 0.5, 0], "radius": 0.2, "color": "#ff4400"},
            })
            print("paint:", res.content[0].text[:200])

            # Full command list -> file, to cross-check the skill's claims.
            res = await s.call_tool("list_viewer_commands", {})
            doc = res.content[0].text
            out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "untracked_commands_dump.txt")
            with open(out, "w") as f:
                f.write(doc)
            # Command docs are markdown-ish; count action headings conservatively.
            print(f"list_viewer_commands: {len(doc)} chars -> untracked_commands_dump.txt")

            res = await s.call_tool("describe_scene", {})
            print("describe_scene:", res.content[0].text[:300])

    print("SMOKE_OK")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
