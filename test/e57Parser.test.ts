import { describe, expect, it, vi } from 'vitest';
import { parseE57 } from '../src/parsers/e57Parser';

const e57MockState = vi.hoisted(() => ({
  init: vi.fn(),
  chunked: undefined as undefined | ReturnType<typeof vi.fn>,
  sampled: undefined as undefined | ReturnType<typeof vi.fn>,
  plain: undefined as undefined | ReturnType<typeof vi.fn>,
}));

vi.mock('../vendor/e57-wasm/pkg/e57_wasm_bg.wasm?url', () => ({ default: 'mock-e57.wasm' }));

vi.mock('../vendor/e57-wasm/pkg/e57_wasm.js', () => ({
  default: e57MockState.init,
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
});