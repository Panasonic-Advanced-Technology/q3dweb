import { describe, expect, it, vi } from 'vitest';

vi.mock('three', async () => {
    const actual = await vi.importActual<any>('three');
    class FakeWebGLRenderer {
        domElement: HTMLCanvasElement;
        capabilities = { isWebGL2: true, maxTextures: 16 };
        constructor() {
            this.domElement = document.createElement('canvas');
        }
        setPixelRatio() {}
        setSize(w: number, h: number) {
            this.domElement.width = w;
            this.domElement.height = h;
        }
        render() {}
        resetState() {}
        setRenderTarget() {}
        dispose() {}
        getContext() { return {}; }
    }
    return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import {
    computeSortedLodDrawPlan,
    extractDepthCoeffs,
    maxDepthCoeffsDiff,
    radixSortOrderByDepths,
    RadixSortWorkspace,
    sortChunkEntriesByDepth,
    sortInterleavedChunkBuffer,
    sortSeparatePointArrays,
    type SortableGpuChunkEntry,
} from '../src/cloud/depthSort';
import {
    AUTO_POINT_SORT_MAX_POINTS,
    AutoDepthSortController,
    IncrementalChunkSorter,
} from '../src/cloud/autoDepthSort';
import { ChunkedCloudItem } from '../src/items/ChunkedCloudItem';
import { CloudItem } from '../src/items/CloudItem';
import { NativeCloudItem } from '../src/items/NativeCloudItem';
import { CloudViewer } from '../src/cloud_viewer';
import type { QuantizedChunkData } from '../src/cloud/types';

function createCameraLookingAt(pos: [number, number, number], target: [number, number, number]): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    cam.up.set(0, 0, 1);
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(target[0], target[1], target[2]);
    cam.updateMatrixWorld();
    return cam;
}

function createStatefulWebGL2Mock(options: { withGetBufferSubData?: boolean; throwOnReadback?: boolean } = {}) {
    const withGetBufferSubData = options.withGetBufferSubData ?? true;
    const buffers = new Map<number, Uint8Array>();
    let nextId = 1;
    let boundVbo: { id: number } | null = null;
    let boundEbo: { id: number } | null = null;
    const gl: any = {
        ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893,
        STATIC_DRAW: 0x88e4,
        DYNAMIC_DRAW: 0x88e8,
        STREAM_DRAW: 0x88e0,
        VERTEX_SHADER: 0x8b31,
        FRAGMENT_SHADER: 0x8b30,
        COMPILE_STATUS: 0x8b81,
        LINK_STATUS: 0x8b82,
        UNSIGNED_SHORT: 0x1403,
        UNSIGNED_BYTE: 0x1401,
        UNSIGNED_INT: 0x1405,
        FLOAT: 0x1406,
        POINTS: 0x0000,
        DEPTH_TEST: 0x0b71,
        SCISSOR_TEST: 0x0c11,
        BLEND: 0x0be2,
        SRC_ALPHA: 0x0302,
        ONE_MINUS_SRC_ALPHA: 0x0303,
        LEQUAL: 0x0203,
        drawingBufferWidth: 320,
        drawingBufferHeight: 240,
        buffers,
        createShader: vi.fn(() => ({ id: nextId++ })),
        shaderSource: vi.fn(),
        compileShader: vi.fn(),
        getShaderParameter: vi.fn(() => true),
        getShaderInfoLog: vi.fn(() => ''),
        deleteShader: vi.fn(),
        createProgram: vi.fn(() => ({ id: nextId++ })),
        attachShader: vi.fn(),
        bindAttribLocation: vi.fn(),
        linkProgram: vi.fn(),
        getProgramParameter: vi.fn(() => true),
        getProgramInfoLog: vi.fn(() => ''),
        deleteProgram: vi.fn(),
        getAttribLocation: vi.fn((_p: any, name: string) => (name === 'aPosition' || name === 'aPos' ? 0 : name === 'aValue' || name === 'aVal' ? 1 : 2)),
        getUniformLocation: vi.fn((_p: any, name: string) => ({ name })),
        createBuffer: vi.fn(() => ({ id: nextId++ })),
        bindBuffer: vi.fn((target: number, buf: { id: number } | null) => {
            if (target === 0x8893) boundEbo = buf;
            else boundVbo = buf;
        }),
        bufferData: vi.fn((target: number, data: ArrayBufferView | number) => {
            const active = target === 0x8893 ? boundEbo : boundVbo;
            if (!active) return;
            if (typeof data === 'number') {
                buffers.set(active.id, new Uint8Array(data));
            } else {
                const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                const copy = new Uint8Array(src.byteLength);
                copy.set(src);
                buffers.set(active.id, copy);
            }
        }),
        bufferSubData: vi.fn((_target: number, offset: number, data: ArrayBufferView) => {
            if (!boundVbo) return;
            const target = buffers.get(boundVbo.id);
            if (!target) return;
            const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            target.set(src, offset);
        }),
        deleteBuffer: vi.fn(),
        createVertexArray: vi.fn(() => ({ id: nextId++ })),
        bindVertexArray: vi.fn(),
        deleteVertexArray: vi.fn(),
        enableVertexAttribArray: vi.fn(),
        disableVertexAttribArray: vi.fn(),
        vertexAttribPointer: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        depthFunc: vi.fn(),
        depthMask: vi.fn(),
        blendFunc: vi.fn(),
        useProgram: vi.fn(),
        uniformMatrix4fv: vi.fn(),
        uniform1f: vi.fn(),
        uniform3f: vi.fn(),
        drawArrays: vi.fn(),
        drawElements: vi.fn(),
        bindFramebuffer: vi.fn(),
        viewport: vi.fn(),
    };
    if (withGetBufferSubData) {
        gl.getBufferSubData = vi.fn((_target: number, offset: number, dst: ArrayBufferView) => {
            if (options.throwOnReadback) throw new Error('context lost');
            if (!boundVbo) return;
            const src = buffers.get(boundVbo.id);
            if (!src) return;
            const out = new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength);
            out.set(src.subarray(offset, offset + out.byteLength));
        });
    }
    const renderer: any = {
        getContext: () => gl,
        resetState: vi.fn(),
        setRenderTarget: vi.fn(),
        domElement: { width: 320, height: 240 },
    };
    return { gl, renderer };
}

