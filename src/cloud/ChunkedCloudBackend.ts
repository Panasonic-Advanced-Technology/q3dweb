import * as THREE from 'three';
import { AccumulationTarget } from './accumulationTarget';
import { CloudShaderCache, type CloudProgramLocations } from './cloudShaders';
import {
    allocateChunkDrawBudget,
    computeEquivalentAlpha,
    cullAndPrioritizeChunks,
    type ChunkCullMetadata,
    type VisibleChunkList,
} from './frustumCuller';
import type { CloudRenderStats, CloudRenderUniformSnapshot, QuantizedChunkData } from './types';

interface GpuChunkEntry {
    data: QuantizedChunkData;
    vbo: WebGLBuffer | null;
    vao: WebGLVertexArrayObject | null;
    uploaded: boolean;
}

const DEFAULT_INTERACTIVE_BUDGET = 12_000_000;
const MIN_INTERACTIVE_BUDGET = 1_000_000;
const MAX_INTERACTIVE_BUDGET = 24_000_000;
const DEFAULT_REFINE_BATCH_POINTS = 16_000_000;
const SIGNATURE_LEN = 26;

export class ChunkedCloudBackend {
    private gl: WebGLRenderingContext | null = null;
    private isWebGL2 = false;
    private shaders: CloudShaderCache | null = null;

    private chunks: GpuChunkEntry[] = [];
    private totalPoints = 0;
    private vramBytes = 0;
    private cpuPickBytes = 0;
    private valOffset = 0;
    private valScale = 1;

    // Flat SoA metadata for zero-allocation frustum culling
    private cullMeta: ChunkCullMetadata = ChunkedCloudBackend.emptyCullMeta();
    private cullMetaDirty = true;
    private visible: VisibleChunkList = {
        indices: new Int32Array(0),
        weights: new Float32Array(0),
        length: 0,
        totalVisiblePoints: 0,
    };
    private drawCounts = new Uint32Array(0);

    // Reusable math / signature buffers (zero per-frame GC)
    private readonly viewProj = new THREE.Matrix4();
    private readonly prevSignature = new Float64Array(SIGNATURE_LEN);
    private readonly currSignature = new Float64Array(SIGNATURE_LEN);
    private hasPrevSignature = false;

    // Adaptive point budgets
    interactivePointBudget = DEFAULT_INTERACTIVE_BUDGET;
    refineBatchPoints = DEFAULT_REFINE_BATCH_POINTS;
    private manualBudgetLock = false;
    private emaInteractiveFrameMs = 8.0;

    // Progressive zero-flicker accumulation state
    private readonly targets = new AccumulationTarget();
    private accumStarted = false;
    private accumComplete = false;
    private accumVisCursor = 0;
    private accumPointOffset = 0;
    private accumDrawnPoints = 0;
    private accumTotalPoints = 0;
    private needsRefineNextFrame = false;

    private lastStats: CloudRenderStats = {
        totalPoints: 0,
        chunkCount: 0,
        visibleChunks: 0,
        drawnPoints: 0,
        vramBytes: 0,
        cpuPickBytes: 0,
        interactivePointBudget: DEFAULT_INTERACTIVE_BUDGET,
        refinementProgress: 1,
        refinementComplete: true,
        lastFrameMs: 0,
        mode: 'direct',
    };

    setValueQuantization(valOffset: number, valScale: number): void {
        this.valOffset = valOffset;
        this.valScale = valScale > 0 ? valScale : 1;
    }

    addChunk(chunk: QuantizedChunkData, renderer?: THREE.WebGLRenderer): void {
        const entry: GpuChunkEntry = { data: chunk, vbo: null, vao: null, uploaded: false };
        this.chunks.push(entry);
        this.totalPoints += chunk.pointCount;
        this.cpuPickBytes += chunk.pickPositions.byteLength;
        this.cullMetaDirty = true;
        this.invalidateCache();

        if (renderer && this.ensureGl(renderer)) {
            this.uploadEntry(entry);
        }
    }

    getTotalPoints(): number {
        return this.totalPoints;
    }

    getChunkCount(): number {
        return this.chunks.length;
    }

    getChunks(): ReadonlyArray<QuantizedChunkData> {
        return this.chunks.map((c) => c.data);
    }

    getChunkAt(index: number): QuantizedChunkData | undefined {
        return this.chunks[index]?.data;
    }

