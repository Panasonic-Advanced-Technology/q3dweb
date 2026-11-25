import * as THREE from 'three';
import type { QuantizedChunkData } from './types';

export type DepthCoeffs = readonly [number, number, number];

export interface DepthSortableCloudItem {
    forceSort(camera: THREE.Camera, renderer?: THREE.WebGLRenderer): boolean;
}

export interface SortableGpuChunkEntry {
    data: QuantizedChunkData;
    vbo: WebGLBuffer | null;
    uploaded: boolean;
    depthSorted?: boolean;
}

export const MAX_WEBGL_VERTEX_STRIDE = 255;

export interface SortedLodDrawPlan {
    mode: 'full' | 'strided' | 'indexed';
    strideStep: number;
    drawCount: number;
}

/**
 * Choose a uniform draw plan for a depth-sorted chunk VBO during partial interactive LOD.
 * Prefix drawing (`drawArrays(0, drawCount)`) on a depth-sorted chunk clips away a diagonal
 * half-space (visible as triangular cutouts); strided or indexed sampling spans the full chunk.
 */
export function computeSortedLodDrawPlan(
    pointCount: number,
    targetDrawCount: number,
    strideBytes: number,
    canUseUint32Ebo: boolean,
): SortedLodDrawPlan {
    if (pointCount <= 0 || targetDrawCount <= 0) {
        return { mode: 'full', strideStep: 1, drawCount: 0 };
    }
    if (targetDrawCount >= pointCount) {
        return { mode: 'full', strideStep: 1, drawCount: pointCount };
    }
    const maxStep = Math.max(1, Math.floor(MAX_WEBGL_VERTEX_STRIDE / Math.max(strideBytes, 1)));
    const step = Math.ceil(pointCount / targetDrawCount);
    if (step <= maxStep) {
        return {
            mode: 'strided',
            strideStep: step,
            drawCount: Math.ceil(pointCount / step),
        };
    }
    if (canUseUint32Ebo) {
        return {
            mode: 'indexed',
            strideStep: 1,
            drawCount: targetDrawCount,
        };
    }
    return {
        mode: 'strided',
        strideStep: maxStep,
        drawCount: Math.ceil(pointCount / maxStep),
    };
}

/** Fill ascending evenly-spaced indices across [0, pointCount) to preserve far-to-near order. */
export function fillUniformLodIndices(
    out: Uint32Array,
    pointCount: number,
    drawCount: number,
): void {
    for (let i = 0; i < drawCount; i++) {
        out[i] = Math.floor((i * pointCount) / drawCount);
    }
}

const _combinedMatrix = new THREE.Matrix4();

/**
 * Extract view-space Z coefficients [a, b, c] from viewMatrix * modelMatrix.
 * Sorting points by ascending depth = a*x + b*y + c*z orders them far-to-near
 * (camera looks down -Z, so farther points have more negative view Z).
 */
export function extractDepthCoeffs(
    viewMatrix: THREE.Matrix4,
    modelMatrix?: THREE.Matrix4,
): [number, number, number] {
    const m = modelMatrix ? _combinedMatrix.multiplyMatrices(viewMatrix, modelMatrix) : viewMatrix;
    const e = m.elements;
    return [e[2], e[6], e[10]];
}

export function maxDepthCoeffsDiff(
    a: DepthCoeffs,
    b: DepthCoeffs | null,
): number {
    if (!b) return Infinity;
    return Math.max(
        Math.abs(a[0] - b[0]),
        Math.abs(a[1] - b[1]),
        Math.abs(a[2] - b[2]),
    );
}

/** Sort chunk descriptors far-to-near along view Z (O(M log M), zero GPU work). */
export function sortChunkOrderByDepth(
    entries: SortableGpuChunkEntry[],
    depthCoeffs: DepthCoeffs,
): void {
    const [a, b, c] = depthCoeffs;
    entries.sort((e1, e2) => {
        const d1 = a * e1.data.centerX + b * e1.data.centerY + c * e1.data.centerZ;
        const d2 = a * e2.data.centerX + b * e2.data.centerY + c * e2.data.centerZ;
        return d1 - d2;
    });
}

