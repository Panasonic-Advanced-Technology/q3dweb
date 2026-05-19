import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  addMeasurementPoint,
  removeMeasurementPoint,
  updateMeasurementMarker,
  type MeasurementContext,
} from '../src/viewer/measurement';

function makeContext(points: THREE.Vector3[] = []): MeasurementContext {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }));
  return {
    renderer: { domElement: canvas } as THREE.WebGLRenderer,
    camera: new THREE.PerspectiveCamera(60, 1, 0.1, 100),
    items: {},
    centerPointMesh: null,
    selectedPoints: points,
    text2dItem: {
      setHTML: vi.fn(),
      setText: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
    },
    requestRender: vi.fn(),
  };
}

describe('measurement helpers extra paths', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('adds the closest point-to-ray hit and ignores marker/center objects', () => {
    const ctx = makeContext();
    const cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());
    cloud.name = 'cloud';
    const unnamed = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());
    const center = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());
    center.name = 'center';
    ctx.centerPointMesh = center;
    ctx.items = { cloud, unnamed, center };

    vi.spyOn(THREE.Raycaster.prototype, 'intersectObjects').mockImplementation((objects) => {
      expect(objects).toEqual([cloud]);
      return [
        { distanceToRay: Number.NaN, distance: 1, point: new THREE.Vector3(1, 0, 0), object: cloud } as any,
        { distanceToRay: 0.2, distance: 10, point: new THREE.Vector3(2, 0, 0), object: cloud } as any,
        { distanceToRay: 0.2, distance: 2, point: new THREE.Vector3(3, 0, 0), object: cloud } as any,
      ];
    });

    addMeasurementPoint(new MouseEvent('mousedown', { clientX: 50, clientY: 50 }), ctx);

    expect(ctx.selectedPoints[0]).toEqual(new THREE.Vector3(3, 0, 0));
    expect(ctx.text2dItem?.setHTML).toHaveBeenCalledWith(expect.stringContaining('Point 1'));
  });

  it('updates marker data, segment text, and empty state directly', () => {
    const marker = { setData: vi.fn() };
    const ctx = makeContext([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(3, 4, 0),
      new THREE.Vector3(3, 4, 12),
    ]);
    ctx.items.marker = marker as any;

    updateMeasurementMarker(ctx);

    expect(marker.setData).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ position: [0, 0, 0], pointSize: 5 }),
    ]));
    expect(ctx.text2dItem?.setHTML).toHaveBeenCalledWith(expect.stringContaining('Total: 17.000 m'));
    expect(ctx.text2dItem?.show).toHaveBeenCalled();

    removeMeasurementPoint(ctx);
    removeMeasurementPoint(ctx);
    removeMeasurementPoint(ctx);
    removeMeasurementPoint(ctx);

    expect(ctx.selectedPoints).toHaveLength(0);
    expect(ctx.text2dItem?.setText).toHaveBeenCalledWith('');
    expect(ctx.text2dItem?.hide).toHaveBeenCalled();
  });
});