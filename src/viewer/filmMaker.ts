import * as THREE from 'three';
import { FrameItem } from '../items/FrameItem';
import { interpolatePose } from '../utils/maths';

export interface KeyFrameOptions {
    Twc: THREE.Matrix4;
    linVel?: number;   // m/s
    angVel?: number;   // rad/s
    stopTime?: number; // seconds
}

/**
 * A single keyframe: a camera pose in world coordinates, plus the linear/angular
 * velocities used when interpolating toward the next keyframe, plus an optional
 * stop time to linger on this pose before moving.
 */
export class KeyFrame {
    Twc: THREE.Matrix4;
    linVel: number;
    angVel: number;
    stopTime: number;
    item: FrameItem;

    constructor(opts: KeyFrameOptions) {
        this.Twc = opts.Twc.clone();
        this.linVel = opts.linVel ?? 10;
        this.angVel = opts.angVel ?? Math.PI / 3;
        this.stopTime = opts.stopTime ?? 0;
        this.item = new FrameItem({ size: [1, 0.8], width: 3, color: 0x0000ff });
        this.item.setTransform(this.Twc);
    }

    setTransform(Twc: THREE.Matrix4) {
        this.Twc.copy(Twc);
        this.item.setTransform(this.Twc);
    }

    dispose() {
        // Let callers remove the FrameItem from the scene first.
        // Child geometries/materials are disposed when the group is removed.
    }
}

/**
 * Pure-logic FilmMaker state. Holds keyframes, exposes add/remove/select,
 * and produces the interpolated camera transforms for playback.
 *
 * DOM-free so it can be unit tested under jsdom.
 */
export class FilmMaker {
    keyFrames: KeyFrame[] = [];
    currentIndex: number = -1;
    /** Playback update interval in milliseconds; default is 60 FPS. */
    updateIntervalMs: number = 1000 / 60;
    /** Frames produced by createFrames(), each tagged with its source keyframe index. */
    frames: { keyIndex: number; Twc: THREE.Matrix4 }[] = [];

    addKeyFrame(Twc: THREE.Matrix4): KeyFrame {
        const prev = this.keyFrames[this.keyFrames.length - 1];
        const kf = new KeyFrame({
            Twc,
            linVel: prev?.linVel,
            angVel: prev?.angVel,
            stopTime: prev?.stopTime,
        });
        this.keyFrames.push(kf);
        this.currentIndex = this.keyFrames.length - 1;
        return kf;
    }

    deleteKeyFrame(index: number): KeyFrame | null {
        if (index < 0 || index >= this.keyFrames.length) return null;
        const [removed] = this.keyFrames.splice(index, 1);
        if (this.keyFrames.length === 0) {
            this.currentIndex = -1;
        } else {
            this.currentIndex = Math.min(index, this.keyFrames.length - 1);
        }
        return removed;
    }

    select(index: number): KeyFrame | null {
        if (index < 0 || index >= this.keyFrames.length) return null;
        this.currentIndex = index;
        return this.keyFrames[index];
    }

    setLinVel(index: number, v: number): void {
        const kf = this.keyFrames[index];
        if (kf) kf.linVel = v;
    }

    setAngVel(index: number, v: number): void {
        const kf = this.keyFrames[index];
        if (kf) kf.angVel = v;
    }

    setStopTime(index: number, v: number): void {
        const kf = this.keyFrames[index];
        if (kf) kf.stopTime = v;
    }

    /**
     * Build the sequence of interpolated frames for playback.
     * Mirrors film_maker.py CMMViewer.create_frames.
     */
    createFrames(): { keyIndex: number; Twc: THREE.Matrix4 }[] {
        const dt = this.updateIntervalMs / 1000; // seconds
        const out: { keyIndex: number; Twc: THREE.Matrix4 }[] = [];
        for (let i = 0; i < this.keyFrames.length - 1; i++) {
            const cur = this.keyFrames[i];
            if (cur.stopTime > 0) {
                const numSteps = Math.floor(cur.stopTime / dt);
                for (let j = 0; j < numSteps; j++) {
                    out.push({ keyIndex: i, Twc: cur.Twc.clone() });
                }
            }
            const next = this.keyFrames[i + 1];
            const Ts = interpolatePose(cur.Twc, next.Twc, cur.linVel, cur.angVel, dt);
            for (const T of Ts) out.push({ keyIndex: i, Twc: T });
        }
        this.frames = out;
        return out;
    }

    clear(): KeyFrame[] {
        const removed = this.keyFrames.slice();
        this.keyFrames = [];
        this.currentIndex = -1;
        this.frames = [];
        return removed;
    }
}
