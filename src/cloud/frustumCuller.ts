import * as THREE from 'three';

export interface ChunkCullMetadata {
    count: number;
    minX: Float32Array;
    minY: Float32Array;
    minZ: Float32Array;
    maxX: Float32Array;
    maxY: Float32Array;
    maxZ: Float32Array;
    centerX: Float32Array;
    centerY: Float32Array;
    centerZ: Float32Array;
    radius: Float32Array;
    pointCount: Uint32Array;
}

export interface VisibleChunkList {
    /** Indices into the chunk array, sorted by descending visual priority. */
    indices: Int32Array;
    /** Screen-space projected pixel radius (or priority weight) per visible entry. */
    weights: Float32Array;
    /** Number of valid entries in indices / weights. */
    length: number;
    /** Sum of all pointCount values across visible chunks. */
    totalVisiblePoints: number;
}

const _projScreen = new THREE.Matrix4();
// 6 frustum planes packed as (nx, ny, nz, d) * 6 = 24 floats
const _planes = new Float32Array(24);

function extractFrustumPlanes(m: Float32Array | number[]): void {
    const me0 = m[0], me1 = m[1], me2 = m[2], me3 = m[3];
    const me4 = m[4], me5 = m[5], me6 = m[6], me7 = m[7];
    const me8 = m[8], me9 = m[9], me10 = m[10], me11 = m[11];
    const me12 = m[12], me13 = m[13], me14 = m[14], me15 = m[15];

    // Right, Left, Bottom, Top, Far, Near
    setPlane(0, me3 - me0, me7 - me4, me11 - me8, me15 - me12);
    setPlane(1, me3 + me0, me7 + me4, me11 + me8, me15 + me12);
    setPlane(2, me3 + me1, me7 + me5, me11 + me9, me15 + me13);
    setPlane(3, me3 - me1, me7 - me5, me11 - me9, me15 - me13);
    setPlane(4, me3 - me2, me7 - me6, me11 - me10, me15 - me14);
    setPlane(5, me3 + me2, me7 + me6, me11 + me10, me15 + me14);
}

function setPlane(idx: number, a: number, b: number, c: number, d: number): void {
    const len = Math.hypot(a, b, c);
    const inv = len > 0 ? 1 / len : 1;
    const o = idx * 4;
    _planes[o] = a * inv;
    _planes[o + 1] = b * inv;
    _planes[o + 2] = c * inv;
    _planes[o + 3] = d * inv;
}

/**
 * Zero-allocation AABB frustum culling + screen-space priority computation.
 */
