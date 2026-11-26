import * as THREE from 'three';
import { CloudShaderMaterial, type CloudItemOptions } from './CloudItem';
import { ChunkedCloudBackend } from '../cloud/ChunkedCloudBackend';
import { buildSpatialChunks } from '../cloud/spatialChunker';
import { buildSpatialChunksAsync, yieldToMain } from '../cloud/asyncChunkBuilder';
import type {
    CloudBounds,
    CloudRenderStats,
    CloudRenderUniformSnapshot,
    QuantizedChunkData,
} from '../cloud/types';

export interface ChunkedCloudGeometryCompat {
    boundingBox: THREE.Box3 | null;
    boundingSphere: THREE.Sphere | null;
    getAttribute(name: string): { count: number } | undefined;
    computeBoundingBox(): void;
    dispose(): void;
}

const _chunkBox = new THREE.Box3();
const _hitPoint = new THREE.Vector3();
const _candidate = new THREE.Vector3();
const _rayLocal = new THREE.Ray();
const _invMatrix = new THREE.Matrix4();

/**
 * High-performance spatial-chunked point cloud scene item supporting 100M+ points.
 * Maintains full API/UI compatibility with CloudItem (material.uniforms, geometry count,
 * updateViewport, raycast measurement, dispose).
 */
export class ChunkedCloudItem extends THREE.Object3D {
    readonly isChunkedCloudItem = true;
    readonly material: CloudShaderMaterial;
    readonly geometry: ChunkedCloudGeometryCompat;
    private readonly backend: ChunkedCloudBackend;
    private bounds: CloudBounds = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    private hasBounds = false;

    constructor(options: CloudItemOptions = {}, valOffset: number = 0, valScale: number = 1) {
        super();
        this.name = 'cloud';
        this.frustumCulled = false;
        this.material = new CloudShaderMaterial(options);
        this.backend = new ChunkedCloudBackend();
        this.backend.setValueQuantization(valOffset, valScale);

        const self = this;
        this.geometry = {
            boundingBox: null,
            boundingSphere: null,
            getAttribute(name: string) {
                if (name === 'position') {
                    return { count: self.getPointCount() };
                }
                return undefined;
            },
            computeBoundingBox() {
                self.syncBoundingVolumes();
            },
            dispose() {
                // GPU resources are owned and released by ChunkedCloudItem.dispose()
            },
        };
    }

    static fromArrays(
        positions: Float32Array,
        values: Float32Array,
        options: CloudItemOptions = {},
        rgbColors?: Uint8Array,
        renderer?: THREE.WebGLRenderer,
    ): ChunkedCloudItem {
        const built = buildSpatialChunks(positions, values, rgbColors);
        const item = new ChunkedCloudItem(options, built.valOffset, built.valScale);
        for (let i = 0; i < built.chunks.length; i++) {
            item.addChunk(built.chunks[i], renderer);
        }
        item.setGlobalBounds(built.bounds);
        return item;
    }

    static async fromArraysAsync(
        positions: Float32Array,
        values: Float32Array,
        options: CloudItemOptions = {},
        rgbColors?: Uint8Array,
        renderer?: THREE.WebGLRenderer,
        onProgress?: (stage: 'chunking' | 'uploading', fraction: number) => void,
        sliceMs: number = 14,
    ): Promise<ChunkedCloudItem> {
        const built = await buildSpatialChunksAsync(positions, values, rgbColors, {
            sliceMs,
            onProgress: (f) => onProgress?.('chunking', f),
        });
        const item = new ChunkedCloudItem(options, built.valOffset, built.valScale);
        const total = built.chunks.length;
        let sliceStart = performance.now();
        for (let i = 0; i < total; i++) {
            item.addChunk(built.chunks[i], renderer);
            if (i + 1 < total && performance.now() - sliceStart >= sliceMs) {
                onProgress?.('uploading', (i + 1) / total);
                await yieldToMain();
                sliceStart = performance.now();
            }
        }
        onProgress?.('uploading', 1);
        item.setGlobalBounds(built.bounds);
        return item;
    }

    addChunk(chunk: QuantizedChunkData, renderer?: THREE.WebGLRenderer): void {
        this.backend.addChunk(chunk, renderer);
        this.expandBounds(chunk.bounds);
    }

    setGlobalBounds(bounds: CloudBounds): void {
        this.bounds = { ...bounds };
        this.hasBounds = true;
        this.syncBoundingVolumes();
    }

    getPointCount(): number {
        return this.backend.getTotalPoints();
    }

    getChunkCount(): number {
        return this.backend.getChunkCount();
    }

    updateViewport(height: number): void {
        this.material.uniforms.viewportHeight.value = Math.max(height, 1);
    }

    needsRefinement(): boolean {
        return this.visible && this.backend.needsRefinement();
    }

    invalidateCache(): void {
        this.backend.invalidateCache();
    }

    getStats(): CloudRenderStats {
        return this.backend.getStats();
    }

    setInteractivePointBudget(budget: number): void {
        this.backend.setInteractiveBudgetLocked(budget);
    }

