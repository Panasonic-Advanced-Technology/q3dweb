import * as THREE from 'three';
import { WebGLCloudBackend } from '../utils/WebGLCloudBackend';
import type { ColorMode } from '../utils/realtimeTypes';

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
}
