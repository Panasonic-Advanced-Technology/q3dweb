import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('three', async () => {
  const actual = await vi.importActual<any>('three');
  class FakeWebGLRenderer {
    domElement: HTMLCanvasElement;
    capabilities = { isWebGL2: true, maxTextures: 16 };
    constructor() { this.domElement = document.createElement('canvas'); }
    setPixelRatio() {}
    setSize(width: number, height: number) { this.domElement.width = width; this.domElement.height = height; }
    render() {}
    dispose() {}
    resetState() {}
    getContext() { return {}; }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { CloudViewer } from '../src/cloud_viewer';
import { FilmMakerViewer } from '../src/film_maker_viewer';
import { installViewerModeSelector } from '../src/viewerMode';

function makeContainer(): void {
  const container = document.createElement('div');
  container.id = 'app';
  document.body.appendChild(container);
}

describe('CloudViewer open files button', () => {
  beforeEach(() => {
    makeContainer();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows an Open Files button in cloud viewer settings and opens the picker', () => {
    const viewer = new CloudViewer('app');
    installViewerModeSelector(viewer, 'cloud', vi.fn());

    const button = viewer.settingsPanel!.querySelector('[data-role="cloud-open-file-button"]') as HTMLButtonElement;
    const input = viewer.settingsPanel!.querySelector('[data-role="cloud-open-file-input"]') as HTMLInputElement;
    const section = viewer.settingsPanel!.querySelector('[data-role="cloud-open-file-section"]') as HTMLElement;
    const modeSelect = viewer.settingsPanel!.querySelector('[data-role="viewer-mode-select"]') as HTMLSelectElement;
    const modeWrapper = modeSelect.closest('.q3d-material-select') as HTMLElement;
    const itemLabel = viewer.settingsPanel!.querySelector('[data-role="settings-item-label"]') as HTMLElement;

    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {});
    button.click();

    expect(button.textContent).toContain('Open Files');
    expect(input.accept).toBe('.pcd,.ply,.las,.laz,.e57');
    expect(section.textContent).not.toContain('Open point cloud file');
    expect(Array.from(viewer.settingsPanel!.children).indexOf(section)).toBeGreaterThan(
      Array.from(viewer.settingsPanel!.children).indexOf(modeWrapper),
    );
    expect(Array.from(viewer.settingsPanel!.children).indexOf(section)).toBeLessThan(
      Array.from(viewer.settingsPanel!.children).indexOf(itemLabel),
    );
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it('loads selected files sequentially, keeps the button visible, and exposes it in film maker mode', async () => {
    const viewer = new FilmMakerViewer('app');
    installViewerModeSelector(viewer, 'film_maker', vi.fn());

    const button = viewer.settingsPanel!.querySelector('[data-role="cloud-open-file-button"]') as HTMLButtonElement;
    const input = viewer.settingsPanel!.querySelector('[data-role="cloud-open-file-input"]') as HTMLInputElement;
    const loadSpy = vi.spyOn(viewer, 'loadFile').mockResolvedValue(undefined);
    const first = new File(['a'], 'first.pcd');
    const second = new File(['b'], 'second.las');

    expect(button).toBeTruthy();

    Object.defineProperty(input, 'files', {
      value: [first, second],
      configurable: true,
    });

    input.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    viewer.onSettingsItemSelected('grid');

    expect(loadSpy).toHaveBeenNthCalledWith(1, first, false);
    expect(loadSpy).toHaveBeenNthCalledWith(2, second, true);
    expect(viewer.settingsPanel!.querySelector('[data-role="cloud-open-file-button"]')).toBe(button);
  });
});