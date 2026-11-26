import * as THREE from 'three';
import { CloudItem, CloudShaderMaterial } from '../items/CloudItem';
import { ChunkedCloudItem } from '../items/ChunkedCloudItem';
import { StreamingChunkBuilder } from '../cloud/spatialChunker';
import type { StreamingCloudInitOptions } from '../cloud/types';

export const STATIC_CHUNKED_THRESHOLD = 100_000;

type CloudRenderOptions = {
    pointSize?: number;
    pointType?: 'PIXEL' | 'SQUARE' | 'SPHERE';
    alpha?: number;
    colorMode?: 'I' | 'RGB' | 'FLAT';
    vmin?: number;
    vmax?: number;
};

function colorModeToUniformValue(colorMode: 'I' | 'RGB' | 'FLAT'): number {
    if (colorMode === 'RGB') return 1;
    if (colorMode === 'FLAT') return 2;
    return 0;
}

function pointTypeToUniformValue(pointType: 'PIXEL' | 'SQUARE' | 'SPHERE'): number {
    if (pointType === 'SQUARE') return 1;
    if (pointType === 'SPHERE') return 2;
    return 0;
}

function resolvePointSize(v: any, options: CloudRenderOptions, pointType: 'PIXEL' | 'SQUARE' | 'SPHERE'): number {
    const pixelRatio = typeof v.getBaseRendererPixelRatio === 'function'
        ? v.getBaseRendererPixelRatio()
        : Math.max(window.devicePixelRatio || 1, 1);
    if (options.pointSize === undefined) return 1.0 * pixelRatio;
    return pointType === 'PIXEL' ? options.pointSize * pixelRatio : options.pointSize;
}

function applyCloudMaterialSettings(
    material: CloudShaderMaterial,
    pointSize: number,
    pointType: 'PIXEL' | 'SQUARE' | 'SPHERE',
    alpha: number,
    colorMode: 'I' | 'RGB' | 'FLAT',
    effectiveMin: number,
    effectiveMax: number,
): void {
    material.uniforms.pointSize.value = pointSize;
    material.uniforms.pointType.value = pointTypeToUniformValue(pointType);
    material.uniforms.alpha.value = alpha;
    material.uniforms.colorMode.value = colorModeToUniformValue(colorMode);
    material.uniforms.vmin.value = effectiveMin;
    material.uniforms.vmax.value = effectiveMax;
    material.transparent = alpha < 0.99 || pointType === 'SPHERE';
    material.depthWrite = true;
}