export function cullAndPrioritizeChunks(
    meta: ChunkCullMetadata,
    camera: THREE.PerspectiveCamera,
    viewportHeight: number,
    out: VisibleChunkList,
): void {
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    extractFrustumPlanes(_projScreen.elements);

    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;
    const focalPx = Math.max(viewportHeight, 1) * 0.5 * Math.abs(camera.projectionMatrix.elements[5] || 1);
    const near = Math.max(camera.near, 0.01);

    const p0x = _planes[0], p0y = _planes[1], p0z = _planes[2], p0d = _planes[3];
    const p1x = _planes[4], p1y = _planes[5], p1z = _planes[6], p1d = _planes[7];
    const p2x = _planes[8], p2y = _planes[9], p2z = _planes[10], p2d = _planes[11];
    const p3x = _planes[12], p3y = _planes[13], p3z = _planes[14], p3d = _planes[15];
    const p4x = _planes[16], p4y = _planes[17], p4z = _planes[18], p4d = _planes[19];
    const p5x = _planes[20], p5y = _planes[21], p5z = _planes[22], p5d = _planes[23];

    const minX = meta.minX, minY = meta.minY, minZ = meta.minZ;
    const maxX = meta.maxX, maxY = meta.maxY, maxZ = meta.maxZ;
    const cxArr = meta.centerX, cyArr = meta.centerY, czArr = meta.centerZ;
    const rArr = meta.radius, ptArr = meta.pointCount;
    const indices = out.indices;
    const weights = out.weights;

    let visLen = 0;
    let totalPts = 0;
    const n = meta.count;

    for (let i = 0; i < n; i++) {
        const x0 = minX[i], x1 = maxX[i];
        const y0 = minY[i], y1 = maxY[i];
        const z0 = minZ[i], z1 = maxZ[i];

        if (p0x * (p0x > 0 ? x1 : x0) + p0y * (p0y > 0 ? y1 : y0) + p0z * (p0z > 0 ? z1 : z0) + p0d < 0) continue;
        if (p1x * (p1x > 0 ? x1 : x0) + p1y * (p1y > 0 ? y1 : y0) + p1z * (p1z > 0 ? z1 : z0) + p1d < 0) continue;
        if (p2x * (p2x > 0 ? x1 : x0) + p2y * (p2y > 0 ? y1 : y0) + p2z * (p2z > 0 ? z1 : z0) + p2d < 0) continue;
        if (p3x * (p3x > 0 ? x1 : x0) + p3y * (p3y > 0 ? y1 : y0) + p3z * (p3z > 0 ? z1 : z0) + p3d < 0) continue;
        if (p4x * (p4x > 0 ? x1 : x0) + p4y * (p4y > 0 ? y1 : y0) + p4z * (p4z > 0 ? z1 : z0) + p4d < 0) continue;
        if (p5x * (p5x > 0 ? x1 : x0) + p5y * (p5y > 0 ? y1 : y0) + p5z * (p5z > 0 ? z1 : z0) + p5d < 0) continue;

        const dx = cxArr[i] - camX;
        const dy = cyArr[i] - camY;
        const dz = czArr[i] - camZ;
        const dist = Math.hypot(dx, dy, dz);
        const effDist = Math.max(dist - rArr[i], near);
        const projRadius = (rArr[i] * focalPx) / effDist;
        const pts = ptArr[i];

        indices[visLen] = i;
        // Sublinear screen-footprint weight preserves distant silhouette coverage while prioritizing near chunks.
        weights[visLen] = pts * Math.sqrt(Math.max(1, Math.min(projRadius, 256)));
        visLen++;
        totalPts += pts;
    }

    out.length = visLen;
    out.totalVisiblePoints = totalPts;
}

/**
 * Compute per-chunk draw counts given a total point budget.
 * Allocates proportionally to visual weight while guaranteeing minimum visibility
 * for every frustum-visible chunk and capping at each chunk's pointCount.
 */
export function allocateChunkDrawBudget(
    visible: VisibleChunkList,
    chunkPointCounts: Uint32Array,
    budget: number,
    outDrawCounts: Uint32Array,
): number {
    const n = visible.length;
    if (n === 0) return 0;

    if (visible.totalVisiblePoints <= budget) {
        for (let i = 0; i < n; i++) {
            outDrawCounts[i] = chunkPointCounts[visible.indices[i]];
        }
        return visible.totalVisiblePoints;
    }

    let totalWeight = 0;
    for (let i = 0; i < n; i++) totalWeight += visible.weights[i];
    if (totalWeight <= 0) totalWeight = 1;

    const minPerChunk = Math.max(1, Math.min(64, Math.floor(budget / Math.max(n * 4, 1))));
    let allocated = 0;
    const scale = budget / totalWeight;
    for (let i = 0; i < n; i++) {
        const cap = chunkPointCounts[visible.indices[i]];
        let want = Math.ceil(visible.weights[i] * scale);
        if (want < minPerChunk) want = minPerChunk;
        if (want > cap) want = cap;
        outDrawCounts[i] = want;
        allocated += want;
    }
    return allocated;
}

/**
 * Compute physically equivalent alpha when drawing a fraction `ratio` (0 < ratio <= 1)
 * of transparent points so perceived brightness & opacity match full-density rendering:
 *   (1 - alpha_eff)^(ratio * k) = (1 - alpha)^k  =>  alpha_eff = 1 - (1 - alpha)^(1 / ratio)
 */
export function computeEquivalentAlpha(baseAlpha: number, drawRatio: number): number {
    if (baseAlpha >= 0.99 || drawRatio >= 0.999) return baseAlpha;
    if (baseAlpha <= 0 || drawRatio <= 0) return baseAlpha;
    const invRatio = Math.min(1 / drawRatio, 64);
    const eff = 1 - Math.pow(1 - baseAlpha, invRatio);
    return Math.min(0.995, Math.max(baseAlpha, eff));
}
