import * as THREE from 'three';
import { Viewer } from './viewer';
import { CloudItem } from './items/CloudItem';
import { AxisItem } from './items/AxisItem';

interface PointFieldJson {
    name: string;
    offset: number;
    datatype: number;
    count: number;
}

interface DecodedCloudChunk {
    positions: Float32Array;
    values: Float32Array;
    rgb?: Uint8Array;
    maxAccumulatedPoints: number;
}

interface PointCloud2Json {
    height: number;
    width: number;
    fields: PointFieldJson[];
    is_bigendian: boolean;
    point_step: number;
    row_step: number;
    data: string;
    is_dense: boolean;
}

interface RosbridgePublishMessage {
    op?: string;
    topic?: string;
    msg?: unknown;
}

interface RealtimeTopicOptions {
    topicName?: string;
    cloudTopicName?: string;
    odomTopicName?: string;
    maxPointsPerScan?: number;
    maxAccumulatedPoints?: number;
    autoFitOnFirstChunk?: boolean;
}

const PF_INT8 = 1;
const PF_UINT8 = 2;
const PF_INT16 = 3;
const PF_UINT16 = 4;
const PF_INT32 = 5;
const PF_UINT32 = 6;
const PF_FLOAT32 = 7;
const PF_FLOAT64 = 8;

class NativeLikeMapCloud {
    private static readonly CAPACITY_STEP = 1_000_000;
    private gl: WebGLRenderingContext | null = null;
    private program: WebGLProgram | null = null;
    private vbo: WebGLBuffer | null = null;
    private aPosition = -1;
    private aValue = -1;
    private uView: WebGLUniformLocation | null = null;
    private uProj: WebGLUniformLocation | null = null;
    private uVMin: WebGLUniformLocation | null = null;
    private uVMax: WebGLUniformLocation | null = null;
    private uPointSize: WebGLUniformLocation | null = null;
    private uColorMode: WebGLUniformLocation | null = null;
    private uFlatColor: WebGLUniformLocation | null = null;
    private uAlpha: WebGLUniformLocation | null = null;
    private cpuBuffer = new Float32Array(0);
    private capacityPoints = 0;
    private pointCount = 0;
    private maxPoints = 5_000_000;
    private dirtyUploadedPoints = 0;

    reset(maxPoints: number): void {
        this.maxPoints = Math.max(1, Math.floor(maxPoints));
        this.pointCount = 0;
        this.dirtyUploadedPoints = 0;
    }

    getPointCount(): number {
        return this.pointCount;
    }

    getLastDirtyUploadedPoints(): number {
        return this.dirtyUploadedPoints;
    }

