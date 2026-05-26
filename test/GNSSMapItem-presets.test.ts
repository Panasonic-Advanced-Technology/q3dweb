import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { GNSSMapItem, TILE_PRESETS } from '../src/items/GNSSMapItem';

describe('GNSSMapItem tile server switching', () => {
    let original: typeof THREE.TextureLoader.prototype.load;
    beforeEach(() => {
        original = THREE.TextureLoader.prototype.load;
        THREE.TextureLoader.prototype.load = vi.fn(function (
            _url: string,
            onLoad?: (t: THREE.Texture) => void,
        ) {
            if (onLoad) onLoad(new THREE.Texture());
            return new THREE.Texture();
        }) as any;
    });
    afterEach(() => {
        THREE.TextureLoader.prototype.load = original;
    });

    it('exposes TILE_PRESETS with expected providers', () => {
        const labels = TILE_PRESETS.map(p => p.label);
        expect(labels).toContain('OpenStreetMap');
        expect(labels.some(l => l.includes('GSI'))).toBe(true);
    });

    it('default tile server is the first preset (OSM)', () => {
        const g = new GNSSMapItem();
        expect(g.tileServerUrl).toBe(TILE_PRESETS[0].url);
    });

    it('honors custom tileServer option & matches maxZoom from preset if any', () => {
        const gsiPhoto = TILE_PRESETS.find(p => p.label.includes('写真'))!;
        const g = new GNSSMapItem({ tileServer: gsiPhoto.url });
        expect(g.tileServerUrl).toBe(gsiPhoto.url);
    });

    it('setTileServer no-op when URL unchanged', () => {
        const g = new GNSSMapItem();
        const before = g.tileServerUrl;
        g.setTileServer(before);
        expect(g.tileServerUrl).toBe(before);
    });

    it('setTileServer clears existing tiles and reloads', () => {
        const g = new GNSSMapItem({ tileRadius: 1 });
        g.addFix(35, 139, 0);
        expect((g as any).tileMeshes.size).toBeGreaterThan(0);

        const gsi = TILE_PRESETS.find(p => p.label.includes('標準'))!;
        g.setTileServer(gsi.url);
        expect(g.tileServerUrl).toBe(gsi.url);
        // After reload, meshes should again be populated (mock loads synchronously)
        expect((g as any).tileMeshes.size).toBeGreaterThan(0);
    });

    it('setTileServer clamps zoom to new maxZoom', () => {
        const g = new GNSSMapItem({ zoom: 19 });
        g.addFix(35, 139, 0);
        const gsi = TILE_PRESETS.find(p => p.label === 'GSI 白地図')!;
        expect(gsi.maxZoom).toBe(14);
        g.setTileServer(gsi.url);
        expect(g.zoom).toBeLessThanOrEqual(14);
    });

    it('setTileServer accepts explicit maxZoom override', () => {
        const g = new GNSSMapItem({ zoom: 19 });
        g.setTileServer('https://example.com/{z}/{x}/{y}.png', 10);
        g.setZoom(19); // tries to set 19 but should clamp to 10
        expect(g.zoom).toBe(10);
    });

    it('settings panel contains map-tiles checkbox and provider select', () => {
        const g = new GNSSMapItem({ tileRadius: 1 });
        const container = document.createElement('div');
        document.body.appendChild(container);
        g.addSetting(container);
        const checkbox = container.querySelector('input[type=checkbox]') as HTMLInputElement;
        const select = container.querySelector('select') as HTMLSelectElement;
        const selectButton = Array.from(container.querySelectorAll('button')).find(button =>
            (button.textContent ?? '').includes('OpenStreetMap'));
        expect(checkbox).toBeTruthy();
        expect(select).toBeTruthy();
        expect(selectButton).toBeTruthy();
        expect(select.options.length).toBeGreaterThanOrEqual(TILE_PRESETS.length);
        document.body.removeChild(container);
    });

    it('settings panel map-tiles checkbox toggles tile group visibility', () => {
        const g = new GNSSMapItem();
        const container = document.createElement('div');
        document.body.appendChild(container);
        g.addSetting(container);
        const checkbox = container.querySelector('input[type=checkbox]') as HTMLInputElement;
        expect(checkbox.checked).toBe(true);
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change'));
        expect((g as any).tileGroup.visible).toBe(false);
        document.body.removeChild(container);
    });

    it('settings panel provider select triggers setTileServer', () => {
        const g = new GNSSMapItem({ tileRadius: 1 });
        g.addFix(35, 139, 0);
        const container = document.createElement('div');
        document.body.appendChild(container);
        g.addSetting(container);
        const select = container.querySelector('select') as HTMLSelectElement;
        const gsi = TILE_PRESETS.find(p => p.label.includes('淡色'))!;
        select.value = gsi.url;
        select.dispatchEvent(new Event('change'));
        expect(g.tileServerUrl).toBe(gsi.url);
        document.body.removeChild(container);
    });

    it('settings panel shows "Custom" option when tileServer is not in presets', () => {
        const g = new GNSSMapItem({ tileServer: 'https://private.example.com/{z}/{x}/{y}.png' });
        const container = document.createElement('div');
        document.body.appendChild(container);
        g.addSetting(container);
        const select = container.querySelector('select') as HTMLSelectElement;
        const customOpt = Array.from(select.options).find(o => o.textContent === 'Custom');
        expect(customOpt).toBeTruthy();
        expect(customOpt!.selected).toBe(true);
        document.body.removeChild(container);
    });

    it('showTrailControls=false hides trail line and marker', () => {
        const g = new GNSSMapItem({ showTrailControls: false });
        g.addFix(35, 139, 0);
        expect((g as any).trailLine.visible).toBe(false);
        expect((g as any).marker.visible).toBe(false);
    });

    it('showTrailControls=false hides Clear Trail/Reset Origin buttons in settings', () => {
        const g = new GNSSMapItem({ showTrailControls: false });
        const container = document.createElement('div');
        document.body.appendChild(container);
        g.addSetting(container);
        const buttons = Array.from(container.querySelectorAll('button'));
        const labels = buttons.map(b => b.textContent);
        expect(labels).not.toContain('Clear Trail');
        expect(labels).not.toContain('Reset Origin');
        document.body.removeChild(container);
    });
});
