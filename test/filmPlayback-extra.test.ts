import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  advanceFilmPlaybackFrame,
  downloadLastRecording,
  startPlayback,
  startRecording,
  stopPlayback,
  stopRecording,
  tickFilmPlayback,
  type FilmPlaybackContext,
} from '../src/viewer/filmPlayback';

function makeContext(overrides: Partial<FilmPlaybackContext> = {}): FilmPlaybackContext {
  const canvas = document.createElement('canvas');
  return {
    filmMaker: {
      keyFrames: [{}, {}],
      frames: [{ keyIndex: 0, Twc: new THREE.Matrix4() }],
      currentIndex: 0,
      updateIntervalMs: 20,
      createFrames: vi.fn(),
    },
    cameraDist: 10,
    cameraCenter: new THREE.Vector3(),
    euler: [0, 0, 0],
    filmPlaybackIndex: 0,
    filmPlaybackRequestId: null,
    filmPlaybackLastTimestamp: null,
    filmPlaybackAccumulatorMs: 0,
    isPlayingFilm: false,
    isRecordingFilm: false,
    mediaRecorder: null,
    recordedChunks: [],
    lastRecordedBlob: null,
    videoFileName: 'demo.webm',
    videoMimeType: 'video/webm',
    recordingVideoBitsPerSecond: 1000,
    recordingPixelRatioMin: 2,
    rendererPixelRatio: 1,
    filmMakerPlayBtn: null,
    updateCamera: vi.fn(),
    requestRender: vi.fn(),
    setFilmMakerPlayButtonState: vi.fn(),
    getBaseRendererPixelRatio: vi.fn(() => 1),
    applyRendererResolution: vi.fn(),
    restoreRendererResolution: vi.fn(),
    renderer: { domElement: canvas },
    ...overrides,
  };
}

class FakeMediaRecorder {
  static supported = true;
  static isTypeSupported = vi.fn(() => FakeMediaRecorder.supported);
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  state = 'recording';
  mimeType: string;
  start = vi.fn();
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.onstop?.();
  });

  constructor(_stream: MediaStream, options: MediaRecorderOptions) {
    this.mimeType = options.mimeType || 'video/webm';
  }
}

