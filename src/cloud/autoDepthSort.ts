import * as THREE from 'three';
import {
    measureMaxSortableChunk,
    RadixSortWorkspace,
    sortChunkOrderByDepth,
    sortSingleChunkEntry,
    type DepthCoeffs,
    type SortableGpuChunkEntry,
} from './depthSort';

export const AUTO_SORT_DEPTH_THRESHOLD = 0.1;
export const AUTO_SORT_ALPHA_THRESHOLD = 0.99;
export const DEFAULT_AUTO_SORT_IDLE_MS = 250;
export const DEFAULT_AUTO_SORT_TIME_SLICE_MS = 6;

export type IncrementalSortStartResult = 'skipped' | 'chunk-only-done' | 'in-progress';

export interface IncrementalDepthSortableItem {
    isTransparentForDepthSort(): boolean;
    beginAutoSort(camera: THREE.Camera, renderer?: THREE.WebGLRenderer): IncrementalSortStartResult;
    stepAutoSort(budgetMs: number, renderer?: THREE.WebGLRenderer): boolean;
    cancelAutoSort(): void;
}

export interface ImmediateAutoDepthSortableItem {
    isTransparentForDepthSort(): boolean;
    autoSortIfNeeded(camera: THREE.Camera, renderer?: THREE.WebGLRenderer): boolean;
}

export interface AutoDepthSortHost {
    getSortableItems(): Iterable<THREE.Object3D>;
    getCamera(): THREE.Camera;
    getRenderer(): THREE.WebGLRenderer;
    isUserInteracting(): boolean;
    requestRender(): void;
}

/**
 * Time-sliced per-chunk point sorter for ChunkedCloudBackend.
 * Performs O(M log M) chunk-level ordering immediately, then sorts individual chunk VBOs
 * across animation frames within a millisecond budget so user interaction never stalls.
 */
export class IncrementalChunkSorter {
    private entries: SortableGpuChunkEntry[] | null = null;
    private depthCoeffs: [number, number, number] | null = null;
    private gl2: WebGL2RenderingContext | null = null;
    private ws: RadixSortWorkspace | null = null;
    private srcBuf: Uint8Array | null = null;
    private dstBuf: Uint8Array | null = null;
    private cursor = 0;

    isActive(): boolean {
        return this.entries !== null;
    }

    getTargetCoeffs(): [number, number, number] | null {
        return this.depthCoeffs ? [this.depthCoeffs[0], this.depthCoeffs[1], this.depthCoeffs[2]] : null;
    }

    start(
        entries: SortableGpuChunkEntry[],
        depthCoeffs: DepthCoeffs,
        gl: WebGLRenderingContext | null,
        isWebGL2: boolean,
    ): 'chunk-only-done' | 'in-progress' {
        this.cancel();
        if (entries.length === 0) return 'chunk-only-done';

        sortChunkOrderByDepth(entries, depthCoeffs);

        const gl2 = isWebGL2 && gl ? (gl as WebGL2RenderingContext) : null;
        const canReadbackGpu = Boolean(gl2 && typeof gl2.getBufferSubData === 'function');
        const { maxBytes, maxPoints } = measureMaxSortableChunk(entries, canReadbackGpu);
        if (maxBytes === 0) return 'chunk-only-done';

        const ws = new RadixSortWorkspace();
        ws.ensureCapacity(maxPoints);
        this.entries = entries;
        this.depthCoeffs = [depthCoeffs[0], depthCoeffs[1], depthCoeffs[2]];
        this.gl2 = canReadbackGpu ? gl2 : null;
        this.ws = ws;
        this.srcBuf = new Uint8Array(maxBytes);
        this.dstBuf = new Uint8Array(maxBytes);
        this.cursor = 0;
        return 'in-progress';
    }

    step(budgetMs: number = DEFAULT_AUTO_SORT_TIME_SLICE_MS): { sortedChunks: number; done: boolean; failed: boolean } {
        if (!this.entries || !this.depthCoeffs || !this.ws || !this.srcBuf || !this.dstBuf) {
            return { sortedChunks: 0, done: true, failed: false };
        }

        const deadline = performance.now() + Math.max(0.5, budgetMs);
        const gl2 = this.gl2;
        if (gl2 && typeof gl2.bindVertexArray === 'function') {
            gl2.bindVertexArray(null);
        }

        let sortedChunks = 0;
        let failed = false;
        while (this.cursor < this.entries.length) {
            const status = sortSingleChunkEntry(
                this.entries[this.cursor],
                this.depthCoeffs,
                gl2,
                this.srcBuf,
                this.dstBuf,
                this.ws,
            );
            this.cursor++;
            if (status === 'error') {
                failed = true;
                break;
            }
            if (status === 'sorted') sortedChunks++;
            if (performance.now() >= deadline) break;
        }

        if (gl2) {
            gl2.bindBuffer(gl2.ARRAY_BUFFER, null);
        }

        const done = failed || this.cursor >= this.entries.length;
        if (done) {
            this.releaseBuffers();
        }
        return { sortedChunks, done, failed };
    }

    cancel(): void {
        this.releaseBuffers();
    }

    private releaseBuffers(): void {
        this.entries = null;
        this.depthCoeffs = null;
        this.gl2 = null;
        this.ws = null;
        this.srcBuf = null;
        this.dstBuf = null;
        this.cursor = 0;
    }
}

