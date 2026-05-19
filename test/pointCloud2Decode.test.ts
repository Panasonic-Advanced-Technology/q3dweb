import { describe, expect, it } from 'vitest';
import { decodePointCloud2, inferColorModeFromFields } from '../src/utils/pointCloud2Decode';
import type { PointCloud2Json, PointFieldJson } from '../src/utils/realtimeTypes';

const PF_INT8 = 1;
const PF_UINT8 = 2;
const PF_INT16 = 3;
const PF_UINT16 = 4;
const PF_INT32 = 5;
const PF_UINT32 = 6;
const PF_FLOAT32 = 7;
const PF_FLOAT64 = 8;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function makeMessage(fields: PointFieldJson[], bytes: Uint8Array, overrides: Partial<PointCloud2Json> = {}): PointCloud2Json {
  const pointStep = overrides.point_step ?? 16;
  return {
    height: overrides.height ?? 1,
    width: overrides.width ?? Math.floor(bytes.byteLength / pointStep),
    fields,
    is_bigendian: overrides.is_bigendian ?? false,
    point_step: pointStep,
    row_step: overrides.row_step ?? bytes.byteLength,
    data: overrides.data ?? toBase64(bytes),
    is_dense: overrides.is_dense ?? true,
  };
}

function xyzFields(extra: PointFieldJson[] = []): PointFieldJson[] {
  return [
    { name: 'x', offset: 0, datatype: PF_FLOAT32, count: 1 },
    { name: 'y', offset: 4, datatype: PF_FLOAT32, count: 1 },
    { name: 'z', offset: 8, datatype: PF_FLOAT32, count: 1 },
    ...extra,
  ];
}

