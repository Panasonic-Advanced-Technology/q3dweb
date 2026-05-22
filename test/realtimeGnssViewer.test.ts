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

import * as THREE from 'three';
import { GNSSMapItem } from '../src/items/GNSSMapItem';
import { RealtimeGnssViewer } from '../src/realtime_gnss_viewer';

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  });

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}

function makeContainer(): void {
  const container = document.createElement('div');
  container.id = 'app';
  document.body.appendChild(container);
}

function makeFix(latitude: number, longitude: number) {
  return {
    status: { status: 1, service: 1 },
    latitude,
    longitude,
    altitude: 12.5,
  };
}

describe('RealtimeGnssViewer streaming workflow', () => {
  const originalWebSocket = globalThis.WebSocket;
  let textureLoadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    makeContainer();
    textureLoadSpy = vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(function (
      _url: string,
      onLoad?: (texture: THREE.Texture) => void,
    ) {
      const texture = new THREE.Texture();
      if (onLoad) onLoad(texture);
      return texture;
    } as any);
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    textureLoadSpy.mockRestore();
    document.body.innerHTML = '';
  });

  it('connects, subscribes to GNSS topics, ingests NavSatFix messages, and disconnects', () => {
    const viewer = new RealtimeGnssViewer('app', {
      gnss1TopicName: '/fix/main',
      gnss2TopicName: '/fix/sub',
    });
    viewer.statusElement = document.createElement('div');

    viewer.connectRosbridge('ws://robot:9090');
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(socket.url).toBe('ws://robot:9090');
    expect(socket.sent.map(message => JSON.parse(message))).toEqual([
      { op: 'subscribe', topic: '/fix/main', type: 'sensor_msgs/NavSatFix', queue_length: 1, throttle_rate: 0 },
      { op: 'subscribe', topic: '/fix/sub', type: 'sensor_msgs/NavSatFix', queue_length: 1, throttle_rate: 0 },
    ]);

    socket.message('not json');
    socket.message(JSON.stringify({ op: 'service_response', topic: '/fix/main', msg: makeFix(35, 139) }));
    socket.message(JSON.stringify({ op: 'publish', topic: '/fix/main', msg: makeFix(35.0, 139.0) }));
    socket.message(JSON.stringify({ op: 'publish', topic: '/fix/main', msg: makeFix(35.0002, 139.0001) }));
    socket.message(JSON.stringify({ op: 'publish', topic: '/fix/sub', msg: makeFix(35.0001, 139.0002) }));
    socket.message(JSON.stringify({ op: 'publish', topic: '/fix/main', msg: { latitude: NaN, longitude: 139 } }));

    expect((viewer as any).tracks.gnss1.count).toBe(2);
    expect((viewer as any).tracks.gnss2.count).toBe(1);
    expect((viewer as any).tracks.gnss1.marker).toBeInstanceOf(THREE.Points);
    expect((viewer as any).tracks.gnss1.trailPoints).toBeInstanceOf(THREE.Points);
    expect(((viewer as any).tracks.gnss1.marker.material as THREE.PointsMaterial).sizeAttenuation).toBe(false);
    expect(((viewer as any).tracks.gnss1.trailPoints.material as THREE.PointsMaterial).sizeAttenuation).toBe(false);
    expect((viewer as any).tracks.gnss1.line.type).toBe('Line2');
    expect((viewer as any).tracks.gnss1.lineMaterial.worldUnits).toBe(false);
    expect((viewer as any).tracks.gnss1.lineMaterial.linewidth).toBe(4);
    expect((viewer as any).tracks.gnss1.lineMaterial.resolution.x).toBeGreaterThan(0);
    expect((viewer as any).tracks.gnss1.lineMaterial.depthTest).toBe(false);
    expect((viewer as any).tracks.gnss1.line.visible).toBe(true);
    expect((viewer as any).tracks.gnss1.trailPoints.visible).toBe(true);
    expect(viewer.cameraCenter.length()).toBeGreaterThan(0);
    expect(((viewer as any).tracks.gnss1.marker.material as THREE.PointsMaterial).color.getHex()).toBe(0x2f6bff);
    expect(((viewer as any).tracks.gnss2.marker.material as THREE.PointsMaterial).color.getHex()).toBe(0xff3b30);
    expect(((viewer as any).tracks.gnss1.marker.material as THREE.PointsMaterial).map).toBeTruthy();
    expect(((viewer as any).tracks.gnss1.marker.material as THREE.PointsMaterial).alphaTest).toBe(0.5);
    expect(viewer.items.gnss_map).toBeInstanceOf(GNSSMapItem);
    expect((viewer.items.gnss_map as GNSSMapItem).lastFix?.lat).toBeCloseTo(35.0001);
    expect(viewer.statusElement?.textContent).toContain('GNSS1: 35.000200, 139.000100');
    expect(viewer.statusElement?.textContent).toContain('GNSS2: 35.000100, 139.000200');

    viewer.disconnectRosbridge();
    expect(socket.sent.map(message => JSON.parse(message)).slice(-2)).toEqual([
      { op: 'unsubscribe', topic: '/fix/main' },
      { op: 'unsubscribe', topic: '/fix/sub' },
    ]);
    expect(socket.close).toHaveBeenCalled();
  });

  it('resets origin and clears both GNSS trails', () => {
    const viewer = new RealtimeGnssViewer('app');
    viewer.ingestNavSatFix('gnss1', makeFix(35, 139));
    viewer.ingestNavSatFix('gnss2', makeFix(35.1, 139.1));
    viewer.ingestNavSatFix('gnss1', makeFix(35.0001, 139.0001));

    viewer.resetOrigin();

    expect((viewer as any).tracks.gnss1.count).toBe(0);
    expect((viewer as any).tracks.gnss2.count).toBe(0);
    expect((viewer as any).tracks.gnss1.line.visible).toBe(false);
    expect((viewer as any).tracks.gnss1.trailPoints.visible).toBe(false);
    expect(viewer.cameraCenter.length()).toBe(0);
    expect(viewer.cameraDist).toBe(40);
    expect((viewer.items.gnss_map as GNSSMapItem).lastFix).toBeNull();
  });

  it('uses settings controls, filters empty GNSS topics, and reconnects cleanly', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const viewer = new RealtimeGnssViewer('app');
    const section = viewer.settingsPanel!.querySelector('[data-role="realtime-gnss"]') as HTMLElement;
    const rosInput = section.querySelector('[data-role="realtime-gnss-ros-url"]') as HTMLInputElement;
    const gnss1Dot = section.querySelector('[data-role="realtime-gnss1-label-dot"]') as HTMLElement;
    const gnss2Dot = section.querySelector('[data-role="realtime-gnss2-label-dot"]') as HTMLElement;
    const gnss1TrailToggle = section.querySelector('[data-role="realtime-gnss1-trail-toggle"]') as HTMLInputElement;
    const gnss2TrailToggle = section.querySelector('[data-role="realtime-gnss2-trail-toggle"]') as HTMLInputElement;
    const gnss1Input = section.querySelector('[data-role="realtime-gnss1-topic"]') as HTMLInputElement;
    const gnss2Input = section.querySelector('[data-role="realtime-gnss2-topic"]') as HTMLInputElement;
    const buttons = Array.from(section.querySelectorAll('button'));

    expect(gnss1Dot).toBeTruthy();
    expect(gnss2Dot).toBeTruthy();
    expect(gnss1TrailToggle).toBeTruthy();
    expect(gnss2TrailToggle).toBeTruthy();
    expect(gnss1TrailToggle.checked).toBe(true);
    expect(gnss2TrailToggle.checked).toBe(true);
    expect(gnss1Dot.style.borderRadius).toBe('999px');
    expect(gnss2Dot.style.borderRadius).toBe('999px');
    expect(gnss1Dot.style.backgroundColor).toBe('rgb(47, 107, 255)');
    expect(gnss2Dot.style.backgroundColor).toBe('rgb(255, 59, 48)');

    rosInput.value = '   ';
    buttons[0].click();
    expect(FakeWebSocket.instances).toHaveLength(0);

    rosInput.value = 'ws://first:9090';
    gnss1Input.value = '/fix/only';
    gnss2Input.value = '   ';
    buttons[0].click();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();
    expect(firstSocket.sent.map(message => JSON.parse(message))).toEqual([
      { op: 'subscribe', topic: '/fix/only', type: 'sensor_msgs/NavSatFix', queue_length: 1, throttle_rate: 0 },
    ]);

    viewer.connectRosbridge('ws://second:9090', {
      gnss1TopicName: '/fix/main',
      gnss2TopicName: '/fix/sub',
    });
    expect(firstSocket.sent.map(message => JSON.parse(message)).slice(-1)).toEqual([
      { op: 'unsubscribe', topic: '/fix/only' },
    ]);
    expect(firstSocket.close).toHaveBeenCalled();

    const secondSocket = FakeWebSocket.instances[1];
    secondSocket.open();
    secondSocket.fail();
    expect(errorSpy).toHaveBeenCalled();
    expect(secondSocket.sent.map(message => JSON.parse(message))).toEqual([
      { op: 'subscribe', topic: '/fix/main', type: 'sensor_msgs/NavSatFix', queue_length: 1, throttle_rate: 0 },
      { op: 'subscribe', topic: '/fix/sub', type: 'sensor_msgs/NavSatFix', queue_length: 1, throttle_rate: 0 },
    ]);

    viewer.ingestNavSatFix('gnss1', makeFix(35, 139));
    viewer.ingestNavSatFix('gnss1', makeFix(35.0001, 139.0001));
    viewer.ingestNavSatFix('gnss2', makeFix(35.0002, 139.0002));
    viewer.ingestNavSatFix('gnss2', makeFix(35.0003, 139.0003));
    expect((viewer as any).tracks.gnss1.line.visible).toBe(true);
    expect((viewer as any).tracks.gnss2.line.visible).toBe(true);
    expect((viewer as any).tracks.gnss1.trailPoints.visible).toBe(true);
    expect((viewer as any).tracks.gnss2.trailPoints.visible).toBe(true);
    gnss1TrailToggle.checked = false;
    gnss1TrailToggle.dispatchEvent(new Event('change'));
    expect((viewer as any).tracks.gnss1.line.visible).toBe(false);
    expect((viewer as any).tracks.gnss1.trailPoints.visible).toBe(false);
    expect((viewer as any).tracks.gnss2.line.visible).toBe(true);
    expect((viewer as any).tracks.gnss2.trailPoints.visible).toBe(true);
    gnss2TrailToggle.checked = false;
    gnss2TrailToggle.dispatchEvent(new Event('change'));
    expect((viewer as any).tracks.gnss1.line.visible).toBe(false);
    expect((viewer as any).tracks.gnss2.line.visible).toBe(false);
    expect((viewer as any).tracks.gnss1.trailPoints.visible).toBe(false);
    expect((viewer as any).tracks.gnss2.trailPoints.visible).toBe(false);
    gnss1TrailToggle.checked = true;
    gnss1TrailToggle.dispatchEvent(new Event('change'));
    expect((viewer as any).tracks.gnss1.line.visible).toBe(true);
    expect((viewer as any).tracks.gnss1.trailPoints.visible).toBe(true);
    expect((viewer as any).tracks.gnss2.line.visible).toBe(false);
    expect((viewer as any).tracks.gnss2.trailPoints.visible).toBe(false);
    gnss2TrailToggle.checked = true;
    gnss2TrailToggle.dispatchEvent(new Event('change'));
    expect((viewer as any).tracks.gnss2.line.visible).toBe(true);
    expect((viewer as any).tracks.gnss2.trailPoints.visible).toBe(true);

    viewer.disconnectRosbridge();
    viewer.disconnectRosbridge();
    errorSpy.mockRestore();
  });

  it('handles missing altitude/status, status text without fixes, and trail capacity', () => {
    const viewer = new RealtimeGnssViewer('app');
    viewer.statusElement = document.createElement('div');

    viewer.clearTracks();
    expect(viewer.statusElement.textContent).toContain('GNSS1: waiting');

    viewer.ingestNavSatFix('gnss1', { latitude: 35, longitude: 139 });
    expect((viewer as any).tracks.gnss1.lastFix.alt).toBe(0);
    expect((viewer as any).tracks.gnss1.lastFix.status).toBe(0);

    (viewer as any).tracks.gnss1.count = (viewer as any).maxTrailLength;
    viewer.ingestNavSatFix('gnss1', makeFix(35.001, 139.001));
    expect((viewer as any).tracks.gnss1.count).toBe((viewer as any).maxTrailLength);
    expect((viewer as any).tracks.gnss1.marker.visible).toBe(true);

    buttonsFromViewer(viewer)[1].click();
    buttonsFromViewer(viewer)[2].click();
    expect((viewer as any).tracks.gnss1.count).toBe(0);
  });

  it('disables auto-follow after manual camera input so mouse zoom persists', () => {
    const viewer = new RealtimeGnssViewer('app');

    viewer.ingestNavSatFix('gnss1', makeFix(35, 139));
    viewer.ingestNavSatFix('gnss1', makeFix(35.0008, 139.0008));

    const autoFrameDist = viewer.cameraDist;
    const autoFrameCenter = viewer.cameraCenter.clone();

    viewer.updateDist(-25);

    expect(viewer.cameraDist).toBe(autoFrameDist - 25);

    viewer.ingestNavSatFix('gnss1', makeFix(35.0012, 139.0012));

    expect(viewer.cameraDist).toBe(autoFrameDist - 25);
    expect(viewer.cameraCenter.equals(autoFrameCenter)).toBe(true);

    viewer.clearTracks();
    viewer.ingestNavSatFix('gnss1', makeFix(35.002, 139.002));
    viewer.ingestNavSatFix('gnss1', makeFix(35.0025, 139.0025));

    expect(viewer.cameraCenter.length()).toBeGreaterThan(0);
    expect(viewer.cameraDist).toBeGreaterThan(40);
  });
});

function buttonsFromViewer(viewer: RealtimeGnssViewer): HTMLButtonElement[] {
  const section = viewer.settingsPanel!.querySelector('[data-role="realtime-gnss"]') as HTMLElement;
  return Array.from(section.querySelectorAll('button'));
}