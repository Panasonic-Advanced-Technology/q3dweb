import { CloudViewer } from './cloud_viewer';
import { FilmMaker, KeyFrame } from './viewer/filmMaker';
import { recoverCenterEuler } from './utils/maths';
import {
    buildFilmMakerSettings, refreshFilmMakerList, syncFilmMakerSpinboxes, FilmMakerUIRefs,
    setMaterialButtonLabel,
} from './viewer/settingsUI';
import {
    FilmPlaybackContext,
    startPlayback as _startPlayback, stopPlayback as _stopPlayback,
    tickFilmPlayback as _tickPlayback, startRecording as _startRecording,
    stopRecording as _stopRecording, downloadLastRecording as _downloadLastRecording,
} from './viewer/filmPlayback';

/**
 * FilmMakerViewer extends the base Viewer with keyframe-based film/flythrough recording.
 * Its settings panel includes a persistent film maker section (keyframe list,
 * add/delete/play/record controls) above the inherited item dropdown.
 */
export class FilmMakerViewer extends CloudViewer {
    filmMaker: FilmMaker = new FilmMaker();
    /** Always true — enables Space/Delete keyboard shortcuts for keyframe editing. */
    get filmMakerTabActive(): boolean { return true; }
    filmPlaybackIndex: number = 0;
    filmPlaybackRequestId: number | null = null;
    filmPlaybackLastTimestamp: number | null = null;
    filmPlaybackAccumulatorMs: number = 0;
    isPlayingFilm: boolean = false;
    isRecordingFilm: boolean = false;
    mediaRecorder: MediaRecorder | null = null;
    recordedChunks: Blob[] = [];
    lastRecordedBlob: Blob | null = null;
    videoFileName: string = 'q3dweb.mp4';
    videoMimeType: string = 'video/mp4;codecs=h264';
    recordingVideoBitsPerSecond: number = 32_000_000;
    recordingPixelRatioMin: number = 2;
    private filmMakerListEl: HTMLElement | null = null;
    private filmMakerPlayBtn: HTMLButtonElement | null = null;
    private filmMakerSpinLin: HTMLInputElement | null = null;
    private filmMakerSpinAng: HTMLInputElement | null = null;
    private filmMakerSpinStop: HTMLInputElement | null = null;

    constructor(containerId: string) {
        super(containerId);
        // Fields are now initialized — install the film maker section in the panel.
        this.installFilmMakerSection();
    }

    /**
    * Inserts the film maker controls (keyframe list + add/delete/play buttons) into the
    * settings panel above the item dropdown and per-item content area.
     * Called from the constructor after field initialization.
     */
    private installFilmMakerSection(): void {
        if (!this.settingsPanel || !this.settingsContent) return;
        const section = document.createElement('div');
        section.className = 'q3d-settings-section';
        section.setAttribute('data-role', 'film-maker');
        const refs: FilmMakerUIRefs = buildFilmMakerSettings(section, {
            filmMaker: this.filmMaker,
            isPlayingFilm: this.isPlayingFilm,
            isRecordingFilm: this.isRecordingFilm,
            videoFileName: this.videoFileName,
            videoMimeType: this.videoMimeType,
            addKeyFrameFromCamera: () => this.addKeyFrameFromCamera(),
            deleteCurrentKeyFrame: () => this.deleteCurrentKeyFrame(),
            togglePlayback: () => this.togglePlayback(),
            downloadLastRecording: () => this.downloadLastRecording(),
            selectKeyFrame: (i: number) => { this.selectKeyFrame(i); this.refreshFilmMakerListUI(); },
            jumpToKeyFrame: (i: number) => this.jumpToKeyFrame(i),
            refreshFilmMakerList: () => this.refreshFilmMakerListUI(),
            setIsRecordingFilm: (v: boolean) => { this.isRecordingFilm = v; },
            setVideoFileName: (v: string) => { this.videoFileName = v; },
            setVideoMimeType: (v: string) => { this.videoMimeType = v; },
            setLinVel: (i: number, v: number) => this.filmMaker.setLinVel(i, v),
            setAngVel: (i: number, v: number) => this.filmMaker.setAngVel(i, v),
            setStopTime: (i: number, v: number) => this.filmMaker.setStopTime(i, v),
        });
        this.filmMakerListEl = refs.listEl;
        this.filmMakerPlayBtn = refs.playBtn;
        this.filmMakerSpinLin = refs.spinLin;
        this.filmMakerSpinAng = refs.spinAng;
        this.filmMakerSpinStop = refs.spinStop;
        this.setFilmMakerPlayButtonState(this.isPlayingFilm);
        this.refreshFilmMakerListUI();
        syncFilmMakerSpinboxes(this.filmMaker, this.filmMakerSpinLin, this.filmMakerSpinAng, this.filmMakerSpinStop);
        const itemSelect = this.settingsItemSelect?.closest('.q3d-material-select') as HTMLElement | null;
        const itemLabel = this.settingsPanel.querySelector('[data-role="settings-item-label"]') as HTMLElement | null;
        const anchor = itemLabel ?? itemSelect;
        if (anchor?.parentElement === this.settingsPanel) {
            if (itemSelect) itemSelect.style.marginTop = '2px';
            this.settingsPanel.insertBefore(section, anchor);
        } else {
            this.settingsPanel.insertBefore(section, this.settingsContent);
        }
    }

