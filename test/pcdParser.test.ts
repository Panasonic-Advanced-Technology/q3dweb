import { describe, expect, it } from 'vitest';
import {
  getAsciiFieldTokenIndex,
  getFieldSpec,
  parseAsciiNumericToken,
  parseAsciiPackedRGB,
  parsePCDAscii,
  parsePCDHeader,
  processPCDBinaryChunk,
  readNumericValue,
  readPackedRGB,
  type PCDBinaryState,
  type PCDHeader,
} from '../src/parsers/pcdParser';

const encoder = new TextEncoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function makeState(pointCapacity: number, sampleRatio = 1, rgb = false): PCDBinaryState {
  return {
    posBuffer: new Float32Array(pointCapacity * 3),
    valBuffer: new Float32Array(pointCapacity),
    rgbBuffer: rgb ? new Uint8Array(pointCapacity * 3) : null,
    posIndex: 0,
    pointsLoaded: 0,
    targetSampleRatio: sampleRatio,
    leftoverChunk: null,
  };
}

describe('pcdParser header and scalar helpers', () => {
  it('parses headers with default counts, derived point count, and default row size', () => {
    const minimal = parsePCDHeader('VERSION 0.7\nWIDTH 3\nHEIGHT 2\nDATA ascii\n');
    expect(minimal.points).toBe(6);
    expect(minimal.rowSize).toBe(16);
    expect(minimal.data).toBe('ascii');

    const full = parsePCDHeader('FIELDS x y z normal rgb\nSIZE 4 4 4 4 4\nTYPE F F F F U\nCOUNT 1 1 1 3 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n');
    expect(full.offset).toEqual({ x: 0, y: 4, z: 8, normal: 12, rgb: 24 });
    expect(full.rowSize).toBe(28);
    expect(getFieldSpec(full, 'normal')).toEqual({ offset: 12, type: 'F', size: 4, count: 3 });
    expect(getFieldSpec(full, 'missing')).toBeNull();
    expect(getFieldSpec({ offset: {} } as PCDHeader, 'x')).toBeNull();
  });

  it('reads numeric values and packed RGB values for every supported branch', () => {
    const buffer = new ArrayBuffer(64);
    const view = new DataView(buffer);
    view.setFloat32(0, 1.25, true);
    view.setFloat64(8, 2.5, true);
    view.setUint8(16, 7);
    view.setUint16(18, 700, true);
    view.setUint32(20, 70_000, true);
    view.setInt8(24, -7);
    view.setInt16(26, -700, true);
    view.setInt32(28, -70_000, true);
    view.setFloat32(36, 3.5, true);
    view.setUint16(40, 33, true);
    view.setUint8(42, 44);
    view.setUint32(48, 0x112233, true);

    expect(readNumericValue(view, 0, 'F', 4)).toBeCloseTo(1.25);
    expect(readNumericValue(view, 8, 'F', 8)).toBeCloseTo(2.5);
    expect(readNumericValue(view, 16, 'U', 1)).toBe(7);
    expect(readNumericValue(view, 18, 'U', 2)).toBe(700);
    expect(readNumericValue(view, 20, 'U', 4)).toBe(70_000);
    expect(readNumericValue(view, 24, 'I', 1)).toBe(-7);
    expect(readNumericValue(view, 26, 'I', 2)).toBe(-700);
    expect(readNumericValue(view, 28, 'I', 4)).toBe(-70_000);
    expect(readNumericValue(view, 36, 'X', 4)).toBeCloseTo(3.5);
    expect(readNumericValue(view, 40, 'X', 2)).toBe(33);
    expect(readNumericValue(view, 42, 'X', 8)).toBe(44);
    expect(readPackedRGB(view, 48, 'U', 4)).toBe(0x112233);
    expect(readPackedRGB(view, 16, 'U', 1)).toBe(7);
  });

  it('finds ASCII token indexes and parses numeric tokens safely', () => {
    const header = parsePCDHeader('FIELDS x normal y z rgba\nSIZE 4 4 4 4 4\nTYPE F F F F U\nCOUNT 1 3 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA ascii\n');
    expect(getAsciiFieldTokenIndex(header, 'x')).toBe(0);
    expect(getAsciiFieldTokenIndex(header, 'y')).toBe(4);
    expect(getAsciiFieldTokenIndex(header, 'rgba')).toBe(6);
    expect(getAsciiFieldTokenIndex(header, 'missing')).toBeNull();
    expect(getAsciiFieldTokenIndex({ offset: {} } as PCDHeader, 'x')).toBeNull();
    expect(parseAsciiNumericToken('12.5')).toBe(12.5);
    expect(parseAsciiNumericToken('NaN')).toBeNaN();
    expect(parseAsciiPackedRGB('bad', 'U', 4)).toBe(0);
    expect(parseAsciiPackedRGB('-3.5', 'U', 4)).toBe(0);
    expect(parseAsciiPackedRGB('66051', 'U', 4)).toBe(0x010203);
    const packedFloat = parseAsciiPackedRGB('1.5', 'F', 4);
    expect(packedFloat).toBeGreaterThan(0);
  });
});