    needsRefinement(): boolean {
        return this.needsRefineNextFrame;
    }

    invalidateCache(): void {
        this.hasPrevSignature = false;
        this.resetAccumulation();
    }

    setInteractiveBudgetLocked(budget: number): void {
        this.interactivePointBudget = Math.max(100_000, Math.floor(budget));
        this.manualBudgetLock = true;
        this.invalidateCache();
    }

    private adaptInteractiveBudget(frameMs: number): void {
        if (this.manualBudgetLock || frameMs <= 0) return;
        this.emaInteractiveFrameMs = this.emaInteractiveFrameMs * 0.8 + frameMs * 0.2;
        if (this.emaInteractiveFrameMs > 12.5) {
            this.interactivePointBudget = Math.max(
                MIN_INTERACTIVE_BUDGET,
                Math.floor(this.interactivePointBudget * 0.85),
            );
        } else if (this.emaInteractiveFrameMs < 5.5) {
            this.interactivePointBudget = Math.min(
                MAX_INTERACTIVE_BUDGET,
                Math.floor(this.interactivePointBudget * 1.12),
            );
        }
    }

    getStats(): CloudRenderStats {
        return { ...this.lastStats };
    }

    /**
     * Render the base Three.js scene and this point cloud cooperatively.
     * Returns true if the backend handled full frame presentation (including base scene).
     */
    renderFrame(
        renderer: THREE.WebGLRenderer,
        camera: THREE.PerspectiveCamera,
        uniforms: CloudRenderUniformSnapshot,
        renderBaseScene: (target: THREE.WebGLRenderTarget | null) => void,
    ): boolean {
        if (!this.ensureGl(renderer) || this.chunks.length === 0) {
            renderBaseScene(null);
            return false;
        }
        const gl = this.gl!;
        const t0 = performance.now();

        this.uploadPendingChunks();
        this.ensureCullMetadata();

        const width = gl.drawingBufferWidth || Math.max(renderer.domElement.width, 1);
        const height = gl.drawingBufferHeight || Math.max(renderer.domElement.height, 1);

        camera.updateMatrixWorld();
        cullAndPrioritizeChunks(this.cullMeta, camera, uniforms.viewportHeight || height, this.visible);

        const changed = this.updateSignature(camera, uniforms, width, height);
        const visPoints = this.visible.totalVisiblePoints;

        // Case 1: Fits completely within 1-frame interactive budget -> direct 100% full-quality draw
        if (visPoints <= this.interactivePointBudget) {
            this.resetAccumulation();
            this.needsRefineNextFrame = false;
            renderBaseScene(null);
            const drawn = this.drawVisibleDirect(renderer, camera, uniforms, visPoints, false);
            this.recordStats('direct', drawn, 1, true, performance.now() - t0);
            return true;
        }

        // Case 2: Camera or settings changed -> fast interactive LOD with alpha equivalence
        if (changed) {
            this.resetAccumulation();
            this.needsRefineNextFrame = true;
            renderBaseScene(null);
            const drawn = this.drawVisibleDirect(renderer, camera, uniforms, this.interactivePointBudget, true);
            const frameMs = performance.now() - t0;
            this.adaptInteractiveBudget(frameMs);
            this.recordStats('interactive', drawn, drawn / Math.max(visPoints, 1), false, frameMs);
            return true;
        }

        // Case 3a: Static camera & full accumulation already complete -> 0.1ms blit!
        if (this.accumComplete && this.targets.isReady()) {
            this.needsRefineNextFrame = false;
            this.targets.presentAccumulation(renderer);
            this.recordStats('cached', this.accumTotalPoints, 1, true, performance.now() - t0);
            return true;
        }

        // Case 3b: Static camera -> zero-flicker progressive full-quality accumulation
        this.targets.ensure(gl, this.isWebGL2, width, height);
        if (!this.targets.isReady()) {
            this.needsRefineNextFrame = false;
            renderBaseScene(null);
            const drawn = this.drawVisibleDirect(renderer, camera, uniforms, this.interactivePointBudget, true);
            this.recordStats('interactive', drawn, drawn / Math.max(visPoints, 1), false, performance.now() - t0);
            return true;
        }

        if (!this.accumStarted) {
            const previewFbo = this.targets.beginPreview(gl, renderBaseScene);
            this.drawVisibleIntoFbo(
                renderer,
                camera,
                uniforms,
                this.interactivePointBudget,
                true,
                previewFbo,
                this.targets.getWidth(),
                this.targets.getHeight(),
            );

            this.targets.beginAccumulation(gl, this.isWebGL2, renderer, renderBaseScene);
            this.accumStarted = true;
            this.accumVisCursor = 0;
            this.accumPointOffset = 0;
            this.accumDrawnPoints = 0;
            this.accumTotalPoints = visPoints;

            const pass0Budget = Math.max(2_000_000, Math.floor(this.refineBatchPoints * 0.4));
            this.drawAccumulationSlice(renderer, camera, uniforms, pass0Budget);
        } else {
            this.drawAccumulationSlice(renderer, camera, uniforms, this.refineBatchPoints);
        }

        const progress = this.accumTotalPoints > 0
            ? Math.min(1, this.accumDrawnPoints / this.accumTotalPoints)
            : 1;
        this.accumComplete = this.accumVisCursor >= this.visible.length;
        this.needsRefineNextFrame = !this.accumComplete;

        if (this.accumComplete) {
            this.targets.resolveAccumulation(gl, this.isWebGL2, renderer);
            this.targets.presentAccumulation(renderer);
        } else {
            this.targets.presentPreview(renderer);
        }
        this.recordStats(
            this.accumComplete ? 'cached' : 'refining',
            this.accumDrawnPoints,
            progress,
            this.accumComplete,
            performance.now() - t0,
        );
        return true;
    }

