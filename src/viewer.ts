import * as THREE from 'three';
import { AxisItem } from './items/AxisItem';
import { GridItem } from './items/GridItem';
import { Text2DItem } from './items/Text2DItem';
import { Text3DItem } from './items/Text3DItem';
import { eulerToMatrix4 } from './utils/maths';
import {
    makeLabel, makeTextInput, makeCheckbox, buildCloudItemSettings,
} from './viewer/settingsUI';
import {
    setupMouseControls as _setupMouse, setupKeyboardControls as _setupKeys, updateCameraMovement,
} from './viewer/mouseControls';
import {
    addMeasurementPoint as _addMeasure, removeMeasurementPoint as _removeMeasure,
    updateMeasurementMarker as _updateMeasureMarker,
} from './viewer/measurement';
import { CloudItem } from './items/CloudItem';

const wrapAngle = (a: number): number =>
    ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

interface SettingBuilder { addSetting(container: HTMLElement): void; }

let globalErrorViewer: Viewer | null = null;
let globalErrorHandlersInstalled = false;

export class Viewer {
    container: HTMLElement;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    items: { [name: string]: THREE.Object3D } = {};
    hiddenSettingItems: Set<string> = new Set();

    euler: [number, number, number] = [Math.PI / 3, 0, Math.PI / 4];
    cameraCenter: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
    cameraDist: number = 40;

    activeKeys: Set<string> = new Set();
    showCenter: boolean = false;
    enableShowCenter: boolean = true;
    mousePos: { x: number; y: number } | null = null;
    mouseButton: number = -1;
    shiftPressed: boolean = false;
    ctrlPressed: boolean = false;
    centerPointMesh: THREE.Points | null = null;
    settingsPanel: HTMLElement | null = null;
    settingsPanelMinimized: boolean = false;
    settingsPanelTitle: HTMLElement | null = null;
    settingsPanelToggleButton: HTMLButtonElement | null = null;
    settingsContent: HTMLElement | null = null;
    settingsItemSelect: HTMLSelectElement | null = null;
    statusElement: HTMLElement | null = null;
    loadingOverlay: HTMLElement;
    selectedPoints: THREE.Vector3[] = [];
    text2dItem: Text2DItem | null = null;

    renderRequested: boolean = false;
    animationFrameId: number = 0;
    colorStr: string = 'black';

    rendererPixelRatio: number = 1;
    isTouchPrimaryDevice: boolean = false;