    setRefineBatchPoints(batchPoints: number): void {
        this.backend.refineBatchPoints = Math.max(250_000, Math.floor(batchPoints));
    }

    renderWithBackend(
        renderer: THREE.WebGLRenderer,
        camera: THREE.PerspectiveCamera,
        renderBaseScene: (target: THREE.WebGLRenderTarget | null) => void,
    ): boolean {
        if (!this.visible || this.backend.getTotalPoints() === 0) {
            renderBaseScene(null);
            return false;
        }
        const u = this.material.uniforms;
        const flatColor = u.flatColor.value as THREE.Color;
        const snapshot: CloudRenderUniformSnapshot = {
            pointSize: Number(u.pointSize.value) || 1.0,
            alpha: Number(u.alpha.value),
            vmin: Number(u.vmin.value),
            vmax: Number(u.vmax.value),
            colorMode: Number(u.colorMode.value) || 0,
            flatR: flatColor.r,
            flatG: flatColor.g,
            flatB: flatColor.b,
            pointType: Number(u.pointType.value) || 0,
            viewportHeight: Number(u.viewportHeight.value) || 1.0,
        };
        return this.backend.renderFrame(renderer, camera, snapshot, renderBaseScene);
    }

    /**
     * Spatial-chunk accelerated raycast for Ctrl+click measurement.
     * Prunes 99%+ of chunks via AABB ray intersection and tests compact pick samples.
     */
    override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
        if (!this.visible || this.backend.getTotalPoints() === 0) return;

        const threshold = raycaster.params.Points?.threshold ?? 0.5;
        const thresholdSq = threshold * threshold;
        _invMatrix.copy(this.matrixWorld).invert();
        _rayLocal.copy(raycaster.ray).applyMatrix4(_invMatrix);

        const chunkCount = this.backend.getChunkCount();
        let bestDistSqToRay = thresholdSq;
        let bestCamDist = Infinity;
        let hasBest = false;

        for (let ci = 0; ci < chunkCount; ci++) {
            const chunk = this.backend.getChunkAt(ci);
            if (!chunk || chunk.pickPositions.length === 0) continue;

            const b = chunk.bounds;
            _chunkBox.min.set(b.minX - threshold, b.minY - threshold, b.minZ - threshold);
            _chunkBox.max.set(b.maxX + threshold, b.maxY + threshold, b.maxZ + threshold);
            if (!_rayLocal.intersectsBox(_chunkBox)) continue;

            const pts = chunk.pickPositions;
            const n = pts.length;
            for (let i = 0; i < n; i += 3) {
                _candidate.set(pts[i], pts[i + 1], pts[i + 2]);
                const distSq = _rayLocal.distanceSqToPoint(_candidate);
                if (distSq < bestDistSqToRay) {
                    const camDist = _rayLocal.origin.distanceTo(_candidate);
                    if (camDist >= raycaster.near && camDist <= raycaster.far) {
                        bestDistSqToRay = distSq;
                        bestCamDist = camDist;
                        _hitPoint.copy(_candidate);
                        hasBest = true;
                    }
                }
            }
        }

        if (hasBest) {
            const worldHit = _hitPoint.clone().applyMatrix4(this.matrixWorld);
            const intersection: THREE.Intersection & { distanceToRay?: number } = {
                distance: bestCamDist,
                distanceToRay: Math.sqrt(bestDistSqToRay),
                point: worldHit,
                object: this,
            };
            intersects.push(intersection);
        }
    }

    dispose(): void {
        this.backend.dispose();
        this.material.dispose();
    }

    private expandBounds(b: CloudBounds): void {
        if (!this.hasBounds) {
            this.bounds = { ...b };
            this.hasBounds = true;
        } else {
            if (b.minX < this.bounds.minX) this.bounds.minX = b.minX;
            if (b.minY < this.bounds.minY) this.bounds.minY = b.minY;
            if (b.minZ < this.bounds.minZ) this.bounds.minZ = b.minZ;
            if (b.maxX > this.bounds.maxX) this.bounds.maxX = b.maxX;
            if (b.maxY > this.bounds.maxY) this.bounds.maxY = b.maxY;
            if (b.maxZ > this.bounds.maxZ) this.bounds.maxZ = b.maxZ;
        }
        this.syncBoundingVolumes();
    }

    private syncBoundingVolumes(): void {
        if (!this.hasBounds) {
            this.geometry.boundingBox = null;
            this.geometry.boundingSphere = null;
            return;
        }
        const box = this.geometry.boundingBox ?? new THREE.Box3();
        box.min.set(this.bounds.minX, this.bounds.minY, this.bounds.minZ);
        box.max.set(this.bounds.maxX, this.bounds.maxY, this.bounds.maxZ);
        this.geometry.boundingBox = box;
        const sphere = this.geometry.boundingSphere ?? new THREE.Sphere();
        box.getBoundingSphere(sphere);
        this.geometry.boundingSphere = sphere;
    }
}
