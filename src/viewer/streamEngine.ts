import * as THREE from 'three';
import { GNSSMapItem } from '../items/GNSSMapItem';
import {
    PCDBinaryState, parsePCDHeader, processPCDBinaryChunk, parsePCDAscii, getFieldSpec,
} from '../parsers/pcdParser';
import {
    createPCDAsciiStreamState, finalizePCDAsciiStream, processPCDAsciiStreamChunk,
} from '../parsers/pcdAsciiStream';
import { parsePLY } from '../parsers/plyParser';
import {
    createPLYStreamState, findPLYHeaderEnd, finalizePLYStreamState,
    parsePLYStreamHeader, processPLYStreamChunk,
} from '../parsers/plyStreamParser';
import {
    LASBounds, normalizeIntensity, parseLASMetadata, parseLAZ, processLASRecords,
} from '../parsers/lasParser';
import { parseE57 } from '../parsers/e57Parser';
import {
    computePointSampleRatio,
    estimateSampledPointCount,
} from '../parsers/sampling';
import {
    abortStream,
    checkMemoryBudget,
    ensureSingleBufferInputBudget,
    ensureStreamedPointBudget,
} from './loadBudget';

export {
    abortStream,
    checkMemoryBudget,
    ensureSingleBufferInputBudget,
    ensureStreamedPointBudget,
    estimateSingleBufferInputBytes,
    estimateVisiblePointBufferBytes,
} from './loadBudget';

export type FormatType = 'pcd' | 'ply' | 'las' | 'laz' | 'e57' | 'unknown';

export function detectFormat(filename?: string): FormatType {
    if (!filename) return 'pcd';
    switch ('.' + filename.toLowerCase().split('.').pop()) {
        case '.pcd': return 'pcd'; case '.ply': return 'ply';
        case '.las': return 'las'; case '.laz': return 'laz';
        case '.e57': return 'e57'; default: return 'unknown';
    }
}

export function shouldDeferInitialMemoryCheck(format: string): boolean {
    return format === 'pcd' || format === 'las' || format === 'ply' || format === 'laz' || format === 'e57';
}

export function shouldUseSingleBufferParser(format: string): boolean {
    return format === 'laz';
}

export function startStream(v: any, totalSize: number, filename?: string): void {
    v.streamFilename = filename; v.streamTotalSize = totalSize; v.streamLoadedSize = 0;
    v.streamAborted = false; v.pcdHeader = null; v.lasStream = null;
    v.leftoverChunk = null; v.pointsLoaded = 0; v.posIndex = 0;
    v.posBuffer = null; v.valBuffer = null; v.fullBuffer = null;
    v.rgbBuffer = null; v.fullBufferWriteOffset = 0; v.chunkList = [];
    v.pcdAsciiStream = null; v.plyStream = null;
    v.currentFormat = detectFormat(filename);
    if (v.loadingOverlay) {
        v.loadingOverlay.style.display = 'flex';
        v.loadingOverlay.innerHTML = '<div style="color:white;font-size:24px;font-family:sans-serif;background:rgba(0,0,0,0.8);padding:20px;border-radius:8px;">Preparing stream...</div>';
    }
}

export function parseHeader(v: any, headerStr: string): void {
    v.pcdHeader = parsePCDHeader(headerStr);
    console.log('Parsed Header:', v.pcdHeader);
}

export function processBinaryData(v: any, data: Uint8Array): void {
    if (!v.pcdHeader || !v.posBuffer) return;
    const state: PCDBinaryState = {
        posBuffer: v.posBuffer, valBuffer: v.valBuffer!, rgbBuffer: v.rgbBuffer,
        posIndex: v.posIndex, pointsLoaded: v.pointsLoaded,
        targetSampleRatio: v.targetSampleRatio, leftoverChunk: v.leftoverChunk,
    };
    processPCDBinaryChunk(data, v.pcdHeader, state);
    v.posIndex = state.posIndex; v.pointsLoaded = state.pointsLoaded; v.leftoverChunk = state.leftoverChunk;
}