    dispose(): void {
        if (this.gl) {
            const gl = this.gl;
            const gl2 = this.isWebGL2 ? (gl as WebGL2RenderingContext) : null;
            for (const entry of this.chunks) {
                if (entry.vao && gl2) gl2.deleteVertexArray(entry.vao);
                if (entry.vbo) gl.deleteBuffer(entry.vbo);
                entry.vao = null;
                entry.vbo = null;
                entry.data.packedData = null;
            }
            this.shaders?.dispose();
        }
        this.targets.dispose(this.gl);
        this.shaders = null;
        this.chunks = [];
        this.totalPoints = 0;
        this.vramBytes = 0;
        this.cpuPickBytes = 0;
        this.resetAccumulation();
        this.gl = null;
    }

    private ensureGl(renderer: THREE.WebGLRenderer): boolean {
        if (this.gl && this.shaders) return true;
        const ctx = renderer.getContext?.() as WebGLRenderingContext | undefined;
        if (!ctx || typeof ctx.createBuffer !== 'function' || typeof ctx.createShader !== 'function') {
            return false;
        }
        this.gl = ctx;
        this.isWebGL2 = typeof (ctx as WebGL2RenderingContext).createVertexArray === 'function';
        this.shaders = new CloudShaderCache(ctx);
        return true;
    }

    private uploadPendingChunks(): void {
        for (let i = 0; i < this.chunks.length; i++) {
            const entry = this.chunks[i];
            if (!entry.uploaded && entry.data.packedData) {
                this.uploadEntry(entry);
            }
        }
    }

    private uploadEntry(entry: GpuChunkEntry): void {
        const gl = this.gl;
        const payload = entry.data.packedData;
        if (!gl || !payload) return;

        const vbo = gl.createBuffer();
        if (!vbo) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, payload, gl.STATIC_DRAW);

        let vao: WebGLVertexArrayObject | null = null;
        if (this.isWebGL2) {
            const gl2 = gl as WebGL2RenderingContext;
            vao = gl2.createVertexArray();
            if (vao) {
                gl2.bindVertexArray(vao);
                this.configureVertexAttributes(gl, entry.data);
                gl2.bindVertexArray(null);
            }
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        entry.vbo = vbo;
        entry.vao = vao;
        entry.uploaded = true;
        this.vramBytes += payload.byteLength;
        // Release CPU payload immediately after GPU upload to keep JS heap minimal!
        entry.data.packedData = null;
    }

