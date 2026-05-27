import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Viewer } from './viewer';
import { GNSSMapItem } from './items/GNSSMapItem';
import { makeButton, makeLabel, makeTextInput } from './viewer/settingsUI';
import type { RealtimeUrlOptions } from './realtimeUrlOptions';
import type { NavSatFixJson, RealtimeTopicOptions, RosbridgePublishMessage } from './utils/realtimeTypes';

type GnssTrackId = 'gnss1' | 'gnss2';

interface GnssTrackState {
    line: Line2;
    lineGeometry: LineGeometry;
    lineMaterial: LineMaterial;
    trailPoints: THREE.Points;
    trailPointsGeometry: THREE.BufferGeometry;
    marker: THREE.Points;
    positions: Float32Array;
    count: number;
    lastFix: { lat: number; lon: number; alt: number; status: number } | null;
}

const TRACK_IDS: GnssTrackId[] = ['gnss1', 'gnss2'];
const MARKER_PIXEL_SIZE = 14;
const TRAIL_POINT_PIXEL_SIZE = 6;
const TRAIL_PIXEL_WIDTH = 4;
const EMPTY_TRAIL_SEGMENT = [0, 0, 0, 0, 0, 0];

const TRACK_CONFIG: Record<GnssTrackId, { label: string; color: number }> = {
    gnss1: { label: 'GNSS1', color: 0x2f6bff },
    gnss2: { label: 'GNSS2', color: 0xff3b30 },
};

const ROUND_MARKER_TEXTURE = createRoundMarkerTexture();

function createRoundMarkerTexture(size: number = 64): THREE.DataTexture {
    const data = new Uint8Array(size * size * 4);
    const radius = size * 0.5 - 2;
    const center = (size - 1) * 0.5;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - center;
            const dy = y - center;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const alpha = distance <= radius ? 255 : 0;
            const offset = (y * size + x) * 4;
            data[offset] = 255;
            data[offset + 1] = 255;
            data[offset + 2] = 255;
            data[offset + 3] = alpha;
        }
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    texture.needsUpdate = true;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
}

function createRoundMarkerMaterial(color: number): THREE.PointsMaterial {
    return new THREE.PointsMaterial({
        color,
        size: MARKER_PIXEL_SIZE,
        sizeAttenuation: false,
        map: ROUND_MARKER_TEXTURE,
        transparent: true,
        alphaTest: 0.5,
    });
}

function createTrailPointMaterial(color: number): THREE.PointsMaterial {
    return new THREE.PointsMaterial({
        color,
        size: TRAIL_POINT_PIXEL_SIZE,
        sizeAttenuation: false,
        map: ROUND_MARKER_TEXTURE,
        transparent: true,
        alphaTest: 0.5,
        opacity: 0.95,
    });
}

function makeLegendLabel(text: string, color: number, dataRole: string): HTMLElement {
    const label = makeLabel('');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';

    const dot = document.createElement('span');
    dot.setAttribute('data-role', dataRole);
    dot.style.width = '10px';
    dot.style.height = '10px';
    dot.style.borderRadius = '999px';
    dot.style.flex = '0 0 10px';
    dot.style.backgroundColor = `#${color.toString(16).padStart(6, '0')}`;

    const textNode = document.createElement('span');
    textNode.textContent = text;

    label.appendChild(dot);
    label.appendChild(textNode);
    return label;
}

function makeTrailToggle(
    trackId: GnssTrackId,
    checked: boolean,
    onChange: (checked: boolean) => void,
): HTMLElement {
    const trailToggle = document.createElement('label');
    trailToggle.setAttribute('data-role', `realtime-${trackId}-trail-toggle-label`);
    trailToggle.style.display = 'inline-flex';
    trailToggle.style.alignItems = 'center';
    trailToggle.style.gap = '6px';
    trailToggle.style.marginLeft = 'auto';
    trailToggle.style.fontSize = '11px';
    trailToggle.style.color = '#ddd';

    const trailToggleInput = document.createElement('input');
    trailToggleInput.type = 'checkbox';
    trailToggleInput.checked = checked;
    trailToggleInput.setAttribute('data-role', `realtime-${trackId}-trail-toggle`);
    trailToggleInput.addEventListener('change', () => onChange(trailToggleInput.checked));

    const trailToggleText = document.createElement('span');
    trailToggleText.textContent = 'Trail';

    trailToggle.appendChild(trailToggleInput);
    trailToggle.appendChild(trailToggleText);
    return trailToggle;
}