describe('depthSort core utilities', () => {
    it('extractDepthCoeffs produces view-space Z coefficients ordered far-to-near', () => {
        const cam = createCameraLookingAt([0, -50, 0], [0, 0, 0]);
        const [a, b, c] = extractDepthCoeffs(cam.matrixWorldInverse);
        // Camera looks along +Y, so farther point (+40) has more negative view Z than nearer point (-40).
        const dFar = a * 0 + b * 40 + c * 0;
        const dNear = a * 0 + b * -40 + c * 0;
        expect(dFar).toBeLessThan(dNear);

        const model = new THREE.Matrix4().makeRotationZ(Math.PI);
        const [ma, mb, mc] = extractDepthCoeffs(cam.matrixWorldInverse, model);
        expect(ma * 0 + mb * -40 + mc * 0).toBeLessThan(ma * 0 + mb * 40 + mc * 0);
    });

    it('radixSortOrderByDepths handles empty, single, equal, negative, zero, positive, and random values', () => {
        const ws = new RadixSortWorkspace();
        ws.ensureCapacity(8);
        expect(radixSortOrderByDepths(0, ws)).toBe(ws.orderA);
        expect(radixSortOrderByDepths(1, ws)[0]).toBe(0);

        // All equal (all 3 radix passes skipped)
        ws.depthsF32.set([5, 5, 5, 5]);
        const eq = radixSortOrderByDepths(4, ws);
        expect(Array.from(eq.subarray(0, 4))).toEqual([0, 1, 2, 3]);

        // Only middle pass differs (pass 0 & 2 skipped)
        ws.depthsF32.set([2.0, 1.0, 4.0, 3.0]);
        const mid = radixSortOrderByDepths(4, ws);
        expect(Array.from(mid.subarray(0, 4))).toEqual([1, 0, 3, 2]);

        // Negative, -0, +0, positive, extremes
        const input = [100, -100, 0, -0.5, 0.5, -1e6, 1e6, -1e-4];
        ws.depthsF32.set(input);
        const order = radixSortOrderByDepths(input.length, ws);
        const sorted = Array.from(order.subarray(0, input.length)).map((idx) => input[idx]);
        expect(sorted).toEqual([-1e6, -100, -0.5, -1e-4, 0, 0.5, 100, 1e6]);

        // Large random verification
        const n = 4096;
        ws.ensureCapacity(n);
        const vals = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            vals[i] = Math.sin(i * 12.9898) * 10000;
            ws.depthsF32[i] = vals[i];
        }
        const largeOrder = radixSortOrderByDepths(n, ws);
        for (let i = 1; i < n; i++) {
            expect(vals[largeOrder[i - 1]]).toBeLessThanOrEqual(vals[largeOrder[i]]);
        }
    });

    it('sortInterleavedChunkBuffer sorts quantized (8B/12B) and float (16B/20B) chunks plus unaligned fallback', () => {
        const ws = new RadixSortWorkspace();
        const coeffs: [number, number, number] = [0, 0, 1]; // ascending z

        // 1) Quantized 8B (no RGB)
        const q8Src = new Uint8Array(3 * 8);
        const q8U16 = new Uint16Array(q8Src.buffer);
        // Point 0: z=60000, val=10; Point 1: z=10000, val=20; Point 2: z=30000, val=30
        q8U16.set([100, 200, 60000, 10, 101, 201, 10000, 20, 102, 202, 30000, 30]);
        const q8Dst = new Uint8Array(3 * 8);
        const q8Chunk: QuantizedChunkData = {
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 },
            centerX: 5, centerY: 5, centerZ: 5, radius: 9,
            pointCount: 3, isQuantized: true, hasRGB: false, strideBytes: 8,
            packedData: q8Src, pickPositions: new Float32Array(0),
        };
        sortInterleavedChunkBuffer(q8Src, q8Dst, q8Chunk, coeffs, ws);
        const q8Out = new Uint16Array(q8Dst.buffer);
        expect([q8Out[3], q8Out[7], q8Out[11]]).toEqual([20, 30, 10]);

        // 2) Quantized 12B (RGB)
        const q12Src = new Uint8Array(3 * 12);
        const q12U16 = new Uint16Array(q12Src.buffer);
        q12U16.set([0, 0, 50000, 1, 0x0201, 0x0003, 0, 0, 1000, 2, 0x0504, 0x0006, 0, 0, 20000, 3, 0x0807, 0x0009]);
        const q12Dst = new Uint8Array(3 * 12);
        sortInterleavedChunkBuffer(q12Src, q12Dst, { ...q8Chunk, hasRGB: true, strideBytes: 12 }, coeffs, ws);
        const q12Out = new Uint16Array(q12Dst.buffer);
        expect([q12Out[3], q12Out[9], q12Out[15]]).toEqual([2, 3, 1]);

        // 3) Unquantized 16B (no RGB)
        const f16Src = new Uint8Array(3 * 16);
        const f16 = new Float32Array(f16Src.buffer);
        f16.set([0, 0, 30, 1, 0, 0, -10, 2, 0, 0, 5, 3]);
        const f16Dst = new Uint8Array(3 * 16);
        sortInterleavedChunkBuffer(f16Src, f16Dst, { ...q8Chunk, isQuantized: false, hasRGB: false, strideBytes: 16 }, coeffs, ws);
        const f16Out = new Float32Array(f16Dst.buffer);
        expect([f16Out[3], f16Out[7], f16Out[11]]).toEqual([2, 3, 1]);

        // 4) Unquantized 20B (RGB)
        const f20Src = new Uint8Array(3 * 20);
        const f20 = new Float32Array(f20Src.buffer);
        f20[2] = 10; f20[3] = 100;
        f20[7] = -5; f20[8] = 200;
        f20[12] = 0; f20[13] = 300;
        const f20Dst = new Uint8Array(3 * 20);
        sortInterleavedChunkBuffer(f20Src, f20Dst, { ...q8Chunk, isQuantized: false, hasRGB: true, strideBytes: 20 }, coeffs, ws);
        const f20Out = new Float32Array(f20Dst.buffer);
        expect([f20Out[3], f20Out[8], f20Out[13]]).toEqual([200, 300, 100]);

        // 5) Unaligned destination view exercises generic byte-copy fallback
        const unalignedBacking = new Uint8Array(3 * 8 + 2);
        const unalignedDst = unalignedBacking.subarray(2);
        sortInterleavedChunkBuffer(q8Src, unalignedDst, q8Chunk, coeffs, ws);
        expect(unalignedDst[6]).toBe(20);

        // 6) Single-point copy
        const oneDst = new Uint8Array(8);
        sortInterleavedChunkBuffer(q8Src, oneDst, { ...q8Chunk, pointCount: 1 }, coeffs, ws);
        expect(new Uint16Array(oneDst.buffer)[3]).toBe(10);
    });

    it('sortSeparatePointArrays sorts positions, values, and optional colors in-place', () => {
        const pos = new Float32Array([0, 0, 10, 0, 0, -20, 0, 0, 0]);
        const val = new Float32Array([1, 2, 3]);
        const col = new Uint8Array([10, 11, 12, 20, 21, 22, 30, 31, 32]);
        sortSeparatePointArrays(pos, val, col, 3, [0, 0, 1]);
        expect(Array.from(val)).toEqual([2, 3, 1]);
        expect(Array.from(pos)).toEqual([0, 0, -20, 0, 0, 0, 0, 0, 10]);
        expect(Array.from(col)).toEqual([20, 21, 22, 30, 31, 32, 10, 11, 12]);

        // colors = null and count <= 1
        const pos2 = new Float32Array([0, 0, 5, 0, 0, -5]);
        const val2 = new Float32Array([10, 20]);
        sortSeparatePointArrays(pos2, val2, null, 2, [0, 0, 1]);
        expect(Array.from(val2)).toEqual([20, 10]);
        sortSeparatePointArrays(pos2, val2, null, 1, [0, 0, 1]);
        expect(Array.from(val2)).toEqual([20, 10]);
    });
});

