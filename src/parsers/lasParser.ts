/**
 * LAS / LAZ point-cloud parsers.
 * Extracted from viewer.ts for modularity.
 */

import { parseLASGeoInfo, readLASBounds } from '../utils/lasGeo';
import { projToLatLon, registerWKT, convertByKey } from '../utils/projConvert';
import type { ParsedCloud } from './pcdParser';
import { computePointSampleRatio, estimateSampledPointCount } from './sampling';

export interface LASBounds {
    minX: number; maxX: number;
    minY: number; maxY: number;
    minZ: number; maxZ: number;
}

export interface LASMetadata {
    versionMajor: number;
    versionMinor: number;
    offsetToPointData: number;
    pointDataRecordFormat: number;
    pointDataRecordLength: number;
    numberOfPoints: number;
    xScale: number; yScale: number; zScale: number;
    xOff: number;   yOff: number;   zOff: number;
    hasRGB: boolean;
    rgbOffset: number;
    shiftX: number;
    shiftY: number;
    originLatLon: [number, number] | null;
    bounds: LASBounds | null;
}

export interface LASStreamState extends LASMetadata {
    rawPointIndex: number;
}

export interface ParsedLAS extends ParsedCloud {
    originLatLon: [number, number] | null;
    bounds: LASBounds | null;
}

type LASPointRecordMeta = Pick<LASMetadata,
    'xScale' | 'yScale' | 'zScale' | 'xOff' | 'yOff' | 'zOff' |
    'shiftX' | 'shiftY' | 'hasRGB' | 'rgbOffset'
>;

function appendLASPointRecord(
    view: DataView,
    recordStart: number,
    meta: LASPointRecordMeta,
    positions: Float32Array,
    intensities: Float32Array,
    rgbColors: Uint8Array | null,
    outputIndex: number,
): void {
    const rawX = view.getInt32(recordStart, true);
    const rawY = view.getInt32(recordStart + 4, true);
    const rawZ = view.getInt32(recordStart + 8, true);
    const base = outputIndex * 3;
    positions[base]     = rawX * meta.xScale + meta.xOff - meta.shiftX;
    positions[base + 1] = rawY * meta.yScale + meta.yOff - meta.shiftY;
    positions[base + 2] = rawZ * meta.zScale + meta.zOff;
    intensities[outputIndex] = view.getUint16(recordStart + 12, true);

    if (rgbColors && meta.hasRGB && meta.rgbOffset !== -1) {
        let redValue = view.getUint16(recordStart + meta.rgbOffset, true);
        let greenValue = view.getUint16(recordStart + meta.rgbOffset + 2, true);
        let blueValue = view.getUint16(recordStart + meta.rgbOffset + 4, true);
        if (redValue > 255 || greenValue > 255 || blueValue > 255) {
            redValue = Math.floor(redValue / 256);
            greenValue = Math.floor(greenValue / 256);
            blueValue = Math.floor(blueValue / 256);
        }
        rgbColors[base] = redValue;
        rgbColors[base + 1] = greenValue;
        rgbColors[base + 2] = blueValue;
    }
}

/** Normalize raw integer intensities to 0-255, matching q3dviewer behaviour. */
export function normalizeIntensity(values: Float32Array): void {
    let maxIntensity = 0;
    for (let i = 0; i < values.length; i++) {
        const v = Math.max(0, Math.trunc(values[i]));
        values[i] = v;
        if (v > maxIntensity) maxIntensity = v;
    }
    if (maxIntensity > 255) {
        const scale = 255 / maxIntensity;
        for (let i = 0; i < values.length; i++) values[i] = Math.trunc(values[i] * scale);
    }
}

