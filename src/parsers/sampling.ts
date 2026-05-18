import {
    computeSamplingThresholdBytes,
    configureHostHeapBudget,
    DEFAULT_HEAP_LIMIT_BYTES,
    detectHeapLimitBytes,
    detectHeapUsedBytes,
} from '../utils/heapBudget';

export const DEFAULT_LARGE_FILE_SAMPLING_THRESHOLD_BYTES = DEFAULT_HEAP_LIMIT_BYTES;
export let LARGE_FILE_SAMPLING_THRESHOLD_BYTES = computeSamplingThresholdBytes();

export function configureSamplingHeapBudget(heapLimitBytes?: number, heapUsedBytes?: number): number {
    configureHostHeapBudget(heapLimitBytes, heapUsedBytes);
    return refreshLargeFileSamplingThresholdBytes();
}

export function refreshLargeFileSamplingThresholdBytes(): number {
    LARGE_FILE_SAMPLING_THRESHOLD_BYTES = computeSamplingThresholdBytes(
        detectHeapLimitBytes(),
        detectHeapUsedBytes(),
    );
    return LARGE_FILE_SAMPLING_THRESHOLD_BYTES;
}

export function getLargeFileSamplingThresholdBytes(): number {
    return refreshLargeFileSamplingThresholdBytes();
}

export function computePointSampleRatio(
    pointCount: number | undefined,
    maxPoints: number,
    sourceBytes: number = 0,
): number {
    const safeMaxPoints = Math.max(1, Math.floor(maxPoints));
    const safePointCount = Number.isFinite(pointCount) && pointCount !== undefined && pointCount > 0
        ? Math.floor(pointCount)
        : safeMaxPoints;
    const byPointBudget = safePointCount > safeMaxPoints
        ? Math.ceil(safePointCount / safeMaxPoints)
        : 1;
    const sourceThreshold = getLargeFileSamplingThresholdBytes();
    const bySourceSize = sourceBytes > sourceThreshold
        ? Math.ceil(sourceBytes / sourceThreshold)
        : 1;
    return Math.max(1, byPointBudget, bySourceSize);
}

export function estimateSampledPointCount(pointCount: number | undefined, sampleRatio: number, fallbackMaxPoints: number): number {
    const safeRatio = Math.max(1, Math.floor(sampleRatio));
    const fallback = Math.max(1, Math.floor(fallbackMaxPoints));
    if (!Number.isFinite(pointCount) || pointCount === undefined || pointCount <= 0) return fallback;
    return Math.max(1, Math.ceil(pointCount / safeRatio));
}