    append(
        renderer: THREE.WebGLRenderer,
        positions: Float32Array,
        values: Float32Array,
        maxPoints: number,
    ): void {
        if (positions.length !== values.length * 3) return;
        if (values.length === 0) return;

        this.maxPoints = Math.max(1, Math.floor(maxPoints));
        this.ensureInitialized(renderer);
        if (!this.gl || !this.vbo) return;

        let appendPos = positions;
        let appendVal = values;

        while (appendVal.length > Math.floor(this.maxPoints * 0.9) && appendVal.length > 1) {
            const halfCount = Math.ceil(appendVal.length / 2);
            const nextPos = new Float32Array(halfCount * 3);
            const nextVal = new Float32Array(halfCount);
            let w = 0;
            for (let r = 0; r < appendVal.length; r += 2) {
                const rp = r * 3;
                const wp = w * 3;
                nextPos[wp] = appendPos[rp];
                nextPos[wp + 1] = appendPos[rp + 1];
                nextPos[wp + 2] = appendPos[rp + 2];
                nextVal[w] = appendVal[r];
                w++;
            }
            appendPos = nextPos;
            appendVal = nextVal;
        }

        this.ensureCapacity(Math.min(this.maxPoints, this.pointCount + appendVal.length));
        if (!this.vbo) return;

        let didDownsample = false;
        while (this.pointCount > 1 && this.pointCount + appendVal.length > this.capacityPoints) {
            this.downsampleExistingHalfInPlace();
            didDownsample = true;
        }

        let currentCount = this.pointCount;
        if (appendVal.length > this.capacityPoints) {
            const keep = this.capacityPoints;
            const srcStart = appendVal.length - keep;
            appendVal = appendVal.subarray(srcStart);
            appendPos = appendPos.subarray(srcStart * 3);
            currentCount = 0;
            didDownsample = true;
        }

        for (let i = 0; i < appendVal.length; i++) {
            const srcPos = i * 3;
            const dstPoint = currentCount + i;
            const dst = dstPoint * 4;
            this.cpuBuffer[dst] = appendPos[srcPos];
            this.cpuBuffer[dst + 1] = appendPos[srcPos + 1];
            this.cpuBuffer[dst + 2] = appendPos[srcPos + 2];
            this.cpuBuffer[dst + 3] = appendVal[i];
        }

        this.pointCount = currentCount + appendVal.length;

        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        if (didDownsample || currentCount === 0) {
            const uploaded = this.cpuBuffer.subarray(0, this.pointCount * 4);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, uploaded);
            this.dirtyUploadedPoints = this.pointCount;
        } else {
            const dstStart = currentCount * 4;
            const uploaded = this.cpuBuffer.subarray(dstStart, (currentCount + appendVal.length) * 4);
            gl.bufferSubData(gl.ARRAY_BUFFER, currentCount * 16, uploaded);
            this.dirtyUploadedPoints = appendVal.length;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    draw(
        renderer: THREE.WebGLRenderer,
        camera: THREE.PerspectiveCamera,
        colorMode: 'FLAT' | 'I' | 'RGB',
        dataMin: number,
        dataMax: number,
        pointSize: number,
        alpha: number,
    ): void {
        if (this.pointCount <= 0) return;
        if (colorMode === 'RGB') return; // native path currently supports intensity/flat only.

        this.ensureInitialized(renderer);
        if (!this.gl || !this.program || !this.vbo) return;

        const gl = this.gl;
        const view = camera.matrixWorldInverse.elements;
        const proj = camera.projectionMatrix.elements;
        const widthPx = renderer.domElement.width;

        renderer.resetState();

        gl.enable(gl.DEPTH_TEST);
        if (alpha < 0.99) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
        } else {
            gl.disable(gl.BLEND);
            gl.depthMask(true);
        }

        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.uView, false, view as unknown as Float32List);
        gl.uniformMatrix4fv(this.uProj, false, proj as unknown as Float32List);
        gl.uniform1f(this.uVMin, dataMin);
        gl.uniform1f(this.uVMax, dataMax);
        gl.uniform1f(this.uPointSize, pointSize);
        gl.uniform1f(this.uColorMode, colorMode === 'FLAT' ? 2 : 0);
        gl.uniform3f(this.uFlatColor, 1, 1, 1);
        gl.uniform1f(this.uAlpha, alpha);
        void widthPx;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.enableVertexAttribArray(this.aPosition);
        gl.enableVertexAttribArray(this.aValue);
        gl.vertexAttribPointer(this.aPosition, 3, gl.FLOAT, false, 16, 0);
        gl.vertexAttribPointer(this.aValue, 1, gl.FLOAT, false, 16, 12);
        gl.drawArrays(gl.POINTS, 0, this.pointCount);
        gl.disableVertexAttribArray(this.aPosition);
        gl.disableVertexAttribArray(this.aValue);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.useProgram(null);
        gl.depthMask(true);