function processLASChunkInternal(v: any, chunkData: Uint8Array): void {
    if (v.leftoverChunk) {
        const merged = new Uint8Array(v.leftoverChunk.byteLength + chunkData.byteLength);
        merged.set(v.leftoverChunk); merged.set(chunkData, v.leftoverChunk.byteLength);
        chunkData = merged; v.leftoverChunk = null;
    }
    if (!v.lasStream) {
        if (chunkData.byteLength < 227) { v.leftoverChunk = chunkData; return; }
        const view = new DataView(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength);
        if (String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !== 'LASF') throw new Error('Not a valid LAS file');
        const offsetToPointData = view.getUint32(96, true);
        if (chunkData.byteLength < offsetToPointData) { v.leftoverChunk = chunkData; return; }
        const meta = parseLASMetadata(chunkData.subarray(0, offsetToPointData));
        v.targetSampleRatio = computePointSampleRatio(meta.numberOfPoints, v.MAX_POINTS_VISUAL, v.streamTotalSize);
        const estimated = estimateSampledPointCount(meta.numberOfPoints, v.targetSampleRatio, v.MAX_POINTS_VISUAL);
        const needsRGB = meta.hasRGB && meta.rgbOffset !== -1;
        if (!ensureStreamedPointBudget(v, estimated, needsRGB, 'las', v.streamFilename)) return;
        v.posBuffer = new Float32Array(estimated * 3);
        v.valBuffer = new Float32Array(estimated);
        v.rgbBuffer = needsRGB ? new Uint8Array(estimated * 3) : null;
        v.lasStream = { ...meta, rawPointIndex: 0 };
        if (v.statusElement) v.statusElement.textContent = `Streaming: ~${estimated.toLocaleString()} pts`;
        chunkData = chunkData.subarray(meta.offsetToPointData);
        if (chunkData.byteLength === 0) return;
    }
    const posIndexRef = { value: v.posIndex };
    const leftoverRef = { value: v.leftoverChunk };
    processLASRecords(chunkData, v.lasStream, v.posBuffer, v.valBuffer, v.rgbBuffer, posIndexRef, v.targetSampleRatio, leftoverRef);
    v.posIndex = posIndexRef.value; v.leftoverChunk = leftoverRef.value;
    v.pointsLoaded = v.lasStream.rawPointIndex;
}

function processPLYChunkInternal(v: any, chunkData: Uint8Array): void {
    if (v.plyStream) {
        processPLYStreamChunk(v.plyStream, chunkData);
        v.pointsLoaded = v.plyStream.vertexIndex;
        return;
    }
    if (v.leftoverChunk) {
        const merged = new Uint8Array(v.leftoverChunk.byteLength + chunkData.byteLength);
        merged.set(v.leftoverChunk); merged.set(chunkData, v.leftoverChunk.byteLength);
        chunkData = merged; v.leftoverChunk = null;
    }

    const headerEnd = findPLYHeaderEnd(chunkData);
    if (headerEnd === -1) {
        if (chunkData.byteLength >= 100000) abortStream(v, 'Invalid PLY file: missing end_header');
        else v.leftoverChunk = chunkData;
        return;
    }

    const header = parsePLYStreamHeader(chunkData.subarray(0, headerEnd));
    const hasRGB = ('red' in header.propIndex && 'green' in header.propIndex && 'blue' in header.propIndex)
        || 'rgb' in header.propIndex;
    const sampleRatio = computePointSampleRatio(header.vertexCount, v.MAX_POINTS_VISUAL, v.streamTotalSize);
    const estimated = estimateSampledPointCount(header.vertexCount, sampleRatio, v.MAX_POINTS_VISUAL);
    if (!ensureStreamedPointBudget(v, estimated, hasRGB, 'ply', v.streamFilename)) return;
    v.plyStream = createPLYStreamState(header, v.MAX_POINTS_VISUAL, v.streamTotalSize);
    v.targetSampleRatio = v.plyStream.sampleRatio;
    if (v.statusElement) v.statusElement.textContent = `Streaming: ~${estimated.toLocaleString()} pts`;
    processPLYStreamChunk(v.plyStream, chunkData.subarray(header.dataStartByte));
    v.pointsLoaded = v.plyStream.vertexIndex;
}

