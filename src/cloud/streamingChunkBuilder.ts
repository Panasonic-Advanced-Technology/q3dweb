import { computeGridDimensions, coprimeStride } from './spatialChunker';
import type { CloudBounds, QuantizedChunkData, StreamingCloudInitOptions } from './types';

const MAX_TOTAL_PICK_SAMPLES = 400_000;

function nextPowerOfTwo(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

function makeDescriptor(
    bounds: CloudBounds,
    pointCount: number,
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
        isQuantized: true,
        hasRGB,
        strideBytes,
        packedData,
        pickPositions,
    };
}

interface ActiveCellBuffer {
    bytes: Uint8Array;
    u16: Uint16Array;
    count: number;
    slot: number;
    capacity: number;
    isFullPow2Buffer: boolean;
    cellMinX: number;
    cellMinY: number;
    cellMinZ: number;
}

/**
 * Zero-copy direct-shuffling streaming spatial chunk builder designed for 100M+ points.
 * Uses power-of-two full chunk buffers with an odd golden-ratio stride so every full chunk
 * is written directly into its final bijectively shuffled order with zero copy on flush.
 */
export class StreamingChunkBuilder {
    readonly hasRGB: boolean;
    readonly strideBytes: number;
    readonly valOffset: number;
    readonly valScale: number;
    private readonly invValScale: number;
    private readonly nx: number;
    private readonly ny: number;
    private readonly nz: number;
    private readonly nxy: number;
    private readonly minX: number;
    private readonly minY: number;
    private readonly minZ: number;
    private readonly invDx: number;
    private readonly invDy: number;
    private readonly invDz: number;
    private readonly cellSizeX: number;
    private readonly cellSizeY: number;
    private readonly cellSizeZ: number;
    private readonly invCellX: number;
    private readonly invCellY: number;
    private readonly invCellZ: number;
    private readonly maxPointsPerChunk: number;
    private readonly chunkMask: number;
    private readonly chunkOddStride: number;
    private readonly eagerFullCells: boolean;
    private readonly pickPerChunk: number;
    private readonly cells: Array<ActiveCellBuffer | null>;
    private totalPoints = 0;
    private globalMinX = Infinity;
    private globalMinY = Infinity;
    private globalMinZ = Infinity;
    private globalMaxX = -Infinity;
    private globalMaxY = -Infinity;
    private globalMaxZ = -Infinity;

    constructor(options: StreamingCloudInitOptions) {
        this.hasRGB = options.hasRGB;
        this.strideBytes = options.hasRGB ? 12 : 8;
        this.valOffset = options.valMin ?? 0;
        const vMax = options.valMax ?? 255;
        this.valScale = vMax > this.valOffset ? vMax - this.valOffset : 1;
        this.invValScale = 65535 / this.valScale;

        const defaultChunkCap = options.totalPointsEstimate > 10_000_000 ? 262_144 : 65_536;
        this.maxPointsPerChunk = nextPowerOfTwo(Math.max(8192, options.maxPointsPerChunk ?? defaultChunkCap));
        this.chunkMask = this.maxPointsPerChunk - 1;
        // Any odd integer is coprime to 2^k, guaranteeing an O(1) bitmask bijection.
        this.chunkOddStride = (Math.floor(this.maxPointsPerChunk * 0.6180339887498949) | 1);

        const estimatedChunks = Math.max(16, Math.ceil(options.totalPointsEstimate / this.maxPointsPerChunk));
        const maxCells = Math.min(256, Math.max(64, Math.ceil(estimatedChunks * 0.5)));
        const [nx, ny, nz] = computeGridDimensions(options.bounds, options.totalPointsEstimate, this.maxPointsPerChunk, maxCells);
        this.nx = nx; this.ny = ny; this.nz = nz; this.nxy = nx * ny;
        this.eagerFullCells = (options.totalPointsEstimate / (nx * ny * nz)) >= this.maxPointsPerChunk * 0.5;
        this.minX = options.bounds.minX;
        this.minY = options.bounds.minY;
        this.minZ = options.bounds.minZ;
        const spanX = Math.max(options.bounds.maxX - options.bounds.minX, 1e-3);
        const spanY = Math.max(options.bounds.maxY - options.bounds.minY, 1e-3);
        const spanZ = Math.max(options.bounds.maxZ - options.bounds.minZ, 1e-3);
        this.cellSizeX = spanX / nx;
        this.cellSizeY = spanY / ny;
        this.cellSizeZ = spanZ / nz;
        this.invCellX = 65535 / this.cellSizeX;
        this.invCellY = 65535 / this.cellSizeY;
        this.invCellZ = 65535 / this.cellSizeZ;
        this.invDx = nx / spanX;
        this.invDy = ny / spanY;
        this.invDz = nz / spanZ;
        this.pickPerChunk = Math.max(64, Math.min(512, Math.floor(MAX_TOTAL_PICK_SAMPLES / estimatedChunks)));
        this.cells = new Array(nx * ny * nz).fill(null);
    }

