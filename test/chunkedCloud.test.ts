import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildSpatialChunks, computeGridDimensions, coprimeStride } from '../src/cloud/spatialChunker';
import { StreamingChunkBuilder } from '../src/cloud/streamingChunkBuilder';
import {
  allocateChunkDrawBudget,
  computeEquivalentAlpha,
  cullAndPrioritizeChunks,
  type ChunkCullMetadata,
  type VisibleChunkList,
} from '../src/cloud/frustumCuller';
import { CloudShaderCache } from '../src/cloud/cloudShaders';
import { AccumulationTarget } from '../src/cloud/accumulationTarget';
import { ChunkedCloudBackend } from '../src/cloud/ChunkedCloudBackend';
import { ChunkedCloudItem } from '../src/items/ChunkedCloudItem';
import {
  beginStreamingCloud,
  finishStreamingCloud,
  pushStreamingCloudBatch,
  renderPoints,
  STATIC_CHUNKED_THRESHOLD,
} from '../src/viewer/cloudRenderer';
import { estimateStreamingChunkedWorkspaceBytes } from '../src/viewer/loadBudget';

function createMockWebGL2Context(samples = 4) {
  let shaderId = 1;
  let progId = 1;
  let bufId = 1;
  let vaoId = 1;
  let fboId = 1;
  let rbId = 1;
  const mockFbo = { id: 999 };
  const mockTex = { id: 888 };
  const gl: any = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    UNSIGNED_SHORT: 0x1403,
    UNSIGNED_BYTE: 0x1401,
    FLOAT: 0x1406,
    POINTS: 0x0000,
    TRIANGLES: 0x0004,
    DEPTH_TEST: 0x0b71,
    SCISSOR_TEST: 0x0c11,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    LEQUAL: 0x0203,
    ALWAYS: 0x0207,
    FRAMEBUFFER: 0x8d40,
    READ_FRAMEBUFFER: 0x8ca8,
    DRAW_FRAMEBUFFER: 0x8ca9,
    DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
    FRAMEBUFFER_BINDING: 0x8ca6,
    RENDERBUFFER: 0x8d41,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8cd0,
    FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8cd1,
    TEXTURE: 0x1702,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    RGBA8: 0x8058,
    DEPTH_COMPONENT24: 0x81a6,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    NEAREST: 0x2600,
    SAMPLES: 0x80a9,
    MAX_SAMPLES: 0x8d57,
    drawingBufferWidth: 640,
    drawingBufferHeight: 360,
    drawArraysCalls: [] as Array<{ mode: number; first: number; count: number }>,
    createShader: vi.fn(() => ({ id: shaderId++ })),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({ id: progId++ })),
    attachShader: vi.fn(),
    bindAttribLocation: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    getAttribLocation: vi.fn((_p: any, name: string) => (name === 'aPos' ? 0 : name === 'aVal' ? 1 : 2)),
    getUniformLocation: vi.fn((_p: any, name: string) => ({ name })),
    createBuffer: vi.fn(() => ({ id: bufId++ })),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    deleteBuffer: vi.fn(),
    createVertexArray: vi.fn(() => ({ id: vaoId++ })),
    bindVertexArray: vi.fn(),
    deleteVertexArray: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    disableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    createFramebuffer: vi.fn(() => ({ id: fboId++ })),
    bindFramebuffer: vi.fn(),
    deleteFramebuffer: vi.fn(),
    createRenderbuffer: vi.fn(() => ({ id: rbId++ })),
    bindRenderbuffer: vi.fn(),
    renderbufferStorageMultisample: vi.fn(),
    framebufferRenderbuffer: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 0x8cd5),
    deleteRenderbuffer: vi.fn(),
    blitFramebuffer: vi.fn(),
    getParameter: vi.fn((pname: number) => {
      if (pname === 0x80a9) return samples;
      if (pname === 0x8d57) return 4;
      if (pname === 0x8ca6) return mockFbo;
      return 0;
    }),
    getFramebufferAttachmentParameter: vi.fn((_t: number, _a: number, pname: number) => {
      if (pname === 0x8cd0) return 0x1702; // TEXTURE
      return mockTex;
    }),
    useProgram: vi.fn(),
    uniformMatrix4fv: vi.fn(),
    uniform1f: vi.fn(),
    uniform1i: vi.fn(),
    uniform3f: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    depthFunc: vi.fn(),
    depthMask: vi.fn(),
    blendFunc: vi.fn(),
    viewport: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    drawArrays: vi.fn((mode: number, first: number, count: number) => {
      gl.drawArraysCalls.push({ mode, first, count });
    }),
  };
  return gl;
}