describe('parsePCDAscii', () => {
  it('parses sampled ASCII PCD data with intensity and RGB while skipping malformed rows', () => {
    const text = 'FIELDS x y z intensity rgb\nSIZE 4 4 4 4 4\nTYPE F F F F U\nCOUNT 1 1 1 1 1\nWIDTH 4\nHEIGHT 1\nPOINTS 4\nDATA ascii\n' +
      '# comment\n' +
      '0 1 2 10 66051\n' +
      'bad row\n' +
      '6 7 8 30 460809\n' +
      '9 10 11 40 658188\n';
    const data = encode(text);
    const header = parsePCDHeader(text.slice(0, text.indexOf('# comment')));

    const parsed = parsePCDAscii(data, header, 10);

    expect(Array.from(parsed.positions)).toEqual([0, 1, 2, 6, 7, 8, 9, 10, 11]);
    expect(Array.from(parsed.values)).toEqual([10, 30, 40]);
    expect(Array.from(parsed.rgb!)).toEqual([1, 2, 3, 7, 8, 9, 10, 11, 12]);
  });

  it('uses z as fallback value and rejects missing xyz fields', () => {
    const okText = 'FIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA ascii\n1 2 3\n';
    const okHeader = parsePCDHeader(okText.slice(0, okText.indexOf('1 2 3')));
    const parsed = parsePCDAscii(encode(okText), okHeader, 10);
    expect(Array.from(parsed.values)).toEqual([3]);
    expect(parsed.rgb).toBeUndefined();

    const badText = 'FIELDS a b c\nSIZE 4 4 4\nTYPE F F F\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA ascii\n1 2 3\n';
    const badHeader = parsePCDHeader(badText.slice(0, badText.indexOf('1 2 3')));
    expect(() => parsePCDAscii(encode(badText), badHeader, 10)).toThrow('missing x/y/z');
  });
});

describe('processPCDBinaryChunk', () => {
  it('processes aligned standard XYZ rows with intensity and RGB', () => {
    const header = parsePCDHeader('FIELDS x y z intensity rgb\nSIZE 4 4 4 4 4\nTYPE F F F F U\nCOUNT 1 1 1 1 1\nWIDTH 2\nHEIGHT 1\nPOINTS 2\nDATA binary\n');
    const data = new Uint8Array(header.rowSize * 2 + 2);
    const view = new DataView(data.buffer);
    [[1, 2, 3, 10, 0x112233], [4, 5, 6, 20, 0x445566]].forEach((row, index) => {
      const base = index * header.rowSize;
      view.setFloat32(base, row[0], true);
      view.setFloat32(base + 4, row[1], true);
      view.setFloat32(base + 8, row[2], true);
      view.setFloat32(base + 12, row[3], true);
      view.setUint32(base + 16, row[4], true);
    });
    const state = makeState(2, 1, true);

    processPCDBinaryChunk(data, header, state);

    expect(state.posIndex).toBe(2);
    expect(Array.from(state.posBuffer)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(state.valBuffer)).toEqual([10, 20]);
    expect(Array.from(state.rgbBuffer!)).toEqual([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    expect(state.leftoverChunk).toEqual(new Uint8Array([0, 0]));
  });

  it('processes unaligned standard chunks and falls back to z when intensity is not scalar float', () => {
    const header = parsePCDHeader('FIELDS x y z intensity rgba\nSIZE 4 4 4 4 4\nTYPE F F F F U\nCOUNT 1 1 1 2 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n');
    const aligned = new Uint8Array(header.rowSize + 1);
    const view = new DataView(aligned.buffer);
    view.setFloat32(1, 7, true);
    view.setFloat32(5, 8, true);
    view.setFloat32(9, 9, true);
    view.setUint32(21, 0x010203, true);
    const unaligned = aligned.subarray(1);
    const state = makeState(1, 1, true);

    processPCDBinaryChunk(unaligned, header, state);

    expect(Array.from(state.posBuffer)).toEqual([7, 8, 9]);
    expect(Array.from(state.valBuffer)).toEqual([0]);
    expect(Array.from(state.rgbBuffer!)).toEqual([1, 2, 3]);
  });

  it('processes non-standard rows with numeric intensity and packed RGB sampling', () => {
    const header = parsePCDHeader('FIELDS pad x y z intensity rgb\nSIZE 4 4 4 4 2 1\nTYPE F F F F U U\nCOUNT 1 1 1 1 1 1\nWIDTH 3\nHEIGHT 1\nPOINTS 3\nDATA binary\n');
    const data = new Uint8Array(header.rowSize * 3);
    const view = new DataView(data.buffer);
    for (let index = 0; index < 3; index++) {
      const base = index * header.rowSize;
      view.setFloat32(base, 0, true);
      view.setFloat32(base + 4, index + 1, true);
      view.setFloat32(base + 8, index + 2, true);
      view.setFloat32(base + 12, index + 3, true);
      view.setUint16(base + 16, index + 10, true);
      view.setUint8(base + 18, index + 1);
    }
    const state = makeState(2, 2, true);

    processPCDBinaryChunk(data, header, state);

    expect(state.pointsLoaded).toBe(3);
    expect(state.posIndex).toBe(2);
    expect(Array.from(state.posBuffer)).toEqual([1, 2, 3, 3, 4, 5]);
    expect(Array.from(state.valBuffer)).toEqual([10, 12]);
    expect(Array.from(state.rgbBuffer!)).toEqual([0, 0, 1, 0, 0, 3]);
    expect(state.leftoverChunk).toBeNull();
  });
});