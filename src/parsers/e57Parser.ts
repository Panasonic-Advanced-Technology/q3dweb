/**
 * E57 point-cloud parser (uses vendor WASM module).
 * Extracted from viewer.ts for modularity.
 */

import type { ParsedCloud } from './pcdParser';
import { normalizeIntensity } from './lasParser';

/** Parse an E57 file. Recenters points around their mean for float32 stability. */
export async function parseE57(data: Uint8Array, maxPoints: number): Promise<ParsedCloud> {
    console.log(`E57: parsing ${data.byteLength} bytes via vendor/e57-wasm...`);
    const mod: any = await import('../../vendor/e57-wasm/pkg/e57_wasm.js');
    const wasmUrl = (await import('../../vendor/e57-wasm/pkg/e57_wasm_bg.wasm?url')).default;
    await mod.default({ module_or_path: wasmUrl });

    const pts          = mod.parsePoints(data);
    const src          = pts.positions  as Float32Array;
    const colSrc       = pts.colors     as Float32Array;
    const intenSrc     = pts.intensities as Float32Array;
    const totalPoints  = pts.pointCount as number;
    const hasColor     = pts.hasColor   as boolean;
    const hasIntensity = pts.hasIntensity as boolean;

    const sampleRatio = totalPoints > maxPoints ? Math.ceil(totalPoints / maxPoints) : 1;
    const estimated   = Math.ceil(totalPoints / sampleRatio);

    const positions = new Float32Array(estimated * 3);
    const intensity = new Float32Array(estimated);
    const rgbColors = hasColor ? new Uint8Array(estimated * 3) : undefined;

    let sumX = 0, sumY = 0, sumZ = 0, n = 0;
    for (let i = 0; i < totalPoints; i += sampleRatio) {
        sumX += src[i * 3]; sumY += src[i * 3 + 1]; sumZ += src[i * 3 + 2];
        n++;
        if (n >= estimated) break;
    }
    const cx = n > 0 ? sumX / n : 0;
    const cy = n > 0 ? sumY / n : 0;
    const cz = n > 0 ? sumZ / n : 0;

    let parsed = 0;
    for (let i = 0; i < totalPoints; i += sampleRatio) {
        if (parsed >= estimated) break;
        const b = parsed * 3;
        positions[b]     = src[i * 3]     - cx;
        positions[b + 1] = src[i * 3 + 1] - cy;
        positions[b + 2] = src[i * 3 + 2] - cz;
        if (rgbColors) {
            rgbColors[b]     = Math.max(0, Math.min(255, Math.round(colSrc[i * 3]     * 255)));
            rgbColors[b + 1] = Math.max(0, Math.min(255, Math.round(colSrc[i * 3 + 1] * 255)));
            rgbColors[b + 2] = Math.max(0, Math.min(255, Math.round(colSrc[i * 3 + 2] * 255)));
        }
        intensity[parsed] = hasIntensity ? intenSrc[i] * 255 : 0;
        parsed++;
    }
    try { pts.free(); } catch { /* ignore */ }

    normalizeIntensity(intensity.subarray(0, parsed));
    console.log(`E57: loaded ${parsed}/${totalPoints} pts (ratio 1:${sampleRatio}), hasColor=${hasColor}, recentered at (${cx.toFixed(2)}, ${cy.toFixed(2)}, ${cz.toFixed(2)})`);
    return {
        positions: positions.subarray(0, parsed * 3),
        values:    intensity.subarray(0, parsed),
        rgb:       rgbColors?.subarray(0, parsed * 3),
    };
}