describe('filmPlayback helpers', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeMediaRecorder.supported = true;
    FakeMediaRecorder.isTypeSupported = vi.fn(() => FakeMediaRecorder.supported);
  });

  it('advances frames and stops when playback reaches the end', () => {
    const ctx = makeContext();

    expect(advanceFilmPlaybackFrame(ctx)).toBe(true);
    expect(ctx.filmPlaybackIndex).toBe(1);
    expect(ctx.filmMaker.currentIndex).toBe(0);
    expect(ctx.updateCamera).toHaveBeenCalled();
    expect(ctx.requestRender).toHaveBeenCalled();

    ctx.isPlayingFilm = true;
    expect(advanceFilmPlaybackFrame(ctx)).toBe(false);
    expect(ctx.isPlayingFilm).toBe(false);
    expect(ctx.restoreRendererResolution).toHaveBeenCalled();
  });

  it('ticks immediately without timestamps and schedules timestamp-based playback', () => {
    const raf = vi.fn(() => 77);
    vi.stubGlobal('requestAnimationFrame', raf);
    const ctx = makeContext({ isPlayingFilm: true });

    tickFilmPlayback(ctx);
    expect(ctx.filmPlaybackIndex).toBe(1);

    ctx.filmMaker.frames = [
      { keyIndex: 0, Twc: new THREE.Matrix4() },
      { keyIndex: 1, Twc: new THREE.Matrix4().makeTranslation(1, 0, 0) },
    ];
    ctx.filmPlaybackIndex = 0;
    ctx.filmPlaybackLastTimestamp = null;
    ctx.filmPlaybackAccumulatorMs = 0;
    ctx.isPlayingFilm = true;
    tickFilmPlayback(ctx, 100);
    expect(ctx.filmPlaybackLastTimestamp).toBe(100);
    expect(ctx.filmPlaybackRequestId).toBe(77);
    tickFilmPlayback(ctx, 145);
    expect(ctx.filmPlaybackIndex).toBeGreaterThan(0);

    ctx.isPlayingFilm = false;
    tickFilmPlayback(ctx, 200);
  });

  it('starts playback only with enough generated frames and records when requested', () => {
    const raf = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', raf);
    const tooFew = makeContext({ filmMaker: { keyFrames: [{}], frames: [], createFrames: vi.fn(), updateIntervalMs: 20, currentIndex: 0 } as any });
    expect(startPlayback(tooFew)).toBe(false);

    const noFrames = makeContext({ filmMaker: { keyFrames: [{}, {}], frames: [], createFrames: vi.fn(), updateIntervalMs: 20, currentIndex: 0 } as any });
    expect(startPlayback(noFrames)).toBe(false);

    const ctx = makeContext({ isRecordingFilm: true });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as any);
    (ctx.renderer.domElement as any).captureStream = vi.fn(() => ({} as MediaStream));
    expect(startPlayback(ctx)).toBe(true);
    expect(ctx.isPlayingFilm).toBe(true);
    expect(ctx.mediaRecorder).toBeInstanceOf(FakeMediaRecorder);
  });

  it('handles recording unsupported, empty stream, and thrown constructor paths', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unsupported = makeContext({ isRecordingFilm: true });
    startRecording(unsupported);
    expect(unsupported.isRecordingFilm).toBe(false);

    const noStream = makeContext({ isRecordingFilm: true });
    (noStream.renderer.domElement as any).captureStream = vi.fn(() => null);
    startRecording(noStream);
    expect(noStream.restoreRendererResolution).toHaveBeenCalled();

    class ThrowingRecorder {
      static isTypeSupported = vi.fn(() => true);
      constructor() { throw new Error('no recorder'); }
    }
    vi.stubGlobal('MediaRecorder', ThrowingRecorder as any);
    const thrown = makeContext({ isRecordingFilm: true });
    (thrown.renderer.domElement as any).captureStream = vi.fn(() => ({} as MediaStream));
    startRecording(thrown);
    expect(thrown.isRecordingFilm).toBe(false);
    expect(thrown.restoreRendererResolution).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('records chunks, stops safely, and restores renderer resolution', () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as any);
    const ctx = makeContext({ rendererPixelRatio: 1, recordingPixelRatioMin: 3 });
    (ctx.renderer.domElement as any).captureStream = vi.fn(() => ({} as MediaStream));

    startRecording(ctx);
    const recorder = ctx.mediaRecorder as unknown as FakeMediaRecorder;
    recorder.ondataavailable?.({ data: new Blob(['abc']) } as BlobEvent);
    recorder.ondataavailable?.({ data: new Blob([]) } as BlobEvent);
    stopRecording(ctx);

    expect(ctx.applyRendererResolution).toHaveBeenCalledWith(3);
    expect(ctx.recordedChunks).toHaveLength(1);
    expect(ctx.lastRecordedBlob?.size).toBe(3);
    expect(ctx.restoreRendererResolution).toHaveBeenCalled();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctx.mediaRecorder = { stop: vi.fn(() => { throw new Error('stop failed'); }) } as any;
    stopRecording(ctx);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stops playback by cancelling animation and stopping an active recorder', () => {
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const ctx = makeContext({
      filmPlaybackRequestId: 12,
      isPlayingFilm: true,
      mediaRecorder: { state: 'recording', stop: vi.fn() } as any,
    });

    stopPlayback(ctx);

    expect(cancel).toHaveBeenCalledWith(12);
    expect(ctx.mediaRecorder?.stop).toHaveBeenCalled();
    expect(ctx.isPlayingFilm).toBe(false);
  });

  it('downloads recorded blobs through browser and VS Code paths', async () => {
    expect(downloadLastRecording(makeContext())).toBe(false);

    vi.useFakeTimers();
    const url = 'blob:test';
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => url),
      revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const browserCtx = makeContext({ lastRecordedBlob: new Blob(['data'], { type: 'video/webm' }) });
    expect(downloadLastRecording(browserCtx)).toBe(true);
    expect(click).toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
    click.mockRestore();
    vi.useRealTimers();

    const vscode = { postMessage: vi.fn() };
    const vscodeCtx = makeContext({ lastRecordedBlob: new Blob(['data'], { type: 'video/webm' }) });
    expect(downloadLastRecording(vscodeCtx, vscode)).toBe(true);
    await Promise.resolve();
    expect(vscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'saveVideo', filename: 'demo.webm' }));
  });
});