    getTotalPoints(): number {
        return this.totalPoints;
    }

    getGlobalBounds(): CloudBounds {
        if (this.totalPoints === 0) {
            return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
        }
        return {
            minX: this.globalMinX, minY: this.globalMinY, minZ: this.globalMinZ,
            maxX: this.globalMaxX, maxY: this.globalMaxY, maxZ: this.globalMaxZ,
        };
    }

    /** Push a single point directly without intermediate staging arrays (used by LAS direct decoder). */
    pushPoint(
        x: number,
        y: number,
        z: number,
        v: number,
        r: number,
        g: number,
        b: number,
        onChunkReady: (chunk: QuantizedChunkData) => void,
    ): void {
        if (x < this.globalMinX) this.globalMinX = x; if (x > this.globalMaxX) this.globalMaxX = x;
        if (y < this.globalMinY) this.globalMinY = y; if (y > this.globalMaxY) this.globalMaxY = y;
        if (z < this.globalMinZ) this.globalMinZ = z; if (z > this.globalMaxZ) this.globalMaxZ = z;

        let gx = ((x - this.minX) * this.invDx) | 0;
        let gy = ((y - this.minY) * this.invDy) | 0;
        let gz = ((z - this.minZ) * this.invDz) | 0;
        if (gx < 0) gx = 0; else if (gx >= this.nx) gx = this.nx - 1;
        if (gy < 0) gy = 0; else if (gy >= this.ny) gy = this.ny - 1;
        if (gz < 0) gz = 0; else if (gz >= this.nz) gz = this.nz - 1;
        const cellIdx = gx + gy * this.nx + gz * this.nxy;

        let cell = this.cells[cellIdx];
        if (!cell) {
            cell = this.allocCell(gx, gy, gz);
            this.cells[cellIdx] = cell;
        }
        this.writePointToCell(cell, x, y, z, v, r, g, b, onChunkReady);
        this.totalPoints++;
    }