/** Sort a single chunk's points (either CPU packedData or uploaded WebGL2 VBO). */
export function sortSingleChunkEntry(
    entry: SortableGpuChunkEntry,
    depthCoeffs: DepthCoeffs,
    gl2: WebGL2RenderingContext | null,
    srcBuf: Uint8Array,
    dstBuf: Uint8Array,
    ws: RadixSortWorkspace,
): 'sorted' | 'skipped' | 'error' {
    const data = entry.data;
    if (data.pointCount <= 1) return 'sorted';
    const byteLen = data.pointCount * data.strideBytes;

    if (!entry.uploaded && data.packedData) {
        const dstView = dstBuf.subarray(0, byteLen);
        sortInterleavedChunkBuffer(data.packedData.subarray(0, byteLen), dstView, data, depthCoeffs, ws);
        data.packedData.set(dstView, 0);
        entry.depthSorted = true;
        return 'sorted';
    }

    if (entry.uploaded && entry.vbo && gl2 && typeof gl2.getBufferSubData === 'function') {
        try {
            const srcView = srcBuf.subarray(0, byteLen);
            const dstView = dstBuf.subarray(0, byteLen);
            gl2.bindBuffer(gl2.ARRAY_BUFFER, entry.vbo);
            gl2.getBufferSubData(gl2.ARRAY_BUFFER, 0, srcView);
            sortInterleavedChunkBuffer(srcView, dstView, data, depthCoeffs, ws);
            gl2.bufferSubData(gl2.ARRAY_BUFFER, 0, dstView);
            entry.depthSorted = true;
            return 'sorted';
        } catch (err) {
            console.warn('[depthSort] GPU chunk sort skipped due to WebGL error:', err);
            return 'error';
        }
    }

    return 'skipped';
}

export class RadixSortWorkspace {
    depthsF32 = new Float32Array(0);
    keysU32 = new Uint32Array(0);
    orderA = new Uint32Array(0);
    orderB = new Uint32Array(0);
    readonly counts0 = new Uint32Array(2048);
    readonly counts1 = new Uint32Array(2048);
    readonly counts2 = new Uint32Array(1024);

    ensureCapacity(count: number): void {
        if (this.depthsF32.length >= count) return;
        const cap = Math.max(count, 1024);
        const keyBuffer = new ArrayBuffer(cap * 4);
        this.depthsF32 = new Float32Array(keyBuffer);
        this.keysU32 = new Uint32Array(keyBuffer);
        this.orderA = new Uint32Array(cap);
        this.orderB = new Uint32Array(cap);
    }
}

function prefixSum(counts: Uint32Array): void {
    let sum = 0;
    for (let i = 0; i < counts.length; i++) {
        const c = counts[i];
        counts[i] = sum;
        sum += c;
    }
}

/**
 * 3-pass LSD radix sort (11 + 11 + 10 bits) on workspace.depthsF32[0..count-1].
 * Returns a Uint32Array whose first `count` entries map sorted position -> source index (ascending).
 */
export function radixSortOrderByDepths(count: number, ws: RadixSortWorkspace): Uint32Array {
    if (count <= 0) return ws.orderA;
    if (count === 1) {
        ws.orderA[0] = 0;
        return ws.orderA;
    }

    const keys = ws.keysU32;
    const c0 = ws.counts0;
    const c1 = ws.counts1;
    const c2 = ws.counts2;
    c0.fill(0);
    c1.fill(0);
    c2.fill(0);

    // Convert IEEE-754 float32 bits into order-preserving unsigned 32-bit integers.
    for (let i = 0; i < count; i++) {
        const bits = keys[i];
        const mask = (bits >> 31) | 0x80000000;
        const k = (bits ^ mask) >>> 0;
        keys[i] = k;
        c0[k & 0x7ff]++;
        c1[(k >>> 11) & 0x7ff]++;
        c2[k >>> 22]++;
    }

    const k0 = keys[0];
    const skip0 = c0[k0 & 0x7ff] === count;
    const skip1 = c1[(k0 >>> 11) & 0x7ff] === count;
    const skip2 = c2[k0 >>> 22] === count;

    let src: Uint32Array | null = null;
    let dst = ws.orderA;

    if (!skip0) {
        prefixSum(c0);
        for (let i = 0; i < count; i++) {
            dst[c0[keys[i] & 0x7ff]++] = i;
        }
        src = dst;
        dst = ws.orderB;
    }

    if (!skip1) {
        prefixSum(c1);
        if (src === null) {
            for (let i = 0; i < count; i++) {
                dst[c1[(keys[i] >>> 11) & 0x7ff]++] = i;
            }
        } else {
            for (let i = 0; i < count; i++) {
                const idx = src[i];
                dst[c1[(keys[idx] >>> 11) & 0x7ff]++] = idx;
            }
        }
        src = dst;
        dst = dst === ws.orderA ? ws.orderB : ws.orderA;
    }

    if (!skip2) {
        prefixSum(c2);
        if (src === null) {
            for (let i = 0; i < count; i++) {
                dst[c2[keys[i] >>> 22]++] = i;
            }
        } else {
            for (let i = 0; i < count; i++) {
                const idx = src[i];
                dst[c2[keys[idx] >>> 22]++] = idx;
            }
        }
        src = dst;
    }

    if (src === null) {
        for (let i = 0; i < count; i++) ws.orderA[i] = i;
        return ws.orderA;
    }
    return src;
}