/** Parse LAS header + georeference VLRs. Throws on invalid magic. */
export function parseLASMetadata(data: Uint8Array): LASMetadata {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'LASF') throw new Error('Not a valid LAS file');

    const versionMajor            = view.getUint8(24);
    const versionMinor            = view.getUint8(25);
    const offsetToPointData       = view.getUint32(96, true);
    const pointDataRecordFormat   = view.getUint8(104);
    const pointDataRecordLength   = view.getUint16(105, true);

    let numberOfPoints: number;
    if (versionMajor === 1 && versionMinor >= 4) {
        const legacyCount  = view.getUint32(107, true);
        const count64Low   = view.getUint32(247, true);
        numberOfPoints = count64Low > 0 ? count64Low : legacyCount;
    } else {
        numberOfPoints = view.getUint32(107, true);
    }

    const xScale = view.getFloat64(131, true);
    const yScale = view.getFloat64(139, true);
    const zScale = view.getFloat64(147, true);
    const xOff   = view.getFloat64(155, true);
    const yOff   = view.getFloat64(163, true);
    const zOff   = view.getFloat64(171, true);

    const hasRGB = [2, 3, 5, 7, 8, 10].includes(pointDataRecordFormat);
    let rgbOffset = -1;
    if (hasRGB) {
        switch (pointDataRecordFormat) {
            case 2: rgbOffset = 20; break;
            case 3: rgbOffset = 28; break;
            case 5: rgbOffset = 28; break;
            case 7: rgbOffset = 30; break;
            case 8: rgbOffset = 30; break;
            case 10: rgbOffset = 30; break;
        }
    }

    console.log(`LAS ${versionMajor}.${versionMinor}, Format ${pointDataRecordFormat}, ` +
        `${numberOfPoints} points, Record Length ${pointDataRecordLength}`);

    const geo    = parseLASGeoInfo(data);
    const bounds = readLASBounds(data) as LASBounds | null;
    let originLatLon: [number, number] | null = null;
    let shiftX = 0;
    let shiftY = 0;
    if (geo && bounds) {
        const cx = (bounds.minX + bounds.maxX) / 2;
        const cy = (bounds.minY + bounds.maxY) / 2;
        if (geo.epsg !== undefined) originLatLon = projToLatLon(geo.epsg, cx, cy);
        if (!originLatLon && geo.wkt) {
            const key = registerWKT(geo.wkt, '__LAS_WKT__');
            if (key) originLatLon = convertByKey(key, cx, cy);
        }
        if (originLatLon) {
            shiftX = cx; shiftY = cy;
            console.log(`LAS georef: EPSG=${geo.epsg ?? 'wkt'}, centre=(${originLatLon[0].toFixed(6)}, ${originLatLon[1].toFixed(6)})`);
        } else if (geo.epsg !== undefined) {
            console.warn(`LAS georef EPSG:${geo.epsg} not supported for overlay.`);
        }
    }

    return {
        versionMajor, versionMinor, offsetToPointData, pointDataRecordFormat,
        pointDataRecordLength, numberOfPoints, xScale, yScale, zScale,
        xOff, yOff, zOff, hasRGB, rgbOffset, shiftX, shiftY, originLatLon, bounds,
    };
}

/** Parse a fully-buffered LAS file. Samples to maxPoints. */
export function parseLAS(data: Uint8Array, maxPoints: number, sourceBytes: number = data.byteLength): ParsedLAS {
    const meta = parseLASMetadata(data);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const sampleRatio = computePointSampleRatio(meta.numberOfPoints, maxPoints, sourceBytes);
    const estimatedVisPoints = estimateSampledPointCount(meta.numberOfPoints, sampleRatio, maxPoints);

    const positions    = new Float32Array(estimatedVisPoints * 3);
    const intensities  = new Float32Array(estimatedVisPoints);
    const rgbColors    = meta.hasRGB && meta.rgbOffset !== -1 ? new Uint8Array(estimatedVisPoints * 3) : null;

    let parsedPoints = 0;
    for (let i = 0; i < meta.numberOfPoints; i += sampleRatio) {
        if (parsedPoints >= estimatedVisPoints) break;
        const recordStart = meta.offsetToPointData + i * meta.pointDataRecordLength;
        if (recordStart + meta.pointDataRecordLength > data.byteLength) break;

        appendLASPointRecord(view, recordStart, meta, positions, intensities, rgbColors, parsedPoints);
        parsedPoints++;
    }

    normalizeIntensity(intensities.subarray(0, parsedPoints));
    return {
        positions: positions.subarray(0, parsedPoints * 3),
        values:    intensities.subarray(0, parsedPoints),
        rgb:       rgbColors ? rgbColors.subarray(0, parsedPoints * 3) : undefined,
        originLatLon: meta.originLatLon,
        bounds:       meta.bounds,
    };
}

