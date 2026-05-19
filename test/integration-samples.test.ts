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
import { CloudItem } from '../src/items/CloudItem';

const SAMPLE_DIR = '/home/hara/web_q3d/test_sample';

const LIGHT_SAMPLES = [
  'warehouse_ascii.pcd',
];

const HEAVY_SAMPLES = [
  'umeda_7F_color_opt.pcd',
  'mihara_binary.pcd',
  'mihara_ascii.ply',
  'mihara_binary.ply',
  'mihara_binary.las',
  'mihara_gnss.las',
];

const SAMPLES = process.env.Q3DWEB_HEAVY_SAMPLES === '1'
  ? [...LIGHT_SAMPLES, ...HEAVY_SAMPLES]
  : LIGHT_SAMPLES;

function makeContainer(): HTMLElement {
  const c = document.createElement('div');
  c.id = 'app';
  document.body.appendChild(c);
  return c;
}

describe('Integration: load real sample files', () => {
  let v: CloudViewer;

  beforeEach(() => {
    makeContainer();
    v = new CloudViewer('app');
    // Smaller cap so very large files don't allocate too much memory in CI
    v.MAX_POINTS_VISUAL = 200_000;
    // Bypass the heap-size guard: the jsdom environment does not expose
    // performance.memory, so the default budget is a conservative 2 GiB
    // which would otherwise block some >500 MB sample files in tests.
    v.skipMemoryCheck = true;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  for (const name of SAMPLES) {
    const fp = path.join(SAMPLE_DIR, name);
    const exists = fs.existsSync(fp);
    const itFn = exists ? it : it.skip;

    itFn(`loads ${name}`, () => {
      const buf = fs.readFileSync(fp);
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      v.loadData(u8, name);
      expect(v.items.cloud).toBeDefined();
      expect((v.items.cloud as CloudItem).getPointCount()).toBeGreaterThan(0);
    }, 300_000);
  }
});