function reorderStridedBytes(
    srcBytes: Uint8Array,
    dstBytes: Uint8Array,
    strideBytes: number,
    order: Uint32Array,
    count: number,
): void {
    if ((srcBytes.byteOffset & 3) === 0 && (dstBytes.byteOffset & 3) === 0 && (strideBytes & 3) === 0) {
        const words = strideBytes >>> 2;
        const srcU32 = new Uint32Array(srcBytes.buffer, srcBytes.byteOffset, count * words);
        const dstU32 = new Uint32Array(dstBytes.buffer, dstBytes.byteOffset, count * words);

        if (words === 2) {
            for (let i = 0; i < count; i++) {
                const s = order[i] * 2;
                const d = i * 2;
                dstU32[d] = srcU32[s];
                dstU32[d + 1] = srcU32[s + 1];
            }
            return;
        }
        if (words === 3) {
            for (let i = 0; i < count; i++) {
                const s = order[i] * 3;
                const d = i * 3;
                dstU32[d] = srcU32[s];
                dstU32[d + 1] = srcU32[s + 1];
                dstU32[d + 2] = srcU32[s + 2];
            }
            return;
        }
        if (words === 4) {
            for (let i = 0; i < count; i++) {
                const s = order[i] * 4;
                const d = i * 4;
                dstU32[d] = srcU32[s];
                dstU32[d + 1] = srcU32[s + 1];
                dstU32[d + 2] = srcU32[s + 2];
                dstU32[d + 3] = srcU32[s + 3];
            }
            return;
        }
        if (words === 5) {
            for (let i = 0; i < count; i++) {
                const s = order[i] * 5;
                const d = i * 5;
                dstU32[d] = srcU32[s];
                dstU32[d + 1] = srcU32[s + 1];
                dstU32[d + 2] = srcU32[s + 2];
                dstU32[d + 3] = srcU32[s + 3];
                dstU32[d + 4] = srcU32[s + 4];
            }
            return;
        }
    }

    for (let i = 0; i < count; i++) {
        const s = order[i] * strideBytes;
        dstBytes.set(srcBytes.subarray(s, s + strideBytes), i * strideBytes);
    }
}

/**
 * Sort a single interleaved chunk buffer (quantized u16 or raw f32) far-to-near into dstBytes.
 */
export function sortInterleavedChunkBuffer(
    srcBytes: Uint8Array,
    dstBytes: Uint8Array,
    chunk: QuantizedChunkData,
    depthCoeffs: DepthCoeffs,
    ws: RadixSortWorkspace,
): void {
    const count = chunk.pointCount;
    if (count <= 1) {
        if (count === 1) dstBytes.set(srcBytes.subarray(0, chunk.strideBytes), 0);
        return;
    }

    ws.ensureCapacity(count);
    const depths = ws.depthsF32;
    const a = depthCoeffs[0];
    const b = depthCoeffs[1];
    const c = depthCoeffs[2];

    if (chunk.isQuantized) {
        const kx = a * (chunk.bounds.maxX - chunk.bounds.minX);
        const ky = b * (chunk.bounds.maxY - chunk.bounds.minY);
        const kz = c * (chunk.bounds.maxZ - chunk.bounds.minZ);
        const u16Stride = chunk.strideBytes >>> 1;
        const srcU16 = new Uint16Array(srcBytes.buffer, srcBytes.byteOffset, count * u16Stride);
        for (let i = 0, o = 0; i < count; i++, o += u16Stride) {
            const d = kx * srcU16[o] + ky * srcU16[o + 1] + kz * srcU16[o + 2];
            depths[i] = Number.isFinite(d) ? d : -3.4e38;
        }
    } else {
        const f32Stride = chunk.strideBytes >>> 2;
        const srcF32 = new Float32Array(srcBytes.buffer, srcBytes.byteOffset, count * f32Stride);
        for (let i = 0, o = 0; i < count; i++, o += f32Stride) {
            const d = a * srcF32[o] + b * srcF32[o + 1] + c * srcF32[o + 2];
            depths[i] = Number.isFinite(d) ? d : -3.4e38;
        }
    }

    const order = radixSortOrderByDepths(count, ws);
    reorderStridedBytes(srcBytes, dstBytes, chunk.strideBytes, order, count);
}

