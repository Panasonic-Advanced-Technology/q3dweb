import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadUrl } from '../src/viewer/remoteCloudLoader';
import * as streamEngine from '../src/viewer/streamEngine';

vi.mock('../src/viewer/streamEngine', () => ({
  checkMemoryBudget: vi.fn(() => true),
  detectFormat: vi.fn(() => 'pcd'),
  finalizeStream: vi.fn(),
  loadData: vi.fn(),
  processChunk: vi.fn(),
  shouldDeferInitialMemoryCheck: vi.fn(() => false),
  startStream: vi.fn(),
}));

function makeViewer() {
  return {
    constructor: { SUPPORTED_EXTENSIONS: ['.pcd', '.ply', '.las', '.laz', '.e57'] },
    loadingOverlay: document.createElement('div'),
    removeItem: vi.fn(),
    streamAborted: false,
  };
}

function makeHeaders(values: Record<string, string | undefined> = {}): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

describe('remoteCloudLoader', () => {
  beforeEach(() => {
    vi.mocked(streamEngine.checkMemoryBudget).mockReturnValue(true);
    vi.mocked(streamEngine.shouldDeferInitialMemoryCheck).mockReturnValue(false);
    vi.mocked(streamEngine.detectFormat).mockReturnValue('pcd' as any);
    vi.mocked(streamEngine.finalizeStream).mockClear();
    vi.mocked(streamEngine.loadData).mockClear();
    vi.mocked(streamEngine.processChunk).mockClear();
    vi.mocked(streamEngine.startStream).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads non-streaming responses through loadData and content-disposition filenames', async () => {
    const viewer = makeViewer();
    const data = new Uint8Array([1, 2, 3]);
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: makeHeaders({
        'content-length': String(data.byteLength),
        'content-disposition': "attachment; filename*=UTF-8''sample%20cloud.pcd",
      }),
      body: null,
      arrayBuffer: vi.fn(async () => data.buffer),
    };
    vi.stubGlobal('fetch', vi.fn(async () => response));

    await loadUrl(viewer, 'https://example.com/download?id=1');

    expect(streamEngine.checkMemoryBudget).toHaveBeenCalledWith(viewer, data.byteLength, 'pcd', 'sample cloud.pcd');
    expect(streamEngine.loadData).toHaveBeenCalledWith(viewer, data, 'sample cloud.pcd');
  });

  it('streams response chunks and finalizes when not aborted', async () => {
    const viewer = makeViewer();
    const chunks = [new Uint8Array([1]), new Uint8Array([2])];
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: chunks[0] })
        .mockResolvedValueOnce({ done: false, value: chunks[1] })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(),
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: makeHeaders({ 'content-length': '2' }),
      body: { getReader: () => reader },
    })));

    await loadUrl(viewer, 'https://example.com/clouds/sample.pcd');

    expect(viewer.removeItem).toHaveBeenCalledWith('cloud');
    expect(streamEngine.startStream).toHaveBeenCalledWith(viewer, 2, 'sample.pcd');
    expect(streamEngine.processChunk).toHaveBeenCalledTimes(2);
    expect(streamEngine.finalizeStream).toHaveBeenCalledWith(viewer);
    expect(reader.cancel).not.toHaveBeenCalled();
  });

  it('cancels stream readers when processing aborts', async () => {
    const viewer = makeViewer();
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array([1]) }),
      cancel: vi.fn(),
    };
    vi.mocked(streamEngine.processChunk).mockImplementationOnce((target: any) => { target.streamAborted = true; });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: makeHeaders({ 'content-length': '1' }),
      body: { getReader: () => reader },
    })));

    await loadUrl(viewer, 'https://example.com/clouds/sample.pcd');

    expect(reader.cancel).toHaveBeenCalled();
    expect(streamEngine.finalizeStream).not.toHaveBeenCalled();
  });

  it('shows errors for unsupported URLs, failed memory checks, HTTP errors, and fetch failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unsupportedViewer = makeViewer();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: makeHeaders(),
      body: null,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    })));
    await loadUrl(unsupportedViewer, 'https://example.com/clouds/sample.txt');
    expect(unsupportedViewer.loadingOverlay.innerHTML).toContain('Unsupported point cloud URL');

    const budgetViewer = makeViewer();
    vi.mocked(streamEngine.checkMemoryBudget).mockReturnValueOnce(false);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: makeHeaders({ 'content-length': '10' }),
      body: null,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0)),
    })));
    await loadUrl(budgetViewer, 'https://example.com/clouds/sample.pcd');
    expect(streamEngine.loadData).not.toHaveBeenCalled();

    const httpViewer = makeViewer();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', headers: makeHeaders() })));
    await loadUrl(httpViewer, 'https://example.com/clouds/sample.pcd');
    expect(httpViewer.loadingOverlay.innerHTML).toContain('HTTP 404 Not Found');

    const failureViewer = makeViewer();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await loadUrl(failureViewer, 'https://example.com/clouds/sample.pcd');
    expect(failureViewer.loadingOverlay.innerHTML).toContain('network down');
    consoleError.mockRestore();
  });
});