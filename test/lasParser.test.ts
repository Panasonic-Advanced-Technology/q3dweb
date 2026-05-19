import { describe, expect, it, vi } from 'vitest';
import {
  normalizeIntensity,
  parseLAS,
  parseLASMetadata,
  parseLAZ,
  processLASRecords,
  type LASStreamState,
} from '../src/parsers/lasParser';

const lazMockState = vi.hoisted(() => ({ freeCalls: [] as number[] }));

vi.mock('laz-perf/lib/web/laz-perf.wasm?url', () => ({ default: 'mock-laz-perf.wasm' }));

vi.mock('laz-perf/lib/web', () => ({
  createLazPerf: vi.fn(async () => {
    let nextPtr = 0;
    const heap = new Uint8Array(4096);
    const lazPerf = {
      HEAPU8: heap,
      _malloc(size: number) {
        const ptr = nextPtr;
        nextPtr += size;
        return ptr;
      },
      _free(ptr: number) {
        lazMockState.freeCalls.push(ptr);
      },
      LASZip: class {
        private pointIndex = 0;
        open() {}
        getCount() { return 2; }
        getPointLength() { return 26; }
        getPointFormat() { return 2; }
        getPoint(pointPtr: number) {
          const view = new DataView(lazPerf.HEAPU8.buffer);
          const raw = this.pointIndex + 1;
          view.setInt32(pointPtr, raw * 100, true);
          view.setInt32(pointPtr + 4, raw * 200, true);
          view.setInt32(pointPtr + 8, raw * 300, true);
          view.setUint16(pointPtr + 12, raw * 10, true);
          view.setUint16(pointPtr + 20, raw * 256, true);
          view.setUint16(pointPtr + 22, raw * 512, true);
          view.setUint16(pointPtr + 24, raw * 768, true);
          this.pointIndex++;
        }
        delete() {}
      },
    };
    return lazPerf;
  }),
}));

function makeLAS(version: [number, number] = [1, 2], format = 0, pointCount = 2): Uint8Array {
  const headerSize = version[1] >= 4 ? 375 : 227;
  const recordLengths: Record<number, number> = { 0: 20, 2: 26, 3: 34, 5: 63, 7: 36, 8: 38, 10: 67 };
  const recordLength = recordLengths[format] ?? 20;
  const data = new Uint8Array(headerSize + pointCount * recordLength);
  const view = new DataView(data.buffer);
  data[0] = 0x4C;
  data[1] = 0x41;
  data[2] = 0x53;
  data[3] = 0x46;
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  view.setUint8(24, version[0]);
  view.setUint8(25, version[1]);
  view.setUint8(104, format);
  view.setUint16(105, recordLength, true);
  view.setUint32(107, pointCount, true);
  if (version[1] >= 4) view.setUint32(247, pointCount, true);
  view.setFloat64(131, 0.01, true);
  view.setFloat64(139, 0.02, true);
  view.setFloat64(147, 0.03, true);
  view.setFloat64(155, 1, true);
  view.setFloat64(163, 2, true);
  view.setFloat64(171, 3, true);
  view.setFloat64(179, 10, true);
  view.setFloat64(187, 1, true);
  view.setFloat64(195, 20, true);
  view.setFloat64(203, 2, true);
  view.setFloat64(211, 30, true);
  view.setFloat64(219, 3, true);

  for (let index = 0; index < pointCount; index++) {
    const base = headerSize + index * recordLength;
    view.setInt32(base, (index + 1) * 100, true);
    view.setInt32(base + 4, (index + 1) * 200, true);
    view.setInt32(base + 8, (index + 1) * 300, true);
    view.setUint16(base + 12, (index + 1) * 100, true);
    const rgbOffset = format === 2 ? 20 : format === 3 || format === 5 ? 28 : format === 7 || format === 8 || format === 10 ? 30 : -1;
    if (rgbOffset >= 0) {
      view.setUint16(base + rgbOffset, 65535, true);
      view.setUint16(base + rgbOffset + 2, 32768, true);
      view.setUint16(base + rgbOffset + 4, 256, true);
    }
  }
  return data;
}

