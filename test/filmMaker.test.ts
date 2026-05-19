import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { FilmMaker, KeyFrame } from '../src/viewer/filmMaker';

function poseAt(x: number, y: number, z: number): THREE.Matrix4 {
    return new THREE.Matrix4().makeTranslation(x, y, z);
}

describe('FilmMaker: keyframe management', () => {
    let fm: FilmMaker;
    beforeEach(() => {
        fm = new FilmMaker();
    });

    it('starts empty', () => {
        expect(fm.keyFrames.length).toBe(0);
        expect(fm.currentIndex).toBe(-1);
    });

    it('addKeyFrame appends and selects the new frame with default velocities', () => {
        const kf = fm.addKeyFrame(poseAt(0, 0, 0));
        expect(fm.keyFrames).toEqual([kf]);
        expect(fm.currentIndex).toBe(0);
        expect(kf.linVel).toBe(10);
        expect(Math.abs(kf.angVel - Math.PI / 3)).toBeLessThan(1e-9);
        expect(kf.stopTime).toBe(0);
    });

    it('subsequent addKeyFrame inherits velocities from previous', () => {
        const k1 = fm.addKeyFrame(poseAt(0, 0, 0));
        k1.linVel = 42;
        k1.angVel = 1.23;
        k1.stopTime = 0.5;
        const k2 = fm.addKeyFrame(poseAt(1, 0, 0));
        expect(k2.linVel).toBe(42);
        expect(k2.angVel).toBeCloseTo(1.23, 9);
        expect(k2.stopTime).toBe(0.5);
    });

    it('deleteKeyFrame removes and re-selects the last remaining', () => {
        fm.addKeyFrame(poseAt(0, 0, 0));
        fm.addKeyFrame(poseAt(1, 0, 0));
        fm.addKeyFrame(poseAt(2, 0, 0));
        const removed = fm.deleteKeyFrame(1);
        expect(removed).toBeInstanceOf(KeyFrame);
        expect(fm.keyFrames.length).toBe(2);
        expect(fm.currentIndex).toBe(1);
    });

    it('deleteKeyFrame resets selection when the final frame is removed', () => {
        fm.addKeyFrame(poseAt(0, 0, 0));
        expect(fm.deleteKeyFrame(0)).toBeInstanceOf(KeyFrame);
        expect(fm.keyFrames.length).toBe(0);
        expect(fm.currentIndex).toBe(-1);
    });

    it('KeyFrame.setTransform updates both stored pose and frame item', () => {
        const kf = new KeyFrame({ Twc: poseAt(0, 0, 0) });
        const next = poseAt(4, 5, 6);
        kf.setTransform(next);
        expect(kf.Twc.elements[12]).toBe(4);
        expect(kf.item.matrix.elements[13]).toBe(5);
        kf.dispose();
    });

    it('deleteKeyFrame returns null on out-of-range', () => {
        fm.addKeyFrame(poseAt(0, 0, 0));
        expect(fm.deleteKeyFrame(-1)).toBeNull();
        expect(fm.deleteKeyFrame(99)).toBeNull();
    });

    it('select updates currentIndex', () => {
        fm.addKeyFrame(poseAt(0, 0, 0));
        fm.addKeyFrame(poseAt(1, 0, 0));
        expect(fm.select(0)).toBeInstanceOf(KeyFrame);
        expect(fm.currentIndex).toBe(0);
        expect(fm.select(5)).toBeNull();
        expect(fm.currentIndex).toBe(0);
    });

    it('setLinVel/setAngVel/setStopTime mutate the given keyframe', () => {
        fm.addKeyFrame(poseAt(0, 0, 0));
        fm.setLinVel(0, 7);
        fm.setAngVel(0, 2);
        fm.setStopTime(0, 0.25);
        expect(fm.keyFrames[0].linVel).toBe(7);
        expect(fm.keyFrames[0].angVel).toBe(2);
        expect(fm.keyFrames[0].stopTime).toBe(0.25);
    });
});

describe('FilmMaker: playback frames', () => {
    it('createFrames produces no frames with < 2 keyframes', () => {
        const fm = new FilmMaker();
        expect(fm.createFrames()).toEqual([]);
        fm.addKeyFrame(poseAt(0, 0, 0));
        expect(fm.createFrames()).toEqual([]);
    });

    it('createFrames interpolates between consecutive keyframes', () => {
        const fm = new FilmMaker();
        fm.updateIntervalMs = 100; // dt=0.1s
        const k1 = fm.addKeyFrame(poseAt(0, 0, 0));
        k1.linVel = 1;
        k1.angVel = 0;
        fm.addKeyFrame(poseAt(10, 0, 0));
        const frames = fm.createFrames();
        // 10m / 1 m/s / 0.1s = 100 steps
        expect(frames.length).toBe(100);
        expect(frames[0].keyIndex).toBe(0);
        // Last frame's x should approach 10.
        expect(frames[frames.length - 1].Twc.elements[12]).toBeGreaterThan(9);
    });

    it('createFrames prepends stopTime holds for the first keyframe', () => {
        const fm = new FilmMaker();
        fm.updateIntervalMs = 100;
        const k1 = fm.addKeyFrame(poseAt(0, 0, 0));
        k1.linVel = 1;
        k1.angVel = 0;
        k1.stopTime = 0.5; // 5 steps at 0.1s each
        fm.addKeyFrame(poseAt(1, 0, 0));
        const frames = fm.createFrames();
        expect(frames.length).toBeGreaterThanOrEqual(15);
        // The first 5 frames should be at x=0 (stop).
        for (let i = 0; i < 5; i++) {
            expect(frames[i].Twc.elements[12]).toBe(0);
            expect(frames[i].keyIndex).toBe(0);
        }
    });

    it('clear() empties all state', () => {
        const fm = new FilmMaker();
        fm.addKeyFrame(poseAt(0, 0, 0));
        fm.addKeyFrame(poseAt(1, 0, 0));
        fm.createFrames();
        fm.clear();
        expect(fm.keyFrames).toEqual([]);
        expect(fm.currentIndex).toBe(-1);
        expect(fm.frames).toEqual([]);
    });
});