function createMockRenderer(gl: any) {
  return {
    domElement: { width: 640, height: 360 },
    getContext: () => gl,
    resetState: vi.fn(),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
}

describe('spatialChunker & StreamingChunkBuilder', () => {
  it('computes coprime strides that form exact bijections', () => {
    for (const n of [1, 2, 17, 100, 1024, 65536]) {
      const s = coprimeStride(n);
      const seen = new Set<number>();
      let slot = 0;
      for (let i = 0; i < n; i++) {
        seen.add(slot);
        slot = (slot + s) % n;
      }
      expect(seen.size).toBe(n);
    }
  });

  it('partitions clouds into quantized RGB and intensity-only chunks', () => {
    const empty = buildSpatialChunks(new Float32Array(0), new Float32Array(0));
    expect(empty.chunks).toHaveLength(0);
    expect(empty.totalPoints).toBe(0);

    const n = 2000;
    const pos = new Float32Array(n * 3);
    const val = new Float32Array(n);
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (i % 50) * 0.5;
      pos[i * 3 + 1] = Math.floor(i / 50) * 0.5;
      pos[i * 3 + 2] = (i % 10) * 0.2;
      val[i] = i % 255;
      rgb[i * 3] = 200;
      rgb[i * 3 + 1] = 100;
      rgb[i * 3 + 2] = 50;
    }

    const withRgb = buildSpatialChunks(pos, val, rgb, 256);
    expect(withRgb.totalPoints).toBe(n);
    expect(withRgb.chunks.length).toBeGreaterThan(1);
    expect(withRgb.chunks[0].isQuantized).toBe(true);
    expect(withRgb.chunks[0].strideBytes).toBe(12);
    expect(withRgb.chunks.reduce((sum, c) => sum + c.pointCount, 0)).toBe(n);

    const noRgb = buildSpatialChunks(pos, val, undefined, 256);
    expect(noRgb.chunks[0].strideBytes).toBe(8);
    expect(noRgb.chunks[0].hasRGB).toBe(false);
  });

  it('falls back to Float32 chunks when cell spans exceed quantization limit', () => {
    const pos = new Float32Array([0, 0, 0, 50_000, 0, 0, 0, 50_000, 0, 0, 0, 50_000]);
    const val = new Float32Array([1, 2, 3, 4]);
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
    const res = buildSpatialChunks(pos, val, rgb, 1024);
    expect(res.chunks.every((c) => !c.isQuantized && c.strideBytes === 20)).toBe(true);
  });

  it('computes bounded grid dimensions for flat and cubic extents', () => {
    const [nx, ny, nz] = computeGridDimensions(
      { minX: 0, minY: 0, minZ: 0, maxX: 200, maxY: 200, maxZ: 5 },
      1_000_000,
      10_000,
      256,
    );
    expect(nx * ny * nz).toBeLessThanOrEqual(256);
    expect(nx).toBeGreaterThanOrEqual(nz);
  });

  it('streams points via pushBatch, pushPoint, and pushLASRecords with zero-copy full-chunk flushes', () => {
    const chunks: any[] = [];
    const builder = new StreamingChunkBuilder({
      totalPointsEstimate: 30_000,
      hasRGB: true,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 },
      valMin: 0,
      valMax: 255,
      maxPointsPerChunk: 8192,
    });

    const batchN = 10_000;
    const pos = new Float32Array(batchN * 3);
    const val = new Float32Array(batchN);
    const rgb = new Uint8Array(batchN * 3);
    for (let i = 0; i < batchN; i++) {
      // Force all points into the same cell so promoteCell + flushFullCellZeroCopy execute!
      pos[i * 3] = 0.5 + (i % 10) * 0.01;
      pos[i * 3 + 1] = 0.5 + ((i >> 4) % 10) * 0.01;
      pos[i * 3 + 2] = 0.5;
      val[i] = i & 255;
      rgb[i * 3] = 10; rgb[i * 3 + 1] = 20; rgb[i * 3 + 2] = 30;
    }
    builder.pushBatch(pos, val, rgb, batchN, (c) => chunks.push(c));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].pointCount).toBe(8192);

    builder.pushPoint(5, 5, 5, 100, 1, 2, 3, (c) => chunks.push(c));

    // Also test pushLASRecords directly
    const recLen = 26;
    const lasBuf = new Uint8Array(recLen * 5);
    const dv = new DataView(lasBuf.buffer);
    for (let i = 0; i < 5; i++) {
      const o = i * recLen;
      dv.setInt32(o, 2000 + i * 10, true);
      dv.setInt32(o + 4, 2000, true);
      dv.setInt32(o + 8, 2000, true);
      dv.setUint16(o + 12, 120 + i, true);
      dv.setUint16(o + 20, 300, true);
      dv.setUint16(o + 22, 600, true);
      dv.setUint16(o + 24, 900, true);
    }
    const lasRes = builder.pushLASRecords(dv, 5, 0, 1, recLen, 0.001, 0.001, 0.001, 0, 0, 0, 20, (c) => chunks.push(c));
    expect(lasRes.emitted).toBe(5);
    expect(lasRes.hasNonZeroRGB).toBe(true);

    builder.finish((c) => chunks.push(c));
    expect(builder.getTotalPoints()).toBe(batchN + 6);
    expect(chunks.reduce((s, c) => s + c.pointCount, 0)).toBe(batchN + 6);
    expect(builder.getGlobalBounds().maxX).toBeGreaterThan(4);
  });
});