        renderer.resetState();
    }

    private ensureInitialized(renderer: THREE.WebGLRenderer): void {
        if (this.gl && this.program && this.vbo) return;

        this.gl = renderer.getContext();
        const gl = this.gl;

        if (!this.program) {
            const vertSrc = `
                attribute vec3 aPosition;
                attribute float aValue;
                uniform mat4 uView;
                uniform mat4 uProj;
                uniform float uVMin;
                uniform float uVMax;
                uniform float uPointSize;
                uniform float uColorMode;
                uniform vec3 uFlatColor;
                varying vec3 vColor;

                vec3 rainbow(float x) {
                    float t = clamp((x - uVMin) / max(uVMax - uVMin, 1e-6), 0.0, 1.0);
                    float h = t * 0.6666;
                    vec3 K = vec3(1.0, 2.0 / 3.0, 1.0 / 3.0);
                    vec3 p = abs(fract(vec3(h) + K) * 6.0 - vec3(3.0));
                    return clamp(p - vec3(1.0), 0.0, 1.0);
                }

                void main() {
                    vec3 c = rainbow(aValue);
                    if (uColorMode > 1.5) c = uFlatColor;
                    vColor = c;
                    vec4 mv = uView * vec4(aPosition, 1.0);
                    gl_Position = uProj * mv;
                    gl_PointSize = uPointSize;
                }
            `;
            const fragSrc = `
                precision mediump float;
                varying vec3 vColor;
                uniform float uAlpha;
                void main() {
                    gl_FragColor = vec4(vColor, uAlpha);
                }
            `;

            const vert = this.compileShader(gl, gl.VERTEX_SHADER, vertSrc);
            const frag = this.compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
            const program = gl.createProgram();
            if (!vert || !frag || !program) return;
            gl.attachShader(program, vert);
            gl.attachShader(program, frag);
            gl.linkProgram(program);
            gl.deleteShader(vert);
            gl.deleteShader(frag);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                gl.deleteProgram(program);
                return;
            }
            this.program = program;
            this.aPosition = gl.getAttribLocation(program, 'aPosition');
            this.aValue = gl.getAttribLocation(program, 'aValue');
            this.uView = gl.getUniformLocation(program, 'uView');
            this.uProj = gl.getUniformLocation(program, 'uProj');
            this.uVMin = gl.getUniformLocation(program, 'uVMin');
            this.uVMax = gl.getUniformLocation(program, 'uVMax');
            this.uPointSize = gl.getUniformLocation(program, 'uPointSize');
            this.uColorMode = gl.getUniformLocation(program, 'uColorMode');
            this.uFlatColor = gl.getUniformLocation(program, 'uFlatColor');
            this.uAlpha = gl.getUniformLocation(program, 'uAlpha');
        }

        if (!this.vbo) {
            this.vbo = gl.createBuffer();
        }

        this.ensureCapacity(Math.min(this.maxPoints, NativeLikeMapCloud.CAPACITY_STEP));
    }

    private ensureCapacity(requiredPoints: number): void {
        if (!this.gl || !this.vbo) return;
        if (requiredPoints <= this.capacityPoints) return;

        let next = Math.max(this.capacityPoints, NativeLikeMapCloud.CAPACITY_STEP);
        while (next < requiredPoints && next < this.maxPoints) {
            next += NativeLikeMapCloud.CAPACITY_STEP;
        }
        next = Math.min(next, this.maxPoints);
        if (next <= this.capacityPoints) return;

        const nextCpu = new Float32Array(next * 4);
        if (this.pointCount > 0 && this.cpuBuffer.length > 0) {
            nextCpu.set(this.cpuBuffer.subarray(0, this.pointCount * 4), 0);
        }
        this.cpuBuffer = nextCpu;
        this.capacityPoints = next;

        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.capacityPoints * 16, gl.DYNAMIC_DRAW);
        if (this.pointCount > 0) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cpuBuffer.subarray(0, this.pointCount * 4));
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    private downsampleExistingHalfInPlace(): void {
        if (this.pointCount <= 1) return;
        let write = 0;
        for (let read = 0; read < this.pointCount; read += 2) {
            const src = read * 4;
            const dst = write * 4;
            this.cpuBuffer[dst] = this.cpuBuffer[src];
            this.cpuBuffer[dst + 1] = this.cpuBuffer[src + 1];
            this.cpuBuffer[dst + 2] = this.cpuBuffer[src + 2];
            this.cpuBuffer[dst + 3] = this.cpuBuffer[src + 3];
            write++;
        }
        this.pointCount = write;
    }

    private compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }
}

