import * as THREE from 'three';
import { Viewer } from './viewer';
import { CloudItem } from './items/CloudItem';
import { AxisItem } from './items/AxisItem';
import { NativeCloudItem } from './items/NativeCloudItem';
import { decodePointCloud2, inferColorModeFromFields } from './utils/pointCloud2Decode';
import { makeLabel, makeTextInput, makeNumberInput, makeButton, buildNativeCloudItemSettings } from './viewer/settingsUI';
import type {
    ColorMode,
    DecodedCloudChunk,
    OdomJson,
    PointCloud2Json,
    RealtimeTopicOptions,
    RosbridgePublishMessage,
} from './utils/realtimeTypes';

/**
 * RealtimeViewer extends Viewer with ROS PointCloud2 realtime ingestion.
 * It is optimized for streaming append workloads instead of one-shot file loads.
 */
export class RealtimeViewer extends Viewer {
    private rosSocket: WebSocket | null = null;
    private cloudTopicName: string = '/cloud_registered';
    private odomTopicName: string = '/odometry';
    private maxPointsPerScan: number = 1500;
    private mapColorMode: ColorMode | null = null;
    private readonly maxQueuedChunks = 4;
    private readonly maxApplyChunksPerCommit = 4;
    private readonly mapUpdateIntervalMs = 80;
    private lastMapUpdateTs = 0;
    private readonly scanUpdateIntervalMs = 120;
    private lastScanUpdateTs = 0;
    private pendingChunks: DecodedCloudChunk[] = [];
    private pendingScanChunk: DecodedCloudChunk | null = null;
    private readonly mapItemName = 'map';
    private readonly scanItemName = 'scan';
    private readonly odomItemName = 'odom';
    realtimeMaxPoints: number = 5_000_000;

    constructor(containerId: string) {
        super(containerId);
        this.setupRealtimeItems();
        this.installRealtimeSection();
    }

    /** Inserts the realtime connection panel above the item dropdown and settings area. */
    private installRealtimeSection(): void {
        if (!this.settingsPanel || !this.settingsContent) return;
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:10px;padding-bottom:10px;border-bottom:2px solid #888;box-shadow:0 1px 0 rgba(0,0,0,0.9);';
        section.setAttribute('data-role', 'realtime');

        section.appendChild(makeLabel('ROS Bridge URL'));
        const rosInput = makeTextInput('ws://localhost:9090', () => {});

        section.appendChild(rosInput);
        section.appendChild(makeLabel('Cloud Topic'));
        const cloudTopicInput = makeTextInput(this.cloudTopicName, v => { this.cloudTopicName = v; });
        section.appendChild(cloudTopicInput);

        section.appendChild(makeLabel('Odom Topic'));
        const odomTopicInput = makeTextInput(this.odomTopicName, v => { this.odomTopicName = v; });
        section.appendChild(odomTopicInput);

        section.appendChild(makeLabel('Max Points / Scan'));
        const maxScanInput = makeNumberInput(this.maxPointsPerScan, 1, 1_000_000, 100, v => { this.maxPointsPerScan = Math.floor(v); });
        section.appendChild(maxScanInput);

        section.appendChild(makeLabel('Max Accumulated Points'));
        const maxCloudInput = makeNumberInput(this.realtimeMaxPoints, 10_000, 50_000_000, 100_000, v => { this.realtimeMaxPoints = Math.floor(v); });
        section.appendChild(maxCloudInput);

        const connectBtn = makeButton('Connect', () => {
            const url = rosInput.value.trim();
            if (!url) return;
            this.connectRosbridge(url);
            connectBtn.textContent = 'Reconnect';
        });
        section.appendChild(connectBtn);

        const itemSelect = this.settingsItemSelect;
        if (itemSelect?.parentElement === this.settingsPanel) {
            itemSelect.style.marginTop = '2px';
            this.settingsPanel.insertBefore(section, itemSelect);
        } else {
            this.settingsPanel.insertBefore(section, this.settingsContent);
        }
    }

    override onSettingsItemSelected(name: string): void {
        const item = this.items[name];
        if (item instanceof NativeCloudItem && this.settingsContent) {
            this.settingsContent.innerHTML = '';
            buildNativeCloudItemSettings(
                item,
                this.settingsContent,
                () => this.requestRender(),
                mode => { this.mapColorMode = mode; },
            );
            return;
        }
        super.onSettingsItemSelected(name);
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
        this.setupRealtimeItems();
        const map = this.items[this.mapItemName];
        if (map instanceof NativeCloudItem) {
            map.reset(this.realtimeMaxPoints);
            map.setColorMode('FLAT');
        }

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
            const map = this.items[this.mapItemName];
            if (map instanceof NativeCloudItem) {
                map.setColorMode(this.mapColorMode);
            }
        }

        const decoded = decodePointCloud2(
            pointCloud2,
            options.maxPointsPerScan ?? this.maxPointsPerScan,
            this.mapColorMode,
        );
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
        this.applyPendingCloudUpdates();
        super.render();
        const map = this.items[this.mapItemName];
        if (map instanceof NativeCloudItem) {
            map.draw(this.renderer, this.camera);
        }

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
        if (!(this.items[this.mapItemName] instanceof NativeCloudItem)) {
            const map = new NativeCloudItem({
                colorMode: 'FLAT',
                pointSize: 1,
                alpha: 1,
            });
            this.addItem(this.mapItemName, map);
        }

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
        const map = this.items[this.mapItemName] as NativeCloudItem | undefined;
        const scan = this.items[this.scanItemName] as CloudItem | undefined;
        if (!(map instanceof NativeCloudItem) || !(scan instanceof CloudItem)) return;

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

                map.appendPoints(this.renderer, chunk.positions, chunk.values, chunk.maxAccumulatedPoints);
                applied++;
                lastScanCount = chunk.values.length;
            }
            this.lastMapUpdateTs = now;
        }

        if (applied > 0 && this.statusElement) {
            this.statusElement.textContent =
                `Map: ${map.getPointCount().toLocaleString()} pts | Scan: ${lastScanCount.toLocaleString()} pts`;
        }
    }
}
