import * as THREE from 'three';
import { WebGLCloudBackend } from '../utils/WebGLCloudBackend';
import type { ColorMode } from '../utils/realtimeTypes';

export interface NativeCloudItemOptions {
    colorMode?: ColorMode;
    pointSize?: number;
    alpha?: number;
}

export class NativeCloudItem extends THREE.Object3D {
    private readonly backend = new WebGLCloudBackend();
    private colorMode: ColorMode;
    private pointSize: number;
    private alpha: number;
    private dataMin = Number.POSITIVE_INFINITY;
    private dataMax = Number.NEGATIVE_INFINITY;

    constructor(options: NativeCloudItemOptions = {}) {
        super();
        this.colorMode = options.colorMode ?? 'FLAT';
        this.pointSize = options.pointSize ?? 1;
        this.alpha = options.alpha ?? 1;
    }

    setColorMode(colorMode: ColorMode): void {
        this.colorMode = colorMode;
    }

    setPointSize(pointSize: number): void {
        if (Number.isFinite(pointSize) && pointSize > 0) {
            this.pointSize = pointSize;
        }
    }

    setAlpha(alpha: number): void {
        if (!Number.isFinite(alpha)) return;
        this.alpha = Math.max(0, Math.min(1, alpha));
    }

    reset(maxPoints: number): void {
        this.backend.reset(maxPoints);
        this.dataMin = Number.POSITIVE_INFINITY;
        this.dataMax = Number.NEGATIVE_INFINITY;
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
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            if (value < this.dataMin) this.dataMin = value;
            if (value > this.dataMax) this.dataMax = value;
        }
    }

    draw(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
        this.backend.draw(
            renderer,
            camera,
            this.colorMode,
            Number.isFinite(this.dataMin) ? this.dataMin : 0,
            Number.isFinite(this.dataMax) ? this.dataMax : 255,
            this.pointSize,
            this.alpha,
        );
    }

    getPointCount(): number {
        return this.backend.getPointCount();
    }
}
