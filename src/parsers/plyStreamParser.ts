import type { ParsedCloud } from './pcdParser';
import {
    decodePLYPackedRGB,
    parsePLYHeader,
    plyTypeSize,
    readPLYValue,
    type PLYHeader,
} from './plyParser';
import { computePointSampleRatio, estimateSampledPointCount } from './sampling';

interface PLYDerivedFields {
    hasRed: boolean;
    hasPackedRGB: boolean;
    hasIntensity: boolean;
    intensityName: string;
    xIndex: number;
    yIndex: number;
    zIndex: number;
    intensityIndex: number;
    redIndex: number;
    greenIndex: number;
    blueIndex: number;
    packedRgbIndex: number;
    packedRgbType: string;
}

export interface PLYStreamState extends PLYDerivedFields {
    header: PLYHeader;
    positions: Float32Array;
    values: Float32Array;
    rgb: Uint8Array | null;
    parsedPoints: number;
    vertexIndex: number;
    sampleRatio: number;
    leftoverLine: string;
    decoder: TextDecoder;
    binaryLeftover: Uint8Array | null;
    vertexByteSize: number;
    propOffsets: number[];
    intensityIsFloat: boolean;
    maxIntensityRaw: number;
}

export function findPLYHeaderEnd(data: Uint8Array): number {
    const probe = new TextDecoder().decode(data.subarray(0, Math.min(data.byteLength, 100000)));
    const endHeaderIdx = probe.indexOf('end_header');
    if (endHeaderIdx === -1) return -1;
    const nlIdx = probe.indexOf('\n', endHeaderIdx);
    return nlIdx === -1 ? -1 : nlIdx + 1;
}

function deriveFields(header: PLYHeader): PLYDerivedFields {
    const propIndex = header.propIndex;
    if (!('x' in propIndex) || !('y' in propIndex) || !('z' in propIndex)) {
        throw new Error('PLY missing x/y/z properties');
    }
    const hasRed = 'red' in propIndex && 'green' in propIndex && 'blue' in propIndex;
    const hasPackedRGB = 'rgb' in propIndex;
    const hasIntensity = 'intensity' in propIndex || 'scalar_intensity' in propIndex
        || 'scalar_Intensity' in propIndex || 'reflectance' in propIndex;
    const intensityName = 'intensity' in propIndex ? 'intensity'
        : 'scalar_intensity' in propIndex ? 'scalar_intensity'
        : 'scalar_Intensity' in propIndex ? 'scalar_Intensity'
        : 'reflectance';
    return {
        hasRed,
        hasPackedRGB,
        hasIntensity,
        intensityName,
        xIndex: propIndex['x'],
        yIndex: propIndex['y'],
        zIndex: propIndex['z'],
        intensityIndex: hasIntensity ? propIndex[intensityName] : -1,
        redIndex: hasRed ? propIndex['red'] : -1,
        greenIndex: hasRed ? propIndex['green'] : -1,
        blueIndex: hasRed ? propIndex['blue'] : -1,
        packedRgbIndex: hasPackedRGB ? propIndex['rgb'] : -1,
        packedRgbType: hasPackedRGB ? header.vertexProps[propIndex['rgb']].type : '',
    };
}

export function createPLYStreamState(
    header: PLYHeader,
    maxPoints: number,
    sourceBytes: number = 0,
): PLYStreamState {
    const fields = deriveFields(header);
    const sampleRatio = computePointSampleRatio(header.vertexCount, maxPoints, sourceBytes);
    const estimated = estimateSampledPointCount(header.vertexCount, sampleRatio, maxPoints);
    const propOffsets: number[] = [];
    let vertexByteSize = 0;
    for (const prop of header.vertexProps) {
        propOffsets.push(vertexByteSize);
        vertexByteSize += plyTypeSize(prop.type);
    }
    return {
        header,
        ...fields,
        positions: new Float32Array(estimated * 3),
        values: new Float32Array(estimated),
        rgb: fields.hasRed || fields.hasPackedRGB ? new Uint8Array(estimated * 3) : null,
        parsedPoints: 0,
        vertexIndex: 0,
        sampleRatio,
        leftoverLine: '',
        decoder: new TextDecoder(),
        binaryLeftover: null,
        vertexByteSize,
        propOffsets,
        intensityIsFloat: false,
        maxIntensityRaw: 0,
    };
}

