import { ColorMode, PointCloud2Json, PointFieldJson } from './realtimeTypes';

const PF_INT8 = 1;
const PF_UINT8 = 2;
const PF_INT16 = 3;
const PF_UINT16 = 4;
const PF_INT32 = 5;
const PF_UINT32 = 6;
const PF_FLOAT32 = 7;
const PF_FLOAT64 = 8;

export function decodePointCloud2(
    msg: PointCloud2Json,
    maxPointsPerScan: number,
    colorMode: ColorMode,
): {
    positions: Float32Array;
    values: Float32Array;
    rgb?: Uint8Array;
} | null {
    if (!msg || !Array.isArray(msg.fields) || msg.fields.length === 0 || !msg.data) {
        return null;
    }

    const pointCountRaw = Math.max(msg.width * msg.height, 0);
    if (pointCountRaw === 0 || msg.point_step <= 0) return null;

    const rawBytes = decodeBase64(msg.data);
    const availableCount = Math.floor(rawBytes.byteLength / msg.point_step);
    const pointCount = Math.min(pointCountRaw, availableCount);
    if (pointCount <= 0) return null;

    const sampleRatio = maxPointsPerScan > 0 && pointCount > maxPointsPerScan
        ? Math.ceil(pointCount / maxPointsPerScan)
        : 1;
    const sampledCount = Math.ceil(pointCount / sampleRatio);

    const fieldMap = new Map<string, PointFieldJson>();
    for (const field of msg.fields) fieldMap.set(field.name, field);

    const fx = fieldMap.get('x');
    const fy = fieldMap.get('y');
    const fz = fieldMap.get('z');
    if (!fx || !fy || !fz) return null;

    const fi = fieldMap.get('intensity');
    const frgbPacked = colorMode === 'RGB' ? (fieldMap.get('rgb') ?? fieldMap.get('rgba')) : undefined;
    const fr = colorMode === 'RGB' ? (fieldMap.get('r') ?? fieldMap.get('red')) : undefined;
    const fg = colorMode === 'RGB' ? (fieldMap.get('g') ?? fieldMap.get('green')) : undefined;
    const fb = colorMode === 'RGB' ? (fieldMap.get('b') ?? fieldMap.get('blue')) : undefined;

    const positions = new Float32Array(sampledCount * 3);
    const values = new Float32Array(sampledCount);
    const hasRgb = colorMode === 'RGB';
    const rgb = hasRgb ? new Uint8Array(sampledCount * 3) : undefined;

    const littleEndian = !msg.is_bigendian;
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);

    let writeIndex = 0;
    for (let i = 0; i < pointCount; i += sampleRatio) {
        const base = i * msg.point_step;
        const outBase = writeIndex * 3;

        const x = readPointField(view, base + fx.offset, fx.datatype, littleEndian);
        const y = readPointField(view, base + fy.offset, fy.datatype, littleEndian);
        const z = readPointField(view, base + fz.offset, fz.datatype, littleEndian);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

        positions[outBase] = x;
        positions[outBase + 1] = y;
        positions[outBase + 2] = z;

        if (fi) {
            const intensity = readPointField(view, base + fi.offset, fi.datatype, littleEndian);
            values[writeIndex] = Number.isFinite(intensity) ? intensity : z;
        } else {
            values[writeIndex] = z;
        }

        if (rgb) {
            if (frgbPacked) {
                const packed = readPackedRgb(view, base + frgbPacked.offset, frgbPacked.datatype, littleEndian);
                rgb[outBase] = (packed >> 16) & 0xFF;
                rgb[outBase + 1] = (packed >> 8) & 0xFF;
                rgb[outBase + 2] = packed & 0xFF;
            } else if (fr && fg && fb) {
                rgb[outBase] = toU8(readPointField(view, base + fr.offset, fr.datatype, littleEndian));
                rgb[outBase + 1] = toU8(readPointField(view, base + fg.offset, fg.datatype, littleEndian));
                rgb[outBase + 2] = toU8(readPointField(view, base + fb.offset, fb.datatype, littleEndian));
            }
        }

        writeIndex++;
        if (writeIndex >= sampledCount) break;
    }

    return {
        positions: positions.subarray(0, writeIndex * 3),
        values: values.subarray(0, writeIndex),
        rgb: rgb ? rgb.subarray(0, writeIndex * 3) : undefined,
    };
}

export function inferColorModeFromFields(fields: PointFieldJson[] | undefined): ColorMode {
    if (!Array.isArray(fields) || fields.length === 0) return 'FLAT';

    const fieldMap = new Map<string, PointFieldJson>();
    for (const field of fields) fieldMap.set(field.name, field);

    const frgbPacked = fieldMap.get('rgb') ?? fieldMap.get('rgba');
    const fr = fieldMap.get('r') ?? fieldMap.get('red');
    const fg = fieldMap.get('g') ?? fieldMap.get('green');
    const fb = fieldMap.get('b') ?? fieldMap.get('blue');
    const fi = fieldMap.get('intensity');

    if (frgbPacked || (fr && fg && fb)) return 'RGB';
    if (fi) return 'I';
    return 'FLAT';
}

function readPointField(view: DataView, byteOffset: number, datatype: number, littleEndian: boolean): number {
    switch (datatype) {
        case PF_INT8: return view.getInt8(byteOffset);
        case PF_UINT8: return view.getUint8(byteOffset);
        case PF_INT16: return view.getInt16(byteOffset, littleEndian);
        case PF_UINT16: return view.getUint16(byteOffset, littleEndian);
        case PF_INT32: return view.getInt32(byteOffset, littleEndian);
        case PF_UINT32: return view.getUint32(byteOffset, littleEndian);
        case PF_FLOAT32: return view.getFloat32(byteOffset, littleEndian);
        case PF_FLOAT64: return view.getFloat64(byteOffset, littleEndian);
        default: return NaN;
    }
}

function readPackedRgb(view: DataView, byteOffset: number, datatype: number, littleEndian: boolean): number {
    if (datatype === PF_FLOAT32) {
        return view.getUint32(byteOffset, littleEndian);
    }
    const numeric = readPointField(view, byteOffset, datatype, littleEndian);
    return (Math.max(0, Math.trunc(numeric)) >>> 0);
}

function toU8(value: number): number {
    const scaled = value <= 1 ? value * 255 : value;
    return Math.max(0, Math.min(255, Math.round(scaled)));
}

function decodeBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}