class LatLonToLocal {
    private readonly refLat: number;
    private readonly refLon: number;
    private readonly cosLat: number;
    private static readonly DEG2M = 111319.49079327357;

    constructor(refLat: number, refLon: number) {
        this.refLat = refLat;
        this.refLon = refLon;
        this.cosLat = Math.cos((refLat * Math.PI) / 180);
    }

    toLocal(lat: number, lon: number): [number, number] {
        const east = (lon - this.refLon) * LatLonToLocal.DEG2M * this.cosLat;
        const north = (lat - this.refLat) * LatLonToLocal.DEG2M;
        return [east, north];
    }
}

export class RealtimeGnssViewer extends Viewer {
    private rosSocket: WebSocket | null = null;
    private rosbridgeUrl: string = 'ws://localhost:9090';
    private gnss1TopicName: string = '/gnss1';
    private gnss2TopicName: string = '/gnss2';
    private autoFrameTracks: boolean = true;
    private readonly trailVisibility: Record<GnssTrackId, boolean> = {
        gnss1: true,
        gnss2: true,
    };
    private rosUrlInput: HTMLInputElement | null = null;
    private gnss1TopicInput: HTMLInputElement | null = null;
    private gnss2TopicInput: HTMLInputElement | null = null;
    private projection: LatLonToLocal | null = null;
    private readonly maxTrailLength = 50000;
    private readonly gnssMapItemName = 'gnss_map';
    private readonly trackGroupItemName = 'gnss_tracks';
    private readonly trackGroup = new THREE.Group();
    private readonly tracks: Record<GnssTrackId, GnssTrackState> = {
        gnss1: this.createTrack('gnss1'),
        gnss2: this.createTrack('gnss2'),
    };

    constructor(containerId: string, options: RealtimeUrlOptions = {}) {
        super(containerId);
        this.trackGroup.name = this.trackGroupItemName;
        for (const trackId of TRACK_IDS) {
            const track = this.tracks[trackId];
            this.trackGroup.add(track.line);
            this.trackGroup.add(track.trailPoints);
            this.trackGroup.add(track.marker);
        }
        this.setRealtimeOptions(options);
        this.setupRealtimeGnssItems();
        this.installRealtimeGnssSection();
        this.syncTrackLineResolutions();
    }

    private restoreDefaultCameraView(): void {
        this.cameraCenter.set(0, 0, 0);
        this.cameraDist = 40;
        this.updateCamera();
    }

    override rotateCam(rx: number, ry: number, rz: number): void {
        this.autoFrameTracks = false;
        super.rotateCam(rx, ry, rz);
    }

    override rotateKeepCamPos(rx: number, ry: number, rz: number): void {
        this.autoFrameTracks = false;
        super.rotateKeepCamPos(rx, ry, rz);
    }

    override translateCam(trans: THREE.Vector3): void {
        this.autoFrameTracks = false;
        super.translateCam(trans);
    }

    override updateDist(delta: number): void {
        this.autoFrameTracks = false;
        super.updateDist(delta);
    }

    private createTrack(trackId: GnssTrackId): GnssTrackState {
        const positions = new Float32Array(this.maxTrailLength * 3);
        const lineGeometry = new LineGeometry();
        lineGeometry.setPositions(EMPTY_TRAIL_SEGMENT);
        const lineMaterial = new LineMaterial({
            color: TRACK_CONFIG[trackId].color,
            linewidth: TRAIL_PIXEL_WIDTH,
            worldUnits: false,
            depthTest: false,
            transparent: true,
            depthWrite: false,
        });
        lineMaterial.resolution.set(1, 1);
        const line = new Line2(lineGeometry, lineMaterial);
        line.name = `${trackId}_trail`;
        line.frustumCulled = false;
        line.renderOrder = 4;
        line.visible = false;

        const trailPointsGeometry = new THREE.BufferGeometry();
        trailPointsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        trailPointsGeometry.setDrawRange(0, 0);
        const trailPoints = new THREE.Points(
            trailPointsGeometry,
            createTrailPointMaterial(TRACK_CONFIG[trackId].color),
        );
        trailPoints.name = `${trackId}_trail_points`;
        trailPoints.visible = false;
        trailPoints.frustumCulled = false;
        trailPoints.renderOrder = 5;

        const markerGeometry = new THREE.BufferGeometry();
        markerGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
        const marker = new THREE.Points(
            markerGeometry,
            createRoundMarkerMaterial(TRACK_CONFIG[trackId].color),
        );
        marker.name = `${trackId}_marker`;
        marker.visible = false;
        marker.frustumCulled = false;
        marker.renderOrder = 6;

        return { line, lineGeometry, lineMaterial, trailPoints, trailPointsGeometry, marker, positions, count: 0, lastFix: null };
    }

