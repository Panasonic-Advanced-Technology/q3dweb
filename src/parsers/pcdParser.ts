import { computePointSampleRatio, estimateSampledPointCount } from './sampling';

/**
 * PCD (Point Cloud Data) parsing utilities.
 * Extracted from viewer.ts for modularity.
 */

export interface PCDHeader {
    data: 'ascii' | 'binary' | 'binary_compressed';
    headerLen: number;
    width: number;
    height: number;
    points: number;
    rowSize: number;
    offset: { [key: string]: number };
    fields?: string[];
    counts?: number[];
    types?: string[];
    sizes?: number[];
}

export interface ParsedCloud {
    positions: Float32Array;
    values: Float32Array;
    rgb?: Uint8Array;
}

/** Mutable state bag for streaming binary PCD parsing (one instance per stream). */
export interface PCDBinaryState {
    posBuffer: Float32Array;
    valBuffer: Float32Array;
    rgbBuffer: Uint8Array | null;
    posIndex: number;
    pointsLoaded: number;
    targetSampleRatio: number;
    leftoverChunk: Uint8Array | null;
}

export function parsePCDHeader(headerStr: string): PCDHeader {
    const pcdHeader: any = { offset: {} };
    const lines = headerStr.split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trim();
        const words = line.split(/\s+/).filter(x => x);
        if (words.length === 0) continue;
        switch (words[0]) {
            case 'WIDTH':  pcdHeader.width  = parseInt(words[1]); break;
            case 'HEIGHT': pcdHeader.height = parseInt(words[1]); break;
            case 'POINTS': pcdHeader.points = parseInt(words[1]); break;
            case 'DATA':
                pcdHeader.data = words[1];
                pcdHeader.headerLen = headerStr.length;
                break;
        }
    }

    if (pcdHeader.points === undefined && pcdHeader.width !== undefined && pcdHeader.height !== undefined) {
        pcdHeader.points = pcdHeader.width * pcdHeader.height;
    }

    pcdHeader.rowSize = 16;

    const fieldsIdx = lines.findIndex(l => l.trimStart().startsWith('FIELDS'));
    const sizeIdx   = lines.findIndex(l => l.trimStart().startsWith('SIZE'));
    const typeIdx   = lines.findIndex(l => l.trimStart().startsWith('TYPE'));
    const countIdx  = lines.findIndex(l => l.trimStart().startsWith('COUNT'));

    if (fieldsIdx >= 0 && sizeIdx >= 0 && typeIdx >= 0) {
        const fields = lines[fieldsIdx].trim().split(/\s+/).slice(1);
        const sizes  = lines[sizeIdx].trim().split(/\s+/).slice(1).map(Number);
        const counts = countIdx >= 0
            ? lines[countIdx].trim().split(/\s+/).slice(1).map(Number)
            : new Array(fields.length).fill(1);
        const types  = lines[typeIdx].trim().split(/\s+/).slice(1);
        pcdHeader.fields  = fields;
        pcdHeader.counts  = counts;
        pcdHeader.types   = types;
        pcdHeader.sizes   = sizes;
        let size = 0;
        pcdHeader.offset = {};
        for (let i = 0; i < fields.length; i++) {
            pcdHeader.offset[fields[i]] = size;
            size += sizes[i] * counts[i];
        }
        pcdHeader.rowSize = size;
    }

    return pcdHeader as PCDHeader;
}

export function getFieldSpec(
    header: PCDHeader,
    fieldName: string,
): { offset: number; type: string; size: number; count: number } | null {
    if (!header.fields || !header.types || !header.sizes || !header.counts) return null;
    const idx = header.fields.indexOf(fieldName);
    if (idx < 0) return null;
    return {
        offset: header.offset[fieldName],
        type:   header.types[idx],
        size:   header.sizes[idx],
        count:  header.counts[idx],
    };
}

export function readNumericValue(
    view: DataView, byteOffset: number, type: string, size: number,
): number {
    if (type === 'F' && size === 4) return view.getFloat32(byteOffset, true);
    if (type === 'F' && size === 8) return view.getFloat64(byteOffset, true);
    if (type === 'U' && size === 1) return view.getUint8(byteOffset);
    if (type === 'U' && size === 2) return view.getUint16(byteOffset, true);
    if (type === 'U' && size === 4) return view.getUint32(byteOffset, true);
    if (type === 'I' && size === 1) return view.getInt8(byteOffset);
    if (type === 'I' && size === 2) return view.getInt16(byteOffset, true);
    if (type === 'I' && size === 4) return view.getInt32(byteOffset, true);
    if (size === 4) return view.getFloat32(byteOffset, true);
    if (size === 2) return view.getUint16(byteOffset, true);
    return view.getUint8(byteOffset);
}

export function readPackedRGB(
    view: DataView, byteOffset: number, type: string, size: number,
): number {
    if (size === 4) return view.getUint32(byteOffset, true);
    return (readNumericValue(view, byteOffset, type, size) >>> 0);
}

