import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { NativeCloudItem } from '../src/items/NativeCloudItem';
import { WebGLCloudBackend } from '../src/utils/WebGLCloudBackend';

type FakeGl = WebGLRenderingContext & {
  calls: Record<string, ReturnType<typeof vi.fn>>;
  shaderCompileOk: boolean;
  programLinkOk: boolean;
};

function makeGl(overrides: Partial<Pick<FakeGl, 'shaderCompileOk' | 'programLinkOk'>> = {}): FakeGl {
  const calls = {
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    bufferSubData: vi.fn(),
    drawArrays: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    blendFunc: vi.fn(),
    depthMask: vi.fn(),
    useProgram: vi.fn(),
    uniformMatrix4fv: vi.fn(),
    uniform1f: vi.fn(),
    uniform3f: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    disableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
  };

  const fakeGl = {
    calls,
    shaderCompileOk: overrides.shaderCompileOk ?? true,
    programLinkOk: overrides.programLinkOk ?? true,
    ARRAY_BUFFER: 0x8892,
    DYNAMIC_DRAW: 0x88E8,
    DEPTH_TEST: 0x0B71,
    BLEND: 0x0BE2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    POINTS: 0x0000,
    FLOAT: 0x1406,
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    createShader: vi.fn((type: number) => ({ type })),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => fakeGl.shaderCompileOk),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    deleteProgram: vi.fn(),
    getProgramParameter: vi.fn(() => fakeGl.programLinkOk),
    getAttribLocation: vi.fn((_: unknown, name: string) => name === 'aPosition' ? 1 : 2),
    getUniformLocation: vi.fn((_: unknown, name: string) => ({ name })),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: calls.bindBuffer,
    bufferData: calls.bufferData,
    bufferSubData: calls.bufferSubData,
    enable: calls.enable,
    disable: calls.disable,
    blendFunc: calls.blendFunc,
    depthMask: calls.depthMask,
    useProgram: calls.useProgram,
    uniformMatrix4fv: calls.uniformMatrix4fv,
    uniform1f: calls.uniform1f,
    uniform3f: calls.uniform3f,
    enableVertexAttribArray: calls.enableVertexAttribArray,
    disableVertexAttribArray: calls.disableVertexAttribArray,
    vertexAttribPointer: calls.vertexAttribPointer,
    drawArrays: calls.drawArrays,
  } as unknown as FakeGl;
  return fakeGl;
}

