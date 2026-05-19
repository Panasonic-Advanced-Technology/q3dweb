import { beforeEach, describe, expect, it, vi } from 'vitest';

const parserMocks = vi.hoisted(() => ({
  parseE57: vi.fn(),
  parseLAZ: vi.fn(),
}));

vi.mock('../src/parsers/e57Parser', () => ({
  parseE57: parserMocks.parseE57,
}));

vi.mock('../src/parsers/lasParser', async () => {
  const actual = await vi.importActual<any>('../src/parsers/lasParser');
  return {
    ...actual,
    parseLAZ: parserMocks.parseLAZ,
  };
});

let streamEngine: typeof import('../src/viewer/streamEngine');
let viewerMode: typeof import('../src/viewerMode');

function makeViewer() {
  return {
    constructor: { SUPPORTED_EXTENSIONS: ['.pcd', '.ply', '.las', '.laz', '.e57'] },
    MAX_POINTS_VISUAL: 100,
    skipMemoryCheck: true,
    loadingOverlay: document.createElement('div'),
    statusElement: document.createElement('div'),
    chunkList: [] as Uint8Array[],
    fullBuffer: null as Uint8Array | null,
    fullBufferWriteOffset: 0,
    streamTotalSize: 0,
    streamLoadedSize: 0,
    streamAborted: false,
    currentFormat: 'pcd',
    removeItem: vi.fn(),
    addItem: vi.fn(),
    requestRender: vi.fn(),
    renderPoints: vi.fn(),
  } as any;
}

describe('streamEngine extra paths', () => {
  beforeEach(async () => {
    vi.resetModules();
    parserMocks.parseE57.mockReset();
    parserMocks.parseLAZ.mockReset();
    vi.unstubAllGlobals();
    streamEngine = await import('../src/viewer/streamEngine');
    viewerMode = await import('../src/viewerMode');
  });

  it('detects stream formats and single-buffer/deferred policies', () => {
    expect(streamEngine.detectFormat()).toBe('pcd');
    expect(streamEngine.detectFormat('a.PCD')).toBe('pcd');
    expect(streamEngine.detectFormat('a.ply')).toBe('ply');
    expect(streamEngine.detectFormat('a.las')).toBe('las');
    expect(streamEngine.detectFormat('a.laz')).toBe('laz');
    expect(streamEngine.detectFormat('a.e57')).toBe('e57');
    expect(streamEngine.detectFormat('a.txt')).toBe('unknown');
    expect(streamEngine.shouldDeferInitialMemoryCheck('e57')).toBe(true);
    expect(streamEngine.shouldDeferInitialMemoryCheck('unknown')).toBe(false);
    expect(streamEngine.shouldUseSingleBufferParser('laz')).toBe(true);
    expect(streamEngine.shouldUseSingleBufferParser('e57')).toBe(false);
  });

  it('updates viewer state on startStream and assembles chunk lists', () => {
    const viewer = makeViewer();
    streamEngine.startStream(viewer, 12, 'sample.e57');

    expect(viewer.currentFormat).toBe('e57');
    expect(viewer.streamTotalSize).toBe(12);
    expect(viewer.loadingOverlay.innerHTML).toContain('Preparing stream');
    expect(streamEngine.assembleChunkList({ chunkList: [] })).toHaveLength(0);
    expect(streamEngine.assembleChunkList({ chunkList: [new Uint8Array([1, 2])] })).toEqual(new Uint8Array([1, 2]));
    expect(streamEngine.assembleChunkList({ chunkList: [new Uint8Array([1]), new Uint8Array([2, 3])] })).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('collects non-PCD chunks without reparsing them', () => {
    const viewer = makeViewer();
    streamEngine.startStream(viewer, 4, 'sample.e57');
    const chunk = new Uint8Array([1, 2]);

    streamEngine.processChunk(viewer, chunk, 0);

    expect(viewer.chunkList[0]).toBe(chunk);
    expect(viewer.fullBufferWriteOffset).toBe(2);
    expect(viewer.loadingOverlay.innerHTML).toContain('50.0%');
  });

  it('keeps loading progress at or below 100% when streamed bytes exceed content length', () => {
    const viewer = makeViewer();
    streamEngine.startStream(viewer, 1, 'sample.e57');

    streamEngine.processChunk(viewer, new Uint8Array([1, 2, 3]), 0);

    expect(viewer.streamTotalSize).toBe(3);
    expect(viewer.loadingOverlay.innerHTML).toContain('100.0%');
    expect(viewer.loadingOverlay.innerHTML).not.toContain('300.0%');
  });

  it('finalizes chunked E57 streams asynchronously', async () => {
    const viewer = makeViewer();
    streamEngine.startStream(viewer, 2, 'sample.e57');
    viewer.chunkList = [new Uint8Array([1, 2])];
    parserMocks.parseE57.mockResolvedValue({
      positions: new Float32Array([1, 2, 3]),
      values: new Float32Array([9]),
      rgb: new Uint8Array([1, 2, 3]),
    });

    await streamEngine.finalizeStream(viewer);

    expect(parserMocks.parseE57).toHaveBeenCalledWith(expect.any(Array), 100, 2);
    expect(viewer.renderPoints).toHaveBeenCalledWith(expect.any(Float32Array), expect.any(Float32Array), expect.any(Uint8Array));
    expect(viewer.pointsLoaded).toBe(1);
  });

  it('reports finalize errors for empty E57 streams', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const viewer = makeViewer();
    streamEngine.startStream(viewer, 0, 'empty.e57');

    await streamEngine.finalizeStream(viewer);

    expect(viewer.loadingOverlay.innerHTML).toContain('Empty E57 stream');
    error.mockRestore();
  });

  it('loads single-buffer LAZ files through loadFile', async () => {
    const viewer = makeViewer();
    const data = new Uint8Array([0x4c, 0x41, 0x53, 0x46]);
    parserMocks.parseLAZ.mockResolvedValue({
      positions: new Float32Array([1, 2, 3]),
      values: new Float32Array([5]),
      rgb: undefined,
      originLatLon: null,
      bounds: null,
    });

    await streamEngine.loadFile(viewer, new File([data], 'sample.laz'));

    expect(viewer.removeItem).toHaveBeenCalledWith('cloud');
    expect(parserMocks.parseLAZ).toHaveBeenCalledWith(expect.any(Uint8Array), 100, data.byteLength);
    expect(viewer.renderPoints).toHaveBeenCalledWith(expect.any(Float32Array), expect.any(Float32Array), undefined);
    expect(viewer.chunkList).toEqual([]);
  });

  it('ignores unsupported files and catches loadFile reader errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const viewer = makeViewer();
    await streamEngine.loadFile(viewer, new File(['x'], 'sample.txt'));
    expect(warn).toHaveBeenCalledWith('Unsupported file type: sample.txt');

    const failingFile = new File(['x'], 'sample.pcd');
    (failingFile as any).stream = () => ({ getReader: () => ({ read: async () => { throw new Error('reader failed'); } }) });
    await streamEngine.loadFile(viewer, failingFile);
    expect(error).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('navigates by replacing the mode URL parameter', () => {
    const assign = vi.fn();
    const originalLocation = window.location;
    vi.stubGlobal('location', {
      href: 'https://example.test/viewer?mode=cloud&x=1',
      assign,
    } as any);

    viewerMode.navigateToViewerMode('realtime');

    expect(assign).toHaveBeenCalledWith('https://example.test/viewer?mode=realtime&x=1');
    vi.stubGlobal('location', originalLocation);
  });
});