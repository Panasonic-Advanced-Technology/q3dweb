import { inferPointCloudFilename } from '../cloudUrlOptions';
import {
    checkMemoryBudget,
    detectFormat,
    finalizeStream,
    loadData,
    processChunk,
    shouldDeferInitialMemoryCheck,
    startStream,
} from './streamEngine';

function contentLength(response: Response): number {
    const value = response.headers.get('content-length');
    if (!value) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
}

function contentDispositionFilename(response: Response): string | undefined {
    const value = response.headers.get('content-disposition');
    const match = value?.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
    if (!match) return undefined;
    try {
        return decodeURIComponent(match[1].trim());
    } catch {
        return match[1].trim();
    }
}

function hasSupportedExtension(v: any, filename?: string): boolean {
    const ext = '.' + (filename ?? '').toLowerCase().split('.').pop();
    return v.constructor.SUPPORTED_EXTENSIONS?.includes(ext) === true;
}

function showRemoteLoadError(v: any, message: string): void {
    console.error(message);
    if (v.loadingOverlay) {
        v.loadingOverlay.style.display = 'flex';
        v.loadingOverlay.innerHTML = `<div style="color:white;font-size:24px;font-family:sans-serif;background:rgba(0,0,0,0.8);padding:20px;border-radius:8px;">Error: ${escapeHtml(message)}</div>`;
    }
}

export async function loadUrl(v: any, sourceUrl: string, filename?: string): Promise<void> {
    try {
        const response = await fetch(sourceUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());

        const urlFilename = inferPointCloudFilename(sourceUrl);
        const headerFilename = contentDispositionFilename(response);
        const effectiveFilename = filename || (hasSupportedExtension(v, urlFilename) ? urlFilename : headerFilename) || urlFilename;
        if (!hasSupportedExtension(v, effectiveFilename)) {
            showRemoteLoadError(v, `Unsupported point cloud URL: ${sourceUrl}`);
            return;
        }

        const totalSize = contentLength(response);
        const fmt = detectFormat(effectiveFilename);
        if (totalSize > 0 && !shouldDeferInitialMemoryCheck(fmt) && !checkMemoryBudget(v, totalSize, fmt, effectiveFilename)) return;

        if (!response.body) {
            const content = new Uint8Array(await response.arrayBuffer());
            loadData(v, content, effectiveFilename);
            return;
        }

        v.removeItem('cloud');
        startStream(v, totalSize, effectiveFilename);
        if (v.loadingOverlay) {
            v.loadingOverlay.style.display = 'flex';
            v.loadingOverlay.innerHTML = '<div style="color:white;font-size:24px;font-family:sans-serif;background:rgba(0,0,0,0.8);padding:20px;border-radius:8px;">Fetching...</div>';
        }

        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                processChunk(v, value, 0);
                if (v.streamAborted) {
                    await reader.cancel();
                    break;
                }
                await new Promise(r => setTimeout(r, 0));
            }
        }
        if (!v.streamAborted) finalizeStream(v);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showRemoteLoadError(v, `Failed to load ${sourceUrl}: ${message}`);
    }
}