export function processChunk(v: any, chunkData: Uint8Array, _offset: number): void {
    try {
        if (v.streamAborted) return;
        v.streamLoadedSize += chunkData.byteLength;
        const progress = v.streamTotalSize > 0 ? (v.streamLoadedSize / v.streamTotalSize) * 100 : 0;
        const pHtml = (pct: number) => `<div style="color:white;font-size:24px;font-family:sans-serif;background:rgba(0,0,0,0.8);padding:20px;border-radius:8px;">Loading: ${pct.toFixed(1)}%</div>`;
        if (v.currentFormat === 'las') {
            processLASChunkInternal(v, chunkData);
            if (!v.streamAborted && v.loadingOverlay) v.loadingOverlay.innerHTML = pHtml(progress);
            return;
        }
        if (v.currentFormat === 'ply') {
            processPLYChunkInternal(v, chunkData);
            if (!v.streamAborted && v.loadingOverlay) v.loadingOverlay.innerHTML = pHtml(progress);
            return;
        }
        if (v.currentFormat !== 'pcd') {
            const chunk = v.currentFormat === 'e57' ? chunkData : new Uint8Array(chunkData);
            v.chunkList.push(chunk); v.fullBufferWriteOffset += chunkData.byteLength;
            if (v.loadingOverlay) v.loadingOverlay.innerHTML = pHtml(progress);
            return;
        }
        if (!v.pcdHeader) {
            if (v.leftoverChunk) {
                const temp = new Uint8Array(v.leftoverChunk.byteLength + chunkData.byteLength);
                temp.set(v.leftoverChunk); temp.set(chunkData, v.leftoverChunk.byteLength);
                chunkData = temp; v.leftoverChunk = null;
            }
            const headerStr = new TextDecoder().decode(chunkData.slice(0, Math.min(chunkData.byteLength, 5000)));
            const headerEnd = headerStr.indexOf('DATA ');
            if (headerEnd !== -1) {
                const nlIdx = headerStr.indexOf('\n', headerEnd);
                if (nlIdx !== -1) {
                    parseHeader(v, headerStr.substring(0, nlIdx + 1));
                    if (v.pcdHeader!.data === 'binary') {
                        v.isBinary = true;
                        const totalPts = v.pcdHeader!.points;
                        v.targetSampleRatio = computePointSampleRatio(totalPts, v.MAX_POINTS_VISUAL, v.streamTotalSize);
                        const estimated = estimateSampledPointCount(totalPts, v.targetSampleRatio, v.MAX_POINTS_VISUAL);
                        const hasRGB = (v.pcdHeader!.offset['rgb'] !== undefined || v.pcdHeader!.offset['rgba'] !== undefined);
                        if (!ensureStreamedPointBudget(v, estimated, hasRGB, 'pcd', v.streamFilename)) return;
                        v.posBuffer = new Float32Array(estimated * 3);
                        v.valBuffer = new Float32Array(estimated);
                        v.rgbBuffer = hasRGB ? new Uint8Array(estimated * 3) : null;
                        if (v.statusElement) v.statusElement.textContent = `Streaming: ~${estimated.toLocaleString()} pts`;
                        processBinaryData(v, chunkData.subarray(v.pcdHeader!.headerLen));
                    } else if (v.pcdHeader!.data === 'ascii') {
                        v.isBinary = false;
                        const totalPts = v.pcdHeader!.points;
                        const sampleRatio = computePointSampleRatio(totalPts, v.MAX_POINTS_VISUAL, v.streamTotalSize);
                        const estimated = estimateSampledPointCount(totalPts, sampleRatio, v.MAX_POINTS_VISUAL);
                        const hasRGB = (v.pcdHeader!.offset['rgb'] !== undefined || v.pcdHeader!.offset['rgba'] !== undefined);
                        if (!ensureStreamedPointBudget(v, estimated, hasRGB, 'pcd', v.streamFilename)) return;
                        v.pcdAsciiStream = createPCDAsciiStreamState(v.pcdHeader!, v.MAX_POINTS_VISUAL, v.streamTotalSize);
                        v.targetSampleRatio = v.pcdAsciiStream.sampleRatio;
                        if (v.statusElement) v.statusElement.textContent = `Streaming: ~${estimated.toLocaleString()} pts`;
                        processPCDAsciiStreamChunk(v.pcdAsciiStream, chunkData.subarray(v.pcdHeader!.headerLen));
                    } else {
                        v.isBinary = false;
                        if (!checkMemoryBudget(v, v.streamTotalSize || chunkData.byteLength, 'pcd', v.streamFilename)) {
                            abortStream(v, `Cannot open ${v.streamFilename ? `"${v.streamFilename}"` : 'this ASCII PCD'}`); return;
                        }
                        v.fullBuffer = new Uint8Array(v.streamTotalSize);
                        v.fullBuffer.set(chunkData, 0);
                        v.fullBufferWriteOffset = chunkData.byteLength;
                    }
                } else { v.leftoverChunk = chunkData; }
            } else { v.leftoverChunk = chunkData; }
        } else if (v.isBinary) {
            if (v.leftoverChunk) {
                const temp = new Uint8Array(v.leftoverChunk.byteLength + chunkData.byteLength);
                temp.set(v.leftoverChunk); temp.set(chunkData, v.leftoverChunk.byteLength);
                v.leftoverChunk = null; processBinaryData(v, temp);
            } else { processBinaryData(v, chunkData); }
        } else if (v.pcdAsciiStream) {
            processPCDAsciiStreamChunk(v.pcdAsciiStream, chunkData);
            v.pointsLoaded = v.pcdAsciiStream.rawPointIndex;
        } else if (v.fullBuffer) {
            v.fullBuffer.set(chunkData, v.fullBufferWriteOffset);
            v.fullBufferWriteOffset += chunkData.byteLength;
        }
        if (!v.streamAborted && v.loadingOverlay) v.loadingOverlay.innerHTML = pHtml(progress);
    } catch (e) { console.error('Chunk processing failed', e); }
}

