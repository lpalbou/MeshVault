#!/usr/bin/env python3
"""Compare GLB export texture and screenshots."""
import struct, json, io, sys, zipfile
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
GLB = str(ROOT / 'untracked' / '_test_export.glb')
ZIP = str(ROOT / 'untracked' / 'uploads_files_775776_asteroid_pack_2.zip')
TGA = 'asteroid_pack_2/projectFiles/sourceimages/Asteroid_1/asteroid_1_baseColor.tga'
SHOT_O = str(ROOT / 'untracked' / '_shot_original.png')
SHOT_G = str(ROOT / 'untracked' / '_shot_glb.png')

print('=== TEXTURE ORIENTATION ===')
with zipfile.ZipFile(ZIP) as zf:
    tga_data = zf.read(TGA)
tga_arr = np.array(Image.open(io.BytesIO(tga_data)).convert('RGB'))

with open(GLB, 'rb') as f:
    f.read(12)
    jlen = struct.unpack('<I', f.read(4))[0]; f.read(4)
    doc = json.loads(f.read(jlen))
    blen = struct.unpack('<I', f.read(4))[0]; f.read(4)
    b = f.read(blen)

bvs = doc['bufferViews']
img0 = doc['images'][0]
bv = bvs[img0['bufferView']]
data = b[bv.get('byteOffset',0):bv.get('byteOffset',0)+bv['byteLength']]
glb_arr = np.array(Image.open(io.BytesIO(data)).convert('RGB'))

diff_d = np.abs(tga_arr.astype(float) - glb_arr.astype(float)).mean()
diff_f = np.abs(tga_arr[::-1].astype(float) - glb_arr.astype(float)).mean()
print(f'  Direct diff:  {diff_d:.2f}')
print(f'  Flipped diff: {diff_f:.2f}')
tex_ok = diff_d < 2.0
print(f'  Texture: {"PASS" if tex_ok else "FAIL (FLIPPED)" if diff_f < 2 else "FAIL"}')

print()
print('=== SCREENSHOT COMPARISON ===')
orig = np.array(Image.open(SHOT_O).convert('RGB'))
glb_s = np.array(Image.open(SHOT_G).convert('RGB'))
print(f'  Original: {orig.shape[1]}x{orig.shape[0]}')
print(f'  GLB:      {glb_s.shape[1]}x{glb_s.shape[0]}')

render_ok = False
if orig.shape == glb_s.shape:
    pixel_diff = np.abs(orig.astype(float) - glb_s.astype(float)).mean()
    diff_map = np.abs(orig.astype(float) - glb_s.astype(float)).max(axis=2)
    pct_big = (diff_map > 50).mean() * 100
    max_diff = diff_map.max()
    nonzero = int((diff_map > 0).sum())
    print(f'  Mean pixel diff: {pixel_diff:.2f}')
    print(f'  Pixels diff>50:  {pct_big:.1f}%')
    print(f'  Max channel diff: {max_diff:.0f}')
    print(f'  Pixels diff>0:    {nonzero}')
    diff_vis = np.clip(diff_map * 3, 0, 255).astype(np.uint8)
    Image.fromarray(diff_vis).save(SHOT_O.replace('original', 'diff'))
    print(f'  Diff image saved')

    # Render comparison is inherently GPU-dependent. We enforce a tight,
    # but resilient threshold that catches UV/texture coordinate errors
    # while avoiding flakiness due to 1-LSB noise.
    render_ok = (pixel_diff < 0.05) and (pct_big < 0.01) and (max_diff <= 2)
else:
    print(f'  Different sizes — cannot compare pixels')

print()
print('=== GLB STRUCTURE ===')
attrs = sorted(doc['meshes'][0]['primitives'][0]['attributes'].keys())
print(f'  Attributes: {attrs}')
print(f'  Extensions: {doc.get("extensionsUsed", [])}')

print()
ok = tex_ok and render_ok
print('RESULT=PASS' if ok else 'RESULT=FAIL')
sys.exit(0 if ok else 1)
