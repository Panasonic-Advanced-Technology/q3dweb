/**
 * E57 point-cloud parser (uses vendor WASM module).
 * Extracted from viewer.ts for modularity.
 */

import type { ParsedCloud } from './pcdParser';
import { normalizeIntensity } from './lasParser';
import { getLargeFileSamplingThresholdBytes } from './sampling';

type E57Input = Uint8Array | readonly Uint8Array[];

function isChunkedInput(data: E57Input): data is readonly Uint8Array[] {
    return Array.isArray(data);
}

function getInputByteLength(data: E57Input): number {
    if (!isChunkedInput(data)) return data.byteLength;
    let total = 0;
    for (const chunk of data) total += chunk.byteLength;
    return total;
}

function mergeChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

/** Parse an E57 file while preserving the original scanner coordinates. */
export async function parseE57(data: E57Input, maxPoints: number, sourceBytes: number = getInputByteLength(data)): Promise<ParsedCloud> {
    const inputBytes = getInputByteLength(data);
    console.log(`E57: parsing ${inputBytes} bytes via vendor/e57-wasm...`);
    const mod: any = await import('../../vendor/e57-wasm/pkg/e57_wasm.js');
    const wasmUrl = (await import('../../vendor/e57-wasm/pkg/e57_wasm_bg.wasm?url')).default;
    await mod.default({ module_or_path: wasmUrl });
    const samplingThresholdBytes = getLargeFileSamplingThresholdBytes();

    const pts = isChunkedInput(data)
        ? (typeof mod.parsePointChunksSampled === 'function'
            ? mod.parsePointChunksSampled(data, maxPoints, sourceBytes, samplingThresholdBytes)
            : (typeof mod.parsePointsSampled === 'function'
                ? mod.parsePointsSampled(mergeChunks(data, inputBytes), maxPoints, sourceBytes, samplingThresholdBytes)
                : mod.parsePoints(mergeChunks(data, inputBytes))))
        : (typeof mod.parsePointsSampled === 'function'
            ? mod.parsePointsSampled(data, maxPoints, sourceBytes, samplingThresholdBytes)
            : mod.parsePoints(data));
    const positions    = pts.positions as Float32Array;
    const intensity    = pts.intensities as Float32Array;
    const rgbColors    = pts.hasColor ? pts.colors as Uint8Array : undefined;
    const totalPoints  = pts.pointCount as number;
    try { pts.free(); } catch { /* ignore */ }

    normalizeIntensity(intensity);
    console.log(`E57: loaded ${totalPoints} pts, hasColor=${Boolean(rgbColors)}`);
    return {
        positions,
        values: intensity,
        rgb: rgbColors,
    };
}
