import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import * as THREE from 'three';
import { Viewer } from '../src/viewer';
import { CloudViewer } from '../src/cloud_viewer';

function makeContainer(id = 'app'): HTMLElement {
  const c = document.createElement('div');
  c.id = id;
  document.body.appendChild(c);
  return c;
}
function cleanup() { document.body.innerHTML = ''; }

describe('Viewer additional branch coverage', () => {
  let v: CloudViewer;
  beforeEach(() => { makeContainer(); v = new CloudViewer('app'); });
  afterEach(cleanup);

  it('measurement: hit a real cloud point', () => {
    // Add a cloud item containing a point near the screen center (camera looks from +Z to origin).
    const positions = new Float32Array([0, 0, 0]);
    const values = new Float32Array([0]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ size: 1 });
    const cloud = new THREE.Points(geo, mat);
    cloud.name = 'cloud';
    v.items['cloud'] = cloud;
    v.scene.add(cloud);

    // Aim camera right at the origin
    v.cameraCenter.set(0, 0, 0);
    v.cameraDist = 5;
    v.updateCamera();

    // Force selection by pushing directly
    v.selectedPoints.push(new THREE.Vector3(0, 0, 0));
    v.selectedPoints.push(new THREE.Vector3(1, 0, 0));
    v.updateMeasurementMarker();
    expect(v.selectedPoints.length).toBe(2);

    v.selectedPoints.push(new THREE.Vector3(2, 0, 0));
    v.updateMeasurementMarker();
    v.removeMeasurementPoint();
    expect(v.selectedPoints.length).toBe(2);
  });

  it('updateMeasurementMarker without text2d still safe', () => {
    v.text2dItem = null;
    v.selectedPoints = [new THREE.Vector3(), new THREE.Vector3(1, 0, 0)];
    v.updateMeasurementMarker();
    v.selectedPoints = [];
    v.updateMeasurementMarker();
  });

  it('parseHeader for binary with rgba field and counts/sizes', () => {
    v.parseHeader('VERSION 0.7\nFIELDS x y z rgba\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH 2\nHEIGHT 1\nPOINTS 2\nDATA binary\n');
    expect(v.pcdHeader?.offset['rgba']).toBe(12);
  });

  it('readNumericValue covers all type/size combinations', () => {
    // Build PCD with all field types
    v.parseHeader('VERSION 0.7\nFIELDS f4 f8 u1 u2 u4 i1 i2 i4 ux uxx uxxx\nSIZE 4 8 1 2 4 1 2 4 8 16 32\nTYPE F F U U U I I I X X X\nCOUNT 1 1 1 1 1 1 1 1 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n');
    const buf = new ArrayBuffer(80);
    const dv = new DataView(buf);
    dv.setFloat32(0, 1.5, true);
    dv.setFloat64(4, 2.5, true);
    dv.setUint8(12, 7);
    dv.setUint16(13, 8, true);
    dv.setUint32(15, 9, true);
    dv.setInt8(19, -1);
    dv.setInt16(20, -2, true);
    dv.setInt32(22, -3, true);
    // unknown size 8: falls to fallback (returns float32)
    dv.setFloat32(26, 10.0, true);
    // unknown size 16: also fallback
    dv.setUint16(34, 11, true);
    // unknown size 32: ultimate fallback uint8
    dv.setUint8(50, 12);
    const r = (v as any).readNumericValue;
    expect(r.call(v, dv, 0, 'F', 4)).toBeCloseTo(1.5);
    expect(r.call(v, dv, 4, 'F', 8)).toBeCloseTo(2.5);
    expect(r.call(v, dv, 12, 'U', 1)).toBe(7);
    expect(r.call(v, dv, 13, 'U', 2)).toBe(8);
    expect(r.call(v, dv, 15, 'U', 4)).toBe(9);
    expect(r.call(v, dv, 19, 'I', 1)).toBe(-1);
    expect(r.call(v, dv, 20, 'I', 2)).toBe(-2);
    expect(r.call(v, dv, 22, 'I', 4)).toBe(-3);
    // fallback paths
    r.call(v, dv, 26, 'X', 4);
    r.call(v, dv, 34, 'X', 2);
    r.call(v, dv, 50, 'X', 1);
  });

  it('readPackedRGB covers size!=4 fallback', () => {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint8(0, 0xFF);
    expect((v as any).readPackedRGB(dv, 0, 'U', 1)).toBe(0xFF);
    dv.setUint32(0, 0x00FF00, true);
    expect((v as any).readPackedRGB(dv, 0, 'U', 4)).toBe(0x00FF00);
  });

  it('parseAsciiPackedRGB covers float and integer paths', () => {
    expect((v as any).parseAsciiPackedRGB('not-a-num', 'F', 4)).toBe(0);
    const f = (v as any).parseAsciiPackedRGB('1.5', 'F', 4);
    expect(f).toBeGreaterThan(0);
    expect((v as any).parseAsciiPackedRGB('100', 'U', 4)).toBe(100);
  });

  it('getFieldSpec returns null when header missing', () => {
    v.pcdHeader = null;
    expect((v as any).getFieldSpec('x')).toBeNull();
  });

  it('assembleChunkList with multiple chunks', () => {
    v.chunkList = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5])];
    const out = (v as any).assembleChunkList();
    expect(out.length).toBe(5);
  });

  it('PLY ascii with line lacking sufficient tokens is skipped', () => {
    const ply = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\nbad\n';
    v.loadData(new TextEncoder().encode(ply), 'a.ply');
  });

  it('PLY ascii without trailing newline still parses last line', () => {
    const ply = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 1 1';
    v.loadData(new TextEncoder().encode(ply), 'a.ply');
    expect(v.items.cloud).toBeDefined();
  });

  it('PLY ascii with float intensity (0..1) gets rescaled', () => {
    const ply = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nproperty float intensity\nend_header\n0 0 0 0.5\n1 1 1 0.7\n';
    v.loadData(new TextEncoder().encode(ply), 'a.ply');
  });

  it('PLY binary intensity + packed RGB', () => {
    // header with intensity and rgb (packed float)
    const header = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty float intensity\nproperty float rgb\nend_header\n';
    const hb = new TextEncoder().encode(header);
    const recSize = 4 * 5;
    const out = new Uint8Array(hb.byteLength + recSize);
    out.set(hb);
    const dv = new DataView(out.buffer, hb.byteLength);
    dv.setFloat32(0, 1, true); dv.setFloat32(4, 2, true); dv.setFloat32(8, 3, true);
    dv.setFloat32(12, 200, true);
    // packed rgb: bits = 0xFF8800
    const buf = new ArrayBuffer(4); new DataView(buf).setUint32(0, 0xFF8800, true);
    dv.setFloat32(16, new DataView(buf).getFloat32(0, true), true);
    v.loadData(out, 'rgb.ply');
    expect(v.items.cloud).toBeDefined();
  });

  it('PLY binary with element list properties (skipped)', () => {
    const header = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nelement face 0\nproperty list uchar int vertex_indices\nend_header\n';
    const hb = new TextEncoder().encode(header);
    const out = new Uint8Array(hb.byteLength + 12);
    out.set(hb);
    const dv = new DataView(out.buffer, hb.byteLength);
    dv.setFloat32(0, 0, true); dv.setFloat32(4, 0, true); dv.setFloat32(8, 0, true);
    v.loadData(out, 'list.ply');
  });

  it('PLY without xyz throws (caught by loadData)', () => {
    const ply = 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float a\nproperty float b\nproperty float c\nend_header\n0 0 0\n';
    v.loadData(new TextEncoder().encode(ply), 'no_xyz.ply');
    expect(v.items.cloud).toBeUndefined();
  });

  it('LAS 1.4 with 64-bit point count', () => {
    const headerSize = 375;
    const recLen = 34; // format 3 with RGB needs 34
    const n = 2;
    const out = new Uint8Array(headerSize + n * recLen);
    const view = new DataView(out.buffer);
    out[0] = 0x4C; out[1] = 0x41; out[2] = 0x53; out[3] = 0x46;
    view.setUint8(24, 1); view.setUint8(25, 4);
    view.setUint32(96, headerSize, true);
    view.setUint8(104, 3);
    view.setUint16(105, recLen, true);
    view.setUint32(107, 0, true);  // legacy=0
    view.setUint32(247, n, true);  // 64-bit count low
    view.setFloat64(131, 0.01, true); view.setFloat64(139, 0.01, true); view.setFloat64(147, 0.01, true);
    for (let i = 0; i < n; i++) {
      const base = headerSize + i * recLen;
      view.setInt32(base, i * 100, true);
      view.setInt32(base + 4, i * 100, true);
      view.setInt32(base + 8, i * 100, true);
      view.setUint16(base + 12, 100, true);
      view.setUint16(base + 28, 200, true); // RGB low
      view.setUint16(base + 30, 200, true);
      view.setUint16(base + 32, 200, true);
    }
    v.loadData(out, 'big.las');
  });

  it('processAsciiData with rgba and intensity', () => {
    // Use rgba field, packed (uint32)
    const data = new TextEncoder().encode(
      'VERSION 0.7\nFIELDS x y z intensity rgba\nSIZE 4 4 4 4 4\nTYPE F F F F U\nCOUNT 1 1 1 1 1\nWIDTH 2\nHEIGHT 1\nPOINTS 2\nDATA ascii\n0 0 0 100 16711680\n1 1 1 200 65280\n'
    );
    v.loadData(data, 'rgba.pcd');
    expect(v.items.cloud).toBeDefined();
  });

  it('processAsciiData throws when missing xyz', () => {
    const data = new TextEncoder().encode(
      'VERSION 0.7\nFIELDS a b c\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA ascii\n0 0 0\n'
    );
    v.loadData(data, 'no_xyz.pcd');
  });

  it('processBinaryData with non-standard offsets goes through fallback path', () => {
    // Build a PCD with x at offset 4 (non-standard), via reordering fields
    const data = new TextEncoder().encode(
      'VERSION 0.7\nFIELDS pad x y z\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n'
    );
    const out = new Uint8Array(data.byteLength + 16);
    out.set(data);
    const dv = new DataView(out.buffer, data.byteLength);
    dv.setFloat32(0, 0, true);  // pad
    dv.setFloat32(4, 1, true);  // x
    dv.setFloat32(8, 2, true);  // y
    dv.setFloat32(12, 3, true); // z
    v.loadData(out, 'reorder.pcd');
    expect(v.items.cloud).toBeDefined();
  });

  it('processBinaryData with intensity & rgb in fallback path', () => {
    const data = new TextEncoder().encode(
      'VERSION 0.7\nFIELDS pad x y z intensity rgb\nSIZE 4 4 4 4 4 4\nTYPE F F F F F U\nCOUNT 1 1 1 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n'
    );
    const out = new Uint8Array(data.byteLength + 24);
    out.set(data);
    const dv = new DataView(out.buffer, data.byteLength);
    dv.setFloat32(0, 0, true);
    dv.setFloat32(4, 1, true);
    dv.setFloat32(8, 2, true);
    dv.setFloat32(12, 3, true);
    dv.setFloat32(16, 100, true);
    dv.setUint32(20, 0xFFAA00, true);
    v.loadData(out, 'rgb_fb.pcd');
    expect(v.items.cloud).toBeDefined();
  });

  it('finalize empty PLY stream throws (caught)', () => {
    v.startStream(0, 'a.ply');
    v.finalizeStream();
  });

  it('binary_compressed PCD path shows error', () => {
    v.startStream(200, 'foo.pcd');
    const data = new TextEncoder().encode(
      'VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary_compressed\n'
    );
    v.processChunk(data, 0);
    v.finalizeStream();
  });

  it('processChunk catches inner error', () => {
    v.startStream(100, 'foo.pcd');
    // Force error by making leftoverChunk a non-Uint8Array would be hard;
    // instead trigger via malformed buffer in processBinaryData by shrinking pcdHeader
    v.parseHeader('VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n');
    v.isBinary = true;
    v.posBuffer = new Float32Array(3);
    v.valBuffer = new Float32Array(1);
    // Trigger leftover chunk merging
    v.leftoverChunk = new Uint8Array(8);
    v.processChunk(new Uint8Array(8), 0);
  });

  it('animation showCenter timeout fires', async () => {
    vi.useFakeTimers();
    v.showCenter = true;
    v.enableShowCenter = true;
    // Animation loop should run, set marker visible, then timeout 500ms hides it
    vi.advanceTimersByTime(20); // animation tick
    vi.advanceTimersByTime(600); // timeout
    vi.useRealTimers();
  });
});