describe('decodePointCloud2', () => {
  it('rejects incomplete messages', () => {
    const bytes = new Uint8Array(16);
    const fields = xyzFields();

    expect(decodePointCloud2(null as any, 10, 'FLAT')).toBeNull();
    expect(decodePointCloud2(makeMessage([], bytes), 10, 'FLAT')).toBeNull();
    expect(decodePointCloud2(makeMessage(fields, bytes, { data: '' }), 10, 'FLAT')).toBeNull();
    expect(decodePointCloud2(makeMessage(fields, bytes, { width: 0 }), 10, 'FLAT')).toBeNull();
    expect(decodePointCloud2(makeMessage(fields, bytes, { point_step: 0 }), 10, 'FLAT')).toBeNull();
    expect(decodePointCloud2(makeMessage(fields.slice(0, 2), bytes), 10, 'FLAT')).toBeNull();
    expect(decodePointCloud2(makeMessage(fields, new Uint8Array(3)), 10, 'FLAT')).toBeNull();
  });

  it('decodes finite sampled float positions and intensity', () => {
    const bytes = new Uint8Array(16 * 3);
    const view = new DataView(bytes.buffer);
    const rows = [
      [1, 2, 3, 10],
      [Number.NaN, 4, 5, 20],
      [7, 8, 9, 30],
    ];
    rows.forEach((row, index) => {
      const base = index * 16;
      row.forEach((value, offset) => view.setFloat32(base + offset * 4, value, true));
    });

    const decoded = decodePointCloud2(
      makeMessage(xyzFields([{ name: 'intensity', offset: 12, datatype: PF_FLOAT32, count: 1 }]), bytes),
      2,
      'I',
    );

    expect(Array.from(decoded!.positions)).toEqual([1, 2, 3, 7, 8, 9]);
    expect(Array.from(decoded!.values)).toEqual([10, 30]);
  });

  it('trims skipped non-finite points', () => {
    const bytes = new Uint8Array(16 * 2);
    const view = new DataView(bytes.buffer);
    view.setFloat32(0, Number.NaN, true);
    view.setFloat32(4, 1, true);
    view.setFloat32(8, 2, true);
    view.setFloat32(16, 3, true);
    view.setFloat32(20, 4, true);
    view.setFloat32(24, 5, true);

    const decoded = decodePointCloud2(makeMessage(xyzFields(), bytes), 10, 'FLAT');

    expect(Array.from(decoded!.positions)).toEqual([3, 4, 5]);
    expect(Array.from(decoded!.values)).toEqual([5]);
  });

  it('decodes packed RGB fields', () => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setFloat32(0, 1, true);
    view.setFloat32(4, 2, true);
    view.setFloat32(8, 3, true);
    view.setUint32(12, 0x112233, true);

    const decoded = decodePointCloud2(
      makeMessage(xyzFields([{ name: 'rgb', offset: 12, datatype: PF_UINT32, count: 1 }]), bytes),
      10,
      'RGB',
    );

    expect(Array.from(decoded!.rgb!)).toEqual([0x11, 0x22, 0x33]);
    expect(Array.from(decoded!.values)).toEqual([3]);
  });

  it('decodes float-packed RGB fields by raw bits', () => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setFloat32(0, 1, true);
    view.setFloat32(4, 2, true);
    view.setFloat32(8, 3, true);
    view.setUint32(12, 0x445566, true);

    const decoded = decodePointCloud2(
      makeMessage(xyzFields([{ name: 'rgba', offset: 12, datatype: PF_FLOAT32, count: 1 }]), bytes),
      10,
      'RGB',
    );

    expect(Array.from(decoded!.rgb!)).toEqual([0x44, 0x55, 0x66]);
  });

  it('decodes separate RGB fields and clamps normalized colors', () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setFloat32(0, 1, true);
    view.setFloat32(4, 2, true);
    view.setFloat32(8, 3, true);
    view.setFloat32(12, 0.5, true);
    view.setFloat32(16, 2, true);
    view.setFloat32(20, 300, true);

    const decoded = decodePointCloud2(
      makeMessage(xyzFields([
        { name: 'red', offset: 12, datatype: PF_FLOAT32, count: 1 },
        { name: 'green', offset: 16, datatype: PF_FLOAT32, count: 1 },
        { name: 'blue', offset: 20, datatype: PF_FLOAT32, count: 1 },
      ]), bytes, { point_step: 24 }),
      10,
      'RGB',
    );

    expect(Array.from(decoded!.rgb!)).toEqual([128, 2, 255]);
  });

  it('decodes signed and unsigned integer fields on big-endian messages', () => {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setInt8(0, -2);
    view.setUint8(1, 250);
    view.setInt16(2, -1234, false);
    view.setUint16(4, 65535, false);

    const decoded = decodePointCloud2(
      makeMessage([
        { name: 'x', offset: 0, datatype: PF_INT8, count: 1 },
        { name: 'y', offset: 1, datatype: PF_UINT8, count: 1 },
        { name: 'z', offset: 2, datatype: PF_INT16, count: 1 },
        { name: 'intensity', offset: 4, datatype: PF_UINT16, count: 1 },
      ], bytes, { point_step: 8, is_bigendian: true }),
      10,
      'I',
    );

    expect(Array.from(decoded!.positions)).toEqual([-2, 250, -1234]);
    expect(Array.from(decoded!.values)).toEqual([65535]);
  });

  it('decodes 32-bit integers and float64 fields', () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, -1000, false);
    view.setUint32(4, 1000, false);
    view.setFloat64(8, 12.5, false);
    view.setFloat64(16, 42.25, false);

    const decoded = decodePointCloud2(
      makeMessage([
        { name: 'x', offset: 0, datatype: PF_INT32, count: 1 },
        { name: 'y', offset: 4, datatype: PF_UINT32, count: 1 },
        { name: 'z', offset: 8, datatype: PF_FLOAT64, count: 1 },
        { name: 'intensity', offset: 16, datatype: PF_FLOAT64, count: 1 },
      ], bytes, { point_step: 24, is_bigendian: true }),
      10,
      'I',
    );

    expect(Array.from(decoded!.positions)).toEqual([-1000, 1000, 12.5]);
    expect(Array.from(decoded!.values)).toEqual([42.25]);
  });

  it('skips points with unsupported field datatypes', () => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setFloat32(4, 1, true);
    view.setFloat32(8, 2, true);

    const decoded = decodePointCloud2(
      makeMessage([
        { name: 'x', offset: 0, datatype: 99, count: 1 },
        { name: 'y', offset: 4, datatype: PF_FLOAT32, count: 1 },
        { name: 'z', offset: 8, datatype: PF_FLOAT32, count: 1 },
      ], bytes),
      10,
      'FLAT',
    );

    expect(decoded!.positions).toHaveLength(0);
    expect(decoded!.values).toHaveLength(0);
  });
});

describe('inferColorModeFromFields', () => {
  it('infers FLAT, intensity, packed RGB, and separate RGB modes', () => {
    expect(inferColorModeFromFields(undefined)).toBe('FLAT');
    expect(inferColorModeFromFields([])).toBe('FLAT');
    expect(inferColorModeFromFields([{ name: 'intensity', offset: 0, datatype: PF_FLOAT32, count: 1 }])).toBe('I');
    expect(inferColorModeFromFields([{ name: 'rgba', offset: 0, datatype: PF_UINT32, count: 1 }])).toBe('RGB');
    expect(inferColorModeFromFields([
      { name: 'r', offset: 0, datatype: PF_UINT8, count: 1 },
      { name: 'g', offset: 1, datatype: PF_UINT8, count: 1 },
      { name: 'b', offset: 2, datatype: PF_UINT8, count: 1 },
    ])).toBe('RGB');
  });
});