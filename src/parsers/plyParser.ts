/**
 * PLY point-cloud parser.
 * Extracted from viewer.ts for modularity.
 */

import type { ParsedCloud } from './pcdParser';
import { computePointSampleRatio, estimateSampledPointCount } from './sampling';

export interface PLYProp { name: string; type: string; }

export interface PLYHeader {
    format: string;
    vertexCount: number;
    vertexProps: PLYProp[];
    propIndex: { [key: string]: number };
    dataStartByte: number;
}

export function plyTypeSize(type: string): number {
    switch (type) {
        case 'char': case 'int8':
        case 'uchar': case 'uint8': return 1;
        case 'short': case 'int16':
        case 'ushort': case 'uint16': return 2;
        case 'int': case 'int32': case 'float': case 'float32':
        case 'uint': case 'uint32': return 4;
        case 'double': case 'float64': return 8;
        default: return 4;
    }
}

export function readPLYValue(view: DataView, offset: number, type: string, isLE: boolean): number {
    switch (type) {
        case 'char': case 'int8':    return view.getInt8(offset);
        case 'uchar': case 'uint8':  return view.getUint8(offset);
        case 'short': case 'int16':  return view.getInt16(offset, isLE);
        case 'ushort': case 'uint16':return view.getUint16(offset, isLE);
        case 'int': case 'int32':    return view.getInt32(offset, isLE);
        case 'uint': case 'uint32':  return view.getUint32(offset, isLE);
        case 'float': case 'float32':return view.getFloat32(offset, isLE);
        case 'double': case 'float64':return view.getFloat64(offset, isLE);
        default: return view.getFloat32(offset, isLE);
    }
}

export function decodePLYPackedRGB(value: number, type: string): number {
    if (type === 'float' || type === 'float32') {
        const buf = new ArrayBuffer(4);
        const dv  = new DataView(buf);
        dv.setFloat32(0, value, true);
        return dv.getUint32(0, true);
    }
    return (Math.max(0, Math.trunc(value)) >>> 0);
}

export function parsePLYHeader(data: Uint8Array): PLYHeader {
    const headerRegion = new TextDecoder().decode(data.subarray(0, Math.min(data.byteLength, 100000)));
    const endHeaderIdx = headerRegion.indexOf('end_header');
    if (endHeaderIdx === -1) throw new Error('Invalid PLY file: missing end_header');
    const nlIdx = headerRegion.indexOf('\n', endHeaderIdx);
    if (nlIdx === -1) throw new Error('Invalid PLY file: malformed end_header');
    const dataStartByte = nlIdx + 1;

    const headerStr = headerRegion.substring(0, endHeaderIdx);
    const lines = headerStr.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('comment'));

    if (lines[0] !== 'ply') throw new Error('Not a PLY file');

    let format = 'ascii';
    let vertexCount = 0;
    const vertexProps: PLYProp[] = [];
    let currentElement = '';

    for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts[0] === 'format') {
            format = parts[1];
        } else if (parts[0] === 'element') {
            currentElement = parts[1];
            if (currentElement === 'vertex') vertexCount = parseInt(parts[2]);
        } else if (parts[0] === 'property' && currentElement === 'vertex') {
            if (parts[1] === 'list') continue;
            vertexProps.push({ name: parts[2], type: parts[1] });
        }
    }

    const propIndex: { [key: string]: number } = {};
    vertexProps.forEach((p, i) => { propIndex[p.name] = i; });

    return { format, vertexCount, vertexProps, propIndex, dataStartByte };
}

