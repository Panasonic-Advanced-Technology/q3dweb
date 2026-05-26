import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { GNSSMapItem } from '../src/items/GNSSMapItem';

describe('GNSSMapItem', () => {
  let original: typeof THREE.TextureLoader.prototype.load;
  beforeEach(() => {
    original = THREE.TextureLoader.prototype.load;
    THREE.TextureLoader.prototype.load = vi.fn(function (
      url: string,
      onLoad?: (t: THREE.Texture) => void,
      _onProgress?: any,
      onError?: (e: ErrorEvent) => void
    ) {
      if (url.endsWith('/0.png')) {
        if (onError) onError(new ErrorEvent('error'));
      } else {
        if (onLoad) onLoad(new THREE.Texture());
      }
      return new THREE.Texture();
    }) as any;
  });

  afterEach(() => {
    THREE.TextureLoader.prototype.load = original;
  });

  it('creates with defaults', () => {
    const g = new GNSSMapItem();
    expect(g.zoom).toBe(18);
    expect(g.alpha).toBeCloseTo(0.8);
    expect(g.altitude).toBe(0);
    expect(g.trailLength).toBe(0);
    expect(g.lastFix).toBeNull();
    expect((g as any).marker).toBeInstanceOf(THREE.Points);
    expect(((g as any).marker.material as THREE.PointsMaterial).sizeAttenuation).toBe(false);
  });

  it('creates with custom options', () => {
    const g = new GNSSMapItem({ zoom: 15, altitude: 10, alpha: 0.5, tileRadius: 2, tileServer: 'https://example.com/{z}/{x}/{y}.png' });
    expect(g.zoom).toBe(15);
  });

  it('addFix initializes proj and adds trail', () => {
    const g = new GNSSMapItem({ tileRadius: 1 });
    g.addFix(35.0, 139.0, 100, 0);
    expect(g.trailLength).toBe(1);
    expect(g.lastFix?.lat).toBe(35.0);
    g.addFix(35.000001, 139.000001, 100, 1);
    g.addFix(35.000002, 139.000002, 100, 2);
    g.addFix(35.000003, 139.000003, 100, -1);
    g.addFix(35.000004, 139.000004, 100, 99);
    expect(g.trailLength).toBe(5);
  });

  it('addFix ignores NaN', () => {
    const g = new GNSSMapItem();
    g.addFix(NaN, 1, 0);
    g.addFix(1, NaN, 0);
    expect(g.trailLength).toBe(0);
  });

  it('clearTrail / resetOrigin', () => {
    const g = new GNSSMapItem({ tileRadius: 1 });
    g.addFix(35, 139, 0);
    g.clearTrail();
    expect(g.trailLength).toBe(0);
    g.addFix(35, 139, 0);
    g.resetOrigin();
    expect(g.trailLength).toBe(0);
  });

  it('setZoom changes/clamps', () => {
    const g = new GNSSMapItem({ tileRadius: 1 });
    g.addFix(35, 139, 0);
    g.setZoom(17);
    expect(g.zoom).toBe(17);
    g.setZoom(17);
    g.setZoom(100);
    expect(g.zoom).toBe(19);
    g.setZoom(-1);
    expect(g.zoom).toBe(1);
  });

  it('setZoom without prior fix', () => {
    const g = new GNSSMapItem();
    g.setZoom(10);
    expect(g.zoom).toBe(10);
  });

  it('setAlpha clamps and updates', () => {
    const g = new GNSSMapItem({ tileRadius: 1 });
    g.addFix(35, 139, 0);
    g.setAlpha(0.5);
    expect(g.alpha).toBeCloseTo(0.5);
    g.setAlpha(2);
    expect(g.alpha).toBe(1);
    g.setAlpha(-1);
    expect(g.alpha).toBe(0);
  });

  it('setAltitude updates Z', () => {
    const g = new GNSSMapItem({ tileRadius: 1 });
    g.addFix(35, 139, 0);
    g.setAltitude(50);
    expect(g.altitude).toBe(50);
  });

  it('addSetting builds DOM and handles events', () => {
    vi.useFakeTimers();
    const g = new GNSSMapItem({ tileRadius: 1 });
    g.renderCb = () => {};
    const c = document.createElement('div');
    document.body.appendChild(c);
    g.addSetting(c);
    expect(c.children.length).toBeGreaterThan(0);

    vi.advanceTimersByTime(600);
    g.addFix(35, 139, 0);
    vi.advanceTimersByTime(600);

    const actionButtons = Array.from(c.querySelectorAll('button')).filter((button) => {
      const label = button.textContent ?? '';
      return label.includes('Clear Trail') || label.includes('Reset Origin');
    });
    expect(actionButtons).toHaveLength(2);
    actionButtons[0].click();
    actionButtons[1].click();

    const nums = c.querySelectorAll('input[type=number]');
    (nums[0] as HTMLInputElement).value = '15';
    (nums[0] as HTMLInputElement).onchange?.(new Event('change'));
    (nums[1] as HTMLInputElement).value = '0.5';
    (nums[1] as HTMLInputElement).onchange?.(new Event('change'));
    (nums[2] as HTMLInputElement).value = '5';
    (nums[2] as HTMLInputElement).onchange?.(new Event('change'));
    (nums[3] as HTMLInputElement).value = '2';
    (nums[3] as HTMLInputElement).onchange?.(new Event('change'));

    (nums[0] as HTMLInputElement).value = 'bad';
    (nums[0] as HTMLInputElement).onchange?.(new Event('change'));

    c.remove();
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
  });

  it('items/index exports all items', async () => {
    const idx = await import('../src/items/index');
    expect(idx.AxisItem).toBeDefined();
    expect(idx.GridItem).toBeDefined();
    expect(idx.CloudItem).toBeDefined();
    expect(idx.GaussianItem).toBeDefined();
    expect(idx.LineItem).toBeDefined();
    expect(idx.MeshItem).toBeDefined();
    expect(idx.FrameItem).toBeDefined();
    expect(idx.Text2DItem).toBeDefined();
    expect(idx.Text3DItem).toBeDefined();
    expect(idx.ImageItem).toBeDefined();
  });

  it('tile lifecycle: add/remove old tiles & race-condition replacement', () => {
    const g = new GNSSMapItem({ tileRadius: 1 });
    g.addFix(35, 139, 0);
    // Adding far-apart fix should request entirely new tiles and remove old
    g.addFix(35.5, 139.5, 0);
    // Add same fix again -> replaces existing tiles (race-condition path)
    g.addFix(35.5, 139.5, 0);

    // Direct loadTile call when the key already has a mesh: triggers
    // the race-condition replace branch (lines 396-401). Avoid y=0
    // because the mock simulates that URL as an error.
    (g as any).tileLoading.delete('18/0/1');
    const fakeGeom = new THREE.PlaneGeometry(1, 1);
    const fakeMat = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
    const fakeMesh = new THREE.Mesh(fakeGeom, fakeMat);
    (g as any).tileMeshes.set('18/0/1', fakeMesh);
    (g as any).tileGroup.add(fakeMesh);
    (g as any).loadTile(18, 0, 1, '18/0/1');
  });
});