export function assembleChunkList(v: any): Uint8Array {
    if (v.chunkList.length === 0) return new Uint8Array(0);
    if (v.chunkList.length === 1) return v.chunkList[0];
    let total = 0;
    for (const c of v.chunkList) total += c.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of v.chunkList) { out.set(c, off); off += c.byteLength; }
    return out;
}

export function addLASOverlay(v: any, originLatLon: [number, number], bounds: LASBounds): void {
    v.removeItem('gnss');
    const sizeMeters = Math.max(Math.abs(bounds.maxX - bounds.minX), Math.abs(bounds.maxY - bounds.minY), 50);
    const latRad = originLatLon[0] * Math.PI / 180;
    const z = Math.max(1, Math.min(19, Math.round(Math.log2(40075016.686 * Math.cos(latRad) / Math.max(sizeMeters / 3, 20)))));
    const tileSide = 40075016.686 * Math.cos(latRad) / Math.pow(2, z);
    const tileRadius = Math.max(2, Math.min(6, Math.ceil(sizeMeters / tileSide) + 1));
    console.log(`GNSS overlay: zoom=${z}, tileRadius=${tileRadius}`);
    const gnss = new GNSSMapItem({ altitude: bounds.minZ - 0.1, zoom: z, tileRadius, alpha: 0.9, showTrailControls: false });
    gnss.renderCb = () => v.requestRender();
    gnss.addFix(originLatLon[0], originLatLon[1], 0);
    v.addItem('gnss', gnss);
    v.requestRender();
}