    pushBatch(
        positions: Float32Array,
        values: Float32Array,
        rgb: Uint8Array | undefined,
        pointCount: number,
        onChunkReady: (chunk: QuantizedChunkData) => void,
    ): void {
        const hasRGB = this.hasRGB && rgb !== undefined;
        const nx = this.nx, nxy = this.nxy;
        const nxMax = nx - 1, nyMax = this.ny - 1, nzMax = this.nz - 1;
        const minX = this.minX, minY = this.minY, minZ = this.minZ;
        const invDx = this.invDx, invDy = this.invDy, invDz = this.invDz;
        const invCellX = this.invCellX, invCellY = this.invCellY, invCellZ = this.invCellZ;
        const valOffset = this.valOffset, invValScale = this.invValScale;
        const maxPerChunk = this.maxPointsPerChunk;
        const mask = this.chunkMask;
        const oddStride = this.chunkOddStride;
        const cells = this.cells;

        let gMinX = this.globalMinX, gMinY = this.globalMinY, gMinZ = this.globalMinZ;
        let gMaxX = this.globalMaxX, gMaxY = this.globalMaxY, gMaxZ = this.globalMaxZ;

        for (let i = 0; i < pointCount; i++) {
            const b = i * 3;
            const x = positions[b], y = positions[b + 1], z = positions[b + 2];
            if (x < gMinX) gMinX = x; if (x > gMaxX) gMaxX = x;
            if (y < gMinY) gMinY = y; if (y > gMaxY) gMaxY = y;
            if (z < gMinZ) gMinZ = z; if (z > gMaxZ) gMaxZ = z;

            let gx = ((x - minX) * invDx) | 0;
            let gy = ((y - minY) * invDy) | 0;
            let gz = ((z - minZ) * invDz) | 0;
            if (gx < 0) gx = 0; else if (gx > nxMax) gx = nxMax;
            if (gy < 0) gy = 0; else if (gy > nyMax) gy = nyMax;
            if (gz < 0) gz = 0; else if (gz > nzMax) gz = nzMax;
            const cellIdx = gx + gy * nx + gz * nxy;

            let cell = cells[cellIdx];
            if (!cell) {
                cell = this.allocCell(gx, gy, gz);
                cells[cellIdx] = cell;
            }

            let idx: number;
            if (cell.isFullPow2Buffer) {
                idx = cell.slot;
                cell.slot = (idx + oddStride) & mask;
                cell.count++;
            } else {
                idx = cell.count++;
                if (idx >= cell.capacity) {
                    this.promoteCell(cell);
                    idx = cell.slot;
                    cell.slot = (idx + oddStride) & mask;
                }
            }

            let qx = ((x - cell.cellMinX) * invCellX + 0.5) | 0;
            let qy = ((y - cell.cellMinY) * invCellY + 0.5) | 0;
            let qz = ((z - cell.cellMinZ) * invCellZ + 0.5) | 0;
            let qv = ((values[i] - valOffset) * invValScale + 0.5) | 0;
            if (qx < 0) qx = 0; else if (qx > 65535) qx = 65535;
            if (qy < 0) qy = 0; else if (qy > 65535) qy = 65535;
            if (qz < 0) qz = 0; else if (qz > 65535) qz = 65535;
            if (qv < 0) qv = 0; else if (qv > 65535) qv = 65535;

            const u16 = cell.u16;
            if (hasRGB) {
                const dst = idx * 6;
                u16[dst] = qx;
                u16[dst + 1] = qy;
                u16[dst + 2] = qz;
                u16[dst + 3] = qv;
                u16[dst + 4] = rgb![b] | (rgb![b + 1] << 8);
                u16[dst + 5] = rgb![b + 2] | 0xFF00;
            } else {
                const dst = idx * 4;
                u16[dst] = qx;
                u16[dst + 1] = qy;
                u16[dst + 2] = qz;
                u16[dst + 3] = qv;
            }

            if (cell.count >= maxPerChunk) {
                onChunkReady(this.flushFullCellZeroCopy(cell));
            }
        }

        this.globalMinX = gMinX; this.globalMinY = gMinY; this.globalMinZ = gMinZ;
        this.globalMaxX = gMaxX; this.globalMaxY = gMaxY; this.globalMaxZ = gMaxZ;
        this.totalPoints += pointCount;
    }

    finish(onChunkReady: (chunk: QuantizedChunkData) => void): void {
        for (let i = 0; i < this.cells.length; i++) {
            const cell = this.cells[i];
            if (cell && cell.count > 0) {
                onChunkReady(this.flushPartialCell(cell));
            }
            this.cells[i] = null;
        }
    }

