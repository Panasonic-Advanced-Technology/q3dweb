import * as THREE from 'three';
import { CloudItem, CloudShaderMaterial } from './items/CloudItem';
import { AxisItem } from './items/AxisItem';
import { GridItem } from './items/GridItem';
import { Text2DItem } from './items/Text2DItem';
import { Text3DItem, Text3DData } from './items/Text3DItem';
import { GNSSMapItem } from './items/GNSSMapItem';
import { FilmMaker, KeyFrame } from './filmMaker';
import { recoverCenterEuler } from './utils/maths';
import { parseLASGeoInfo, readLASBounds } from './utils/lasGeo';
import { projToLatLon, registerWKT, convertByKey } from './utils/projConvert';
import {
    detectHeapLimit,
    detectHeapUsed,
    estimateMemoryRequirement,
    formatBytes,
} from './utils/memoryCheck';

// Minimal PCD Header Parser for Streaming
interface PCDHeader {
    data: 'ascii' | 'binary' | 'binary_compressed';
    headerLen: number;
    width: number;
    height: number;
    points: number;
    rowSize: number;
    offset: { [key: string]: number };
    fields?: string[];
    counts?: number[];
    types?: string[];
    sizes?: number[];
}

interface LASBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
}

interface LASMetadata {
    versionMajor: number;
    versionMinor: number;
    offsetToPointData: number;
    pointDataRecordFormat: number;
    pointDataRecordLength: number;
    numberOfPoints: number;
    xScale: number;
    yScale: number;
    zScale: number;
    xOff: number;
    yOff: number;
    zOff: number;
    hasRGB: boolean;
    rgbOffset: number;
    shiftX: number;
    shiftY: number;
    originLatLon: [number, number] | null;
    bounds: LASBounds | null;
}

interface LASStreamState extends LASMetadata {
    rawPointIndex: number;
}

function eulerToMatrix(roll: number, pitch: number, yaw: number): THREE.Matrix4 {
    const cx = Math.cos(roll), sx = Math.sin(roll);
    const cy = Math.cos(pitch), sy = Math.sin(pitch);
    const cz = Math.cos(yaw), sz = Math.sin(yaw);
    const m = new THREE.Matrix4();
    m.set(
        cz*cy,  cz*sy*sx - sz*cx,  cz*sy*cx + sz*sx,  0,
        sz*cy,  sz*sy*sx + cz*cx,  sz*sy*cx - cz*sx,  0,
       -sy,     cy*sx,             cy*cx,              0,
        0,      0,                 0,                   1
    );
    return m;
}

/** Interface for settings that items can provide */
interface SettingBuilder {
    addSetting(container: HTMLElement): void;
}