export async function finalizeStream(v: any): Promise<void> {
    console.log('Stream finished.');
    const onErr = (e: any) => {
        console.error('Finalize Error', e);
        const msg = e instanceof Error ? e.message : String(e);
        if (v.loadingOverlay) v.loadingOverlay.innerHTML = `<div style="color:white;font-size:24px;font-family:sans-serif;background:rgba(0,0,0,0.8);padding:20px;border-radius:8px;">Error: ${msg}</div>`;
    };
    try {
        if (v.streamAborted) return;
        if (v.currentFormat === 'las' && v.lasStream && v.posBuffer && v.valBuffer) {
            const pos = v.posBuffer.subarray(0, v.posIndex * 3);
            const val = v.valBuffer.subarray(0, v.posIndex);
            normalizeIntensity(val);
            v.renderPoints(pos, val, v.rgbBuffer ? v.rgbBuffer.subarray(0, v.posIndex * 3) : undefined);
            if (v.lasStream.originLatLon && v.lasStream.bounds) addLASOverlay(v, v.lasStream.originLatLon, v.lasStream.bounds);
            v.lasStream = null; v.leftoverChunk = null; v.posBuffer = null; v.valBuffer = null; v.rgbBuffer = null;
        } else if (v.currentFormat === 'ply' && v.plyStream) {
            const result = finalizePLYStreamState(v.plyStream);
            v.pointsLoaded = result.values.length;
            if (result.values.length > 0) normalizeIntensity(result.values as Float32Array);
            v.renderPoints(result.positions as Float32Array, result.values as Float32Array, result.rgb as Uint8Array | undefined);
            v.plyStream = null; v.leftoverChunk = null;
        } else if (v.currentFormat === 'e57') {
            const chunks = v.chunkList;
            if (chunks.length === 0) throw new Error('Empty E57 stream');
            console.log(`E57 chunked bytes: ${v.streamTotalSize || v.fullBufferWriteOffset}`);
            v.chunkList = []; v.fullBuffer = null;
            try {
                const r = await parseE57(chunks, v.MAX_POINTS_VISUAL, v.streamTotalSize || v.fullBufferWriteOffset);
                v.pointsLoaded = r.values.length;
                v.renderPoints(r.positions as Float32Array, r.values as Float32Array, r.rgb as Uint8Array | undefined);
            } catch (e) { onErr(e); }
        } else if (v.currentFormat === 'laz' || v.currentFormat === 'ply') {
            if (v.currentFormat === 'laz' && !ensureSingleBufferInputBudget(v, v.streamTotalSize || v.fullBufferWriteOffset, 'laz', v.streamFilename)) return;
            const assembled = assembleChunkList(v);
            if (assembled.byteLength === 0) throw new Error(`Empty ${v.currentFormat.toUpperCase()} stream`);
            console.log(`${v.currentFormat.toUpperCase()} assembled bytes: ${assembled.byteLength}`);
            if (v.currentFormat === 'ply') {
                const result = parsePLY(assembled, v.MAX_POINTS_VISUAL, v.streamTotalSize || assembled.byteLength);
                v.pointsLoaded = result.values.length;
                if (result.values.length > 0) normalizeIntensity(result.values as Float32Array);
                v.renderPoints(result.positions as Float32Array, result.values as Float32Array, result.rgb as Uint8Array | undefined);
            } else if (v.currentFormat === 'laz') {
                try {
                    const r = await parseLAZ(assembled, v.MAX_POINTS_VISUAL, v.streamTotalSize || assembled.byteLength);
                    v.pointsLoaded = r.values.length;
                    v.renderPoints(r.positions as Float32Array, r.values as Float32Array, r.rgb as Uint8Array | undefined);
                    if (r.originLatLon && r.bounds) addLASOverlay(v, r.originLatLon, r.bounds);
                } catch (e) { onErr(e); }
            } else {
                try {
                    const r = await parseE57(assembled, v.MAX_POINTS_VISUAL, v.streamTotalSize || assembled.byteLength);
                    v.pointsLoaded = r.values.length;
                    v.renderPoints(r.positions as Float32Array, r.values as Float32Array, r.rgb as Uint8Array | undefined);
                } catch (e) { onErr(e); }
            }
            v.chunkList = []; v.fullBuffer = null;
        } else if (v.isBinary && v.posBuffer) {
            const pos = v.posBuffer.subarray(0, v.posIndex * 3);
            const val = v.valBuffer!.subarray(0, v.posIndex);
            if (v.pcdHeader?.offset['intensity'] !== undefined) normalizeIntensity(val);
            v.renderPoints(pos, val, v.rgbBuffer ? v.rgbBuffer.subarray(0, v.posIndex * 3) : undefined);
            v.posBuffer = null; v.valBuffer = null; v.rgbBuffer = null;
        } else if (v.fullBuffer && v.pcdHeader?.data === 'ascii') {
            const result = parsePCDAscii(v.fullBuffer, v.pcdHeader, v.MAX_POINTS_VISUAL, v.streamTotalSize || v.fullBuffer.byteLength);
            v.pointsLoaded = result.values.length;
            if (getFieldSpec(v.pcdHeader, 'intensity')) normalizeIntensity(result.values as Float32Array);
            v.renderPoints(result.positions as Float32Array, result.values as Float32Array, result.rgb as Uint8Array | undefined);
            v.fullBuffer = null;
        } else if (v.pcdAsciiStream) {
            const result = finalizePCDAsciiStream(v.pcdAsciiStream);
            v.pointsLoaded = result.values.length;
            if (v.pcdHeader && getFieldSpec(v.pcdHeader, 'intensity')) normalizeIntensity(result.values as Float32Array);
            v.renderPoints(result.positions as Float32Array, result.values as Float32Array, result.rgb as Uint8Array | undefined);
            v.pcdAsciiStream = null;
        } else if (v.fullBuffer) {
            console.warn('binary_compressed PCD not supported in streaming mode.');
            if (v.loadingOverlay) v.loadingOverlay.innerHTML = '<div style="color:white;font-size:24px;font-family:sans-serif;background:rgba(0,0,0,0.8);padding:20px;border-radius:8px;">binary_compressed PCD is not supported.</div>';
            v.fullBuffer = null;
        }
    } catch (e: any) { onErr(e); }
}