function isIncrementalSortable(item: THREE.Object3D): item is THREE.Object3D & IncrementalDepthSortableItem {
    const candidate = item as Partial<IncrementalDepthSortableItem>;
    return typeof candidate.beginAutoSort === 'function'
        && typeof candidate.stepAutoSort === 'function'
        && typeof candidate.cancelAutoSort === 'function'
        && typeof candidate.isTransparentForDepthSort === 'function';
}

function isImmediateAutoSortable(item: THREE.Object3D): item is THREE.Object3D & ImmediateAutoDepthSortableItem {
    const candidate = item as Partial<ImmediateAutoDepthSortableItem>;
    return typeof candidate.autoSortIfNeeded === 'function'
        && typeof candidate.isTransparentForDepthSort === 'function';
}

/**
 * Coordinates idle-triggered automatic depth sorting across viewer cloud items.
 * Cancels immediately on any user camera interaction so responsiveness is unaffected.
 */
export class AutoDepthSortController {
    private readonly host: AutoDepthSortHost;
    private enabled: boolean;
    private readonly idleDelayMs: number;
    private readonly timeSliceMs: number;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private stepRafId: number | null = null;
    private activeIncrementalItems: Array<THREE.Object3D & IncrementalDepthSortableItem> = [];

    constructor(
        host: AutoDepthSortHost,
        options: { enabled?: boolean; idleDelayMs?: number; timeSliceMs?: number } = {},
    ) {
        this.host = host;
        this.enabled = options.enabled ?? true;
        this.idleDelayMs = options.idleDelayMs ?? DEFAULT_AUTO_SORT_IDLE_MS;
        this.timeSliceMs = options.timeSliceMs ?? DEFAULT_AUTO_SORT_TIME_SLICE_MS;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) {
            this.cancelPendingAndActive();
            return;
        }
        this.scheduleIdleSort();
    }

    /** Called on camera movement or user interaction: interrupts active sorting and resets idle timer. */
    notifyActivity(): void {
        this.cancelActiveIncremental();
        this.clearIdleTimer();
        if (!this.enabled) return;
        this.scheduleIdleSort();
    }

    /** Schedule an idle sort check without cancelling an already-scheduled check unless reset. */
    scheduleIdleSort(): void {
        this.clearIdleTimer();
        if (!this.enabled) return;
        if (!this.hasTransparentSortableItem()) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            this.runIdleSort();
        }, this.idleDelayMs);
    }

    /** Cancel any scheduled or in-progress automatic sorting (e.g. manual 'r' or dispose). */
    cancelPendingAndActive(): void {
        this.clearIdleTimer();
        this.cancelActiveIncremental();
    }

    /** Run idle sort immediately (invoked by timer or tests). Returns true if any sort started or completed. */
    runIdleSort(): boolean {
        if (!this.enabled) return false;
        if (this.host.isUserInteracting()) {
            this.scheduleIdleSort();
            return false;
        }
        this.cancelActiveIncremental();

        const camera = this.host.getCamera();
        const renderer = this.host.getRenderer();
        camera.updateMatrixWorld();

        let needsRender = false;
        const nextIncremental: Array<THREE.Object3D & IncrementalDepthSortableItem> = [];

        for (const item of this.host.getSortableItems()) {
            if (!item.visible) continue;
            if (isIncrementalSortable(item)) {
                if (!item.isTransparentForDepthSort()) continue;
                const result = item.beginAutoSort(camera, renderer);
                if (result === 'chunk-only-done') {
                    needsRender = true;
                } else if (result === 'in-progress') {
                    // Chunk order already updated -> redraw immediately for instant coarse fix.
                    needsRender = true;
                    nextIncremental.push(item);
                }
            } else if (isImmediateAutoSortable(item)) {
                if (!item.isTransparentForDepthSort()) continue;
                if (item.autoSortIfNeeded(camera, renderer)) {
                    needsRender = true;
                }
            }
        }

        if (needsRender) {
            this.host.requestRender();
        }
        if (nextIncremental.length > 0) {
            this.activeIncrementalItems = nextIncremental;
            this.scheduleNextSlice();
        }
        return needsRender || nextIncremental.length > 0;
    }

    /** Process one time-sliced frame of active incremental sorts. Returns true when all are done. */
    stepActiveSort(): boolean {
        this.stepRafId = null;
        if (!this.enabled || this.host.isUserInteracting()) {
            this.cancelActiveIncremental();
            return true;
        }
        if (this.activeIncrementalItems.length === 0) return true;

        const renderer = this.host.getRenderer();
        const item = this.activeIncrementalItems[0];
        const done = item.stepAutoSort(this.timeSliceMs, renderer);
        if (done) {
            this.activeIncrementalItems.shift();
            this.host.requestRender();
        }

        if (this.activeIncrementalItems.length > 0) {
            this.scheduleNextSlice();
            return false;
        }
        return true;
    }

    private hasTransparentSortableItem(): boolean {
        for (const item of this.host.getSortableItems()) {
            if (!item.visible) continue;
            if ((isIncrementalSortable(item) || isImmediateAutoSortable(item)) && item.isTransparentForDepthSort()) {
                return true;
            }
        }
        return false;
    }

    private scheduleNextSlice(): void {
        if (this.stepRafId !== null) return;
        this.stepRafId = requestAnimationFrame(() => {
            this.stepActiveSort();
        });
    }

    private clearIdleTimer(): void {
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    private cancelActiveIncremental(): void {
        if (this.stepRafId !== null) {
            cancelAnimationFrame(this.stepRafId);
            this.stepRafId = null;
        }
        for (const item of this.activeIncrementalItems) {
            item.cancelAutoSort();
        }
        this.activeIncrementalItems = [];
    }
}
