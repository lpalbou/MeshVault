# Acknowledgments

MeshVault is built on the work of excellent open-source projects. We gratefully acknowledge the following libraries and their contributors.

---

## Backend (Python)

| Library | License | Description |
|---------|---------|-------------|
| [FastAPI](https://github.com/tiangolo/fastapi) | MIT | High-performance async web framework for the REST API |
| [Uvicorn](https://github.com/encode/uvicorn) | BSD-3-Clause | ASGI server powering the backend |
| [Pydantic](https://github.com/pydantic/pydantic) | MIT | Data validation and settings management (via FastAPI) |
| [Starlette](https://github.com/encode/starlette) | BSD-3-Clause | ASGI toolkit underlying FastAPI |
| [rarfile](https://github.com/markokr/rarfile) | ISC | RAR archive header parsing and extraction |
| [aiofiles](https://github.com/Tinche/aiofiles) | Apache-2.0 | Async file I/O support |
| [trimesh](https://github.com/mikedh/trimesh) | MIT | 3D mesh processing utilities |
| [python-multipart](https://github.com/Kludex/python-multipart) | Apache-2.0 | Multipart form data parsing |

## Frontend (JavaScript)

| Library | License | Description |
|---------|---------|-------------|
| [Three.js](https://github.com/mrdoob/three.js) (r170) | MIT | 3D rendering engine — scene, lights, materials, postprocessing |
| [Three.js OBJLoader](https://github.com/mrdoob/three.js) | MIT | Wavefront OBJ file loader |
| [Three.js MTLLoader](https://github.com/mrdoob/three.js) | MIT | OBJ material file loader |
| [Three.js FBXLoader](https://github.com/mrdoob/three.js) | MIT | Autodesk FBX file loader (version 7000+) |
| [Three.js OrbitControls](https://github.com/mrdoob/three.js) | MIT | Mouse-based camera orbit, zoom, and pan |
| [Three.js EffectComposer](https://github.com/mrdoob/three.js) | MIT | Postprocessing pipeline (SSAO, output pass) |

## Development & Testing

| Library | License | Description |
|---------|---------|-------------|
| [pytest](https://github.com/pytest-dev/pytest) | MIT | Python testing framework |
| [HTTPX](https://github.com/encode/httpx) | BSD-3-Clause | HTTP client for API testing |
| [Poetry](https://github.com/python-poetry/poetry) | MIT | Python dependency management and packaging |

## System Tools (Optional)

The following system tools are optionally used for RAR archive extraction. The application auto-detects availability:

| Tool | License | Purpose |
|------|---------|---------|
| [bsdtar / libarchive](https://github.com/libarchive/libarchive) | BSD-2-Clause | Multi-format archive extraction |
| [unrar](https://www.rarlab.com/) | Freeware (non-commercial) | RAR archive extraction |
| [p7zip / 7-Zip](https://github.com/p7zip-project/p7zip) | LGPL-2.1 | Multi-format archive extraction |
| [unar / The Unarchiver](https://theunarchiver.com/) | LGPL-2.1 | Multi-format archive extraction |

---

## Python Standard Library

This project also relies on the following Python standard library modules, which require no additional installation:

- `zipfile` — ZIP archive handling
- `zlib` — Data decompression (used in FBX binary parser)
- `struct` — Binary data packing/unpacking (used in FBX binary parser)
- `subprocess` — CLI tool invocation for RAR extraction fallback
- `mimetypes` — Content-type detection for file serving
- `tempfile` — Temporary directory management
- `pathlib` — Filesystem path handling

---

Thank you to all maintainers and contributors of these projects.
