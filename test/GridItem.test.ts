import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GridItem } from '../src/items/GridItem';

describe('GridItem', () => {
  it('creates with defaults', () => {
    const g = new GridItem();
    expect(g.geometry.getAttribute('position')).toBeDefined();
    expect((g.material as THREE.LineBasicMaterial).transparent).toBe(true);
  });

  it('creates with opacity=1 (no transparency)', () => {
    const g = new GridItem({ opacity: 1.0 });
    expect((g.material as THREE.LineBasicMaterial).transparent).toBe(false);
  });

  it('creates with custom options', () => {
    const g = new GridItem({ size: 50, spacing: 5, color: 0xff0000, offset: [1, 2, 3] });
    expect(g.geometry.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('setSize rebuilds geometry', () => {
    const g = new GridItem({ size: 100, spacing: 10 });
    const before = g.geometry.getAttribute('position').count;
    g.setSize(200);
    const after = g.geometry.getAttribute('position').count;
    expect(after).toBeGreaterThan(before);
  });

  it('setSize rejects non-positive', () => {
    const g = new GridItem();
    const before = g.geometry.getAttribute('position').count;
    g.setSize(-1);
    g.setSize(0);
    expect(g.geometry.getAttribute('position').count).toBe(before);
  });

  it('setSpacing changes density', () => {
    const g = new GridItem({ size: 100, spacing: 20 });
    const before = g.geometry.getAttribute('position').count;
    g.setSpacing(10);
    const after = g.geometry.getAttribute('position').count;
    expect(after).toBeGreaterThan(before);
  });

  it('setSpacing rejects non-positive', () => {
    const g = new GridItem({ size: 100, spacing: 20 });
    const before = g.geometry.getAttribute('position').count;
    g.setSpacing(0);
    g.setSpacing(-5);
    expect(g.geometry.getAttribute('position').count).toBe(before);
  });

  it('setOffset rebuilds', () => {
    const g = new GridItem();
    g.setOffset([10, 20, 30]);
    expect(g.geometry.getAttribute('position').count).toBeGreaterThan(0);
  });

  it('addSetting builds DOM controls', () => {
    const g = new GridItem();
    let rendered = 0;
    g.renderCb = () => rendered++;
    const c = document.createElement('div');
    g.addSetting(c);
    expect(c.children.length).toBeGreaterThan(0);
    expect(c.querySelector('.q3d-setting-checkbox')).toBeTruthy();

    // Toggle visibility checkbox
    const cb = c.querySelector('input[type=checkbox]') as HTMLInputElement;
    cb.checked = false;
    cb.onchange?.(new Event('change'));
    expect(g.visible).toBe(false);
    expect(rendered).toBeGreaterThan(0);

    // Spacing input change
    const num = c.querySelector('input[type=number]') as HTMLInputElement;
  expect(num.className).toContain('q3d-setting-control');
    num.value = '5';
    num.onchange?.(new Event('change'));

    // Invalid input should be ignored
    num.value = 'not-a-number';
    num.onchange?.(new Event('change'));
  });
});