function makeRenderer(fakeGl: FakeGl): THREE.WebGLRenderer {
  return {
    getContext: () => fakeGl,
    resetState: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
}

function positions(pointCount: number): Float32Array {
  const out = new Float32Array(pointCount * 3);
  for (let index = 0; index < pointCount; index++) {
    out[index * 3] = index;
    out[index * 3 + 1] = index + 1;
    out[index * 3 + 2] = index + 2;
  }
  return out;
}

function values(pointCount: number): Float32Array {
  const out = new Float32Array(pointCount);
  for (let index = 0; index < pointCount; index++) out[index] = index + 10;
  return out;
}

describe('WebGLCloudBackend', () => {
  it('ignores invalid and empty appends', () => {
    const backend = new WebGLCloudBackend();
    const renderer = makeRenderer(makeGl());

    backend.append(renderer, new Float32Array(4), new Float32Array(1), 100);
    backend.append(renderer, new Float32Array(0), new Float32Array(0), 100);

    expect(backend.getPointCount()).toBe(0);
  });

  it('initializes shaders, uploads sampled chunks, and downsamples existing data at capacity', () => {
    const fakeGl = makeGl();
    const backend = new WebGLCloudBackend();
    const renderer = makeRenderer(fakeGl);

    backend.append(renderer, positions(10), values(10), 4);
    expect(backend.getPointCount()).toBe(3);
    expect(fakeGl.createShader).toHaveBeenCalledTimes(2);
    expect(fakeGl.createProgram).toHaveBeenCalledTimes(1);
    expect(fakeGl.calls.bufferData).toHaveBeenCalledWith(fakeGl.ARRAY_BUFFER, 4 * 16, fakeGl.DYNAMIC_DRAW);

    backend.append(renderer, positions(4), values(4), 4);
    expect(backend.getPointCount()).toBe(4);
    expect(fakeGl.calls.bufferSubData).toHaveBeenCalled();
  });

  it('draws non-RGB clouds with alpha and opaque render states', () => {
    const fakeGl = makeGl();
    const backend = new WebGLCloudBackend();
    const renderer = makeRenderer(fakeGl);
    const camera = new THREE.PerspectiveCamera();

    backend.append(renderer, positions(2), values(2), 10);
    backend.draw(renderer, camera, 'I', 0, 20, 3, 0.5);
    backend.draw(renderer, camera, 'FLAT', 0, 20, 4, 1);

    expect(fakeGl.calls.drawArrays).toHaveBeenCalledWith(fakeGl.POINTS, 0, 2);
    expect(fakeGl.calls.enable).toHaveBeenCalledWith(fakeGl.BLEND);
    expect(fakeGl.calls.disable).toHaveBeenCalledWith(fakeGl.BLEND);
    expect(fakeGl.calls.uniform1f).toHaveBeenCalledWith(expect.anything(), 2);
  });

  it('skips drawing empty and RGB clouds', () => {
    const fakeGl = makeGl();
    const backend = new WebGLCloudBackend();
    const renderer = makeRenderer(fakeGl);
    const camera = new THREE.PerspectiveCamera();

    backend.draw(renderer, camera, 'I', 0, 1, 1, 1);
    backend.append(renderer, positions(1), values(1), 10);
    backend.draw(renderer, camera, 'RGB', 0, 1, 1, 1);

    expect(fakeGl.calls.drawArrays).not.toHaveBeenCalled();
  });

  it('does not append when shader compilation or program linking fails', () => {
    const compileFailBackend = new WebGLCloudBackend();
    compileFailBackend.append(makeRenderer(makeGl({ shaderCompileOk: false })), positions(1), values(1), 10);
    expect(compileFailBackend.getPointCount()).toBe(0);

    const linkFailBackend = new WebGLCloudBackend();
    linkFailBackend.append(makeRenderer(makeGl({ programLinkOk: false })), positions(1), values(1), 10);
    expect(linkFailBackend.getPointCount()).toBe(0);
  });

  it('resets point count and floors max point capacity', () => {
    const backend = new WebGLCloudBackend();
    const renderer = makeRenderer(makeGl());
    backend.append(renderer, positions(2), values(2), 10);

    backend.reset(0.4);

    expect(backend.getPointCount()).toBe(0);
  });
});

describe('NativeCloudItem', () => {
  it('validates setters and delegates append/draw/reset to the backend', () => {
    const fakeGl = makeGl();
    const renderer = makeRenderer(fakeGl);
    const camera = new THREE.PerspectiveCamera();
    const item = new NativeCloudItem({ colorMode: 'I', pointSize: 2, alpha: 0.5, vmin: 1, vmax: 9 });

    item.setPointSize(Number.NaN);
    expect(item.getPointSize()).toBe(2);
    item.setPointSize(4);
    expect(item.getPointSize()).toBe(4);
    item.setAlpha(Number.NaN);
    item.setAlpha(2);
    item.setVmin(-1);
    item.setVmax(10);
    expect(item.getVmin()).toBe(-1);
    expect(item.getVmax()).toBe(10);

    item.appendPoints(renderer, new Float32Array(4), new Float32Array(1), 10);
    expect(item.getPointCount()).toBe(0);
    item.appendPoints(renderer, positions(2), values(2), 10);
    expect(item.getPointCount()).toBe(2);
    item.draw(renderer, camera);
    expect(fakeGl.calls.drawArrays).toHaveBeenCalled();
    item.setColorMode('RGB');
    item.draw(renderer, camera);

    item.reset(1);
    expect(item.getPointCount()).toBe(0);
  });
});