describe('frustumCuller', () => {
  it('culls out-of-frustum chunks and allocates budgets with equivalent alpha', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const meta: ChunkCullMetadata = {
      count: 2,
      minX: new Float32Array([-1, 500]),
      minY: new Float32Array([-1, 500]),
      minZ: new Float32Array([-1, 500]),
      maxX: new Float32Array([1, 505]),
      maxY: new Float32Array([1, 505]),
      maxZ: new Float32Array([1, 505]),
      centerX: new Float32Array([0, 502.5]),
      centerY: new Float32Array([0, 502.5]),
      centerZ: new Float32Array([0, 502.5]),
      radius: new Float32Array([1.73, 4.33]),
      pointCount: new Uint32Array([1000, 1000]),
    };
    const vis: VisibleChunkList = {
      indices: new Int32Array(2),
      weights: new Float32Array(2),
      length: 0,
      totalVisiblePoints: 0,
    };
    cullAndPrioritizeChunks(meta, camera, 600, vis);
    expect(vis.length).toBe(1);
    expect(vis.indices[0]).toBe(0);
    expect(vis.totalVisiblePoints).toBe(1000);

    const drawCounts = new Uint32Array(2);
    expect(allocateChunkDrawBudget(vis, meta.pointCount, 5000, drawCounts)).toBe(1000);
    expect(drawCounts[0]).toBe(1000);
    expect(allocateChunkDrawBudget(vis, meta.pointCount, 250, drawCounts)).toBe(250);
    expect(drawCounts[0]).toBe(250);

    // Alpha equivalence: (1 - eff)^ratio == (1 - base)
    const baseAlpha = 0.1;
    const ratio = 0.25;
    const eff = computeEquivalentAlpha(baseAlpha, ratio);
    expect(Math.pow(1 - eff, ratio)).toBeCloseTo(1 - baseAlpha, 5);
    expect(computeEquivalentAlpha(1.0, 0.2)).toBe(1.0);
  });
});

