import {
    getAsciiFieldTokenIndex,
    getFieldSpec,
    parseAsciiNumericToken,
    parseAsciiPackedRGB,
    type ParsedCloud,
    type PCDHeader,
} from './pcdParser';
import { computePointSampleRatio, estimateSampledPointCount } from './sampling';

export interface PCDAsciiStreamState {
    positions: Float32Array;
    values: Float32Array;
    rgb: Uint8Array | null;
    parsedPoints: number;
    rawPointIndex: number;
    sampleRatio: number;
    leftoverLine: string;
    decoder: TextDecoder;
    expectedTokenCount: number;
    xIndex: number;
    yIndex: number;
    zIndex: number;
    intensityIndex: number | null;
    rgbIndex: number | null;
    rgbType: string;
    rgbSize: number;
}

export function createPCDAsciiStreamState(
    header: PCDHeader,
    maxPoints: number,
    sourceBytes: number = 0,
): PCDAsciiStreamState {
    const sampleRatio = computePointSampleRatio(header.points, maxPoints, sourceBytes);
    const estimated = estimateSampledPointCount(header.points, sampleRatio, maxPoints);
    const intensitySpec = getFieldSpec(header, 'intensity');
    const rgbSpec = getFieldSpec(header, 'rgb') ?? getFieldSpec(header, 'rgba');
    const xIndex = getAsciiFieldTokenIndex(header, 'x');
    const yIndex = getAsciiFieldTokenIndex(header, 'y');
    const zIndex = getAsciiFieldTokenIndex(header, 'z');
    if (xIndex === null || yIndex === null || zIndex === null) {
        throw new Error('ASCII PCD is missing x/y/z fields.');
    }

    let expectedTokenCount = 0;
    if (header.fields && header.counts) {
        for (let i = 0; i < header.fields.length; i++) expectedTokenCount += header.counts[i] ?? 1;
    }

    return {
        positions: new Float32Array(estimated * 3),
        values: new Float32Array(estimated),
        rgb: rgbSpec ? new Uint8Array(estimated * 3) : null,
        parsedPoints: 0,
        rawPointIndex: 0,
        sampleRatio,
        leftoverLine: '',
        decoder: new TextDecoder(),
        expectedTokenCount,
        xIndex,
        yIndex,
        zIndex,
        intensityIndex: intensitySpec ? getAsciiFieldTokenIndex(header, 'intensity') : null,
        rgbIndex: rgbSpec ? getAsciiFieldTokenIndex(header, 'rgb') ?? getAsciiFieldTokenIndex(header, 'rgba') : null,
        rgbType: rgbSpec?.type ?? 'U',
        rgbSize: rgbSpec?.size ?? 4,
    };
}

function processLine(state: PCDAsciiStreamState, rawLine: string): void {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const tokens = line.split(/\s+/);
    if (state.expectedTokenCount > 0 && tokens.length < state.expectedTokenCount) return;

    const rawIndex = state.rawPointIndex++;
    if (rawIndex % state.sampleRatio !== 0) return;
    if (state.parsedPoints >= state.values.length) return;

    const x = parseAsciiNumericToken(tokens[state.xIndex]);
    const y = parseAsciiNumericToken(tokens[state.yIndex]);
    const z = parseAsciiNumericToken(tokens[state.zIndex]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    const base = state.parsedPoints * 3;
    state.positions[base] = x;
    state.positions[base + 1] = y;
    state.positions[base + 2] = z;
    state.values[state.parsedPoints] = state.intensityIndex !== null
        ? parseAsciiNumericToken(tokens[state.intensityIndex])
        : z;

    if (state.rgb && state.rgbIndex !== null) {
        const rgbInt = parseAsciiPackedRGB(tokens[state.rgbIndex], state.rgbType, state.rgbSize);
        state.rgb[base] = (rgbInt >> 16) & 0xFF;
        state.rgb[base + 1] = (rgbInt >> 8) & 0xFF;
        state.rgb[base + 2] = rgbInt & 0xFF;
    }

    state.parsedPoints++;
}

export function processPCDAsciiStreamChunk(state: PCDAsciiStreamState, data: Uint8Array): void {
    if (data.byteLength === 0) return;
    const text = state.leftoverLine + state.decoder.decode(data, { stream: true });
    const lines = text.split('\n');
    state.leftoverLine = lines.pop() ?? '';
    for (const line of lines) processLine(state, line.endsWith('\r') ? line.slice(0, -1) : line);
}

export function finalizePCDAsciiStream(state: PCDAsciiStreamState): ParsedCloud {
    const tail = state.leftoverLine + state.decoder.decode();
    state.leftoverLine = '';
    if (tail) processLine(state, tail.endsWith('\r') ? tail.slice(0, -1) : tail);
    return {
        positions: state.positions.subarray(0, state.parsedPoints * 3),
        values: state.values.subarray(0, state.parsedPoints),
        rgb: state.rgb ? state.rgb.subarray(0, state.parsedPoints * 3) : undefined,
    };
}
