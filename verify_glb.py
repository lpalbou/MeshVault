#!/usr/bin/env python3
"""
Verify a GLB exported from MeshVault against the original archive textures.

Usage:
    python3 verify_glb.py <glb_path> <archive_path> <tga_inner_path>

Example:
    python3 verify_glb.py untracked/aaa.glb untracked/uploads_files_775776_asteroid_pack_2.zip \
        asteroid_pack_2/projectFiles/sourceimages/Asteroid_1/asteroid_1_baseColor.tga
"""
import struct, json, io, sys, zipfile
import numpy as np
from PIL import Image

if len(sys.argv) < 4:
    print(__doc__)
    sys.exit(1)

glb_path = sys.argv[1]
zip_path = sys.argv[2]
tga_inner = sys.argv[3]

# Load original TGA
with zipfile.ZipFile(zip_path) as zf:
    tga_data = zf.read(tga_inner)
tga_pil = Image.open(io.BytesIO(tga_data)).convert('RGB')
tga_arr = np.array(tga_pil)

# Parse GLB
with open(glb_path, 'rb') as f:
    f.read(12)
    jlen = struct.unpack('<I', f.read(4))[0]; f.read(4)
    doc = json.loads(f.read(jlen))
    blen = struct.unpack('<I', f.read(4))[0]; f.read(4)
    b = f.read(blen)

bvs = doc['bufferViews']
img_meta = doc['images'][0]
bv = bvs[img_meta['bufferView']]
off = bv.get('byteOffset', 0)
data = b[off:off+bv['byteLength']]
glb_pil = Image.open(io.BytesIO(data)).convert('RGB')
glb_arr = np.array(glb_pil)

# Compare
diff_direct = np.abs(tga_arr.astype(float) - glb_arr.astype(float)).mean()
diff_flipped = np.abs(tga_arr[::-1].astype(float) - glb_arr.astype(float)).mean()

print(f'Direct diff:  {diff_direct:.4f}')
print(f'Flipped diff: {diff_flipped:.4f}')
print()

if diff_direct < 2.0:
    print('✅ PASS — Texture orientation matches original')
    # Check GLB structure
    print(f'  Extensions: {doc.get("extensionsUsed", [])}')
    attrs = sorted(doc['meshes'][0]['primitives'][0]['attributes'].keys())
    print(f'  Attributes: {attrs}')
    sys.exit(0)
elif diff_flipped < 2.0:
    print('❌ FAIL — Texture is VERTICALLY FLIPPED')
    sys.exit(1)
else:
    print('❌ FAIL — Texture does not match at all')
    print(f'  GLB size: {glb_pil.size}, TGA size: {tga_pil.size}')
    sys.exit(1)