describe('lasParser', () => {
  it('normalizes intensity to non-negative 8-bit values only when needed', () => {
    const small = new Float32Array([-1.2, 100.9, 255]);
    normalizeIntensity(small);
    expect(Array.from(small)).toEqual([0, 100, 255]);

    const large = new Float32Array([0, 500, 1000]);
    normalizeIntensity(large);
    expect(Array.from(large)).toEqual([0, 127, 255]);
  });

  it('parses LAS metadata for point formats and LAS 1.4 counts', () => {
    const formatOffsets = new Map([[2, 20], [3, 28], [5, 28], [7, 30], [8, 30], [10, 30]]);
    for (const [format, rgbOffset] of formatOffsets) {
      const metadata = parseLASMetadata(makeLAS([1, format >= 7 ? 4 : 2], format, 3));
      expect(metadata.hasRGB).toBe(true);
      expect(metadata.rgbOffset).toBe(rgbOffset);
      expect(metadata.numberOfPoints).toBe(3);
      expect(metadata.bounds).toEqual({ minX: 1, maxX: 10, minY: 2, maxY: 20, minZ: 3, maxZ: 30 });
    }

    expect(() => parseLASMetadata(new Uint8Array(227))).toThrow('Not a valid LAS file');
  });

  it('parses sampled LAS records with scaled coordinates and RGB colors', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const parsed = parseLAS(makeLAS([1, 2], 2, 4), 2);

    expect(Array.from(parsed.positions)).toEqual([2, 6, 12, 4, 14, 30]);
    expect(Array.from(parsed.values)).toEqual([85, 255]);
    expect(Array.from(parsed.rgb!)).toEqual([255, 128, 1, 255, 128, 1]);
    expect(parsed.bounds?.maxZ).toBe(30);
    log.mockRestore();
  });

  it('processes streaming LAS records with sampling, RGB scaling, and leftovers', () => {
    const data = makeLAS([1, 2], 2, 3).subarray(227);
    const meta: LASStreamState = {
      ...parseLASMetadata(makeLAS([1, 2], 2, 3)),
      rawPointIndex: 0,
    };
    const positions = new Float32Array(6);
    const values = new Float32Array(2);
    const colors = new Uint8Array(6);
    const indexRef = { value: 0 };
    const leftoverRef = { value: null as Uint8Array | null };

    processLASRecords(data.subarray(0, 5), meta, positions, values, colors, indexRef, 1, leftoverRef);
    expect(leftoverRef.value).toHaveLength(5);

    processLASRecords(data.subarray(0, data.byteLength - 3), meta, positions, values, colors, indexRef, 1, leftoverRef);

    expect(indexRef.value).toBe(2);
    expect(Array.from(positions)).toEqual([2, 6, 12, 3, 10, 21]);
    expect(Array.from(values)).toEqual([100, 200]);
    expect(Array.from(colors)).toEqual([255, 128, 1, 255, 128, 1]);
    expect(leftoverRef.value).toHaveLength(23);
  });

  it('parses LAZ through the laz-perf adapter while storing only sampled records', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    lazMockState.freeCalls = [];
    const lazData = makeLAS([1, 2], 2, 0);
    lazData[104] = 0x82;

    const parsed = await parseLAZ(lazData, 10);

    expect(Array.from(parsed.positions)).toEqual([2, 6, 12, 3, 10, 21]);
    expect(Array.from(parsed.values)).toEqual([10, 20]);
    expect(Array.from(parsed.rgb!)).toEqual([1, 2, 3, 2, 4, 6]);
    expect(lazMockState.freeCalls.length).toBeGreaterThanOrEqual(2);
    log.mockRestore();
  });

  it('rejects invalid LAZ magic before loading the wasm adapter', async () => {
    await expect(parseLAZ(new Uint8Array(227), 10)).rejects.toThrow('Not a valid LAZ/LAS file');
  });
});