    override onWindowResize() {
        super.onWindowResize();
        this.syncTrackLineResolutions();
    }

    private installRealtimeGnssSection(): void {
        if (!this.settingsPanel || !this.settingsContent) return;
        const section = document.createElement('div');
        section.className = 'q3d-settings-section';
        section.setAttribute('data-role', 'realtime-gnss');

        section.appendChild(makeLabel('ROS Bridge URL'));
        const rosInput = makeTextInput(this.rosbridgeUrl, value => { this.rosbridgeUrl = value.trim(); });
        rosInput.setAttribute('data-role', 'realtime-gnss-ros-url');
        this.rosUrlInput = rosInput;
        section.appendChild(rosInput);

        const gnss1Label = makeLegendLabel('GNSS1 Topic', TRACK_CONFIG.gnss1.color, 'realtime-gnss1-label-dot');
        gnss1Label.appendChild(makeTrailToggle('gnss1', this.trailVisibility.gnss1, checked => {
            this.trailVisibility.gnss1 = checked;
            this.syncTrackVisibility();
            this.requestRender();
        }));
        section.appendChild(gnss1Label);
        const gnss1TopicInput = makeTextInput(this.gnss1TopicName, value => { this.gnss1TopicName = value.trim(); });
        gnss1TopicInput.setAttribute('data-role', 'realtime-gnss1-topic');
        this.gnss1TopicInput = gnss1TopicInput;
        section.appendChild(gnss1TopicInput);

        const gnss2Label = makeLegendLabel('GNSS2 Topic', TRACK_CONFIG.gnss2.color, 'realtime-gnss2-label-dot');
        gnss2Label.appendChild(makeTrailToggle('gnss2', this.trailVisibility.gnss2, checked => {
            this.trailVisibility.gnss2 = checked;
            this.syncTrackVisibility();
            this.requestRender();
        }));
        section.appendChild(gnss2Label);
        const gnss2TopicInput = makeTextInput(this.gnss2TopicName, value => { this.gnss2TopicName = value.trim(); });
        gnss2TopicInput.setAttribute('data-role', 'realtime-gnss2-topic');
        this.gnss2TopicInput = gnss2TopicInput;
        section.appendChild(gnss2TopicInput);

        const connectBtn = makeButton('Connect', () => {
            const url = rosInput.value.trim();
            if (!url) return;
            this.rosbridgeUrl = url;
            this.gnss1TopicName = gnss1TopicInput.value.trim();
            this.gnss2TopicName = gnss2TopicInput.value.trim();
            this.connectRosbridge(url);
            connectBtn.textContent = 'Reconnect';
        });
        section.appendChild(connectBtn);

        section.appendChild(makeButton('Clear GNSS Trails', () => this.clearTracks()));
        section.appendChild(makeButton('Reset GNSS Origin', () => this.resetOrigin()));

        const itemSelect = this.settingsItemSelect?.closest('.q3d-material-select') as HTMLElement | null;
        const itemLabel = this.settingsPanel.querySelector('[data-role="settings-item-label"]') as HTMLElement | null;
        const anchor = itemLabel ?? itemSelect;
        if (anchor?.parentElement === this.settingsPanel) {
            if (itemSelect) itemSelect.style.marginTop = '2px';
            this.settingsPanel.insertBefore(section, anchor);
        } else {
            this.settingsPanel.insertBefore(section, this.settingsContent);
        }
        this.syncRealtimeControls();
        this.syncTrackVisibility();
    }

