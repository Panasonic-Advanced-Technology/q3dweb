import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('three', async () => {
    const actual = await vi.importActual<any>('three');
    class FakeWebGLRenderer {
        domElement: HTMLCanvasElement;
        capabilities = { isWebGL2: true, maxTextures: 16 };
        constructor() { this.domElement = document.createElement('canvas'); }
        setPixelRatio() {}
        setSize() {}
        render() {}
        dispose() {}
        getContext() { return {}; }
    }
    return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { Viewer } from '../src/viewer';
import { CloudViewer } from '../src/cloud_viewer';

function makeLASWithVLR(options: {
    recordID: number;
    body: Uint8Array;
    bounds?: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
    versionMinor?: number;
}): Uint8Array {
    const headerSize = 227;
    const vlrHdr = 54;
    const numPoints = 1;
    const recLen = 20;
    const totalHdr = headerSize + vlrHdr + options.body.byteLength;
    const dataOff = totalHdr;
    const total = totalHdr + numPoints * recLen;

    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    buf[0] = 0x4C; buf[1] = 0x41; buf[2] = 0x53; buf[3] = 0x46;
    buf[24] = 1; buf[25] = options.versionMinor ?? 2;
    dv.setUint16(94, headerSize, true);
    dv.setUint32(96, dataOff, true);
    buf[104] = 0; // format 0
    dv.setUint16(105, recLen, true);
    dv.setUint32(107, numPoints, true);
    dv.setUint32(100, 1, true);
    // scale 1.0, offsets 0
    dv.setFloat64(131, 1.0, true);
    dv.setFloat64(139, 1.0, true);
    dv.setFloat64(147, 1.0, true);
    // bounds (optional)
    const b = options.bounds ?? { minX: 0, maxX: 10, minY: 0, maxY: 10, minZ: 0, maxZ: 10 };
    dv.setFloat64(179, b.maxX, true);
    dv.setFloat64(187, b.minX, true);
    dv.setFloat64(195, b.maxY, true);
    dv.setFloat64(203, b.minY, true);
    dv.setFloat64(211, b.maxZ, true);
    dv.setFloat64(219, b.minZ, true);

    // VLR
    dv.setUint16(headerSize + 18, options.recordID, true);
    dv.setUint16(headerSize + 20, options.body.byteLength, true);
    buf.set(options.body, headerSize + vlrHdr);

    // Single point at origin
    dv.setInt32(dataOff, 0, true);
    dv.setInt32(dataOff + 4, 0, true);
    dv.setInt32(dataOff + 8, 0, true);
    return buf;
}

describe('Viewer parseLAS georef branches', () => {
    let v: CloudViewer;
    beforeEach(() => {
        const c = document.createElement('div'); c.id = 'app'; document.body.appendChild(c);
        v = new CloudViewer('app');
    });
    afterEach(() => { document.body.innerHTML = ''; });

    it('falls back to WKT VLR when EPSG is absent', () => {
        const wkt = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]\0';
        const body = new TextEncoder().encode(wkt);
        const data = makeLASWithVLR({
            recordID: 2112,
            body,
            bounds: { minX: 139, maxX: 139.01, minY: 35, maxY: 35.01, minZ: 0, maxZ: 1 },
        });
        v.loadData(data, 'wkt.las');
        // Should add gnss overlay because WKT converts successfully
        expect(v.items['gnss']).toBeDefined();
    });

    it('logs warning when EPSG is unknown (no overlay added)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Unknown EPSG in GeoKey
        const body = new Uint8Array(16);
        const dv = new DataView(body.buffer);
        dv.setUint16(6, 1, true);
        dv.setUint16(8, 3072, true);
        dv.setUint16(12, 1, true);
        dv.setUint16(14, 9999, true); // unknown
        const data = makeLASWithVLR({ recordID: 34735, body });
        v.loadData(data, 'unknown.las');
        expect(v.items['gnss']).toBeUndefined();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