/**
 * RealtimeViewer extends Viewer with ROS PointCloud2 realtime ingestion.
 * It is optimized for streaming append workloads instead of one-shot file loads.
 */
export class RealtimeViewer extends Viewer {
    private rosSocket: WebSocket | null = null;
    private cloudTopicName: string = '/cloud_registered';
    private odomTopicName: string = '/odometry';
    private maxPointsPerScan: number = 1500;
    private mapColorMode: 'FLAT' | 'I' | 'RGB' | null = null;
    private perfLastReportTs = performance.now();
    private perfDecodeMsSum = 0;
    private perfDecodeMsMax = 0;
    private perfAppendMsSum = 0;
    private perfAppendMsMax = 0;
    private perfApplyMsSum = 0;
    private perfApplyMsMax = 0;
    private perfDrawMsSum = 0;
    private perfDrawMsMax = 0;
    private perfRenderMsSum = 0;
    private perfRenderMsMax = 0;
    private perfChunkCount = 0;
    private perfRenderCount = 0;
    private perfDirtyPointsSum = 0;
    private readonly maxQueuedChunks = 4;
    private readonly maxApplyChunksPerCommit = 4;
    private readonly mapUpdateIntervalMs = 80;
    private lastMapUpdateTs = 0;
    private readonly scanUpdateIntervalMs = 120;
    private lastScanUpdateTs = 0;
    private pendingChunks: DecodedCloudChunk[] = [];
    private pendingScanChunk: DecodedCloudChunk | null = null;
    private readonly nativeMap = new NativeLikeMapCloud();
    private nativeDataMin = Number.POSITIVE_INFINITY;
    private nativeDataMax = Number.NEGATIVE_INFINITY;
    private readonly scanItemName = 'scan';
    private readonly odomItemName = 'odom';

    constructor(containerId: string) {
        super(containerId);
        this.setupRealtimeItems();
    }

    setRealtimeOptions(options: RealtimeTopicOptions): void {
        const cloudTopic = options.cloudTopicName ?? options.topicName;
        if (cloudTopic) this.cloudTopicName = cloudTopic;
        if (options.odomTopicName) this.odomTopicName = options.odomTopicName;
        if (typeof options.maxPointsPerScan === 'number' && options.maxPointsPerScan > 0) {
            this.maxPointsPerScan = Math.floor(options.maxPointsPerScan);
        }
        if (typeof options.maxAccumulatedPoints === 'number' && options.maxAccumulatedPoints > 0) {
            this.realtimeMaxPoints = Math.floor(options.maxAccumulatedPoints);
        }
    }

    connectRosbridge(wsUrl: string, options: RealtimeTopicOptions = {}): void {
        this.setRealtimeOptions(options);
        this.mapColorMode = null;
        this.pendingChunks = [];
        this.pendingScanChunk = null;
        this.lastMapUpdateTs = 0;
        this.lastScanUpdateTs = 0;
        this.nativeMap.reset(this.realtimeMaxPoints);
        this.nativeDataMin = Number.POSITIVE_INFINITY;
        this.nativeDataMax = Number.NEGATIVE_INFINITY;

        if (this.rosSocket && this.rosSocket.readyState <= WebSocket.OPEN) {
            this.disconnectRosbridge();
        }

        const socket = new WebSocket(wsUrl);
        this.rosSocket = socket;

        socket.addEventListener('open', () => {
            const cloudSubscribe = {
                op: 'subscribe',
                topic: this.cloudTopicName,
                type: 'sensor_msgs/PointCloud2',
                queue_length: 1,
                throttle_rate: 0,
            };
            const odomSubscribe = {
                op: 'subscribe',
                topic: this.odomTopicName,
                type: 'nav_msgs/Odometry',
                queue_length: 1,
                throttle_rate: 0,
            };
            socket.send(JSON.stringify(cloudSubscribe));
            socket.send(JSON.stringify(odomSubscribe));
        });

        socket.addEventListener('message', (event: MessageEvent<string>) => {
            this.onRosbridgeMessage(event.data, options);
        });

        socket.addEventListener('close', () => {
            if (this.rosSocket === socket) this.rosSocket = null;
        });

        socket.addEventListener('error', (err) => {
            console.error('rosbridge websocket error:', err);
        });
    }

