/**
 * Qualification test for the memory-check heuristics in
 * src/utils/memoryCheck.ts.
 *
 * Goal: verify that the per-format expansion factors used by
 * estimateMemoryRequirement() are a reasonable UPPER bound on the peak
 * memory actually consumed by Viewer.loadData() when a real sample is
 * ingested, and that the warn/block gate fires at the documented
 * thresholds.
 *
 * Strategy:
 *   1. For each sample file that exists locally, call loadData() while
 *      measuring the RSS delta via process.memoryUsage().
 *   2. Assert that our estimate >= measured peak (i.e. we never
 *      under-estimate on real data). We intentionally allow the
 *      estimate to be several multiples of the real peak because the
 *      heuristic must also cover worst-case parser intermediates.
 *   3. Exercise the warn / block branches by calling loadData() on a
 *      small in-memory buffer with an artificially tiny heap limit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('three', async () => {
  const actual = await vi.importActual<any>('three');
  class FakeWebGLRenderer {
    domElement: HTMLCanvasElement;
    capabilities = { isWebGL2: true, maxTextures: 16 };
    constructor() { this.domElement = document.createElement('canvas'); }
    setPixelRatio() {}
    setSize(w: number, h: number) { this.domElement.width = w; this.domElement.height = h; }
    render() {}
    dispose() {}
    getContext() { return {}; }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { CloudViewer } from '../src/cloud_viewer';
import { estimateMemoryRequirement } from '../src/utils/memoryCheck';

const SAMPLE_DIR = '/home/hara/web_q3d/test_sample';

type SampleSpec = { name: string; format: 'pcd' | 'ply' | 'las' | 'laz' | 'e57' };

const SAMPLES: SampleSpec[] = [
  { name: 'warehouse_ascii.pcd',      format: 'pcd' },
  { name: 'mihara_binary.pcd',        format: 'pcd' },
  { name: 'mihara_ascii.ply',         format: 'ply' },
  { name: 'mihara_binary.ply',        format: 'ply' },
  { name: 'mihara_binary.las',        format: 'las' },
  { name: 'mihara_gnss.las',          format: 'las' },
  { name: 'mihara.laz',               format: 'laz' },
  { name: 'mihara.e57',               format: 'e57' },
];

function makeContainer(): HTMLElement {
  const c = document.createElement('div');
  c.id = 'app';
  document.body.appendChild(c);
  return c;
}

function readRss(): number {
  return process.memoryUsage().rss;
}

describe('memoryCheck qualification (real samples)', () => {
  let v: CloudViewer;

  beforeEach(() => {
    makeContainer();
    v = new CloudViewer('app');
    v.MAX_POINTS_VISUAL = 200_000;
    v.skipMemoryCheck = true;
    // Warm-up: load a tiny PCD so that jsdom/three baseline allocations
    // (worker pools, GL stubs, Float32Array presets) do not count against
    // the sample we are actually measuring.
    const warmup = new TextEncoder().encode(
      '# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\n' +
      'COUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 1\nDATA ascii\n0 0 0\n'
    );
    v.loadData(warmup, 'warmup.pcd');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  for (const sample of SAMPLES) {
    const fp = path.join(SAMPLE_DIR, sample.name);
    const exists = fs.existsSync(fp);
    const itFn = exists ? it : it.skip;

    itFn(`estimate is an upper bound for ${sample.name}`, async () => {
      const stat = fs.statSync(fp);
      const fileSize = stat.size;

      // Estimate with a generous heap so we can focus on the factor itself.
      const HEAP = 32 * 1024 * 1024 * 1024;
      const est = estimateMemoryRequirement(fileSize, sample.format, HEAP, 0);

      if ((global as any).gc) (global as any).gc();
      const before = readRss();

      const buf = fs.readFileSync(fp);
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      v.loadData(u8, sample.name);

      const peakAfter = readRss();
      const delta = Math.max(peakAfter - before, 0);

      const toMB = (n: number) => (n / 1024 / 1024).toFixed(1) + ' MiB';
      // eslint-disable-next-line no-console
      console.log(
        `[qual] ${sample.name} (${sample.format}) size=${toMB(fileSize)} ` +
        `estimate=${toMB(est.estimatedBytes)} rss_delta=${toMB(delta)} ` +
        `ratio_est/delta=${(est.estimatedBytes / Math.max(delta, 1)).toFixed(2)}`
      );

      // 1) False-negative check: a normal sample must not be flagged as
      //    'block' when loaded against a 32 GiB virtual heap.
      expect(est.level).not.toBe('block');

      // 2) Upper-bound check: allow a 30 MiB slack for GC / node-baseline
      //    noise in very small files, plus 20% margin on the estimate.
      if (delta > 0) {
        const slack = 30 * 1024 * 1024;
        expect(est.estimatedBytes * 1.2 + slack).toBeGreaterThanOrEqual(delta);
      }
    }, 300_000);
  }
});

describe('memoryCheck qualification (gate behaviour)', () => {
  beforeEach(() => { makeContainer(); });
  afterEach(() => { document.body.innerHTML = ''; });

  it('blocks a load that exceeds the heap budget', () => {
    const v = new CloudViewer('app');
    // 10 MiB synthetic payload with a .laz extension -> 8x factor = 80 MiB
    // estimate, against a mocked 1 MiB heap -> ratio >> 0.9 -> block.
    const data = new Uint8Array(10 * 1024 * 1024);

    const perf: any = (globalThis as any).performance ?? ((globalThis as any).performance = {});
    const saved = perf.memory;
    try {
      perf.memory = { jsHeapSizeLimit: 1024 * 1024, usedJSHeapSize: 0, totalJSHeapSize: 0 };
    } catch {
      // Some environments make .memory read-only; use defineProperty as a fallback.
      Object.defineProperty(perf, 'memory', {
        value: { jsHeapSizeLimit: 1024 * 1024, usedJSHeapSize: 0, totalJSHeapSize: 0 },
        configurable: true,
        writable: true,
      });
    }

    const alerts: string[] = [];
    const savedAlert = (globalThis as any).alert;
    (globalThis as any).alert = (msg: string) => { alerts.push(msg); };

    try {
      v.loadData(data, 'synthetic.laz');
    } finally {
      try { perf.memory = saved; } catch { /* best effort */ }
      (globalThis as any).alert = savedAlert;
    }

    expect(alerts.length).toBe(1);
    expect(alerts[0]).toMatch(/memory/i);
    expect(v.items.cloud).toBeUndefined();
  });

  it('passes a small load when the heap budget is generous', () => {
    const v = new CloudViewer('app');
    v.MAX_POINTS_VISUAL = 10_000;
    const header =
      '# .PCD v0.7 - Point Cloud Data file format\n' +
      'VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n' +
      'WIDTH 1\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 1\nDATA ascii\n0 0 0\n';
    const data = new TextEncoder().encode(header);

    const perf: any = (globalThis as any).performance ?? ((globalThis as any).performance = {});
    const saved = perf.memory;
    try {
      perf.memory = { jsHeapSizeLimit: 4 * 1024 * 1024 * 1024, usedJSHeapSize: 0, totalJSHeapSize: 0 };
    } catch {
      Object.defineProperty(perf, 'memory', {
        value: { jsHeapSizeLimit: 4 * 1024 * 1024 * 1024, usedJSHeapSize: 0, totalJSHeapSize: 0 },
        configurable: true,
        writable: true,
      });
    }

    const alerts: string[] = [];
    const savedAlert = (globalThis as any).alert;
    (globalThis as any).alert = (msg: string) => { alerts.push(msg); };

    try {
      v.loadData(data, 'tiny.pcd');
    } finally {
      try { perf.memory = saved; } catch { /* best effort */ }
      (globalThis as any).alert = savedAlert;
    }

    expect(alerts.length).toBe(0);
    expect(v.pointsLoaded).toBeGreaterThan(0);
  });
});
