import * as THREE from 'three';
import { Viewer } from './viewer';
import type { CloudUrlOptions } from './cloudUrlOptions';
import {
    PCDHeader, getFieldSpec, readPackedRGB as _readPackedRGB,
    parseAsciiPackedRGB as _parseAsciiPackedRGB, readNumericValue as _readNumericValue,
} from './parsers/pcdParser';
import { LASStreamState } from './parsers/lasParser';
import {
    detectFormat, assembleChunkList as _assembleChunkList,
    startStream as _startStream, processChunk as _processChunk,
    finalizeStream as _finalizeStream, loadData as _loadData,
    loadFile as _loadFile, handleDrop as _handleDrop, parseHeader as _parseHeader,
    checkMemoryBudget as _checkMemoryBudget,
} from './viewer/streamEngine';
import { loadUrl as _loadUrl } from './viewer/remoteCloudLoader';
import {
    renderPoints as _renderPoints, resetRealtimeCloud as _resetRealtime,
    appendRealtimePoints as _appendRealtime,
} from './viewer/cloudRenderer';

/**
 * CloudViewer extends the base Viewer with point cloud file loading.
 * Supports drag-and-drop and streaming for .pcd, .ply, .las, .laz, .e57 files.
 */
export class CloudViewer extends Viewer {
    static readonly SUPPORTED_EXTENSIONS = ['.pcd', '.ply', '.las', '.laz', '.e57'];
    skipMemoryCheck: boolean = false;

    // --- streaming state ---
    currentFormat: ReturnType<typeof detectFormat> = 'pcd';
    streamFilename: string | undefined = undefined;
    streamTotalSize: number = 0;
    streamLoadedSize: number = 0;
    streamAborted: boolean = false;
    pcdHeader: PCDHeader | null = null;
    lasStream: LASStreamState | null = null;
    isBinary: boolean = false;
    leftoverChunk: Uint8Array | null = null;
    pointsLoaded: number = 0;
    targetSampleRatio: number = 1;
    fullBufferWriteOffset: number = 0;
    chunkList: Uint8Array[] = [];

    // --- render buffers ---
    MAX_POINTS_VISUAL = 15_000_000;
    realtimeMaxPoints: number = 5_000_000;
    posBuffer: Float32Array | null = null;
    valBuffer: Float32Array | null = null;
    rgbBuffer: Uint8Array | null = null;
    fullBuffer: Uint8Array | null = null;
    posIndex: number = 0;
    dataMin: number = 0;
    dataMax: number = 255;
    cloudRenderOptions: Pick<CloudUrlOptions, 'pointSize' | 'pointType' | 'alpha' | 'colorMode' | 'vmin' | 'vmax'> = {};

    constructor(containerId: string, options: CloudUrlOptions = {}) {
        super(containerId);
        this.applyUrlOptions(options);
        this.setupDragDrop();
    }

    applyUrlOptions(options: CloudUrlOptions): void {
        if (options.maxPoints !== undefined) this.MAX_POINTS_VISUAL = Math.floor(options.maxPoints);
        if (options.backgroundColor) {
            try {
                this.scene.background = new THREE.Color(options.backgroundColor);
                this.colorStr = options.backgroundColor;
            } catch { /* ignore invalid colors */ }
        }
        if (options.showCenter !== undefined) this.enableShowCenter = options.showCenter;
        this.cloudRenderOptions = {
            pointSize: options.pointSize,
            pointType: options.pointType,
            alpha: options.alpha,
            colorMode: options.colorMode,
            vmin: options.vmin,
            vmax: options.vmax,
        };
        if (this.settingsItemSelect?.value === '__main_win__') this.onSettingsItemSelected('__main_win__');
    }

    setupDragDrop() {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(n =>
            this.container.addEventListener(n, (e: Event) => { e.preventDefault(); e.stopPropagation(); }, false));
        this.container.addEventListener('drop', (e) => void _handleDrop(this, e as DragEvent), false);
    }

    startStream(totalSize: number, filename?: string): void { _startStream(this, totalSize, filename); }
    processChunk(chunkData: Uint8Array, offset: number): void { _processChunk(this, chunkData, offset); }
    parseHeader(headerStr: string): void { _parseHeader(this, headerStr); }
    async finalizeStream(): Promise<void> { await _finalizeStream(this); }
    async loadData(content: Uint8Array, filename?: string): Promise<void> { await _loadData(this, content, filename); }
    async loadFile(file: File, append: boolean = false): Promise<void> { return _loadFile(this, file, append); }
    async loadUrl(sourceUrl: string, filename?: string): Promise<void> { return _loadUrl(this, sourceUrl, filename); }
    async handleDrop(e: DragEvent): Promise<void> { await _handleDrop(this, e); }
    readPackedRGB(view: DataView, byteOffset: number, type: string, size: number): number { return _readPackedRGB(view, byteOffset, type, size); }
    parseAsciiPackedRGB(token: string, type: string, size: number): number { return _parseAsciiPackedRGB(token, type, size); }
    readNumericValue(view: DataView, byteOffset: number, type: string, size: number): number { return _readNumericValue(view, byteOffset, type, size); }
    getFieldSpec(fieldName: string) { return this.pcdHeader ? getFieldSpec(this.pcdHeader, fieldName) : null; }
    detectFormat(filename?: string) { return detectFormat(filename); }
    checkMemoryBudget(fileSize: number, format: string, filename?: string): boolean { return _checkMemoryBudget(this, fileSize, format, filename); }
    assembleChunkList() { return _assembleChunkList(this); }

    renderPoints(positions: Float32Array, values: Float32Array, rgbColors?: Uint8Array): void { _renderPoints(this, positions, values, rgbColors); }
    resetRealtimeCloud(): void { _resetRealtime(this); }
    appendRealtimePoints(positions: Float32Array, values: Float32Array, rgbColors?: Uint8Array, maxPoints?: number, autoFitOnFirstChunk: boolean = false): void {
        _appendRealtime(this, positions, values, rgbColors, maxPoints, autoFitOnFirstChunk);
    }
}
