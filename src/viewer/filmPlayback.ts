/**
 * Film maker playback and recording helpers.
 * Extracted from viewer.ts for modularity.
 */

import * as THREE from 'three';
import { recoverCenterEuler } from '../utils/maths';

export interface FilmPlaybackContext {
    filmMaker: any;
    cameraDist: number;
    cameraCenter: THREE.Vector3;
    euler: [number, number, number];
    filmPlaybackIndex: number;
    filmPlaybackRequestId: number | null;
    filmPlaybackLastTimestamp: number | null;
    filmPlaybackAccumulatorMs: number;
    isPlayingFilm: boolean;
    isRecordingFilm: boolean;
    mediaRecorder: MediaRecorder | null;
    recordedChunks: Blob[];
    lastRecordedBlob: Blob | null;
    videoFileName: string;
    videoMimeType: string;
    recordingVideoBitsPerSecond: number;
    recordingPixelRatioMin: number;
    rendererPixelRatio: number;
    filmMakerPlayBtn: HTMLButtonElement | null;

    updateCamera(): void;
    requestRender(): void;
    setFilmMakerPlayButtonState(playing: boolean): void;
    getBaseRendererPixelRatio(): number;
    applyRendererResolution(pr: number): void;
    restoreRendererResolution(): void;
    renderer: { domElement: HTMLCanvasElement };
}

export function advanceFilmPlaybackFrame(ctx: FilmPlaybackContext): boolean {
    if (ctx.filmPlaybackIndex >= ctx.filmMaker.frames.length) {
        stopPlayback(ctx);
        return false;
    }
    const { keyIndex, Twc } = ctx.filmMaker.frames[ctx.filmPlaybackIndex];
    const { center, euler } = recoverCenterEuler(Twc, ctx.cameraDist);
    ctx.cameraCenter.copy(center);
    ctx.euler = [euler[0], euler[1], euler[2]];
    ctx.updateCamera();
    ctx.filmMaker.currentIndex = keyIndex;
    ctx.filmPlaybackIndex++;
    ctx.requestRender();
    return true;
}

export function tickFilmPlayback(ctx: FilmPlaybackContext, timestamp?: number): void {
    if (timestamp === undefined) { advanceFilmPlaybackFrame(ctx); return; }
    if (!ctx.isPlayingFilm) return;
    if (ctx.filmPlaybackLastTimestamp == null) {
        ctx.filmPlaybackLastTimestamp = timestamp;
        scheduleFilmPlayback(ctx);
        return;
    }
    const stepMs = Math.max(ctx.filmMaker.updateIntervalMs, 1);
    ctx.filmPlaybackAccumulatorMs += Math.max(timestamp - ctx.filmPlaybackLastTimestamp, 0);
    ctx.filmPlaybackLastTimestamp = timestamp;
    while (ctx.filmPlaybackAccumulatorMs >= stepMs && ctx.isPlayingFilm) {
        ctx.filmPlaybackAccumulatorMs -= stepMs;
        if (!advanceFilmPlaybackFrame(ctx)) break;
    }
    if (ctx.isPlayingFilm) scheduleFilmPlayback(ctx);
}

export function scheduleFilmPlayback(ctx: FilmPlaybackContext): void {
    ctx.filmPlaybackRequestId = requestAnimationFrame((ts) => tickFilmPlayback(ctx, ts));
}

export function stopPlayback(ctx: FilmPlaybackContext): void {
    if (ctx.filmPlaybackRequestId != null) {
        cancelAnimationFrame(ctx.filmPlaybackRequestId);
        ctx.filmPlaybackRequestId = null;
    }
    ctx.filmPlaybackLastTimestamp = null;
    ctx.filmPlaybackAccumulatorMs = 0;
    ctx.isPlayingFilm = false;
    ctx.setFilmMakerPlayButtonState(false);
    if (ctx.mediaRecorder && ctx.mediaRecorder.state !== 'inactive') {
        stopRecording(ctx);
    } else {
        ctx.restoreRendererResolution();
    }
}

export function startPlayback(ctx: FilmPlaybackContext): boolean {
    if (ctx.filmMaker.keyFrames.length < 2) return false;
    ctx.filmMaker.createFrames();
    if (ctx.filmMaker.frames.length === 0) return false;
    ctx.filmPlaybackIndex = 0;
    ctx.filmPlaybackAccumulatorMs = 0;
    ctx.filmPlaybackLastTimestamp = null;
    ctx.isPlayingFilm = true;
    ctx.setFilmMakerPlayButtonState(true);
    if (ctx.isRecordingFilm) startRecording(ctx);
    if (!advanceFilmPlaybackFrame(ctx)) return false;
    if (ctx.filmPlaybackIndex < ctx.filmMaker.frames.length) scheduleFilmPlayback(ctx);
    return true;
}

export function startRecording(ctx: FilmPlaybackContext): void {
    try {
        const captureCanvas = ctx.renderer.domElement;
        if (!captureCanvas.captureStream) {
            console.warn('captureStream not supported');
            ctx.isRecordingFilm = false;
            return;
        }
        const recordingPixelRatio = Math.max(ctx.getBaseRendererPixelRatio(), ctx.recordingPixelRatioMin);
        if (recordingPixelRatio > ctx.rendererPixelRatio) ctx.applyRendererResolution(recordingPixelRatio);

        const stream = captureCanvas.captureStream(Math.max(30, Math.round(1000 / ctx.filmMaker.updateIntervalMs)));
        if (!stream) {
            console.warn('captureStream not supported');
            ctx.isRecordingFilm = false; ctx.restoreRendererResolution(); return;
        }
        const mimeType = MediaRecorder.isTypeSupported?.(ctx.videoMimeType) ? ctx.videoMimeType : '';
        ctx.recordedChunks = [];
        const opts: MediaRecorderOptions = { videoBitsPerSecond: ctx.recordingVideoBitsPerSecond };
        if (mimeType) opts.mimeType = mimeType;
        ctx.mediaRecorder = new MediaRecorder(stream, opts);
        ctx.mediaRecorder.ondataavailable = (e: BlobEvent) => {
            if (e.data && e.data.size > 0) ctx.recordedChunks.push(e.data);
        };
        ctx.mediaRecorder.onstop = () => {
            ctx.lastRecordedBlob = new Blob(ctx.recordedChunks, { type: ctx.mediaRecorder?.mimeType || 'video/webm' });
        };
        ctx.mediaRecorder.start();
    } catch (err) {
        console.warn('Recording start failed:', err);
        ctx.isRecordingFilm = false; ctx.restoreRendererResolution();
    }
}

export function stopRecording(ctx: FilmPlaybackContext): void {
    try { ctx.mediaRecorder?.stop(); } catch (err) { console.warn('Recording stop failed:', err); }
    finally { ctx.restoreRendererResolution(); }
}

export function downloadLastRecording(ctx: FilmPlaybackContext, vscode?: any): boolean {
    if (!ctx.lastRecordedBlob) return false;
    const filename = ctx.videoFileName || 'q3dweb.mp4';
    if (vscode) {
        ctx.lastRecordedBlob.arrayBuffer().then((buf) => {
            vscode.postMessage({ type: 'saveVideo', data: new Uint8Array(buf), filename, mimeType: ctx.lastRecordedBlob?.type || 'video/webm' });
        }).catch((err: any) => console.warn('Failed to read recorded blob:', err));
        return true;
    }
    const url = URL.createObjectURL(ctx.lastRecordedBlob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
}