    disconnectRosbridge(): void {
        if (!this.rosSocket) return;

        if (this.rosSocket.readyState === WebSocket.OPEN) {
            this.rosSocket.send(JSON.stringify({ op: 'unsubscribe', topic: this.cloudTopicName }));
            this.rosSocket.send(JSON.stringify({ op: 'unsubscribe', topic: this.odomTopicName }));
        }
        this.rosSocket.close();
        this.rosSocket = null;
    }

    ingestPointCloud2(pointCloud2: PointCloud2Json, options: RealtimeTopicOptions = {}): void {
        if (this.mapColorMode === null) {
            this.mapColorMode = inferColorModeFromFields(pointCloud2.fields);
        }

        const decodeStart = performance.now();
        const decoded = decodePointCloud2(
            pointCloud2,
            options.maxPointsPerScan ?? this.maxPointsPerScan,
            this.mapColorMode,
        );
        const decodeMs = performance.now() - decodeStart;
        this.perfDecodeMsSum += decodeMs;
        this.perfDecodeMsMax = Math.max(this.perfDecodeMsMax, decodeMs);
        if (!decoded) return;

        const maxAccumulatedPoints = options.maxAccumulatedPoints ?? this.realtimeMaxPoints;
        const chunk: DecodedCloudChunk = {
            positions: decoded.positions,
            values: decoded.values,
            rgb: decoded.rgb,
            maxAccumulatedPoints,
        };

        if (this.pendingChunks.length >= this.maxQueuedChunks) {
            this.pendingChunks.shift();
        }
        this.pendingChunks.push(chunk);
        this.pendingScanChunk = chunk;

        this.requestRender();
    }

    override render(): void {
        const start = performance.now();
        const applyStart = performance.now();
        this.applyPendingCloudUpdates();
        const applyMs = performance.now() - applyStart;
        this.perfApplyMsSum += applyMs;
        this.perfApplyMsMax = Math.max(this.perfApplyMsMax, applyMs);

        const drawStart = performance.now();
        super.render();
        if (this.mapColorMode) {
            this.nativeMap.draw(
                this.renderer,
                this.camera,
                this.mapColorMode,
                Number.isFinite(this.nativeDataMin) ? this.nativeDataMin : 0,
                Number.isFinite(this.nativeDataMax) ? this.nativeDataMax : 255,
                1,
                1,
            );
        }
        const drawMs = performance.now() - drawStart;
        this.perfDrawMsSum += drawMs;
        this.perfDrawMsMax = Math.max(this.perfDrawMsMax, drawMs);

        const ms = performance.now() - start;
        this.perfRenderMsSum += ms;
        this.perfRenderMsMax = Math.max(this.perfRenderMsMax, ms);
        this.perfRenderCount++;
        this.reportRealtimePerfIfNeeded();

        if (this.pendingChunks.length > 0 || this.pendingScanChunk) {
            this.requestRender();
        }
    }

    private onRosbridgeMessage(rawData: string, options: RealtimeTopicOptions): void {
        let payload: RosbridgePublishMessage;
        try {
            payload = JSON.parse(rawData) as RosbridgePublishMessage;
        } catch {
            return;
        }

        if (payload.op !== 'publish' || !payload.topic || !payload.msg) {
            return;
        }

        if (payload.topic === this.cloudTopicName) {
            const pointCloud2 = payload.msg as PointCloud2Json;
            this.ingestPointCloud2(pointCloud2, options);
            return;
        }

        if (payload.topic === this.odomTopicName) {
            this.ingestOdometry(payload.msg as OdomJson);
        }
    }

