import * as THREE from 'three';
import { WebGLCloudBackend } from '../utils/WebGLCloudBackend';
import type { ColorMode } from '../utils/realtimeTypes';
import { extractDepthCoeffs, maxDepthCoeffsDiff } from '../cloud/depthSort';
import { AUTO_SORT_ALPHA_THRESHOLD, AUTO_SORT_DEPTH_THRESHOLD } from '../cloud/autoDepthSort';

export interface NativeCloudItemOptions {
    colorMode?: ColorMode;
    pointSize?: number;
    alpha?: number;
    vmin?: number;
    vmax?: number;
}

export class NativeCloudItem extends THREE.Object3D {
    private readonly backend = new WebGLCloudBackend();
    private colorMode: ColorMode;
    private pointSize: number;
    private alpha: number;
    private vmin: number;
    private vmax: number;
    private lastSortedCoeffs: [number, number, number] | null = null;

    constructor(options: NativeCloudItemOptions = {}) {
        super();
        this.colorMode = options.colorMode ?? 'FLAT';
        this.pointSize = options.pointSize ?? 1;
        this.alpha = options.alpha ?? 1;
        this.vmin = options.vmin ?? 0;
        this.vmax = options.vmax ?? 255;
    }

    setColorMode(colorMode: ColorMode): void {
        this.colorMode = colorMode;
    }

    setPointSize(pointSize: number): void {
        if (Number.isFinite(pointSize) && pointSize > 0) {
            this.pointSize = pointSize;
        }
    }

    getPointSize(): number { return this.pointSize; }

    setAlpha(alpha: number): void {
        if (!Number.isFinite(alpha)) return;
        this.alpha = Math.max(0, Math.min(1, alpha));
    }

    setVmin(v: number): void { this.vmin = v; }
    setVmax(v: number): void { this.vmax = v; }

    getVmin(): number { return this.vmin; }
    getVmax(): number { return this.vmax; }

    reset(maxPoints: number): void {
        this.lastSortedCoeffs = null;
        this.backend.reset(maxPoints);
    }

    appendPoints(
        renderer: THREE.WebGLRenderer,
        positions: Float32Array,
        values: Float32Array,
        maxPoints: number,
    ): void {
        if (positions.length !== values.length * 3) return;
        if (values.length === 0) return;

        this.lastSortedCoeffs = null;
        this.backend.append(renderer, positions, values, maxPoints);
    }

    draw(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
        this.backend.draw(
            renderer,
            camera,
            this.colorMode,
            this.vmin,
            this.vmax,
            this.pointSize,
            this.alpha,
        );
    }

    getPointCount(): number {
        return this.backend.getPointCount();
    }

    forceSort(camera: THREE.Camera, renderer?: THREE.WebGLRenderer): boolean {
        this.updateMatrixWorld();
        const sorted = this.backend.sortByDepth(renderer, camera, this.matrixWorld);
        if (sorted) {
            const coeffs = extractDepthCoeffs(camera.matrixWorldInverse, this.matrixWorld);
            this.lastSortedCoeffs = [coeffs[0], coeffs[1], coeffs[2]];
        }
        return sorted;
    }

    isTransparentForDepthSort(): boolean {
        return this.alpha < AUTO_SORT_ALPHA_THRESHOLD;
    }

    autoSortIfNeeded(camera: THREE.Camera, renderer?: THREE.WebGLRenderer): boolean {
        if (this.getPointCount() <= 1 || !this.isTransparentForDepthSort()) return false;
        camera.updateMatrixWorld();
        this.updateMatrixWorld();
        const coeffs = extractDepthCoeffs(camera.matrixWorldInverse, this.matrixWorld);
        if (maxDepthCoeffsDiff(coeffs, this.lastSortedCoeffs) < AUTO_SORT_DEPTH_THRESHOLD) {
            return false;
        }
        return this.forceSort(camera, renderer);
    }
}
