"""Minimal shared helper for the MeshVault MCP examples.

Connects to the MCP server over stdio and exposes typed helpers so the examples stay
focused on the workflow, not the plumbing. Uses `meshvault-mcp` from PATH by default;
set MESHVAULT_MCP_COMMAND to override (e.g. "python -m backend.mcp_server").
"""

from __future__ import annotations

import base64
import json
import os
import shlex
from contextlib import asynccontextmanager

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@asynccontextmanager
async def meshvault_session():
    """Yield an initialized MCP ClientSession connected to a fresh meshvault-mcp."""
    cmd = os.environ.get("MESHVAULT_MCP_COMMAND", "meshvault-mcp")
    parts = shlex.split(cmd)
    params = StdioServerParameters(
        command=parts[0], args=parts[1:], cwd=os.environ.get("MESHVAULT_MCP_CWD"))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


def result_json(result):
    """Parse the first text content of a tool result as JSON."""
    for c in result.content:
        if getattr(c, "type", None) == "text":
            return json.loads(c.text)
    return None


def result_images(result):
    """Return the raw PNG bytes of every image content in a tool result."""
    return [base64.b64decode(c.data)
            for c in result.content if getattr(c, "type", None) == "image"]


async def viewer(session, action, **params):
    """Shorthand for the viewer_execute passthrough; returns the parsed {ok,...} dict."""
    r = await session.call_tool("viewer_execute", {"action": action, "params": params})
    return result_json(r)
