/**
 * Mouse / keyboard / movement input handlers.
 * Extracted from viewer.ts for modularity.
 */

import * as THREE from 'three';
import { eulerToMatrix4 } from '../utils/maths';

export interface InputContext {
    euler: [number, number, number];
    cameraCenter: THREE.Vector3;
    cameraDist: number;
    mousePos: { x: number; y: number } | null;
    mouseButton: number;
    shiftPressed: boolean;
    ctrlPressed: boolean;
    showCenter: boolean;
    activeKeys: Set<string>;
    filmMakerTabActive?: boolean;
    rendererPixelRatio: number;
    container: { clientWidth: number; clientHeight: number };
    camera: { fov: number };

    rotateCam(rx: number, ry: number, rz: number): void;
    rotateKeepCamPos(rx: number, ry: number, rz: number): void;
    translateCam(v: THREE.Vector3): void;
    updateDist(delta: number): void;
    toggleSettingsPanel(): void;
    addMeasurementPoint(e: MouseEvent): void;
    removeMeasurementPoint(): void;
    addKeyFrameFromCamera?(): void;
    deleteCurrentKeyFrame?(): void;
    requestRender(): void;
}

function isEditable(t: EventTarget | null): boolean {
    if (!t) return false;
    const el = t as HTMLElement;
    const tag = el.tagName?.toUpperCase?.();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

function getCameraK(ctx: InputContext): THREE.Matrix3 {
    const w = ctx.container.clientWidth * ctx.rendererPixelRatio;
    const h = ctx.container.clientHeight * ctx.rendererPixelRatio;
    const fovRad = ctx.camera.fov * Math.PI / 180;
    const fy = (h / 2) / Math.tan(fovRad / 2);
    const K = new THREE.Matrix3();
    K.set(fy, 0, w / 2, 0, fy, h / 2, 0, 0, 1);
    return K;
}

export function setupMouseControls(canvas: HTMLElement, ctx: InputContext): void {
    canvas.addEventListener('mousedown', (e: MouseEvent) => {
        ctx.mousePos = { x: e.clientX, y: e.clientY };
        ctx.mouseButton = e.button;
        ctx.shiftPressed = e.shiftKey;
        ctx.ctrlPressed = e.ctrlKey || e.metaKey;
        if (ctx.ctrlPressed && e.button === 0) { ctx.addMeasurementPoint(e); return; }
        if (ctx.ctrlPressed && e.button === 2) { ctx.removeMeasurementPoint(); return; }
        e.preventDefault();
        (canvas as HTMLElement & { focus?: () => void }).focus?.();
    });

    canvas.addEventListener('mousemove', (e: MouseEvent) => {
        if (ctx.mousePos === null || ctx.ctrlPressed) return;
        const dx = e.clientX - ctx.mousePos.x;
        const dy = e.clientY - ctx.mousePos.y;
        ctx.mousePos = { x: e.clientX, y: e.clientY };
        ctx.shiftPressed = e.shiftKey;

        if (ctx.mouseButton === 2) {
            const rotSpeed = 0.2;
            const dyaw  = (-dx * rotSpeed) * Math.PI / 180;
            const droll = (-dy * rotSpeed) * Math.PI / 180;
            if (ctx.shiftPressed) ctx.rotateKeepCamPos(droll, 0, dyaw);
            else ctx.rotateCam(droll, 0, dyaw);
        } else if (ctx.mouseButton === 0) {
            const Rwc    = eulerToMatrix4(ctx.euler[0], ctx.euler[1], ctx.euler[2]);
            const Kinv   = getCameraK(ctx).clone().invert();
            const dist   = Math.max(ctx.cameraDist, 0.5);
            const sv     = new THREE.Vector3(-dx, dy, 0);
            sv.applyMatrix3(Kinv).multiplyScalar(dist).applyMatrix4(Rwc);
            ctx.translateCam(sv);
        }
        ctx.showCenter = true;
        ctx.requestRender();
    });

    canvas.addEventListener('mouseup', () => { ctx.mousePos = null; ctx.mouseButton = -1; });
    canvas.addEventListener('mouseleave', () => { ctx.mousePos = null; ctx.mouseButton = -1; });
    canvas.addEventListener('wheel', (e: WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        ctx.updateDist(delta * ctx.cameraDist * 0.001);
        ctx.showCenter = true;
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function setupKeyboardControls(ctx: InputContext): void {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
        ctx.activeKeys.add(e.key.toLowerCase());
        if (e.key === 'Shift') ctx.shiftPressed = true;
        if (e.key === 'Control' || e.key === 'Meta') ctx.ctrlPressed = true;
        if (e.key.toLowerCase() === 'm') {
            const tag = (e.target as HTMLElement | null)?.tagName?.toUpperCase?.();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable === true) return;
            if (tag === 'SELECT') { e.preventDefault(); (e.target as HTMLSelectElement).blur(); }
            ctx.toggleSettingsPanel();
        }
        if (ctx.filmMakerTabActive && !isEditable(e.target)) {
            if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); ctx.addKeyFrameFromCamera?.(); }
            else if (e.key === 'Delete') { e.preventDefault(); ctx.deleteCurrentKeyFrame?.(); }
        }
    });
    window.addEventListener('keyup', (e: KeyboardEvent) => {
        ctx.activeKeys.delete(e.key.toLowerCase());
        if (e.key === 'Shift') ctx.shiftPressed = false;
        if (e.key === 'Control' || e.key === 'Meta') ctx.ctrlPressed = false;
    });
}

