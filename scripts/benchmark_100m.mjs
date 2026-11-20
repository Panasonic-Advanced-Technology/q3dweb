import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 4179;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve(ROOT, 'test-results/bench-100m');
fs.mkdirSync(OUT_DIR, { recursive: true });

const mode = process.argv[2] || 'all'; // 'baseline' | 'compare' | 'all'

function startPreviewServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const onData = (buf) => {
      const s = buf.toString();
      if (!settled && (s.includes(`:${PORT}`) || s.includes('Local:'))) {
        settled = true;
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (!settled) reject(new Error(`vite preview exited early with code ${code}`));
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(proc);
      }
    }, 3000);
  });
}

function computeImageMetrics(refBytes, testBytes) {
  const len = Math.min(refBytes.length, testBytes.length);
  let sumSq = 0;
  let maxDiff = 0;
  let refNonZero = 0;
  let testNonZero = 0;
  let overlapNonZero = 0;
  let count = 0;
  for (let i = 0; i < len; i += 4) {
    const rr = refBytes[i], rg = refBytes[i + 1], rb = refBytes[i + 2];
    const tr = testBytes[i], tg = testBytes[i + 1], tb = testBytes[i + 2];
    const dr = rr - tr, dg = rg - tg, db = rb - tb;
    sumSq += dr * dr + dg * dg + db * db;
    const md = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
    if (md > maxDiff) maxDiff = md;
    const rNZ = (rr | rg | rb) !== 0;
    const tNZ = (tr | tg | tb) !== 0;
    if (rNZ) refNonZero++;
    if (tNZ) testNonZero++;
    if (rNZ && tNZ) overlapNonZero++;
    count += 3;
  }
  const mse = sumSq / Math.max(count, 1);
  const rmse = Math.sqrt(mse);
  const psnr = mse === 0 ? 99.99 : 20 * Math.log10(255 / rmse);
  const coverageIoU = (refNonZero + testNonZero - overlapNonZero) > 0
    ? overlapNonZero / (refNonZero + testNonZero - overlapNonZero)
    : 1;
  return {
    psnr: Number(psnr.toFixed(2)),
    rmse: Number(rmse.toFixed(3)),
    maxDiff,
    refNonZero,
    testNonZero,
    coverageIoU: Number(coverageIoU.toFixed(4)),
  };
}