function fitCameraToBox(v: any, box: THREE.Box3 | null): void {
    if (!box) return;
    const center = new THREE.Vector3();
    box.getCenter(center);
    v.cameraCenter.copy(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    v.cameraDist = (Math.max(size.x, size.y, size.z) / (2 * Math.tan(v.camera.fov * Math.PI / 360))) * 1.5;
    v.euler = [Math.PI / 3, 0, Math.PI / 4];
    v.updateCamera();
}

export type CloudBuildProgressCallback = (stage: 'chunking' | 'uploading', fraction: number) => void;

function prepareCloudMetadata(
    v: any,
    values: Float32Array,
    rgbColors?: Uint8Array,
): {
    count: number;
    effectiveMin: number;
    effectiveMax: number;
    hasUsableRGB: boolean;
    colorMode: 'I' | 'RGB' | 'FLAT';
    pointType: 'PIXEL' | 'SQUARE' | 'SPHERE';
    pointSize: number;
    alpha: number;
} {
    const count = values.length;
    let minVal = Infinity, maxVal = -Infinity;
    const step = Math.max(1, Math.min(1000, Math.floor(count / 4096) || 1));
    for (let i = 0; i < count; i += step) {
        const val = values[i];
        if (val < minVal) minVal = val;
        if (val > maxVal) maxVal = val;
    }
    if (minVal === Infinity) { minVal = 0; maxVal = 255; }
    if (minVal === maxVal) { minVal -= 1; maxVal += 1; }
    const renderOptions = (v.cloudRenderOptions ?? {}) as CloudRenderOptions;
    const effectiveMin = renderOptions.vmin ?? minVal;
    const effectiveMax = renderOptions.vmax ?? maxVal;
    v.dataMin = effectiveMin; v.dataMax = effectiveMax;

    let hasUsableRGB = false;
    let colorMode: 'I' | 'RGB' | 'FLAT' = 'I';
    if (rgbColors) {
        for (let i = 0; i < Math.min(rgbColors.length, 3000); i += 3) {
            if (rgbColors[i] > 0 || rgbColors[i + 1] > 0 || rgbColors[i + 2] > 0) {
                hasUsableRGB = true;
                colorMode = 'RGB';
                break;
            }
        }
    }
    colorMode = renderOptions.colorMode ?? colorMode;
    const pointType = renderOptions.pointType ?? 'PIXEL';
    const pointSize = resolvePointSize(v, renderOptions, pointType);
    const alpha = renderOptions.alpha ?? 0.1;
    return { count, effectiveMin, effectiveMax, hasUsableRGB, colorMode, pointType, pointSize, alpha };
}

function finalizeRenderedCloud(
    v: any,
    cloud: CloudItem | ChunkedCloudItem,
    meta: ReturnType<typeof prepareCloudMetadata>,
): void {
    const material = cloud.material as CloudShaderMaterial;
    applyCloudMaterialSettings(
        material,
        meta.pointSize,
        meta.pointType,
        meta.alpha,
        meta.colorMode,
        meta.effectiveMin,
        meta.effectiveMax,
    );
    cloud.name = 'cloud';
    cloud.frustumCulled = false;
    cloud.geometry.computeBoundingBox();
    fitCameraToBox(v, cloud.geometry.boundingBox);

    v.addItem('cloud', cloud);
    if (v.statusElement) v.statusElement.textContent = `${meta.count.toLocaleString()} points`;
    if (v.loadingOverlay) v.loadingOverlay.style.display = 'none';
    v.requestRender();
}

export function renderPoints(v: any, positions: Float32Array, values: Float32Array, rgbColors?: Uint8Array): void {
    const meta = prepareCloudMetadata(v, values, rgbColors);
    const useChunked = meta.count >= STATIC_CHUNKED_THRESHOLD;
    const cloud = useChunked
        ? ChunkedCloudItem.fromArrays(
            positions,
            values,
            { size: meta.pointSize, alpha: meta.alpha, colorMode: meta.colorMode, pointType: meta.pointType },
            (meta.hasUsableRGB || meta.colorMode === 'RGB') ? rgbColors : undefined,
            v.renderer,
        )
        : new CloudItem(
            positions,
            values,
            { size: meta.pointSize, alpha: meta.alpha, colorMode: meta.colorMode, pointType: meta.pointType },
            meta.colorMode === 'RGB' ? rgbColors : undefined,
        );

    finalizeRenderedCloud(v, cloud, meta);
}

/**
 * Time-sliced async version of renderPoints() for large clouds.
 * Yields between ~14ms slices during spatial chunking and GPU VBO upload so the UI never freezes.
 */
export async function renderPointsAsync(
    v: any,
    positions: Float32Array,
    values: Float32Array,
    rgbColors?: Uint8Array,
    onProgress?: CloudBuildProgressCallback,
): Promise<void> {
    if (values.length < STATIC_CHUNKED_THRESHOLD) {
        renderPoints(v, positions, values, rgbColors);
        onProgress?.('uploading', 1);
        return;
    }
    const meta = prepareCloudMetadata(v, values, rgbColors);
    const cloud = await ChunkedCloudItem.fromArraysAsync(
        positions,
        values,
        { size: meta.pointSize, alpha: meta.alpha, colorMode: meta.colorMode, pointType: meta.pointType },
        (meta.hasUsableRGB || meta.colorMode === 'RGB') ? rgbColors : undefined,
        v.renderer,
        onProgress,
    );
    if (v.streamAborted) {
        cloud.dispose();
        return;
    }
    finalizeRenderedCloud(v, cloud, meta);
}

export function beginStreamingCloud(v: any, options: StreamingCloudInitOptions): void {
    v.removeItem('cloud');
    const renderOptions = (v.cloudRenderOptions ?? {}) as CloudRenderOptions;
    const pointType = renderOptions.pointType ?? 'PIXEL';
    const pointSize = resolvePointSize(v, renderOptions, pointType);
    const alpha = renderOptions.alpha ?? 0.1;
    const colorMode = renderOptions.colorMode ?? (options.hasRGB ? 'RGB' : 'I');
    const valMin = options.valMin ?? 0;
    const valMax = options.valMax ?? 255;

    const builder = new StreamingChunkBuilder(options);
    const cloud = new ChunkedCloudItem(
        { size: pointSize, alpha, colorMode, pointType },
        builder.valOffset,
        builder.valScale,
    );
    applyCloudMaterialSettings(
        cloud.material,
        pointSize,
        pointType,
        alpha,
        colorMode,
        renderOptions.vmin ?? valMin,
        renderOptions.vmax ?? valMax,
    );
    v.streamingBuilder = builder;
    v.streamingCloudItem = cloud;
    v.streamingHasNonZeroRGB = false;
    v.streamingMinVal = Infinity;
    v.streamingMaxVal = -Infinity;
}

export function pushStreamingCloudBatch(
    v: any,
    positions: Float32Array,
    values: Float32Array,
    rgbColors?: Uint8Array,
    pointCount: number = values.length,
): void {
    const builder = v.streamingBuilder as StreamingChunkBuilder | null;
    const cloud = v.streamingCloudItem as ChunkedCloudItem | null;
    if (!builder || !cloud || pointCount <= 0) return;

    const sampleStep = Math.max(1, Math.floor(pointCount / 256));
    for (let i = 0; i < pointCount; i += sampleStep) {
        const val = values[i];
        if (val < v.streamingMinVal) v.streamingMinVal = val;
        if (val > v.streamingMaxVal) v.streamingMaxVal = val;
    }
    if (!v.streamingHasNonZeroRGB && rgbColors) {
        const probeEnd = Math.min(pointCount * 3, 3000);
        for (let i = 0; i < probeEnd; i += 3) {
            if (rgbColors[i] > 0 || rgbColors[i + 1] > 0 || rgbColors[i + 2] > 0) {
                v.streamingHasNonZeroRGB = true;
                break;
            }
        }
    }

    builder.pushBatch(positions, values, rgbColors, pointCount, (chunk) => {
        cloud.addChunk(chunk, v.renderer);
    });
}

function finalizeStreamingCloudCommon(
    v: any,
    builder: StreamingChunkBuilder,
    cloud: ChunkedCloudItem,
): void {
    const count = cloud.getPointCount();
    const renderOptions = (v.cloudRenderOptions ?? {}) as CloudRenderOptions;
    let minVal = v.streamingMinVal;
    let maxVal = v.streamingMaxVal;
    if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) { minVal = 0; maxVal = 255; }
    if (minVal === maxVal) { minVal -= 1; maxVal += 1; }
    const effectiveMin = renderOptions.vmin ?? minVal;
    const effectiveMax = renderOptions.vmax ?? maxVal;
    v.dataMin = effectiveMin;
    v.dataMax = effectiveMax;

    const pointType = renderOptions.pointType ?? 'PIXEL';
    const pointSize = resolvePointSize(v, renderOptions, pointType);
    const alpha = renderOptions.alpha ?? 0.1;
    const colorMode = renderOptions.colorMode ?? (v.streamingHasNonZeroRGB ? 'RGB' : 'I');
    applyCloudMaterialSettings(cloud.material, pointSize, pointType, alpha, colorMode, effectiveMin, effectiveMax);

    cloud.setGlobalBounds(builder.getGlobalBounds());
    cloud.name = 'cloud';
    fitCameraToBox(v, cloud.geometry.boundingBox);

    v.addItem('cloud', cloud);
    if (v.statusElement) v.statusElement.textContent = `${count.toLocaleString()} points`;
    if (v.loadingOverlay) v.loadingOverlay.style.display = 'none';
    v.requestRender();
}