/** Decompress a LAZ file via laz-perf WASM while storing only sampled points. */
export async function parseLAZ(data: Uint8Array, maxPoints: number, sourceBytes: number = data.byteLength): Promise<ParsedLAS> {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'LASF') throw new Error('Not a valid LAZ/LAS file');
    const offsetToPointData     = view.getUint32(96, true);
    const compressedFormatByte  = view.getUint8(104);
    const uncompressedFormat    = compressedFormatByte & 0x3F;

    console.log(`LAZ: decompressing via laz-perf (format ${uncompressedFormat})...`);
    const { createLazPerf } = await import('laz-perf/lib/web');
    const wasmUrl = (await import('laz-perf/lib/web/laz-perf.wasm?url')).default;
    const LazPerf: any = await (createLazPerf as any)({
        locateFile: (path: string) => path.endsWith('.wasm') ? wasmUrl : path,
    });
    const laszip = new LazPerf.LASZip();
    const dataPtr = LazPerf._malloc(data.byteLength);
    LazPerf.HEAPU8.set(data, dataPtr);
    try {
        laszip.open(dataPtr, data.byteLength);
        const count    = Number(laszip.getCount());
        const pointLen = Number(laszip.getPointLength());
        console.log(`LAZ: ${count} points, pointLen=${pointLen}, fmt=${laszip.getPointFormat()}`);

        const metadataBytes = new Uint8Array(data.subarray(0, offsetToPointData));
        metadataBytes[104] = uncompressedFormat;
        new DataView(metadataBytes.buffer).setUint16(105, pointLen, true);
        const meta = { ...parseLASMetadata(metadataBytes), numberOfPoints: count, pointDataRecordLength: pointLen };
        const sampleRatio = computePointSampleRatio(count, maxPoints, sourceBytes);
        const estimatedVisPoints = estimateSampledPointCount(count, sampleRatio, maxPoints);

        const positions    = new Float32Array(estimatedVisPoints * 3);
        const intensities  = new Float32Array(estimatedVisPoints);
        const rgbColors    = meta.hasRGB && meta.rgbOffset !== -1 ? new Uint8Array(estimatedVisPoints * 3) : null;

        const pointPtr = LazPerf._malloc(pointLen);
        try {
            let pointBuffer = LazPerf.HEAPU8.buffer;
            let pointView = new DataView(pointBuffer, pointPtr, pointLen);
            let parsedPoints = 0;
            for (let rawPointIndex = 0; rawPointIndex < count; rawPointIndex++) {
                laszip.getPoint(pointPtr);
                if (pointBuffer !== LazPerf.HEAPU8.buffer) {
                    pointBuffer = LazPerf.HEAPU8.buffer;
                    pointView = new DataView(pointBuffer, pointPtr, pointLen);
                }
                if (rawPointIndex % sampleRatio !== 0) continue;
                if (parsedPoints >= estimatedVisPoints) break;
                appendLASPointRecord(pointView, 0, meta, positions, intensities, rgbColors, parsedPoints);
                parsedPoints++;
            }

            normalizeIntensity(intensities.subarray(0, parsedPoints));
            console.log(`LAZ: loaded ${parsedPoints}/${count} pts (ratio 1:${sampleRatio})`);
            return {
                positions: positions.subarray(0, parsedPoints * 3),
                values:    intensities.subarray(0, parsedPoints),
                rgb:       rgbColors ? rgbColors.subarray(0, parsedPoints * 3) : undefined,
                originLatLon: meta.originLatLon,
                bounds:       meta.bounds,
            };
        } finally { LazPerf._free(pointPtr); }
    } finally {
        try { laszip.delete(); } catch { /* ignore */ }
        LazPerf._free(dataPtr);
    }
}

/** Apply one chunk of raw LAS point records to the streaming buffers. */
export function processLASRecords(
    data: Uint8Array,
    meta: LASStreamState,
    posBuffer: Float32Array,
    valBuffer: Float32Array,
    rgbBuffer: Uint8Array | null,
    posIndexRef: { value: number },
    targetSampleRatio: number,
    leftoverRef: { value: Uint8Array | null },
): void {
    const rowSize   = meta.pointDataRecordLength;
    const count     = Math.floor(data.byteLength / rowSize);
    if (count === 0) {
        leftoverRef.value = data.byteLength > 0 ? data.slice() : null;
        return;
    }

    const usableBytes = count * rowSize;
    const view        = new DataView(data.buffer, data.byteOffset, usableBytes);

    for (let i = 0; i < count; i++) {
        const rawIdx = meta.rawPointIndex++;
        if (rawIdx % targetSampleRatio !== 0) continue;
        if (posIndexRef.value >= valBuffer.length) break;

        const recordStart = i * rowSize;
        const rawX = view.getInt32(recordStart,     true);
        const rawY = view.getInt32(recordStart + 4, true);
        const rawZ = view.getInt32(recordStart + 8, true);
        const base = posIndexRef.value * 3;

        posBuffer[base]     = rawX * meta.xScale + meta.xOff - meta.shiftX;
        posBuffer[base + 1] = rawY * meta.yScale + meta.yOff - meta.shiftY;
        posBuffer[base + 2] = rawZ * meta.zScale + meta.zOff;
        valBuffer[posIndexRef.value] = view.getUint16(recordStart + 12, true);

        if (rgbBuffer && meta.rgbOffset !== -1) {
            let r = view.getUint16(recordStart + meta.rgbOffset,     true);
            let g = view.getUint16(recordStart + meta.rgbOffset + 2, true);
            let b = view.getUint16(recordStart + meta.rgbOffset + 4, true);
            if (r > 255 || g > 255 || b > 255) { r = Math.floor(r / 256); g = Math.floor(g / 256); b = Math.floor(b / 256); }
            rgbBuffer[base] = r; rgbBuffer[base + 1] = g; rgbBuffer[base + 2] = b;
        }
        posIndexRef.value++;
    }

    const leftovers = data.byteLength - usableBytes;
    leftoverRef.value = leftovers > 0 ? data.slice(usableBytes) : null;
}
