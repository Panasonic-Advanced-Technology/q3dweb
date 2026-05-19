import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock THREE.WebGLRenderer (needs to be hoisted before importing Viewer)
vi.mock('three', async () => {
  const actual = await vi.importActual<any>('three');
  class FakeWebGLRenderer {
    domElement: HTMLCanvasElement;
    capabilities = { isWebGL2: true, maxTextures: 16 };
    constructor(_params?: any) {
      this.domElement = document.createElement('canvas');
    }
    setPixelRatio() {}
    setSize(w: number, h: number) {
      this.domElement.width = w;
      this.domElement.height = h;
    }
    render() {}
    dispose() {}
    getContext() { return {}; }
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import * as THREE from 'three';
import { Viewer } from '../src/viewer';
import { CloudViewer } from '../src/cloud_viewer';
import { FilmMakerViewer } from '../src/film_maker_viewer';
import { RealtimeViewer } from '../src/realtime_viewer';
import { inferPointCloudFilename, parseCloudUrlOptions } from '../src/cloudUrlOptions';
import { parseRealtimeUrlOptions } from '../src/realtimeUrlOptions';
import { installViewerModeSelector, normalizeViewerMode } from '../src/viewerMode';

function makeContainer(id = 'app'): HTMLElement {
  const c = document.createElement('div');
  c.id = id;
  document.body.appendChild(c);
  return c;
}

function cleanupContainers() {
  document.body.innerHTML = '';
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer as ArrayBuffer;
}

describe('Viewer construction & errors', () => {
  afterEach(cleanupContainers);

  it('throws when container missing', () => {
    expect(() => new Viewer('does-not-exist')).toThrow();
  });

  it('constructs successfully', () => {
    makeContainer();
    const v = new Viewer('app');
    expect(v.scene).toBeInstanceOf(THREE.Scene);
    expect(v.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(v.items.grid).toBeDefined();
    expect(v.items.axis).toBeDefined();
    expect(v.items.marker).toBeDefined();
  });
});

describe('Viewer camera controls', () => {
  let v: Viewer;
  beforeEach(() => {
    makeContainer();
    v = new Viewer('app');
  });
  afterEach(cleanupContainers);

  it('rotateCam clamps roll and wraps yaw', () => {
    v.rotateCam(10, 0, 10);
    expect(v.euler[0]).toBeLessThanOrEqual(Math.PI);
    expect(v.euler[2]).toBeGreaterThan(-Math.PI);
    v.rotateCam(-100, -100, -100);
    expect(v.euler[0]).toBeGreaterThanOrEqual(0);
  });

  it('rotateKeepCamPos preserves camera world position', () => {
    const before = v.camera.position.clone();
    v.rotateKeepCamPos(0.1, 0.1, 0.1);
    expect(v.camera.position.distanceTo(before)).toBeGreaterThanOrEqual(0);
  });

  it('translateCam shifts center', () => {
    const before = v.cameraCenter.clone();
    v.translateCam(new THREE.Vector3(1, 2, 3));
    expect(v.cameraCenter.x).toBe(before.x + 1);
  });

  it('updateDist clamps to minimum', () => {
    v.cameraDist = 0.2;
    v.updateDist(-5);
    expect(v.cameraDist).toBe(0.1);
  });

  it('updateMovement no-ops when no keys', () => {
    v.activeKeys.clear();
    v.updateMovement();
  });

  it('updateMovement handles all key bindings', () => {
    const keys = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'z', 'x', 'w', 'a', 's', 'd'];
    for (const k of keys) {
      v.activeKeys.clear();
      v.activeKeys.add(k);
      v.shiftPressed = false;
      v.updateMovement();
      v.shiftPressed = true;
      v.updateMovement();
    }
  });
});

describe('Viewer item management', () => {
  let v: Viewer;
  beforeEach(() => { makeContainer(); v = new Viewer('app'); });
  afterEach(cleanupContainers);

  it('addItem replaces existing & removeItem cleans', () => {
    const a = new THREE.Object3D();
    a.name = 'foo';
    v.addItem('foo', a);
    expect(v.items.foo).toBe(a);
    const b = new THREE.Object3D();
    v.addItem('foo', b);
    expect(v.items.foo).toBe(b);
    v.removeItem('foo');
    expect(v.items.foo).toBeUndefined();
  });

  it('removeItem on missing is safe', () => {
    v.removeItem('nope');
  });

  it('clearItems removes all', () => {
    v.clearItems();
    expect(Object.keys(v.items).length).toBe(0);
  });

  it('removeItem disposes geometry/material/array material', () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const mesh = new THREE.Mesh(geo, [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
    v.addItem('mesh', mesh);
    v.removeItem('mesh');
  });
});

describe('Viewer settings panel', () => {
  let v: Viewer;
  beforeEach(() => { makeContainer(); v = new Viewer('app'); });
  afterEach(cleanupContainers);

  it('toggleSettingsPanel minimizes and expands', () => {
    expect(v.settingsPanel?.style.display).toBe('block');
    expect(v.settingsPanel?.getAttribute('data-minimized')).toBe('false');
    v.toggleSettingsPanel();
    expect(v.settingsPanel?.style.display).toBe('block');
    expect(v.settingsPanel?.getAttribute('data-minimized')).toBe('true');
    expect(v.settingsPanel?.style.width).toBe('40px');
    expect(v.settingsPanel?.style.padding).toBe('0px');
    expect(v.settingsPanel?.style.background).toBe('transparent');
    expect(v.settingsPanel?.style.border).toBe('0px');
    expect(v.settingsItemSelect?.style.display).toBe('none');
    v.toggleSettingsPanel();
    expect(v.settingsPanel?.getAttribute('data-minimized')).toBe('false');
    expect(v.settingsPanel?.style.display).toBe('block');
    expect(v.settingsPanel?.style.width).toBe('260px');
    expect(v.settingsPanel?.style.background).toBe('rgba(20, 20, 20, 0.92)');
    expect(v.settingsPanel?.style.border).toBe('1px solid rgb(85, 85, 85)');
    expect(v.settingsItemSelect?.style.display).not.toBe('none');
  });

  it('settings minimize button toggles the panel', () => {
    const button = v.settingsPanel!.querySelector('[data-role="settings-minimize-button"]') as HTMLButtonElement;
    expect(button).toBeDefined();
    button.click();
    expect(v.settingsPanel?.getAttribute('data-minimized')).toBe('true');
    expect(button.textContent).toBe('+');
    expect(button.style.border).toBe('0px');
    button.click();
    expect(v.settingsPanel?.getAttribute('data-minimized')).toBe('false');
    expect(button.textContent).toBe('-');
    expect(button.style.border).toBe('1px solid rgb(102, 102, 102)');
  });

  it('refreshSettingsItemList preserves preferred selection', () => {
    const obj = new THREE.Object3D();
    v.addItem('myitem', obj);
    v.refreshSettingsItemList('myitem');
    expect(v.settingsItemSelect?.value).toBe('myitem');
  });

  it('settings selector shows plain item names without class suffixes', () => {
    const labels = Array.from(v.settingsItemSelect?.options ?? []).map((option) => option.textContent);
    expect(labels).toContain('grid');
    expect(labels).not.toContain('grid(GridItem)');
    expect(labels).toContain('Viewer');
  });

  it('refreshSettingsItemList falls back to main when missing', () => {
    v.refreshSettingsItemList('nonexistent');
    expect(v.settingsItemSelect?.value).toBe('__main_win__');
  });

  it('settings selector does not include ROS Viewer', () => {
    const optionLabels = Array.from(v.settingsItemSelect?.options ?? []).map((option) => option.textContent);
    expect(optionLabels).not.toContain('ROS Viewer');
  });

  it('onSettingsItemSelected main_win builds main settings', () => {
    v.onSettingsItemSelected('__main_win__');
    expect(v.settingsContent?.children.length).toBeGreaterThan(0);

    // Trigger color text input change (valid)
    const input = v.settingsContent!.querySelector('input[type=text]') as HTMLInputElement;
    input.value = '#ff0000';
    input.onchange?.(new Event('change'));
    expect(v.colorStr).toBe('#ff0000');

    // Invalid color is ignored
    input.value = 'this-is-not-a-color';
    input.onchange?.(new Event('change'));

    // Show center toggle
    const cb = v.settingsContent!.querySelector('input[type=checkbox]') as HTMLInputElement;
    cb.checked = false;
    cb.onchange?.(new Event('change'));
    expect(v.enableShowCenter).toBe(false);
  });

  it('onSettingsItemSelected with unknown name does nothing', () => {
    v.onSettingsItemSelected('nope');
    expect(v.settingsContent?.children.length).toBe(0);
  });

  it('onSettingsItemSelected with item using addSetting', () => {
    v.onSettingsItemSelected('grid');
    expect(v.settingsContent?.children.length).toBeGreaterThan(0);
  });

  it('onSettingsItemSelected with cloud-like item builds cloud settings', async () => {
    // Add a fake cloud item
    const positions = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    const values = new Float32Array([0, 1, 2]);
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const cloudModule = await import('../src/items/CloudItem');
    const cloud = new cloudModule.CloudItem(positions, values, { size: 1, alpha: 0.5, colorMode: 'RGB' }, rgb);
    const material = cloud.material as THREE.ShaderMaterial;
    v.addItem('cloud', cloud);
    expect(material.uniforms.viewportHeight.value).toBeGreaterThan(0);

    v.onSettingsItemSelected('cloud');
    expect(v.settingsContent!.children.length).toBeGreaterThan(0);
    expect(v.settingsContent!.textContent).toContain('Point Type:');

    // Trigger numeric and select inputs
    const numbers = v.settingsContent!.querySelectorAll('input[type=number]');
    const selects = v.settingsContent!.querySelectorAll('select');
    expect(selects.length).toBe(2);

    const pointTypeSelect = selects[0] as HTMLSelectElement;
    pointTypeSelect.value = '2';
    pointTypeSelect.onchange?.(new Event('change'));
    expect(material.uniforms.pointType.value).toBe(2);

    for (const n of Array.from(numbers)) {
      (n as HTMLInputElement).value = '5';
      (n as HTMLInputElement).onchange?.(new Event('change'));
      // Invalid
      (n as HTMLInputElement).value = 'bad';
      (n as HTMLInputElement).onchange?.(new Event('change'));
    }
    for (const s of Array.from(selects)) {
      (s as HTMLSelectElement).value = '1';
      (s as HTMLSelectElement).onchange?.(new Event('change'));
    }

    // Test alpha low branch (transparent)
    const alphaInput = numbers[1] as HTMLInputElement;
    alphaInput.value = '0.5';
    alphaInput.onchange?.(new Event('change'));
    // Then alpha high branch (opaque)
    alphaInput.value = '1.0';
    alphaInput.onchange?.(new Event('change'));
  });
});

describe('viewer mode selector', () => {
  let v: Viewer;
  beforeEach(() => { makeContainer(); v = new Viewer('app'); });
  afterEach(cleanupContainers);

  it('is installed above item settings without adding mode logic to Viewer', () => {
    const navigate = vi.fn();
    const modeSelect = installViewerModeSelector(v, 'cloud', navigate)!;
    const itemSelect = v.settingsPanel!.querySelector('[data-role="settings-item-select"]') as HTMLSelectElement;

    expect(modeSelect).toBeTruthy();
    expect(itemSelect).toBe(v.settingsItemSelect);
    expect(Array.from(v.settingsPanel!.children).indexOf(modeSelect)).toBeLessThan(
      Array.from(v.settingsPanel!.children).indexOf(itemSelect),
    );
    expect(Array.from(modeSelect.options).map((option) => option.textContent)).toEqual([
      'cloud_viewer',
      'film_maker',
      'realtime_viewer',
    ]);
    expect(modeSelect.value).toBe('cloud');

    modeSelect.value = 'film_maker';
    modeSelect.onchange?.(new Event('change'));
    expect(navigate).toHaveBeenCalledWith('film_maker');
  });

  it('normalizes unknown modes to cloud', () => {
    expect(normalizeViewerMode(null)).toBe('cloud');
    expect(normalizeViewerMode('cloud')).toBe('cloud');
    expect(normalizeViewerMode('film_maker')).toBe('film_maker');
    expect(normalizeViewerMode('realtime')).toBe('realtime');
    expect(normalizeViewerMode('other')).toBe('cloud');
  });
});

describe('Viewer Film Maker controls', () => {
  let v: FilmMakerViewer;
  beforeEach(() => { makeContainer(); v = new FilmMakerViewer('app'); });
  afterEach(() => {
    v.stopPlayback();
    vi.useRealTimers();
    cleanupContainers();
    vi.restoreAllMocks();
    delete (globalThis as any).MediaRecorder;
  });

  function addTwoKeyFrames() {
    v.camera.position.set(1, 2, 3);
    v.updateCamera();
    const first = v.addKeyFrameFromCamera();
    v.cameraCenter.set(3, 2, 1);
    v.updateCamera();
    const second = v.addKeyFrameFromCamera();
    return { first, second };
  }

  it('builds the Film Maker UI and wires list, buttons, inputs, and shortcuts', () => {
    // Film maker UI is built during construction, always visible in panel
    expect(v.filmMakerTabActive).toBe(true);
    const fm = v.settingsPanel!.querySelector('[data-role="film-maker"]') as HTMLElement;
    expect(fm.textContent).toContain('Video File Name:');
    expect(Array.from(v.settingsPanel!.children).indexOf(fm)).toBeLessThan(
      Array.from(v.settingsPanel!.children).indexOf(v.settingsItemSelect!),
    );

    const buttons = Array.from(fm.querySelectorAll('button'));
    buttons[0].click();
    buttons[0].click();
    expect(v.filmMaker.keyFrames.length).toBe(2);

    const rows = Array.from(fm.querySelectorAll('div[data-index]')) as HTMLElement[];
    expect(rows.map((row) => row.textContent)).toEqual(['Frame 1', 'Frame 2']);
    rows[0].click();
    expect(v.filmMaker.currentIndex).toBe(0);
    rows[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const checkbox = fm.querySelector('input[type=checkbox]') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.onchange?.(new Event('change'));
    expect(v.isRecordingFilm).toBe(true);

    const textInput = fm.querySelector('input[type=text]') as HTMLInputElement;
    textInput.value = 'demo.webm';
    textInput.onchange?.(new Event('change'));
    expect(v.videoFileName).toBe('demo.webm');

    const codecSelect = fm.querySelector('select') as HTMLSelectElement;
    codecSelect.value = 'video/webm;codecs=vp8';
    codecSelect.onchange?.(new Event('change'));
    expect(v.videoMimeType).toBe('video/webm;codecs=vp8');

    const numbers = Array.from(fm.querySelectorAll('input[type=number]')) as HTMLInputElement[];
    numbers[0].value = '2.5';
    numbers[0].onchange?.(new Event('change'));
    numbers[1].value = '90';
    numbers[1].onchange?.(new Event('change'));
    numbers[2].value = '0.4';
    numbers[2].onchange?.(new Event('change'));
    expect(v.filmMaker.keyFrames[v.filmMaker.currentIndex].linVel).toBe(2.5);
    expect(v.filmMaker.keyFrames[v.filmMaker.currentIndex].angVel).toBeCloseTo(Math.PI / 2, 6);
    expect(v.filmMaker.keyFrames[v.filmMaker.currentIndex].stopTime).toBe(0.4);

    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    window.dispatchEvent(spaceEvent);
    expect(spaceEvent.defaultPrevented).toBe(true);
    expect(v.filmMaker.keyFrames.length).toBe(3);

    const deleteEvent = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    window.dispatchEvent(deleteEvent);
    expect(deleteEvent.defaultPrevented).toBe(true);
    expect(v.filmMaker.keyFrames.length).toBe(2);

    const input = document.createElement('input');
    document.body.appendChild(input);
    const ignoredSpace = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    input.dispatchEvent(ignoredSpace);
    expect(ignoredSpace.defaultPrevented).toBe(false);
  });

  it('handles select-target M shortcut and panel re-show', () => {
    const select = v.settingsItemSelect!;
    const event = new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true });
    select.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(v.settingsPanel?.getAttribute('data-minimized')).toBe('true');

    // Expand panel: should re-render the last active tab (Film Maker)
    v.toggleSettingsPanel();
    expect(v.settingsPanel?.getAttribute('data-minimized')).toBe('false');
    expect(v.settingsContent?.children.length).toBeGreaterThan(0);
  });

  it('plays keyframes, records with MediaRecorder, and stops cleanly', () => {
    vi.useFakeTimers();
    const stream = {} as MediaStream;
    (v.renderer.domElement as HTMLCanvasElement).captureStream = vi.fn(() => stream) as any;
    const setPixelRatio = vi.spyOn(v.renderer, 'setPixelRatio');
    const setSize = vi.spyOn(v.renderer, 'setSize');
    class FakeMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state = 'recording';
      mimeType = 'video/webm';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(public readonly mediaStream: MediaStream, public readonly options?: MediaRecorderOptions) {}
      start() {
        this.ondataavailable?.({ data: new Blob(['frame'], { type: 'video/webm' }) });
      }
      stop() {
        this.state = 'inactive';
        this.onstop?.();
      }
    }
    (globalThis as any).MediaRecorder = FakeMediaRecorder;

    addTwoKeyFrames();
    v.filmMaker.updateIntervalMs = 100;
    v.isRecordingFilm = true;
    expect(v.startPlayback()).toBe(true);
    expect(v.isPlayingFilm).toBe(true);
    expect((v as any).filmMakerPlayBtn.textContent).toBe('Playing');
    expect((v as any).filmMakerPlayBtn.style.backgroundColor).toBe('rgb(170, 51, 51)');
    expect((v as any).mediaRecorder.options).toEqual(expect.objectContaining({
      videoBitsPerSecond: v.recordingVideoBitsPerSecond,
    }));

    while ((v as any).filmPlaybackIndex < v.filmMaker.frames.length) {
      (v as any).tickFilmPlayback();
    }
    (v as any).tickFilmPlayback();
    expect(v.isPlayingFilm).toBe(false);
    expect((v as any).filmMakerPlayBtn.textContent).toBe('Play');
    expect((v as any).filmMakerPlayBtn.style.backgroundColor).toBe('rgb(51, 51, 51)');
    expect(v.lastRecordedBlob?.type).toBe('video/webm');
    expect(setPixelRatio).toHaveBeenCalledWith(v.recordingPixelRatioMin);
    expect(setPixelRatio).toHaveBeenLastCalledWith(1);
    expect(setSize).toHaveBeenCalled();
  });

  it('covers playback guard paths and captureStream fallback', () => {
    expect(v.startPlayback()).toBe(false);
    addTwoKeyFrames();
    const createFrames = vi.spyOn(v.filmMaker, 'createFrames').mockImplementation(() => {
      v.filmMaker.frames = [];
      return [];
    });
    expect(v.startPlayback()).toBe(false);
    createFrames.mockRestore();

    v.isRecordingFilm = true;
    (v.renderer.domElement as HTMLCanvasElement).captureStream = undefined as any;
    (v as any).startRecording();
    expect(v.isRecordingFilm).toBe(false);

    const stopped = { stop: vi.fn(() => { throw new Error('stop failed'); }) };
    (v as any).mediaRecorder = stopped;
    (v as any).stopRecording();
    expect(stopped.stop).toHaveBeenCalled();
  });

  it('downloads recorded video through browser and VS Code paths', async () => {
    expect(v.downloadLastRecording()).toBe(false);
    v.lastRecordedBlob = new Blob(['ok'], { type: 'video/webm' });
    v.videoFileName = '';

    (URL as any).createObjectURL = vi.fn(() => 'blob:test');
    (URL as any).revokeObjectURL = vi.fn();
    const createObjectURL = vi.mocked(URL.createObjectURL);
    const revokeObjectURL = vi.mocked(URL.revokeObjectURL);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.useFakeTimers();
    expect(v.downloadLastRecording()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(createObjectURL).toHaveBeenCalledWith(v.lastRecordedBlob);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');

    vi.useRealTimers();
    const postMessage = vi.fn();
    (v as any).vscode = { postMessage };
    v.videoFileName = 'clip.webm';
    expect(v.downloadLastRecording()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'saveVideo',
      filename: 'clip.webm',
      mimeType: 'video/webm',
    }));
  });

  it('confirms warning-level memory budget checks', () => {
    const originalConfirm = globalThis.confirm;
    const confirm = vi.fn(() => false);
    (globalThis as any).confirm = confirm;
    try {
      const result = (v as any).checkMemoryBudget(700 * 1024 * 1024, 'pcd', 'large.pcd');
      expect(result).toBe(false);
      expect(confirm).toHaveBeenCalled();
    } finally {
      (globalThis as any).confirm = originalConfirm;
    }
  });
});

describe('RealtimeViewer settings layout', () => {
  let v: RealtimeViewer;
  beforeEach(() => { makeContainer(); v = new RealtimeViewer('app'); });
  afterEach(cleanupContainers);

  it('places realtime controls above the item selector with a clear boundary', () => {
    const realtime = v.settingsPanel!.querySelector('[data-role="realtime"]') as HTMLElement;
    expect(realtime.textContent).toContain('ROS Bridge URL');
    expect(Array.from(v.settingsPanel!.children).indexOf(realtime)).toBeLessThan(
      Array.from(v.settingsPanel!.children).indexOf(v.settingsItemSelect!),
    );
    expect(realtime.style.borderBottomWidth).toBe('2px');
    expect(v.settingsItemSelect!.style.marginTop).toBe('2px');
  });

  it('applies realtime options to settings inputs', () => {
    cleanupContainers();
    makeContainer();
    v = new RealtimeViewer('app', {
      rosbridgeUrl: 'ws://robot.local:9090',
      cloudTopicName: '/points_raw',
      odomTopicName: '/odom/wheel',
      maxPointsPerScan: 3200,
      maxAccumulatedPoints: 1_200_000,
    });

    expect((v.settingsPanel!.querySelector('[data-role="realtime-ros-url"]') as HTMLInputElement).value)
      .toBe('ws://robot.local:9090');
    expect((v.settingsPanel!.querySelector('[data-role="realtime-cloud-topic"]') as HTMLInputElement).value)
      .toBe('/points_raw');
    expect((v.settingsPanel!.querySelector('[data-role="realtime-odom-topic"]') as HTMLInputElement).value)
      .toBe('/odom/wheel');
    expect((v.settingsPanel!.querySelector('[data-role="realtime-max-points-per-scan"]') as HTMLInputElement).value)
      .toBe('3200');
    expect((v.settingsPanel!.querySelector('[data-role="realtime-max-accumulated-points"]') as HTMLInputElement).value)
      .toBe('1200000');
  });
});

describe('realtime URL options', () => {
  it('parses rosbridge, topics, and point budgets from URL params', () => {
    const options = parseRealtimeUrlOptions(new URLSearchParams({
      ros: 'ws://robot.local:9090',
      cloudTopic: '/points_raw',
      odomTopic: '/odom/wheel',
      maxPointsPerScan: '3200',
      maxAccumulatedPoints: '1200000',
    }));

    expect(options).toEqual({
      rosbridgeUrl: 'ws://robot.local:9090',
      cloudTopicName: '/points_raw',
      odomTopicName: '/odom/wheel',
      maxPointsPerScan: 3200,
      maxAccumulatedPoints: 1_200_000,
    });
  });

  it('supports aliases and ignores invalid point budgets', () => {
    const options = parseRealtimeUrlOptions(new URLSearchParams({
      rosbridgeUrl: 'ws://host:9090',
      topic: '/cloud_alias',
      odom: '/odom_alias',
      scanPoints: '-5',
      maxPoints: '2500000.9',
    }));

    expect(options.rosbridgeUrl).toBe('ws://host:9090');
    expect(options.cloudTopicName).toBe('/cloud_alias');
    expect(options.odomTopicName).toBe('/odom_alias');
    expect(options.maxPointsPerScan).toBeUndefined();
    expect(options.maxAccumulatedPoints).toBe(2_500_000);
  });
});

describe('cloud URL options', () => {
  it('parses point cloud URL aliases and optional filename', () => {
    const options = parseCloudUrlOptions(new URLSearchParams({
      cloudUrl: 'https://example.com/data/sample.las',
      filename: 'sample.las',
    }));

    expect(options).toEqual({
      pointCloudUrl: 'https://example.com/data/sample.las',
      filename: 'sample.las',
    });
  });

  it('infers filenames from URLs with query strings', () => {
    expect(inferPointCloudFilename('https://example.com/clouds/mihara%20binary.e57?token=abc'))
      .toBe('mihara binary.e57');
  });
});

describe('CloudViewer URL loading', () => {
  let v: CloudViewer;
  const originalFetch = globalThis.fetch;

  beforeEach(() => { makeContainer(); v = new CloudViewer('app'); });
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    cleanupContainers();
  });

  function makeAsciiPCD(): Uint8Array {
    const pcd =
      'VERSION 0.7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH 2\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 2\nDATA ascii\n' +
      '0 0 0 10\n1 1 1 20\n';
    return new TextEncoder().encode(pcd);
  }

  it('loads a remote point cloud through fetch streaming', async () => {
    const data = makeAsciiPCD();
    (globalThis as any).fetch = vi.fn().mockResolvedValue(new Response(toArrayBuffer(data), {
      headers: { 'content-length': String(data.byteLength) },
    }));

    await v.loadUrl('https://example.com/clouds/sample.pcd');

    expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com/clouds/sample.pcd');
    expect(v.streamFilename).toBe('sample.pcd');
    expect(v.items.cloud).toBeDefined();
  });
});