describe('CloudItem / ChunkedCloudItem / NativeCloudItem forceSort', () => {
    it('CloudItem.forceSort reorders points far-to-near for the current camera', () => {
        const positions = new Float32Array([
            0, -30, 0, // near when camera is at (0, -50, 0)
            0, 40, 0,  // far
            0, 0, 0,   // middle
        ]);
        const values = new Float32Array([10, 20, 30]);
        const rgb = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const item = new CloudItem(positions, values, { alpha: 0.2 }, rgb);

        const camFront = createCameraLookingAt([0, -50, 0], [0, 0, 0]);
        expect(item.forceSort(camFront)).toBe(true);
        const valAttr = item.geometry.getAttribute('value') as THREE.BufferAttribute;
        expect(Array.from(valAttr.array as Float32Array)).toEqual([20, 30, 10]);

        // View from opposite side -> order flips
        const camBack = createCameraLookingAt([0, 50, 0], [0, 0, 0]);
        expect(item.forceSort(camBack)).toBe(true);
        expect(Array.from(valAttr.array as Float32Array)).toEqual([10, 30, 20]);

        // Empty / single-point CloudItem returns false
        const tiny = new CloudItem(new Float32Array([1, 2, 3]), new Float32Array([5]));
        expect(tiny.forceSort(camFront)).toBe(false);
    });

    it('ChunkedCloudItem.forceSort reorders chunks and GPU VBO points far-to-near via WebGL2 readback', () => {
        const { gl, renderer } = createStatefulWebGL2Mock();
        // Build points spanning Y in [-40, +40] across multiple spatial chunks
        const n = 2000;
        const positions = new Float32Array(n * 3);
        const values = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const y = ((i * 73) % 800) * 0.1 - 40;
            positions[i * 3] = (i % 10) - 5;
            positions[i * 3 + 1] = y;
            positions[i * 3 + 2] = ((i * 17) % 20) - 10;
            values[i] = y + 50;
        }

        const item = ChunkedCloudItem.fromArrays(positions, values, { alpha: 0.1 }, undefined, renderer);
        expect(item.getChunkCount()).toBeGreaterThan(1);

        // Camera at (0, -100, 0) looking toward +Y -> far chunks have larger +Y
        const camFront = createCameraLookingAt([0, -100, 0], [0, 0, 0]);
        expect(item.forceSort(camFront, renderer)).toBe(true);
        expect(gl.getBufferSubData).toHaveBeenCalled();
        expect(gl.bufferSubData).toHaveBeenCalled();

        // Check chunk centers are ordered far (+Y) to near (-Y)
        const chunksAfterFront = (item as any).backend.getChunks() as QuantizedChunkData[];
        for (let i = 1; i < chunksAfterFront.length; i++) {
            expect(chunksAfterFront[i - 1].centerY).toBeGreaterThanOrEqual(chunksAfterFront[i].centerY - 1e-4);
        }

        // Verify points inside each uploaded VBO are strictly ordered far-to-near along view Z
        const [a, b, c] = extractDepthCoeffs(camFront.matrixWorldInverse, item.matrixWorld);
        const entries = (item as any).backend.chunks as Array<{ data: QuantizedChunkData; vbo: { id: number } }>;
        for (const entry of entries) {
            const raw = gl.buffers.get(entry.vbo.id)!;
            const u16 = new Uint16Array(raw.buffer, raw.byteOffset, entry.data.pointCount * (entry.data.strideBytes / 2));
            const stride = entry.data.strideBytes / 2;
            const sx = entry.data.bounds.maxX - entry.data.bounds.minX;
            const sy = entry.data.bounds.maxY - entry.data.bounds.minY;
            const sz = entry.data.bounds.maxZ - entry.data.bounds.minZ;
            let prevDepth = -Infinity;
            for (let i = 0; i < entry.data.pointCount; i++) {
                const o = i * stride;
                const d = a * sx * u16[o] + b * sy * u16[o + 1] + c * sz * u16[o + 2];
                expect(d).toBeGreaterThanOrEqual(prevDepth - 1e-3);
                prevDepth = d;
            }
        }

        // Camera from opposite side reverses chunk order
        const camBack = createCameraLookingAt([0, 100, 0], [0, 0, 0]);
        expect(item.forceSort(camBack, renderer)).toBe(true);
        const chunksAfterBack = (item as any).backend.getChunks() as QuantizedChunkData[];
        for (let i = 1; i < chunksAfterBack.length; i++) {
            expect(chunksAfterBack[i - 1].centerY).toBeLessThanOrEqual(chunksAfterBack[i].centerY + 1e-4);
        }

        // Empty ChunkedCloudItem returns false
        const empty = new ChunkedCloudItem();
        expect(empty.forceSort(camFront, renderer)).toBe(false);
    });

    it('sortChunkEntriesByDepth handles CPU-pending chunks, WebGL1 fallback, and WebGL readback errors gracefully', () => {
        const chunkBytes = new Uint8Array(2 * 8);
        new Uint16Array(chunkBytes.buffer).set([0, 0, 50000, 1, 0, 0, 1000, 2]);
        const pendingChunk: QuantizedChunkData = {
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 10 },
            centerX: 0.5, centerY: 0.5, centerZ: 5, radius: 5,
            pointCount: 2, isQuantized: true, hasRGB: false, strideBytes: 8,
            packedData: chunkBytes, pickPositions: new Float32Array(0),
        };
        const entries: SortableGpuChunkEntry[] = [{ data: pendingChunk, vbo: null, uploaded: false }];
        expect(sortChunkEntriesByDepth(entries, [0, 0, 1], null, false)).toBe(1);
        expect(new Uint16Array(chunkBytes.buffer)[3]).toBe(2);

        // WebGL1 (no getBufferSubData) still sorts chunk order safely
        const { gl: gl1 } = createStatefulWebGL2Mock({ withGetBufferSubData: false });
        const uploadedEntries: SortableGpuChunkEntry[] = [
            { data: { ...pendingChunk, packedData: null, centerZ: 10 }, vbo: { id: 1 } as any, uploaded: true },
            { data: { ...pendingChunk, packedData: null, centerZ: -10 }, vbo: { id: 2 } as any, uploaded: true },
        ];
        expect(sortChunkEntriesByDepth(uploadedEntries, [0, 0, 1], gl1, false)).toBe(2);
        expect(uploadedEntries[0].data.centerZ).toBe(-10);

        // WebGL2 readback throwing error is caught and warns without crashing
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { gl: glErr } = createStatefulWebGL2Mock({ withGetBufferSubData: true, throwOnReadback: true });
        expect(sortChunkEntriesByDepth(uploadedEntries, [0, 0, 1], glErr, true)).toBe(0);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('NativeCloudItem.forceSort reorders interleaved points and updates GPU VBO', () => {
        const { gl, renderer } = createStatefulWebGL2Mock();
        const nativeItem = new NativeCloudItem({ alpha: 0.2, colorMode: 'I' });
        nativeItem.appendPoints(
            renderer,
            new Float32Array([0, -20, 0, 0, 30, 0, 0, 5, 0]),
            new Float32Array([1, 2, 3]),
            100,
        );
        const cam = createCameraLookingAt([0, -50, 0], [0, 0, 0]);
        expect(nativeItem.forceSort(cam, renderer)).toBe(true);
        expect(gl.bufferSubData).toHaveBeenCalled();
        const vboData = Array.from(gl.buffers.values())[0];
        const f32 = new Float32Array(vboData.buffer, vboData.byteOffset, 12);
        // Far (+30, val=2) -> middle (+5, val=3) -> near (-20, val=1)
        expect([f32[3], f32[7], f32[11]]).toEqual([2, 3, 1]);
    });
});