    addKeyFrameFromCamera(): KeyFrame {
        this.camera.updateMatrixWorld();
        const kf = this.filmMaker.addKeyFrame(this.camera.matrixWorld.clone());
        this.scene.add(kf.item);
        this.refreshFilmMakerListUI();
        this.highlightSelectedKeyFrame();
        this.requestRender();
        return kf;
    }

    deleteCurrentKeyFrame(): void {
        const removed = this.filmMaker.deleteKeyFrame(this.filmMaker.currentIndex);
        if (removed) {
            this.scene.remove(removed.item);
            this.refreshFilmMakerListUI();
            this.highlightSelectedKeyFrame();
            this.requestRender();
        }
    }

    selectKeyFrame(index: number): void {
        this.filmMaker.select(index);
        this.highlightSelectedKeyFrame();
        syncFilmMakerSpinboxes(this.filmMaker, this.filmMakerSpinLin, this.filmMakerSpinAng, this.filmMakerSpinStop);
        this.requestRender();
    }

    jumpToKeyFrame(index: number): void {
        const kf = this.filmMaker.keyFrames[index];
        if (!kf) return;
        const { center, euler } = recoverCenterEuler(kf.Twc, this.cameraDist);
        this.cameraCenter.copy(center);
        this.euler = [euler[0], euler[1], euler[2]];
        this.updateCamera();
    }

    private highlightSelectedKeyFrame(): void {
        const sel = this.filmMaker.currentIndex;
        this.filmMaker.keyFrames.forEach((kf: any, i: number) => {
            kf.item.setColor(i === sel ? '#ff0000' : '#0000ff');
            kf.item.setLineWidth(i === sel ? 5 : 3);
        });
    }

    private refreshFilmMakerListUI(): void {
        if (!this.filmMakerListEl) return;
        refreshFilmMakerList(
            this.filmMakerListEl, this.filmMaker,
            (i) => { this.selectKeyFrame(i); this.refreshFilmMakerListUI(); },
            (i) => this.jumpToKeyFrame(i),
        );
    }

    setFilmMakerPlayButtonState(isPlaying: boolean): void {
        if (!this.filmMakerPlayBtn) return;
        setMaterialButtonLabel(this.filmMakerPlayBtn, isPlaying ? 'Playing' : 'Play');
        this.filmMakerPlayBtn.style.backgroundColor = isPlaying ? '#a33' : '#333';
        this.filmMakerPlayBtn.style.color = isPlaying ? '#fff' : '#eee';
        this.filmMakerPlayBtn.style.borderColor = isPlaying ? '#d66' : '#666';
    }

    togglePlayback(): void { this.isPlayingFilm ? this.stopPlayback() : this.startPlayback(); }
    startPlayback(): boolean { return _startPlayback(this as unknown as FilmPlaybackContext); }
    stopPlayback(): void { _stopPlayback(this as unknown as FilmPlaybackContext); }
    tickFilmPlayback(timestamp?: number): void { _tickPlayback(this as unknown as FilmPlaybackContext, timestamp); }
    startRecording(): void { _startRecording(this as unknown as FilmPlaybackContext); }
    stopRecording(): void { _stopRecording(this as unknown as FilmPlaybackContext); }
    downloadLastRecording(): boolean { return _downloadLastRecording(this as unknown as FilmPlaybackContext, (this as any).vscode); }
}
