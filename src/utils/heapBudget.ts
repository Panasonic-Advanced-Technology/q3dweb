export const DEFAULT_HEAP_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
export const MIN_SAMPLING_THRESHOLD_BYTES = 128 * 1024 * 1024;
export const SAMPLING_THRESHOLD_HEAP_FRACTION = 0.5;

const HOST_HEAP_LIMIT_KEY = '__Q3DWEB_HOST_HEAP_LIMIT_BYTES';
const HOST_HEAP_USED_KEY = '__Q3DWEB_HOST_HEAP_USED_BYTES';

let hostHeapLimitOverride: number | undefined;
let hostHeapUsedOverride: number | undefined;

function finitePositive(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : undefined;
}

function globalNumber(key: string): number | undefined {
    return finitePositive((globalThis as Record<string, unknown>)[key]);
}

export function configureHostHeapBudget(heapLimitBytes?: number, heapUsedBytes?: number): void {
    hostHeapLimitOverride = finitePositive(heapLimitBytes);
    hostHeapUsedOverride = finitePositive(heapUsedBytes);
    const globals = globalThis as Record<string, unknown>;
    if (hostHeapLimitOverride === undefined && hostHeapUsedOverride === undefined) {
        delete globals[HOST_HEAP_LIMIT_KEY];
        delete globals[HOST_HEAP_USED_KEY];
        return;
    }
    if (hostHeapLimitOverride !== undefined) globals[HOST_HEAP_LIMIT_KEY] = hostHeapLimitOverride;
    if (hostHeapUsedOverride !== undefined) globals[HOST_HEAP_USED_KEY] = hostHeapUsedOverride;
}

export function detectHeapLimitBytes(): number {
    const hostLimit = hostHeapLimitOverride ?? globalNumber(HOST_HEAP_LIMIT_KEY);
    if (hostLimit !== undefined) return hostLimit;

    const perf = (globalThis as any).performance;
    if (perf?.memory) {
        const jsLimit = finitePositive(perf.memory.jsHeapSizeLimit);
        if (jsLimit !== undefined) return jsLimit;
    }

    const nav = (globalThis as any).navigator;
    const deviceMemoryGiB = finitePositive(nav?.deviceMemory);
    if (deviceMemoryGiB !== undefined) {
        return Math.floor(deviceMemoryGiB * 1024 * 1024 * 1024 * 0.5);
    }

    return DEFAULT_HEAP_LIMIT_BYTES;
}

export function detectHeapUsedBytes(): number {
    const hostUsed = hostHeapUsedOverride ?? globalNumber(HOST_HEAP_USED_KEY);
    if (hostUsed !== undefined) return hostUsed;

    const perf = (globalThis as any).performance;
    if (perf?.memory) {
        const used = finitePositive(perf.memory.usedJSHeapSize);
        if (used !== undefined) return used;
    }

    return 0;
}

export function computeSamplingThresholdBytes(
    heapLimitBytes: number = detectHeapLimitBytes(),
    heapUsedBytes: number = detectHeapUsedBytes(),
): number {
    const safeLimit = finitePositive(heapLimitBytes) ?? DEFAULT_HEAP_LIMIT_BYTES;
    const safeUsed = Number.isFinite(heapUsedBytes) ? Math.max(0, Math.floor(heapUsedBytes)) : 0;
    const available = Math.max(safeLimit - safeUsed, 0);
    const budget = available > 0 ? available : safeLimit;
    return Math.max(
        MIN_SAMPLING_THRESHOLD_BYTES,
        Math.floor(budget * SAMPLING_THRESHOLD_HEAP_FRACTION),
    );
}