describe('Viewer R-key force sort integration', () => {
    it('triggers forceSortCloud on R key, ignores modifier/repeat/editable inputs, and supports settings button', () => {
        document.body.innerHTML = '<div id="app" style="width:640px;height:480px;"></div>';
        const viewer = new CloudViewer('app');
        viewer.renderPoints(
            new Float32Array([0, -20, 0, 0, 30, 0, 0, 0, 0]),
            new Float32Array([1, 2, 3]),
        );

        const sortSpy = vi.spyOn(viewer, 'forceSortCloud');
        const renderSpy = vi.spyOn(viewer, 'requestRender');

        // Plain 'r' triggers sort and render
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }));
        expect(sortSpy).toHaveBeenCalledTimes(1);
        expect(renderSpy).toHaveBeenCalled();

        // Uppercase 'R' also triggers sort
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'R', bubbles: true, cancelable: true }));
        expect(sortSpy).toHaveBeenCalledTimes(2);

        // Ctrl+R / Meta+R / Alt+R / repeat must be ignored
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', altKey: true, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', repeat: true, bubbles: true }));
        expect(sortSpy).toHaveBeenCalledTimes(2);

        // Typing 'r' inside an input must be ignored
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
        expect(sortSpy).toHaveBeenCalledTimes(2);

        // Settings panel Force Sort (R) button also triggers forceSortCloud
        const sortBtn = viewer.settingsContent?.querySelector('[data-role="cloud-force-sort-button"]') as HTMLButtonElement | null;
        expect(sortBtn).not.toBeNull();
        sortBtn!.click();
        expect(sortSpy).toHaveBeenCalledTimes(3);

        // Auto Depth Sort checkbox toggles autoDepthSortEnabled
        const autoCheckbox = viewer.settingsContent?.querySelector('[data-role="cloud-auto-sort-checkbox"]') as HTMLInputElement | null;
        expect(autoCheckbox).not.toBeNull();
        expect(autoCheckbox!.checked).toBe(true);
        autoCheckbox!.checked = false;
        autoCheckbox!.onchange?.(new Event('change'));
        expect(viewer.autoDepthSortEnabled).toBe(false);
        autoCheckbox!.checked = true;
        autoCheckbox!.onchange?.(new Event('change'));
        expect(viewer.autoDepthSortEnabled).toBe(true);

        viewer.autoDepthSortController.cancelPendingAndActive();
        cancelAnimationFrame(viewer.animationFrameId);
    });
});