/** True if the event target is an input/textarea/select — used to suppress global keyboard shortcuts. */
function isEditable(t: EventTarget | null): boolean {
    if (!t) return false;
    const el = t as HTMLElement;
    const tag = el.tagName?.toUpperCase?.();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export class Viewer {
    container: HTMLElement;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    items: {[name: string]: THREE.Object3D} = {};
    /** Items that should not appear in settings */
    hiddenSettingItems: Set<string> = new Set();

    // Camera state (matching q3dviewer)
    euler: [number, number, number] = [Math.PI / 3, 0, Math.PI / 4];
    cameraCenter: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
    cameraDist: number = 40;

    // Keyboard / Mouse state
    activeKeys: Set<string> = new Set();
    showCenter: boolean = false;
    enableShowCenter: boolean = true;
    mousePos: { x: number; y: number } | null = null;
    mouseButton: number = -1;
    shiftPressed: boolean = false;
    ctrlPressed: boolean = false;
    centerPointMesh: THREE.Points | null = null;

    // Settings panel
    settingsPanel: HTMLElement | null = null;
    settingsContent: HTMLElement | null = null;
    settingsItemSelect: HTMLSelectElement | null = null;

    // Status & UI
    statusElement: HTMLElement | null = null;
    loadingOverlay: HTMLElement;

    // Measurement (Ctrl+click like cloud_viewer)
    selectedPoints: THREE.Vector3[] = [];
    text2dItem: Text2DItem | null = null;

    // Supported extensions
    static readonly SUPPORTED_EXTENSIONS = ['.pcd', '.ply', '.las', '.laz', '.e57'];

    // When true, skip the heap-size safety check before loading a file.
    // Useful for automated tests and headless environments.
    skipMemoryCheck: boolean = false;

    // Streaming state
    currentFormat: 'pcd' | 'ply' | 'las' | 'laz' | 'e57' | 'unknown' = 'pcd';
    streamFilename: string | undefined = undefined;
    streamTotalSize: number = 0;
    streamLoadedSize: number = 0;
    streamAborted: boolean = false;
    pcdHeader: PCDHeader | null = null;
    lasStream: LASStreamState | null = null;
    isBinary: boolean = false;
    leftoverChunk: Uint8Array | null = null;
    pointsLoaded: number = 0;
    targetSampleRatio: number = 1;
    fullBufferWriteOffset: number = 0;
    chunkList: Uint8Array[] = [];

    // Visualization Buffers
    MAX_POINTS_VISUAL = 15_000_000;
    posBuffer: Float32Array | null = null;
    valBuffer: Float32Array | null = null;
    rgbBuffer: Uint8Array | null = null;
    fullBuffer: Uint8Array | null = null;
    posIndex: number = 0;

    // Data range
    dataMin: number = 0;
    dataMax: number = 255;

    // Rendering
    renderRequested: boolean = false;
    animationFrameId: number = 0;

    // Background color string for settings
    colorStr: string = 'black';

    // Film Maker
    filmMaker: FilmMaker = new FilmMaker();
    /** When the Film Maker tab is active, Space/Delete bind to add/delete keyframes. */
    filmMakerTabActive: boolean = false;
    /** Playback state. */
    private filmPlaybackIndex: number = 0;
    private filmPlaybackRequestId: number | null = null;
    private filmPlaybackLastTimestamp: number | null = null;
    private filmPlaybackAccumulatorMs: number = 0;
    isPlayingFilm: boolean = false;
    isRecordingFilm: boolean = false;
    private mediaRecorder: MediaRecorder | null = null;
    private recordedChunks: Blob[] = [];
    lastRecordedBlob: Blob | null = null;
    videoFileName: string = 'q3dweb.mp4';
    videoMimeType: string = 'video/mp4;codecs=h264';
    recordingVideoBitsPerSecond: number = 32_000_000;
    recordingPixelRatioMin: number = 2;
    private filmMakerListEl: HTMLElement | null = null;
    private filmMakerPlayBtn: HTMLButtonElement | null = null;
    private rendererPixelRatio: number = 1;

    constructor(containerId: string) {
        const container = document.getElementById(containerId);
        if (!container) throw new Error(`Container ${containerId} not found`);
        this.container = container;

        // Loading Overlay (Center)
        this.loadingOverlay = document.createElement('div');
        this.loadingOverlay.style.cssText = `
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); display: none;
            justify-content: center; align-items: center; z-index: 1001;
        `;
        this.loadingOverlay.innerHTML = '<div style="color: white; font-size: 24px; font-family: sans-serif; background: rgba(0,0,0,0.8); padding: 20px; border-radius: 8px;">Loading...</div>';
        this.container.appendChild(this.loadingOverlay);

        this.installGlobalErrorHandler();

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x000000);

        // Camera
        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 1000);
        this.camera.position.set(10, 10, 10);
        this.camera.up.set(0, 0, 1);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.rendererPixelRatio = this.getBaseRendererPixelRatio();
        this.renderer.setPixelRatio(this.rendererPixelRatio);
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        // Make the canvas focusable so clicking it steals focus from form inputs,
        // ensuring keyboard shortcuts (e.g. M to toggle settings) work as expected.
        this.renderer.domElement.tabIndex = 0;
        this.renderer.domElement.style.outline = 'none';
        this.container.appendChild(this.renderer.domElement);

        // Camera controls
        this.setupMouseControls();
        this.setupKeyboardControls();
        this.updateCamera();

        // Default items (matching cloud_viewer)
        this.addDefaultItems();

        // Center point visualization
        this.createCenterPoint();

        // Settings panel (toggled by 'm' key)
        this.createSettingsPanel();

        // Drag and Drop
        this.setupDragDrop();

        // Resize handler
        window.addEventListener('resize', this.onWindowResize.bind(this), false);

        // Animation loop
        this.startAnimationLoop();
    }

    // ========== Default Items (matching cloud_viewer) ==========

    addDefaultItems() {
        const grid = new GridItem({ size: 1000, spacing: 20 });
        grid.renderCb = () => this.requestRender();
        this.addItem('grid', grid);

        const axis = new AxisItem({ size: 0.5, width: 5 });
        this.addItem('axis', axis);
        this.hiddenSettingItems.add('axis');

        // Text2DItem for distance display (top-right overlay)
        this.text2dItem = new Text2DItem(this.container, {
            text: '',
            color: '#b3ffb3',
            fontSize: 14,
            anchor: 'top-right',
            pos: [16, 16],
            background: 'rgba(0,0,0,0.55)',
            padding: '8px 12px',
        });
        this.text2dItem.hide();
        this.hiddenSettingItems.add('text');

        // Marker (Text3DItem) for measurement points
        const marker = new Text3DItem();
        this.addItem('marker', marker);
        this.hiddenSettingItems.add('marker');
    }

    // ========== Camera Control Methods (matching q3dviewer) ==========

    updateCamera() {
        const [roll, pitch, yaw] = this.euler;
        const Rwc = eulerToMatrix(roll, pitch, yaw);
        const offset = new THREE.Vector3(0, 0, this.cameraDist);
        offset.applyMatrix4(Rwc);
        const camPos = this.cameraCenter.clone().add(offset);
        this.camera.position.copy(camPos);
        const up = new THREE.Vector3(0, 1, 0).applyMatrix4(Rwc);
        this.camera.up.copy(up);
        this.camera.lookAt(this.cameraCenter);

        this.updateProjectionMatrixLikeQ3DViewer();

        this.requestRender();
    }

    private updateProjectionMatrixLikeQ3DViewer(): void {
        const w = Math.max(this.container.clientWidth, 1);
        const h = Math.max(this.container.clientHeight, 1);
        const dist = 40;
        const near = dist * 0.001;
        const far = dist * 10000;
        const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
        const r = near * Math.tan(0.5 * fovRad);
        const t = r * h / Math.max(w, 1);

        this.camera.near = near;
        this.camera.far = far;
        this.camera.projectionMatrix.makePerspective(-r, r, t, -t, near, far);
        this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    }

    rotateCam(rx: number, ry: number, rz: number) {
        this.euler[0] += rx;
        this.euler[1] += ry;
        this.euler[2] += rz;
        this.euler[0] = Math.max(0, Math.min(Math.PI, this.euler[0]));
        this.euler[1] = ((this.euler[1] + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        this.euler[2] = ((this.euler[2] + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        this.updateCamera();
    }

    rotateKeepCamPos(rx: number, ry: number, rz: number) {
        const newEuler: [number, number, number] = [
            this.euler[0] + rx, this.euler[1] + ry, this.euler[2] + rz
        ];
        newEuler[0] = Math.max(0, Math.min(Math.PI, newEuler[0]));
        newEuler[1] = ((newEuler[1] + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        newEuler[2] = ((newEuler[2] + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        const RwcOld = eulerToMatrix(this.euler[0], this.euler[1], this.euler[2]);
        const tco = new THREE.Vector3(0, 0, this.cameraDist);
        const twc = this.cameraCenter.clone().add(tco.clone().applyMatrix4(RwcOld));
        const RwcNew = eulerToMatrix(newEuler[0], newEuler[1], newEuler[2]);
        const newCenter = twc.clone().sub(tco.clone().applyMatrix4(RwcNew));
        this.cameraCenter.copy(newCenter);
        this.euler = newEuler;
        this.updateCamera();
    }

    translateCam(trans: THREE.Vector3) {
        this.cameraCenter.add(trans);
        this.updateCamera();
    }

    updateDist(delta: number) {
        this.cameraDist += delta;
        if (this.cameraDist < 0.1) this.cameraDist = 0.1;
        this.updateCamera();
    }

    private getCameraK(): THREE.Matrix3 {
        const w = this.container.clientWidth * this.rendererPixelRatio;
        const h = this.container.clientHeight * this.rendererPixelRatio;
        const fovRad = this.camera.fov * Math.PI / 180;
        const fy = (h / 2) / Math.tan(fovRad / 2);
        const K = new THREE.Matrix3();
        K.set(fy, 0, w / 2, 0, fy, h / 2, 0, 0, 1);
        return K;
    }

    // ========== Mouse Controls ==========

    setupMouseControls() {
        const canvas = this.renderer.domElement;

        canvas.addEventListener('mousedown', (e: MouseEvent) => {
            this.mousePos = { x: e.clientX, y: e.clientY };
            this.mouseButton = e.button;
            this.shiftPressed = e.shiftKey;
            this.ctrlPressed = e.ctrlKey || e.metaKey;

            // Ctrl + Left click: add measurement point
            if (this.ctrlPressed && e.button === 0) {
                this.addMeasurementPoint(e);
                return;
            }
            // Ctrl + Right click: remove last measurement point
            if (this.ctrlPressed && e.button === 2) {
                this.removeMeasurementPoint();
                return;
            }

            e.preventDefault();
            // preventDefault stops text selection but also suppresses the
            // browser's default focus transfer. Explicitly focus the canvas
            // so keyboard shortcuts (e.g. M) work after a mouse interaction.
            canvas.focus();
        });

        canvas.addEventListener('mousemove', (e: MouseEvent) => {
            if (this.mousePos === null) return;
            if (this.ctrlPressed) return;

            const dx = e.clientX - this.mousePos.x;
            const dy = e.clientY - this.mousePos.y;
            this.mousePos = { x: e.clientX, y: e.clientY };
            this.shiftPressed = e.shiftKey;

            if (this.mouseButton === 2) {
                const rotSpeed = 0.2;
                const dyaw = (-dx * rotSpeed) * Math.PI / 180;
                const droll = (-dy * rotSpeed) * Math.PI / 180;
                if (this.shiftPressed) {
                    this.rotateKeepCamPos(droll, 0, dyaw);
                } else {
                    this.rotateCam(droll, 0, dyaw);
                }
            } else if (this.mouseButton === 0) {
                const Rwc = eulerToMatrix(this.euler[0], this.euler[1], this.euler[2]);
                const K = this.getCameraK();
                const Kinv = K.clone().invert();
                const dist = Math.max(this.cameraDist, 0.5);
                const screenVec = new THREE.Vector3(-dx, dy, 0);
                screenVec.applyMatrix3(Kinv);
                screenVec.multiplyScalar(dist);
                screenVec.applyMatrix4(Rwc);
                this.translateCam(screenVec);
            }
            this.showCenter = true;
            this.requestRender();
        });

        canvas.addEventListener('mouseup', () => {
            this.mousePos = null;
            this.mouseButton = -1;
        });

        canvas.addEventListener('mouseleave', () => {
            this.mousePos = null;
            this.mouseButton = -1;
        });

        canvas.addEventListener('wheel', (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
            this.updateDist(delta * this.cameraDist * 0.001);
            this.showCenter = true;
        }, { passive: false });

        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // ========== Measurement (Ctrl+Click like cloud_viewer) ==========

    addMeasurementPoint(e: MouseEvent) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);
        raycaster.params.Points = { threshold: 0.5 };

        const intersectables = Object.values(this.items).filter(
            i => i instanceof THREE.Points && i.name !== '' && i !== this.centerPointMesh
        );
        const hits = raycaster.intersectObjects(intersectables, false);
        if (hits.length > 0) {
            let best = hits[0] as any;
            for (let i = 1; i < hits.length; i++) {
                const h = hits[i] as any;
                const bestRay = Number.isFinite(best.distanceToRay) ? best.distanceToRay : Infinity;
                const hRay = Number.isFinite(h.distanceToRay) ? h.distanceToRay : Infinity;
                if (hRay < bestRay || (hRay === bestRay && h.distance < best.distance)) {
                    best = h;
                }
            }
            const p = best.point.clone();
            this.selectedPoints.push(p);
            this.updateMeasurementMarker();
        }
    }

    removeMeasurementPoint() {
        if (this.selectedPoints.length > 0) {
            this.selectedPoints.pop();
            this.updateMeasurementMarker();
        }
    }

    updateMeasurementMarker() {
        const markerItem = this.items['marker'];
        if (markerItem instanceof Text3DItem) {
            const data: Text3DData[] = this.selectedPoints.map(p => ({
                text: '',
                position: [p.x, p.y, p.z] as [number, number, number],
                color: [0.0, 1.0, 0.0, 1.0] as [number, number, number, number],
                fontSize: 16,
                pointSize: 5.0,
                lineWidth: 1.0,
            }));
            markerItem.setData(data);
        }

        if (this.selectedPoints.length >= 2) {
            let totalDist = 0;
            const segments: string[] = [];
            for (let i = 1; i < this.selectedPoints.length; i++) {
                const d = this.selectedPoints[i].distanceTo(this.selectedPoints[i - 1]);
                totalDist += d;
                segments.push(`#${i}→#${i + 1}: ${d.toFixed(3)} m`);
            }
            if (this.text2dItem) {
                const lines = [
                    `<b>Measurement</b>`,
                    `Points: ${this.selectedPoints.length}`,
                    ...segments,
                    `<span style="color:#fff;">Total: ${totalDist.toFixed(3)} m</span>`,
                ];
                this.text2dItem.setHTML(lines.join('<br>'));
                this.text2dItem.show();
            }
        } else if (this.selectedPoints.length === 1) {
            const p = this.selectedPoints[0];
            if (this.text2dItem) {
                this.text2dItem.setHTML(
                    `<b>Measurement</b><br>` +
                    `Point 1: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})<br>` +
                    `<span style="color:#aaa;">Ctrl+click another point to measure…</span>`
                );
                this.text2dItem.show();
            }
        } else {
            if (this.text2dItem) { this.text2dItem.setText(''); this.text2dItem.hide(); }
        }
        this.requestRender();
    }

    // ========== Keyboard Controls ==========

    setupKeyboardControls() {
        window.addEventListener('keydown', (e: KeyboardEvent) => {
            this.activeKeys.add(e.key.toLowerCase());
            if (e.key === 'Shift') this.shiftPressed = true;
            if (e.key === 'Control' || e.key === 'Meta') this.ctrlPressed = true;
            if (e.key.toLowerCase() === 'm') {
                // Skip M when user is typing in a text input, but NOT for
                // <select> (isEditable treats SELECT as editable). Also
                // suppress the native <select> type-ahead which would
                // otherwise jump to "main win..." because it starts with 'm'.
                const tag = (e.target as HTMLElement | null)?.tagName?.toUpperCase?.();
                if (tag === 'INPUT' || tag === 'TEXTAREA'
                    || (e.target as HTMLElement | null)?.isContentEditable === true) {
                    return;
                }
                if (tag === 'SELECT') {
                    e.preventDefault();
                    (e.target as HTMLSelectElement).blur();
                }
                this.toggleSettingsPanel();
            }

            // Film Maker shortcuts (only when the Film Maker tab is active and the
            // focus is not an editable field).
            if (this.filmMakerTabActive && !isEditable(e.target)) {
                if (e.key === ' ' || e.code === 'Space') {
                    e.preventDefault();
                    this.addKeyFrameFromCamera();
                } else if (e.key === 'Delete') {
                    e.preventDefault();
                    this.deleteCurrentKeyFrame();
                }
            }
        });

        window.addEventListener('keyup', (e: KeyboardEvent) => {
            this.activeKeys.delete(e.key.toLowerCase());
            if (e.key === 'Shift') this.shiftPressed = false;
            if (e.key === 'Control' || e.key === 'Meta') this.ctrlPressed = false;
        });
    }

    updateMovement() {
        if (this.activeKeys.size === 0) return;
        const rotSpeed = 0.5;
        const transSpeed = Math.max(this.cameraDist * 0.005, 0.1);

        if (this.activeKeys.has('arrowup')) {
            if (this.shiftPressed) this.rotateKeepCamPos(rotSpeed * Math.PI / 180, 0, 0);
            else this.rotateCam(rotSpeed * Math.PI / 180, 0, 0);
        }
        if (this.activeKeys.has('arrowdown')) {
            if (this.shiftPressed) this.rotateKeepCamPos(-rotSpeed * Math.PI / 180, 0, 0);
            else this.rotateCam(-rotSpeed * Math.PI / 180, 0, 0);
        }
        if (this.activeKeys.has('arrowleft')) {
            if (this.shiftPressed) this.rotateKeepCamPos(0, 0, rotSpeed * Math.PI / 180);
            else this.rotateCam(0, 0, rotSpeed * Math.PI / 180);
        }
        if (this.activeKeys.has('arrowright')) {
            if (this.shiftPressed) this.rotateKeepCamPos(0, 0, -rotSpeed * Math.PI / 180);
            else this.rotateCam(0, 0, -rotSpeed * Math.PI / 180);
        }

        if (this.activeKeys.has('z') || this.activeKeys.has('x')) {
            const Rwc = eulerToMatrix(this.euler[0], this.euler[1], this.euler[2]);
            if (this.activeKeys.has('z')) this.translateCam(new THREE.Vector3(0, 0, -transSpeed).applyMatrix4(Rwc));
            if (this.activeKeys.has('x')) this.translateCam(new THREE.Vector3(0, 0, transSpeed).applyMatrix4(Rwc));
        }

        if (this.activeKeys.has('w') || this.activeKeys.has('a') ||
            this.activeKeys.has('s') || this.activeKeys.has('d')) {
            const Rz = eulerToMatrix(0, 0, this.euler[2]);
            if (this.activeKeys.has('w')) this.translateCam(new THREE.Vector3(0, transSpeed, 0).applyMatrix4(Rz));
            if (this.activeKeys.has('s')) this.translateCam(new THREE.Vector3(0, -transSpeed, 0).applyMatrix4(Rz));
            if (this.activeKeys.has('a')) this.translateCam(new THREE.Vector3(-transSpeed, 0, 0).applyMatrix4(Rz));
            if (this.activeKeys.has('d')) this.translateCam(new THREE.Vector3(transSpeed, 0, 0).applyMatrix4(Rz));
        }
    }

    // ========== Center Point Visualization ==========

    createCenterPoint() {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
        const mat = new THREE.PointsMaterial({ color: 0xff0000, size: 8, sizeAttenuation: false });
        this.centerPointMesh = new THREE.Points(geo, mat);
        this.centerPointMesh.visible = false;
        this.scene.add(this.centerPointMesh);
    }

    // ========== Settings Panel (matching q3dviewer SettingWindow) ==========

    createSettingsPanel() {
        const panel = document.createElement('div');
        panel.style.cssText = `
            position: absolute; top: 10px; left: 10px;
            background: rgba(20,20,20,0.92); color: #eee;
            padding: 12px; border-radius: 8px;
            font-family: monospace; font-size: 12px;
            z-index: 1100; width: 260px;
            display: block; max-height: calc(100% - 20px); overflow-y: auto;
            border: 1px solid #555;
        `;

        // Title
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 14px; font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid #555; padding-bottom: 4px;';
        title.textContent = 'Settings (M to toggle)';
        panel.appendChild(title);

        // Item selector (combo box matching SettingWindow)
        const select = document.createElement('select');
        select.style.cssText = 'width: 100%; margin-bottom: 8px; background: #333; color: #eee; border: 1px solid #666; padding: 4px; border-radius: 3px;';
        select.onchange = () => this.onSettingsItemSelected(select.value);
        panel.appendChild(select);
        this.settingsItemSelect = select;

        // Item settings content (matches SettingWindow.layout)
        const content = document.createElement('div');
        content.style.cssText = 'border: 1px solid #444; border-radius: 4px; padding: 8px;';
        panel.appendChild(content);
        this.settingsContent = content;

        this.container.appendChild(panel);
        this.settingsPanel = panel;
        this.refreshSettingsItemList();
    }

    toggleSettingsPanel() {
        if (!this.settingsPanel) return;
        const visible = this.settingsPanel.style.display !== 'none';
        this.settingsPanel.style.display = visible ? 'none' : 'block';
        if (!visible) {
            // Re-opening: if the previously-selected tab no longer exists
            // (e.g. the item was removed while the panel was hidden),
            // gracefully fall back to main_win. Otherwise keep whatever
            // content is already rendered so the user sees exactly what
            // they left behind (active tab, scroll position, in-progress
            // input values, etc.).
            const current = this.settingsItemSelect?.value;
            const exists = !!current && Array.from(this.settingsItemSelect!.options).some(o => o.value === current);
            if (!exists && this.settingsItemSelect) {
                this.settingsItemSelect.value = '__main_win__';
                this.onSettingsItemSelected('__main_win__');
            }
        }
    }

    refreshSettingsItemList(preferredSelection?: string) {
        if (!this.settingsItemSelect) return;
        const previousSelection = this.settingsItemSelect.value;
        this.rebuildSettingsItemOptions();
        const desired = preferredSelection ?? previousSelection;
        const exists = desired && Array.from(this.settingsItemSelect.options).some(opt => opt.value === desired);
        this.settingsItemSelect.value = exists ? desired! : '__main_win__';
        // Skip the content rebuild while the panel is hidden: we want the
        // user to see the same sub-panel they had open before closing, not
        // a freshly-rendered one. The rebuild will still happen the next
        // time the selector's onchange fires or when the panel is re-opened
        // with a stale selection.
        const visible = this.settingsPanel?.style.display !== 'none';
        if (visible) {
            this.onSettingsItemSelected(this.settingsItemSelect.value);
        }
    }

    /** Rebuild only the <option>s in the selector, without re-triggering onSettingsItemSelected. */
    private rebuildSettingsItemOptions() {
        if (!this.settingsItemSelect) return;
        this.settingsItemSelect.innerHTML = '';

        const mainOpt = document.createElement('option');
        mainOpt.value = '__main_win__';
        mainOpt.textContent = 'Viewer';
        this.settingsItemSelect.appendChild(mainOpt);

        const filmOpt = document.createElement('option');
        filmOpt.value = '__film_maker__';
        filmOpt.textContent = 'Film Maker';
        this.settingsItemSelect.appendChild(filmOpt);

        for (const name of Object.keys(this.items)) {
            if (this.hiddenSettingItems.has(name)) continue;
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            this.settingsItemSelect.appendChild(opt);
        }
    }

    onSettingsItemSelected(name: string) {
        if (!this.settingsContent) return;
        this.settingsContent.innerHTML = '';
        this.filmMakerTabActive = name === '__film_maker__';

        if (name === '__main_win__') {
            this.buildMainWinSettings(this.settingsContent);
            return;
        }
        if (name === '__film_maker__') {
            this.buildFilmMakerSettings(this.settingsContent);
            return;
        }

        const item = this.items[name];
        if (!item) return;
        this.buildItemSettings(item, this.settingsContent);
    }

    /** Build settings for "main win" matching GLWidget.add_setting */
    buildMainWinSettings(container: HTMLElement) {
        container.appendChild(this.makeLabel('Set background color:'));
        const colorInput = this.makeTextInput(this.colorStr, (val) => {
            try {
                const c = new THREE.Color(val);
                this.scene.background = c;
                this.colorStr = val;
                this.requestRender();
            } catch { /* ignore invalid */ }
        });
        colorInput.title = 'Use hex color, i.e. #FF4500';
        container.appendChild(colorInput);

        container.appendChild(this.makeCheckbox('Show Center Point', this.enableShowCenter, (v) => {
            this.enableShowCenter = v;
        }));
    }

    /** Build per-item settings matching each item's add_setting() */
    buildItemSettings(item: THREE.Object3D, container: HTMLElement) {
        if ('addSetting' in item && typeof (item as any).addSetting === 'function') {
            (item as any as SettingBuilder).addSetting(container);
            return;
        }

        // CloudItem settings (matching cloud_item.py add_setting)
        const mat = (item as any).material;
        if (mat && mat.uniforms) {
            this.buildCloudItemSettings(item, mat, container);
        }
    }

    /** Build CloudItem settings matching cloud_item.py add_setting */
    buildCloudItemSettings(item: THREE.Object3D, mat: any, container: HTMLElement) {
        const geometry = (item as any).geometry as THREE.BufferGeometry | undefined;
        const pointCount = geometry?.getAttribute('position')?.count;
        const pointTypeUniform = mat.uniforms.pointType;
        const pointSizeUniform = mat.uniforms.pointSize;
        const pixelRatio = this.getBaseRendererPixelRatio();
        const isPixelPointType = (value: number) => value < 0.5;
        const getSizeLabelText = () => {
            if (!pointTypeUniform) return 'Size:';
            return isPixelPointType(pointTypeUniform.value) ? 'Size (pixel):' : 'Size (cm):';
        };
        const getPointSizeInputValue = () => {
            if (!pointSizeUniform) return 0;
            return pointTypeUniform && isPixelPointType(pointTypeUniform.value)
                ? pointSizeUniform.value / pixelRatio
                : pointSizeUniform.value;
        };
        const setStoredPointSize = (value: number) => {
            if (!pointSizeUniform) return;
            pointSizeUniform.value = pointTypeUniform && isPixelPointType(pointTypeUniform.value)
                ? value * pixelRatio
                : value;
        };
        let sizeLabel: HTMLElement | null = null;
        let sizeInput: HTMLInputElement | null = null;

        if (typeof pointCount === 'number') {
            container.appendChild(this.makeLabel('Points:'));
            container.appendChild(this.makeStaticValue(`${pointCount.toLocaleString()} pts`));
        }

        if (pointTypeUniform) {
            container.appendChild(this.makeLabel('Point Type:'));
            container.appendChild(this.makeSelectInput(
                [
                    { label: 'pixels', value: '0' },
                    { label: 'flat squares', value: '1' },
                    { label: 'spheres', value: '2' },
                ],
                String(pointTypeUniform.value),
                (value) => {
                    const nextPointType = parseInt(value, 10);
                    const wasPixelPoint = isPixelPointType(pointTypeUniform.value);
                    const willPixelPoint = isPixelPointType(nextPointType);

                    if (pointSizeUniform) {
                        if (wasPixelPoint && !willPixelPoint) {
                            pointSizeUniform.value /= pixelRatio;
                        } else if (!wasPixelPoint && willPixelPoint) {
                            pointSizeUniform.value *= pixelRatio;
                        }
                    }

                    pointTypeUniform.value = nextPointType;
                    if (sizeLabel) sizeLabel.textContent = getSizeLabelText();
                    if (sizeInput) sizeInput.value = getPointSizeInputValue().toString();
                    mat.needsUpdate = true;
                    this.requestRender();
                }
            ));
        }

        if (pointSizeUniform) {
            sizeLabel = this.makeLabel(getSizeLabelText());
            container.appendChild(sizeLabel);
            sizeInput = this.makeNumberInput(
                getPointSizeInputValue(), 0, 100, 1,
                (v) => { setStoredPointSize(v); mat.needsUpdate = true; this.requestRender(); }
            );
            container.appendChild(sizeInput);
        }

        if (mat.uniforms.alpha) {
            container.appendChild(this.makeLabel('Alpha:'));
            container.appendChild(this.makeNumberInput(
                mat.uniforms.alpha.value, 0, 1, 0.01,
                (v) => {
                    mat.uniforms.alpha.value = v;
                    if (v >= 0.99) { mat.transparent = false; mat.depthWrite = true; }
                    else { mat.transparent = true; mat.depthWrite = false; }
                    mat.needsUpdate = true;
                    this.requestRender();
                }
            ));
        }

        if (mat.uniforms.colorMode) {
            container.appendChild(this.makeLabel('Color Mode:'));
            container.appendChild(this.makeSelectInput(
                [
                    { label: 'Intensity', value: '0' },
                    { label: 'RGB', value: '1' },
                    { label: 'Flat', value: '2' },
                ],
                String(mat.uniforms.colorMode.value),
                (value) => {
                    mat.uniforms.colorMode.value = parseInt(value, 10);
                    mat.needsUpdate = true;
                    this.requestRender();
                }
            ));
        }

        if (mat.uniforms.vmin && mat.uniforms.vmax) {
            container.appendChild(this.makeLabel('Vmin:'));
            container.appendChild(this.makeNumberInput(
                mat.uniforms.vmin.value, -100000, 100000, 1,
                (v) => { mat.uniforms.vmin.value = v; mat.needsUpdate = true; this.requestRender(); }
            ));
            container.appendChild(this.makeLabel('Vmax:'));
            container.appendChild(this.makeNumberInput(
                mat.uniforms.vmax.value, -100000, 100000, 1,
                (v) => { mat.uniforms.vmax.value = v; mat.needsUpdate = true; this.requestRender(); }
            ));
        }
    }

    // ========== Settings UI Helpers ==========

    private makeLabel(text: string): HTMLElement {
        const lbl = document.createElement('div');
        lbl.textContent = text;
        lbl.style.cssText = 'margin: 6px 0 2px 0; font-size: 11px; color: #ccc;';
        return lbl;
    }

    private makeStaticValue(text: string): HTMLElement {
        const value = document.createElement('div');
        value.textContent = text;
        value.style.cssText = 'width: 100%; box-sizing: border-box; background: #252525; color: #eee; border: 1px solid #444; padding: 3px 6px; border-radius: 3px; margin-bottom: 4px;';
        return value;
    }

    private makeTextInput(defaultVal: string, onChange: (val: string) => void): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = defaultVal;
        input.style.cssText = 'width: 100%; box-sizing: border-box; background: #333; color: #eee; border: 1px solid #666; padding: 3px 6px; border-radius: 3px; margin-bottom: 4px;';
        input.onchange = () => onChange(input.value);
        return input;
    }

    private makeSelectInput(options: Array<{ label: string; value: string }>, selectedValue: string, onChange: (value: string) => void): HTMLSelectElement {
        const select = document.createElement('select');
        select.style.cssText = 'width: 100%; box-sizing: border-box; background: #333; color: #eee; border: 1px solid #666; padding: 3px 6px; border-radius: 3px; margin-bottom: 4px;';
        for (const option of options) {
            const el = document.createElement('option');
            el.value = option.value;
            el.textContent = option.label;
            el.selected = option.value === selectedValue;
            select.appendChild(el);
        }
        select.onchange = () => onChange(select.value);
        return select;
    }

    private makeNumberInput(value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'number';
        input.value = value.toString();
        input.min = min.toString();
        input.max = max.toString();
        input.step = step.toString();
        input.style.cssText = 'width: 100%; box-sizing: border-box; background: #333; color: #eee; border: 1px solid #666; padding: 3px 6px; border-radius: 3px; margin-bottom: 4px;';
        input.onchange = () => { const v = parseFloat(input.value); if (!isNaN(v)) onChange(v); };
        return input;
    }

    private makeCheckbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; margin: 6px 0;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.onchange = () => onChange(cb.checked);
        const lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.style.marginLeft = '6px';
        row.appendChild(cb);
        row.appendChild(lbl);
        return row;
    }

    // ========== Film Maker ==========

    /** Compute the current camera Twc (world-from-camera) from camera.matrixWorld. */
    private currentCameraTwc(): THREE.Matrix4 {
        this.camera.updateMatrixWorld();
        return this.camera.matrixWorld.clone();
    }

    addKeyFrameFromCamera(): KeyFrame {
        const Twc = this.currentCameraTwc();
        const kf = this.filmMaker.addKeyFrame(Twc);
        this.scene.add(kf.item);
        this.refreshFilmMakerList();
        this.highlightSelectedKeyFrame();
        this.requestRender();
        return kf;
    }

    deleteCurrentKeyFrame(): void {
        const idx = this.filmMaker.currentIndex;
        const removed = this.filmMaker.deleteKeyFrame(idx);
        if (removed) {
            this.scene.remove(removed.item);
            this.refreshFilmMakerList();
            this.highlightSelectedKeyFrame();
            this.requestRender();
        }
    }

    selectKeyFrame(index: number): void {
        this.filmMaker.select(index);
        this.highlightSelectedKeyFrame();
        this.syncFilmMakerSpinboxes();
        this.requestRender();
    }

    /** Jump the orbit camera to the selected keyframe's pose. */
    jumpToKeyFrame(index: number): void {
        const kf = this.filmMaker.keyFrames[index];
        if (!kf) return;
        const { center, euler } = recoverCenterEuler(kf.Twc, this.cameraDist);
        this.cameraCenter.copy(center);
        this.euler = [euler[0], euler[1], euler[2]];
        this.updateCamera();
    }

    private highlightSelectedKeyFrame() {
        const sel = this.filmMaker.currentIndex;
        this.filmMaker.keyFrames.forEach((kf, i) => {
            if (i === sel) {
                kf.item.setColor('#ff0000');
                kf.item.setLineWidth(5);
            } else {
                kf.item.setColor('#0000ff');
                kf.item.setLineWidth(3);
            }
        });
    }

    private refreshFilmMakerList() {
        if (!this.filmMakerListEl) return;
        this.filmMakerListEl.innerHTML = '';
        const sel = this.filmMaker.currentIndex;
        this.filmMaker.keyFrames.forEach((_kf, i) => {
            const row = document.createElement('div');
            row.textContent = `Frame ${i + 1}`;
            row.dataset.index = String(i);
            row.style.cssText = `padding: 3px 6px; cursor: pointer; border-radius: 3px; margin-bottom: 2px; ${
                i === sel ? 'background:#a33;color:#fff;' : 'background:#252525;color:#eee;'
            }`;
            row.addEventListener('click', () => {
                this.selectKeyFrame(i);
                this.refreshFilmMakerList();
            });
            row.addEventListener('dblclick', () => {
                this.jumpToKeyFrame(i);
            });
            this.filmMakerListEl!.appendChild(row);
        });
    }

    private filmMakerSpinLin: HTMLInputElement | null = null;
    private filmMakerSpinAng: HTMLInputElement | null = null;
    private filmMakerSpinStop: HTMLInputElement | null = null;

    private syncFilmMakerSpinboxes() {
        const kf = this.filmMaker.keyFrames[this.filmMaker.currentIndex];
        if (!kf) return;
        if (this.filmMakerSpinLin) this.filmMakerSpinLin.value = kf.linVel.toString();
        if (this.filmMakerSpinAng) this.filmMakerSpinAng.value = (kf.angVel * 180 / Math.PI).toFixed(2);
        if (this.filmMakerSpinStop) this.filmMakerSpinStop.value = kf.stopTime.toString();
    }

    private buildFilmMakerSettings(container: HTMLElement) {
        // Buttons
        const addBtn = this.makeButton('Add Key Frame (Space)', () => this.addKeyFrameFromCamera());
        container.appendChild(addBtn);
        const delBtn = this.makeButton('Delete Key Frame (Delete)', () => this.deleteCurrentKeyFrame());
        container.appendChild(delBtn);

        const playBtn = this.makeButton('Play', () => this.togglePlayback());
        this.filmMakerPlayBtn = playBtn;
        this.setFilmMakerPlayButtonState(this.isPlayingFilm);
        container.appendChild(playBtn);

        // Record checkbox
        const recordRow = this.makeCheckbox('Record', this.isRecordingFilm, (v) => {
            this.isRecordingFilm = v;
        });
        container.appendChild(recordRow);

        // Video filename
        container.appendChild(this.makeLabel('Video File Name:'));
        container.appendChild(this.makeTextInput(this.videoFileName, (val) => { this.videoFileName = val; }));

        // Codec / mimeType
        container.appendChild(this.makeLabel('Codec (MediaRecorder mimeType):'));
        const codecs = [
            'video/mp4;codecs=h264',
            'video/mp4;codecs=avc1',
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm;codecs=h264',
        ];
        container.appendChild(this.makeSelectInput(
            codecs.map((c) => ({ label: c, value: c })),
            this.videoMimeType,
            (val) => { this.videoMimeType = val; },
        ));

        // Download last recording button
        const dlBtn = this.makeButton('Download Last Recording', () => this.downloadLastRecording());
        container.appendChild(dlBtn);

        // Key frame list
        container.appendChild(this.makeLabel('Key Frames (double-click to jump):'));
        const list = document.createElement('div');
        list.style.cssText = 'max-height: 180px; overflow-y: auto; border: 1px solid #444; padding: 4px; border-radius: 3px; margin-bottom: 6px;';
        this.filmMakerListEl = list;
        container.appendChild(list);
        this.refreshFilmMakerList();

        // Velocity / stop-time spinboxes
        container.appendChild(this.makeLabel('Linear Velocity (m/s):'));
        this.filmMakerSpinLin = this.makeNumberInput(10, 0, 1000, 0.1, (v) => {
            this.filmMaker.setLinVel(this.filmMaker.currentIndex, v);
        });
        container.appendChild(this.filmMakerSpinLin);

        container.appendChild(this.makeLabel('Angular Velocity (deg/s):'));
        this.filmMakerSpinAng = this.makeNumberInput(60, 0, 360, 0.1, (v) => {
            this.filmMaker.setAngVel(this.filmMaker.currentIndex, v * Math.PI / 180);
        });
        container.appendChild(this.filmMakerSpinAng);

        container.appendChild(this.makeLabel('Stop Time (s):'));
        this.filmMakerSpinStop = this.makeNumberInput(0, 0, 100, 0.1, (v) => {
            this.filmMaker.setStopTime(this.filmMaker.currentIndex, v);
        });
        container.appendChild(this.filmMakerSpinStop);

        this.syncFilmMakerSpinboxes();
    }

    private makeButton(label: string, onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = 'width: 100%; box-sizing: border-box; background: #333; color: #eee; border: 1px solid #666; padding: 5px; border-radius: 3px; margin-bottom: 4px; cursor: pointer;';
        btn.addEventListener('click', onClick);
        return btn;
    }

    private getBaseRendererPixelRatio(): number {
        return Math.max(window.devicePixelRatio || 1, 1);
    }

    private applyRendererResolution(pixelRatio: number): void {
        this.rendererPixelRatio = Math.max(pixelRatio, 1);
        this.renderer.setPixelRatio(this.rendererPixelRatio);
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.syncAllCloudItemViewports();
        this.requestRender();
    }

    private restoreRendererResolution(): void {
        const basePixelRatio = this.getBaseRendererPixelRatio();
        if (Math.abs(this.rendererPixelRatio - basePixelRatio) > 1e-6) {
            this.applyRendererResolution(basePixelRatio);
        }
    }

    private getCloudViewportHeight(): number {
        return Math.max(this.container.clientHeight * this.rendererPixelRatio, 1);
    }

    private syncCloudItemViewport(item: THREE.Object3D): void {
        if (item instanceof CloudItem) {
            item.updateViewport(this.getCloudViewportHeight());
        }
    }

    private syncAllCloudItemViewports(): void {
        Object.values(this.items).forEach((item) => this.syncCloudItemViewport(item));
    }

    private setFilmMakerPlayButtonState(isPlaying: boolean): void {
        if (!this.filmMakerPlayBtn) return;
        this.filmMakerPlayBtn.textContent = isPlaying ? 'Playing' : 'Play';
        this.filmMakerPlayBtn.style.backgroundColor = isPlaying ? '#a33' : '#333';
        this.filmMakerPlayBtn.style.color = isPlaying ? '#fff' : '#eee';
        this.filmMakerPlayBtn.style.borderColor = isPlaying ? '#d66' : '#666';
    }

    togglePlayback() {
        if (this.isPlayingFilm) this.stopPlayback();
        else this.startPlayback();
    }

    startPlayback(): boolean {
        if (this.filmMaker.keyFrames.length < 2) return false;
        this.filmMaker.createFrames();
        if (this.filmMaker.frames.length === 0) return false;
        this.filmPlaybackIndex = 0;
        this.filmPlaybackAccumulatorMs = 0;
        this.filmPlaybackLastTimestamp = null;
        this.isPlayingFilm = true;
        this.setFilmMakerPlayButtonState(true);
        if (this.isRecordingFilm) this.startRecording();
        if (!this.advanceFilmPlaybackFrame()) return false;
        if (this.filmPlaybackIndex < this.filmMaker.frames.length) {
            this.scheduleFilmPlayback();
        }
        return true;
    }

    stopPlayback() {
        if (this.filmPlaybackRequestId != null) {
            cancelAnimationFrame(this.filmPlaybackRequestId);
            this.filmPlaybackRequestId = null;
        }
        this.filmPlaybackLastTimestamp = null;
        this.filmPlaybackAccumulatorMs = 0;
        this.isPlayingFilm = false;
        this.setFilmMakerPlayButtonState(false);
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.stopRecording();
        } else {
            this.restoreRendererResolution();
        }
    }

    private scheduleFilmPlayback(): void {
        this.filmPlaybackRequestId = requestAnimationFrame((timestamp) => this.tickFilmPlayback(timestamp));
    }

    private advanceFilmPlaybackFrame(): boolean {
        if (this.filmPlaybackIndex >= this.filmMaker.frames.length) {
            this.stopPlayback();
            return false;
        }
        const { keyIndex, Twc } = this.filmMaker.frames[this.filmPlaybackIndex];
        const { center, euler } = recoverCenterEuler(Twc, this.cameraDist);
        this.cameraCenter.copy(center);
        this.euler = [euler[0], euler[1], euler[2]];
        this.updateCamera();
        this.filmMaker.currentIndex = keyIndex;
        this.filmPlaybackIndex++;
        this.requestRender();
        return true;
    }

    private tickFilmPlayback(timestamp?: number) {
        if (timestamp === undefined) {
            this.advanceFilmPlaybackFrame();
            return;
        }
        if (!this.isPlayingFilm) return;
        if (this.filmPlaybackLastTimestamp == null) {
            this.filmPlaybackLastTimestamp = timestamp;
            this.scheduleFilmPlayback();
            return;
        }

        const stepMs = Math.max(this.filmMaker.updateIntervalMs, 1);
        this.filmPlaybackAccumulatorMs += Math.max(timestamp - this.filmPlaybackLastTimestamp, 0);
        this.filmPlaybackLastTimestamp = timestamp;

        while (this.filmPlaybackAccumulatorMs >= stepMs && this.isPlayingFilm) {
            this.filmPlaybackAccumulatorMs -= stepMs;
            if (!this.advanceFilmPlaybackFrame()) break;
        }

        if (this.isPlayingFilm) {
            this.scheduleFilmPlayback();
        }
    }

    private startRecording() {
        try {
            const captureCanvas = this.renderer.domElement as HTMLCanvasElement;
            if (!captureCanvas.captureStream) {
                console.warn('captureStream not supported');
                this.isRecordingFilm = false;
                return;
            }

            const recordingPixelRatio = Math.max(this.getBaseRendererPixelRatio(), this.recordingPixelRatioMin);
            if (recordingPixelRatio > this.rendererPixelRatio) {
                this.applyRendererResolution(recordingPixelRatio);
            }

            const stream = captureCanvas.captureStream(
                Math.max(30, Math.round(1000 / this.filmMaker.updateIntervalMs)),
            );
            if (!stream) {
                console.warn('captureStream not supported');
                this.isRecordingFilm = false;
                this.restoreRendererResolution();
                return;
            }
            const mimeType = MediaRecorder.isTypeSupported?.(this.videoMimeType)
                ? this.videoMimeType
                : '';
            this.recordedChunks = [];
            const recorderOptions: MediaRecorderOptions = {
                videoBitsPerSecond: this.recordingVideoBitsPerSecond,
            };
            if (mimeType) recorderOptions.mimeType = mimeType;
            this.mediaRecorder = new MediaRecorder(stream, recorderOptions);
            this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
                if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
            };
            this.mediaRecorder.onstop = () => {
                this.lastRecordedBlob = new Blob(this.recordedChunks, {
                    type: this.mediaRecorder?.mimeType || 'video/webm',
                });
            };
            this.mediaRecorder.start();
        } catch (err) {
            console.warn('Recording start failed:', err);
            this.isRecordingFilm = false;
            this.restoreRendererResolution();
        }
    }

    private stopRecording() {
        try {
            this.mediaRecorder?.stop();
        } catch (err) {
            console.warn('Recording stop failed:', err);
        } finally {
            this.restoreRendererResolution();
        }
    }

    downloadLastRecording(): boolean {
        if (!this.lastRecordedBlob) return false;
        const filename = this.videoFileName || 'q3dweb.mp4';
        const vscode = (this as any).vscode;
        if (vscode) {
            // In VS Code webview, <a download> is blocked by the webview sandbox.
            // Hand the bytes off to the extension host, which shows a Save dialog.
            this.lastRecordedBlob.arrayBuffer().then((buf) => {
                vscode.postMessage({
                    type: 'saveVideo',
                    data: new Uint8Array(buf),
                    filename,
                    mimeType: this.lastRecordedBlob?.type || 'video/webm',
                });
            }).catch((err) => {
                console.warn('Failed to read recorded blob:', err);
            });
            return true;
        }
        const url = URL.createObjectURL(this.lastRecordedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
    }

    // ========== Global Error Handler ==========

    installGlobalErrorHandler() {
        window.addEventListener('error', (event) => {
            console.error("Global error:", event.error);
            if (this.statusElement) {
                this.statusElement.textContent = `Global Error: ${event.message}`;
                this.statusElement.style.backgroundColor = 'rgba(255,0,0,0.8)';
            }
        });
        window.addEventListener('unhandledrejection', (event) => {
            console.error("Unhandled rejection:", event.reason);
            if (this.statusElement) {
                this.statusElement.textContent = `Async Error: ${event.reason}`;
                this.statusElement.style.backgroundColor = 'rgba(255,0,0,0.8)';
            }
        });
    }

    // ========== Drag and Drop ==========

    setupDragDrop() {
        const dropZone = this.container;
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e: Event) => { e.preventDefault(); e.stopPropagation(); }, false);
        });
        dropZone.addEventListener('drop', this.handleDrop.bind(this), false);
    }

    // VS Code Direct Load Entry Point
    loadData(content: Uint8Array, filename?: string) {
        try {
            const fmt = this.detectFormat(filename);
            if (!this.shouldDeferInitialMemoryCheck(fmt) && !this.checkMemoryBudget(content.byteLength, fmt, filename)) return;
            this.removeItem('cloud');
            console.log(`Loading Data directly: ${content.byteLength} bytes, file: ${filename || 'unknown'}`);
            this.startStream(content.byteLength, filename);
            this.processChunk(content, 0);
            if (!this.streamAborted) {
                this.finalizeStream();
            }
        } catch (err) {
            console.error("Error loading data:", err);
        }
    }

    async handleDrop(e: DragEvent) {
        if (!e.dataTransfer) return;
        const files = e.dataTransfer.files;
        for (let i = 0; i < files.length; i++) {
            await this.loadFile(files[i], i > 0);
        }
    }

    private detectFormat(filename?: string): 'pcd' | 'ply' | 'las' | 'laz' | 'e57' | 'unknown' {
        if (!filename) return 'pcd';
        const ext = '.' + filename.toLowerCase().split('.').pop();
        switch (ext) {
            case '.pcd': return 'pcd';
            case '.ply': return 'ply';
            case '.las': return 'las';
            case '.laz': return 'laz';
            case '.e57': return 'e57';
            default: return 'unknown';
        }
    }

    private shouldDeferInitialMemoryCheck(format: string): boolean {
        return format === 'pcd' || format === 'las';
    }

    private estimateVisiblePointBufferBytes(pointCount: number, hasRGB: boolean): number {
        const bytesPerPoint = (3 * Float32Array.BYTES_PER_ELEMENT)
            + Float32Array.BYTES_PER_ELEMENT
            + (hasRGB ? 3 : 0);
        const overheadBytes = 32 * 1024 * 1024;
        return pointCount * bytesPerPoint + overheadBytes;
    }

    private ensureStreamedPointBudget(pointCount: number, hasRGB: boolean, format: string, filename?: string): boolean {
        if (this.skipMemoryCheck) return true;

        const estimatedBytes = this.estimateVisiblePointBufferBytes(pointCount, hasRGB);
        const heapLimit = detectHeapLimit();
        const heapUsed = detectHeapUsed();
        const available = Math.max(heapLimit - heapUsed, 0);
        const budget = available > 0 ? available : heapLimit;

        let level: 'ok' | 'warn' | 'block' = 'ok';
        if (budget > 0) {
            const ratio = estimatedBytes / budget;
            if (ratio >= 0.9) level = 'block';
            else if (ratio >= 0.6) level = 'warn';
        }

        if (level === 'ok') return true;

        const label = filename ? `"${filename}"` : 'this file';
        const detail =
            `Estimated memory for sampled ${format.toUpperCase()} rendering buffers of ${label}: ` +
            `${formatBytes(estimatedBytes)} for ${pointCount.toLocaleString()} visible points` +
            `${hasRGB ? ' with RGB' : ''}. ` +
            `Available JS heap: ${formatBytes(budget)}` +
            (heapLimit > 0 ? ` (limit ${formatBytes(heapLimit)})` : '') + '.';

        if (level === 'block') {
            console.warn('[memoryCheck] blocked streamed load:', detail);
            if (typeof alert === 'function') alert(detail);
            this.abortStream(detail);
            return false;
        }

        console.warn('[memoryCheck] large streamed load warning:', detail);
        if (typeof confirm === 'function' && !confirm(`${detail}\n\nLoad anyway?`)) {
            this.abortStream(detail);
            return false;
        }
        return true;
    }

    private abortStream(message: string): void {
        this.streamAborted = true;
        this.leftoverChunk = null;
        this.chunkList = [];
        this.fullBuffer = null;
        this.fullBufferWriteOffset = 0;
        this.posBuffer = null;
        this.valBuffer = null;
        this.rgbBuffer = null;
        this.lasStream = null;
        if (this.loadingOverlay) {
            this.loadingOverlay.style.display = 'flex';
            this.loadingOverlay.innerHTML = `<div style="color: white; font-size: 24px; font-family: sans-serif; background: rgba(0,0,0,0.8); padding: 20px; border-radius: 8px;">Error: ${message}</div>`;
        }
    }

    async loadFile(file: File, append: boolean = false) {
        const filename = file.name.toLowerCase();
        const ext = '.' + filename.split('.').pop();
        if (!Viewer.SUPPORTED_EXTENSIONS.includes(ext)) {
            console.warn(`Unsupported file type: ${filename}`);
            return;
        }
        const fmt = this.detectFormat(file.name);
        if (!this.shouldDeferInitialMemoryCheck(fmt) && !this.checkMemoryBudget(file.size, fmt, file.name)) return;
        console.log(`Loading file (Stream): ${file.name}`);
        try {
            if (!append) this.removeItem('cloud');
            this.startStream(file.size, file.name);
            const stream = file.stream();
            // @ts-ignore
            const reader = stream.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    this.processChunk(value, 0);
                    if (this.streamAborted) {
                        if (typeof reader.cancel === 'function') {
                            await reader.cancel();
                        }
                        break;
                    }
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            if (!this.streamAborted) {
                this.finalizeStream();
            }
        } catch (err) {
            console.error(`Error loading ${file.name}:`, err);
        }
    }

    /**
     * Check whether we have enough JS heap to load a file of the given size.
     * Returns true if loading should proceed. Shows a confirmation dialog
     * when the risk is moderate and blocks (with an alert) when the estimate
     * exceeds the heap budget.
     */
    private checkMemoryBudget(fileSize: number, format: string, filename?: string): boolean {
        if (this.skipMemoryCheck) return true;
        const result = estimateMemoryRequirement(fileSize, format);
        if (result.level === 'ok') return true;

        const label = filename ? `"${filename}"` : 'this file';
        const header = result.level === 'block'
            ? `Cannot open ${label}: it likely exceeds the available browser memory.`
            : `Opening ${label} may exhaust browser memory.`;
        const detail = `${header}\n\n${result.message}`;

        if (result.level === 'block') {
            console.warn('[memoryCheck] blocked load:', detail);
            if (typeof alert === 'function') alert(detail);
            return false;
        }

        // warn -> ask the user to confirm
        console.warn('[memoryCheck] large file warning:', detail);
        if (typeof confirm === 'function') {
            return confirm(`${detail}\n\nLoad anyway?`);
        }
        return true;
    }

    // ========== Streaming Engine ==========

    startStream(totalSize: number, filename?: string) {
        this.streamFilename = filename;
        this.streamTotalSize = totalSize;
        this.streamLoadedSize = 0;
        this.streamAborted = false;
        this.pcdHeader = null;
        this.lasStream = null;
        this.leftoverChunk = null;
        this.pointsLoaded = 0;
        this.posIndex = 0;
        this.posBuffer = null;
        this.valBuffer = null;
        this.fullBuffer = null;
        this.rgbBuffer = null;
        this.fullBufferWriteOffset = 0;
        this.chunkList = [];
        this.currentFormat = this.detectFormat(filename);

        if (this.loadingOverlay) {
            this.loadingOverlay.style.display = 'flex';
            this.loadingOverlay.innerHTML = '<div style="color: white; font-size: 24px; font-family: sans-serif; background: rgba(0,0,0,0.8); padding: 20px; border-radius: 8px;">Preparing stream...</div>';
        }
    }

    processChunk(chunkData: Uint8Array, _offset: number) {
        try {
            if (this.streamAborted) return;
            this.streamLoadedSize += chunkData.byteLength;

            if (this.currentFormat === 'las') {
                this.processLASChunk(chunkData);
                const progress = this.streamTotalSize > 0
                    ? (this.streamLoadedSize / this.streamTotalSize) * 100
                    : 0;
                if (!this.streamAborted && this.loadingOverlay) {
                    this.loadingOverlay.innerHTML = `<div style="color: white; font-size: 24px; font-family: sans-serif; background: rgba(0,0,0,0.8); padding: 20px; border-radius: 8px;">Loading: ${progress.toFixed(1)}%</div>`;
                }
                return;
            }

            // For non-PCD formats, just accumulate all chunks (streamTotalSize may be inaccurate in some transports)
            if (this.currentFormat !== 'pcd') {
                // Defensive copy: postMessage may hand us a view whose underlying buffer gets reused by the host.
                const copy = new Uint8Array(chunkData.byteLength);
                copy.set(chunkData);
                this.chunkList.push(copy);
                this.fullBufferWriteOffset += chunkData.byteLength;
                const progress = this.streamTotalSize > 0
                    ? (this.streamLoadedSize / this.streamTotalSize) * 100
                    : 0;
                if (this.loadingOverlay) {
                    this.loadingOverlay.innerHTML = `<div style="color: white; font-size: 24px; font-family: sans-serif; background: rgba(0,0,0,0.8); padding: 20px; border-radius: 8px;">Loading: ${progress.toFixed(1)}%</div>`;
                }
                return;
            }

            if (!this.pcdHeader) {
                if (this.leftoverChunk) {
                    const temp = new Uint8Array(this.leftoverChunk.byteLength + chunkData.byteLength);
                    temp.set(this.leftoverChunk);
                    temp.set(chunkData, this.leftoverChunk.byteLength);
                    chunkData = temp;
                    this.leftoverChunk = null;
                }

                const headerStr = new TextDecoder().decode(chunkData.slice(0, Math.min(chunkData.byteLength, 5000)));
                const headerEnd = headerStr.indexOf('DATA ');
                if (headerEnd !== -1) {
                    const nextLineIdx = headerStr.indexOf('\n', headerEnd);
                    if (nextLineIdx !== -1) {
                        this.parseHeader(headerStr.substring(0, nextLineIdx + 1));

                        if (this.pcdHeader!.data === 'binary') {
                            this.isBinary = true;
                            const totalPoints = this.pcdHeader!.points;
                            this.targetSampleRatio = totalPoints > this.MAX_POINTS_VISUAL
                                ? Math.ceil(totalPoints / this.MAX_POINTS_VISUAL) : 1;
                            const estimatedVisPoints = Math.ceil(totalPoints / this.targetSampleRatio);
                            const hasRGB = (this.pcdHeader!.offset['rgb'] !== undefined || this.pcdHeader!.offset['rgba'] !== undefined);
                            if (!this.ensureStreamedPointBudget(estimatedVisPoints, hasRGB, 'pcd', this.streamFilename)) {
                                return;
                            }
                            this.posBuffer = new Float32Array(estimatedVisPoints * 3);
                            this.valBuffer = new Float32Array(estimatedVisPoints);

                            this.rgbBuffer = hasRGB ? new Uint8Array(estimatedVisPoints * 3) : null;

                            if (this.statusElement) this.statusElement.textContent = `Streaming: ~${estimatedVisPoints.toLocaleString()} pts`;

                            const dataPayload = chunkData.subarray(this.pcdHeader!.headerLen);
                            this.processBinaryData(dataPayload);
                        } else {
                            this.isBinary = false;
                            if (!this.checkMemoryBudget(this.streamTotalSize || chunkData.byteLength, 'pcd', this.streamFilename)) {
                                this.abortStream(`Cannot open ${this.streamFilename ? `"${this.streamFilename}"` : 'this ASCII PCD file'} because it likely exceeds the available browser memory.`);
                                return;
                            }
                            this.fullBuffer = new Uint8Array(this.streamTotalSize);
                            this.fullBufferWriteOffset = 0;
                            this.fullBuffer.set(chunkData, 0);
                            this.fullBufferWriteOffset = chunkData.byteLength;
                        }
                    } else {
                        this.leftoverChunk = chunkData;
                    }
                } else {
                    this.leftoverChunk = chunkData;
                }
            } else {
                if (this.isBinary) {
                    if (this.leftoverChunk) {
                        const temp = new Uint8Array(this.leftoverChunk.byteLength + chunkData.byteLength);
                        temp.set(this.leftoverChunk);
                        temp.set(chunkData, this.leftoverChunk.byteLength);
                        this.leftoverChunk = null;
                        this.processBinaryData(temp);
                    } else {
                        this.processBinaryData(chunkData);
                    }
                } else {
                    if (this.fullBuffer) {
                        this.fullBuffer.set(chunkData, this.fullBufferWriteOffset);
                        this.fullBufferWriteOffset += chunkData.byteLength;
                    }
                }
            }

            const progress = (this.streamLoadedSize / this.streamTotalSize) * 100;
            if (!this.streamAborted && this.loadingOverlay) {
                this.loadingOverlay.innerHTML = `<div style="color: white; font-size: 24px; font-family: sans-serif; background: rgba(0,0,0,0.8); padding: 20px; border-radius: 8px;">Loading: ${progress.toFixed(1)}%</div>`;
            }
        } catch (e) {
            console.error("Chunk processing failed", e);
        }
    }

    parseHeader(headerStr: string) {
        const pcdHeader: any = { offset: {} };
        const lines = headerStr.split('\n');

        for (const rawLine of lines) {
            const line = rawLine.trim();
            const words = line.split(/\s+/).filter(x => x);
            if (words.length === 0) continue;
            switch (words[0]) {
                case 'WIDTH': pcdHeader.width = parseInt(words[1]); break;
                case 'HEIGHT': pcdHeader.height = parseInt(words[1]); break;
                case 'POINTS': pcdHeader.points = parseInt(words[1]); break;
                case 'DATA':
                    pcdHeader.data = words[1];
                    pcdHeader.headerLen = headerStr.length;
                    break;
            }
        }

        if (pcdHeader.points === undefined && pcdHeader.width !== undefined && pcdHeader.height !== undefined) {
            pcdHeader.points = pcdHeader.width * pcdHeader.height;
        }

        pcdHeader.rowSize = 16;

        const fieldsIdx = lines.findIndex(l => l.trimStart().startsWith('FIELDS'));
        const sizeIdx = lines.findIndex(l => l.trimStart().startsWith('SIZE'));
        const typeIdx = lines.findIndex(l => l.trimStart().startsWith('TYPE'));
        const countIdx = lines.findIndex(l => l.trimStart().startsWith('COUNT'));

        if (fieldsIdx >= 0 && sizeIdx >= 0 && typeIdx >= 0) {
            const fields = lines[fieldsIdx].trim().split(/\s+/).slice(1);
            const sizes = lines[sizeIdx].trim().split(/\s+/).slice(1).map(Number);
            const counts = countIdx >= 0
                ? lines[countIdx].trim().split(/\s+/).slice(1).map(Number)
                : new Array(fields.length).fill(1);
            const types = lines[typeIdx].trim().split(/\s+/).slice(1);
            pcdHeader.fields = fields;
            pcdHeader.counts = counts;
            pcdHeader.types = types;
            pcdHeader.sizes = sizes;
            let size = 0;
            pcdHeader.offset = {};
            for (let i = 0; i < fields.length; i++) {
                pcdHeader.offset[fields[i]] = size;
                size += sizes[i] * counts[i];
            }
            pcdHeader.rowSize = size;
        }

        this.pcdHeader = pcdHeader as PCDHeader;
        console.log("Parsed Header:", this.pcdHeader);
    }

    private getFieldSpec(fieldName: string): { offset: number; type: string; size: number; count: number } | null {
        if (!this.pcdHeader?.fields || !this.pcdHeader?.types || !this.pcdHeader?.sizes || !this.pcdHeader?.counts) {
            return null;
        }
        const idx = this.pcdHeader.fields.indexOf(fieldName);
        if (idx < 0) return null;
        return {
            offset: this.pcdHeader.offset[fieldName],
            type: this.pcdHeader.types[idx],
            size: this.pcdHeader.sizes[idx],
            count: this.pcdHeader.counts[idx],
        };
    }

    private readNumericValue(view: DataView, byteOffset: number, type: string, size: number): number {
        if (type === 'F' && size === 4) return view.getFloat32(byteOffset, true);
        if (type === 'F' && size === 8) return view.getFloat64(byteOffset, true);

        if (type === 'U' && size === 1) return view.getUint8(byteOffset);
        if (type === 'U' && size === 2) return view.getUint16(byteOffset, true);
        if (type === 'U' && size === 4) return view.getUint32(byteOffset, true);

        if (type === 'I' && size === 1) return view.getInt8(byteOffset);
        if (type === 'I' && size === 2) return view.getInt16(byteOffset, true);
        if (type === 'I' && size === 4) return view.getInt32(byteOffset, true);

        // Fallback for uncommon declarations.
        if (size === 4) return view.getFloat32(byteOffset, true);
        if (size === 2) return view.getUint16(byteOffset, true);
        return view.getUint8(byteOffset);
    }

    private readPackedRGB(view: DataView, byteOffset: number, type: string, size: number): number {
        // PCD often stores rgb as packed float32 bits; decode bytes as uint32 bit pattern.
        if (size === 4) return view.getUint32(byteOffset, true);
        const value = this.readNumericValue(view, byteOffset, type, size);
        return (value >>> 0);
    }

    private getAsciiFieldTokenIndex(fieldName: string): number | null {
        if (!this.pcdHeader?.fields || !this.pcdHeader?.counts) return null;

        let tokenIndex = 0;
        for (let i = 0; i < this.pcdHeader.fields.length; i++) {
            if (this.pcdHeader.fields[i] === fieldName) return tokenIndex;
            tokenIndex += this.pcdHeader.counts[i] ?? 1;
        }

        return null;
    }

    private parseAsciiNumericToken(token: string): number {
        const value = Number(token);
        return Number.isFinite(value) ? value : NaN;
    }

    private parseAsciiPackedRGB(token: string, type: string, size: number): number {
        const value = this.parseAsciiNumericToken(token);
        if (!Number.isFinite(value)) return 0;

        if (type === 'F' && size === 4) {
            const buffer = new ArrayBuffer(4);
            const view = new DataView(buffer);
            view.setFloat32(0, value, true);
            return view.getUint32(0, true);
        }

        return (Math.max(0, Math.trunc(value)) >>> 0);
    }

    private normalizeIntensityLikeQ3DViewer(values: Float32Array): void {
        let maxIntensity = 0;
        for (let i = 0; i < values.length; i++) {
            const v = Math.max(0, Math.trunc(values[i]));
            values[i] = v;
            if (v > maxIntensity) maxIntensity = v;
        }

        // Match load_pcd: normalize only when max intensity is larger than 255.
        if (maxIntensity > 255) {
            const scale = 255 / maxIntensity;
            for (let i = 0; i < values.length; i++) {
                values[i] = Math.trunc(values[i] * scale);
            }
        }
    }

    private parseLASMetadata(data: Uint8Array): LASMetadata {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        if (magic !== 'LASF') throw new Error('Not a valid LAS file');

        const versionMajor = view.getUint8(24);
        const versionMinor = view.getUint8(25);
        const offsetToPointData = view.getUint32(96, true);
        const pointDataRecordFormat = view.getUint8(104);
        const pointDataRecordLength = view.getUint16(105, true);

        let numberOfPoints: number;
        if (versionMajor === 1 && versionMinor >= 4) {
            const legacyCount = view.getUint32(107, true);
            const count64Low = view.getUint32(247, true);
            numberOfPoints = count64Low > 0 ? count64Low : legacyCount;
        } else {
            numberOfPoints = view.getUint32(107, true);
        }

        const xScale = view.getFloat64(131, true);
        const yScale = view.getFloat64(139, true);
        const zScale = view.getFloat64(147, true);
        const xOff = view.getFloat64(155, true);
        const yOff = view.getFloat64(163, true);
        const zOff = view.getFloat64(171, true);

        const hasRGB = [2, 3, 5, 7, 8, 10].includes(pointDataRecordFormat);
        let rgbOffset = -1;
        if (hasRGB) {
            switch (pointDataRecordFormat) {
                case 2: rgbOffset = 20; break;
                case 3: rgbOffset = 28; break;
                case 5: rgbOffset = 28; break;
                case 7: rgbOffset = 30; break;
                case 8: rgbOffset = 30; break;
                case 10: rgbOffset = 30; break;
            }
        }

        console.log(`LAS ${versionMajor}.${versionMinor}, Format ${pointDataRecordFormat}, ` +
            `${numberOfPoints} points, Record Length ${pointDataRecordLength}`);

        const geo = parseLASGeoInfo(data);
        const bounds = readLASBounds(data) as LASBounds | null;
        let originLatLon: [number, number] | null = null;
        let shiftX = 0;
        let shiftY = 0;
        if (geo && bounds) {
            const cx = (bounds.minX + bounds.maxX) / 2;
            const cy = (bounds.minY + bounds.maxY) / 2;
            if (geo.epsg !== undefined) {
                originLatLon = projToLatLon(geo.epsg, cx, cy);
            }
            if (!originLatLon && geo.wkt) {
                const key = registerWKT(geo.wkt, '__LAS_WKT__');
                if (key) originLatLon = convertByKey(key, cx, cy);
            }
            if (originLatLon) {
                shiftX = cx;
                shiftY = cy;
                console.log(`LAS georef: EPSG=${geo.epsg ?? 'wkt'} (${geo.asciiParams ?? ''}), ` +
                    `centre=(${originLatLon[0].toFixed(6)}, ${originLatLon[1].toFixed(6)})`);
            } else if (geo.epsg !== undefined) {
                console.warn(`LAS georef EPSG:${geo.epsg} not supported for overlay.`);
            }
        }

        return {
            versionMajor,
            versionMinor,
            offsetToPointData,
            pointDataRecordFormat,
            pointDataRecordLength,
            numberOfPoints,
            xScale,
            yScale,
            zScale,
            xOff,
            yOff,
            zOff,
            hasRGB,
            rgbOffset,
            shiftX,
            shiftY,
            originLatLon,
            bounds,
        };
    }

    private addLASOverlay(originLatLon: [number, number], bounds: LASBounds): void {
        this.removeItem('gnss');
        const sizeMeters = Math.max(
            Math.abs(bounds.maxX - bounds.minX),
            Math.abs(bounds.maxY - bounds.minY),
            50
        );
        const latRad = originLatLon[0] * Math.PI / 180;
        const targetTile = Math.max(sizeMeters / 3, 20);
        const z = Math.max(
            1,
            Math.min(19, Math.round(Math.log2(40075016.686 * Math.cos(latRad) / targetTile)))
        );
        const tileSide = 40075016.686 * Math.cos(latRad) / Math.pow(2, z);
        const tileRadius = Math.max(2, Math.min(6, Math.ceil(sizeMeters / tileSide) + 1));
        console.log(`GNSS overlay: zoom=${z}, tileRadius=${tileRadius}, cloudSize=${sizeMeters.toFixed(1)}m`);
        const gnss = new GNSSMapItem({
            altitude: bounds.minZ - 0.1,
            zoom: z,
            tileRadius,
            alpha: 0.9,
            showTrailControls: false,
        });
        gnss.renderCb = () => this.requestRender();
        gnss.addFix(originLatLon[0], originLatLon[1], 0);
        this.addItem('gnss', gnss);
        this.requestRender();
    }

    private processLASChunk(chunkData: Uint8Array): void {
        if (this.leftoverChunk) {
            const merged = new Uint8Array(this.leftoverChunk.byteLength + chunkData.byteLength);
            merged.set(this.leftoverChunk);
            merged.set(chunkData, this.leftoverChunk.byteLength);
            chunkData = merged;
            this.leftoverChunk = null;
        }

        if (!this.lasStream) {
            if (chunkData.byteLength < 227) {
                this.leftoverChunk = chunkData;
                return;
            }

            const view = new DataView(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength);
            const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
            if (magic !== 'LASF') {
                throw new Error('Not a valid LAS file');
            }

            const offsetToPointData = view.getUint32(96, true);
            if (offsetToPointData < 227) {
                throw new Error('Invalid LAS file: bad point-data offset');
            }
            if (chunkData.byteLength < offsetToPointData) {
                this.leftoverChunk = chunkData;
                return;
            }

            const meta = this.parseLASMetadata(chunkData.subarray(0, offsetToPointData));
            this.targetSampleRatio = meta.numberOfPoints > this.MAX_POINTS_VISUAL
                ? Math.ceil(meta.numberOfPoints / this.MAX_POINTS_VISUAL)
                : 1;
            const estimatedVisPoints = Math.ceil(meta.numberOfPoints / this.targetSampleRatio);
            const needsRGB = meta.hasRGB && meta.rgbOffset !== -1;
            if (!this.ensureStreamedPointBudget(estimatedVisPoints, needsRGB, 'las', this.streamFilename)) {
                return;
            }

            this.posBuffer = new Float32Array(estimatedVisPoints * 3);
            this.valBuffer = new Float32Array(estimatedVisPoints);
            this.rgbBuffer = needsRGB ? new Uint8Array(estimatedVisPoints * 3) : null;
            this.lasStream = { ...meta, rawPointIndex: 0 };
            if (this.statusElement) {
                this.statusElement.textContent = `Streaming: ~${estimatedVisPoints.toLocaleString()} pts`;
            }

            chunkData = chunkData.subarray(meta.offsetToPointData);
            if (chunkData.byteLength === 0) return;
        }

        this.processLASRecords(chunkData);
    }

    private processLASRecords(data: Uint8Array): void {
        const meta = this.lasStream;
        if (!meta || !this.posBuffer || !this.valBuffer) return;

        const rowSize = meta.pointDataRecordLength;
        const count = Math.floor(data.byteLength / rowSize);
        if (count === 0) {
            this.leftoverChunk = data.byteLength > 0 ? data.slice() : null;
            return;
        }

        const usableBytes = count * rowSize;
        const view = new DataView(data.buffer, data.byteOffset, usableBytes);
        const rgbColors = this.rgbBuffer;

        for (let i = 0; i < count; i++) {
            const rawPointIndex = meta.rawPointIndex++;
            if (rawPointIndex % this.targetSampleRatio !== 0) continue;
            if (this.posIndex >= this.valBuffer.length) break;

            const recordStart = i * rowSize;
            const rawX = view.getInt32(recordStart, true);
            const rawY = view.getInt32(recordStart + 4, true);
            const rawZ = view.getInt32(recordStart + 8, true);
            const base = this.posIndex * 3;

            this.posBuffer[base] = rawX * meta.xScale + meta.xOff - meta.shiftX;
            this.posBuffer[base + 1] = rawY * meta.yScale + meta.yOff - meta.shiftY;
            this.posBuffer[base + 2] = rawZ * meta.zScale + meta.zOff;
            this.valBuffer[this.posIndex] = view.getUint16(recordStart + 12, true);

            if (rgbColors && meta.rgbOffset !== -1) {
                let r = view.getUint16(recordStart + meta.rgbOffset, true);
                let g = view.getUint16(recordStart + meta.rgbOffset + 2, true);
                let b = view.getUint16(recordStart + meta.rgbOffset + 4, true);
                if (r > 255 || g > 255 || b > 255) {
                    r = Math.floor(r / 256);
                    g = Math.floor(g / 256);
                    b = Math.floor(b / 256);
                }
                rgbColors[base] = r;
                rgbColors[base + 1] = g;
                rgbColors[base + 2] = b;
            }

            this.posIndex++;
        }

        this.pointsLoaded = meta.rawPointIndex;
        const leftovers = data.byteLength - usableBytes;
        this.leftoverChunk = leftovers > 0 ? data.slice(usableBytes) : null;
    }

    // ========== PLY Parser ==========

    private assembleChunkList(): Uint8Array {
        if (this.chunkList.length === 0) return new Uint8Array(0);
        if (this.chunkList.length === 1) return this.chunkList[0];
        let total = 0;
        for (const c of this.chunkList) total += c.byteLength;
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of this.chunkList) {
            out.set(c, off);
            off += c.byteLength;
        }
        return out;
    }

    private parsePLY(data: Uint8Array) {
        // Find end_header in the ASCII header region
        const headerRegion = new TextDecoder().decode(data.subarray(0, Math.min(data.byteLength, 100000)));
        const endHeaderIdx = headerRegion.indexOf('end_header');
        if (endHeaderIdx === -1) throw new Error('Invalid PLY file: missing end_header');
        const nlIdx = headerRegion.indexOf('\n', endHeaderIdx);
        if (nlIdx === -1) throw new Error('Invalid PLY file: malformed end_header');
        const dataStartByte = nlIdx + 1; // byte offset = char offset for ASCII header

        const headerStr = headerRegion.substring(0, endHeaderIdx);
        const lines = headerStr.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('comment'));

        if (lines[0] !== 'ply') throw new Error('Not a PLY file');

        // Parse header
        let format = 'ascii';
        let vertexCount = 0;
        interface PLYProp { name: string; type: string; }
        const vertexProps: PLYProp[] = [];
        let currentElement = '';

        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts[0] === 'format') {
                format = parts[1];
            } else if (parts[0] === 'element') {
                currentElement = parts[1];
                if (currentElement === 'vertex') vertexCount = parseInt(parts[2]);
            } else if (parts[0] === 'property' && currentElement === 'vertex') {
                if (parts[1] === 'list') continue;
                vertexProps.push({ name: parts[2], type: parts[1] });
            }
        }

        console.log(`PLY: format=${format}, vertices=${vertexCount}, props=${vertexProps.map(p => p.name).join(',')}`);

        // Map property indices
        const propIndex: { [key: string]: number } = {};
        vertexProps.forEach((p, i) => { propIndex[p.name] = i; });

        if (!('x' in propIndex) || !('y' in propIndex) || !('z' in propIndex)) {
            throw new Error('PLY missing x/y/z properties');
        }

        const hasRed = 'red' in propIndex && 'green' in propIndex && 'blue' in propIndex;
        // Check for packed rgb float (PCL-style)
        const hasPackedRGB = 'rgb' in propIndex;
        const hasIntensity = 'intensity' in propIndex || 'scalar_intensity' in propIndex
            || 'scalar_Intensity' in propIndex || 'reflectance' in propIndex;
        const intensityName = 'intensity' in propIndex ? 'intensity'
            : 'scalar_intensity' in propIndex ? 'scalar_intensity'
            : 'scalar_Intensity' in propIndex ? 'scalar_Intensity'
            : 'reflectance';

        // Sampling
        const sampleRatio = vertexCount > this.MAX_POINTS_VISUAL
            ? Math.ceil(vertexCount / this.MAX_POINTS_VISUAL) : 1;
        const estimatedVisPoints = Math.ceil(vertexCount / sampleRatio);

        const positions = new Float32Array(estimatedVisPoints * 3);
        const values = new Float32Array(estimatedVisPoints);
        const rgbColors = (hasRed || hasPackedRGB) ? new Uint8Array(estimatedVisPoints * 3) : null;

        let parsedPoints = 0;

        if (format === 'ascii') {
            // Stream-parse line-by-line directly from the byte buffer to avoid
            // creating a multi-GB decoded string + split array for huge files.
            const bytes = data;
            const total = bytes.byteLength;
            const LF = 0x0A;
            let lineStart = dataStartByte;
            let vertexIndex = 0;
            let intensityIsFloat = false;
            let maxIntensityRaw = 0;

            const xIdx = propIndex['x'];
            const yIdx = propIndex['y'];
            const zIdx = propIndex['z'];
            const iIdx = hasIntensity ? propIndex[intensityName] : -1;
            const rIdx = hasRed ? propIndex['red'] : -1;
            const gIdx = hasRed ? propIndex['green'] : -1;
            const bIdx = hasRed ? propIndex['blue'] : -1;
            const rgbPackedIdx = hasPackedRGB ? propIndex['rgb'] : -1;
            const rgbPackedType = hasPackedRGB ? vertexProps[propIndex['rgb']].type : '';

            const decoder = new TextDecoder();
            // Small token buffer to reuse
            let lineBuf: Uint8Array;

            const processLine = (lineBytes: Uint8Array) => {
                // Strip trailing \r
                let end = lineBytes.byteLength;
                if (end > 0 && lineBytes[end - 1] === 0x0D) end--;
                if (end === 0) return;
                const lineStr = decoder.decode(lineBytes.subarray(0, end));
                if (!lineStr.trim()) return;
                const tokens = lineStr.split(/\s+/);
                // Leading whitespace yields an empty first token; handle that
                const offset = tokens[0] === '' ? 1 : 0;
                if (tokens.length - offset < vertexProps.length) return;

                if (vertexIndex % sampleRatio === 0 && parsedPoints < estimatedVisPoints) {
                    const base = parsedPoints * 3;
                    const x = parseFloat(tokens[xIdx + offset]);
                    const y = parseFloat(tokens[yIdx + offset]);
                    const z = parseFloat(tokens[zIdx + offset]);
                    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                        positions[base] = x;
                        positions[base + 1] = y;
                        positions[base + 2] = z;

                        if (iIdx >= 0) {
                            const v = parseFloat(tokens[iIdx + offset]);
                            if (Number.isFinite(v)) {
                                values[parsedPoints] = v;
                                if (!Number.isInteger(v)) intensityIsFloat = true;
                                const av = Math.abs(v);
                                if (av > maxIntensityRaw) maxIntensityRaw = av;
                            }
                        } else {
                            values[parsedPoints] = z;
                        }

                        if (rgbColors) {
                            if (hasRed) {
                                rgbColors[base] = parseInt(tokens[rIdx + offset]);
                                rgbColors[base + 1] = parseInt(tokens[gIdx + offset]);
                                rgbColors[base + 2] = parseInt(tokens[bIdx + offset]);
                            } else if (hasPackedRGB) {
                                const rgbInt = this.decodePLYPackedRGB(
                                    parseFloat(tokens[rgbPackedIdx + offset]),
                                    rgbPackedType);
                                rgbColors[base] = (rgbInt >> 16) & 0xFF;
                                rgbColors[base + 1] = (rgbInt >> 8) & 0xFF;
                                rgbColors[base + 2] = rgbInt & 0xFF;
                            }
                        }
                        parsedPoints++;
                    }
                }
                vertexIndex++;
            };

            for (let i = dataStartByte; i < total && vertexIndex < vertexCount; i++) {
                if (bytes[i] === LF) {
                    lineBuf = bytes.subarray(lineStart, i);
                    processLine(lineBuf);
                    lineStart = i + 1;
                }
            }
            // Handle trailing line without newline
            if (lineStart < total && vertexIndex < vertexCount) {
                lineBuf = bytes.subarray(lineStart, total);
                processLine(lineBuf);
            }

            console.log(`PLY ASCII parsed ${parsedPoints} points (from ${vertexIndex} vertices), intensityIsFloat=${intensityIsFloat}, maxIntensityRaw=${maxIntensityRaw}`);

            // If intensity is float (e.g. reflectance 0..1), rescale to 0..255
            // before normalizeIntensityLikeQ3DViewer would truncate floats to 0.
            if (hasIntensity && intensityIsFloat && maxIntensityRaw > 0 && maxIntensityRaw <= 1.0) {
                for (let i = 0; i < parsedPoints; i++) {
                    values[i] = Math.round(values[i] * 255);
                }
            }
        } else {
            // Binary (little or big endian)
            const isLE = format === 'binary_little_endian';
            const view = new DataView(data.buffer, data.byteOffset + dataStartByte, data.byteLength - dataStartByte);

            // Calculate byte offsets per property
            let vertexByteSize = 0;
            const propOffsets: number[] = [];
            for (const prop of vertexProps) {
                propOffsets.push(vertexByteSize);
                vertexByteSize += this.plyTypeSize(prop.type);
            }

            for (let i = 0; i < vertexCount; i += sampleRatio) {
                if (parsedPoints >= estimatedVisPoints) break;
                const rowOffset = i * vertexByteSize;
                if (rowOffset + vertexByteSize > view.byteLength) break;

                const base = parsedPoints * 3;
                positions[base] = this.readPLYValue(view, rowOffset + propOffsets[propIndex['x']], vertexProps[propIndex['x']].type, isLE);
                positions[base + 1] = this.readPLYValue(view, rowOffset + propOffsets[propIndex['y']], vertexProps[propIndex['y']].type, isLE);
                positions[base + 2] = this.readPLYValue(view, rowOffset + propOffsets[propIndex['z']], vertexProps[propIndex['z']].type, isLE);

                if (hasIntensity && intensityName in propIndex) {
                    values[parsedPoints] = this.readPLYValue(view, rowOffset + propOffsets[propIndex[intensityName]], vertexProps[propIndex[intensityName]].type, isLE);
                } else {
                    values[parsedPoints] = positions[base + 2];
                }

                if (rgbColors) {
                    if (hasRed) {
                        rgbColors[base] = this.readPLYValue(view, rowOffset + propOffsets[propIndex['red']], vertexProps[propIndex['red']].type, isLE);
                        rgbColors[base + 1] = this.readPLYValue(view, rowOffset + propOffsets[propIndex['green']], vertexProps[propIndex['green']].type, isLE);
                        rgbColors[base + 2] = this.readPLYValue(view, rowOffset + propOffsets[propIndex['blue']], vertexProps[propIndex['blue']].type, isLE);
                    } else if (hasPackedRGB) {
                        const floatVal = this.readPLYValue(view, rowOffset + propOffsets[propIndex['rgb']], vertexProps[propIndex['rgb']].type, isLE);
                        const rgbInt = this.decodePLYPackedRGB(floatVal, vertexProps[propIndex['rgb']].type);
                        rgbColors[base] = (rgbInt >> 16) & 0xFF;
                        rgbColors[base + 1] = (rgbInt >> 8) & 0xFF;
                        rgbColors[base + 2] = rgbInt & 0xFF;
                    }
                }

                parsedPoints++;
            }
        }

        this.pointsLoaded = parsedPoints;
        const actualPos = positions.subarray(0, parsedPoints * 3);
        const actualVal = values.subarray(0, parsedPoints);
        if (hasIntensity && intensityName in propIndex) this.normalizeIntensityLikeQ3DViewer(actualVal);
        const actualRGB = rgbColors ? rgbColors.subarray(0, parsedPoints * 3) : undefined;
        this.renderPoints(actualPos, actualVal, actualRGB);
    }

    private plyTypeSize(type: string): number {
        switch (type) {
            case 'char': case 'int8': return 1;
            case 'uchar': case 'uint8': return 1;
            case 'short': case 'int16': return 2;
            case 'ushort': case 'uint16': return 2;
            case 'int': case 'int32': case 'float': case 'float32': return 4;
            case 'uint': case 'uint32': return 4;
            case 'double': case 'float64': return 8;
            default: return 4;
        }
    }

    private readPLYValue(view: DataView, offset: number, type: string, isLE: boolean): number {
        switch (type) {
            case 'char': case 'int8': return view.getInt8(offset);
            case 'uchar': case 'uint8': return view.getUint8(offset);
            case 'short': case 'int16': return view.getInt16(offset, isLE);
            case 'ushort': case 'uint16': return view.getUint16(offset, isLE);
            case 'int': case 'int32': return view.getInt32(offset, isLE);
            case 'uint': case 'uint32': return view.getUint32(offset, isLE);
            case 'float': case 'float32': return view.getFloat32(offset, isLE);
            case 'double': case 'float64': return view.getFloat64(offset, isLE);
            default: return view.getFloat32(offset, isLE);
        }
    }

    private decodePLYPackedRGB(value: number, type: string): number {
        // PCL-style packed RGB: float whose bits encode uint32 (R<<16 | G<<8 | B)
        if (type === 'float' || type === 'float32') {
            const buf = new ArrayBuffer(4);
            const dv = new DataView(buf);
            dv.setFloat32(0, value, true);
            return dv.getUint32(0, true);
        }
        return (Math.max(0, Math.trunc(value)) >>> 0);
    }

    // ========== LAS Parser ==========

    private parseLAS(data: Uint8Array) {
        const meta = this.parseLASMetadata(data);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        // Sampling
        const sampleRatio = meta.numberOfPoints > this.MAX_POINTS_VISUAL
            ? Math.ceil(meta.numberOfPoints / this.MAX_POINTS_VISUAL) : 1;
        const estimatedVisPoints = Math.ceil(meta.numberOfPoints / sampleRatio);

        const positions = new Float32Array(estimatedVisPoints * 3);
        const intensityValues = new Float32Array(estimatedVisPoints);
        const rgbColors = meta.hasRGB && meta.rgbOffset !== -1 ? new Uint8Array(estimatedVisPoints * 3) : null;

        let parsedPoints = 0;
        for (let i = 0; i < meta.numberOfPoints; i += sampleRatio) {
            if (parsedPoints >= estimatedVisPoints) break;

            const recordStart = meta.offsetToPointData + i * meta.pointDataRecordLength;
            if (recordStart + meta.pointDataRecordLength > data.byteLength) break;

            // XYZ: int32 scaled values
            const rawX = view.getInt32(recordStart, true);
            const rawY = view.getInt32(recordStart + 4, true);
            const rawZ = view.getInt32(recordStart + 8, true);

            const base = parsedPoints * 3;
            positions[base] = rawX * meta.xScale + meta.xOff - meta.shiftX;
            positions[base + 1] = rawY * meta.yScale + meta.yOff - meta.shiftY;
            positions[base + 2] = rawZ * meta.zScale + meta.zOff;

            // Intensity: uint16 at offset 12
            intensityValues[parsedPoints] = view.getUint16(recordStart + 12, true);

            // RGB: uint16 per channel (16-bit), normalize to 8-bit
            if (rgbColors && meta.rgbOffset !== -1) {
                let r = view.getUint16(recordStart + meta.rgbOffset, true);
                let g = view.getUint16(recordStart + meta.rgbOffset + 2, true);
                let b = view.getUint16(recordStart + meta.rgbOffset + 4, true);
                if (r > 255 || g > 255 || b > 255) {
                    r = Math.floor(r / 256);
                    g = Math.floor(g / 256);
                    b = Math.floor(b / 256);
                }
                rgbColors[base] = r;
                rgbColors[base + 1] = g;
                rgbColors[base + 2] = b;
            }

            parsedPoints++;
        }

        this.pointsLoaded = parsedPoints;
        const actualPos = positions.subarray(0, parsedPoints * 3);
        const actualVal = intensityValues.subarray(0, parsedPoints);
        this.normalizeIntensityLikeQ3DViewer(actualVal);
        const actualRGB = rgbColors ? rgbColors.subarray(0, parsedPoints * 3) : undefined;
        this.renderPoints(actualPos, actualVal, actualRGB);

        // Overlay OSM tiles if we have georeference
        if (meta.originLatLon && meta.bounds) {
            this.addLASOverlay(meta.originLatLon, meta.bounds);
        }
    }

    /**
     * Parse a LAZ (LASzip-compressed LAS) file. Decompresses point records using laz-perf (WASM),
     * then reuses parseLAS() by stitching a synthetic LAS buffer with the decompressed payload.
     */
    private async parseLAZ(data: Uint8Array) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        if (magic !== 'LASF') throw new Error('Not a valid LAZ/LAS file');
        const offsetToPointData = view.getUint32(96, true);
        const pointDataRecordLength = view.getUint16(105, true);
        const compressedFormatByte = view.getUint8(104);
        // LAZ marks compression by setting high bits (usually bit 7) on format byte.
        const uncompressedFormat = compressedFormatByte & 0x3F;

        console.log(`LAZ: decompressing via laz-perf (format ${uncompressedFormat}, recordLen ${pointDataRecordLength})...`);
        const { createLazPerf } = await import('laz-perf/lib/web');
        // Vite emits the wasm to the bundle and returns a hashed URL via `?url`.
        const wasmUrl = (await import('laz-perf/lib/web/laz-perf.wasm?url')).default;
        const LazPerf: any = await (createLazPerf as any)({
            locateFile: (path: string) => path.endsWith('.wasm') ? wasmUrl : path,
        });
        const laszip = new LazPerf.LASZip();

        const dataPtr = LazPerf._malloc(data.byteLength);
        LazPerf.HEAPU8.set(data, dataPtr);
        try {
            laszip.open(dataPtr, data.byteLength);
            const count = laszip.getCount();
            const pointLen = laszip.getPointLength();
            const fmt = laszip.getPointFormat();
            console.log(`LAZ: ${count} points, pointLen=${pointLen}, fmt=${fmt}`);

            // Build synthetic LAS buffer: header (with format byte cleared) + decompressed points.
            const synthetic = new Uint8Array(offsetToPointData + count * pointLen);
            synthetic.set(data.subarray(0, offsetToPointData), 0);
            // Clear compression bits
            synthetic[104] = uncompressedFormat;
            // Ensure point record length matches the decompressed size
            new DataView(synthetic.buffer).setUint16(105, pointLen, true);

            const pointPtr = LazPerf._malloc(pointLen);
            try {
                let writeOff = offsetToPointData;
                for (let i = 0; i < count; i++) {
                    laszip.getPoint(pointPtr);
                    // Refetch HEAPU8 each iteration: WASM memory may grow and detach cached views.
                    synthetic.set(LazPerf.HEAPU8.subarray(pointPtr, pointPtr + pointLen), writeOff);
                    writeOff += pointLen;
                }
            } finally {
                LazPerf._free(pointPtr);
            }

            // Reuse LAS parser on the synthetic buffer.
            this.parseLAS(synthetic);
        } finally {
            try { laszip.delete(); } catch { /* ignore */ }
            LazPerf._free(dataPtr);
        }
    }

    /**
     * Parse an E57 file using `@tatsuya-ogawa/e57` (WASM). The WASM returns `Float32Array`
     * positions/colors directly (no intermediate text buffer, so it handles hundreds of MB
     * without blowing through JS string limits). Points are sampled to `MAX_POINTS_VISUAL`
     * and recentered around their mean to keep single-precision rendering stable.
     */
    private async parseE57(data: Uint8Array) {
        console.log(`E57: parsing ${data.byteLength} bytes via vendor/e57-wasm (cry-inc/e57)...`);
        const mod: any = await import('../vendor/e57-wasm/pkg/e57_wasm.js');
        const wasmUrl = (await import('../vendor/e57-wasm/pkg/e57_wasm_bg.wasm?url')).default;
        await mod.default({ module_or_path: wasmUrl });

        const pts = mod.parsePoints(data);
        const src = pts.positions as Float32Array;
        const colSrc = pts.colors as Float32Array;
        const intenSrc = pts.intensities as Float32Array;
        const totalPoints = pts.pointCount as number;
        const hasColor = pts.hasColor as boolean;
        const hasIntensity = pts.hasIntensity as boolean;

        const sampleRatio = totalPoints > this.MAX_POINTS_VISUAL
            ? Math.ceil(totalPoints / this.MAX_POINTS_VISUAL) : 1;
        const estimated = Math.ceil(totalPoints / sampleRatio);

        const positions = new Float32Array(estimated * 3);
        const intensity = new Float32Array(estimated);
        const rgbColors = hasColor ? new Uint8Array(estimated * 3) : undefined;

        // First pass: mean for recentering (use double to avoid precision loss).
        let sumX = 0, sumY = 0, sumZ = 0, n = 0;
        for (let i = 0; i < totalPoints; i += sampleRatio) {
            sumX += src[i * 3];
            sumY += src[i * 3 + 1];
            sumZ += src[i * 3 + 2];
            n++;
            if (n >= estimated) break;
        }
        const cx = n > 0 ? sumX / n : 0;
        const cy = n > 0 ? sumY / n : 0;
        const cz = n > 0 ? sumZ / n : 0;

        let parsed = 0;
        for (let i = 0; i < totalPoints; i += sampleRatio) {
            if (parsed >= estimated) break;
            const b = parsed * 3;
            positions[b]     = src[i * 3]     - cx;
            positions[b + 1] = src[i * 3 + 1] - cy;
            positions[b + 2] = src[i * 3 + 2] - cz;
            if (rgbColors) {
                rgbColors[b]     = Math.max(0, Math.min(255, Math.round(colSrc[i * 3]     * 255)));
                rgbColors[b + 1] = Math.max(0, Math.min(255, Math.round(colSrc[i * 3 + 1] * 255)));
                rgbColors[b + 2] = Math.max(0, Math.min(255, Math.round(colSrc[i * 3 + 2] * 255)));
            }
            if (hasIntensity) {
                // Library already normalizes intensity to [0, 1]. Scale to
                // 0..255 to match the downstream normalization pipeline used
                // by the other loaders (PCD/PLY/LAS/LAZ).
                intensity[parsed] = intenSrc[i] * 255;
            } else {
                intensity[parsed] = 0;
            }
            parsed++;
        }
        try { pts.free(); } catch { /* ignore */ }

        this.pointsLoaded = parsed;
        this.normalizeIntensityLikeQ3DViewer(intensity.subarray(0, parsed));
        this.renderPoints(
            positions.subarray(0, parsed * 3),
            intensity.subarray(0, parsed),
            rgbColors?.subarray(0, parsed * 3)
        );
        console.log(`E57: loaded ${parsed} / ${totalPoints} points (ratio 1:${sampleRatio}), hasColor=${hasColor}, hasIntensity=${hasIntensity}, recentered at (${cx.toFixed(2)}, ${cy.toFixed(2)}, ${cz.toFixed(2)})`);
    }

    private processAsciiData(data: Uint8Array) {
        if (!this.pcdHeader) return;

        const text = new TextDecoder().decode(data.subarray(this.pcdHeader.headerLen));
        const lines = text.split(/\r?\n/);
        const totalPoints = this.pcdHeader.points ?? lines.length;
        this.targetSampleRatio = totalPoints > this.MAX_POINTS_VISUAL
            ? Math.ceil(totalPoints / this.MAX_POINTS_VISUAL)
            : 1;

        const estimatedVisPoints = Math.ceil(totalPoints / this.targetSampleRatio);
        const positions = new Float32Array(estimatedVisPoints * 3);
        const values = new Float32Array(estimatedVisPoints);

        const intensitySpec = this.getFieldSpec('intensity');
        const intensityTokenIndex = this.getAsciiFieldTokenIndex('intensity');

        let rgbSpec = this.getFieldSpec('rgb');
        if (!rgbSpec) rgbSpec = this.getFieldSpec('rgba');
        let rgbTokenIndex = this.getAsciiFieldTokenIndex('rgb');
        if (rgbTokenIndex === null) rgbTokenIndex = this.getAsciiFieldTokenIndex('rgba');

        const rgbColors = rgbSpec && rgbTokenIndex !== null
            ? new Uint8Array(estimatedVisPoints * 3)
            : null;

        const xTokenIndex = this.getAsciiFieldTokenIndex('x');
        const yTokenIndex = this.getAsciiFieldTokenIndex('y');
        const zTokenIndex = this.getAsciiFieldTokenIndex('z');

        if (xTokenIndex === null || yTokenIndex === null || zTokenIndex === null) {
            throw new Error('ASCII PCD is missing x/y/z fields.');
        }

        let expectedTokenCount = 0;
        if (this.pcdHeader.fields && this.pcdHeader.counts) {
            for (let i = 0; i < this.pcdHeader.fields.length; i++) {
                expectedTokenCount += this.pcdHeader.counts[i] ?? 1;
            }
        }

        let parsedPoints = 0;
        for (let i = 0; i < lines.length; i += this.targetSampleRatio) {
            if (parsedPoints >= estimatedVisPoints) break;

            const line = lines[i].trim();
            if (!line || line.startsWith('#')) continue;

            const tokens = line.split(/\s+/);
            if (tokens.length < expectedTokenCount) continue;

            const x = this.parseAsciiNumericToken(tokens[xTokenIndex]);
            const y = this.parseAsciiNumericToken(tokens[yTokenIndex]);
            const z = this.parseAsciiNumericToken(tokens[zTokenIndex]);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

            const base = parsedPoints * 3;
            positions[base] = x;
            positions[base + 1] = y;
            positions[base + 2] = z;

            if (intensitySpec && intensityTokenIndex !== null) {
                values[parsedPoints] = this.parseAsciiNumericToken(tokens[intensityTokenIndex]);
            } else {
                values[parsedPoints] = z;
            }

            if (rgbColors && rgbSpec && rgbTokenIndex !== null) {
                const rgbInt = this.parseAsciiPackedRGB(tokens[rgbTokenIndex], rgbSpec.type, rgbSpec.size);
                rgbColors[base] = (rgbInt >> 16) & 0xFF;
                rgbColors[base + 1] = (rgbInt >> 8) & 0xFF;
                rgbColors[base + 2] = rgbInt & 0xFF;
            }

            parsedPoints++;
        }

        this.pointsLoaded = parsedPoints;

        const actualPos = positions.subarray(0, parsedPoints * 3);
        const actualVal = values.subarray(0, parsedPoints);
        if (intensitySpec && intensityTokenIndex !== null) {
            this.normalizeIntensityLikeQ3DViewer(actualVal);
        }

        let actualRGB: Uint8Array | undefined;
        if (rgbColors) actualRGB = rgbColors.subarray(0, parsedPoints * 3);

        this.renderPoints(actualPos, actualVal, actualRGB);
    }

    processBinaryData(data: Uint8Array) {
        if (!this.pcdHeader || !this.posBuffer) return;

        const rowSize = this.pcdHeader.rowSize;
        const totalBytes = data.byteLength;
        const count = Math.floor(totalBytes / rowSize);

        const xOff = this.pcdHeader.offset['x'] || 0;
        const yOff = this.pcdHeader.offset['y'] || 4;
        const zOff = this.pcdHeader.offset['z'] || 8;

        const intensitySpec = this.getFieldSpec('intensity');
        let valOff = intensitySpec ? intensitySpec.offset : -1;

        let rgbOff = this.pcdHeader.offset['rgb'];
        if (rgbOff === undefined) rgbOff = this.pcdHeader.offset['rgba'];
        if (rgbOff === undefined) rgbOff = -1;

        let rgbSpec = this.getFieldSpec('rgb');
        if (!rgbSpec) rgbSpec = this.getFieldSpec('rgba');

        const isStandardXYZ = (xOff === 0 && yOff === 4 && zOff === 8);
        const isFloatAligned = (rowSize % 4 === 0);
        const startIndex = (this.targetSampleRatio - (this.pointsLoaded % this.targetSampleRatio)) % this.targetSampleRatio;

        const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);

        if (isStandardXYZ && isFloatAligned) {
            const floatsPerRow = rowSize / 4;
            const floatCount = count * floatsPerRow;

            let floatView: Float32Array;
            let uint32View: Uint32Array | null = null;

            if (data.byteOffset % 4 === 0 && data.byteLength % 4 === 0) {
                floatView = new Float32Array(data.buffer, data.byteOffset, floatCount);
                if (rgbOff !== -1) uint32View = new Uint32Array(data.buffer, data.byteOffset, floatCount);
            } else {
                const aligned = new Uint8Array(data);
                floatView = new Float32Array(aligned.buffer, 0, floatCount);
                if (rgbOff !== -1) uint32View = new Uint32Array(aligned.buffer, 0, floatCount);
            }

            const valOffFloat = (valOff !== -1 && valOff % 4 === 0 && intensitySpec?.type === 'F' && intensitySpec?.size === 4)
                ? (valOff / 4) : -1;
            const rgbOffFloat = (rgbOff !== -1 && rgbOff % 4 === 0) ? (rgbOff / 4) : -1;
            const doRGB = (this.rgbBuffer !== null && rgbOffFloat !== -1 && uint32View !== null);

            for (let i = startIndex; i < count; i += this.targetSampleRatio) {
                if (this.posIndex >= this.posBuffer.length / 3) break;
                const base = i * floatsPerRow;
                this.posBuffer[this.posIndex * 3] = floatView[base];
                this.posBuffer[this.posIndex * 3 + 1] = floatView[base + 1];
                this.posBuffer[this.posIndex * 3 + 2] = floatView[base + 2];

                if (this.valBuffer) {
                    if (valOffFloat !== -1) {
                        this.valBuffer[this.posIndex] = floatView[base + valOffFloat];
                    } else if (intensitySpec && intensitySpec.count === 1) {
                        const val = this.readNumericValue(dataView, i * rowSize + valOff, intensitySpec.type, intensitySpec.size);
                        this.valBuffer[this.posIndex] = val;
                    } else {
                        this.valBuffer[this.posIndex] = floatView[base + 2];
                    }
                }

                if (doRGB) {
                    const rgbInt = uint32View![base + rgbOffFloat];
                    this.rgbBuffer![this.posIndex * 3] = (rgbInt >> 16) & 0xFF;
                    this.rgbBuffer![this.posIndex * 3 + 1] = (rgbInt >> 8) & 0xFF;
                    this.rgbBuffer![this.posIndex * 3 + 2] = (rgbInt) & 0xFF;
                } else if (this.rgbBuffer && rgbOff !== -1 && rgbSpec && rgbSpec.count === 1) {
                    const rgbInt = this.readPackedRGB(dataView, i * rowSize + rgbOff, rgbSpec.type, rgbSpec.size);
                    this.rgbBuffer[this.posIndex * 3] = (rgbInt >> 16) & 0xFF;
                    this.rgbBuffer[this.posIndex * 3 + 1] = (rgbInt >> 8) & 0xFF;
                    this.rgbBuffer[this.posIndex * 3 + 2] = (rgbInt) & 0xFF;
                }
                this.posIndex++;
            }
        } else {
            for (let i = startIndex; i < count; i += this.targetSampleRatio) {
                if (this.posIndex >= this.posBuffer.length / 3) break;
                const base = i * rowSize;
                const pIdx = this.posIndex * 3;
                this.posBuffer[pIdx] = dataView.getFloat32(base + xOff, true);
                this.posBuffer[pIdx + 1] = dataView.getFloat32(base + yOff, true);
                this.posBuffer[pIdx + 2] = dataView.getFloat32(base + zOff, true);

                if (this.valBuffer) {
                    if (intensitySpec && intensitySpec.count === 1 && valOff !== -1) {
                        const val = this.readNumericValue(dataView, base + valOff, intensitySpec.type, intensitySpec.size);
                        this.valBuffer[this.posIndex] = val;
                    } else {
                        this.valBuffer[this.posIndex] = this.posBuffer[pIdx + 2];
                    }
                }

                if (this.rgbBuffer && rgbOff !== -1 && rgbSpec && rgbSpec.count === 1) {
                    const rgbInt = this.readPackedRGB(dataView, base + rgbOff, rgbSpec.type, rgbSpec.size);
                    this.rgbBuffer[pIdx] = (rgbInt >> 16) & 0xFF;
                    this.rgbBuffer[pIdx + 1] = (rgbInt >> 8) & 0xFF;
                    this.rgbBuffer[pIdx + 2] = (rgbInt) & 0xFF;
                }
                this.posIndex++;
            }
        }

        this.pointsLoaded += count;
        const leftovers = totalBytes - (count * rowSize);
        this.leftoverChunk = leftovers > 0 ? data.slice(count * rowSize) : null;
    }

    finalizeStream() {
        console.log("Stream finished.");
        const reportFinalizeError = (e: any) => {
            console.error("Finalize Error", e);
            const message = e instanceof Error ? e.message : String(e);
            if (this.loadingOverlay) this.loadingOverlay.innerHTML = `<div style="color: white; font-size: 24px; font-family: sans-serif; background: rgba(0,0,0,0.8); padding: 20px; border-radius: 8px;">Error: ${message}</div>`;
        };
        try {
            if (this.streamAborted) return;
            // Route to format-specific parser
            if (this.currentFormat === 'las' && this.lasStream && this.posBuffer && this.valBuffer) {
                console.log(`LAS stream loaded: ${this.posIndex} points (sampled from ~${this.pointsLoaded})`);
                const actualPos = this.posBuffer.subarray(0, this.posIndex * 3);
                const actualVal = this.valBuffer.subarray(0, this.posIndex);
                this.normalizeIntensityLikeQ3DViewer(actualVal);
                const actualRGB = this.rgbBuffer ? this.rgbBuffer.subarray(0, this.posIndex * 3) : undefined;
                this.renderPoints(actualPos, actualVal, actualRGB);
                if (this.lasStream.originLatLon && this.lasStream.bounds) {
                    this.addLASOverlay(this.lasStream.originLatLon, this.lasStream.bounds);
                }
                this.lasStream = null;
                this.leftoverChunk = null;
                this.posBuffer = null;
                this.valBuffer = null;
                this.rgbBuffer = null;
            } else if (this.currentFormat === 'ply'
                || this.currentFormat === 'laz' || this.currentFormat === 'e57') {
                const assembled = this.assembleChunkList();
                if (assembled.byteLength === 0) {
                    throw new Error(`Empty ${this.currentFormat.toUpperCase()} stream`);
                }
                console.log(`${this.currentFormat.toUpperCase()} assembled bytes: ${assembled.byteLength}`);
                if (this.currentFormat === 'ply') this.parsePLY(assembled);
                else if (this.currentFormat === 'laz') { void this.parseLAZ(assembled).catch(reportFinalizeError); }
                else { void this.parseE57(assembled).catch(reportFinalizeError); }
                this.chunkList = [];
                this.fullBuffer = null;
            } else if (this.isBinary && this.posBuffer) {
                console.log(`Stream Loaded: ${this.posIndex} points (Sampled from ~${this.pointsLoaded})`);
                const actualPos = this.posBuffer.subarray(0, this.posIndex * 3);
                const actualVal = this.valBuffer!.subarray(0, this.posIndex);
                if (this.pcdHeader?.offset['intensity'] !== undefined) {
                    this.normalizeIntensityLikeQ3DViewer(actualVal);
                }
                let actualRGB: Uint8Array | undefined;
                if (this.rgbBuffer) actualRGB = this.rgbBuffer.subarray(0, this.posIndex * 3);
                this.renderPoints(actualPos, actualVal, actualRGB);
                this.posBuffer = null;
                this.valBuffer = null;
                this.rgbBuffer = null;
            } else if (this.fullBuffer && this.pcdHeader?.data === 'ascii') {
                this.processAsciiData(this.fullBuffer);
                this.fullBuffer = null;
            } else if (this.fullBuffer) {
                console.warn('binary_compressed PCD not supported in streaming mode.');
                if (this.loadingOverlay) {
                    this.loadingOverlay.innerHTML = '<div style="color: white; font-size: 24px; font-family: sans-serif; background: rgba(0,0,0,0.8); padding: 20px; border-radius: 8px;">binary_compressed PCD is not supported.</div>';
                }
                this.fullBuffer = null;
            }
        } catch (e: any) {
            reportFinalizeError(e);
        }
    }

    renderPoints(positions: Float32Array, values: Float32Array, rgbColors?: Uint8Array) {
        const count = values.length;

        let minVal = Infinity, maxVal = -Infinity;
        for (let i = 0; i < count; i += 1000) {
            const v = values[i];
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
        }
        if (minVal === Infinity) { minVal = 0; maxVal = 255; }
        if (minVal === maxVal) { minVal -= 1; maxVal += 1; }

        this.dataMin = minVal;
        this.dataMax = maxVal;

        // Auto-detect color mode (like CloudIOItem.load)
        let colorMode: 'I' | 'RGB' | 'FLAT' = 'I';
        if (rgbColors) {
            let hasRGB = false;
            for (let i = 0; i < Math.min(rgbColors.length, 3000); i += 3) {
                if (rgbColors[i] > 0 || rgbColors[i + 1] > 0 || rgbColors[i + 2] > 0) {
                    hasRGB = true;
                    break;
                }
            }
            if (hasRGB) colorMode = 'RGB';
        }

        const cloud = new CloudItem(positions, values, {
            size: 1.0 * window.devicePixelRatio,
            alpha: 0.1,
            colorMode: colorMode,
        }, colorMode === 'RGB' ? rgbColors : undefined);

        const material = cloud.material as CloudShaderMaterial;
        material.uniforms.vmin.value = minVal;
        material.uniforms.vmax.value = maxVal;

        cloud.name = "cloud";
        cloud.frustumCulled = false;
        cloud.geometry.computeBoundingBox();

        if (cloud.geometry.boundingBox) {
            const center = new THREE.Vector3();
            cloud.geometry.boundingBox.getCenter(center);
            this.cameraCenter.copy(center);
            const size = new THREE.Vector3();
            cloud.geometry.boundingBox.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            const fov = this.camera.fov * (Math.PI / 180);
            this.cameraDist = (maxDim / (2 * Math.tan(fov / 2))) * 1.5;
            this.euler = [Math.PI / 3, 0, Math.PI / 4];
            this.updateCamera();
        }

        this.addItem("cloud", cloud);

        if (this.statusElement) this.statusElement.textContent = `${count.toLocaleString()} points`;
        if (this.loadingOverlay) this.loadingOverlay.style.display = 'none';

        this.requestRender();
    }

    // ========== Item Management ==========

    addItem(name: string, object: THREE.Object3D) {
        if (this.items[name]) this.removeItem(name);
        this.items[name] = object;
        this.scene.add(object);
        this.syncCloudItemViewport(object);
        // Auto-switch to the newly-loaded cloud tab regardless of panel
        // visibility so that when the panel is re-opened with M the user
        // sees the cloud they just loaded rather than a stale fallback.
        // When hidden, refreshSettingsItemList only updates the option list
        // + selector value and does NOT re-render content, so this is safe.
        const preferredSelection = name === 'cloud'
            ? 'cloud'
            : this.settingsItemSelect?.value;
        this.refreshSettingsItemList(preferredSelection);
    }

    removeItem(name: string) {
        const item = this.items[name];
        if (item) {
            const currentSelection = this.settingsItemSelect?.value;
            this.scene.remove(item);
            if ((item as any).geometry && typeof (item as any).geometry.dispose === 'function') {
                (item as any).geometry.dispose();
            }
            if ((item as any).material) {
                const materials = Array.isArray((item as any).material) ? (item as any).material : [(item as any).material];
                materials.forEach((m: any) => { if (typeof m.dispose === 'function') m.dispose(); });
            }
            delete this.items[name];
            this.refreshSettingsItemList(currentSelection === name ? '__main_win__' : currentSelection);
        }
    }

    clearItems() {
        Object.keys(this.items).forEach(name => this.removeItem(name));
    }

    // ========== Rendering ==========

    onWindowResize() {
        if (!this.container) return;
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.updateProjectionMatrixLikeQ3DViewer();
        this.renderer.setPixelRatio(this.rendererPixelRatio);
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.syncAllCloudItemViewports();
        this.requestRender();
    }

    requestRender() {
        if (!this.renderRequested) {
            this.renderRequested = true;
            requestAnimationFrame(this.render.bind(this));
        }
    }

    startAnimationLoop() {
        const loop = () => {
            this.animationFrameId = requestAnimationFrame(loop);
            this.updateMovement();

            if (this.enableShowCenter && this.showCenter && this.centerPointMesh) {
                const pos = this.centerPointMesh.geometry.attributes.position;
                (pos.array as Float32Array).set([this.cameraCenter.x, this.cameraCenter.y, this.cameraCenter.z]);
                pos.needsUpdate = true;
                this.centerPointMesh.visible = true;
                this.showCenter = false;
                this.requestRender();
                setTimeout(() => {
                    if (this.centerPointMesh) this.centerPointMesh.visible = false;
                    this.requestRender();
                }, 500);
            }
        };
        loop();
    }

    render() {
        this.renderRequested = false;
        this.renderer.render(this.scene, this.camera);
    }
}
