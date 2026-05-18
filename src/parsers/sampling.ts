export const LARGE_FILE_SAMPLING_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;

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
    const bySourceSize = sourceBytes > LARGE_FILE_SAMPLING_THRESHOLD_BYTES
        ? Math.ceil(sourceBytes / LARGE_FILE_SAMPLING_THRESHOLD_BYTES)
        : 1;
    return Math.max(1, byPointBudget, bySourceSize);
}

export function estimateSampledPointCount(pointCount: number | undefined, sampleRatio: number, fallbackMaxPoints: number): number {
    const safeRatio = Math.max(1, Math.floor(sampleRatio));
    const fallback = Math.max(1, Math.floor(fallbackMaxPoints));
    if (!Number.isFinite(pointCount) || pointCount === undefined || pointCount <= 0) return fallback;
    return Math.max(1, Math.ceil(pointCount / safeRatio));
}
