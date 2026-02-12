/**
 * Automated GLB export visual test using Playwright.
 *
 * 1. Opens MeshVault with real GPU (non-headless on macOS)
 * 2. Loads Asteroid_1.fbx from archive
 * 3. Takes screenshot of original
 * 4. Exports as GLB
 * 5. Loads the exported GLB back
 * 6. Takes screenshot of re-imported GLB
 * 7. Runs pixel-level texture comparison
 * 8. Saves all images for visual inspection
 */

import { chromium } from 'playwright';
import fs from 'fs';
import { execSync } from 'child_process';

const BASE = 'http://localhost:8420';
const ARCHIVE = '/Users/alboul/3D-assset-browser/untracked/uploads_files_775776_asteroid_pack_2.zip';
const INNER = 'asteroid_pack_2/projectFiles/scenes/SingleAsteroids/Asteroid_1/Asteroid_1.fbx';
const GLB_OUT = '/Users/alboul/3D-assset-browser/untracked/_test_export.glb';
const TGA_INNER = 'asteroid_pack_2/projectFiles/sourceimages/Asteroid_1/asteroid_1_baseColor.tga';
const SHOT_ORIGINAL = '/Users/alboul/3D-assset-browser/untracked/_shot_original.png';
const SHOT_GLB = '/Users/alboul/3D-assset-browser/untracked/_shot_glb.png';

if (fs.existsSync(GLB_OUT)) fs.unlinkSync(GLB_OUT);

console.log('=== GLB EXPORT VISUAL TEST ===\n');

const browser = await chromium.launch({
    headless: false,   // Real GPU needed for WebGL on macOS
    args: ['--no-sandbox'],
});

const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('WebGL'))
        console.log(`  [err] ${msg.text().slice(0, 120)}`);
});

// Navigate
console.log('1. Loading MeshVault...');
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000);

const hasApp = await page.evaluate(() => !!window.app && !!window.app._viewer);
if (!hasApp) {
    console.log('   FAIL: window.app not available');
    await browser.close();
    process.exit(1);
}
console.log('   OK');

// Load FBX from archive
console.log('\n2. Loading Asteroid_1.fbx...');
const prepUrl = `${BASE}/api/asset/prepare_archive?archive_path=${encodeURIComponent(ARCHIVE)}&inner_path=${encodeURIComponent(INNER)}`;
const prep = await page.evaluate(async (url) => {
    const r = await fetch(url);
    return r.json();
}, prepUrl);

const loadOK = await page.evaluate(async (p) => {
    try {
        await window.app._viewer.loadModel(p.url, p.ext, {
            relatedFiles: p.rel, sourcePath: p.src,
        });
        return { ok: true };
    } catch (e) { return { ok: false, err: e.message }; }
}, { url: prep.file_url, ext: prep.actual_extension || '.fbx', rel: prep.related_files || [], src: prep.file_path });

if (!loadOK.ok) {
    console.log(`   FAIL: ${loadOK.err}`);
    await browser.close();
    process.exit(1);
}

await page.waitForTimeout(4000);
console.log('   OK — model loaded');

// Texture info
const texInfo = await page.evaluate(() => {
    const info = [];
    window.app._viewer._currentModel.traverse(c => {
        if (!c.isMesh || !c.material) return;
        const m = c.material;
        for (const slot of ['map', 'normalMap', 'bumpMap']) {
            if (m[slot]) info.push({
                slot, flipY: m[slot].flipY,
                type: m[slot].image?.constructor?.name || '?',
                w: m[slot].image?.width, h: m[slot].image?.height,
            });
        }
    });
    return info;
});
console.log('   Textures:', texInfo.map(t => `${t.slot}(flipY=${t.flipY},${t.type},${t.w}x${t.h})`).join(', '));

// Screenshot original
console.log('\n3. Screenshot of original FBX...');
await page.evaluate(() => window.app._viewer._composer.render());
await page.waitForTimeout(500);

const viewerBox = await page.evaluate(() => {
    const el = document.getElementById('viewer-3d');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
});
const clipW = Math.min(viewerBox.width, 1600);
const clipH = Math.min(viewerBox.height, 800);
await page.screenshot({
    path: SHOT_ORIGINAL,
    clip: { x: viewerBox.x, y: viewerBox.y, width: clipW, height: clipH },
});
console.log(`   Saved: ${SHOT_ORIGINAL}`);

// Export GLB
console.log('\n4. Exporting as GLB...');
const glbB64 = await page.evaluate(async () => {
    const buf = await window.app._viewer.exportAsGLB();
    if (!buf) return null;
    const bytes = new Uint8Array(buf);
    const chunks = [];
    const cs = 65536;
    for (let i = 0; i < bytes.length; i += cs)
        chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + cs, bytes.length))));
    return btoa(chunks.join(''));
});

if (!glbB64) {
    console.log('   FAIL: exportAsGLB returned null');
    await browser.close();
    process.exit(1);
}

fs.writeFileSync(GLB_OUT, Buffer.from(glbB64, 'base64'));
console.log(`   OK — ${(fs.statSync(GLB_OUT).size / 1024 / 1024).toFixed(1)} MB → ${GLB_OUT}`);

// Load GLB back
console.log('\n5. Loading exported GLB back...');
const glbUrl = `${BASE}/api/asset/file?path=${encodeURIComponent(GLB_OUT)}`;
const glbLoadOK = await page.evaluate(async (url) => {
    try {
        await window.app._viewer.loadModel(url, '.glb', {});
        return { ok: true };
    } catch (e) { return { ok: false, err: e.message }; }
}, glbUrl);

if (!glbLoadOK.ok) {
    console.log(`   FAIL: ${glbLoadOK.err}`);
    await browser.close();
    process.exit(1);
}

await page.waitForTimeout(3000);
console.log('   OK — GLB loaded');

// Screenshot GLB
console.log('\n6. Screenshot of re-imported GLB...');
await page.evaluate(() => window.app._viewer._composer.render());
await page.waitForTimeout(500);
await page.screenshot({
    path: SHOT_GLB,
    clip: { x: viewerBox.x, y: viewerBox.y, width: clipW, height: clipH },
});
console.log(`   Saved: ${SHOT_GLB}`);

await browser.close();
console.log('\n7. Browser closed. Running comparisons...\n');

// Python: texture orientation + screenshot diff
try {
    const result = execSync(`python3 test_compare.py`, { encoding: 'utf-8', timeout: 60000 });
    console.log(result);
    console.log('✅ GLB EXPORT TEST PASSED');
    process.exit(0);
} catch (e) {
    console.log('Comparison error:', e?.stdout?.toString?.() || e?.stderr?.toString?.() || e?.message || e);
    console.log('❌ GLB EXPORT TEST FAILED');
    process.exit(1);
}