export function getAsciiFieldTokenIndex(header: PCDHeader, fieldName: string): number | null {
    if (!header.fields || !header.counts) return null;
    let tokenIndex = 0;
    for (let i = 0; i < header.fields.length; i++) {
        if (header.fields[i] === fieldName) return tokenIndex;
        tokenIndex += header.counts[i] ?? 1;
    }
    return null;
}

export function parseAsciiNumericToken(token: string): number {
    const value = Number(token);
    return Number.isFinite(value) ? value : NaN;
}

export function parseAsciiPackedRGB(token: string, type: string, size: number): number {
    const value = parseAsciiNumericToken(token);
    if (!Number.isFinite(value)) return 0;
    if (type === 'F' && size === 4) {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setFloat32(0, value, true);
        return view.getUint32(0, true);
    }
    return (Math.max(0, Math.trunc(value)) >>> 0);
}

/** Parse an ASCII PCD payload (entire file as Uint8Array). Returns positions/values/rgb. */
export function parsePCDAscii(
    data: Uint8Array,
    header: PCDHeader,
    maxPoints: number,
    sourceBytes: number = data.byteLength,
): ParsedCloud {
    const text = new TextDecoder().decode(data.subarray(header.headerLen));
    const lines = text.split(/\r?\n/);
    const totalPoints = header.points ?? lines.length;
    const sampleRatio = computePointSampleRatio(totalPoints, maxPoints, sourceBytes);
    const estimated = estimateSampledPointCount(totalPoints, sampleRatio, maxPoints);

    const positions = new Float32Array(estimated * 3);
    const values    = new Float32Array(estimated);

    const intensitySpec       = getFieldSpec(header, 'intensity');
    const intensityTokenIndex = getAsciiFieldTokenIndex(header, 'intensity');

    let rgbSpec       = getFieldSpec(header, 'rgb') ?? getFieldSpec(header, 'rgba');
    let rgbTokenIndex = getAsciiFieldTokenIndex(header, 'rgb') ?? getAsciiFieldTokenIndex(header, 'rgba');

    const rgbColors = rgbSpec && rgbTokenIndex !== null ? new Uint8Array(estimated * 3) : null;

    const xIdx = getAsciiFieldTokenIndex(header, 'x');
    const yIdx = getAsciiFieldTokenIndex(header, 'y');
    const zIdx = getAsciiFieldTokenIndex(header, 'z');
    if (xIdx === null || yIdx === null || zIdx === null) {
        throw new Error('ASCII PCD is missing x/y/z fields.');
    }

    let expectedTokenCount = 0;
    if (header.fields && header.counts) {
        for (let i = 0; i < header.fields.length; i++) expectedTokenCount += header.counts[i] ?? 1;
    }

    let parsedPoints = 0;
    for (let i = 0; i < lines.length; i += sampleRatio) {
        if (parsedPoints >= estimated) break;
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        const tokens = line.split(/\s+/);
        if (tokens.length < expectedTokenCount) continue;
        const x = parseAsciiNumericToken(tokens[xIdx]);
        const y = parseAsciiNumericToken(tokens[yIdx]);
        const z = parseAsciiNumericToken(tokens[zIdx]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        const base = parsedPoints * 3;
        positions[base] = x; positions[base + 1] = y; positions[base + 2] = z;
        values[parsedPoints] = (intensitySpec && intensityTokenIndex !== null)
            ? parseAsciiNumericToken(tokens[intensityTokenIndex]) : z;
        if (rgbColors && rgbSpec && rgbTokenIndex !== null) {
            const rgbInt = parseAsciiPackedRGB(tokens[rgbTokenIndex], rgbSpec.type, rgbSpec.size);
            rgbColors[base]     = (rgbInt >> 16) & 0xFF;
            rgbColors[base + 1] = (rgbInt >>  8) & 0xFF;
            rgbColors[base + 2] =  rgbInt        & 0xFF;
        }
        parsedPoints++;
    }

    return {
        positions: positions.subarray(0, parsedPoints * 3),
        values:    values.subarray(0, parsedPoints),
        rgb:       rgbColors ? rgbColors.subarray(0, parsedPoints * 3) : undefined,
    };
}

/** Process one binary PCD chunk, appending to state.posBuffer etc. */
export function processPCDBinaryChunk(
    data: Uint8Array,
    header: PCDHeader,
    state: PCDBinaryState,
): void {
    const rowSize   = header.rowSize;
    const totalBytes = data.byteLength;
    const count     = Math.floor(totalBytes / rowSize);

    const xOff = header.offset['x'] || 0;
    const yOff = header.offset['y'] || 4;
    const zOff = header.offset['z'] || 8;

    const intensitySpec = getFieldSpec(header, 'intensity');
    const valOff        = intensitySpec ? intensitySpec.offset : -1;

    let rgbOff  = header.offset['rgb'] ?? header.offset['rgba'] ?? -1;
    let rgbSpec = getFieldSpec(header, 'rgb') ?? getFieldSpec(header, 'rgba');

    const isStandardXYZ  = (xOff === 0 && yOff === 4 && zOff === 8);
    const isFloatAligned = (rowSize % 4 === 0);
    const startIndex     = (state.targetSampleRatio - (state.pointsLoaded % state.targetSampleRatio)) % state.targetSampleRatio;

    const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

    if (isStandardXYZ && isFloatAligned) {
        const floatsPerRow = rowSize / 4;
        const floatCount   = count * floatsPerRow;

        let floatView: Float32Array;
        let uint32View: Uint32Array | null = null;

        if (data.byteOffset % 4 === 0 && data.byteLength % 4 === 0) {
            floatView  = new Float32Array(data.buffer, data.byteOffset, floatCount);
            if (rgbOff !== -1) uint32View = new Uint32Array(data.buffer, data.byteOffset, floatCount);
        } else {
            const aligned = new Uint8Array(data);
            floatView  = new Float32Array(aligned.buffer, 0, floatCount);
            if (rgbOff !== -1) uint32View = new Uint32Array(aligned.buffer, 0, floatCount);
        }

        const valOffFloat = (valOff !== -1 && valOff % 4 === 0 && intensitySpec?.type === 'F' && intensitySpec?.size === 4)
            ? (valOff / 4) : -1;
        const rgbOffFloat = (rgbOff !== -1 && rgbOff % 4 === 0) ? (rgbOff / 4) : -1;
        const doRGB       = (state.rgbBuffer !== null && rgbOffFloat !== -1 && uint32View !== null);

        for (let i = startIndex; i < count; i += state.targetSampleRatio) {
            if (state.posIndex >= state.posBuffer.length / 3) break;
            const base = i * floatsPerRow;
            state.posBuffer[state.posIndex * 3]     = floatView[base];
            state.posBuffer[state.posIndex * 3 + 1] = floatView[base + 1];
            state.posBuffer[state.posIndex * 3 + 2] = floatView[base + 2];

            if (valOffFloat !== -1) {
                state.valBuffer[state.posIndex] = floatView[base + valOffFloat];
            } else if (intensitySpec && intensitySpec.count === 1) {
                state.valBuffer[state.posIndex] = readNumericValue(dataView, i * rowSize + valOff, intensitySpec.type, intensitySpec.size);
            } else {
                state.valBuffer[state.posIndex] = floatView[base + 2];
            }

            if (doRGB) {
                const rgbInt = uint32View![base + rgbOffFloat];
                state.rgbBuffer![state.posIndex * 3]     = (rgbInt >> 16) & 0xFF;
                state.rgbBuffer![state.posIndex * 3 + 1] = (rgbInt >>  8) & 0xFF;
                state.rgbBuffer![state.posIndex * 3 + 2] =  rgbInt        & 0xFF;
            } else if (state.rgbBuffer && rgbOff !== -1 && rgbSpec && rgbSpec.count === 1) {
                const rgbInt = readPackedRGB(dataView, i * rowSize + rgbOff, rgbSpec.type, rgbSpec.size);
                state.rgbBuffer[state.posIndex * 3]     = (rgbInt >> 16) & 0xFF;
                state.rgbBuffer[state.posIndex * 3 + 1] = (rgbInt >>  8) & 0xFF;
                state.rgbBuffer[state.posIndex * 3 + 2] =  rgbInt        & 0xFF;
            }
            state.posIndex++;
        }
    } else {
        for (let i = startIndex; i < count; i += state.targetSampleRatio) {
            if (state.posIndex >= state.posBuffer.length / 3) break;
            const base = i * rowSize;
            const pIdx = state.posIndex * 3;
            state.posBuffer[pIdx]     = dataView.getFloat32(base + xOff, true);
            state.posBuffer[pIdx + 1] = dataView.getFloat32(base + yOff, true);
            state.posBuffer[pIdx + 2] = dataView.getFloat32(base + zOff, true);

            if (intensitySpec && intensitySpec.count === 1 && valOff !== -1) {
                state.valBuffer[state.posIndex] = readNumericValue(dataView, base + valOff, intensitySpec.type, intensitySpec.size);
            } else {
                state.valBuffer[state.posIndex] = state.posBuffer[pIdx + 2];
            }

            if (state.rgbBuffer && rgbOff !== -1 && rgbSpec && rgbSpec.count === 1) {
                const rgbInt = readPackedRGB(dataView, base + rgbOff, rgbSpec.type, rgbSpec.size);
                state.rgbBuffer[pIdx]     = (rgbInt >> 16) & 0xFF;
                state.rgbBuffer[pIdx + 1] = (rgbInt >>  8) & 0xFF;
                state.rgbBuffer[pIdx + 2] =  rgbInt        & 0xFF;
            }
            state.posIndex++;
        }
    }

    state.pointsLoaded += count;
    const leftovers     = totalBytes - (count * rowSize);
    state.leftoverChunk = leftovers > 0 ? data.slice(count * rowSize) : null;
}