async function runBench() {
  const server = await startPreviewServer();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--use-gl=angle',
        '--use-angle=vulkan',
        '--enable-features=Vulkan',
        '--ignore-gpu-blocklist',
        '--js-flags=--max-old-space-size=8192',
      ],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__viewer));

    const glInfo = await page.evaluate(() => {
      const v = window.__viewer;
      const gl = v.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        isWebGL2: v.renderer.capabilities.isWebGL2,
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        jsHeapLimitMB: performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null,
      };
    });

    // Helper inside page: deterministic synthetic urban+terrain point cloud generator
    // and GPU-synchronized frame timing helper (uses gl.finish() for true GPU frame cost).
    await page.evaluate(() => {
      window.__benchHelpers = {
        generateCloud(count, withRGB = true) {
          const positions = new Float32Array(count * 3);
          const values = new Float32Array(count);
          const rgb = withRGB ? new Uint8Array(count * 3) : undefined;
          // Deterministic xorshift32 for reproducible spatial distribution:
          // ground plane + 16 buildings + road corridors across 200m x 200m x 30m
          let seed = 0x12345678;
          for (let i = 0; i < count; i++) {
            seed ^= seed << 13; seed >>>= 0;
            seed ^= seed >>> 17; seed >>>= 0;
            seed ^= seed << 5; seed >>>= 0;
            const u = (seed & 0xFFFF) / 65535;
            const v = ((seed >>> 16) & 0xFFFF) / 65535;

            let x = (u - 0.5) * 200;
            let y = (v - 0.5) * 200;
            let z = Math.sin(x * 0.05) * Math.cos(y * 0.05) * 2.0;

            // 30% of points form building walls/roofs
            if ((i & 3) === 0) {
              const bx = ((i >> 2) & 3) * 45 - 67.5;
              const by = ((i >> 4) & 3) * 45 - 67.5;
              x = bx + (u - 0.5) * 18;
              y = by + (v - 0.5) * 18;
              z = ((seed % 1000) / 1000) * 24 + 1;
            }
            const b = i * 3;
            positions[b] = x;
            positions[b + 1] = y;
            positions[b + 2] = z;
            values[i] = Math.min(255, Math.max(0, (z + 5) * 8));
            if (rgb) {
              rgb[b] = Math.min(255, Math.max(0, Math.floor((x + 100) * 1.25)));
              rgb[b + 1] = Math.min(255, Math.max(0, Math.floor((y + 100) * 1.25)));
              rgb[b + 2] = Math.min(255, Math.max(0, Math.floor(z * 10)));
            }
          }
          return { positions, values, rgb };
        },

        syncGpu(gl) {
          const px = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return px[0] | px[1] | px[2] | px[3];
        },

        countNonZeroPixels(gl) {
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let nz = 0;
          for (let i = 0; i < px.length; i += 16) {
            if ((px[i] | px[i + 1] | px[i + 2]) !== 0) nz++;
          }
          return nz;
        },

        async measureOrbit(frames = 25, zoomFactor = 1.0) {
          const v = window.__viewer;
          const gl = v.renderer.getContext();
          const savedDist = v.cameraDist;
          const savedEuler = [...v.euler];
          v.cameraDist = savedDist * zoomFactor;
          v.updateCamera();
          v.render();
          this.syncGpu(gl);
          const nonZeroSamples = this.countNonZeroPixels(gl);
          const glError = gl.getError();

          // 1) Pure GPU+CPU synchronous frame time (readPixels barrier)
          const gpuTimes = [];
          for (let f = 0; f < frames; f++) {
            v.euler[2] += 0.04;
            v.updateCamera();
            const t0 = performance.now();
            v.render();
            this.syncGpu(gl);
            gpuTimes.push(performance.now() - t0);
          }

          // 2) Real rAF interactive loop wall-clock FPS
          const rafDeltas = [];
          await new Promise((resolve) => {
            let count = 0;
            let last = performance.now();
            const step = () => {
              const now = performance.now();
              if (count > 0) rafDeltas.push(now - last);
              last = now;
              if (count >= Math.min(frames, 20)) {
                resolve();
                return;
              }
              v.euler[2] += 0.04;
              v.updateCamera();
              v.render();
              count++;
              requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          });

          v.cameraDist = savedDist;
          v.euler = savedEuler;
          v.updateCamera();
          v.render();
          this.syncGpu(gl);

          gpuTimes.sort((a, b) => a - b);
          const mean = gpuTimes.reduce((a, b) => a + b, 0) / gpuTimes.length;
          const p50 = gpuTimes[Math.floor(gpuTimes.length * 0.5)];
          const p95 = gpuTimes[Math.min(gpuTimes.length - 1, Math.floor(gpuTimes.length * 0.95))];
          const max = gpuTimes[gpuTimes.length - 1];
          const rafMean = rafDeltas.length ? rafDeltas.reduce((a, b) => a + b, 0) / rafDeltas.length : 0;
          return {
            meanMs: Number(mean.toFixed(2)),
            p50Ms: Number(p50.toFixed(2)),
            p95Ms: Number(p95.toFixed(2)),
            maxMs: Number(max.toFixed(2)),
            gpuFps: Number((1000 / Math.max(mean, 0.01)).toFixed(1)),
            rafMeanMs: Number(rafMean.toFixed(2)),
            rafFps: Number((1000 / Math.max(rafMean, 0.01)).toFixed(1)),
            nonZeroSamples,
            glError,
          };
        },

        waitRefinementAndCapture(cameraPreset) {
          const v = window.__viewer;
          const gl = v.renderer.getContext();
          if (cameraPreset) {
            v.cameraCenter.set(cameraPreset.cx, cameraPreset.cy, cameraPreset.cz);
            v.cameraDist = cameraPreset.dist;
            v.euler = [...cameraPreset.euler];
            v.updateCamera();
          }
          const t0 = performance.now();
          let refinePasses = 0;
          v.render();
          this.syncGpu(gl);
          const cloud = v.items.cloud;
          while (cloud && typeof cloud.needsRefinement === 'function' && cloud.needsRefinement() && refinePasses < 200) {
            v.render();
            this.syncGpu(gl);
            refinePasses++;
          }
          const refineMs = performance.now() - t0;

          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const pixels = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          // Downsample 4x4 grid stride for fast transfer while keeping exact pixel coverage
          const stride = 2;
          const sw = Math.floor(w / stride);
          const sh = Math.floor(h / stride);
          const sampled = new Uint8Array(sw * sh * 4);
          let di = 0;
          for (let y = 0; y < sh; y++) {
            const sy = y * stride;
            for (let x = 0; x < sw; x++) {
              const si = (sy * w + x * stride) * 4;
              sampled[di++] = pixels[si];
              sampled[di++] = pixels[si + 1];
              sampled[di++] = pixels[si + 2];
              sampled[di++] = pixels[si + 3];
            }
          }
          return {
            refineMs: Number(refineMs.toFixed(2)),
            refinePasses,
            w: sw,
            h: sh,
            pixels: Array.from(sampled),
          };
        },

        measureRaycast(trials = 5) {
          const v = window.__viewer;
          const rect = v.renderer.domElement.getBoundingClientRect();
          const cx = rect.left + rect.width * 0.5;
          const cy = rect.top + rect.height * 0.5;
          const times = [];
          for (let i = 0; i < trials; i++) {
            v.selectedPoints = [];
            const t0 = performance.now();
            v.addMeasurementPoint(new MouseEvent('mousedown', { clientX: cx + i * 3, clientY: cy + i * 2 }));
            times.push(performance.now() - t0);
          }
          v.selectedPoints = [];
          v.updateMeasurementMarker();
          const mean = times.reduce((a, b) => a + b, 0) / times.length;
          return { meanMs: Number(mean.toFixed(2)), maxMs: Number(Math.max(...times).toFixed(2)) };
        },

        heapMB() {
          return performance.memory ? Number((performance.memory.usedJSHeapSize / 1048576).toFixed(1)) : null;
        },
      };
    });

    const report = {
      timestamp: new Date().toISOString(),
      mode,
      glInfo,
      scales: {},
      quality: {},
      parserThroughput: {},
      errors,
    };

    // Hide grid and axis during quality captures for pure point cloud comparison
    const qualityCases = [
      { name: '1M_I_alpha01_pixel', colorMode: 'I', alpha: 0.1, pointType: 'PIXEL', pointSize: 1 },
      { name: '1M_RGB_alpha10_pixel', colorMode: 'RGB', alpha: 1.0, pointType: 'PIXEL', pointSize: 2 },
      { name: '1M_I_alpha10_square', colorMode: 'I', alpha: 1.0, pointType: 'SQUARE', pointSize: 15 },
      { name: '1M_RGB_alpha10_sphere', colorMode: 'RGB', alpha: 1.0, pointType: 'SPHERE', pointSize: 15 },
    ];
    const qualityCam = { cx: 0, cy: 0, cz: 5, dist: 180, euler: [Math.PI / 3, 0, Math.PI / 4] };

    // 1. Scale 1M + Quality capture
    {
      const res1M = await page.evaluate(async (cam) => {
        const v = window.__viewer;
        const h = window.__benchHelpers;
        const { positions, values, rgb } = h.generateCloud(1_000_000, true);
        const t0 = performance.now();
        v.cloudRenderOptions = { alpha: 0.1, colorMode: 'RGB', pointType: 'PIXEL', pointSize: 1 };
        v.renderPoints(positions, values, rgb);
        const gl = v.renderer.getContext();
        v.render();
        h.syncGpu(gl);
        const buildAndFirstRenderMs = Number((performance.now() - t0).toFixed(2));
        const orbitFull = await h.measureOrbit(20, 1.0);
        const orbitZoom = await h.measureOrbit(20, 0.25);
        const raycast = h.measureRaycast(3);
        const heapMB = h.heapMB();
        return { buildAndFirstRenderMs, orbitFull, orbitZoom, raycast, heapMB };
      }, qualityCam);
      report.scales['1M'] = res1M;

      // Capture quality frames
      for (const qc of qualityCases) {
        const cap = await page.evaluate(({ qc, cam }) => {
          const v = window.__viewer;
          const h = window.__benchHelpers;
          if (v.items.grid) v.items.grid.visible = false;
          if (v.items.axis) v.items.axis.visible = false;
          const cloud = v.items.cloud;
          const mat = cloud.material;
          mat.uniforms.colorMode.value = qc.colorMode === 'RGB' ? 1 : qc.colorMode === 'FLAT' ? 2 : 0;
          mat.uniforms.alpha.value = qc.alpha;
          mat.uniforms.pointType.value = qc.pointType === 'SQUARE' ? 1 : qc.pointType === 'SPHERE' ? 2 : 0;
          mat.uniforms.pointSize.value = qc.pointSize;
          mat.transparent = qc.alpha < 0.99 || qc.pointType === 'SPHERE';
          mat.depthWrite = qc.alpha >= 0.99 && qc.pointType !== 'SPHERE';
          if (typeof cloud.invalidateCache === 'function') cloud.invalidateCache();
          const out = h.waitRefinementAndCapture(cam);
          if (v.items.grid) v.items.grid.visible = true;
          if (v.items.axis) v.items.axis.visible = true;
          return out;
        }, { qc, cam: qualityCam });

        const refPath = path.join(OUT_DIR, `ref_${qc.name}.bin`);
        const curBuf = Buffer.from(cap.pixels);
        if (mode === 'baseline' || !fs.existsSync(refPath)) {
          fs.writeFileSync(refPath, curBuf);
          report.quality[qc.name] = { savedReference: true, refineMs: cap.refineMs, refinePasses: cap.refinePasses };
        } else {
          const refBuf = fs.readFileSync(refPath);
          report.quality[qc.name] = {
            ...computeImageMetrics(refBuf, curBuf),
            refineMs: cap.refineMs,
            refinePasses: cap.refinePasses,
          };
        }
      }
    }

    // 2. Scale 10M
    {
      const res10M = await page.evaluate(async () => {
        const v = window.__viewer;
        const h = window.__benchHelpers;
        v.removeItem('cloud');
        const { positions, values, rgb } = h.generateCloud(10_000_000, true);
        const t0 = performance.now();
        v.cloudRenderOptions = { alpha: 0.1, colorMode: 'RGB', pointType: 'PIXEL', pointSize: 1 };
        v.renderPoints(positions, values, rgb);
        const gl = v.renderer.getContext();
        v.render();
        h.syncGpu(gl);
        const buildAndFirstRenderMs = Number((performance.now() - t0).toFixed(2));
        const orbitFullAlpha01 = await h.measureOrbit(15, 1.0);
        const orbitZoomAlpha01 = await h.measureOrbit(15, 0.25);

        // Opaque mode
        const mat = v.items.cloud.material;
        mat.uniforms.alpha.value = 1.0;
        mat.transparent = false;
        mat.depthWrite = true;
        if (typeof v.items.cloud.invalidateCache === 'function') v.items.cloud.invalidateCache();
        const orbitFullOpaque = await h.measureOrbit(15, 1.0);
        const raycast = h.measureRaycast(2);
        const heapMB = h.heapMB();
        return { buildAndFirstRenderMs, orbitFullAlpha01, orbitZoomAlpha01, orbitFullOpaque, raycast, heapMB };
      });
      report.scales['10M'] = res10M;

      // Verify progressive accumulation fidelity on 10M points (Direct 100% vs Forced 4-pass Accumulation)
      const accumCheck = await page.evaluate((cam) => {
        const v = window.__viewer;
        const h = window.__benchHelpers;
        const cloud = v.items.cloud;
        if (!cloud || typeof cloud.setInteractivePointBudget !== 'function') return null;
        if (v.items.grid) v.items.grid.visible = false;
        if (v.items.axis) v.items.axis.visible = false;
        const mat = cloud.material;
        mat.uniforms.colorMode.value = 1;
        mat.uniforms.alpha.value = 0.1;
        mat.uniforms.pointType.value = 0;
        mat.uniforms.pointSize.value = 1;
        mat.transparent = true;
        mat.depthWrite = false;

        cloud.setInteractivePointBudget(15_000_000);
        const directCap = h.waitRefinementAndCapture(cam);

        cloud.setInteractivePointBudget(2_500_000);
        cloud.setRefineBatchPoints(2_500_000);
        const accumCap = h.waitRefinementAndCapture(cam);

        if (v.items.grid) v.items.grid.visible = true;
        if (v.items.axis) v.items.axis.visible = true;
        return {
          directPixels: directCap.pixels,
          accumPixels: accumCap.pixels,
          accumPasses: accumCap.refinePasses,
          accumMs: accumCap.refineMs,
        };
      }, qualityCam);
      if (accumCheck) {
        report.quality['10M_Accum_vs_Direct_alpha01'] = {
          ...computeImageMetrics(Buffer.from(accumCheck.directPixels), Buffer.from(accumCheck.accumPixels)),
          accumPasses: accumCheck.accumPasses,
          accumMs: accumCheck.accumMs,
        };
      }
    }

    // 3. Scale 100M (1億点)
    {
      const res100M = await page.evaluate(async () => {
        const v = window.__viewer;
        const h = window.__benchHelpers;
        v.removeItem('cloud');
        const TOTAL = 100_000_000;
        const BATCH = 2_000_000;
        const gl = v.renderer.getContext();
        try {
          if (typeof v.beginStreamingCloud === 'function') {
            // New streaming chunked 100M path
            const t0 = performance.now();
            v.beginStreamingCloud({
              totalPointsEstimate: TOTAL,
              hasRGB: true,
              bounds: { minX: -100, minY: -100, minZ: -5, maxX: 100, maxY: 100, maxZ: 26 },
              valMin: 0,
              valMax: 255,
            });
            const posBuf = new Float32Array(BATCH * 3);
            const valBuf = new Float32Array(BATCH);
            const rgbBuf = new Uint8Array(BATCH * 3);
            let seed = 0x9E3779B9;
            let ingestMs = 0;
            for (let off = 0; off < TOTAL; off += BATCH) {
              for (let i = 0; i < BATCH; i++) {
                seed ^= seed << 13; seed >>>= 0;
                seed ^= seed >>> 17; seed >>>= 0;
                seed ^= seed << 5; seed >>>= 0;
                const u = (seed & 0xFFFF) / 65535;
                const w = ((seed >>> 16) & 0xFFFF) / 65535;
                let x = (u - 0.5) * 200;
                let y = (w - 0.5) * 200;
                let z = Math.sin(x * 0.05) * Math.cos(y * 0.05) * 2.0;
                const gi = off + i;
                if ((gi & 3) === 0) {
                  const bx = ((gi >> 2) & 3) * 45 - 67.5;
                  const by = ((gi >> 4) & 3) * 45 - 67.5;
                  x = bx + (u - 0.5) * 18;
                  y = by + (w - 0.5) * 18;
                  z = ((seed % 1000) / 1000) * 24 + 1;
                }
                const b = i * 3;
                posBuf[b] = x; posBuf[b + 1] = y; posBuf[b + 2] = z;
                valBuf[i] = Math.min(255, Math.max(0, (z + 5) * 8));
                rgbBuf[b] = Math.min(255, Math.max(0, Math.floor((x + 100) * 1.25)));
                rgbBuf[b + 1] = Math.min(255, Math.max(0, Math.floor((y + 100) * 1.25)));
                rgbBuf[b + 2] = Math.min(255, Math.max(0, Math.floor(z * 10)));
              }
              const ti = performance.now();
              v.pushStreamingCloudBatch(posBuf, valBuf, rgbBuf, BATCH);
              ingestMs += performance.now() - ti;
            }
            const tf = performance.now();
            v.cloudRenderOptions = { alpha: 0.1, colorMode: 'RGB', pointType: 'PIXEL', pointSize: 1 };
            v.finishStreamingCloud();
            v.render();
            h.syncGpu(gl);
            const finalizeAndFirstRenderMs = Number((performance.now() - tf).toFixed(2));
            const totalWallMs = Number((performance.now() - t0).toFixed(2));

            const orbitFullAlpha01 = await h.measureOrbit(20, 1.0);
            const orbitZoomAlpha01 = await h.measureOrbit(20, 0.2);

            // Measure refinement to 100% full quality
            const tRef0 = performance.now();
            let refinePasses = 0;
            const cloud = v.items.cloud;
            while (cloud && typeof cloud.needsRefinement === 'function' && cloud.needsRefinement() && refinePasses < 300) {
              v.render();
              h.syncGpu(gl);
              refinePasses++;
            }
            const fullRefineMs = Number((performance.now() - tRef0).toFixed(2));
            const stats = typeof cloud?.getStats === 'function' ? cloud.getStats() : null;

            // Opaque orbit
            const mat = cloud.material;
            mat.uniforms.alpha.value = 1.0;
            mat.transparent = false;
            mat.depthWrite = true;
            if (typeof cloud.invalidateCache === 'function') cloud.invalidateCache();
            const orbitFullOpaque = await h.measureOrbit(20, 1.0);
            const orbitZoomOpaque = await h.measureOrbit(20, 0.2);
            const raycast = h.measureRaycast(3);
            const heapMB = h.heapMB();
            return {
              supported: true,
              pointCount: cloud.getPointCount(),
              ingestMs: Number(ingestMs.toFixed(2)),
              finalizeAndFirstRenderMs,
              totalWallMs,
              orbitFullAlpha01,
              orbitZoomAlpha01,
              fullRefineMs,
              refinePasses,
              orbitFullOpaque,
              orbitZoomOpaque,
              raycast,
              heapMB,
              stats,
            };
          } else {
            // Baseline test: see what happens when trying 100M on existing CloudItem (or report MAX_POINTS_VISUAL cap)
            const positions = new Float32Array(TOTAL * 3);
            const values = new Float32Array(TOTAL);
            const rgb = new Uint8Array(TOTAL * 3);
            for (let i = 0; i < TOTAL; i++) {
              const b = i * 3;
              positions[b] = (i % 1000) * 0.2 - 100;
              positions[b + 1] = ((i / 1000) | 0) % 1000 * 0.2 - 100;
              positions[b + 2] = (i / 1000000) * 0.25;
              values[i] = i & 255;
              rgb[b] = i & 255; rgb[b + 1] = (i >> 8) & 255; rgb[b + 2] = 128;
            }
            const tRender = performance.now();
            v.cloudRenderOptions = { alpha: 0.1, colorMode: 'RGB', pointType: 'PIXEL', pointSize: 1 };
            v.renderPoints(positions, values, rgb);
            v.render();
            h.syncGpu(gl);
            const buildAndFirstRenderMs = Number((performance.now() - tRender).toFixed(2));
            const orbitFullAlpha01 = await h.measureOrbit(5, 1.0);
            const orbitZoomAlpha01 = await h.measureOrbit(5, 0.2);
            return {
              supported: true,
              legacySingleBuffer: true,
              maxPointsVisualCap: v.MAX_POINTS_VISUAL,
              buildAndFirstRenderMs,
              orbitFullAlpha01,
              orbitZoomAlpha01,
              heapMB: h.heapMB(),
            };
          }
        } catch (err) {
          return {
            supported: false,
            error: String(err),
            maxPointsVisualCap: v.MAX_POINTS_VISUAL,
            heapMB: h.heapMB(),
          };
        }
      });
      report.scales['100M'] = res100M;
    }

    // 4. Streaming binary LAS parser throughput benchmark (5M points in 1MB chunks)
    {
      const parserRes = await page.evaluate(async () => {
        const v = window.__viewer;
        v.removeItem('cloud');
        v.skipMemoryCheck = true;
        const N = 2_000_000;
        const recLen = 26; // Format 2 (XYZ + Intensity + RGB)
        const headerLen = 227;
        const totalBytes = headerLen + N * recLen;
        const buf = new Uint8Array(totalBytes);
        const dv = new DataView(buf.buffer);
        // Magic "LASF"
        buf[0] = 76; buf[1] = 65; buf[2] = 83; buf[3] = 70;
        dv.setUint8(24, 1); dv.setUint8(25, 2);
        dv.setUint16(94, headerLen, true);
        dv.setUint32(96, headerLen, true);
        dv.setUint8(104, 2); // Format 2
        dv.setUint16(105, recLen, true);
        dv.setUint32(107, N, true);
        dv.setFloat64(131, 0.001, true);
        dv.setFloat64(139, 0.001, true);
        dv.setFloat64(147, 0.001, true);
        dv.setFloat64(155, 0, true);
        dv.setFloat64(163, 0, true);
        dv.setFloat64(171, 0, true);
        // Bounds: [-100..100, -100..100, 0..30]
        dv.setFloat64(179, 100, true); dv.setFloat64(187, -100, true);
        dv.setFloat64(195, 100, true); dv.setFloat64(203, -100, true);
        dv.setFloat64(211, 30, true); dv.setFloat64(219, 0, true);
        for (let i = 0; i < N; i++) {
          const off = headerLen + i * recLen;
          dv.setInt32(off, ((i % 2000) - 1000) * 100, true);
          dv.setInt32(off + 4, ((((i / 2000) | 0) % 2000) - 1000) * 100, true);
          dv.setInt32(off + 8, (i % 300) * 100, true);
          dv.setUint16(off + 12, i & 255, true);
          dv.setUint16(off + 20, (i & 255) << 8, true);
          dv.setUint16(off + 22, ((i >> 4) & 255) << 8, true);
          dv.setUint16(off + 24, 128 << 8, true);
        }
        const file = new File([buf], 'bench_2m.las');
        const t0 = performance.now();
        await v.loadFile(file);
        const ms = performance.now() - t0;
        const loaded = v.items.cloud ? v.items.cloud.getPointCount() : 0;
        return {
          points: N,
          loadedPoints: loaded,
          totalMs: Number(ms.toFixed(2)),
          mPtsPerSec: Number(((N / 1e6) / (ms / 1000)).toFixed(2)),
        };
      });
      report.parserThroughput.las2M = parserRes;
    }

    console.log(JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, `report_${mode}_${Date.now()}.json`), JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

runBench().catch((e) => {
  console.error(e);
  process.exit(1);
});