    private configureVertexAttributes(gl: WebGLRenderingContext, data: QuantizedChunkData): void {
        const stride = data.strideBytes;
        gl.enableVertexAttribArray(0);
        if (data.isQuantized) {
            gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, true, stride, 0);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 1, gl.UNSIGNED_SHORT, true, stride, 6);
            if (data.hasRGB) {
                gl.enableVertexAttribArray(2);
                gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, stride, 8);
            } else {
                gl.disableVertexAttribArray(2);
            }
        } else {
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 12);
            if (data.hasRGB) {
                gl.enableVertexAttribArray(2);
                gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, stride, 16);
            } else {
                gl.disableVertexAttribArray(2);
            }
        }
    }

    private ensureCullMetadata(): void {
        if (!this.cullMetaDirty) return;
        const n = this.chunks.length;
        const meta: ChunkCullMetadata = {
            count: n,
            minX: new Float32Array(n),
            minY: new Float32Array(n),
            minZ: new Float32Array(n),
            maxX: new Float32Array(n),
            maxY: new Float32Array(n),
            maxZ: new Float32Array(n),
            centerX: new Float32Array(n),
            centerY: new Float32Array(n),
            centerZ: new Float32Array(n),
            radius: new Float32Array(n),
            pointCount: new Uint32Array(n),
        };
        for (let i = 0; i < n; i++) {
            const c = this.chunks[i].data;
            meta.minX[i] = c.bounds.minX; meta.minY[i] = c.bounds.minY; meta.minZ[i] = c.bounds.minZ;
            meta.maxX[i] = c.bounds.maxX; meta.maxY[i] = c.bounds.maxY; meta.maxZ[i] = c.bounds.maxZ;
            meta.centerX[i] = c.centerX; meta.centerY[i] = c.centerY; meta.centerZ[i] = c.centerZ;
            meta.radius[i] = c.radius;
            meta.pointCount[i] = c.pointCount;
        }
        this.cullMeta = meta;
        if (this.visible.indices.length < n) {
            this.visible.indices = new Int32Array(n);
            this.visible.weights = new Float32Array(n);
            this.drawCounts = new Uint32Array(n);
        }
        this.cullMetaDirty = false;
    }

    private drawVisibleDirect(
        renderer: THREE.WebGLRenderer,
        camera: THREE.PerspectiveCamera,
        uniforms: CloudRenderUniformSnapshot,
        budget: number,
        allowAlphaCompensation: boolean,
    ): number {
        const gl = this.gl!;
        const w = gl.drawingBufferWidth || Math.max(renderer.domElement.width, 1);
        const h = gl.drawingBufferHeight || Math.max(renderer.domElement.height, 1);
        renderer.setRenderTarget(null);
        return this.drawVisibleIntoFbo(renderer, camera, uniforms, budget, allowAlphaCompensation, null, w, h);
    }

    private drawVisibleIntoFbo(
        renderer: THREE.WebGLRenderer,
        camera: THREE.PerspectiveCamera,
        uniforms: CloudRenderUniformSnapshot,
        budget: number,
        allowAlphaCompensation: boolean,
        targetFbo: WebGLFramebuffer | null,
        viewportW: number,
        viewportH: number,
    ): number {
        if (this.visible.length === 0) return 0;
        const drawnTotal = allocateChunkDrawBudget(this.visible, this.cullMeta.pointCount, budget, this.drawCounts);
        const gl = this.gl!;
        const gl2 = this.isWebGL2 ? (gl as WebGL2RenderingContext) : null;

        renderer.resetState();
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
        gl.viewport(0, 0, viewportW, viewportH);
        gl.disable(gl.SCISSOR_TEST);
        this.setupGlBlendDepth(gl, uniforms.alpha);
        this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const worldSizeFactor = (uniforms.pointSize * 0.01) * (camera.projectionMatrix.elements[5] || 1) * Math.max(uniforms.viewportHeight, 1) * 0.5;

        let activeProg: CloudProgramLocations | null = null;
        let activeKey = -1;
        let lastAlpha = -1;

        for (let vi = 0; vi < this.visible.length; vi++) {
            const drawCount = this.drawCounts[vi];
            if (drawCount <= 0) continue;
            const entry = this.chunks[this.visible.indices[vi]];
            if (!entry.vbo) continue;

            const c = entry.data;
            const progKey = (c.isQuantized ? 2 : 0) | (c.hasRGB ? 1 : 0);
            if (progKey !== activeKey) {
                activeProg = this.shaders!.getProgram(uniforms.colorMode, uniforms.pointType, c.isQuantized, c.hasRGB);
                if (!activeProg) continue;
                activeKey = progKey;
                this.bindProgramCommonUniforms(gl, activeProg, uniforms, worldSizeFactor);
                lastAlpha = -1;
            }
            if (!activeProg) continue;

            const effAlpha = allowAlphaCompensation
                ? computeEquivalentAlpha(uniforms.alpha, drawCount / c.pointCount)
                : uniforms.alpha;
            if (Math.abs(effAlpha - lastAlpha) > 1e-4 && activeProg.uEffectiveAlpha) {
                gl.uniform1f(activeProg.uEffectiveAlpha, effAlpha);
                lastAlpha = effAlpha;
            }

            if (c.isQuantized) {
                gl.uniform3f(activeProg.uBoundsMin, c.bounds.minX, c.bounds.minY, c.bounds.minZ);
                gl.uniform3f(
                    activeProg.uBoundsSize,
                    c.bounds.maxX - c.bounds.minX,
                    c.bounds.maxY - c.bounds.minY,
                    c.bounds.maxZ - c.bounds.minZ,
                );
            }

            if (entry.vao && gl2) {
                gl2.bindVertexArray(entry.vao);
                gl.drawArrays(gl.POINTS, 0, drawCount);
            } else {
                gl.bindBuffer(gl.ARRAY_BUFFER, entry.vbo);
                this.configureVertexAttributes(gl, c);
                gl.drawArrays(gl.POINTS, 0, drawCount);
            }
        }

        if (gl2) gl2.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.useProgram(null);
        gl.depthMask(true);
        renderer.resetState();
        return drawnTotal;
    }

    private drawAccumulationSlice(
        renderer: THREE.WebGLRenderer,
        camera: THREE.PerspectiveCamera,
        uniforms: CloudRenderUniformSnapshot,
        sliceBudget: number,
    ): void {
        const gl = this.gl!;
        const gl2 = this.isWebGL2 ? (gl as WebGL2RenderingContext) : null;
        const drawFbo = this.targets.getDrawFbo();
        if (!drawFbo || this.accumVisCursor >= this.visible.length) return;

        renderer.resetState();
        gl.bindFramebuffer(gl.FRAMEBUFFER, drawFbo);
        gl.viewport(0, 0, this.targets.getWidth(), this.targets.getHeight());
        gl.disable(gl.SCISSOR_TEST);
        this.setupGlBlendDepth(gl, uniforms.alpha);
        this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const worldSizeFactor = (uniforms.pointSize * 0.01) * (camera.projectionMatrix.elements[5] || 1) * Math.max(uniforms.viewportHeight, 1) * 0.5;

        let activeProg: CloudProgramLocations | null = null;
        let activeKey = -1;
        let remaining = sliceBudget;

        while (remaining > 0 && this.accumVisCursor < this.visible.length) {
            const entry = this.chunks[this.visible.indices[this.accumVisCursor]];
            const c = entry.data;
            const avail = c.pointCount - this.accumPointOffset;
            if (!entry.vbo || avail <= 0) {
                this.accumVisCursor++;
                this.accumPointOffset = 0;
                continue;
            }

            const take = avail <= remaining ? avail : remaining;
            const progKey = (c.isQuantized ? 2 : 0) | (c.hasRGB ? 1 : 0);
            if (progKey !== activeKey) {
                activeProg = this.shaders!.getProgram(uniforms.colorMode, uniforms.pointType, c.isQuantized, c.hasRGB);
                if (!activeProg) break;
                activeKey = progKey;
                this.bindProgramCommonUniforms(gl, activeProg, uniforms, worldSizeFactor);
                if (activeProg.uEffectiveAlpha) gl.uniform1f(activeProg.uEffectiveAlpha, uniforms.alpha);
            }
            if (!activeProg) break;

            if (c.isQuantized) {
                gl.uniform3f(activeProg.uBoundsMin, c.bounds.minX, c.bounds.minY, c.bounds.minZ);
                gl.uniform3f(
                    activeProg.uBoundsSize,
                    c.bounds.maxX - c.bounds.minX,
                    c.bounds.maxY - c.bounds.minY,
                    c.bounds.maxZ - c.bounds.minZ,
                );
            }

            if (entry.vao && gl2) {
                gl2.bindVertexArray(entry.vao);
                gl.drawArrays(gl.POINTS, this.accumPointOffset, take);
            } else {
                gl.bindBuffer(gl.ARRAY_BUFFER, entry.vbo);
                this.configureVertexAttributes(gl, c);
                gl.drawArrays(gl.POINTS, this.accumPointOffset, take);
            }

            this.accumPointOffset += take;
            this.accumDrawnPoints += take;
            remaining -= take;
            if (this.accumPointOffset >= c.pointCount) {
                this.accumVisCursor++;
                this.accumPointOffset = 0;
            }
        }

        if (gl2) gl2.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.useProgram(null);
        gl.depthMask(true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        renderer.resetState();
    }

    private setupGlBlendDepth(gl: WebGLRenderingContext, alpha: number): void {
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        if (alpha < 0.99) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        } else {
            gl.disable(gl.BLEND);
        }
    }

    private bindProgramCommonUniforms(
        gl: WebGLRenderingContext,
        prog: CloudProgramLocations,
        u: CloudRenderUniformSnapshot,
        worldSizeFactor: number,
    ): void {
        gl.useProgram(prog.program);
        gl.uniformMatrix4fv(prog.uViewProj, false, this.viewProj.elements);
        if (prog.uValOffset) gl.uniform1f(prog.uValOffset, this.valOffset);
        if (prog.uValScale) gl.uniform1f(prog.uValScale, this.valScale);
        if (prog.uVMin) gl.uniform1f(prog.uVMin, u.vmin);
        if (prog.uVMax) gl.uniform1f(prog.uVMax, u.vmax);
        if (prog.uPointSize) gl.uniform1f(prog.uPointSize, u.pointSize);
        if (prog.uWorldSizeFactor) gl.uniform1f(prog.uWorldSizeFactor, worldSizeFactor);
        if (prog.uFlatColor) gl.uniform3f(prog.uFlatColor, u.flatR, u.flatG, u.flatB);
    }

    private resetAccumulation(): void {
        this.accumStarted = false;
        this.accumComplete = false;
        this.accumVisCursor = 0;
        this.accumPointOffset = 0;
        this.accumDrawnPoints = 0;
        this.accumTotalPoints = 0;
    }

    private updateSignature(
        camera: THREE.PerspectiveCamera,
        u: CloudRenderUniformSnapshot,
        width: number,
        height: number,
    ): boolean {
        const s = this.currSignature;
        const m = camera.matrixWorldInverse.elements;
        for (let i = 0; i < 16; i++) s[i] = m[i];
        s[16] = camera.projectionMatrix.elements[5];
        s[17] = u.pointSize;
        s[18] = u.alpha;
        s[19] = u.vmin;
        s[20] = u.vmax;
        s[21] = u.colorMode;
        s[22] = u.pointType;
        s[23] = u.flatR * 65536 + u.flatG * 256 + u.flatB;
        s[24] = width;
        s[25] = height;

        let changed = !this.hasPrevSignature;
        if (!changed) {
            const p = this.prevSignature;
            for (let i = 0; i < SIGNATURE_LEN; i++) {
                if (Math.abs(s[i] - p[i]) > 1e-6) {
                    changed = true;
                    break;
                }
            }
        }
        this.prevSignature.set(s);
        this.hasPrevSignature = true;
        return changed;
    }

    private recordStats(
        mode: CloudRenderStats['mode'],
        drawnPoints: number,
        refinementProgress: number,
        refinementComplete: boolean,
        lastFrameMs: number,
    ): void {
        this.lastStats = {
            totalPoints: this.totalPoints,
            chunkCount: this.chunks.length,
            visibleChunks: this.visible.length,
            drawnPoints,
            vramBytes: this.vramBytes,
            cpuPickBytes: this.cpuPickBytes,
            interactivePointBudget: this.interactivePointBudget,
            refinementProgress,
            refinementComplete,
            lastFrameMs,
            mode,
        };
    }

    private static emptyCullMeta(): ChunkCullMetadata {
        return {
            count: 0,
            minX: new Float32Array(0),
            minY: new Float32Array(0),
            minZ: new Float32Array(0),
            maxX: new Float32Array(0),
            maxY: new Float32Array(0),
            maxZ: new Float32Array(0),
            centerX: new Float32Array(0),
            centerY: new Float32Array(0),
            centerZ: new Float32Array(0),
            radius: new Float32Array(0),
            pointCount: new Uint32Array(0),
        };
    }
}
