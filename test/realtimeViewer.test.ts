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

import { CloudItem } from '../src/items/CloudItem';
import { NativeCloudItem } from '../src/items/NativeCloudItem';
import { RealtimeViewer } from '../src/realtime_viewer';
import type { PointCloud2Json } from '../src/utils/realtimeTypes';

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

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function makePointCloud2(width = 1): PointCloud2Json {
  const pointStep = 16;
  const bytes = new Uint8Array(width * pointStep);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < width; index++) {
    const base = index * pointStep;
    view.setFloat32(base, index + 1, true);
    view.setFloat32(base + 4, index + 2, true);
    view.setFloat32(base + 8, index + 3, true);
    view.setUint32(base + 12, 0x102030 + index, true);
  }
  return {
    height: 1,
    width,
    fields: [
      { name: 'x', offset: 0, datatype: 7, count: 1 },
      { name: 'y', offset: 4, datatype: 7, count: 1 },
      { name: 'z', offset: 8, datatype: 7, count: 1 },
      { name: 'rgb', offset: 12, datatype: 6, count: 1 },
    ],
    is_bigendian: false,
    point_step: pointStep,
    row_step: bytes.byteLength,
    data: toBase64(bytes),
    is_dense: true,
  };
}

describe('RealtimeViewer streaming workflow', () => {
  const originalWebSocket = globalThis.WebSocket;
  let appendSpy: ReturnType<typeof vi.spyOn>;
  let drawSpy: ReturnType<typeof vi.spyOn>;
  let countSpy: ReturnType<typeof vi.spyOn>;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    makeContainer();
    appendSpy = vi.spyOn(NativeCloudItem.prototype, 'appendPoints').mockImplementation(() => {});
    drawSpy = vi.spyOn(NativeCloudItem.prototype, 'draw').mockImplementation(() => {});
    countSpy = vi.spyOn(NativeCloudItem.prototype, 'getPointCount').mockReturnValue(42);
    nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    appendSpy.mockRestore();
    drawSpy.mockRestore();
    countSpy.mockRestore();
    nowSpy.mockRestore();
    document.body.innerHTML = '';
  });

  it('queues decoded PointCloud2 chunks and applies map and scan updates during render', () => {
    const viewer = new RealtimeViewer('app', { maxPointsPerScan: 10, maxAccumulatedPoints: 500 });
    const setColorModeSpy = vi.spyOn(NativeCloudItem.prototype, 'setColorMode');
    viewer.statusElement = document.createElement('div');

    viewer.ingestPointCloud2(makePointCloud2(1));
    viewer.render();

    expect(setColorModeSpy).toHaveBeenCalledWith('RGB');
    expect(appendSpy).toHaveBeenCalledWith(viewer.renderer, expect.any(Float32Array), expect.any(Float32Array), 500);
    expect((viewer.items.scan as CloudItem).getPointCount()).toBe(1);
    expect(viewer.statusElement?.textContent).toContain('Map: 42 pts | Scan: 1 pts');
    expect(drawSpy).toHaveBeenCalledWith(viewer.renderer, viewer.camera);
    setColorModeSpy.mockRestore();
  });

  it('drops oldest queued chunks and applies at most one commit batch', () => {
    const viewer = new RealtimeViewer('app');

    for (let index = 0; index < 6; index++) viewer.ingestPointCloud2(makePointCloud2(1));
    viewer.render();

    expect(appendSpy).toHaveBeenCalledTimes(4);
  });

  it('ignores undecodable point clouds', () => {
    const viewer = new RealtimeViewer('app');
    viewer.ingestPointCloud2({ ...makePointCloud2(1), fields: [] });
    viewer.render();

    expect(appendSpy).not.toHaveBeenCalled();
  });

  it('connects, subscribes, handles publish messages, and disconnects cleanly', () => {
    const viewer = new RealtimeViewer('app', {
      cloudTopicName: '/points',
      odomTopicName: '/odom',
    });

    viewer.connectRosbridge('ws://robot:9090');
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(socket.url).toBe('ws://robot:9090');
    expect(socket.sent.map(message => JSON.parse(message))).toEqual([
      { op: 'subscribe', topic: '/points', type: 'sensor_msgs/PointCloud2', queue_length: 1, throttle_rate: 0 },
      { op: 'subscribe', topic: '/odom', type: 'nav_msgs/Odometry', queue_length: 1, throttle_rate: 0 },
    ]);

    socket.message('not json');
    socket.message(JSON.stringify({ op: 'service_response', topic: '/points', msg: makePointCloud2(1) }));
    socket.message(JSON.stringify({ op: 'publish', topic: '/points', msg: makePointCloud2(1) }));
    socket.message(JSON.stringify({
      op: 'publish',
      topic: '/odom',
      msg: {
        pose: { pose: { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } },
      },
    }));
    socket.fail();
    viewer.render();

    expect(appendSpy).toHaveBeenCalled();
    expect(viewer.items.odom.matrix.elements[12]).toBe(1);
    expect(viewer.items.odom.matrix.elements[13]).toBe(2);
    expect(viewer.items.odom.matrix.elements[14]).toBe(3);

    viewer.disconnectRosbridge();
    expect(socket.sent.map(message => JSON.parse(message)).slice(-2)).toEqual([
      { op: 'unsubscribe', topic: '/points' },
      { op: 'unsubscribe', topic: '/odom' },
    ]);
    expect(socket.close).toHaveBeenCalled();
  });

  it('disconnects an existing open socket before reconnecting', () => {
    const viewer = new RealtimeViewer('app');
    viewer.connectRosbridge('ws://first');
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();

    viewer.connectRosbridge('ws://second');

    expect(firstSocket.close).toHaveBeenCalled();
    expect(FakeWebSocket.instances[1].url).toBe('ws://second');
  });

  it('renders NativeCloudItem settings and syncs color mode changes', () => {
    const viewer = new RealtimeViewer('app');
    viewer.onSettingsItemSelected('map');

    const inputs = Array.from(viewer.settingsContent!.querySelectorAll('input')) as HTMLInputElement[];
    const colorModeSelect = viewer.settingsContent!.querySelector('select') as HTMLSelectElement;
    inputs[0].value = '5';
    inputs[0].onchange?.(new Event('change'));
    inputs[1].value = '0.25';
    inputs[1].onchange?.(new Event('change'));
    colorModeSelect.value = 'I';
    colorModeSelect.onchange?.(new Event('change'));

    viewer.ingestPointCloud2(makePointCloud2(1));
    viewer.render();

    expect(viewer.settingsContent!.textContent).toContain('Color Mode:');
    expect(appendSpy).toHaveBeenCalled();
  });
});