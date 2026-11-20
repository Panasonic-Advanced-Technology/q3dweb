export type CloudColorMode = 'I' | 'RGB' | 'FLAT';
export type CloudPointType = 'PIXEL' | 'SQUARE' | 'SPHERE';

export interface CloudBounds {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

export interface QuantizedChunkData {
    readonly bounds: CloudBounds;
    readonly centerX: number;
    readonly centerY: number;
    readonly centerZ: number;
    readonly radius: number;
    readonly pointCount: number;
    readonly isQuantized: boolean;
    readonly hasRGB: boolean;
    readonly strideBytes: number;
    /** Interleaved vertex payload; released after GPU upload. */
    packedData: Uint8Array | null;
    /** Compact world-space xyz samples for fast raycast measurement after CPU release. */
    readonly pickPositions: Float32Array;
}

export interface StreamingCloudInitOptions {
    totalPointsEstimate: number;
    hasRGB: boolean;
    bounds: CloudBounds;
    valMin?: number;
    valMax?: number;
    maxPointsPerChunk?: number;
}

export interface CloudRenderUniformSnapshot {
    pointSize: number;
    alpha: number;
    vmin: number;
    vmax: number;
    colorMode: number; // 0 = I, 1 = RGB, 2 = FLAT
    flatR: number;
    flatG: number;
    flatB: number;
    pointType: number; // 0 = PIXEL, 1 = SQUARE, 2 = SPHERE
    viewportHeight: number;
}

export interface CloudRenderStats {
    totalPoints: number;
    chunkCount: number;
    visibleChunks: number;
    drawnPoints: number;
    vramBytes: number;
    cpuPickBytes: number;
    interactivePointBudget: number;
    refinementProgress: number;
    refinementComplete: boolean;
    lastFrameMs: number;
    mode: 'direct' | 'interactive' | 'refining' | 'cached';
}
