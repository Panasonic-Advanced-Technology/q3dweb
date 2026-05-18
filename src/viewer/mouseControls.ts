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

interface TouchPoint { x: number; y: number; }

interface TouchGestureState {
    mode: 'none' | 'single' | 'multi';
    lastPoint: TouchPoint | null;
    lastCenter: TouchPoint | null;
    lastDistance: number;
}

const TOUCH_ROTATE_SPEED = 0.45 * Math.PI / 180;
const TOUCH_PAN_SPEED = 1.8;
const TOUCH_PINCH_ZOOM_SPEED = 0.01;

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

function getTouchPoint(touch: Touch): TouchPoint {
    return { x: touch.clientX, y: touch.clientY };
}

function translateFromScreenDelta(ctx: InputContext, dx: number, dy: number, distanceScale = 1): void {
    const Rwc = eulerToMatrix4(ctx.euler[0], ctx.euler[1], ctx.euler[2]);
    const Kinv = getCameraK(ctx).clone().invert();
    const dist = Math.max(ctx.cameraDist, 0.5) * distanceScale;
    const sv = new THREE.Vector3(-dx, dy, 0);
    sv.applyMatrix3(Kinv).multiplyScalar(dist).applyMatrix4(Rwc);
    ctx.translateCam(sv);
}

function centerOfPoints(points: TouchPoint[]): TouchPoint {
    return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
}

function distanceBetweenPoints(points: TouchPoint[]): number {
    return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
}

function isTouchLikePointer(e: PointerEvent): boolean {
    return e.pointerType === 'touch' || e.pointerType === 'pen';
}

export function setupMouseControls(canvas: HTMLElement, ctx: InputContext): void {
    const touchState: TouchGestureState = {
        mode: 'none',
        lastPoint: null,
        lastCenter: null,
        lastDistance: 0,
    };
    const activeTouchPointers = new Map<number, TouchPoint>();

    const resetTouchState = (): void => {
        touchState.mode = 'none';
        touchState.lastPoint = null;
        touchState.lastCenter = null;
        touchState.lastDistance = 0;
    };

    const startTouchGesture = (points: TouchPoint[]): void => {
        if (points.length === 1) {
            touchState.mode = 'single';
            touchState.lastPoint = points[0];
            touchState.lastCenter = null;
            touchState.lastDistance = 0;
            return;
        }
        if (points.length >= 2) {
            touchState.mode = 'multi';
            touchState.lastPoint = null;
            touchState.lastCenter = centerOfPoints(points);
            touchState.lastDistance = distanceBetweenPoints(points);
        }
    };

    const moveTouchGesture = (points: TouchPoint[]): void => {
        if (points.length === 1 && touchState.mode === 'single' && touchState.lastPoint) {
            const point = points[0];
            const dx = point.x - touchState.lastPoint.x;
            const dy = point.y - touchState.lastPoint.y;
            touchState.lastPoint = point;
            translateFromScreenDelta(ctx, dx, dy, TOUCH_PAN_SPEED);
            ctx.showCenter = true;
            ctx.requestRender();
            return;
        }

        if (points.length >= 2) {
            const center = centerOfPoints(points);
            const pinchDistance = distanceBetweenPoints(points);
            if (touchState.mode !== 'multi' || !touchState.lastCenter) {
                startTouchGesture(points);
                return;
            }

            const dx = center.x - touchState.lastCenter.x;
            const dy = center.y - touchState.lastCenter.y;
            const pinchDelta = pinchDistance - touchState.lastDistance;
            if (dx !== 0 || dy !== 0) ctx.rotateCam(-dy * TOUCH_ROTATE_SPEED, 0, -dx * TOUCH_ROTATE_SPEED);
            if (pinchDelta !== 0) ctx.updateDist(-pinchDelta * ctx.cameraDist * TOUCH_PINCH_ZOOM_SPEED);
            touchState.lastCenter = center;
            touchState.lastDistance = pinchDistance;
            ctx.showCenter = true;
            ctx.requestRender();
        }
    };

    const remainingTouchGesture = (points: TouchPoint[]): void => {
        if (points.length === 0) resetTouchState();
        else startTouchGesture(points);
    };

    canvas.style.touchAction = 'none';

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

    if ('PointerEvent' in window) {
        canvas.addEventListener('pointerdown', (e: PointerEvent) => {
            if (!isTouchLikePointer(e)) return;
            e.preventDefault();
            (canvas as HTMLElement & { focus?: () => void }).focus?.();
            (canvas as HTMLElement & { setPointerCapture?: (pointerId: number) => void }).setPointerCapture?.(e.pointerId);
            activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            ctx.mousePos = null;
            ctx.mouseButton = -1;
            startTouchGesture(Array.from(activeTouchPointers.values()));
        }, { passive: false });

        canvas.addEventListener('pointermove', (e: PointerEvent) => {
            if (!isTouchLikePointer(e) || !activeTouchPointers.has(e.pointerId)) return;
            e.preventDefault();
            activeTouchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            moveTouchGesture(Array.from(activeTouchPointers.values()));
        }, { passive: false });

        const endPointer = (e: PointerEvent) => {
            if (!isTouchLikePointer(e) || !activeTouchPointers.has(e.pointerId)) return;
            e.preventDefault();
            activeTouchPointers.delete(e.pointerId);
            remainingTouchGesture(Array.from(activeTouchPointers.values()));
        };
        canvas.addEventListener('pointerup', endPointer, { passive: false });
        canvas.addEventListener('pointercancel', endPointer, { passive: false });
        canvas.addEventListener('lostpointercapture', endPointer, { passive: false });
    } else {
        canvas.addEventListener('touchstart', (e: TouchEvent) => {
            if (e.touches.length === 0) return;
            e.preventDefault();
            (canvas as HTMLElement & { focus?: () => void }).focus?.();
            ctx.mousePos = null;
            ctx.mouseButton = -1;
            startTouchGesture(Array.from(e.touches, getTouchPoint));
        }, { passive: false });

        canvas.addEventListener('touchmove', (e: TouchEvent) => {
            if (e.touches.length === 0) return;
            e.preventDefault();
            moveTouchGesture(Array.from(e.touches, getTouchPoint));
        }, { passive: false });

        canvas.addEventListener('touchend', (e: TouchEvent) => {
            e.preventDefault();
            remainingTouchGesture(Array.from(e.touches, getTouchPoint));
        }, { passive: false });

        canvas.addEventListener('touchcancel', () => resetTouchState(), { passive: false });
    }

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