export async function loadData(v: any, content: Uint8Array, filename?: string): Promise<void> {
    try {
        const fmt = detectFormat(filename);
        if (!shouldDeferInitialMemoryCheck(fmt) && !checkMemoryBudget(v, content.byteLength, fmt, filename)) return;
        v.removeItem('cloud');
        startStream(v, content.byteLength, filename);
        processChunk(v, content, 0);
        if (!v.streamAborted) await finalizeStream(v);
    } catch (err) { console.error('Error loading data:', err); }
}

export async function loadFile(v: any, file: File, append: boolean = false): Promise<void> {
    const ext = '.' + file.name.toLowerCase().split('.').pop();
    if (!v.constructor.SUPPORTED_EXTENSIONS?.includes(ext)) { console.warn(`Unsupported file type: ${file.name}`); return; }
    const fmt = detectFormat(file.name);
    if (!shouldDeferInitialMemoryCheck(fmt) && !checkMemoryBudget(v, file.size, fmt, file.name)) return;
    try {
        if (!append) v.removeItem('cloud');
        startStream(v, file.size, file.name);
        if (shouldUseSingleBufferParser(fmt)) {
            if (!ensureSingleBufferInputBudget(v, file.size, fmt, file.name)) return;
            const content = new Uint8Array(await file.arrayBuffer());
            v.streamLoadedSize = file.size;
            if (v.loadingOverlay) {
                v.loadingOverlay.style.display = 'flex';
                v.loadingOverlay.innerHTML = '<div style="color:white;font-size:24px;font-family:sans-serif;background:rgba(0,0,0,0.8);padding:20px;border-radius:8px;">Downsampling...</div>';
            }
            if (fmt === 'laz') {
                const result = await parseLAZ(content, v.MAX_POINTS_VISUAL, file.size);
                v.pointsLoaded = result.values.length;
                v.renderPoints(result.positions as Float32Array, result.values as Float32Array, result.rgb as Uint8Array | undefined);
                if (result.originLatLon && result.bounds) addLASOverlay(v, result.originLatLon, result.bounds);
            } else {
                const result = await parseE57(content, v.MAX_POINTS_VISUAL, file.size);
                v.pointsLoaded = result.values.length;
                v.renderPoints(result.positions as Float32Array, result.values as Float32Array, result.rgb as Uint8Array | undefined);
            }
            v.chunkList = []; v.fullBuffer = null;
            return;
        }
        // @ts-ignore
        const reader = file.stream().getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                processChunk(v, value, 0);
                if (v.streamAborted) { if (typeof reader.cancel === 'function') await reader.cancel(); break; }
                await new Promise(r => setTimeout(r, 0));
            }
        }
        if (!v.streamAborted) await finalizeStream(v);
    } catch (err) { console.error(`Error loading ${file.name}:`, err); }
}

export async function handleDrop(v: any, e: DragEvent): Promise<void> {
    if (!e.dataTransfer) return;
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) await loadFile(v, files[i], i > 0);
}

// Re-export THREE for cloudRenderer consumers
export { THREE };
