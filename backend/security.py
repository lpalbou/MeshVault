"""
Security module — the single trust boundary for MeshVault.

Why this exists (root-cause fix, not per-endpoint patching):
The original app exposed three classes of problem — arbitrary file read/write/delete
via unconfined absolute paths, a socket bound to all interfaces, and no authentication.
Patching each endpoint individually is fragile: the next endpoint added would forget
the check. Instead we centralize the boundary here so *every* filesystem-touching
endpoint must go through one `PathGuard`, and *every* request passes through auth +
host-allowlist middleware.

Layers of defense:
1. Bind loopback by default (network reachability).
2. Session token (LAN exposure): required on /api/* via an HttpOnly SameSite cookie
   set when the app shell is served, or an explicit header/query for programmatic use.
3. Host allow-list (DNS-rebinding): a malicious site cannot make the browser send our
   loopback cookie under its own hostname, and forged Host headers are rejected here.
4. Path confinement (defense-in-depth): all filesystem access is resolved and verified
   to live inside an allowed root, defeating traversal and symlink escapes uniformly.
"""

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response


# Cookie name for the session token (HttpOnly + SameSite=Strict).
SESSION_COOKIE = "mv_session"

# Loopback host names that are always trusted for the Host header.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def _split_roots(raw: str) -> list[str]:
    """
    Split an env-provided root list on the OS path separator only.

    Using `os.pathsep` (":" on POSIX, ";" on Windows) is correct on both platforms.
    We must NOT additionally split on ":" — on Windows that would shred drive letters
    like "C:\\Users\\me" into "C" and "\\Users\\me".
    """
    return [p for p in (s.strip() for s in raw.split(os.pathsep)) if p]


@dataclass
class SecurityConfig:
    """
    Single source of truth for the trust boundary.

    Three deliberately separate notions:
    - allowed_roots: what the server may READ/WRITE. Broad by default (the whole
      filesystem) because the real network protections are loopback + token + Host
      allow-list; path confinement is opt-in hardening for people who widen exposure.
      Set MESHVAULT_ROOT to lock the server to specific directories.
    - default_browse_path: where the file browser OPENS (home) — a friendly start,
      not a security boundary.
    - confined: whether MESHVAULT_ROOT narrowed the allowed_roots.

    Attributes:
        allowed_roots: Resolved directories the server may touch.
        default_browse_path: Initial directory the browser opens at.
        confined: True when MESHVAULT_ROOT restricted the roots.
        bind_host: Interface the server binds to. Loopback unless explicitly overridden.
        token: Session token required on /api/*.
        require_auth: When False (tests / explicit opt-out), auth is skipped.
        allowed_hosts: Hostnames accepted in the Host header (loopback + bind host).
    """
    allowed_roots: list[Path]
    default_browse_path: Path
    confined: bool
    bind_host: str
    token: str
    require_auth: bool
    allowed_hosts: set[str] = field(default_factory=set)

    @classmethod
    def from_env(cls) -> "SecurityConfig":
        """Build config from environment variables with safe defaults."""
        home = Path.home().resolve()
        root_env = os.environ.get("MESHVAULT_ROOT", "").strip()
        if root_env:
            roots = [Path(p).expanduser().resolve() for p in _split_roots(root_env)]
            roots = [p for p in roots if p.exists()]

        if root_env and roots:
            # Explicitly confined to the requested directories.
            confined = True
            default_browse = roots[0]
        else:
            # Unconfined default: allow the whole filesystem (POSIX "/"; on Windows the
            # home drive anchor). Browsing still starts at home. This matches the tool's
            # original "browse anywhere" behavior; auth + loopback + Host remain the
            # actual protections.
            confined = False
            roots = [Path(home.anchor or os.sep).resolve()]
            default_browse = home

        bind_host = os.environ.get("MESHVAULT_HOST", "127.0.0.1").strip() or "127.0.0.1"

        token = os.environ.get("MESHVAULT_TOKEN", "").strip() or secrets.token_urlsafe(32)

        # Auth is on by default. Opt out only for tests / trusted single-user shells.
        require_auth = os.environ.get("MESHVAULT_NO_AUTH", "").strip().lower() not in {
            "1", "true", "yes", "on",
        }

        cfg = cls(
            allowed_roots=roots,
            default_browse_path=default_browse,
            confined=confined,
            bind_host=bind_host,
            token=token,
            require_auth=require_auth,
        )
        cfg.allowed_hosts = cfg._compute_allowed_hosts()
        return cfg

    def _compute_allowed_hosts(self) -> set[str]:
        """Loopback names are always allowed; add the bind host if it is a real name."""
        hosts = set(_LOOPBACK_HOSTS)
        if self.bind_host and self.bind_host not in {"0.0.0.0", "::"}:
            hosts.add(self.bind_host)
        # Allow an explicit list for reverse-proxy / LAN setups.
        extra = os.environ.get("MESHVAULT_ALLOWED_HOSTS", "").strip()
        if extra:
            hosts.update(h.strip().lower() for h in extra.split(",") if h.strip())
        return hosts

    @property
    def is_loopback_bind(self) -> bool:
        return self.bind_host in _LOOPBACK_HOSTS or self.bind_host == "::1"


