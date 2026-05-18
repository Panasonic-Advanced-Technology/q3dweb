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

function makeContainer() {
  const c = document.createElement('div'); c.id = 'app'; document.body.appendChild(c); return c;
}
function cleanup() { document.body.innerHTML = ''; }

describe('Viewer last-mile coverage', () => {
  let v: CloudViewer;
  beforeEach(() => { makeContainer(); v = new CloudViewer('app'); });
  afterEach(cleanup);

  it('addMeasurementPoint: hit via fake raycastable item', () => {
    // Add a custom THREE.Points instance with overridden raycast that always reports a hit.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
    const cloud: any = new THREE.Points(geo, new THREE.PointsMaterial());
    cloud.name = 'cloud';
    cloud.raycast = function (_raycaster: any, intersects: any[]) {
      intersects.push({ distance: 1, point: new THREE.Vector3(1, 2, 3), object: cloud });
    };
    v.items['cloud'] = cloud;
    v.scene.add(cloud);

    Object.defineProperty(v.renderer.domElement, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }),
      configurable: true,
    });
    v.addMeasurementPoint(new MouseEvent('mousedown', { clientX: 400, clientY: 300 }));
    expect(v.selectedPoints.length).toBe(1);
  });

  it('processChunk: PCD header arrives without DATA marker (leftover path)', () => {
    v.startStream(500, 'a.pcd');
    // Send a partial header without "DATA " keyword
    const partial = new TextEncoder().encode('VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\n');
    v.processChunk(partial, 0);
    expect(v.leftoverChunk).not.toBeNull();
    // Then the rest including DATA
    const rest = new TextEncoder().encode('COUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n');
    const dataBytes = new Uint8Array(rest.byteLength + 12);
    dataBytes.set(rest);
    const dv = new DataView(dataBytes.buffer, rest.byteLength);
    dv.setFloat32(0, 0, true); dv.setFloat32(4, 0, true); dv.setFloat32(8, 0, true);
    v.processChunk(dataBytes, 0);
    v.finalizeStream();
  });

  it('processChunk: header then DATA marker arrives mid-buffer without newline (leftover branch)', () => {
    v.startStream(500, 'a.pcd');
    // chunk includes "DATA binary" but NOT the trailing newline -> nextLineIdx === -1 path
    const noNl = new TextEncoder().encode('VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary');
    v.processChunk(noNl, 0);
    expect(v.leftoverChunk).not.toBeNull();
  });

  it('processChunk: error inside try is caught', () => {
    v.startStream(50, 'a.pcd');
    // Make TextDecoder.decode throw via tampered Uint8Array.subarray
    const u = new Uint8Array(50);
    Object.defineProperty(u, 'byteLength', { get() { throw new Error('boom'); } });
    v.processChunk(u, 0);
  });

  it('processAsciiData: lines.length fallback when totalPoints undefined + sample-ratio branch', () => {
    // Ascii PCD with no WIDTH/HEIGHT/POINTS - parseHeader leaves points undefined.
    // Force totalPoints > MAX_POINTS_VISUAL by lowering the cap.
    (v as any).MAX_POINTS_VISUAL = 1;
    const data = new TextEncoder().encode(
      'VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nDATA ascii\n0 0 0\n1 1 1\n2 2 2\n'
    );
    v.loadData(data, 'no_dims.pcd');
  });

  it('processChunk: non-PCD path with streamTotalSize=0 (progress fallback 0)', () => {
    v.startStream(0, 'x.ply');
    v.processChunk(new Uint8Array(5), 0);
  });

  it('decodePLYPackedRGB: integer (non-float) type path', () => {
    // Trigger via PLY ascii with packed rgb declared as uint
    const header = 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty uint rgb\nend_header\n';
    const ply = header + '0 0 0 16711680\n';
    v.loadData(new TextEncoder().encode(ply), 'rgb_int.ply');
  });

  it('processBinaryData: fast path with rgb at non-float-aligned offset', () => {
    // FIELDS x y z _ rgb _  with sizes 4 4 4 1 4 3 -> rowSize 20 aligned, rgb offset 13 (non-aligned)
    const header = 'VERSION 0.7\nFIELDS x y z _ rgb _\nSIZE 4 4 4 1 4 3\nTYPE F F F U U U\nCOUNT 1 1 1 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n';
    const hb = new TextEncoder().encode(header);
    const out = new Uint8Array(hb.byteLength + 20);
    out.set(hb);
    const dv = new DataView(out.buffer, hb.byteLength);
    dv.setFloat32(0, 0, true); dv.setFloat32(4, 0, true); dv.setFloat32(8, 0, true);
    dv.setUint8(12, 0);
    // rgb at offset 13 (non-4-aligned)
    dv.setUint8(13, 0xFF); dv.setUint8(14, 0x00); dv.setUint8(15, 0x00); dv.setUint8(16, 0x00);
    v.loadData(out, 'rgb_unaligned.pcd');
    expect(v.items.cloud).toBeDefined();
  });
});
