import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CloudItem } from '../src/items/CloudItem';

describe('CloudItem color modes', () => {
  it('FLAT color mode resolves uniform to 2', () => {
    const c = new CloudItem(new Float32Array([0, 0, 0]), new Float32Array([0]), { colorMode: 'FLAT' });
    expect(((c.material as any).uniforms.colorMode.value)).toBe(2);
  });
  it('I (intensity) color mode resolves uniform to 0', () => {
    const c = new CloudItem(new Float32Array([0, 0, 0]), new Float32Array([0]), { colorMode: 'I' });
    expect(((c.material as any).uniforms.colorMode.value)).toBe(0);
  });
  it('RGB color mode via rgbColors arg resolves uniform to 1', () => {
    const c = new CloudItem(new Float32Array([0, 0, 0]), new Float32Array([0]), {}, new Uint8Array([255, 0, 0]));
    expect(((c.material as any).uniforms.colorMode.value)).toBe(1);
  });
  it('default colorMode resolves to 0', () => {
    const c = new CloudItem(new Float32Array([0, 0, 0]), new Float32Array([0]));
    expect(((c.material as any).uniforms.colorMode.value)).toBe(0);
  });
});

describe('CloudItem geometry & uniforms', () => {
  function makePositions(pointCount: number): Float32Array {
    const positions = new Float32Array(pointCount * 3);
    for (let index = 0; index < pointCount; index++) {
      positions[index * 3] = index;
      positions[index * 3 + 1] = index + 0.25;
      positions[index * 3 + 2] = index + 0.5;
    }
    return positions;
  }

  function makeValues(pointCount: number): Float32Array {
    const values = new Float32Array(pointCount);
    for (let index = 0; index < pointCount; index++) values[index] = index + 10;
    return values;
  }

  it('initializes with correct geometry attributes', () => {
    const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
    const values = new Float32Array([10, 20]);
    const cloud = new CloudItem(positions, values);
    expect(cloud.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(cloud.geometry.getAttribute('position').count).toBe(2);
    expect(cloud.geometry.getAttribute('value').count).toBe(2);
  });
  it('sets default uniforms', () => {
    const cloud = new CloudItem(new Float32Array(3), new Float32Array(1));
    const m = cloud.material as THREE.ShaderMaterial;
    expect(m.uniforms.pointSize.value).toBe(1.0);
    expect(m.uniforms.alpha.value).toBe(1.0);
  });
  it('accepts custom options', () => {
    const cloud = new CloudItem(new Float32Array(3), new Float32Array(1), { size: 5.0, alpha: 0.5 });
    const m = cloud.material as THREE.ShaderMaterial;
    expect(m.uniforms.pointSize.value).toBe(5.0);
    expect(m.uniforms.alpha.value).toBe(0.5);
  });

  it('maps pointType options to uniforms', () => {
    const cloud = new CloudItem(new Float32Array(3), new Float32Array(1), { pointType: 'SPHERE' });
    const m = cloud.material as THREE.ShaderMaterial;
    expect(m.uniforms.pointType.value).toBe(2);
  });

  it('updates viewport height for world-space point sizing', () => {
    const cloud = new CloudItem(new Float32Array(3), new Float32Array(1), { pointType: 'SQUARE' });
    cloud.updateViewport(720);
    const m = cloud.material as THREE.ShaderMaterial;
    expect(m.uniforms.viewportHeight.value).toBe(720);
  });

  it('uses branch-light shader code for color selection and point masking', () => {
    const cloud = new CloudItem(new Float32Array(3), new Float32Array(1), { pointType: 'SPHERE', colorMode: 'RGB' }, new Uint8Array([255, 0, 0]));
    const m = cloud.material as THREE.ShaderMaterial;
    expect(m.vertexShader).not.toContain('if (colorMode');
    expect(m.fragmentShader).not.toContain('if (pointType');
    expect(m.fragmentShader).not.toContain('discard');
    expect(m.vertexShader).toContain('mix(');
    expect(m.fragmentShader).toContain('step(');
    expect(m.vertexShader).toContain('viewportHeight');
    expect(m.vertexShader).toContain('projectionMatrix[1][1]');
  });

  it('rejects mismatched position and value lengths', () => {
    expect(() => new CloudItem(new Float32Array(4), new Float32Array(1))).toThrow('positions length');
  });

  it('sets alpha-dependent transparency and depth write flags', () => {
    const opaqueCloud = new CloudItem(new Float32Array(3), new Float32Array(1), { alpha: 1 });
    const transparentCloud = new CloudItem(new Float32Array(3), new Float32Array(1), { alpha: 0.5 });

    expect((opaqueCloud.material as THREE.ShaderMaterial).transparent).toBe(false);
    expect((opaqueCloud.material as THREE.ShaderMaterial).depthWrite).toBe(true);
    expect((transparentCloud.material as THREE.ShaderMaterial).transparent).toBe(true);
    expect((transparentCloud.material as THREE.ShaderMaterial).depthWrite).toBe(false);
  });

  it('replaces points, grows attributes, converts float colors, and updates draw range', () => {
    const cloud = new CloudItem(new Float32Array([0, 0, 0]), new Float32Array([1]));

    cloud.replacePoints(
      new Float32Array([1, 2, 3, 4, 5, 6]),
      new Float32Array([7, 8]),
      new Float32Array([0, 0.5, 1, 260, -1, 128]),
    );

    expect(cloud.getPointCount()).toBe(2);
    expect(cloud.geometry.drawRange.count).toBe(2);
    expect(Array.from((cloud.geometry.getAttribute('position').array as Float32Array).slice(0, 6)))
      .toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from((cloud.geometry.getAttribute('value').array as Float32Array).slice(0, 2)))
      .toEqual([7, 8]);
    expect(Array.from((cloud.geometry.getAttribute('color').array as Uint8Array).slice(0, 6)))
      .toEqual([0, 128, 255, 255, 0, 128]);
  });

  it('clears active colors when replacing without RGB values', () => {
    const cloud = new CloudItem(
      new Float32Array([0, 0, 0]),
      new Float32Array([1]),
      {},
      new Uint8Array([255, 128, 64]),
    );

    cloud.replacePoints(new Float32Array([1, 2, 3]), new Float32Array([2]));

    expect(Array.from((cloud.geometry.getAttribute('color').array as Uint8Array).slice(0, 3)))
      .toEqual([0, 0, 0]);
  });

  it('rejects invalid replacement lengths', () => {
    const cloud = new CloudItem(new Float32Array(3), new Float32Array(1));

    expect(() => cloud.replacePoints(new Float32Array(4), new Float32Array(1))).toThrow('positions length');
  });

  it('ignores empty appends and records regular append metadata', () => {
    const cloud = new CloudItem(new Float32Array([0, 0, 0]), new Float32Array([1]));

    expect(cloud.appendPoints(new Float32Array(0), new Float32Array(0))).toBe(1);
    expect(cloud.getLastAppendMeta()).toBeNull();

    expect(cloud.appendPoints(new Float32Array([1, 1, 1, 2, 2, 2]), new Float32Array([2, 3]))).toBe(3);
    expect(cloud.getLastAppendMeta()).toEqual({
      appendRequested: 2,
      appendActual: 2,
      dirtyPoints: 2,
      didDownsample: false,
      resetToIncomingTailOnly: false,
      totalPoints: 3,
    });
  });

  it('downsamples oversized incoming chunks before appending', () => {
    const cloud = new CloudItem(new Float32Array([0, 0, 0]), new Float32Array([1]));

    cloud.appendPoints(
      makePositions(10),
      makeValues(10),
      new Float32Array([
        0, 0, 0,
        0.1, 0.2, 0.3,
        0.4, 0.5, 0.6,
        0.7, 0.8, 0.9,
        1, 1, 1,
        2, 2, 2,
        3, 3, 3,
        4, 4, 4,
        5, 5, 5,
        6, 6, 6,
      ]),
      4,
    );

    expect(cloud.getPointCount()).toBe(4);
    expect(cloud.getLastAppendMeta()?.appendRequested).toBe(10);
    expect(cloud.getLastAppendMeta()?.appendActual).toBe(3);
    expect(Array.from((cloud.geometry.getAttribute('value').array as Float32Array).slice(1, 4)))
      .toEqual([10, 14, 18]);
    expect(Array.from((cloud.geometry.getAttribute('color').array as Uint8Array).slice(3, 12)))
      .toEqual([0, 0, 0, 255, 255, 255, 5, 5, 5]);
  });

  it('downsamples existing points when the fixed capacity is full', () => {
    const cloud = new CloudItem(makePositions(4), makeValues(4), {}, new Uint8Array([
      10, 11, 12,
      20, 21, 22,
      30, 31, 32,
      40, 41, 42,
    ]));

    cloud.appendPoints(makePositions(4), makeValues(4), undefined, 4);

    expect(cloud.getPointCount()).toBe(4);
    expect(cloud.getLastAppendMeta()).toEqual({
      appendRequested: 4,
      appendActual: 2,
      dirtyPoints: 4,
      didDownsample: true,
      resetToIncomingTailOnly: false,
      totalPoints: 4,
    });
    expect(Array.from((cloud.geometry.getAttribute('value').array as Float32Array).slice(0, 4)))
      .toEqual([10, 12, 10, 12]);
    expect(Array.from((cloud.geometry.getAttribute('color').array as Uint8Array).slice(0, 12)))
      .toEqual([10, 11, 12, 30, 31, 32, 0, 0, 0, 0, 0, 0]);
  });

  it('rejects invalid append lengths', () => {
    const cloud = new CloudItem(new Float32Array(3), new Float32Array(1));

    expect(() => cloud.appendPoints(new Float32Array(4), new Float32Array(1))).toThrow('positions length');
  });
});