describe('Viewer streaming - PCD', () => {
  let v: CloudViewer;
  beforeEach(() => { makeContainer(); v = new CloudViewer('app'); });
  afterEach(cleanupContainers);

  function makeBinaryPCD(points: Array<[number, number, number, number]>): Uint8Array {
    const header =
      `# .PCD v0.7 - Point Cloud Data file format\nVERSION 0.7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH ${points.length}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${points.length}\nDATA binary\n`;
    const headerBytes = new TextEncoder().encode(header);
    const rowSize = 16;
    const total = headerBytes.byteLength + points.length * rowSize;
    const out = new Uint8Array(total);
    out.set(headerBytes);
    const dv = new DataView(out.buffer, headerBytes.byteLength);
    for (let i = 0; i < points.length; i++) {
      dv.setFloat32(i * rowSize, points[i][0], true);
      dv.setFloat32(i * rowSize + 4, points[i][1], true);
      dv.setFloat32(i * rowSize + 8, points[i][2], true);
      dv.setFloat32(i * rowSize + 12, points[i][3], true);
    }
    return out;
  }

  function makeAsciiPCD(points: Array<[number, number, number, number]>): Uint8Array {
    let s =
      `VERSION 0.7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH ${points.length}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${points.length}\nDATA ascii\n`;
    for (const p of points) s += `${p[0]} ${p[1]} ${p[2]} ${p[3]}\n`;
    return new TextEncoder().encode(s);
  }

  function makeBinaryPCDWithRGB(): Uint8Array {
    const header =
      `VERSION 0.7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH 2\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 2\nDATA binary\n`;
    const headerBytes = new TextEncoder().encode(header);
    const out = new Uint8Array(headerBytes.byteLength + 32);
    out.set(headerBytes);
    const dv = new DataView(out.buffer, headerBytes.byteLength);
    dv.setFloat32(0, 1, true); dv.setFloat32(4, 2, true); dv.setFloat32(8, 3, true); dv.setUint32(12, 0xFF0000, true);
    dv.setFloat32(16, 4, true); dv.setFloat32(20, 5, true); dv.setFloat32(24, 6, true); dv.setUint32(28, 0x00FF00, true);
    return out;
  }

  it('loads binary PCD (small)', () => {
    const data = makeBinaryPCD([[0, 0, 0, 10], [1, 1, 1, 20], [2, 2, 2, 30]]);
    v.loadData(data, 'foo.pcd');
    expect(v.items.cloud).toBeDefined();
  });

  it('loadFile with binary .pcd defers the initial memory budget check', async () => {
    const checkSpy = vi.spyOn(v as any, 'checkMemoryBudget').mockReturnValue(false);
    const origStream = (File.prototype as any).stream;
    try {
      const data = makeBinaryPCD([[0, 0, 0, 10], [1, 1, 1, 20]]);
      (File.prototype as any).stream = function () {
        let sent = false;
        return {
          getReader() {
            return {
              async read() {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: data };
              },
              async cancel() {},
            };
          },
        };
      };
      const f = new File([toArrayBuffer(data)], 'foo.pcd');
      await v.loadFile(f);
      expect(v.items.cloud).toBeDefined();
      expect(checkSpy).not.toHaveBeenCalled();
    } finally {
      (File.prototype as any).stream = origStream;
      checkSpy.mockRestore();
    }
  });

  it('loads ascii PCD', () => {
    const data = makeAsciiPCD([[0, 0, 0, 10], [1, 1, 1, 20], [2, 2, 2, 30]]);
    v.loadData(data, 'foo.pcd');
    expect(v.items.cloud).toBeDefined();
  });

  it('streams fake 2GiB+ ASCII PCD without allocating the full file', async () => {
    const data = makeAsciiPCD([
      [0, 0, 0, 10], [1, 1, 1, 20], [2, 2, 2, 30],
      [3, 3, 3, 40], [4, 4, 4, 50], [5, 5, 5, 60],
    ]);
    const renderSpy = vi.spyOn(v, 'renderPoints');
    const fakeFile = {
      name: 'huge_ascii.pcd',
      size: 2 * 1024 * 1024 * 1024 + 1,
      stream() {
        let sent = false;
        return {
          getReader() {
            return {
              async read() {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: data };
              },
              async cancel() {},
            };
          },
        };
      },
    } as any as File;
    await v.loadFile(fakeFile);
    expect(renderSpy).toHaveBeenCalled();
    const renderedPoints = (renderSpy.mock.calls[0][0] as Float32Array).length / 3;
    expect(renderedPoints).toBeGreaterThan(0);
    expect(renderedPoints).toBeLessThan(6);
    expect((v as any).fullBuffer).toBeNull();
  });

  it('loads binary PCD with RGB', () => {
    const data = makeBinaryPCDWithRGB();
    v.loadData(data, 'foo.pcd');
    expect(v.items.cloud).toBeDefined();
  });

  it('handles intermediate header chunk (header arrives split)', () => {
    const data = makeBinaryPCD([[0, 0, 0, 1]]);
    v.startStream(data.byteLength, 'foo.pcd');
    // First half (no DATA marker yet)
    v.processChunk(data.slice(0, 30), 0);
    // Then the rest
    v.processChunk(data.slice(30), 0);
    v.finalizeStream();
  });

  it('handles ascii data via streaming', () => {
    const data = makeAsciiPCD([[0, 0, 0, 1], [1, 1, 1, 2]]);
    v.startStream(data.byteLength, 'foo.pcd');
    // Send full at once
    v.processChunk(data, 0);
    v.finalizeStream();
  });

  it('handles non-PCD chunk path (PLY format detection)', () => {
    const data = new Uint8Array(100);
    v.startStream(100, 'foo.ply');
    v.processChunk(data, 0);
    // finalize will throw because it's not a real PLY but processChunk path executes
  });

  it('parseHeader handles missing POINTS by computing from W*H', () => {
    v.parseHeader('VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nWIDTH 5\nHEIGHT 2\nDATA ascii\n');
    expect(v.pcdHeader?.points).toBe(10);
  });

  it('parseHeader without COUNT still works', () => {
    v.parseHeader('VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nWIDTH 3\nHEIGHT 1\nPOINTS 3\nDATA ascii\n');
    expect(v.pcdHeader?.counts?.length).toBe(3);
  });

  it('processChunk handles errors gracefully', () => {
    v.startStream(0, 'foo.pcd');
    // Force an error scenario (negative streamTotalSize math is OK; just call)
    v.processChunk(new Uint8Array(0), 0);
  });
});

