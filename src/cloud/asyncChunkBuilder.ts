import {
    computeGridDimensions,
    coprimeStride,
    makeChunkDescriptor,
    type SpatialBuildResult,
} from './spatialChunker';
import type { CloudBounds, QuantizedChunkData } from './types';

const MAX_QUANTIZED_SPAN = 1000;
const MAX_TOTAL_PICK_SAMPLES = 400_000;
const DEFAULT_TARGET_POINTS_PER_CHUNK = 65_536;
const SLICE_BATCH_POINTS = 131_072;
const DEFAULT_SLICE_MS = 14;

export function yieldToMain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Time-sliced intensity normalization matching normalizeIntensity(), yielding to the event loop
 * so multi-million-point files never freeze the browser UI.
 */
export async function normalizeIntensityAsync(
    values: Float32Array,
    onProgress?: (fraction: number) => void,
    sliceMs: number = DEFAULT_SLICE_MS,
): Promise<void> {
    const n = values.length;
    if (n === 0) return;

    let maxIntensity = 0;
    let sliceStart = performance.now();
    for (let i = 0; i < n; ) {
        const end = Math.min(n, i + SLICE_BATCH_POINTS);
        for (; i < end; i++) {
            const v = Math.max(0, Math.trunc(values[i]));
            values[i] = v;
            if (v > maxIntensity) maxIntensity = v;
        }
        if (i < n && performance.now() - sliceStart >= sliceMs) {
            onProgress?.((i / n) * 0.5);
            await yieldToMain();
            sliceStart = performance.now();
        }
    }

    if (maxIntensity > 255) {
        const scale = 255 / maxIntensity;
        sliceStart = performance.now();
        for (let i = 0; i < n; ) {
            const end = Math.min(n, i + SLICE_BATCH_POINTS);
            for (; i < end; i++) {
                values[i] = Math.trunc(values[i] * scale);
            }
            if (i < n && performance.now() - sliceStart >= sliceMs) {
                onProgress?.(0.5 + (i / n) * 0.5);
                await yieldToMain();
                sliceStart = performance.now();
            }
        }
    }
    onProgress?.(1);
}

/**
 * Time-sliced asynchronous counterpart to buildSpatialChunks().
 * Yields between ~14ms slices across all three passes so large clouds build smoothly without freezing the UI.
 */
