import { describe, expect, it, vi } from 'vitest';
import { buildSpatialChunks } from '../src/cloud/spatialChunker';
import { buildSpatialChunksAsync, normalizeIntensityAsync } from '../src/cloud/asyncChunkBuilder';
import { StreamingChunkBuilder } from '../src/cloud/streamingChunkBuilder';
import { ChunkedCloudItem } from '../src/items/ChunkedCloudItem';
import {
    beginStreamingCloud,
    finishStreamingCloudAsync,
    pushStreamingCloudBatch,
    renderPointsAsync,
    STATIC_CHUNKED_THRESHOLD,
} from '../src/viewer/cloudRenderer';
import * as THREE from 'three';

function createSimpleMockRenderer() {
    let nextId = 1;
    const gl: any = {
        ARRAY_BUFFER: 0x8892,
        STATIC_DRAW: 0x88e4,
        UNSIGNED_SHORT: 0x1403,
        UNSIGNED_BYTE: 0x1401,
        FLOAT: 0x1406,
        createBuffer: vi.fn(() => ({ id: nextId++ })),
        bindBuffer: vi.fn(),
        bufferData: vi.fn(),
        deleteBuffer: vi.fn(),
        createVertexArray: vi.fn(() => ({ id: nextId++ })),
        bindVertexArray: vi.fn(),
        deleteVertexArray: vi.fn(),
        enableVertexAttribArray: vi.fn(),
        disableVertexAttribArray: vi.fn(),
        vertexAttribPointer: vi.fn(),
        createShader: vi.fn(() => ({ id: nextId++ })),
        shaderSource: vi.fn(),
        compileShader: vi.fn(),
        getShaderParameter: vi.fn(() => true),
        deleteShader: vi.fn(),
        createProgram: vi.fn(() => ({ id: nextId++ })),
        attachShader: vi.fn(),
        bindAttribLocation: vi.fn(),
        linkProgram: vi.fn(),
        getProgramParameter: vi.fn(() => true),
        deleteProgram: vi.fn(),
    };
    return {
        getContext: () => gl,
        domElement: { width: 320, height: 240 },
    } as unknown as THREE.WebGLRenderer;
}