    private setupRealtimeGnssItems(): void {
        if (!(this.items[this.gnssMapItemName] instanceof GNSSMapItem)) {
            const map = new GNSSMapItem({ alpha: 0.9, tileRadius: 3, showTrailControls: false });
            map.renderCb = () => this.requestRender();
            this.addItem(this.gnssMapItemName, map);
        }

        if (this.items[this.trackGroupItemName] !== this.trackGroup) {
            this.hiddenSettingItems.add(this.trackGroupItemName);
            this.addItem(this.trackGroupItemName, this.trackGroup);
        }
    }

    private syncRealtimeControls(): void {
        if (this.rosUrlInput) this.rosUrlInput.value = this.rosbridgeUrl;
        if (this.gnss1TopicInput) this.gnss1TopicInput.value = this.gnss1TopicName;
        if (this.gnss2TopicInput) this.gnss2TopicInput.value = this.gnss2TopicName;
    }

    setRealtimeOptions(options: RealtimeUrlOptions): void {
        if (options.rosbridgeUrl) this.rosbridgeUrl = options.rosbridgeUrl;
        if (options.gnss1TopicName) this.gnss1TopicName = options.gnss1TopicName.trim();
        if (options.gnss2TopicName) this.gnss2TopicName = options.gnss2TopicName.trim();
        this.syncRealtimeControls();
    }

    connectRosbridge(wsUrl: string, options: RealtimeTopicOptions = {}): void {
        this.rosbridgeUrl = wsUrl;
        if (this.rosSocket && this.rosSocket.readyState <= WebSocket.OPEN) {
            this.disconnectRosbridge();
        }

        this.setRealtimeOptions(options as RealtimeUrlOptions);
        this.setupRealtimeGnssItems();
        this.resetOrigin();

        const socket = new WebSocket(wsUrl);
        this.rosSocket = socket;

        socket.addEventListener('open', () => {
            for (const [, topicName] of this.getTopicEntries()) {
                socket.send(JSON.stringify({
                    op: 'subscribe',
                    topic: topicName,
                    type: 'sensor_msgs/NavSatFix',
                    queue_length: 1,
                    throttle_rate: 0,
                }));
            }
        });

        socket.addEventListener('message', (event: MessageEvent<string>) => {
            this.onRosbridgeMessage(event.data);
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
            for (const [, topicName] of this.getTopicEntries()) {
                this.rosSocket.send(JSON.stringify({ op: 'unsubscribe', topic: topicName }));
            }
        }
        this.rosSocket.close();
        this.rosSocket = null;
    }

    ingestNavSatFix(trackId: GnssTrackId, msg: NavSatFixJson): void {
        const latitude = msg?.latitude;
        const longitude = msg?.longitude;
        if (
            typeof latitude !== 'number' ||
            typeof longitude !== 'number' ||
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude)
        ) return;

        const altitudeValue = typeof msg?.altitude === 'number' ? msg.altitude : Number.NaN;
        const altitude = Number.isFinite(altitudeValue) ? altitudeValue : 0;
        const statusValue = typeof msg?.status?.status === 'number' ? msg.status.status : Number.NaN;
        const status = Number.isFinite(statusValue) ? Math.trunc(statusValue) : 0;

        this.setupRealtimeGnssItems();
        if (!this.projection) this.projection = new LatLonToLocal(latitude, longitude);
        this.addTrackFix(trackId, latitude, longitude, altitude, status);
        this.frameTracksInView();

        const map = this.items[this.gnssMapItemName];
        if (map instanceof GNSSMapItem) map.addFix(latitude, longitude, altitude, status);

        this.updateStatus();
        this.requestRender();
    }

    clearTracks(): void {
        this.autoFrameTracks = true;
        for (const trackId of TRACK_IDS) {
            const track = this.tracks[trackId];
            track.count = 0;
            track.lastFix = null;
            track.lineGeometry.setPositions(EMPTY_TRAIL_SEGMENT);
            track.trailPointsGeometry.setDrawRange(0, 0);
            track.line.visible = false;
            track.trailPoints.visible = false;
            track.marker.visible = false;
        }
        const map = this.items[this.gnssMapItemName];
        if (map instanceof GNSSMapItem) map.clearTrail();
        this.updateStatus();
        this.requestRender();
    }