export function updateCameraMovement(ctx: InputContext): void {
    if (ctx.activeKeys.size === 0) return;
    const rotSpeed  = 0.5;
    const transSpeed = Math.max(ctx.cameraDist * 0.005, 0.1);

    if (ctx.activeKeys.has('arrowup'))    ctx.shiftPressed ? ctx.rotateKeepCamPos( rotSpeed * Math.PI / 180, 0, 0) : ctx.rotateCam( rotSpeed * Math.PI / 180, 0, 0);
    if (ctx.activeKeys.has('arrowdown'))  ctx.shiftPressed ? ctx.rotateKeepCamPos(-rotSpeed * Math.PI / 180, 0, 0) : ctx.rotateCam(-rotSpeed * Math.PI / 180, 0, 0);
    if (ctx.activeKeys.has('arrowleft'))  ctx.shiftPressed ? ctx.rotateKeepCamPos(0, 0, rotSpeed * Math.PI / 180)  : ctx.rotateCam(0, 0, rotSpeed * Math.PI / 180);
    if (ctx.activeKeys.has('arrowright')) ctx.shiftPressed ? ctx.rotateKeepCamPos(0, 0, -rotSpeed * Math.PI / 180) : ctx.rotateCam(0, 0, -rotSpeed * Math.PI / 180);

    if (ctx.activeKeys.has('z') || ctx.activeKeys.has('x')) {
        const Rwc = eulerToMatrix4(ctx.euler[0], ctx.euler[1], ctx.euler[2]);
        if (ctx.activeKeys.has('z')) ctx.translateCam(new THREE.Vector3(0, 0, -transSpeed).applyMatrix4(Rwc));
        if (ctx.activeKeys.has('x')) ctx.translateCam(new THREE.Vector3(0, 0,  transSpeed).applyMatrix4(Rwc));
    }

    if (ctx.activeKeys.has('w') || ctx.activeKeys.has('a') || ctx.activeKeys.has('s') || ctx.activeKeys.has('d')) {
        const Rz = eulerToMatrix4(0, 0, ctx.euler[2]);
        if (ctx.activeKeys.has('w')) ctx.translateCam(new THREE.Vector3(0,  transSpeed, 0).applyMatrix4(Rz));
        if (ctx.activeKeys.has('s')) ctx.translateCam(new THREE.Vector3(0, -transSpeed, 0).applyMatrix4(Rz));
        if (ctx.activeKeys.has('a')) ctx.translateCam(new THREE.Vector3(-transSpeed, 0, 0).applyMatrix4(Rz));
        if (ctx.activeKeys.has('d')) ctx.translateCam(new THREE.Vector3( transSpeed, 0, 0).applyMatrix4(Rz));
    }
}