    private setupRealtimeItems(): void {
        if (!(this.items[this.scanItemName] instanceof CloudItem)) {
            const scan = new CloudItem(
                new Float32Array(0),
                new Float32Array(0),
                {
                    size: 2,
                    alpha: 1,
                    colorMode: 'FLAT',
                    color: '#ffffff',
                },
            );
            this.addItem(this.scanItemName, scan);
        }

        if (!(this.items[this.odomItemName] instanceof AxisItem)) {
            const odom = new AxisItem({ size: 0.5, width: 5 });
            this.addItem(this.odomItemName, odom);
        }
    }

    private ingestOdometry(msg: OdomJson): void {
        const odom = this.items[this.odomItemName];
        if (!(odom instanceof AxisItem)) return;

        const p = msg?.pose?.pose?.position;
        const q = msg?.pose?.pose?.orientation;
        if (!p || !q) return;

        const t = new THREE.Vector3(p.x ?? 0, p.y ?? 0, p.z ?? 0);
        const quat = new THREE.Quaternion(q.x ?? 0, q.y ?? 0, q.z ?? 0, q.w ?? 1).normalize();
        const matrix = new THREE.Matrix4().compose(t, quat, new THREE.Vector3(1, 1, 1));
        odom.setTransform(matrix);
        this.requestRender();
    }

    private applyPendingCloudUpdates(): void {
        if (this.pendingChunks.length === 0 && !this.pendingScanChunk) return;

        this.setupRealtimeItems();
        const scan = this.items[this.scanItemName] as CloudItem | undefined;
        if (!(scan instanceof CloudItem)) return;

        let lastScanCount = 0;
        const chunkToScan = this.pendingScanChunk;
        const now = performance.now();
        const shouldUpdateScan = !!chunkToScan &&
            (now - this.lastScanUpdateTs >= this.scanUpdateIntervalMs || this.pendingChunks.length === 0);
        if (chunkToScan && shouldUpdateScan) {
            scan.replacePoints(chunkToScan.positions, chunkToScan.values, undefined);
            lastScanCount = chunkToScan.values.length;
            this.pendingScanChunk = null;
            this.lastScanUpdateTs = now;
        }

        let applied = 0;
        const shouldCommitMap = this.pendingChunks.length > 0 &&
            (now - this.lastMapUpdateTs >= this.mapUpdateIntervalMs || this.pendingChunks.length >= this.maxQueuedChunks);

        if (shouldCommitMap) {
            while (applied < this.maxApplyChunksPerCommit && this.pendingChunks.length > 0) {
                const chunk = this.pendingChunks.shift();
                if (!chunk) break;

                const appendStart = performance.now();
                this.nativeMap.append(this.renderer, chunk.positions, chunk.values, chunk.maxAccumulatedPoints);
                const appendMs = performance.now() - appendStart;
                this.perfAppendMsSum += appendMs;
                this.perfAppendMsMax = Math.max(this.perfAppendMsMax, appendMs);
                this.perfDirtyPointsSum += this.nativeMap.getLastDirtyUploadedPoints();

                for (let i = 0; i < chunk.values.length; i++) {
                    const v = chunk.values[i];
                    if (v < this.nativeDataMin) this.nativeDataMin = v;
                    if (v > this.nativeDataMax) this.nativeDataMax = v;
                }
                this.perfChunkCount++;
                applied++;
                lastScanCount = chunk.values.length;
            }
            this.lastMapUpdateTs = now;
        }

        if (applied > 0 && this.statusElement) {
            this.statusElement.textContent =
                `Map: ${this.nativeMap.getPointCount().toLocaleString()} pts | Scan: ${lastScanCount.toLocaleString()} pts`;
        }
    }