    resetOrigin(): void {
        this.clearTracks();
        this.projection = null;
        this.restoreDefaultCameraView();
        const map = this.items[this.gnssMapItemName];
        if (map instanceof GNSSMapItem) map.resetOrigin();
    }

    private addTrackFix(trackId: GnssTrackId, lat: number, lon: number, alt: number, status: number): void {
        if (!this.projection) return;
        const track = this.tracks[trackId];
        const [east, north] = this.projection.toLocal(lat, lon);
        const groundHeight = 0.15;

        if (track.count < this.maxTrailLength) {
            const offset = track.count * 3;
            track.positions[offset] = east;
            track.positions[offset + 1] = north;
            track.positions[offset + 2] = groundHeight;
            track.count++;
            const trailPositionAttr = track.trailPointsGeometry.getAttribute('position') as THREE.BufferAttribute;
            trailPositionAttr.needsUpdate = true;
            track.trailPointsGeometry.setDrawRange(0, track.count);
            if (track.count >= 2) {
                track.lineGeometry.setPositions(track.positions.subarray(0, track.count * 3));
            }
            this.syncTrackVisibility();
        }

        track.marker.position.set(east, north, groundHeight + 0.35);
        track.marker.visible = true;
        track.lastFix = { lat, lon, alt, status };
    }

    private onRosbridgeMessage(rawData: string): void {
        let payload: RosbridgePublishMessage;
        try {
            payload = JSON.parse(rawData) as RosbridgePublishMessage;
        } catch {
            return;
        }

        if (payload.op !== 'publish' || !payload.topic || !payload.msg) return;

        if (payload.topic === this.gnss1TopicName) {
            this.ingestNavSatFix('gnss1', payload.msg as NavSatFixJson);
        }
        if (payload.topic === this.gnss2TopicName) {
            this.ingestNavSatFix('gnss2', payload.msg as NavSatFixJson);
        }
    }

    private getTopicEntries(): Array<[GnssTrackId, string]> {
        return TRACK_IDS
            .map(trackId => [trackId, this.getTopicName(trackId).trim()] as [GnssTrackId, string])
            .filter(([, topicName]) => topicName.length > 0);
    }

    private getTopicName(trackId: GnssTrackId): string {
        return trackId === 'gnss1' ? this.gnss1TopicName : this.gnss2TopicName;
    }

    private syncTrackLineResolutions(): void {
        const width = Math.max(this.container.clientWidth, 1);
        const height = Math.max(this.container.clientHeight, 1);
        for (const trackId of TRACK_IDS) {
            this.tracks[trackId].lineMaterial.resolution.set(width, height);
        }
    }

    private syncTrackVisibility(): void {
        for (const trackId of TRACK_IDS) {
            const track = this.tracks[trackId];
            const visible = this.trailVisibility[trackId] && track.count >= 2;
            track.line.visible = visible;
            track.trailPoints.visible = visible;
        }
    }

    private frameTracksInView(): void {
        if (!this.autoFrameTracks) return;

        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let hasPoint = false;

        for (const trackId of TRACK_IDS) {
            const track = this.tracks[trackId];
            for (let i = 0; i < track.count; i++) {
                const offset = i * 3;
                const x = track.positions[offset];
                const y = track.positions[offset + 1];
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
                hasPoint = true;
            }
        }

        if (!hasPoint) return;

        const centerX = (minX + maxX) * 0.5;
        const centerY = (minY + maxY) * 0.5;
        const spanX = maxX - minX;
        const spanY = maxY - minY;
        const radius = Math.max(Math.hypot(spanX, spanY) * 0.5, 10);
        const fitDistance = radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));

        this.cameraCenter.set(centerX, centerY, 0);
        this.cameraDist = Math.max(40, fitDistance * 1.8);
        this.updateCamera();
    }

    private updateStatus(): void {
        if (!this.statusElement) return;
        this.statusElement.textContent = TRACK_IDS.map(trackId => {
            const fix = this.tracks[trackId].lastFix;
            const label = TRACK_CONFIG[trackId].label;
            return fix
                ? `${label}: ${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)} (${this.tracks[trackId].count} pts)`
                : `${label}: waiting`;
        }).join(' | ');
    }
}