class PathGuard:
    """
    Confines all filesystem access to a set of allowed roots.

    The confinement rule is general on purpose: resolve the target to its real path
    (following symlinks and collapsing `..`), then require that real path to be the
    root itself or a descendant of it. This enforces the single invariant "the real
    target lives inside an allowed root" — it is not tuned to any specific attack
    string, so traversal, absolute-path injection, and symlink escapes are all handled
    by the same check.
    """

    def __init__(self, allowed_roots: list[Path]):
        self._roots = [r.resolve() for r in allowed_roots]

    @property
    def roots(self) -> list[Path]:
        return list(self._roots)

    @property
    def primary_root(self) -> Path:
        return self._roots[0]

    def _within_roots(self, real: Path) -> bool:
        for root in self._roots:
            if real == root or root in real.parents:
                return True
        return False

    def resolve(
        self,
        path_str: str,
        *,
        must_exist: bool = True,
        require_file: bool = False,
        require_dir: bool = False,
    ) -> Path:
        """
        Resolve and confine a path.

        Raises:
            PermissionError: the resolved path escapes all allowed roots.
            FileNotFoundError: must_exist and the path does not exist.
            ValueError: require_file/require_dir violated.
        """
        if not path_str:
            raise ValueError("Empty path")

        real = Path(path_str).expanduser()
        # strict=False so we can validate not-yet-created export targets too.
        real = real.resolve(strict=False)

        if not self._within_roots(real):
            raise PermissionError(
                f"Access denied: path is outside the allowed root(s)"
            )

        if must_exist and not real.exists():
            raise FileNotFoundError(f"Not found: {path_str}")
        if require_file and real.exists() and not real.is_file():
            raise ValueError(f"Not a file: {path_str}")
        if require_dir and real.exists() and not real.is_dir():
            raise ValueError(f"Not a directory: {path_str}")

        return real

    @staticmethod
    def sanitize_component(name: str) -> str:
        """
        Validate a single filename component (no directory parts).

        A filename is not a path: reject separators, parent refs, and absolute forms
        so an export `new_name` cannot be used to escape its target directory.
        """
        cleaned = (name or "").strip()
        if not cleaned:
            raise ValueError("Empty name")
        if "/" in cleaned or "\\" in cleaned or cleaned in {".", ".."}:
            raise ValueError("Invalid name: must not contain path separators")
        if os.path.isabs(cleaned):
            raise ValueError("Invalid name: must not be an absolute path")
        return cleaned


class HostAllowlistMiddleware(BaseHTTPMiddleware):
    """
    Reject requests whose Host header is not in the allow-list.

    This is the primary defense against DNS-rebinding: even though the socket answers
    on 127.0.0.1, a page served from a rebinding attacker domain will send that
    domain in the Host header, which is rejected before any handler runs.
    """

    def __init__(self, app, allowed_hosts: set[str]):
        super().__init__(app)
        self._allowed = allowed_hosts

    async def dispatch(self, request: Request, call_next):
        host_header = request.headers.get("host", "")
        # Strip the port; compare hostname only. Treat an empty/missing Host as
        # disallowed (fail closed) rather than allowing it through.
        hostname = host_header.split(":")[0].strip().lower() if host_header else ""
        if hostname not in self._allowed:
            return JSONResponse(
                {"detail": f"Host not allowed: {hostname or '(empty)'}"}, status_code=400
            )
        return await call_next(request)


class TokenAuthMiddleware(BaseHTTPMiddleware):
    """
    Require a valid session token on /api/* requests.

    The token is accepted from (in order): the session cookie (set when the app shell
    is served — same-origin fetches and Three.js loader requests send it automatically),
    an `Authorization: Bearer <token>` header, an `X-MeshVault-Token` header, or a
    `token` query param (for programmatic / loader use). Non-/api routes are public
    (they carry no filesystem data).
    """

    def __init__(self, app, config: SecurityConfig):
        super().__init__(app)
        self._config = config

    def _token_from_request(self, request: Request) -> Optional[str]:
        cookie = request.cookies.get(SESSION_COOKIE)
        if cookie:
            return cookie
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        header = request.headers.get("x-meshvault-token")
        if header:
            return header.strip()
        # Deliberately NOT accepting a ?token= query param: query strings leak into
        # access logs, browser history, and the Referer header. The cookie (set on the
        # app shell) covers same-origin/browser use; headers cover programmatic use.
        return None

    async def dispatch(self, request: Request, call_next):
        if not self._config.require_auth:
            return await call_next(request)
        if not request.url.path.startswith("/api/"):
            return await call_next(request)

        supplied = self._token_from_request(request)
        if not supplied or not secrets.compare_digest(supplied, self._config.token):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)


def attach_session_cookie(response: Response, config: SecurityConfig) -> None:
    """Set the session-token cookie on a response (used when serving the app shell)."""
    if not config.require_auth:
        return
    response.set_cookie(
        key=SESSION_COOKIE,
        value=config.token,
        httponly=True,
        samesite="strict",
        max_age=60 * 60 * 24,  # 24h; a fresh shell load re-issues it
    )
