// Test setup: polyfills for jsdom environment

if (typeof (globalThis as any).ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    colorSpace: string = 'srgb';
    constructor(...args: any[]) {
      if (args[0] instanceof Uint8ClampedArray) {
        this.data = args[0];
        this.width = args[1];
        this.height = args[2] ?? args[1];
      } else {
        this.width = args[0];
        this.height = args[1];
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      }
    }
  };
}

// requestAnimationFrame: prevent infinite loops in animation; flush via timer
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id as any);
}

// Stub HTMLCanvasElement.getContext for jsdom
if (typeof HTMLCanvasElement !== 'undefined') {
  const origGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type: string) {
    const real = origGet ? origGet.call(this, type as any) : null;
    if (real) return real;
    if (type === '2d') {
      return {
        canvas: this,
        putImageData: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) =>
          new (globalThis as any).ImageData(w, h),
        drawImage: () => {},
        clearRect: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => {},
        fill: () => {},
        arc: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        scale: () => {},
        setTransform: () => {},
        fillText: () => {},
        measureText: () => ({ width: 0 }),
      } as any;
    }
    return null;
  } as any;
}

// Mock THREE.WebGLRenderer to avoid needing real WebGL in jsdom: handled
// per-file via vi.mock in viewer.test.ts (cannot reassign on ESM namespace).

// Sizes for jsdom HTMLElement clientWidth/clientHeight
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 600; } });