export function finishStreamingCloud(v: any): void {
    const builder = v.streamingBuilder as StreamingChunkBuilder | null;
    const cloud = v.streamingCloudItem as ChunkedCloudItem | null;
    v.streamingBuilder = null;
    v.streamingCloudItem = null;
    if (!builder || !cloud) return;

    builder.finish((chunk) => {
        cloud.addChunk(chunk, v.renderer);
    });
    finalizeStreamingCloudCommon(v, builder, cloud);
}

export async function finishStreamingCloudAsync(
    v: any,
    onProgress?: (fraction: number) => void,
): Promise<void> {
    const builder = v.streamingBuilder as StreamingChunkBuilder | null;
    const cloud = v.streamingCloudItem as ChunkedCloudItem | null;
    v.streamingBuilder = null;
    v.streamingCloudItem = null;
    if (!builder || !cloud) return;

    await builder.finishAsync((chunk) => {
        cloud.addChunk(chunk, v.renderer);
    }, onProgress);
    if (v.streamAborted) {
        cloud.dispose();
        return;
    }
    finalizeStreamingCloudCommon(v, builder, cloud);
}

export function resetRealtimeCloud(v: any): void {
    v.removeItem('cloud');
    if (v.statusElement) v.statusElement.textContent = '0 points';
    v.requestRender();
}

