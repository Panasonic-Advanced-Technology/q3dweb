import { describe, expect, it, vi } from 'vitest';
import { parseE57 } from '../src/parsers/e57Parser';

const e57MockState = vi.hoisted(() => ({
  init: vi.fn(),
  streamParser: undefined as undefined | {
    fromChunks: ReturnType<typeof vi.fn>;
    fromUint8Array: ReturnType<typeof vi.fn>;
  },
  chunked: undefined as undefined | ReturnType<typeof vi.fn>,
  sampled: undefined as undefined | ReturnType<typeof vi.fn>,
  plain: undefined as undefined | ReturnType<typeof vi.fn>,
}));

vi.mock('../vendor/e57-wasm/pkg/e57_wasm_bg.wasm?url', () => ({ default: 'mock-e57.wasm' }));

vi.mock('../vendor/e57-wasm/pkg/e57_wasm.js', () => ({
  default: e57MockState.init,
  get E57StreamParser() { return e57MockState.streamParser; },
  get parsePointChunksSampled() { return e57MockState.chunked; },
  get parsePointsSampled() { return e57MockState.sampled; },
  get parsePoints() { return e57MockState.plain; },
}));

function makeParsedPoints(hasColor = false) {
  return {
    positions: new Float32Array([1, 2, 3, 4, 5, 6]),
    intensities: new Float32Array([0, 1000]),
    colors: hasColor ? new Uint8Array([10, 20, 30, 40, 50, 60]) : undefined,
    hasColor,
    pointCount: 2,
    free: vi.fn(),
  };
}

describe('parseE57', () => {
  it('uses chunked sampled parsing when available', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const parsedPoints = makeParsedPoints(true);
    e57MockState.init = vi.fn();
    e57MockState.chunked = vi.fn(() => parsedPoints);
    e57MockState.sampled = vi.fn();
    e57MockState.plain = vi.fn();

    const parsed = await parseE57([new Uint8Array([1, 2]), new Uint8Array([3])], 100, 3);

    expect(e57MockState.init).toHaveBeenCalledWith({ module_or_path: 'mock-e57.wasm' });
    expect(e57MockState.chunked).toHaveBeenCalledWith(expect.any(Array), 100, 3, expect.any(Number));
    expect(Array.from(parsed.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(parsed.values)).toEqual([0, 255]);
    expect(Array.from(parsed.rgb!)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(parsedPoints.free).toHaveBeenCalled();
    log.mockRestore();
  });

  it('merges chunks and uses sampled parsing when chunked parsing is unavailable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    e57MockState.init = vi.fn();
    e57MockState.chunked = undefined;
    e57MockState.sampled = vi.fn(() => makeParsedPoints(false));
    e57MockState.plain = vi.fn();

    const parsed = await parseE57([new Uint8Array([1, 2]), new Uint8Array([3, 4])], 50, 4);

    expect(e57MockState.sampled).toHaveBeenCalledWith(new Uint8Array([1, 2, 3, 4]), 50, 4, expect.any(Number));
    expect(parsed.rgb).toBeUndefined();
    log.mockRestore();
  });

  it('falls back to plain parsing for unchunked input when sampled parsing is unavailable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const data = new Uint8Array([9, 8, 7]);
    e57MockState.init = vi.fn();
    e57MockState.chunked = undefined;
    e57MockState.sampled = undefined;
    e57MockState.plain = vi.fn(() => makeParsedPoints(false));

    await parseE57(data, 10);

    expect(e57MockState.plain).toHaveBeenCalledWith(data);
    log.mockRestore();
  });

  it('uses incremental E57StreamParser and reports progress across time slices', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const parsedPoints = makeParsedPoints(true);
    let stepCalls = 0;
    const mockParser = {
      totalRecords: 100_000,
      get processedRecords() { return stepCalls * 50_000; },
      step: vi.fn(() => {
        stepCalls++;
        return stepCalls >= 2;
      }),
      takePoints: vi.fn(() => parsedPoints),
      free: vi.fn(),
    };
    e57MockState.init = vi.fn();
    e57MockState.streamParser = {
      fromChunks: vi.fn(() => mockParser),
      fromUint8Array: vi.fn(() => mockParser),
    };

    let fakeNow = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
      fakeNow += 20;
      return fakeNow;
    });

    const progress: number[] = [];
    const parsed = await parseE57([new Uint8Array([1, 2]), new Uint8Array([3])], 100, 3, (f) => progress.push(f));

    expect(e57MockState.streamParser.fromChunks).toHaveBeenCalledWith(expect.any(Array), 100, 3, expect.any(Number));
    expect(mockParser.step).toHaveBeenCalledTimes(2);
    expect(mockParser.takePoints).toHaveBeenCalledTimes(1);
    expect(mockParser.free).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([0.5, 1]);
    expect(Array.from(parsed.positions)).toEqual([1, 2, 3, 4, 5, 6]);

    // Single Uint8Array input uses fromUint8Array
    stepCalls = 0;
    await parseE57(new Uint8Array([9, 8]), 50, 2);
    expect(e57MockState.streamParser.fromUint8Array).toHaveBeenCalledWith(expect.any(Uint8Array), 50, 2, expect.any(Number));

    nowSpy.mockRestore();
    e57MockState.streamParser = undefined;
    log.mockRestore();
  });
});