describe('AutoDepthSortController & IncrementalChunkSorter', () => {
    it('IncrementalChunkSorter sorts chunk order immediately and slices per-chunk VBO sorting across steps', () => {
        const { gl, renderer } = createStatefulWebGL2Mock();
        const n = 2000;
        const positions = new Float32Array(n * 3);
        const values = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            positions[i * 3] = (i % 10) - 5;
            positions[i * 3 + 1] = ((i * 73) % 800) * 0.1 - 40;
            positions[i * 3 + 2] = ((i * 17) % 20) - 10;
            values[i] = i;
        }
        const item = ChunkedCloudItem.fromArrays(positions, values, { alpha: 0.2 }, undefined, renderer);
        const camFront = createCameraLookingAt([0, -100, 0], [0, 0, 0]);

        expect(item.isTransparentForDepthSort()).toBe(true);
        expect(item.beginAutoSort(camFront, renderer)).toBe('in-progress');

        // Force tiny budget so sorting spans multiple steps via mocked performance.now
        let fakeNow = 0;
        const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
            fakeNow += 5;
            return fakeNow;
        });
        let steps = 0;
        while (!item.stepAutoSort(1, renderer)) {
            steps++;
            expect(steps).toBeLessThan(100);
        }
        nowSpy.mockRestore();
        expect(steps).toBeGreaterThanOrEqual(1);
        expect(gl.getBufferSubData).toHaveBeenCalled();

        // Same camera direction is skipped because diff < threshold
        expect(item.beginAutoSort(camFront, renderer)).toBe('skipped');
        expect(maxDepthCoeffsDiff([0, 0, 1], null)).toBe(Infinity);

        // Opposite camera direction triggers a new sort, which can be cancelled mid-flight
        const camBack = createCameraLookingAt([0, 100, 0], [0, 0, 0]);
        expect(item.beginAutoSort(camBack, renderer)).toBe('in-progress');
        item.cancelAutoSort();
        expect(item.stepAutoSort(6, renderer)).toBe(true);
        // After cancellation, lastSortedCoeffs was not updated so restarting still runs
        expect(item.beginAutoSort(camBack, renderer)).toBe('in-progress');
        item.cancelAutoSort();
    });

    it('IncrementalChunkSorter handles empty, WebGL1 chunk-only, and error fallback', () => {
        const sorter = new IncrementalChunkSorter();
        expect(sorter.isActive()).toBe(false);
        expect(sorter.getTargetCoeffs()).toBeNull();
        expect(sorter.step(6)).toEqual({ sortedChunks: 0, done: true, failed: false });
        expect(sorter.start([], [0, 0, 1], null, false)).toBe('chunk-only-done');

        const { gl: gl1 } = createStatefulWebGL2Mock({ withGetBufferSubData: false });
        const chunk: QuantizedChunkData = {
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
            centerX: 0, centerY: 0, centerZ: 10, radius: 1,
            pointCount: 2, isQuantized: true, hasRGB: false, strideBytes: 8,
            packedData: null, pickPositions: new Float32Array(0),
        };
        const entries: SortableGpuChunkEntry[] = [
            { data: chunk, vbo: { id: 1 } as any, uploaded: true },
            { data: { ...chunk, centerZ: -10 }, vbo: { id: 2 } as any, uploaded: true },
        ];
        expect(sorter.start(entries, [0, 0, 1], gl1, false)).toBe('chunk-only-done');
        expect(entries[0].data.centerZ).toBe(-10);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { gl: glErr } = createStatefulWebGL2Mock({ withGetBufferSubData: true, throwOnReadback: true });
        expect(sorter.start(entries, [0, 0, 1], glErr, true)).toBe('in-progress');
        expect(sorter.getTargetCoeffs()).toEqual([0, 0, 1]);
        const res = sorter.step(10);
        expect(res.done).toBe(true);
        expect(res.failed).toBe(true);
        expect(sorter.isActive()).toBe(false);
        warnSpy.mockRestore();
    });

    it('AutoDepthSortController skips opaque clouds, respects idle delay & interaction, and cancels on activity', () => {
        vi.useFakeTimers();
        try {
            const { renderer } = createStatefulWebGL2Mock();
            const cam = createCameraLookingAt([0, -50, 0], [0, 0, 0]);
            const cloud = new CloudItem(
                new Float32Array([0, -20, 0, 0, 30, 0, 0, 0, 0]),
                new Float32Array([1, 2, 3]),
                { alpha: 1.0 },
            );
            const nativeCloud = new NativeCloudItem({ alpha: 0.3, colorMode: 'I' });
            nativeCloud.appendPoints(
                renderer,
                new Float32Array([0, -20, 0, 0, 30, 0]),
                new Float32Array([1, 2]),
                10,
            );

            let interacting = false;
            const requestRender = vi.fn();
            const items: THREE.Object3D[] = [cloud];
            const controller = new AutoDepthSortController(
                {
                    getSortableItems: () => items,
                    getCamera: () => cam,
                    getRenderer: () => renderer,
                    isUserInteracting: () => interacting,
                    requestRender,
                },
                { enabled: true, idleDelayMs: 250, timeSliceMs: 6 },
            );

            // Opaque cloud -> skipped completely
            expect(cloud.isTransparentForDepthSort()).toBe(false);
            expect(controller.runIdleSort()).toBe(false);
            expect(requestRender).not.toHaveBeenCalled();

            // Make cloud transparent -> scheduled after idle delay
            (cloud.material as THREE.ShaderMaterial).uniforms.alpha.value = 0.2;
            controller.notifyActivity();
            vi.advanceTimersByTime(200);
            expect(requestRender).not.toHaveBeenCalled();

            // User interacting when timer fires -> defers cleanly
            interacting = true;
            vi.advanceTimersByTime(60);
            expect(requestRender).not.toHaveBeenCalled();

            // Once user stops interacting, next timer runs sort and renders
            interacting = false;
            vi.advanceTimersByTime(260);
            expect(requestRender).toHaveBeenCalledTimes(1);
            const vals = (cloud.geometry.getAttribute('value') as THREE.BufferAttribute).array as Float32Array;
            expect(Array.from(vals)).toEqual([2, 3, 1]);

            // Running again with unchanged camera skips redundant sort
            expect(controller.runIdleSort()).toBe(false);

            // NativeCloudItem also auto-sorts when transparent
            items.push(nativeCloud);
            expect(controller.runIdleSort()).toBe(true);
            expect(nativeCloud.autoSortIfNeeded(cam, renderer)).toBe(false);

            // Disabling turns off idle sorting
            controller.setEnabled(false);
            expect(controller.isEnabled()).toBe(false);
            expect(controller.runIdleSort()).toBe(false);

            // ChunkedCloudItem incremental path via controller
            const n = 1500;
            const pos = new Float32Array(n * 3);
            const val = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                pos[i * 3] = (i % 10) - 5;
                pos[i * 3 + 1] = ((i * 53) % 400) * 0.1 - 20;
                pos[i * 3 + 2] = (i % 7) - 3;
                val[i] = i;
            }
            const chunked = ChunkedCloudItem.fromArrays(pos, val, { alpha: 0.2 }, undefined, renderer);
            items.splice(0, items.length, chunked);
            controller.setEnabled(true);
            const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 123);
            const cancelRafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
            expect(controller.runIdleSort()).toBe(true);
            expect(rafSpy).toHaveBeenCalled();
            expect(controller.stepActiveSort()).toBe(true);
            // Activity interrupts active sort
            const camBack = createCameraLookingAt([0, 50, 0], [0, 0, 0]);
            cam.position.copy(camBack.position);
            cam.lookAt(0, 0, 0);
            cam.updateMatrixWorld();
            expect(controller.runIdleSort()).toBe(true);
            controller.notifyActivity();
            expect(cancelRafSpy).toHaveBeenCalledWith(123);
            controller.cancelPendingAndActive();
            rafSpy.mockRestore();
            cancelRafSpy.mockRestore();
        } finally {
            vi.useRealTimers();
        }
    });

    it('computeSortedLodDrawPlan uses rounded step, keeps near-full chunks full-VAO, and clamps stride <= 255B', () => {
        expect(computeSortedLodDrawPlan(0, 100, 12)).toEqual({ mode: 'full', strideStep: 1, drawCount: 0 });
        expect(computeSortedLodDrawPlan(1000, 1000, 12)).toEqual({ mode: 'full', strideStep: 1, drawCount: 1000 });

        // Near-full ratio (>67%) stays full-VAO to prevent sudden 100%->50% chunk-boundary bands
        expect(computeSortedLodDrawPlan(65536, 50000, 12)).toEqual({ mode: 'full', strideStep: 1, drawCount: 65536 });

        // Half ratio -> strideStep = 2
        const plan2 = computeSortedLodDrawPlan(65536, 32768, 12);
        expect(plan2).toEqual({ mode: 'strided', strideStep: 2, drawCount: 32768 });
        expect((plan2.drawCount - 1) * plan2.strideStep).toBeLessThan(65536);
        expect(plan2.strideStep * 12).toBeLessThanOrEqual(255);

        // Heavy decimation -> clamped to floor(255/12)=21 with zero per-frame EBO allocation
        const planClamped = computeSortedLodDrawPlan(100000, 1000, 12);
        expect(planClamped.mode).toBe('strided');
        expect(planClamped.strideStep).toBe(21);
        expect(planClamped.strideStep * 12).toBeLessThanOrEqual(255);
        expect((planClamped.drawCount - 1) * planClamped.strideStep).toBeLessThan(100000);
    });

    it('ChunkedCloudBackend caches strided lodVao on sorted chunks and keeps large-cloud auto-sort chunk-only', () => {
        const { gl, renderer } = createStatefulWebGL2Mock();
        const n = 200_000;
        const positions = new Float32Array(n * 3);
        const values = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            positions[i * 3] = ((i % 400) - 200) * 0.05;
            positions[i * 3 + 1] = ((Math.floor(i / 400) % 500) - 250) * 0.05;
            positions[i * 3 + 2] = 0;
            values[i] = i & 255;
        }
        const item = ChunkedCloudItem.fromArrays(positions, values, { alpha: 0.2 }, undefined, renderer);
        const cam = createCameraLookingAt([20, -20, 20], [0, 0, 0]);
        cam.updateProjectionMatrix();

        // Force sort all chunks, then trigger interactive LOD (budget < totalPoints)
        expect(item.forceSort(cam, renderer)).toBe(true);
        item.setInteractivePointBudget(80_000); // ~40% -> strideStep >= 2

        gl.vertexAttribPointer.mockClear();
        gl.drawArrays.mockClear();
        gl.createVertexArray.mockClear();

        // First interactive frame builds and caches lodVao per strided chunk
        item.renderWithBackend(renderer, cam, () => {});
        const firstCreateVaoCalls = gl.createVertexArray.mock.calls.length;
        const firstAttribCalls = gl.vertexAttribPointer.mock.calls.length;
        expect(firstCreateVaoCalls).toBeGreaterThan(0);
        expect(firstAttribCalls).toBeGreaterThan(0);
        expect(gl.drawArrays).toHaveBeenCalled();

        // Second interactive frame with same strideStep reuses cached lodVao with zero attribute reconfiguration
        const camSlightlyMoved = createCameraLookingAt([21, -20, 20], [0, 0, 0]);
        camSlightlyMoved.updateProjectionMatrix();
        gl.vertexAttribPointer.mockClear();
        gl.createVertexArray.mockClear();
        item.renderWithBackend(renderer, camSlightlyMoved, () => {});
        expect(gl.createVertexArray).not.toHaveBeenCalled();
        expect(gl.vertexAttribPointer).not.toHaveBeenCalled();

        // Large clouds (> AUTO_POINT_SORT_MAX_POINTS) auto-sort chunk order ONLY without GPU VBO readback
        const backend = (item as any).backend;
        backend.totalPoints = AUTO_POINT_SORT_MAX_POINTS + 1;
        backend.lastSortedCoeffs = null;
        gl.getBufferSubData.mockClear();
        const camOpposite = createCameraLookingAt([-20, 20, 20], [0, 0, 0]);
        expect(item.beginAutoSort(camOpposite, renderer)).toBe('chunk-only-done');
        expect(gl.getBufferSubData).not.toHaveBeenCalled();

        // AutoDepthSortController defers while an item is refining accumulation
        const refiningItem: any = new THREE.Object3D();
        refiningItem.visible = true;
        refiningItem.isTransparentForDepthSort = () => true;
        refiningItem.isRefining = () => true;
        refiningItem.beginAutoSort = vi.fn(() => 'chunk-only-done');
        refiningItem.stepAutoSort = vi.fn(() => true);
        refiningItem.cancelAutoSort = vi.fn();
        const ctrl = new AutoDepthSortController({
            getSortableItems: () => [refiningItem],
            getCamera: () => cam,
            getRenderer: () => renderer,
            isUserInteracting: () => false,
            requestRender: vi.fn(),
        });
        expect(ctrl.runIdleSort()).toBe(false);
        expect(refiningItem.beginAutoSort).not.toHaveBeenCalled();
        ctrl.cancelPendingAndActive();

        item.dispose();
        expect(gl.deleteVertexArray).toHaveBeenCalled();
        expect(gl.deleteBuffer).toHaveBeenCalled();
    });
});