    private reportRealtimePerfIfNeeded(): void {
        const now = performance.now();
        if (now - this.perfLastReportTs < 1000) return;
        if (this.perfChunkCount === 0 && this.perfRenderCount === 0) {
            this.perfLastReportTs = now;
            return;
        }

        const applyAvg = this.perfRenderCount > 0 ? this.perfApplyMsSum / this.perfRenderCount : 0;
        const drawAvg = this.perfRenderCount > 0 ? this.perfDrawMsSum / this.perfRenderCount : 0;
        const renderAvg = this.perfRenderCount > 0 ? this.perfRenderMsSum / this.perfRenderCount : 0;
        const dirtyAvg = this.perfChunkCount > 0 ? this.perfDirtyPointsSum / this.perfChunkCount : 0;
        const applyPart = `apply(ms) avg=${applyAvg.toFixed(2)} max=${this.perfApplyMsMax.toFixed(2)} `;
        const drawPart = `draw(ms) avg=${drawAvg.toFixed(2)} max=${this.perfDrawMsMax.toFixed(2)} `;

        console.info(
            `[realtime-perf] chunks=${this.perfChunkCount} ` +
            applyPart +
            drawPart +
            `dirty(avg points)=${dirtyAvg.toFixed(0)} ` +
            `render_total(ms) avg=${renderAvg.toFixed(2)} max=${this.perfRenderMsMax.toFixed(2)} ` +
            `frames=${this.perfRenderCount}`,
        );

        this.perfLastReportTs = now;
        this.perfDecodeMsSum = 0;
        this.perfDecodeMsMax = 0;
        this.perfAppendMsSum = 0;
        this.perfAppendMsMax = 0;
        this.perfApplyMsSum = 0;
        this.perfApplyMsMax = 0;
        this.perfDrawMsSum = 0;
        this.perfDrawMsMax = 0;
        this.perfRenderMsSum = 0;
        this.perfRenderMsMax = 0;
        this.perfChunkCount = 0;
        this.perfRenderCount = 0;
        this.perfDirtyPointsSum = 0;
    }
}

interface OdomJson {
    pose?: {
        pose?: {
            position?: { x?: number; y?: number; z?: number };
            orientation?: { x?: number; y?: number; z?: number; w?: number };
        };
    };
}

function decodePointCloud2(
    msg: PointCloud2Json,
    maxPointsPerScan: number,
    colorMode: 'FLAT' | 'I' | 'RGB',
): {
    positions: Float32Array;
    values: Float32Array;
    rgb?: Uint8Array;
} | null {
    if (!msg || !Array.isArray(msg.fields) || msg.fields.length === 0 || !msg.data) {
        return null;
    }

    const pointCountRaw = Math.max(msg.width * msg.height, 0);
    if (pointCountRaw === 0 || msg.point_step <= 0) return null;

    const rawBytes = decodeBase64(msg.data);
    const availableCount = Math.floor(rawBytes.byteLength / msg.point_step);
    const pointCount = Math.min(pointCountRaw, availableCount);
    if (pointCount <= 0) return null;

    const sampleRatio = maxPointsPerScan > 0 && pointCount > maxPointsPerScan
        ? Math.ceil(pointCount / maxPointsPerScan)
        : 1;
    const sampledCount = Math.ceil(pointCount / sampleRatio);

    const fieldMap = new Map<string, PointFieldJson>();
    for (const field of msg.fields) fieldMap.set(field.name, field);

    const fx = fieldMap.get('x');
    const fy = fieldMap.get('y');
    const fz = fieldMap.get('z');
    if (!fx || !fy || !fz) return null;

    const fi = fieldMap.get('intensity');
    const frgbPacked = colorMode === 'RGB' ? (fieldMap.get('rgb') ?? fieldMap.get('rgba')) : undefined;
    const fr = colorMode === 'RGB' ? (fieldMap.get('r') ?? fieldMap.get('red')) : undefined;
    const fg = colorMode === 'RGB' ? (fieldMap.get('g') ?? fieldMap.get('green')) : undefined;
    const fb = colorMode === 'RGB' ? (fieldMap.get('b') ?? fieldMap.get('blue')) : undefined;

    const positions = new Float32Array(sampledCount * 3);
    const values = new Float32Array(sampledCount);
    const hasRgb = colorMode === 'RGB';
    const rgb = hasRgb ? new Uint8Array(sampledCount * 3) : undefined;

    const littleEndian = !msg.is_bigendian;
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);

    let writeIndex = 0;
    for (let i = 0; i < pointCount; i += sampleRatio) {
        const base = i * msg.point_step;
        const outBase = writeIndex * 3;

        const x = readPointField(view, base + fx.offset, fx.datatype, littleEndian);
        const y = readPointField(view, base + fy.offset, fy.datatype, littleEndian);
        const z = readPointField(view, base + fz.offset, fz.datatype, littleEndian);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

        positions[outBase] = x;
        positions[outBase + 1] = y;
        positions[outBase + 2] = z;

        if (fi) {
            const intensity = readPointField(view, base + fi.offset, fi.datatype, littleEndian);
            values[writeIndex] = Number.isFinite(intensity) ? intensity : z;
        } else {
            values[writeIndex] = z;
        }

        if (rgb) {
            if (frgbPacked) {
                const packed = readPackedRgb(view, base + frgbPacked.offset, frgbPacked.datatype, littleEndian);
                rgb[outBase] = (packed >> 16) & 0xFF;
                rgb[outBase + 1] = (packed >> 8) & 0xFF;
                rgb[outBase + 2] = packed & 0xFF;
            } else if (fr && fg && fb) {
                rgb[outBase] = toU8(readPointField(view, base + fr.offset, fr.datatype, littleEndian));
                rgb[outBase + 1] = toU8(readPointField(view, base + fg.offset, fg.datatype, littleEndian));
                rgb[outBase + 2] = toU8(readPointField(view, base + fb.offset, fb.datatype, littleEndian));
            }
        }

        writeIndex++;
        if (writeIndex >= sampledCount) break;
    }

    return {
        positions: positions.subarray(0, writeIndex * 3),
        values: values.subarray(0, writeIndex),
        rgb: rgb ? rgb.subarray(0, writeIndex * 3) : undefined,
    };
}