function processAsciiLine(state: PLYStreamState, rawLine: string): void {
    if (state.vertexIndex >= state.header.vertexCount) return;
    const line = rawLine.trim();
    if (!line) return;
    const tokens = line.split(/\s+/);
    if (tokens.length < state.header.vertexProps.length) return;

    const rawIndex = state.vertexIndex++;
    if (rawIndex % state.sampleRatio !== 0) return;
    if (state.parsedPoints >= state.values.length) return;

    const x = parseFloat(tokens[state.xIndex]);
    const y = parseFloat(tokens[state.yIndex]);
    const z = parseFloat(tokens[state.zIndex]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    const base = state.parsedPoints * 3;
    state.positions[base] = x;
    state.positions[base + 1] = y;
    state.positions[base + 2] = z;

    if (state.intensityIndex >= 0) {
        const value = parseFloat(tokens[state.intensityIndex]);
        if (Number.isFinite(value)) {
            state.values[state.parsedPoints] = value;
            if (!Number.isInteger(value)) state.intensityIsFloat = true;
            state.maxIntensityRaw = Math.max(state.maxIntensityRaw, Math.abs(value));
        }
    } else {
        state.values[state.parsedPoints] = z;
    }

    if (state.rgb) {
        if (state.hasRed) {
            state.rgb[base] = parseInt(tokens[state.redIndex]);
            state.rgb[base + 1] = parseInt(tokens[state.greenIndex]);
            state.rgb[base + 2] = parseInt(tokens[state.blueIndex]);
        } else if (state.hasPackedRGB) {
            const rgbInt = decodePLYPackedRGB(parseFloat(tokens[state.packedRgbIndex]), state.packedRgbType);
            state.rgb[base] = (rgbInt >> 16) & 0xFF;
            state.rgb[base + 1] = (rgbInt >> 8) & 0xFF;
            state.rgb[base + 2] = rgbInt & 0xFF;
        }
    }
    state.parsedPoints++;
}

function processAsciiChunk(state: PLYStreamState, data: Uint8Array): void {
    if (data.byteLength === 0) return;
    const text = state.leftoverLine + state.decoder.decode(data, { stream: true });
    const lines = text.split('\n');
    state.leftoverLine = lines.pop() ?? '';
    for (const line of lines) processAsciiLine(state, line.endsWith('\r') ? line.slice(0, -1) : line);
}

function processBinaryChunk(state: PLYStreamState, data: Uint8Array): void {
    if (data.byteLength === 0 || state.vertexByteSize <= 0) return;
    let chunk = data;
    if (state.binaryLeftover) {
        const merged = new Uint8Array(state.binaryLeftover.byteLength + data.byteLength);
        merged.set(state.binaryLeftover);
        merged.set(data, state.binaryLeftover.byteLength);
        chunk = merged;
        state.binaryLeftover = null;
    }

    const remainingVertices = state.header.vertexCount - state.vertexIndex;
    const availableVertices = Math.min(Math.floor(chunk.byteLength / state.vertexByteSize), remainingVertices);
    const usedBytes = availableVertices * state.vertexByteSize;
    const isLE = state.header.format === 'binary_little_endian';
    const view = new DataView(chunk.buffer, chunk.byteOffset, usedBytes);

    for (let i = 0; i < availableVertices; i++) {
        const rawIndex = state.vertexIndex++;
        if (rawIndex % state.sampleRatio !== 0) continue;
        if (state.parsedPoints >= state.values.length) break;

        const rowOffset = i * state.vertexByteSize;
        const base = state.parsedPoints * 3;
        state.positions[base] = readPLYValue(view, rowOffset + state.propOffsets[state.xIndex], state.header.vertexProps[state.xIndex].type, isLE);
        state.positions[base + 1] = readPLYValue(view, rowOffset + state.propOffsets[state.yIndex], state.header.vertexProps[state.yIndex].type, isLE);
        state.positions[base + 2] = readPLYValue(view, rowOffset + state.propOffsets[state.zIndex], state.header.vertexProps[state.zIndex].type, isLE);
        state.values[state.parsedPoints] = state.intensityIndex >= 0
            ? readPLYValue(view, rowOffset + state.propOffsets[state.intensityIndex], state.header.vertexProps[state.intensityIndex].type, isLE)
            : state.positions[base + 2];

        if (state.rgb) {
            if (state.hasRed) {
                state.rgb[base] = readPLYValue(view, rowOffset + state.propOffsets[state.redIndex], state.header.vertexProps[state.redIndex].type, isLE);
                state.rgb[base + 1] = readPLYValue(view, rowOffset + state.propOffsets[state.greenIndex], state.header.vertexProps[state.greenIndex].type, isLE);
                state.rgb[base + 2] = readPLYValue(view, rowOffset + state.propOffsets[state.blueIndex], state.header.vertexProps[state.blueIndex].type, isLE);
            } else if (state.hasPackedRGB) {
                const rgbValue = readPLYValue(view, rowOffset + state.propOffsets[state.packedRgbIndex], state.header.vertexProps[state.packedRgbIndex].type, isLE);
                const rgbInt = decodePLYPackedRGB(rgbValue, state.packedRgbType);
                state.rgb[base] = (rgbInt >> 16) & 0xFF;
                state.rgb[base + 1] = (rgbInt >> 8) & 0xFF;
                state.rgb[base + 2] = rgbInt & 0xFF;
            }
        }
        state.parsedPoints++;
    }

    const leftoverStart = usedBytes;
    state.binaryLeftover = leftoverStart < chunk.byteLength && state.vertexIndex < state.header.vertexCount
        ? chunk.slice(leftoverStart)
        : null;
}

export function processPLYStreamChunk(state: PLYStreamState, data: Uint8Array): void {
    if (state.header.format === 'ascii') processAsciiChunk(state, data);
    else processBinaryChunk(state, data);
}

export function finalizePLYStreamState(state: PLYStreamState): ParsedCloud {
    if (state.header.format === 'ascii') {
        const tail = state.leftoverLine + state.decoder.decode();
        state.leftoverLine = '';
        if (tail) processAsciiLine(state, tail.endsWith('\r') ? tail.slice(0, -1) : tail);
        if (state.hasIntensity && state.intensityIsFloat && state.maxIntensityRaw > 0 && state.maxIntensityRaw <= 1.0) {
            for (let i = 0; i < state.parsedPoints; i++) state.values[i] = Math.round(state.values[i] * 255);
        }
    }
    state.binaryLeftover = null;
    return {
        positions: state.positions.subarray(0, state.parsedPoints * 3),
        values: state.values.subarray(0, state.parsedPoints),
        rgb: state.rgb ? state.rgb.subarray(0, state.parsedPoints * 3) : undefined,
    };
}

export function parsePLYStreamHeader(data: Uint8Array): PLYHeader {
    return parsePLYHeader(data);
}