describe('asyncChunkBuilder & non-blocking loading', () => {
    it('normalizeIntensityAsync matches sync behavior for empty, <=255, and >255 arrays while yielding', async () => {
        const empty = new Float32Array(0);
        await normalizeIntensityAsync(empty);
        expect(empty.length).toBe(0);

        const small = new Float32Array([-5.2, 10.9, 200.4]);
        await normalizeIntensityAsync(small, undefined, 0);
        expect(Array.from(small)).toEqual([0, 10, 200]);

        const large = new Float32Array(200_000);
        for (let i = 0; i < large.length; i++) large[i] = i % 1021;
        const fractions: number[] = [];
        await normalizeIntensityAsync(large, (f) => fractions.push(f), 0);
        expect(fractions.length).toBeGreaterThanOrEqual(2);
        expect(fractions[fractions.length - 1]).toBe(1);
        expect(large[0]).toBe(0);
        expect(Math.max(...large.subarray(0, 1021))).toBe(255);
    });

    it('buildSpatialChunksAsync matches buildSpatialChunks for quantized RGB, intensity-only, float32 fallback, and empty clouds', async () => {
        const empty = await buildSpatialChunksAsync(new Float32Array(0), new Float32Array(0));
        expect(empty.chunks).toHaveLength(0);
        expect(empty.totalPoints).toBe(0);

        const n = 2000;
        const pos = new Float32Array(n * 3);
        const val = new Float32Array(n);
        const rgb = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) {
            pos[i * 3] = (i % 40) * 0.5;
            pos[i * 3 + 1] = Math.floor(i / 40) * 0.5;
            pos[i * 3 + 2] = (i % 10) * 0.2;
            val[i] = i % 255;
            rgb[i * 3] = 200;
            rgb[i * 3 + 1] = 100;
            rgb[i * 3 + 2] = 50;
        }

        // Quantized RGB
        const syncRgb = buildSpatialChunks(pos, val, rgb, 256);
        const progressRgb: number[] = [];
        const asyncRgb = await buildSpatialChunksAsync(pos, val, rgb, {
            targetPointsPerChunk: 256,
            sliceMs: 0,
            onProgress: (f) => progressRgb.push(f),
        });
        expect(asyncRgb.totalPoints).toBe(syncRgb.totalPoints);
        expect(asyncRgb.chunks.length).toBe(syncRgb.chunks.length);
        expect(asyncRgb.chunks[0].packedData).toEqual(syncRgb.chunks[0].packedData);
        expect(progressRgb[progressRgb.length - 1]).toBe(1);

        // Quantized intensity-only (no RGB)
        const syncInt = buildSpatialChunks(pos, val, undefined, 256);
        const asyncInt = await buildSpatialChunksAsync(pos, val, undefined, { targetPointsPerChunk: 256, sliceMs: 0 });
        expect(asyncInt.chunks.length).toBe(syncInt.chunks.length);
        expect(asyncInt.chunks[0].packedData).toEqual(syncInt.chunks[0].packedData);

        // Float32 fallback (span > 1000)
        const widePos = new Float32Array([0, 0, 0, 50_000, 0, 0, 0, 50_000, 0, 0, 0, 50_000]);
        const wideVal = new Float32Array([1, 2, 3, 4]);
        const wideRgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
        const asyncWide = await buildSpatialChunksAsync(widePos, wideVal, wideRgb, { targetPointsPerChunk: 1024, sliceMs: 0 });
        expect(asyncWide.chunks.every((c) => !c.isQuantized && c.strideBytes === 20)).toBe(true);
    });

    it('ChunkedCloudItem.fromArraysAsync, StreamingChunkBuilder.finishAsync, renderPointsAsync, and finishStreamingCloudAsync report progress cleanly', async () => {
        const renderer = createSimpleMockRenderer();

        // StreamingChunkBuilder.finishAsync
        const builder = new StreamingChunkBuilder({
            totalPointsEstimate: 1000,
            hasRGB: false,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 },
        });
        builder.pushPoint(1, 2, 3, 100, 0, 0, 0, () => {});
        builder.pushPoint(8, 9, 7, 200, 0, 0, 0, () => {});
        const flushed: any[] = [];
        const finishProgress: number[] = [];
        await builder.finishAsync((c) => flushed.push(c), (f) => finishProgress.push(f), 0);
        expect(flushed.reduce((s, c) => s + c.pointCount, 0)).toBe(2);
        expect(finishProgress[finishProgress.length - 1]).toBe(1);

        // ChunkedCloudItem.fromArraysAsync
        const smallPos = new Float32Array(3000 * 3);
        const smallVal = new Float32Array(3000);
        for (let i = 0; i < 3000; i++) {
            smallPos[i * 3] = (i % 30) * 0.2;
            smallPos[i * 3 + 1] = Math.floor(i / 30) * 0.2;
            smallPos[i * 3 + 2] = 0;
            smallVal[i] = i & 255;
        }
        const stages = new Set<string>();
        const item = await ChunkedCloudItem.fromArraysAsync(
            smallPos,
            smallVal,
            { alpha: 0.2 },
            undefined,
            renderer,
            (stage) => stages.add(stage),
            0,
        );
        expect(item.getPointCount()).toBe(3000);
        expect(stages.has('chunking')).toBe(true);
        expect(stages.has('uploading')).toBe(true);
        item.dispose();

        // renderPointsAsync for >= STATIC_CHUNKED_THRESHOLD and finishStreamingCloudAsync
        const mockViewer: any = {
            renderer,
            camera: new THREE.PerspectiveCamera(60, 1, 0.1, 1000),
            cameraCenter: new THREE.Vector3(),
            cameraDist: 40,
            euler: [0, 0, 0],
            items: {} as Record<string, any>,
            statusElement: { textContent: '' },
            loadingOverlay: { style: { display: 'flex' } },
            streamAborted: false,
            addItem: vi.fn((name: string, obj: any) => { mockViewer.items[name] = obj; }),
            removeItem: vi.fn((name: string) => { delete mockViewer.items[name]; }),
            updateCamera: vi.fn(),
            requestRender: vi.fn(),
        };

        const bigCount = STATIC_CHUNKED_THRESHOLD;
        const bigPos = new Float32Array(bigCount * 3);
        const bigVal = new Float32Array(bigCount);
        for (let i = 0; i < bigCount; i++) {
            bigPos[i * 3] = (i % 200) * 0.1;
            bigPos[i * 3 + 1] = Math.floor(i / 200) * 0.1;
            bigPos[i * 3 + 2] = 0;
            bigVal[i] = i & 255;
        }
        const rpStages = new Set<string>();
        await renderPointsAsync(mockViewer, bigPos, bigVal, undefined, (s) => rpStages.add(s));
        expect(mockViewer.items['cloud']).toBeInstanceOf(ChunkedCloudItem);
        expect(rpStages.has('uploading')).toBe(true);
        mockViewer.items['cloud'].dispose();

        // finishStreamingCloudAsync
        beginStreamingCloud(mockViewer, {
            totalPointsEstimate: 1000,
            hasRGB: false,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 },
        });
        pushStreamingCloudBatch(mockViewer, new Float32Array([1, 2, 3, 4, 5, 6]), new Float32Array([10, 20]), undefined, 2);
        const streamFinishProg: number[] = [];
        await finishStreamingCloudAsync(mockViewer, (f) => streamFinishProg.push(f));
        expect(mockViewer.items['cloud']).toBeInstanceOf(ChunkedCloudItem);
        expect(mockViewer.items['cloud'].getPointCount()).toBe(2);
        expect(streamFinishProg[streamFinishProg.length - 1]).toBe(1);
        mockViewer.items['cloud'].dispose();
    });
});