function inferColorModeFromFields(fields: PointFieldJson[] | undefined): 'FLAT' | 'I' | 'RGB' {
    if (!Array.isArray(fields) || fields.length === 0) return 'FLAT';

    const fieldMap = new Map<string, PointFieldJson>();
    for (const field of fields) fieldMap.set(field.name, field);

    const frgbPacked = fieldMap.get('rgb') ?? fieldMap.get('rgba');
    const fr = fieldMap.get('r') ?? fieldMap.get('red');
    const fg = fieldMap.get('g') ?? fieldMap.get('green');
    const fb = fieldMap.get('b') ?? fieldMap.get('blue');
    const fi = fieldMap.get('intensity');

    if (frgbPacked || (fr && fg && fb)) return 'RGB';
    if (fi) return 'I';
    return 'FLAT';
}

function readPointField(view: DataView, byteOffset: number, datatype: number, littleEndian: boolean): number {
    switch (datatype) {
        case PF_INT8: return view.getInt8(byteOffset);
        case PF_UINT8: return view.getUint8(byteOffset);
        case PF_INT16: return view.getInt16(byteOffset, littleEndian);
        case PF_UINT16: return view.getUint16(byteOffset, littleEndian);
        case PF_INT32: return view.getInt32(byteOffset, littleEndian);
        case PF_UINT32: return view.getUint32(byteOffset, littleEndian);
        case PF_FLOAT32: return view.getFloat32(byteOffset, littleEndian);
        case PF_FLOAT64: return view.getFloat64(byteOffset, littleEndian);
        default: return NaN;
    }
}

function readPackedRgb(view: DataView, byteOffset: number, datatype: number, littleEndian: boolean): number {
    if (datatype === PF_FLOAT32) {
        return view.getUint32(byteOffset, littleEndian);
    }
    const numeric = readPointField(view, byteOffset, datatype, littleEndian);
    return (Math.max(0, Math.trunc(numeric)) >>> 0);
}

function toU8(value: number): number {
    const scaled = value <= 1 ? value * 255 : value;
    return Math.max(0, Math.min(255, Math.round(scaled)));
}

function decodeBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i);
    }
    return out;
}
