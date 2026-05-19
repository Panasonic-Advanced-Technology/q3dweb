/**
 * Memory budget estimation for point cloud loading.
 *
 * Point cloud loading keeps parsed output buffers in memory, and a few formats
 * also need full compressed input. Loading beyond the current heap budget can
 * OOM the webview, so this module estimates memory risk before allocation.
 */

import { detectHeapLimitBytes, detectHeapUsedBytes } from './heapBudget';

export type MemoryCheckResult = {
    /** Whether the caller should proceed with loading. */
    proceed: boolean;
    /** Human-readable message that was (or would be) shown to the user. */
    message: string;
    /** Estimated peak memory in bytes. */
    estimatedBytes: number;
    /** Detected heap limit in bytes (0 if unknown). */
    heapLimitBytes: number;
    /** Severity level. */
    level: 'ok' | 'warn' | 'block';
};

/**
 * Per-format expansion factor applied to the raw file size to estimate the
 * peak resident memory footprint (raw buffer + parsed typed arrays).
 *
 * These are deliberately conservative; it is better to over-estimate than to
 * let the tab OOM.
 */
const FORMAT_EXPANSION_FACTOR: Record<string, number> = {
    pcd: 2.0,   // binary PCD: raw + float32 pos + u8 rgb + f32 intensity
    ply: 2.5,   // similar to PCD but parsing keeps intermediate string buffers
    las: 2.5,   // raw + parsed float32 pos + colors/intensity
    laz: 8.0,   // LAZ decompresses ~5-10x the compressed size
    e57: 3.0,   // e57 WASM keeps raw + decoded float64 then float32
    unknown: 3.0,
};

/**
 * Return the host Node heap limit when VS Code provides it, then browser heap
 * information, then a conservative fallback.
 */
export function detectHeapLimit(): number {
    return detectHeapLimitBytes();
}

/**
 * Currently used JS heap, when available. Returns 0 when unknown.
 */
export function detectHeapUsed(): number {
    return detectHeapUsedBytes();
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

/**
 * Estimate peak memory requirement for loading a file of the given
 * size/format, and classify the risk against the detected heap limit.
 *
 * Thresholds:
 *   estimate < 60% of limit  -> 'ok'   (proceed silently)
 *   60% <= estimate < 90%    -> 'warn' (user confirmation recommended)
 *   estimate >= 90%          -> 'block' (hard block by default)
 */
export function estimateMemoryRequirement(
    fileSize: number,
    format: string,
    heapLimit: number = detectHeapLimit(),
    heapUsed: number = detectHeapUsed(),
): MemoryCheckResult {
    const factor = FORMAT_EXPANSION_FACTOR[format] ?? FORMAT_EXPANSION_FACTOR.unknown;
    const estimatedBytes = Math.ceil(fileSize * factor);
    const available = Math.max(heapLimit - heapUsed, 0);
    const budget = available > 0 ? available : heapLimit;

    let level: MemoryCheckResult['level'] = 'ok';
    if (budget > 0) {
        const ratio = estimatedBytes / budget;
        if (ratio >= 0.9) level = 'block';
        else if (ratio >= 0.6) level = 'warn';
    }

    const message =
        `Estimated memory to load this ${format.toUpperCase()} file: ` +
        `${formatBytes(estimatedBytes)} (raw ${formatBytes(fileSize)} x ${factor}). ` +
        `Available JS heap: ${formatBytes(budget)}` +
        (heapLimit > 0 ? ` (limit ${formatBytes(heapLimit)})` : '') + '.';

    return {
        proceed: level !== 'block',
        message,
        estimatedBytes,
        heapLimitBytes: heapLimit,
        level,
    };
}