    private writePointToCell(
        cell: ActiveCellBuffer,
        x: number,
        y: number,
        z: number,
        v: number,
        r: number,
        g: number,
        b: number,
        onChunkReady: (chunk: QuantizedChunkData) => void,
    ): void {
        let idx: number;
        if (cell.isFullPow2Buffer) {
            idx = cell.slot;
            cell.slot = (idx + this.chunkOddStride) & this.chunkMask;
            cell.count++;
        } else {
            idx = cell.count++;
            if (idx >= cell.capacity) {
                this.promoteCell(cell);
                idx = cell.slot;
                cell.slot = (idx + this.chunkOddStride) & this.chunkMask;
            }
        }

        let qx = ((x - cell.cellMinX) * this.invCellX + 0.5) | 0;
        let qy = ((y - cell.cellMinY) * this.invCellY + 0.5) | 0;
        let qz = ((z - cell.cellMinZ) * this.invCellZ + 0.5) | 0;
        let qv = ((v - this.valOffset) * this.invValScale + 0.5) | 0;
        if (qx < 0) qx = 0; else if (qx > 65535) qx = 65535;
        if (qy < 0) qy = 0; else if (qy > 65535) qy = 65535;
        if (qz < 0) qz = 0; else if (qz > 65535) qz = 65535;
        if (qv < 0) qv = 0; else if (qv > 65535) qv = 65535;

        const u16 = cell.u16;
        if (this.hasRGB) {
            const dst = idx * 6;
            u16[dst] = qx;
            u16[dst + 1] = qy;
            u16[dst + 2] = qz;
            u16[dst + 3] = qv;
            u16[dst + 4] = r | (g << 8);
            u16[dst + 5] = b | 0xFF00;
        } else {
            const dst = idx * 4;
            u16[dst] = qx;
            u16[dst + 1] = qy;
            u16[dst + 2] = qz;
            u16[dst + 3] = qv;
        }

        if (cell.count >= this.maxPointsPerChunk) {
            onChunkReady(this.flushFullCellZeroCopy(cell));
        }
    }

