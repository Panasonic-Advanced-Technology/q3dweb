import type { CloudBounds, QuantizedChunkData } from './types';
export { StreamingChunkBuilder } from './streamingChunkBuilder';

const MAX_QUANTIZED_SPAN = 1000;
const MAX_TOTAL_PICK_SAMPLES = 400_000;
const DEFAULT_TARGET_POINTS_PER_CHUNK = 65_536;
const MAX_GRID_CELLS = 2048;

export interface SpatialBuildResult {
    chunks: QuantizedChunkData[];
    bounds: CloudBounds;
    totalPoints: number;
    valOffset: number;
    valScale: number;
    hasRGB: boolean;
}

function gcd(a: number, b: number): number {
    let x = a;
    let y = b;
    while (y !== 0) {
        const t = x % y;
        x = y;
        y = t;
    }
    return x;
}

/** Deterministic golden-ratio coprime stride for O(1) bijective in-chunk shuffling. */
export function coprimeStride(n: number): number {
    if (n <= 2) return 1;
    let s = Math.max(1, Math.floor(n * 0.6180339887498949));
    if (s >= n) s = n - 1;
    while (gcd(s, n) !== 1) {
        s++;
        if (s >= n) s = 1;
    }
    return s;
}

export function computeGridDimensions(
    bounds: CloudBounds,
    pointCount: number,
    targetPointsPerChunk: number = DEFAULT_TARGET_POINTS_PER_CHUNK,
    maxCells: number = MAX_GRID_CELLS,
): [number, number, number] {
    const desiredCells = Math.max(8, Math.min(maxCells, Math.ceil(pointCount / Math.max(targetPointsPerChunk, 1024))));
    const dx = Math.max(bounds.maxX - bounds.minX, 1e-3);
    const dy = Math.max(bounds.maxY - bounds.minY, 1e-3);
    const dz = Math.max(bounds.maxZ - bounds.minZ, 1e-3);
    const vol = dx * dy * dz;
    const cellSide = Math.cbrt(vol / desiredCells);

    let nx = Math.max(1, Math.round(dx / cellSide));
    let ny = Math.max(1, Math.round(dy / cellSide));
    let nz = Math.max(1, Math.round(dz / cellSide));

    while (nx * ny * nz > maxCells) {
        if (nx >= ny && nx >= nz && nx > 1) nx--;
        else if (ny >= nx && ny >= nz && ny > 1) ny--;
        else if (nz > 1) nz--;
        else break;
    }
    return [nx, ny, nz];
}

function makeChunkDescriptor(
    bounds: CloudBounds,
    pointCount: number,
    isQuantized: boolean,
    hasRGB: boolean,
    strideBytes: number,
    packedData: Uint8Array,
    pickPositions: Float32Array,
): QuantizedChunkData {
    const cx = (bounds.minX + bounds.maxX) * 0.5;
    const cy = (bounds.minY + bounds.maxY) * 0.5;
    const cz = (bounds.minZ + bounds.maxZ) * 0.5;
    const hx = (bounds.maxX - bounds.minX) * 0.5;
    const hy = (bounds.maxY - bounds.minY) * 0.5;
    const hz = (bounds.maxZ - bounds.minZ) * 0.5;
    return {
        bounds,
        centerX: cx,
        centerY: cy,
        centerZ: cz,
        radius: Math.hypot(hx, hy, hz),
        pointCount,
        isQuantized,
        hasRGB,
        strideBytes,
        packedData,
        pickPositions,
    };
}

/**
 * Partition an in-memory point cloud into spatially localized, quantized,
 * bijectively shuffled GPU-ready chunks.
 */
export function buildSpatialChunks(
    positions: Float32Array,
    values: Float32Array,
    rgb?: Uint8Array,
    targetPointsPerChunk: number = DEFAULT_TARGET_POINTS_PER_CHUNK,
): SpatialBuildResult {
    const count = values.length;
    const hasRGB = Boolean(rgb && rgb.length === count * 3);
    if (count === 0) {
        return {
            chunks: [],
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
            totalPoints: 0,
            valOffset: 0,
            valScale: 1,
            hasRGB,
        };
    }

    // Pass 1: global bounds and value range
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let valMin = Infinity, valMax = -Infinity;
    for (let i = 0; i < count; i++) {
        const b = i * 3;
        const x = positions[b], y = positions[b + 1], z = positions[b + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        const v = values[i];
        if (v < valMin) valMin = v; if (v > valMax) valMax = v;
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

    // Pass 2: count points per cell (grid cell bounds already give sub-millimeter 16-bit precision).
    const cellCounts = new Uint32Array(totalCells);
    const cellOfPoint = new Uint16Array(count);

    const nxMax = nx - 1, nyMax = ny - 1, nzMax = nz - 1;
    const nxy = nx * ny;
    for (let i = 0; i < count; i++) {
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

    // Pass 3: specialized hot loops for direct bijective scatter
    if (quantized && hasRGB && rgb) {
        for (let i = 0; i < count; i++) {
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
    } else if (quantized) {
        for (let i = 0; i < count; i++) {
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
    } else {
        const f32Stride = hasRGB ? 5 : 4;
        for (let i = 0; i < count; i++) {
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

    return {
        chunks,
        bounds: globalBounds,
        totalPoints: count,
        valOffset,
        valScale,
        hasRGB,
    };
}