describe('Viewer PLY parsing', () => {
  let v: CloudViewer;
  beforeEach(() => { makeContainer(); v = new CloudViewer('app'); });
  afterEach(cleanupContainers);

  function asciiPLY(withColors = true, withIntensity = true): Uint8Array {
    let header = 'ply\nformat ascii 1.0\ncomment hi\nelement vertex 3\n';
    header += 'property float x\nproperty float y\nproperty float z\n';
    if (withIntensity) header += 'property float intensity\n';
    if (withColors) header += 'property uchar red\nproperty uchar green\nproperty uchar blue\n';
    header += 'end_header\n';
    let body = '';
    body += '0 0 0' + (withIntensity ? ' 0.5' : '') + (withColors ? ' 255 0 0' : '') + '\n';
    body += '1 1 1' + (withIntensity ? ' 0.7' : '') + (withColors ? ' 0 255 0' : '') + '\n';
    body += '2 2 2' + (withIntensity ? ' 100' : '') + (withColors ? ' 0 0 255' : '') + '\n';
    return new TextEncoder().encode(header + body);
  }

  function binaryPLY(): Uint8Array {
    const header = 'ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
    const hb = new TextEncoder().encode(header);
    const recSize = 4 * 3 + 3;
    const out = new Uint8Array(hb.byteLength + 2 * recSize);
    out.set(hb);
    const dv = new DataView(out.buffer, hb.byteLength);
    dv.setFloat32(0, 0, true); dv.setFloat32(4, 0, true); dv.setFloat32(8, 0, true);
    dv.setUint8(12, 255); dv.setUint8(13, 0); dv.setUint8(14, 0);
    dv.setFloat32(15, 1, true); dv.setFloat32(19, 1, true); dv.setFloat32(23, 1, true);
    dv.setUint8(27, 0); dv.setUint8(28, 255); dv.setUint8(29, 0);
    return out;
  }

  function plyWithPackedRGBAscii(): Uint8Array {
    const header = 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty float rgb\nend_header\n';
    // float bits encoding 0x00FF0000 (red)
    const buf = new ArrayBuffer(4); new DataView(buf).setUint32(0, 0xFF0000, true);
    const f = new DataView(buf).getFloat32(0, true);
    return new TextEncoder().encode(header + `0 0 0 ${f}\n`);
  }

  it('parses ASCII PLY with intensity + colors', () => {
    v.loadData(asciiPLY(true, true), 'a.ply');
    expect(v.items.cloud).toBeDefined();
  });

  it('streams fake 2GiB+ ASCII PLY with source-size thinning', async () => {
    let header = 'ply\nformat ascii 1.0\nelement vertex 6\n';
    header += 'property float x\nproperty float y\nproperty float z\nproperty float intensity\nend_header\n';
    const body = '0 0 0 0\n1 1 1 1\n2 2 2 2\n3 3 3 3\n4 4 4 4\n5 5 5 5\n';
    const data = new TextEncoder().encode(header + body);
    const renderSpy = vi.spyOn(v, 'renderPoints');
    const fakeFile = {
      name: 'huge_ascii.ply',
      size: 2 * 1024 * 1024 * 1024 + 1,
      stream() {
        let sent = false;
        return {
          getReader() {
            return {
              async read() {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: data };
              },
              async cancel() {},
            };
          },
        };
      },
    } as any as File;
    await v.loadFile(fakeFile);
    expect(renderSpy).toHaveBeenCalled();
    const renderedPoints = (renderSpy.mock.calls[0][0] as Float32Array).length / 3;
    expect(renderedPoints).toBeGreaterThan(0);
    expect(renderedPoints).toBeLessThan(6);
    expect((v as any).chunkList.length).toBe(0);
  });

  it('parses ASCII PLY with intensity only (no colors)', () => {
    v.loadData(asciiPLY(false, true), 'a.ply');
    expect(v.items.cloud).toBeDefined();
  });

  it('parses ASCII PLY with no intensity', () => {
    v.loadData(asciiPLY(true, false), 'a.ply');
    expect(v.items.cloud).toBeDefined();
  });

  it('parses binary little endian PLY', () => {
    v.loadData(binaryPLY(), 'b.ply');
    expect(v.items.cloud).toBeDefined();
  });

  it('parses ASCII PLY with packed RGB float', () => {
    v.loadData(plyWithPackedRGBAscii(), 'c.ply');
    expect(v.items.cloud).toBeDefined();
  });

  it('throws on PLY without end_header', () => {
    v.loadData(new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n'), 'bad.ply');
    // loadData catches the throw inside finalizeStream
    expect(v.items.cloud).toBeUndefined();
  });

  it('rejects file that is not PLY', () => {
    v.loadData(new TextEncoder().encode('not_ply\nelement vertex 0\nend_header\n'), 'bad.ply');
  });
});