    constructor(containerId: string) {
        const container = document.getElementById(containerId);
        if (!container) throw new Error(`Container ${containerId} not found`);
        this.container = container;
        this.isTouchPrimaryDevice = this.detectTouchPrimaryDevice();
        this.loadingOverlay = document.createElement('div');
        this.loadingOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:none;justify-content:center;align-items:center;z-index:1001;';
        this.loadingOverlay.innerHTML = '<div style="color:white;font-size:24px;font-family:sans-serif;background:rgba(0,0,0,0.8);padding:20px;border-radius:8px;">Loading...</div>';
        this.container.appendChild(this.loadingOverlay);
        this.installGlobalErrorHandler();
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x000000);
        this.camera = new THREE.PerspectiveCamera(60, this.container.clientWidth / this.container.clientHeight, 0.1, 1000);
        this.camera.up.set(0, 0, 1);
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.rendererPixelRatio = this.getBaseRendererPixelRatio();
        this.renderer.setPixelRatio(this.rendererPixelRatio);
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.domElement.tabIndex = 0;
        this.renderer.domElement.style.outline = 'none';
        this.container.appendChild(this.renderer.domElement);
        _setupMouse(this.renderer.domElement, this as any);
        _setupKeys(this as any);
        this.updateCamera();
        this.addDefaultItems();
        this.createCenterPoint();
        this.createSettingsPanel();
        window.addEventListener('resize', this.onWindowResize.bind(this), false);
        this.startAnimationLoop();
    }

    addDefaultItems() {
        const grid = new GridItem({ size: 1000, spacing: 20 });
        grid.renderCb = () => this.requestRender();
        this.addItem('grid', grid);
        this.addItem('axis', new AxisItem({ size: 0.5, width: 5 }));
        this.hiddenSettingItems.add('axis');
        this.text2dItem = new Text2DItem(this.container, {
            text: '', color: '#b3ffb3', fontSize: 14, anchor: 'top-right',
            pos: [16, 16], background: 'rgba(0,0,0,0.55)', padding: '8px 12px',
        });
        this.text2dItem.hide();
        this.hiddenSettingItems.add('text');
        this.addItem('marker', new Text3DItem());
        this.hiddenSettingItems.add('marker');
    }

    createCenterPoint() {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
        this.centerPointMesh = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xff0000, size: 8, sizeAttenuation: false }));
        this.centerPointMesh.visible = false;
        this.scene.add(this.centerPointMesh);
    }

    updateCamera() {
        const [roll, pitch, yaw] = this.euler;
        const Rwc = eulerToMatrix4(roll, pitch, yaw);
        const offset = new THREE.Vector3(0, 0, this.cameraDist).applyMatrix4(Rwc);
        this.camera.position.copy(this.cameraCenter.clone().add(offset));
        this.camera.up.copy(new THREE.Vector3(0, 1, 0).applyMatrix4(Rwc));
        this.camera.lookAt(this.cameraCenter);
        this.updateProjection();
        this.requestRender();
    }

    private updateProjection(): void {
        const w = Math.max(this.container.clientWidth, 1), h = Math.max(this.container.clientHeight, 1);
        const near = 40 * 0.001, far = 40 * 10000;
        const r = near * Math.tan(0.5 * THREE.MathUtils.degToRad(this.camera.fov));
        const t = r * h / Math.max(w, 1);
        this.camera.near = near; this.camera.far = far;
        this.camera.projectionMatrix.makePerspective(-r, r, t, -t, near, far);
        this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    }

    rotateCam(rx: number, ry: number, rz: number) {
        this.euler[0] = Math.max(0, Math.min(Math.PI, this.euler[0] + rx));
        this.euler[1] = wrapAngle(this.euler[1] + ry);
        this.euler[2] = wrapAngle(this.euler[2] + rz);
        this.updateCamera();
    }

    rotateKeepCamPos(rx: number, ry: number, rz: number) {
        const ne: [number, number, number] = [
            Math.max(0, Math.min(Math.PI, this.euler[0] + rx)),
            wrapAngle(this.euler[1] + ry),
            wrapAngle(this.euler[2] + rz),
        ];
        const RwcOld = eulerToMatrix4(this.euler[0], this.euler[1], this.euler[2]);
        const tco = new THREE.Vector3(0, 0, this.cameraDist);
        const twc = this.cameraCenter.clone().add(tco.clone().applyMatrix4(RwcOld));
        const RwcNew = eulerToMatrix4(ne[0], ne[1], ne[2]);
        this.cameraCenter.copy(twc.clone().sub(tco.clone().applyMatrix4(RwcNew)));
        this.euler = ne; this.updateCamera();
    }

    translateCam(trans: THREE.Vector3) { this.cameraCenter.add(trans); this.updateCamera(); }
    updateDist(delta: number) { this.cameraDist = Math.max(0.1, this.cameraDist + delta); this.updateCamera(); }
    updateMovement() { updateCameraMovement(this as any); }
    addMeasurementPoint(e: MouseEvent) { if (!this.isTouchPrimaryDevice) _addMeasure(e, this as any); }
    removeMeasurementPoint() { if (!this.isTouchPrimaryDevice) _removeMeasure(this as any); }
    updateMeasurementMarker() { _updateMeasureMarker(this as any); }

    createSettingsPanel() {
        const panel = document.createElement('div');
        panel.style.cssText = 'position:absolute;top:10px;left:10px;background:rgba(20,20,20,0.92);color:#eee;padding:12px;border-radius:8px;font-family:monospace;font-size:12px;z-index:1100;width:260px;display:block;max-height:calc(100% - 20px);overflow-y:auto;border:1px solid #555;';
        panel.setAttribute('data-minimized', 'false');
        const title = document.createElement('div');
        title.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;font-weight:bold;margin-bottom:8px;border-bottom:1px solid #555;padding-bottom:4px;';
        title.setAttribute('data-role', 'settings-panel-header');
        const toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.textContent = '-';
        toggleButton.title = 'Minimize menu';
        toggleButton.setAttribute('aria-label', 'Minimize menu');
        toggleButton.setAttribute('data-role', 'settings-minimize-button');
        toggleButton.style.cssText = 'flex:0 0 30px;width:30px;height:30px;line-height:26px;box-sizing:border-box;background:#333;color:#eee;border:1px solid #666;border-radius:4px;cursor:pointer;font-size:18px;font-family:monospace;padding:0;touch-action:manipulation;';
        toggleButton.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.toggleSettingsPanel(); });
        const titleText = document.createElement('span');
        titleText.textContent = 'Settings';
        titleText.setAttribute('data-role', 'settings-panel-title');
        title.appendChild(toggleButton);
        title.appendChild(titleText);
        panel.appendChild(title);
        this.settingsPanelTitle = titleText;
        this.settingsPanelToggleButton = toggleButton;
        const select = document.createElement('select');
        select.style.cssText = 'width:100%;margin-bottom:8px;background:#333;color:#eee;border:1px solid #666;padding:4px;border-radius:3px;';
        select.setAttribute('data-role', 'settings-item-select');
        select.onchange = () => this.onSettingsItemSelected(select.value);
        panel.appendChild(select);
        this.settingsItemSelect = select;
        const content = document.createElement('div');
        content.style.cssText = 'border:1px solid #444;border-radius:4px;padding:8px;';
        panel.appendChild(content);
        this.settingsContent = content;
        this.container.appendChild(panel);
        this.settingsPanel = panel;
        this.refreshSettingsItemList();
    }

    toggleSettingsPanel() {
        this.setSettingsPanelMinimized(!this.settingsPanelMinimized);
        if (!this.settingsPanelMinimized) this.onSettingsItemSelected(this.settingsItemSelect?.value ?? '__main_win__');
    }

    private setSettingsPanelMinimized(minimized: boolean): void {
        if (!this.settingsPanel || !this.settingsPanelToggleButton) return;
        this.settingsPanelMinimized = minimized;
        this.settingsPanel.setAttribute('data-minimized', minimized ? 'true' : 'false');
        for (let i = 1; i < this.settingsPanel.children.length; i++) {
            (this.settingsPanel.children[i] as HTMLElement).style.display = minimized ? 'none' : '';
        }
        this.settingsPanel.style.width = minimized ? '40px' : '260px';
        this.settingsPanel.style.height = minimized ? '40px' : '';
        this.settingsPanel.style.padding = minimized ? '0' : '12px';
        this.settingsPanel.style.maxHeight = minimized ? '40px' : 'calc(100% - 20px)';
        this.settingsPanel.style.overflow = minimized ? 'hidden' : 'auto';
        this.settingsPanel.style.background = minimized ? 'transparent' : 'rgba(20,20,20,0.92)';
        this.settingsPanel.style.border = minimized ? '0' : '1px solid #555';
        const header = this.settingsPanel.children[0] as HTMLElement;
        header.style.justifyContent = minimized ? 'center' : '';
        header.style.marginBottom = minimized ? '0' : '8px';
        header.style.borderBottom = minimized ? '0' : '1px solid #555';
        header.style.paddingBottom = minimized ? '0' : '4px';
        if (this.settingsPanelTitle) this.settingsPanelTitle.style.display = minimized ? 'none' : '';
        this.settingsPanelToggleButton.textContent = minimized ? '+' : '-';
        this.settingsPanelToggleButton.title = minimized ? 'Expand menu' : 'Minimize menu';
        this.settingsPanelToggleButton.setAttribute('aria-label', this.settingsPanelToggleButton.title);
        this.settingsPanelToggleButton.style.flex = '0 0 30px';
        this.settingsPanelToggleButton.style.width = '30px';
        this.settingsPanelToggleButton.style.height = '30px';
        this.settingsPanelToggleButton.style.lineHeight = '26px';
        this.settingsPanelToggleButton.style.border = '1px solid #666';
        this.settingsPanelToggleButton.style.borderRadius = '4px';
    }

    refreshSettingsItemList(preferredSelection?: string) {
        if (!this.settingsItemSelect) return;
        const prev = this.settingsItemSelect.value;
        this.settingsItemSelect.innerHTML = '';
        const mainOpt = document.createElement('option');
        mainOpt.value = '__main_win__'; mainOpt.textContent = 'Viewer';
        this.settingsItemSelect.appendChild(mainOpt);
        for (const name of Object.keys(this.items)) {
            if (this.hiddenSettingItems.has(name)) continue;
            const o = document.createElement('option'); o.value = name; o.textContent = name;
            this.settingsItemSelect.appendChild(o);
        }
        const desired = preferredSelection ?? prev;
        const exists = desired && Array.from(this.settingsItemSelect.options).some(o => o.value === desired);
        this.settingsItemSelect.value = exists ? desired! : '__main_win__';
        if (!this.settingsPanelMinimized)
            this.onSettingsItemSelected(this.settingsItemSelect.value);
    }

    onSettingsItemSelected(name: string) {
        if (!this.settingsContent) return;
        this.settingsContent.innerHTML = '';
        if (name === '__main_win__') {
            this.settingsContent.appendChild(makeLabel('Set background color:'));
            const inp = makeTextInput(this.colorStr, (val) => {
                try { this.scene.background = new THREE.Color(val); this.colorStr = val; this.requestRender(); } catch { /* ignore */ }
            });
            inp.title = 'Use hex color, i.e. #FF4500';
            this.settingsContent.appendChild(inp);
            this.settingsContent.appendChild(makeCheckbox('Show Center Point', this.enableShowCenter, (v) => { this.enableShowCenter = v; }));
            return;
        }
        const item = this.items[name];
        if (!item) return;
        if ('addSetting' in item && typeof (item as any).addSetting === 'function') {
            (item as any as SettingBuilder).addSetting(this.settingsContent); return;
        }
        const mat = (item as any).material;
        if (mat?.uniforms) buildCloudItemSettings(item, mat, this.settingsContent, this.getBaseRendererPixelRatio(), () => this.requestRender());
    }

    getBaseRendererPixelRatio(): number { return Math.max(window.devicePixelRatio || 1, 1); }
    private detectTouchPrimaryDevice(): boolean {
        const touchPoints = navigator.maxTouchPoints ?? 0;
        if (touchPoints <= 0) return false;
        const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches === true;
        const noHover = window.matchMedia?.('(hover: none)').matches === true;
        return coarsePointer || noHover;
    }
    private getCloudViewportHeight(): number { return Math.max(this.container.clientHeight * this.rendererPixelRatio, 1); }
    protected syncCloudItemViewport(item: THREE.Object3D) { if (item instanceof CloudItem) item.updateViewport(this.getCloudViewportHeight()); }
    protected syncAllCloudItemViewports() { Object.values(this.items).forEach(i => this.syncCloudItemViewport(i)); }

    applyRendererResolution(pixelRatio: number): void {
        this.rendererPixelRatio = Math.max(pixelRatio, 1);
        this.renderer.setPixelRatio(this.rendererPixelRatio);
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.syncAllCloudItemViewports();
        this.requestRender();
    }

    restoreRendererResolution(): void {
        const base = this.getBaseRendererPixelRatio();
        if (Math.abs(this.rendererPixelRatio - base) > 1e-6) this.applyRendererResolution(base);
    }

    installGlobalErrorHandler() {
        globalErrorViewer = this;
        if (globalErrorHandlersInstalled) return;
        globalErrorHandlersInstalled = true;
        window.addEventListener('error', (ev) => {
            console.error('Global error:', ev.error);
            ev.preventDefault();
            const viewer = globalErrorViewer;
            if (viewer?.statusElement) { viewer.statusElement.textContent = `Global Error: ${ev.message}`; viewer.statusElement.style.backgroundColor = 'rgba(255,0,0,0.8)'; }
        });
        window.addEventListener('unhandledrejection', (ev) => {
            console.error('Unhandled rejection:', ev.reason);
            ev.preventDefault();
            const viewer = globalErrorViewer;
            if (viewer?.statusElement) { viewer.statusElement.textContent = `Async Error: ${ev.reason}`; viewer.statusElement.style.backgroundColor = 'rgba(255,0,0,0.8)'; }
        });
    }

    addItem(name: string, object: THREE.Object3D) {
        if (this.items[name]) this.removeItem(name);
        this.items[name] = object;
        this.scene.add(object);
        this.syncCloudItemViewport(object);
        this.refreshSettingsItemList(name === 'cloud' ? 'cloud' : this.settingsItemSelect?.value);
    }

    removeItem(name: string) {
        const item = this.items[name];
        if (item) {
            const sel = this.settingsItemSelect?.value;
            this.scene.remove(item);
            if ((item as any).geometry?.dispose) (item as any).geometry.dispose();
            const mats = (item as any).material ? (Array.isArray((item as any).material) ? (item as any).material : [(item as any).material]) : [];
            mats.forEach((m: any) => { if (typeof m.dispose === 'function') m.dispose(); });
            delete this.items[name];
            this.refreshSettingsItemList(sel === name ? '__main_win__' : sel);
        }
    }

    clearItems() { Object.keys(this.items).forEach(name => this.removeItem(name)); }

    onWindowResize() {
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.updateProjection();
        this.renderer.setPixelRatio(this.rendererPixelRatio);
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.syncAllCloudItemViewports();
        this.requestRender();
    }

    requestRender() {
        if (!this.renderRequested) { this.renderRequested = true; requestAnimationFrame(this.render.bind(this)); }
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
                setTimeout(() => { if (this.centerPointMesh) this.centerPointMesh.visible = false; this.requestRender(); }, 500);
            }
        };
        loop();
    }

    render() { this.renderRequested = false; this.renderer.render(this.scene, this.camera); }
}