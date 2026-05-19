import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CloudItem } from '../src/items/CloudItem';
import { appendRealtimePoints, renderPoints, resetRealtimeCloud } from '../src/viewer/cloudRenderer';

function makeViewer() {
  const viewer = {
    items: {} as Record<string, unknown>,
    camera: new THREE.PerspectiveCamera(60),
    cameraCenter: new THREE.Vector3(),
    cameraDist: 0,
    euler: [0, 0, 0],
    dataMin: 0,
    dataMax: 0,
    realtimeMaxPoints: 10,
    statusElement: document.createElement('div'),
    loadingOverlay: document.createElement('div'),
    updateCamera: vi.fn(),
    requestRender: vi.fn(),
    addItem: vi.fn((name: string, item: unknown) => { viewer.items[name] = item; }),
    removeItem: vi.fn((name: string) => { delete viewer.items[name]; }),
  };
  return viewer;
}

describe('cloudRenderer', () => {
  it('renders RGB point clouds, updates camera fit, status, and overlay', () => {
    const viewer = makeViewer();
    viewer.loadingOverlay.style.display = 'flex';

    renderPoints(
      viewer,
      new Float32Array([0, 0, 0, 2, 4, 6]),
      new Float32Array([10, 30]),
      new Uint8Array([0, 0, 0, 255, 128, 64]),
    );

    const cloud = viewer.items.cloud as CloudItem;
    expect(cloud).toBeInstanceOf(CloudItem);
    expect((cloud.material as any).uniforms.colorMode.value).toBe(1);
    expect(viewer.cameraCenter.toArray()).toEqual([1, 2, 3]);
    expect(viewer.cameraDist).toBeGreaterThan(0);
    expect(viewer.statusElement.textContent).toBe('2 points');
    expect(viewer.loadingOverlay.style.display).toBe('none');
    expect(viewer.requestRender).toHaveBeenCalled();
  });

  it('renders empty clouds with default value range', () => {
    const viewer = makeViewer();

    renderPoints(viewer, new Float32Array(0), new Float32Array(0));

    expect(viewer.dataMin).toBe(0);
    expect(viewer.dataMax).toBe(255);
    expect((viewer.items.cloud as CloudItem).getPointCount()).toBe(0);
  });

  it('resets realtime cloud state', () => {
    const viewer = makeViewer();
    viewer.items.cloud = new CloudItem(new Float32Array(3), new Float32Array(1));

    resetRealtimeCloud(viewer);

    expect(viewer.removeItem).toHaveBeenCalledWith('cloud');
    expect(viewer.statusElement.textContent).toBe('0 points');
    expect(viewer.requestRender).toHaveBeenCalled();
  });

  it('rejects malformed realtime chunks', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const viewer = makeViewer();

    appendRealtimePoints(viewer, new Float32Array(4), new Float32Array(1));
    appendRealtimePoints(viewer, new Float32Array(3), new Float32Array(1), new Uint8Array(2));
    appendRealtimePoints(viewer, new Float32Array(0), new Float32Array(0));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(viewer.items.cloud).toBeUndefined();
    warn.mockRestore();
  });

  it('creates realtime clouds, fits the first chunk, and widens equal value ranges', () => {
    const viewer = makeViewer();

    appendRealtimePoints(
      viewer,
      new Float32Array([0, 0, 0, 2, 0, 0]),
      new Float32Array([5, 5]),
      undefined,
      10,
      true,
    );

    const cloud = viewer.items.cloud as CloudItem;
    expect(cloud.getPointCount()).toBe(2);
    expect(viewer.dataMin).toBe(4);
    expect(viewer.dataMax).toBe(6);
    expect(viewer.cameraCenter.toArray()).toEqual([1, 0, 0]);
    expect(viewer.statusElement.textContent).toBe('2 points (realtime)');
    expect(viewer.requestRender).toHaveBeenCalled();
  });

  it('appends RGB realtime chunks to existing clouds and expands data range', () => {
    const viewer = makeViewer();
    appendRealtimePoints(viewer, new Float32Array([0, 0, 0]), new Float32Array([10]));

    appendRealtimePoints(
      viewer,
      new Float32Array([1, 1, 1]),
      new Float32Array([30]),
      new Uint8Array([10, 20, 30]),
      10,
    );

    const cloud = viewer.items.cloud as CloudItem;
    expect(cloud.getPointCount()).toBe(2);
    expect((cloud.material as any).uniforms.colorMode.value).toBe(1);
    expect(viewer.dataMin).toBe(9);
    expect(viewer.dataMax).toBe(30);
  });
});