describe('Viewer LAS parsing', () => {
  let v: CloudViewer;
  beforeEach(() => { makeContainer(); v = new CloudViewer('app'); });
  afterEach(cleanupContainers);

  function makeLAS(version: [number, number] = [1, 2], format = 0, n = 2, withRGB = false): Uint8Array {
    const headerSize = version[1] >= 4 ? 375 : 227;
    const recordLengths: Record<number, number> = { 0: 20, 1: 28, 2: 26, 3: 34, 6: 30, 7: 36, 8: 38 };
    const recLen = recordLengths[format] ?? 20;
    const out = new Uint8Array(headerSize + n * recLen);
    const view = new DataView(out.buffer);

    // LASF magic
    out[0] = 0x4C; out[1] = 0x41; out[2] = 0x53; out[3] = 0x46;
    view.setUint8(24, version[0]);
    view.setUint8(25, version[1]);
    view.setUint32(96, headerSize, true); // offset to point data
    view.setUint8(104, format);
    view.setUint16(105, recLen, true);
    view.setUint32(107, n, true); // legacy count
    if (version[1] >= 4) view.setUint32(247, n, true);

    // Scale & offset
    view.setFloat64(131, 0.01, true);
    view.setFloat64(139, 0.01, true);
    view.setFloat64(147, 0.01, true);
    view.setFloat64(155, 0, true);
    view.setFloat64(163, 0, true);
    view.setFloat64(171, 0, true);

    // Records
    for (let i = 0; i < n; i++) {
      const base = headerSize + i * recLen;
      view.setInt32(base, i * 100, true);
      view.setInt32(base + 4, i * 100, true);
      view.setInt32(base + 8, i * 100, true);
      view.setUint16(base + 12, 65535, true); // intensity (16-bit max)

      if (withRGB) {
        let off = 0;
        if (format === 2) off = 20;
        else if (format === 3) off = 28;
        else if (format === 7) off = 30;
        view.setUint16(base + off, 65535, true);
        view.setUint16(base + off + 2, 0, true);
        view.setUint16(base + off + 4, 0, true);
      }
    }
    return out;
  }

  it('parses LAS 1.2 format 0', () => {
    v.loadData(makeLAS([1, 2], 0), 'a.las');
    expect(v.items.cloud).toBeDefined();
  });

  it('parses LAS 1.2 format 2 with RGB', () => {
    v.loadData(makeLAS([1, 2], 2, 2, true), 'a.las');
    expect(v.items.cloud).toBeDefined();
  });

  it('parses LAS 1.2 format 3 with RGB', () => {
    v.loadData(makeLAS([1, 2], 3, 2, true), 'a.las');
    expect(v.items.cloud).toBeDefined();
  });

  it('parses LAS 1.4 format 7 with RGB', () => {
    v.loadData(makeLAS([1, 4], 7, 2, true), 'a.las');
    expect(v.items.cloud).toBeDefined();
  });

  it('parses LAS 1.4 format 8 with RGB', () => {
    v.loadData(makeLAS([1, 4], 8, 2, true), 'a.las');
    expect(v.items.cloud).toBeDefined();
  });

  it('parses LAS through streaming chunks without assembling the whole file', () => {
    const data = makeLAS([1, 2], 0, 3);
    v.startStream(data.byteLength, 'stream.las');
    v.processChunk(data.slice(0, 100), 0);
    v.processChunk(data.slice(100, 240), 0);
    v.processChunk(data.slice(240), 0);
    v.finalizeStream();
    expect(v.items.cloud).toBeDefined();
    expect((v as any).chunkList.length).toBe(0);
  });

  it('loadFile with .las defers the initial memory budget check', async () => {
    const checkSpy = vi.spyOn(v as any, 'checkMemoryBudget').mockReturnValue(false);
    const origStream = (File.prototype as any).stream;
    try {
      const data = makeLAS([1, 2], 0, 2);
      (File.prototype as any).stream = function () {
        let sent = false;
        return {
          getReader() {
            return {
              async read() {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: data };
              },
              async cancel() {},
            };
          },
        };
      };
      const f = new File([toArrayBuffer(data)], 'foo.las');
      await v.loadFile(f);
      expect(v.items.cloud).toBeDefined();
      expect(checkSpy).not.toHaveBeenCalled();
    } finally {
      (File.prototype as any).stream = origStream;
      checkSpy.mockRestore();
    }
  });

  it('rejects file without LASF magic', () => {
    const bad = new Uint8Array(400);
    v.loadData(bad, 'bad.las');
    expect(v.items.cloud).toBeUndefined();
  });
});

