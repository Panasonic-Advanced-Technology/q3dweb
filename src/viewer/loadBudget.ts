import { detectHeapLimit, detectHeapUsed, estimateMemoryRequirement, formatBytes } from '../utils/memoryCheck';
import { getLargeFileSamplingThresholdBytes } from '../parsers/sampling';

export function estimateVisiblePointBufferBytes(pointCount: number, hasRGB: boolean): number {
    return pointCount * (3 * 4 + 4 + (hasRGB ? 3 : 0)) + 32 * 1024 * 1024;
}

export function estimateSingleBufferInputBytes(fileSize: number, format: string): number {
    const wasmCopyFactor = format === 'laz' ? 2 : 1;
    return Math.ceil(fileSize * wasmCopyFactor + 32 * 1024 * 1024);
}

export function abortStream(v: any, message: string): void {
    v.streamAborted = true;
    v.leftoverChunk = null; v.chunkList = []; v.fullBuffer = null;
    v.fullBufferWriteOffset = 0; v.posBuffer = null; v.valBuffer = null;
    v.rgbBuffer = null; v.lasStream = null;
    v.pcdAsciiStream = null; v.plyStream = null;
    if (v.loadingOverlay) {
        v.loadingOverlay.style.display = 'flex';
        v.loadingOverlay.innerHTML = `<div style="color:white;font-size:24px;font-family:sans-serif;background:rgba(0,0,0,0.8);padding:20px;border-radius:8px;">Error: ${message}</div>`;
    }
}

export function ensureSingleBufferInputBudget(v: any, fileSize: number, format: string, filename?: string): boolean {
    if (v.skipMemoryCheck) return true;
    const estimated = estimateSingleBufferInputBytes(fileSize, format);
    const heapLimit = detectHeapLimit(), heapUsed = detectHeapUsed();
    const budget = Math.max(heapLimit - heapUsed, 0) || heapLimit;
    const ratio = budget > 0 ? estimated / budget : 0;
    if (ratio < 0.6) return true;
    const label = filename ? `"${filename}"` : 'this file';
    const threshold = getLargeFileSamplingThresholdBytes();
    const detail = `Estimated contiguous input memory for ${format.toUpperCase()} of ${label}: ${formatBytes(estimated)}. Available: ${formatBytes(budget)}. Sampling threshold: ${formatBytes(threshold)}.`;
    if (ratio >= 0.9) { console.warn('[memoryCheck] blocked:', detail); if (typeof alert === 'function') alert(detail); abortStream(v, detail); return false; }
    console.warn('[memoryCheck] large input warning:', detail);
    if (typeof confirm === 'function' && !confirm(`${detail}\n\nLoad anyway?`)) { abortStream(v, detail); return false; }
    return true;
}

export function ensureStreamedPointBudget(v: any, pointCount: number, hasRGB: boolean, format: string, filename?: string): boolean {
    if (v.skipMemoryCheck) return true;
    const estimated = estimateVisiblePointBufferBytes(pointCount, hasRGB);
    const heapLimit = detectHeapLimit(), heapUsed = detectHeapUsed();
    const budget = Math.max(heapLimit - heapUsed, 0) || heapLimit;
    const ratio = budget > 0 ? estimated / budget : 0;
    if (ratio < 0.6) return true;
    const label = filename ? `"${filename}"` : 'this file';
    const detail = `Estimated memory for ${format.toUpperCase()} of ${label}: ${formatBytes(estimated)} for ${pointCount.toLocaleString()} pts. Available: ${formatBytes(budget)}.`;
    if (ratio >= 0.9) { console.warn('[memoryCheck] blocked:', detail); if (typeof alert === 'function') alert(detail); abortStream(v, detail); return false; }
    console.warn('[memoryCheck] large load warning:', detail);
    if (typeof confirm === 'function' && !confirm(`${detail}\n\nLoad anyway?`)) { abortStream(v, detail); return false; }
    return true;
}

export function checkMemoryBudget(v: any, fileSize: number, format: string, filename?: string): boolean {
    if (v.skipMemoryCheck) return true;
    const result = estimateMemoryRequirement(fileSize, format);
    if (result.level === 'ok') return true;
    const label = filename ? `"${filename}"` : 'this file';
    const header = result.level === 'block' ? `Cannot open ${label}: likely exceeds available memory.` : `Opening ${label} may exhaust browser memory.`;
    const detail = `${header}\n\n${result.message}`;
    if (result.level === 'block') { console.warn('[memoryCheck] blocked:', detail); if (typeof alert === 'function') alert(detail); return false; }
    console.warn('[memoryCheck] large file warning:', detail);
    if (typeof confirm === 'function') return confirm(`${detail}\n\nLoad anyway?`);
    return true;
}
