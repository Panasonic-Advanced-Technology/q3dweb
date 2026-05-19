import { beforeEach, describe, expect, it, vi } from 'vitest';

const memoryMock = vi.hoisted(() => ({
  heapLimit: 1000,
  heapUsed: 0,
  estimate: { level: 'ok' as 'ok' | 'warn' | 'block', message: 'ok' },
}));

vi.mock('../src/utils/memoryCheck', () => ({
  detectHeapLimit: vi.fn(() => memoryMock.heapLimit),
  detectHeapUsed: vi.fn(() => memoryMock.heapUsed),
  estimateMemoryRequirement: vi.fn(() => memoryMock.estimate),
  formatBytes: vi.fn((bytes: number) => `${bytes} B`),
}));

vi.mock('../src/parsers/sampling', () => ({
  getLargeFileSamplingThresholdBytes: vi.fn(() => 1234),
}));

import {
  abortStream,
  checkMemoryBudget,
  ensureSingleBufferInputBudget,
  ensureStreamedPointBudget,
  estimateSingleBufferInputBytes,
  estimateVisiblePointBufferBytes,
} from '../src/viewer/loadBudget';

function makeViewer() {
  return {
    skipMemoryCheck: false,
    streamAborted: false,
    leftoverChunk: new Uint8Array([1]),
    chunkList: [new Uint8Array([2])],
    fullBuffer: new Uint8Array([3]),
    fullBufferWriteOffset: 9,
    posBuffer: new Float32Array(3),
    valBuffer: new Float32Array(1),
    rgbBuffer: new Uint8Array(3),
    lasStream: {},
    pcdAsciiStream: {},
    plyStream: {},
    loadingOverlay: document.createElement('div'),
  } as any;
}

describe('loadBudget', () => {
  beforeEach(() => {
    memoryMock.heapLimit = 1000;
    memoryMock.heapUsed = 0;
    memoryMock.estimate = { level: 'ok', message: 'ok' };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('estimates point and input buffers', () => {
    expect(estimateVisiblePointBufferBytes(10, false)).toBe(10 * 16 + 32 * 1024 * 1024);
    expect(estimateVisiblePointBufferBytes(10, true)).toBe(10 * 19 + 32 * 1024 * 1024);
    expect(estimateSingleBufferInputBytes(100, 'pcd')).toBe(100 + 32 * 1024 * 1024);
    expect(estimateSingleBufferInputBytes(100, 'laz')).toBe(200 + 32 * 1024 * 1024);
  });

  it('aborts streams and reports the message in the overlay', () => {
    const viewer = makeViewer();

    abortStream(viewer, 'too large');

    expect(viewer.streamAborted).toBe(true);
    expect(viewer.leftoverChunk).toBeNull();
    expect(viewer.chunkList).toEqual([]);
    expect(viewer.posBuffer).toBeNull();
    expect(viewer.loadingOverlay.style.display).toBe('flex');
    expect(viewer.loadingOverlay.innerHTML).toContain('too large');
  });

  it('allows budget checks when disabled or comfortably under budget', () => {
    const skipped = makeViewer();
    skipped.skipMemoryCheck = true;
    expect(ensureSingleBufferInputBudget(skipped, 10_000, 'pcd')).toBe(true);
    expect(ensureStreamedPointBudget(skipped, 10_000, false, 'pcd')).toBe(true);
    expect(checkMemoryBudget(skipped, 10_000, 'pcd')).toBe(true);

    memoryMock.heapLimit = 100_000_000;
    expect(ensureSingleBufferInputBudget(makeViewer(), 1, 'pcd')).toBe(true);
    expect(ensureStreamedPointBudget(makeViewer(), 1, false, 'pcd')).toBe(true);
  });

  it('blocks single-buffer loads that exceed available heap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    memoryMock.heapLimit = 1000;
    const viewer = makeViewer();

    expect(ensureSingleBufferInputBudget(viewer, 1000, 'e57', 'huge.e57')).toBe(false);

    expect(alert).toHaveBeenCalled();
    expect(viewer.streamAborted).toBe(true);
    warn.mockRestore();
  });

  it('warns for large single-buffer loads and honors confirm', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    memoryMock.heapLimit = 60_000_000;
    const rejected = makeViewer();
    expect(ensureSingleBufferInputBudget(rejected, 10_000_000, 'pcd')).toBe(false);
    expect(rejected.streamAborted).toBe(true);

    confirm.mockReturnValue(true);
    expect(ensureSingleBufferInputBudget(makeViewer(), 10_000_000, 'pcd')).toBe(true);
    warn.mockRestore();
  });

  it('blocks and warns streamed point budgets', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('alert', vi.fn());
    memoryMock.heapLimit = 1000;
    const blocked = makeViewer();
    expect(ensureStreamedPointBudget(blocked, 1000, true, 'las')).toBe(false);
    expect(blocked.streamAborted).toBe(true);

    vi.stubGlobal('confirm', vi.fn(() => true));
    memoryMock.heapLimit = 80_000_000;
    expect(ensureStreamedPointBudget(makeViewer(), 2_000_000, false, 'las')).toBe(true);
    warn.mockRestore();
  });

  it('handles generic memory budget ok, warning, block, and no-confirm paths', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alert = vi.fn();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('alert', alert);
    vi.stubGlobal('confirm', confirm);

    memoryMock.estimate = { level: 'ok', message: 'fine' };
    expect(checkMemoryBudget(makeViewer(), 1, 'pcd')).toBe(true);
    memoryMock.estimate = { level: 'warn', message: 'maybe' };
    expect(checkMemoryBudget(makeViewer(), 1, 'pcd', 'large.pcd')).toBe(false);
    expect(confirm).toHaveBeenCalled();
    vi.stubGlobal('confirm', undefined);
    expect(checkMemoryBudget(makeViewer(), 1, 'pcd')).toBe(true);
    memoryMock.estimate = { level: 'block', message: 'nope' };
    expect(checkMemoryBudget(makeViewer(), 1, 'pcd')).toBe(false);
    expect(alert).toHaveBeenCalled();
    warn.mockRestore();
  });
});