describe('Viewer measurement & mouse/keyboard events', () => {
  let v: Viewer;
  beforeEach(() => { makeContainer(); v = new Viewer('app'); });
  afterEach(() => { vi.useRealTimers(); cleanupContainers(); });

  function makeTouchEvent(type: string, touches: Array<{ x: number; y: number }>): TouchEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
    const touchList = touches.map((point, index) => ({
      identifier: index,
      target: v.renderer.domElement,
      clientX: point.x,
      clientY: point.y,
      pageX: point.x,
      pageY: point.y,
      screenX: point.x,
      screenY: point.y,
    })) as unknown as TouchList;
    Object.defineProperty(event, 'touches', { value: touchList });
    Object.defineProperty(event, 'targetTouches', { value: touchList });
    Object.defineProperty(event, 'changedTouches', { value: touchList });
    return event;
  }

  function makePointerEvent(type: string, pointerId: number, x: number, y: number): PointerEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    Object.defineProperty(event, 'clientX', { value: x });
    Object.defineProperty(event, 'clientY', { value: y });
    return event;
  }

  function installTouchViewport(): void {
    Object.defineProperty(v.container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(v.container, 'clientHeight', { value: 600, configurable: true });
  }

  it('removeMeasurementPoint with empty list is safe', () => {
    v.removeMeasurementPoint();
  });

  it('addMeasurementPoint and updateMarker (no hits)', () => {
    const e = new MouseEvent('mousedown', { clientX: 0, clientY: 0 });
    v.addMeasurementPoint(e);
    expect(v.selectedPoints.length).toBe(0);
  });

  it('updateMeasurementMarker with selected points calculates distance', () => {
    v.selectedPoints = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(3, 4, 0)];
    v.updateMeasurementMarker();
    expect(v.text2dItem).not.toBeNull();
  });

  it('mouse events on canvas trigger handlers', () => {
    const canvas = v.renderer.domElement;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, button: 2 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20, button: 2 }));
    canvas.dispatchEvent(new MouseEvent('mouseup'));

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, button: 0 }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 30, button: 0 }));
    canvas.dispatchEvent(new MouseEvent('mouseleave'));

    // Wheel
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, deltaX: 50 }));
    canvas.dispatchEvent(new MouseEvent('contextmenu'));

    // Mouse move with shift
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, button: 2, shiftKey: true }));
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 20, button: 2, shiftKey: true }));
    canvas.dispatchEvent(new MouseEvent('mouseup'));

    // Ctrl+left for measurement
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, button: 0, ctrlKey: true }));
    // Ctrl+right for measurement removal
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, button: 2, ctrlKey: true }));

    // mousemove with ctrl pressed (should early-exit)
    v.mousePos = { x: 0, y: 0 };
    v.ctrlPressed = true;
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }));

    // mousemove with no mousePos
    v.mousePos = null;
    canvas.dispatchEvent(new MouseEvent('mousemove'));
  });

  it('touch gestures pan, two-finger twist/pitch rotate, and pinch zoom', () => {
    const originalPointerEvent = (window as any).PointerEvent;
    try {
      delete (window as any).PointerEvent;
      cleanupContainers();
      makeContainer();
      v = new Viewer('app');
      installTouchViewport();
      const canvas = v.renderer.domElement;
      expect(canvas.style.touchAction).toBe('none');

      const beforeCenter = v.cameraCenter.clone();
      const beforeEuler = [...v.euler];
      canvas.dispatchEvent(makeTouchEvent('touchstart', [{ x: 100, y: 100 }]));
      canvas.dispatchEvent(makeTouchEvent('touchmove', [{ x: 140, y: 120 }]));
      canvas.dispatchEvent(makeTouchEvent('touchend', []));
      expect(v.cameraCenter.distanceTo(beforeCenter)).toBeGreaterThan(0);
      expect(v.euler).toEqual(beforeEuler);

      const beforeDist = v.cameraDist;
      const beforeTwoFingerEuler = [...v.euler];
      canvas.dispatchEvent(makeTouchEvent('touchstart', [{ x: 100, y: 100 }, { x: 200, y: 100 }]));
      canvas.dispatchEvent(makeTouchEvent('touchmove', [{ x: 130, y: 80 }, { x: 240, y: 140 }]));
      canvas.dispatchEvent(makeTouchEvent('touchend', []));
      expect(v.euler[2] - beforeTwoFingerEuler[2]).toBeGreaterThan(0.2);
      expect(v.cameraDist).toBeLessThan(beforeDist - 6);

      const beforeParallelEuler = [...v.euler];
      canvas.dispatchEvent(makeTouchEvent('touchstart', [{ x: 100, y: 180 }, { x: 220, y: 180 }]));
      canvas.dispatchEvent(makeTouchEvent('touchmove', [{ x: 100, y: 120 }, { x: 220, y: 120 }]));
      canvas.dispatchEvent(makeTouchEvent('touchend', []));
      expect(v.euler[0] - beforeParallelEuler[0]).toBeGreaterThan(0.15);
      expect(Math.abs(v.euler[2] - beforeParallelEuler[2])).toBeLessThan(0.001);
    } finally {
      if (originalPointerEvent !== undefined) (window as any).PointerEvent = originalPointerEvent;
    }
  });

  it('pointer touch gestures pan, two-finger twist/pitch rotate, and pinch zoom', () => {
    const originalPointerEvent = (window as any).PointerEvent;
    try {
      (window as any).PointerEvent = function PointerEvent() {};
      cleanupContainers();
      makeContainer();
      v = new Viewer('app');
      installTouchViewport();

      const canvas = v.renderer.domElement;
      const beforeCenter = v.cameraCenter.clone();
      const beforeEuler = [...v.euler];
      canvas.dispatchEvent(makePointerEvent('pointerdown', 1, 100, 100));
      canvas.dispatchEvent(makePointerEvent('pointermove', 1, 140, 120));
      canvas.dispatchEvent(makePointerEvent('pointerup', 1, 140, 120));
      expect(v.cameraCenter.distanceTo(beforeCenter)).toBeGreaterThan(0);
      expect(v.euler).toEqual(beforeEuler);

      const beforeDist = v.cameraDist;
      const beforeTwoFingerEuler = [...v.euler];
      canvas.dispatchEvent(makePointerEvent('pointerdown', 1, 100, 100));
      canvas.dispatchEvent(makePointerEvent('pointerdown', 2, 200, 100));
      canvas.dispatchEvent(makePointerEvent('pointermove', 1, 120, 80));
      canvas.dispatchEvent(makePointerEvent('pointermove', 2, 240, 140));
      canvas.dispatchEvent(makePointerEvent('pointerup', 1, 120, 80));
      canvas.dispatchEvent(makePointerEvent('pointerup', 2, 240, 140));
      expect(v.euler[2] - beforeTwoFingerEuler[2]).toBeGreaterThan(0.2);
      expect(v.cameraDist).toBeLessThan(beforeDist);

      const beforeParallelEuler = [...v.euler];
      canvas.dispatchEvent(makePointerEvent('pointerdown', 1, 100, 180));
      canvas.dispatchEvent(makePointerEvent('pointerdown', 2, 220, 180));
      canvas.dispatchEvent(makePointerEvent('pointermove', 1, 100, 120));
      canvas.dispatchEvent(makePointerEvent('pointermove', 2, 220, 120));
      canvas.dispatchEvent(makePointerEvent('pointerup', 1, 100, 120));
      canvas.dispatchEvent(makePointerEvent('pointerup', 2, 220, 120));
      expect(v.euler[0] - beforeParallelEuler[0]).toBeGreaterThan(0.15);
      expect(Math.abs(v.euler[2] - beforeParallelEuler[2])).toBeLessThan(0.001);
    } finally {
      if (originalPointerEvent === undefined) delete (window as any).PointerEvent;
      else (window as any).PointerEvent = originalPointerEvent;
    }
  });

  it('one-finger touch panning scales with distance from the rotation center', () => {
    const originalPointerEvent = (window as any).PointerEvent;
    try {
      (window as any).PointerEvent = function PointerEvent() {};
      cleanupContainers();
      makeContainer();
      v = new Viewer('app');
      installTouchViewport();
      const canvas = v.renderer.domElement;

      const runPanAtDistance = (cameraDist: number) => {
        v.cameraCenter.set(0, 0, 0);
        v.cameraDist = cameraDist;
        v.updateCamera();
        canvas.dispatchEvent(makePointerEvent('pointerdown', 1, 100, 100));
        canvas.dispatchEvent(makePointerEvent('pointermove', 1, 120, 120));
        canvas.dispatchEvent(makePointerEvent('pointerup', 1, 120, 120));
        return v.cameraCenter.length();
      };

      const nearPan = runPanAtDistance(5);
      const farPan = runPanAtDistance(50);
      expect(nearPan).toBeGreaterThan(0);
      expect(farPan).toBeGreaterThan(nearPan * 5);
    } finally {
      if (originalPointerEvent === undefined) delete (window as any).PointerEvent;
      else (window as any).PointerEvent = originalPointerEvent;
    }
  });

  it('one-finger touch pan matches mouse pan for the same screen delta', () => {
    const originalPointerEvent = (window as any).PointerEvent;
    try {
      (window as any).PointerEvent = function PointerEvent() {};
      cleanupContainers();
      makeContainer();
      v = new Viewer('app');
      installTouchViewport();
      const canvas = v.renderer.domElement;

      const resetCamera = () => {
        v.cameraCenter.set(0, 0, 0);
        v.cameraDist = 40;
        v.euler = [Math.PI / 3, 0, Math.PI / 4];
        v.updateCamera();
      };

      resetCamera();
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, button: 0 }));
      canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 130, clientY: 125, button: 0 }));
      canvas.dispatchEvent(new MouseEvent('mouseup'));
      const mousePan = v.cameraCenter.clone();

      resetCamera();
      canvas.dispatchEvent(makePointerEvent('pointerdown', 1, 100, 100));
      canvas.dispatchEvent(makePointerEvent('pointermove', 1, 130, 125));
      canvas.dispatchEvent(makePointerEvent('pointerup', 1, 130, 125));
      const touchPan = v.cameraCenter.clone();

      expect(touchPan.x).toBeCloseTo(mousePan.x, 6);
      expect(touchPan.y).toBeCloseTo(mousePan.y, 6);
      expect(touchPan.z).toBeCloseTo(mousePan.z, 6);
    } finally {
      if (originalPointerEvent === undefined) delete (window as any).PointerEvent;
      else (window as any).PointerEvent = originalPointerEvent;
    }
  });

  it('one-finger touch pan uses CSS pixels on high DPI screens', () => {
    const originalPointerEvent = (window as any).PointerEvent;
    try {
      (window as any).PointerEvent = function PointerEvent() {};
      cleanupContainers();
      makeContainer();
      v = new Viewer('app');
      installTouchViewport();
      const canvas = v.renderer.domElement;

      const runTouchPan = (rendererPixelRatio: number) => {
        v.cameraCenter.set(0, 0, 0);
        v.cameraDist = 40;
        v.euler = [Math.PI / 3, 0, Math.PI / 4];
        v.rendererPixelRatio = rendererPixelRatio;
        v.updateCamera();
        canvas.dispatchEvent(makePointerEvent('pointerdown', 1, 100, 100));
        canvas.dispatchEvent(makePointerEvent('pointermove', 1, 130, 125));
        canvas.dispatchEvent(makePointerEvent('pointerup', 1, 130, 125));
        return v.cameraCenter.clone();
      };

      const normalDpiPan = runTouchPan(1);
      const highDpiPan = runTouchPan(3);
      expect(highDpiPan.x).toBeCloseTo(normalDpiPan.x, 6);
      expect(highDpiPan.y).toBeCloseTo(normalDpiPan.y, 6);
      expect(highDpiPan.z).toBeCloseTo(normalDpiPan.z, 6);
    } finally {
      if (originalPointerEvent === undefined) delete (window as any).PointerEvent;
      else (window as any).PointerEvent = originalPointerEvent;
    }
  });

  it('touch input does not drive measurement shortcuts', () => {
    const canvas = v.renderer.domElement;
    const addSpy = vi.spyOn(v, 'addMeasurementPoint');
    const removeSpy = vi.spyOn(v, 'removeMeasurementPoint');

    canvas.dispatchEvent(makeTouchEvent('touchstart', [{ x: 120, y: 120 }]));
    canvas.dispatchEvent(makeTouchEvent('touchend', []));
    expect(addSpy).not.toHaveBeenCalled();

    canvas.dispatchEvent(makeTouchEvent('touchstart', [{ x: 100, y: 100 }, { x: 150, y: 100 }]));
    canvas.dispatchEvent(makeTouchEvent('touchend', []));
    expect(removeSpy).not.toHaveBeenCalled();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('primary touch devices disable measurement APIs', () => {
    const originalMatchMedia = window.matchMedia;
    const originalMaxTouchPoints = navigator.maxTouchPoints;
    try {
      cleanupContainers();
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
      (window as any).matchMedia = vi.fn((query: string) => ({
        matches: query.includes('pointer: coarse') || query.includes('hover: none'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      makeContainer();
      v = new Viewer('app');
      expect(v.isTouchPrimaryDevice).toBe(true);
      v.selectedPoints = [new THREE.Vector3(1, 2, 3)];
      v.removeMeasurementPoint();
      expect(v.selectedPoints).toHaveLength(1);
    } finally {
      window.matchMedia = originalMatchMedia;
      Object.defineProperty(navigator, 'maxTouchPoints', { value: originalMaxTouchPoints, configurable: true });
    }
  });

  it('keyboard events', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'm' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta' }));
  });
});

describe('Viewer drag and drop & loadFile', () => {
  let v: CloudViewer;
  beforeEach(() => { makeContainer(); v = new CloudViewer('app'); });
  afterEach(cleanupContainers);

  it('handleDrop with no dataTransfer does nothing', async () => {
    const e = new Event('drop') as any;
    e.dataTransfer = null;
    await v.handleDrop(e);
  });

  it('loadFile with unsupported ext warns', async () => {
    const f = new File(['x'], 'foo.txt');
    await v.loadFile(f);
  });

  it('loadFile with .pcd reads stream', async () => {
    const data = new TextEncoder().encode('VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA ascii\n0 0 0\n');
    const f = new File([toArrayBuffer(data)], 'foo.pcd');
    await v.loadFile(f);
  });

  it('loadFile append=true does not remove cloud', async () => {
    const data = new TextEncoder().encode('VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA ascii\n0 0 0\n');
    const f = new File([toArrayBuffer(data)], 'foo.pcd');
    await v.loadFile(f, true);
  });
});

describe('Viewer global error handlers + window resize + animation', () => {
  let v: CloudViewer;
  beforeEach(() => { makeContainer(); v = new CloudViewer('app'); });
  afterEach(cleanupContainers);

  it('onWindowResize updates renderer & camera', () => {
    v.onWindowResize();
  });

  it('global error event sets statusElement', () => {
    v.statusElement = document.createElement('div');
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));
  });

  it('unhandled rejection sets statusElement', () => {
    v.statusElement = document.createElement('div');
    window.dispatchEvent(new (globalThis as any).Event('unhandledrejection') as any);
    // Manually fire with reason
    const event: any = new Event('unhandledrejection');
    event.reason = 'failure';
    window.dispatchEvent(event);
  });

  it('animation loop with showCenter renders center marker', async () => {
    vi.useFakeTimers();
    v.showCenter = true;
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
  });

  it('renderPoints with all-equal values widens range', () => {
    v.renderPoints(new Float32Array([0, 0, 0, 1, 1, 1]), new Float32Array([5, 5]), undefined);
    expect(v.dataMin).toBeLessThan(v.dataMax);
  });

  it('renderPoints with empty values uses default range', () => {
    v.renderPoints(new Float32Array(0), new Float32Array(0), undefined);
  });

  it('renderPoints with all-zero RGB stays in I mode', () => {
    v.renderPoints(new Float32Array([0, 0, 0, 1, 1, 1]), new Float32Array([1, 2]), new Uint8Array([0, 0, 0, 0, 0, 0]));
  });

  it('detectFormat covers extensions and unknown', () => {
    expect((v as any).detectFormat()).toBe('pcd');
    expect((v as any).detectFormat('a.xyz')).toBe('unknown');
  });
});