export async function buildSpatialChunksAsync(
    positions: Float32Array,
    values: Float32Array,
    rgb?: Uint8Array,
    options: {
        targetPointsPerChunk?: number;
        sliceMs?: number;
        onProgress?: (fraction: number) => void;
    } = {},
): Promise<SpatialBuildResult> {
    const targetPointsPerChunk = options.targetPointsPerChunk ?? DEFAULT_TARGET_POINTS_PER_CHUNK;
    const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    const onProgress = options.onProgress;
    const count = values.length;
    const hasRGB = Boolean(rgb && rgb.length === count * 3);
    if (count === 0) {
        onProgress?.(1);
        return {
            chunks: [],
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
            totalPoints: 0,
            valOffset: 0,
            valScale: 1,
            hasRGB,
        };
    }

    // Pass 1: global bounds and value range (0.00 -> 0.20)
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let valMin = Infinity, valMax = -Infinity;
    let sliceStart = performance.now();
    for (let i = 0; i < count; ) {
        const end = Math.min(count, i + SLICE_BATCH_POINTS);
        for (; i < end; i++) {
            const b = i * 3;
            const x = positions[b], y = positions[b + 1], z = positions[b + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            const v = values[i];
            if (v < valMin) valMin = v; if (v > valMax) valMax = v;
        }
        if (i < count && performance.now() - sliceStart >= sliceMs) {
            onProgress?.((i / count) * 0.2);
            await yieldToMain();
            sliceStart = performance.now();
        }
    }

    const globalBounds: CloudBounds = { minX, minY, minZ, maxX, maxY, maxZ };
    const valOffset = Number.isFinite(valMin) ? valMin : 0;
    const valScale = (Number.isFinite(valMax) && valMax > valOffset) ? (valMax - valOffset) : 1;
    const invValScale = 65535 / valScale;

    const [nx, ny, nz] = computeGridDimensions(globalBounds, count, targetPointsPerChunk);
    const totalCells = nx * ny * nz;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const spanZ = maxZ - minZ;
    const invDx = spanX > 0 ? nx / spanX : 0;
    const invDy = spanY > 0 ? ny / spanY : 0;
    const invDz = spanZ > 0 ? nz / spanZ : 0;
    const cellSizeX = spanX / nx;
    const cellSizeY = spanY / ny;
    const cellSizeZ = spanZ / nz;

    // Pass 2: count points per cell (0.20 -> 0.45)
    const cellCounts = new Uint32Array(totalCells);
    const cellOfPoint = new Uint16Array(count);
    const nxMax = nx - 1, nyMax = ny - 1, nzMax = nz - 1;
    const nxy = nx * ny;
    sliceStart = performance.now();
    for (let i = 0; i < count; ) {
        const end = Math.min(count, i + SLICE_BATCH_POINTS);
        for (; i < end; i++) {
            const b = i * 3;
            let gx = ((positions[b] - minX) * invDx) | 0;
            let gy = ((positions[b + 1] - minY) * invDy) | 0;
            let gz = ((positions[b + 2] - minZ) * invDz) | 0;
            if (gx < 0) gx = 0; else if (gx > nxMax) gx = nxMax;
            if (gy < 0) gy = 0; else if (gy > nyMax) gy = nyMax;
            if (gz < 0) gz = 0; else if (gz > nzMax) gz = nzMax;
            const cell = gx + gy * nx + gz * nxy;
            cellOfPoint[i] = cell;
            cellCounts[cell]++;
        }
        if (i < count && performance.now() - sliceStart >= sliceMs) {
            onProgress?.(0.2 + (i / count) * 0.25);
            await yieldToMain();
            sliceStart = performance.now();
        }
    }

    const cellToChunk = new Int32Array(totalCells).fill(-1);
    const activeCells: number[] = [];
    for (let c = 0; c < totalCells; c++) {
        if (cellCounts[c] > 0) {
            cellToChunk[c] = activeCells.length;
            activeCells.push(c);
        }
    }

    const numChunks = activeCells.length;
    const pickStride = Math.max(1, Math.ceil(count / MAX_TOTAL_PICK_SAMPLES));
    const maxCellSpan = Math.max(cellSizeX, cellSizeY, cellSizeZ);
    const quantized = maxCellSpan <= MAX_QUANTIZED_SPAN;
    const strideBytes = quantized ? (hasRGB ? 12 : 8) : (hasRGB ? 20 : 16);
    const invCellX = cellSizeX > 0 ? 65535 / cellSizeX : 0;
    const invCellY = cellSizeY > 0 ? 65535 / cellSizeY : 0;
    const invCellZ = cellSizeZ > 0 ? 65535 / cellSizeZ : 0;

    const chunkStrides = new Uint32Array(numChunks);
    const chunkSlots = new Uint32Array(numChunks);
    const chunkCounts = new Uint32Array(numChunks);
    const chunkMinX = new Float32Array(numChunks);
    const chunkMinY = new Float32Array(numChunks);
    const chunkMinZ = new Float32Array(numChunks);

    const packedBytesList: Uint8Array[] = new Array(numChunks);
    const packedU16List: Array<Uint16Array | null> = new Array(numChunks);
    const packedF32List: Array<Float32Array | null> = new Array(numChunks);
    const pickPosList: Float32Array[] = new Array(numChunks);
    const pickCaps = new Uint32Array(numChunks);
    const pickCounts = new Uint32Array(numChunks);

    for (let ci = 0; ci < numChunks; ci++) {
        const cell = activeCells[ci];
        const n = cellCounts[cell];
        const gz = Math.floor(cell / nxy);
        const rem = cell - gz * nxy;
        const gy = Math.floor(rem / nx);
        const gx = rem - gy * nx;

        chunkCounts[ci] = n;
        chunkStrides[ci] = coprimeStride(n);
        chunkMinX[ci] = minX + gx * cellSizeX;
        chunkMinY[ci] = minY + gy * cellSizeY;
        chunkMinZ[ci] = minZ + gz * cellSizeZ;

        const bytes = new Uint8Array(n * strideBytes);
        packedBytesList[ci] = bytes;
        packedU16List[ci] = quantized ? new Uint16Array(bytes.buffer) : null;
        packedF32List[ci] = quantized ? null : new Float32Array(bytes.buffer);
        const pickCap = Math.max(1, Math.ceil(n / pickStride));
        pickCaps[ci] = pickCap;
        pickPosList[ci] = new Float32Array(pickCap * 3);
    }

    // Pass 3: direct bijective scatter (0.45 -> 0.98)
    sliceStart = performance.now();
    if (quantized && hasRGB && rgb) {
        for (let i = 0; i < count; ) {
            const end = Math.min(count, i + SLICE_BATCH_POINTS);
            for (; i < end; i++) {
                const ci = cellToChunk[cellOfPoint[i]];
                const n = chunkCounts[ci];
                const slot = chunkSlots[ci];
                let nextSlot = slot + chunkStrides[ci];
                if (nextSlot >= n) nextSlot -= n;
                chunkSlots[ci] = nextSlot;

                const b = i * 3;
                const x = positions[b], y = positions[b + 1], z = positions[b + 2];
                let qx = ((x - chunkMinX[ci]) * invCellX + 0.5) | 0;
                let qy = ((y - chunkMinY[ci]) * invCellY + 0.5) | 0;
                let qz = ((z - chunkMinZ[ci]) * invCellZ + 0.5) | 0;
                let qv = ((values[i] - valOffset) * invValScale + 0.5) | 0;
                if (qx < 0) qx = 0; else if (qx > 65535) qx = 65535;
                if (qy < 0) qy = 0; else if (qy > 65535) qy = 65535;
                if (qz < 0) qz = 0; else if (qz > 65535) qz = 65535;
                if (qv < 0) qv = 0; else if (qv > 65535) qv = 65535;

                const u16 = packedU16List[ci]!;
                const dst = slot * 6;
                u16[dst] = qx;
                u16[dst + 1] = qy;
                u16[dst + 2] = qz;
                u16[dst + 3] = qv;
                u16[dst + 4] = rgb[b] | (rgb[b + 1] << 8);
                u16[dst + 5] = rgb[b + 2] | 0xFF00;

                if (slot < pickCaps[ci]) {
                    const pk = pickPosList[ci];
                    const pb = slot * 3;
                    pk[pb] = x; pk[pb + 1] = y; pk[pb + 2] = z;
                    if (slot + 1 > pickCounts[ci]) pickCounts[ci] = slot + 1;
                }
            }
            if (i < count && performance.now() - sliceStart >= sliceMs) {
                onProgress?.(0.45 + (i / count) * 0.53);
                await yieldToMain();
                sliceStart = performance.now();
            }
        }
    } else if (quantized) {
        for (let i = 0; i < count; ) {
            const end = Math.min(count, i + SLICE_BATCH_POINTS);
            for (; i < end; i++) {
                const ci = cellToChunk[cellOfPoint[i]];
                const n = chunkCounts[ci];
                const slot = chunkSlots[ci];
                let nextSlot = slot + chunkStrides[ci];
                if (nextSlot >= n) nextSlot -= n;
                chunkSlots[ci] = nextSlot;

                const b = i * 3;
                const x = positions[b], y = positions[b + 1], z = positions[b + 2];
                let qx = ((x - chunkMinX[ci]) * invCellX + 0.5) | 0;
                let qy = ((y - chunkMinY[ci]) * invCellY + 0.5) | 0;
                let qz = ((z - chunkMinZ[ci]) * invCellZ + 0.5) | 0;
                let qv = ((values[i] - valOffset) * invValScale + 0.5) | 0;
                if (qx < 0) qx = 0; else if (qx > 65535) qx = 65535;
                if (qy < 0) qy = 0; else if (qy > 65535) qy = 65535;
                if (qz < 0) qz = 0; else if (qz > 65535) qz = 65535;
                if (qv < 0) qv = 0; else if (qv > 65535) qv = 65535;

                const u16 = packedU16List[ci]!;
                const dst = slot * 4;
                u16[dst] = qx;
                u16[dst + 1] = qy;
                u16[dst + 2] = qz;
                u16[dst + 3] = qv;

                if (slot < pickCaps[ci]) {
                    const pk = pickPosList[ci];
                    const pb = slot * 3;
                    pk[pb] = x; pk[pb + 1] = y; pk[pb + 2] = z;
                    if (slot + 1 > pickCounts[ci]) pickCounts[ci] = slot + 1;
                }
            }
            if (i < count && performance.now() - sliceStart >= sliceMs) {
                onProgress?.(0.45 + (i / count) * 0.53);
                await yieldToMain();
                sliceStart = performance.now();
            }
        }
    } else {
        const f32Stride = hasRGB ? 5 : 4;
        for (let i = 0; i < count; ) {
            const end = Math.min(count, i + SLICE_BATCH_POINTS);
            for (; i < end; i++) {
                const ci = cellToChunk[cellOfPoint[i]];
                const n = chunkCounts[ci];
                const slot = chunkSlots[ci];
                let nextSlot = slot + chunkStrides[ci];
                if (nextSlot >= n) nextSlot -= n;
                chunkSlots[ci] = nextSlot;

                const b = i * 3;
                const x = positions[b], y = positions[b + 1], z = positions[b + 2];
                const f32 = packedF32List[ci]!;
                const dst = slot * f32Stride;
                f32[dst] = x;
                f32[dst + 1] = y;
                f32[dst + 2] = z;
                f32[dst + 3] = values[i];
                if (hasRGB && rgb) {
                    const bytes = packedBytesList[ci];
                    const cb = slot * 20 + 16;
                    bytes[cb] = rgb[b];
                    bytes[cb + 1] = rgb[b + 1];
                    bytes[cb + 2] = rgb[b + 2];
                    bytes[cb + 3] = 255;
                }

                if (slot < pickCaps[ci]) {
                    const pk = pickPosList[ci];
                    const pb = slot * 3;
                    pk[pb] = x; pk[pb + 1] = y; pk[pb + 2] = z;
                    if (slot + 1 > pickCounts[ci]) pickCounts[ci] = slot + 1;
                }
            }
            if (i < count && performance.now() - sliceStart >= sliceMs) {
                onProgress?.(0.45 + (i / count) * 0.53);
                await yieldToMain();
                sliceStart = performance.now();
            }
        }
    }

    const chunks: QuantizedChunkData[] = new Array(numChunks);
    for (let ci = 0; ci < numChunks; ci++) {
        const cMinX = chunkMinX[ci], cMinY = chunkMinY[ci], cMinZ = chunkMinZ[ci];
        const pk = pickPosList[ci];
        const pkTrim = pickCounts[ci] * 3 < pk.length ? pk.subarray(0, pickCounts[ci] * 3) : pk;
        chunks[ci] = makeChunkDescriptor(
            {
                minX: cMinX, minY: cMinY, minZ: cMinZ,
                maxX: cMinX + cellSizeX, maxY: cMinY + cellSizeY, maxZ: cMinZ + cellSizeZ,
            },
            chunkCounts[ci],
            quantized,
            hasRGB,
            strideBytes,
            packedBytesList[ci],
            pkTrim,
        );
    }
    onProgress?.(1);

    return {
        chunks,
        bounds: globalBounds,
        totalPoints: count,
        valOffset,
        valScale,
        hasRGB,
    };
}