/** Parse a PLY file (entire Uint8Array). Returns positions/values/rgb. */
export function parsePLY(data: Uint8Array, maxPoints: number, sourceBytes: number = data.byteLength): ParsedCloud {
    const { format, vertexCount, vertexProps, propIndex, dataStartByte } = parsePLYHeader(data);

    console.log(`PLY: format=${format}, vertices=${vertexCount}, props=${vertexProps.map(p => p.name).join(',')}`);

    if (!('x' in propIndex) || !('y' in propIndex) || !('z' in propIndex)) {
        throw new Error('PLY missing x/y/z properties');
    }

    const hasRed       = 'red' in propIndex && 'green' in propIndex && 'blue' in propIndex;
    const hasPackedRGB = 'rgb' in propIndex;
    const hasIntensity = 'intensity' in propIndex || 'scalar_intensity' in propIndex
        || 'scalar_Intensity' in propIndex || 'reflectance' in propIndex;
    const intensityName = 'intensity' in propIndex ? 'intensity'
        : 'scalar_intensity' in propIndex ? 'scalar_intensity'
        : 'scalar_Intensity' in propIndex ? 'scalar_Intensity'
        : 'reflectance';

    const sampleRatio = computePointSampleRatio(vertexCount, maxPoints, sourceBytes);
    const estimatedVisPoints = estimateSampledPointCount(vertexCount, sampleRatio, maxPoints);

    const positions = new Float32Array(estimatedVisPoints * 3);
    const values    = new Float32Array(estimatedVisPoints);
    const rgbColors = (hasRed || hasPackedRGB) ? new Uint8Array(estimatedVisPoints * 3) : null;

    let parsedPoints = 0;

    if (format === 'ascii') {
        const bytes   = data;
        const total   = bytes.byteLength;
        const LF      = 0x0A;
        let lineStart = dataStartByte;
        let vertexIndex     = 0;
        let intensityIsFloat = false;
        let maxIntensityRaw  = 0;

        const xIdx          = propIndex['x'];
        const yIdx          = propIndex['y'];
        const zIdx          = propIndex['z'];
        const iIdx          = hasIntensity ? propIndex[intensityName] : -1;
        const rIdx          = hasRed       ? propIndex['red']         : -1;
        const gIdx          = hasRed       ? propIndex['green']       : -1;
        const bIdx          = hasRed       ? propIndex['blue']        : -1;
        const rgbPackedIdx  = hasPackedRGB ? propIndex['rgb']         : -1;
        const rgbPackedType = hasPackedRGB ? vertexProps[propIndex['rgb']].type : '';

        const decoder = new TextDecoder();

        const processLine = (lineBytes: Uint8Array) => {
            let end = lineBytes.byteLength;
            if (end > 0 && lineBytes[end - 1] === 0x0D) end--;
            if (end === 0) return;
            const lineStr = decoder.decode(lineBytes.subarray(0, end));
            if (!lineStr.trim()) return;
            const tokens = lineStr.split(/\s+/);
            const offset = tokens[0] === '' ? 1 : 0;
            if (tokens.length - offset < vertexProps.length) return;

            if (vertexIndex % sampleRatio === 0 && parsedPoints < estimatedVisPoints) {
                const base = parsedPoints * 3;
                const x = parseFloat(tokens[xIdx + offset]);
                const y = parseFloat(tokens[yIdx + offset]);
                const z = parseFloat(tokens[zIdx + offset]);
                if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                    positions[base] = x; positions[base + 1] = y; positions[base + 2] = z;
                    if (iIdx >= 0) {
                        const v = parseFloat(tokens[iIdx + offset]);
                        if (Number.isFinite(v)) {
                            values[parsedPoints] = v;
                            if (!Number.isInteger(v)) intensityIsFloat = true;
                            const av = Math.abs(v);
                            if (av > maxIntensityRaw) maxIntensityRaw = av;
                        }
                    } else { values[parsedPoints] = z; }

                    if (rgbColors) {
                        if (hasRed) {
                            rgbColors[base]     = parseInt(tokens[rIdx + offset]);
                            rgbColors[base + 1] = parseInt(tokens[gIdx + offset]);
                            rgbColors[base + 2] = parseInt(tokens[bIdx + offset]);
                        } else if (hasPackedRGB) {
                            const rgbInt = decodePLYPackedRGB(parseFloat(tokens[rgbPackedIdx + offset]), rgbPackedType);
                            rgbColors[base]     = (rgbInt >> 16) & 0xFF;
                            rgbColors[base + 1] = (rgbInt >>  8) & 0xFF;
                            rgbColors[base + 2] =  rgbInt        & 0xFF;
                        }
                    }
                    parsedPoints++;
                }
            }
            vertexIndex++;
        };

        for (let i = dataStartByte; i < total && vertexIndex < vertexCount; i++) {
            if (bytes[i] === LF) {
                processLine(bytes.subarray(lineStart, i));
                lineStart = i + 1;
            }
        }
        if (lineStart < total && vertexIndex < vertexCount) {
            processLine(bytes.subarray(lineStart, total));
        }

        console.log(`PLY ASCII parsed ${parsedPoints} pts, intensityIsFloat=${intensityIsFloat}, maxRaw=${maxIntensityRaw}`);

        if (hasIntensity && intensityIsFloat && maxIntensityRaw > 0 && maxIntensityRaw <= 1.0) {
            for (let i = 0; i < parsedPoints; i++) values[i] = Math.round(values[i] * 255);
        }
    } else {
        const isLE = format === 'binary_little_endian';
        const view = new DataView(data.buffer, data.byteOffset + dataStartByte, data.byteLength - dataStartByte);

        let vertexByteSize = 0;
        const propOffsets: number[] = [];
        for (const prop of vertexProps) {
            propOffsets.push(vertexByteSize);
            vertexByteSize += plyTypeSize(prop.type);
        }

        for (let i = 0; i < vertexCount; i += sampleRatio) {
            if (parsedPoints >= estimatedVisPoints) break;
            const rowOffset = i * vertexByteSize;
            if (rowOffset + vertexByteSize > view.byteLength) break;
            const base = parsedPoints * 3;
            positions[base]     = readPLYValue(view, rowOffset + propOffsets[propIndex['x']], vertexProps[propIndex['x']].type, isLE);
            positions[base + 1] = readPLYValue(view, rowOffset + propOffsets[propIndex['y']], vertexProps[propIndex['y']].type, isLE);
            positions[base + 2] = readPLYValue(view, rowOffset + propOffsets[propIndex['z']], vertexProps[propIndex['z']].type, isLE);

            values[parsedPoints] = (hasIntensity && intensityName in propIndex)
                ? readPLYValue(view, rowOffset + propOffsets[propIndex[intensityName]], vertexProps[propIndex[intensityName]].type, isLE)
                : positions[base + 2];

            if (rgbColors) {
                if (hasRed) {
                    rgbColors[base]     = readPLYValue(view, rowOffset + propOffsets[propIndex['red']],   vertexProps[propIndex['red']].type,   isLE);
                    rgbColors[base + 1] = readPLYValue(view, rowOffset + propOffsets[propIndex['green']], vertexProps[propIndex['green']].type, isLE);
                    rgbColors[base + 2] = readPLYValue(view, rowOffset + propOffsets[propIndex['blue']],  vertexProps[propIndex['blue']].type,  isLE);
                } else if (hasPackedRGB) {
                    const floatVal = readPLYValue(view, rowOffset + propOffsets[propIndex['rgb']], vertexProps[propIndex['rgb']].type, isLE);
                    const rgbInt   = decodePLYPackedRGB(floatVal, vertexProps[propIndex['rgb']].type);
                    rgbColors[base]     = (rgbInt >> 16) & 0xFF;
                    rgbColors[base + 1] = (rgbInt >>  8) & 0xFF;
                    rgbColors[base + 2] =  rgbInt        & 0xFF;
                }
            }
            parsedPoints++;
        }
    }

    return {
        positions: positions.subarray(0, parsedPoints * 3),
        values:    values.subarray(0, parsedPoints),
        rgb:       rgbColors ? rgbColors.subarray(0, parsedPoints * 3) : undefined,
    };
}