describe('CloudShaderCache, AccumulationTarget, ChunkedCloudBackend & ChunkedCloudItem', () => {
  it('compiles and caches shader variants and blit program, then disposes cleanly', () => {
    const gl = createMockWebGL2Context();
    const cache = new CloudShaderCache(gl);
    const p1 = cache.getProgram(0, 0, true, false);
    const p2 = cache.getProgram(0, 0, true, false);
    const p3 = cache.getProgram(1, 2, true, true);
    const p4 = cache.getProgram(2, 1, false, false);
    const p5 = cache.getProgram(1, 0, true, false); // RGB requested without RGB attr
    const blit = cache.getBlitProgram();

    expect(p1).toBeTruthy();
    expect(p1).toBe(p2);
    expect(p3).toBeTruthy();
    expect(p4).toBeTruthy();
    expect(p5).toBeTruthy();
    expect(blit).toBeTruthy();

    cache.dispose();
    expect(gl.deleteProgram).toHaveBeenCalled();
  });

  it('drives direct, interactive, refining, and cached render modes and accelerates raycasting', () => {
    const gl = createMockWebGL2Context(4);
    const renderer = createMockRenderer(gl);
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
    camera.position.set(0, 0, 20);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const n = 4000;
    const pos = new Float32Array(n * 3);
    const val = new Float32Array(n);
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = ((i % 40) - 20) * 0.2;
      pos[i * 3 + 1] = (Math.floor(i / 40) - 50) * 0.1;
      pos[i * 3 + 2] = 0;
      val[i] = i % 255;
      rgb[i * 3] = 255; rgb[i * 3 + 1] = 128; rgb[i * 3 + 2] = 64;
    }

    const item = ChunkedCloudItem.fromArrays(pos, val, { size: 2, alpha: 0.1, colorMode: 'RGB', pointType: 'PIXEL' }, rgb, renderer);
    expect(item.getPointCount()).toBe(n);
    expect(item.geometry.getAttribute('position')?.count).toBe(n);
    expect(item.getChunkCount()).toBeGreaterThan(0);

    item.updateViewport(720);
    expect(item.material.uniforms.viewportHeight.value).toBe(720);

    // Direct mode (budget >= n) keeps depth write enabled even when alpha < 1.0
    const renderBase = vi.fn();
    gl.depthMask.mockClear();
    expect(item.renderWithBackend(renderer, camera, renderBase)).toBe(true);
    expect(item.getStats().mode).toBe('direct');
    expect(item.needsRefinement()).toBe(false);
    expect(gl.depthMask).toHaveBeenCalledWith(true);
    expect(gl.depthMask).not.toHaveBeenCalledWith(false);

    // Interactive -> Refining -> Cached transition when budget < n
    const backend = new ChunkedCloudBackend();
    backend.setValueQuantization(0, 255);
    const built = buildSpatialChunks(pos, val, rgb, 1024);
    for (const c of built.chunks) backend.addChunk(c, renderer);
    backend.interactivePointBudget = 500;
    backend.refineBatchPoints = 1500;

    const snap = {
      pointSize: 1, alpha: 0.1, vmin: 0, vmax: 255, colorMode: 1,
      flatR: 1, flatG: 1, flatB: 1, pointType: 0, viewportHeight: 360,
    };
    backend.renderFrame(renderer, camera, snap, renderBase);
    expect(backend.getStats().mode).toBe('interactive');
    expect(backend.needsRefinement()).toBe(true);

    let guard = 0;
    while (backend.needsRefinement() && guard++ < 10) {
      backend.renderFrame(renderer, camera, snap, renderBase);
    }
    expect(backend.getStats().refinementComplete).toBe(true);
    expect(backend.getStats().mode).toBe('cached');

    // Subsequent static frame uses cached blit
    backend.renderFrame(renderer, camera, snap, renderBase);
    expect(backend.getStats().mode).toBe('cached');

    // Raycast hits a point near (0, 0, 0)
    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
    raycaster.params.Points = { threshold: 0.5 };
    const hits: THREE.Intersection[] = [];
    item.raycast(raycaster, hits);
    expect(hits.length).toBe(1);
    expect(hits[0].object).toBe(item);

    backend.dispose();
    item.dispose();
    expect(item.getPointCount()).toBe(0);
  });

  it('exercises AccumulationTarget lifecycle cleanly', () => {
    const gl = createMockWebGL2Context(4);
    const renderer = createMockRenderer(gl);
    const target = new AccumulationTarget();
    expect(target.isReady()).toBe(false);
    target.ensure(gl, true, 640, 360);
    expect(target.isReady()).toBe(true);
    target.beginPreview(gl, () => {});
    target.beginAccumulation(gl, true, renderer, () => {});
    expect(target.getDrawFbo()).toBeTruthy();
    target.resolveAccumulation(gl, true, renderer);
    target.presentAccumulation(renderer);
    target.presentPreview(renderer);
    target.dispose(gl);
    expect(target.isReady()).toBe(false);
  });

  it('auto-selects ChunkedCloudItem at STATIC_CHUNKED_THRESHOLD and supports streaming cloud lifecycle', () => {
    const viewer: any = {
      items: {},
      camera: new THREE.PerspectiveCamera(60),
      cameraCenter: new THREE.Vector3(),
      cameraDist: 0,
      euler: [0, 0, 0],
      dataMin: 0,
      dataMax: 0,
      statusElement: document.createElement('div'),
      loadingOverlay: document.createElement('div'),
      updateCamera: vi.fn(),
      requestRender: vi.fn(),
      addItem: vi.fn((name: string, obj: any) => { viewer.items[name] = obj; }),
      removeItem: vi.fn((name: string) => { delete viewer.items[name]; }),
    };

    const count = STATIC_CHUNKED_THRESHOLD;
    renderPoints(viewer, new Float32Array(count * 3), new Float32Array(count));
    expect(viewer.items.cloud).toBeInstanceOf(ChunkedCloudItem);
    expect(viewer.items.cloud.getPointCount()).toBe(count);

    // Streaming lifecycle
    beginStreamingCloud(viewer, {
      totalPointsEstimate: 100,
      hasRGB: true,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 },
    });
    pushStreamingCloudBatch(
      viewer,
      new Float32Array([1, 2, 3, 4, 5, 6]),
      new Float32Array([10, 20]),
      new Uint8Array([255, 0, 0, 0, 255, 0]),
      2,
    );
    finishStreamingCloud(viewer);
    expect(viewer.items.cloud).toBeInstanceOf(ChunkedCloudItem);
    expect(viewer.items.cloud.getPointCount()).toBe(2);
    expect(viewer.items.cloud.material.uniforms.colorMode.value).toBe(1);

    // Workspace memory estimate stays bounded even for 100M points
    const est100M = estimateStreamingChunkedWorkspaceBytes(100_000_000, true);
    expect(est100M).toBeLessThan(128 * 1024 * 1024);
  });
});