/**
 * Sort separate position/value/color arrays in-place (ascending depth = far-to-near).
 */
export function sortSeparatePointArrays(
    positions: Float32Array,
    values: Float32Array,
    colors: Uint8Array | null,
    count: number,
    depthCoeffs: DepthCoeffs,
    ws: RadixSortWorkspace = new RadixSortWorkspace(),
): void {
    if (count <= 1) return;
    ws.ensureCapacity(count);
    const depths = ws.depthsF32;
    const a = depthCoeffs[0];
    const b = depthCoeffs[1];
    const c = depthCoeffs[2];

    for (let i = 0, o = 0; i < count; i++, o += 3) {
        const d = a * positions[o] + b * positions[o + 1] + c * positions[o + 2];
        depths[i] = Number.isFinite(d) ? d : -3.4e38;
    }

    const order = radixSortOrderByDepths(count, ws);
    const tmpPos = new Float32Array(count * 3);
    const tmpVal = new Float32Array(count);
    const tmpCol = colors ? new Uint8Array(count * 3) : null;

    for (let i = 0; i < count; i++) {
        const srcIdx = order[i];
        const s3 = srcIdx * 3;
        const d3 = i * 3;
        tmpPos[d3] = positions[s3];
        tmpPos[d3 + 1] = positions[s3 + 1];
        tmpPos[d3 + 2] = positions[s3 + 2];
        tmpVal[i] = values[srcIdx];
        if (tmpCol && colors) {
            tmpCol[d3] = colors[s3];
            tmpCol[d3 + 1] = colors[s3 + 1];
            tmpCol[d3 + 2] = colors[s3 + 2];
        }
    }

    positions.set(tmpPos, 0);
    values.set(tmpVal, 0);
    if (tmpCol && colors) colors.set(tmpCol, 0);
}

export function measureMaxSortableChunk(
    entries: readonly SortableGpuChunkEntry[],
    canReadbackGpu: boolean,
): { maxBytes: number; maxPoints: number } {
    let maxBytes = 0;
    let maxPoints = 0;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const d = entry.data;
        if (d.pointCount <= 1) continue;
        const canSort = (!entry.uploaded && Boolean(d.packedData)) || (entry.uploaded && Boolean(entry.vbo) && canReadbackGpu);
        if (!canSort) continue;
        const bytes = d.pointCount * d.strideBytes;
        if (bytes > maxBytes) maxBytes = bytes;
        if (d.pointCount > maxPoints) maxPoints = d.pointCount;
    }
    return { maxBytes, maxPoints };
}

/**
 * Sort chunk entries far-to-near by chunk center and reorder each chunk's GPU VBO in-place.
 */
export function sortChunkEntriesByDepth(
    entries: SortableGpuChunkEntry[],
    depthCoeffs: DepthCoeffs,
    gl: WebGLRenderingContext | null,
    isWebGL2: boolean,
): number {
    if (entries.length === 0) return 0;

    // 1. Sort chunks far-to-near along view Z (axis-aligned grid cells have no occlusion cycles).
    sortChunkOrderByDepth(entries, depthCoeffs);

    // 2. Sort points inside each chunk (CPU payload if not yet uploaded, or GPU VBO via WebGL2).
    const gl2 = isWebGL2 && gl ? (gl as WebGL2RenderingContext) : null;
    const canReadbackGpu = Boolean(gl2 && typeof gl2.getBufferSubData === 'function');
    const { maxBytes, maxPoints } = measureMaxSortableChunk(entries, canReadbackGpu);
    if (maxBytes === 0) return entries.length;

    const ws = new RadixSortWorkspace();
    ws.ensureCapacity(maxPoints);
    const srcBuf = new Uint8Array(maxBytes);
    const dstBuf = new Uint8Array(maxBytes);

    if (gl2 && canReadbackGpu && typeof gl2.bindVertexArray === 'function') {
        gl2.bindVertexArray(null);
    }

    let sortedChunks = 0;
    for (let i = 0; i < entries.length; i++) {
        const status = sortSingleChunkEntry(entries[i], depthCoeffs, gl2, srcBuf, dstBuf, ws);
        if (status === 'error') break;
        if (status === 'sorted') sortedChunks++;
    }

    if (gl2 && canReadbackGpu) {
        gl2.bindBuffer(gl2.ARRAY_BUFFER, null);
    }

    return sortedChunks;
}