export function appendRealtimePoints(v: any, positions: Float32Array, values: Float32Array, rgbColors?: Uint8Array, maxPoints?: number, autoFitOnFirstChunk: boolean = false): void {
    if (positions.length !== values.length * 3) { console.warn('appendRealtimePoints: positions.length must equal values.length * 3'); return; }
    if (rgbColors && rgbColors.length !== values.length * 3) { console.warn('appendRealtimePoints: rgb.length must equal values.length * 3'); return; }
    if (values.length === 0) return;

    let cloud = v.items['cloud'];
    if (!(cloud instanceof CloudItem)) {
        cloud = new CloudItem(new Float32Array(0), new Float32Array(0), { size: 1.0 * window.devicePixelRatio, alpha: 0.1, colorMode: rgbColors ? 'RGB' : 'I' });
        cloud.name = 'cloud'; cloud.frustumCulled = false; v.addItem('cloud', cloud);
    }
    const cloudItem = cloud as CloudItem;
    const beforeCount = cloudItem.getPointCount();
    const count = cloudItem.appendPoints(positions, values, rgbColors, Math.max(1, maxPoints ?? v.realtimeMaxPoints));
    const material = cloudItem.material as CloudShaderMaterial;
    if (rgbColors) material.uniforms.colorMode.value = 1;

    let chunkMin = Infinity, chunkMax = -Infinity;
    for (let i = 0; i < values.length; i++) { const val = values[i]; if (val < chunkMin) chunkMin = val; if (val > chunkMax) chunkMax = val; }
    if (beforeCount === 0 || v.dataMin > v.dataMax) { v.dataMin = chunkMin; v.dataMax = chunkMax; }
    else { if (chunkMin < v.dataMin) v.dataMin = chunkMin; if (chunkMax > v.dataMax) v.dataMax = chunkMax; }
    if (v.dataMin === v.dataMax) { v.dataMin -= 1; v.dataMax += 1; }
    material.uniforms.vmin.value = v.dataMin; material.uniforms.vmax.value = v.dataMax; material.needsUpdate = true;

    if (autoFitOnFirstChunk && beforeCount === 0) {
        cloudItem.geometry.computeBoundingBox();
        if (cloudItem.geometry.boundingBox) {
            const center = new THREE.Vector3(); cloudItem.geometry.boundingBox.getCenter(center); v.cameraCenter.copy(center);
            const size = new THREE.Vector3(); cloudItem.geometry.boundingBox.getSize(size);
            v.cameraDist = (Math.max(size.x, size.y, size.z) / (2 * Math.tan(v.camera.fov * Math.PI / 360))) * 1.5;
            v.euler = [Math.PI / 3, 0, Math.PI / 4]; v.updateCamera();
        }
    }
    if (v.statusElement) v.statusElement.textContent = `${count.toLocaleString()} points (realtime)`;
    if (v.loadingOverlay) v.loadingOverlay.style.display = 'none';
    v.requestRender();
}