    /**
     * Decode raw LAS point records directly into quantized GPU-ready chunks
     * without allocating or copying intermediate Float32 staging buffers.
     */
    pushLASRecords(
        view: DataView,
        recordCount: number,
        startIndex: number,
        ratio: number,
        rowSize: number,
        xScale: number,
        yScale: number,
        zScale: number,
        xBias: number,
        yBias: number,
        zBias: number,
        rgbOff: number,
        onChunkReady: (chunk: QuantizedChunkData) => void,
    ): { emitted: number; minVal: number; maxVal: number; hasNonZeroRGB: boolean } {
        const hasRGB = this.hasRGB && rgbOff !== -1;
        const nx = this.nx, nxy = this.nxy;
        const nxMax = nx - 1, nyMax = this.ny - 1, nzMax = this.nz - 1;
        const minX = this.minX, minY = this.minY, minZ = this.minZ;
        const invDx = this.invDx, invDy = this.invDy, invDz = this.invDz;
        const invCellX = this.invCellX, invCellY = this.invCellY, invCellZ = this.invCellZ;
        const valOffset = this.valOffset, invValScale = this.invValScale;
        const maxPerChunk = this.maxPointsPerChunk;
        const mask = this.chunkMask;
        const oddStride = this.chunkOddStride;
        const cells = this.cells;

        let gMinX = this.globalMinX, gMinY = this.globalMinY, gMinZ = this.globalMinZ;
        let gMaxX = this.globalMaxX, gMaxY = this.globalMaxY, gMaxZ = this.globalMaxZ;
        let minVal = Infinity, maxVal = -Infinity;
        let hasNonZeroRGB = false;
        let emitted = 0;

        for (let i = startIndex; i < recordCount; i += ratio) {
            const off = i * rowSize;
            const x = view.getInt32(off, true) * xScale + xBias;
            const y = view.getInt32(off + 4, true) * yScale + yBias;
            const z = view.getInt32(off + 8, true) * zScale + zBias;
            const val = view.getUint16(off + 12, true);
            if (x < gMinX) gMinX = x; if (x > gMaxX) gMaxX = x;
            if (y < gMinY) gMinY = y; if (y > gMaxY) gMaxY = y;
            if (z < gMinZ) gMinZ = z; if (z > gMaxZ) gMaxZ = z;
            if (val < minVal) minVal = val; if (val > maxVal) maxVal = val;

            let gx = ((x - minX) * invDx) | 0;
            let gy = ((y - minY) * invDy) | 0;
            let gz = ((z - minZ) * invDz) | 0;
            if (gx < 0) gx = 0; else if (gx > nxMax) gx = nxMax;
            if (gy < 0) gy = 0; else if (gy > nyMax) gy = nyMax;
            if (gz < 0) gz = 0; else if (gz > nzMax) gz = nzMax;
            const cellIdx = gx + gy * nx + gz * nxy;

            let cell = cells[cellIdx];
            if (!cell) {
                cell = this.allocCell(gx, gy, gz);
                cells[cellIdx] = cell;
            }

            let idx: number;
            if (cell.isFullPow2Buffer) {
                idx = cell.slot;
                cell.slot = (idx + oddStride) & mask;
                cell.count++;
            } else {
                idx = cell.count++;
                if (idx >= cell.capacity) {
                    this.promoteCell(cell);
                    idx = cell.slot;
                    cell.slot = (idx + oddStride) & mask;
                }
            }

            let qx = ((x - cell.cellMinX) * invCellX + 0.5) | 0;
            let qy = ((y - cell.cellMinY) * invCellY + 0.5) | 0;
            let qz = ((z - cell.cellMinZ) * invCellZ + 0.5) | 0;
            let qv = ((val - valOffset) * invValScale + 0.5) | 0;
            if (qx < 0) qx = 0; else if (qx > 65535) qx = 65535;
            if (qy < 0) qy = 0; else if (qy > 65535) qy = 65535;
            if (qz < 0) qz = 0; else if (qz > 65535) qz = 65535;
            if (qv < 0) qv = 0; else if (qv > 65535) qv = 65535;

            const u16 = cell.u16;
            if (hasRGB) {
                let r = view.getUint16(off + rgbOff, true);
                let g = view.getUint16(off + rgbOff + 2, true);
                let b = view.getUint16(off + rgbOff + 4, true);
                if ((r | g | b) > 255) { r >>>= 8; g >>>= 8; b >>>= 8; }
                if (!hasNonZeroRGB && (r | g | b) > 0) hasNonZeroRGB = true;
                const dst = idx * 6;
                u16[dst] = qx;
                u16[dst + 1] = qy;
                u16[dst + 2] = qz;
                u16[dst + 3] = qv;
                u16[dst + 4] = r | (g << 8);
                u16[dst + 5] = b | 0xFF00;
            } else {
                const dst = idx * 4;
                u16[dst] = qx;
                u16[dst + 1] = qy;
                u16[dst + 2] = qz;
                u16[dst + 3] = qv;
            }

            if (cell.count >= maxPerChunk) {
                onChunkReady(this.flushFullCellZeroCopy(cell));
            }
            emitted++;
        }

        this.globalMinX = gMinX; this.globalMinY = gMinY; this.globalMinZ = gMinZ;
        this.globalMaxX = gMaxX; this.globalMaxY = gMaxY; this.globalMaxZ = gMaxZ;
        this.totalPoints += emitted;
        return { emitted, minVal, maxVal, hasNonZeroRGB };
    }

    private allocCell(gx: number, gy: number, gz: number): ActiveCellBuffer {
        const cap = this.eagerFullCells ? this.maxPointsPerChunk : Math.min(this.maxPointsPerChunk, 16384);
        const bytes = new Uint8Array(cap * this.strideBytes);
        return {
            bytes,
            u16: new Uint16Array(bytes.buffer),
            count: 0,
            slot: 0,
            capacity: cap,
            isFullPow2Buffer: cap === this.maxPointsPerChunk,
            cellMinX: this.minX + gx * this.cellSizeX,
            cellMinY: this.minY + gy * this.cellSizeY,
            cellMinZ: this.minZ + gz * this.cellSizeZ,
        };
    }

    private promoteCell(cell: ActiveCellBuffer): void {
        const prevCount = cell.count - 1;
        const cap = this.maxPointsPerChunk;
        const nextBytes = new Uint8Array(cap * this.strideBytes);
        const nextU16 = new Uint16Array(nextBytes.buffer);
        const srcU16 = cell.u16;
        const step = this.hasRGB ? 6 : 4;
        const mask = this.chunkMask;
        const stride = this.chunkOddStride;

        let slot = 0;
        for (let i = 0; i < prevCount; i++) {
            const s = i * step;
            const d = slot * step;
            for (let k = 0; k < step; k++) nextU16[d + k] = srcU16[s + k];
            slot = (slot + stride) & mask;
        }
        cell.bytes = nextBytes;
        cell.u16 = nextU16;
        cell.capacity = cap;
        cell.slot = slot;
        cell.isFullPow2Buffer = true;
    }

    private flushFullCellZeroCopy(cell: ActiveCellBuffer): QuantizedChunkData {
        const n = cell.count;
        const readyBytes = cell.bytes;
        const pickPositions = this.extractPickSamples(cell.u16, n, cell.cellMinX, cell.cellMinY, cell.cellMinZ);

        const freshBytes = new Uint8Array(this.maxPointsPerChunk * this.strideBytes);
        cell.bytes = freshBytes;
        cell.u16 = new Uint16Array(freshBytes.buffer);
        cell.count = 0;
        cell.slot = 0;
        cell.capacity = this.maxPointsPerChunk;
        cell.isFullPow2Buffer = true;

        return makeDescriptor(
            {
                minX: cell.cellMinX, minY: cell.cellMinY, minZ: cell.cellMinZ,
                maxX: cell.cellMinX + this.cellSizeX, maxY: cell.cellMinY + this.cellSizeY, maxZ: cell.cellMinZ + this.cellSizeZ,
            },
            n, this.hasRGB, this.strideBytes, readyBytes, pickPositions,
        );
    }

    private flushPartialCell(cell: ActiveCellBuffer): QuantizedChunkData {
        const n = cell.count;
        const outBytes = new Uint8Array(n * this.strideBytes);
        const outU16 = new Uint16Array(outBytes.buffer);
        const srcU16 = cell.u16;
        const step = this.hasRGB ? 6 : 4;
        const dstStride = coprimeStride(n);

        if (cell.isFullPow2Buffer) {
            let srcSlot = 0;
            let dstSlot = 0;
            for (let i = 0; i < n; i++) {
                const s = srcSlot * step;
                const d = dstSlot * step;
                for (let k = 0; k < step; k++) outU16[d + k] = srcU16[s + k];
                srcSlot = (srcSlot + this.chunkOddStride) & this.chunkMask;
                dstSlot += dstStride;
                if (dstSlot >= n) dstSlot -= n;
            }
        } else {
            let dstSlot = 0;
            for (let i = 0; i < n; i++) {
                const s = i * step;
                const d = dstSlot * step;
                for (let k = 0; k < step; k++) outU16[d + k] = srcU16[s + k];
                dstSlot += dstStride;
                if (dstSlot >= n) dstSlot -= n;
            }
        }

        const pickPositions = this.extractPickSamples(outU16, n, cell.cellMinX, cell.cellMinY, cell.cellMinZ);
        cell.bytes = new Uint8Array(0);
        cell.u16 = new Uint16Array(0);
        cell.count = 0;

        return makeDescriptor(
            {
                minX: cell.cellMinX, minY: cell.cellMinY, minZ: cell.cellMinZ,
                maxX: cell.cellMinX + this.cellSizeX, maxY: cell.cellMinY + this.cellSizeY, maxZ: cell.cellMinZ + this.cellSizeZ,
            },
            n, this.hasRGB, this.strideBytes, outBytes, pickPositions,
        );
    }

    private extractPickSamples(u16: Uint16Array, n: number, minX: number, minY: number, minZ: number): Float32Array {
        const step = this.hasRGB ? 6 : 4;
        const pickCount = Math.min(n, this.pickPerChunk);
        const pickPositions = new Float32Array(pickCount * 3);
        const sx = this.cellSizeX / 65535;
        const sy = this.cellSizeY / 65535;
        const sz = this.cellSizeZ / 65535;
        for (let i = 0; i < pickCount; i++) {
            const o = i * step;
            const pb = i * 3;
            pickPositions[pb] = minX + u16[o] * sx;
            pickPositions[pb + 1] = minY + u16[o + 1] * sy;
            pickPositions[pb + 2] = minZ + u16[o + 2] * sz;
        }
        return pickPositions;
    }
}
