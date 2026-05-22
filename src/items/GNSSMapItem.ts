/**
 * GNSSMapItem — 3D ground-plane OpenStreetMap tiles + GNSS track.
 *
 * Renders OSM tiles as textured planes in the Three.js scene (same space as
 * point clouds). Lat/lon → local ENU (East-North-Up) via equirectangular
 * projection centred on the first received fix. GNSS trail rendered as a
 * 3D line at altitude 0.1 m above the ground plane.
 *
 * Slippy Map tile convention:
 *   https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
 */

import * as THREE from 'three';

// ============================================================
// Tile server presets
// ============================================================
export const TILE_PRESETS: { label: string; url: string; maxZoom?: number }[] = [
    { label: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 },
    { label: 'GSI 標準地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', maxZoom: 18 },
    { label: 'GSI 淡色地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', maxZoom: 18 },
    { label: 'GSI 写真', url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', maxZoom: 18 },
    { label: 'GSI 白地図', url: 'https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png', maxZoom: 14 },
];

const MARKER_PIXEL_SIZE = 12;

// ============================================================
// Options
// ============================================================
export interface GNSSMapItemOptions {
    zoom?: number;           // OSM zoom level (default 18)
    altitude?: number;       // Z of ground plane (default 0)
    alpha?: number;          // tile opacity (0–1)
    maxTrailLength?: number;
    tileServer?: string;
    tileRadius?: number;     // tiles to load around centre (default 3)
    showTrailControls?: boolean; // show Clear Trail / Reset Origin buttons + trail line (default true)
}

// ============================================================
// Slippy Map helpers
// ============================================================
function lon2tileX(lon: number, z: number): number {
    return ((lon + 180) / 360) * (1 << z);
}
function lat2tileY(lat: number, z: number): number {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z);
}
/** Tile X/Y → lon/lat of tile's NW corner */
function tileX2lon(x: number, z: number): number {
    return (x / (1 << z)) * 360 - 180;
}
function tileY2lat(y: number, z: number): number {
    const n = Math.PI - (2 * Math.PI * y) / (1 << z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// ============================================================
// Lat/lon → local metres (equirectangular approximation)
// ============================================================
class LatLonToLocal {
    private refLat: number;
    private refLon: number;
    private cosLat: number;
    private static DEG2M = 111319.49079327357; // metres per degree at equator

    constructor(refLat: number, refLon: number) {
        this.refLat = refLat;
        this.refLon = refLon;
        this.cosLat = Math.cos((refLat * Math.PI) / 180);
    }

    /** Returns [east, north] in metres relative to reference */
    toLocal(lat: number, lon: number): [number, number] {
        const east = (lon - this.refLon) * LatLonToLocal.DEG2M * this.cosLat;
        const north = (lat - this.refLat) * LatLonToLocal.DEG2M;
        return [east, north];
    }
}

// ============================================================
// GNSSMapItem
// ============================================================
export class GNSSMapItem extends THREE.Group {
    // Settings
    private _zoom: number;
    private _altitude: number;
    private _alpha: number;
    private _tileRadius: number;
    private tileServer: string;
    private _showTrailControls: boolean;
    private _maxZoom: number = 19;

    // Reference frame (set on first fix)
    private proj: LatLonToLocal | null = null;

    // Tile meshes — key "z/x/y"
    private tileMeshes: Map<string, THREE.Mesh> = new Map();
    private tileLoading: Set<string> = new Set();
    private loader: THREE.TextureLoader = (() => {
        const l = new THREE.TextureLoader();
        l.setCrossOrigin('anonymous');
        return l;
    })();

    // Trail
    private trailLine: THREE.Line;
    private trailPositions: Float32Array;
    private trailCount: number = 0;
    private readonly MAX_TRAIL = 50000;

    // Current marker
    private marker: THREE.Points;
    private currentLatLon: { lat: number; lon: number; alt: number; status: number } | null = null;

    // Tile group (separate so we can set renderOrder)
    private tileGroup: THREE.Group;

    // Render callback for settings
    renderCb: (() => void) | null = null;

    constructor(options: GNSSMapItemOptions = {}) {
        super();
        this.name = 'gnss';
        this._zoom = options.zoom ?? 18;
        this._altitude = options.altitude ?? 0;
        this._alpha = options.alpha ?? 0.8;
        this._tileRadius = options.tileRadius ?? 3;
        this.tileServer = options.tileServer ?? TILE_PRESETS[0].url;
        const matched = TILE_PRESETS.find(p => p.url === this.tileServer);
        this._maxZoom = matched?.maxZoom ?? 19;
        this._showTrailControls = options.showTrailControls ?? true;

        // Tile container
        this.tileGroup = new THREE.Group();
        this.tileGroup.renderOrder = -1;
        this.add(this.tileGroup);

        // Trail line — pre-allocated buffer
        this.trailPositions = new Float32Array(this.MAX_TRAIL * 3);
        const trailGeo = new THREE.BufferGeometry();
        trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
        trailGeo.setDrawRange(0, 0);
        this.trailLine = new THREE.Line(
            trailGeo,
            new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2, depthTest: true })
        );
        this.trailLine.renderOrder = 1;
        this.trailLine.frustumCulled = false;
        this.add(this.trailLine);

        // Current position marker: screen-space size, independent of camera zoom.
        const markerGeo = new THREE.BufferGeometry();
        markerGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
        this.marker = new THREE.Points(
            markerGeo,
            new THREE.PointsMaterial({ color: 0x44bb44, size: MARKER_PIXEL_SIZE, sizeAttenuation: false })
        );
        this.marker.visible = false;
        this.marker.renderOrder = 2;
        this.add(this.marker);

        // Hide trail visuals when trail controls are disabled (e.g., LAS overlay)
        if (!this._showTrailControls) {
            this.trailLine.visible = false;
            this.marker.visible = false;
        }
    }

    // ============================================================
    // Public API
    // ============================================================

    addFix(lat: number, lon: number, alt: number, status: number = 0) {
        if (isNaN(lat) || isNaN(lon)) return;

        // Initialise projection on first fix
        if (!this.proj) {
            this.proj = new LatLonToLocal(lat, lon);
        }

        this.currentLatLon = { lat, lon, alt, status };
        const [east, north] = this.proj.toLocal(lat, lon);
        const z = this._altitude + 0.1; // trail slightly above ground

        // Append to trail
        if (this.trailCount < this.MAX_TRAIL) {
            this.trailPositions[this.trailCount * 3] = east;
            this.trailPositions[this.trailCount * 3 + 1] = north;
            this.trailPositions[this.trailCount * 3 + 2] = z;
            this.trailCount++;
        }
        (this.trailLine.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        this.trailLine.geometry.setDrawRange(0, this.trailCount);

        // Update marker
        this.marker.position.set(east, north, z + 0.2);
        if (this._showTrailControls) this.marker.visible = true;
        this.updateMarkerColor(status);

        // Load tiles around current position
        this.updateTiles(lat, lon);

        this.renderCb?.();
    }

    clearTrail() {
        this.trailCount = 0;
        this.trailLine.geometry.setDrawRange(0, 0);
        this.marker.visible = false;
        this.currentLatLon = null;
        this.renderCb?.();
    }

    resetOrigin() {
        // Remove all tiles and trail, next fix sets new origin
        this.clearTrail();
        this.proj = null;
        for (const [key, mesh] of this.tileMeshes) {
            this.tileGroup.remove(mesh);
            mesh.geometry.dispose();
            (mesh.material as THREE.MeshBasicMaterial).map?.dispose();
            (mesh.material as THREE.MeshBasicMaterial).dispose();
            this.tileMeshes.delete(key);
        }
        this.renderCb?.();
    }

    setZoom(z: number) {
        const nz = Math.max(1, Math.min(this._maxZoom, Math.round(z)));
        if (nz === this._zoom) return;
        this._zoom = nz;
        // Remove old zoom tiles
        for (const [key, mesh] of this.tileMeshes) {
            if (!key.startsWith(nz + '/')) {
                this.tileGroup.remove(mesh);
                mesh.geometry.dispose();
                (mesh.material as THREE.MeshBasicMaterial).map?.dispose();
                (mesh.material as THREE.MeshBasicMaterial).dispose();
                this.tileMeshes.delete(key);
            }
        }
        if (this.currentLatLon) this.updateTiles(this.currentLatLon.lat, this.currentLatLon.lon);
        this.renderCb?.();
    }

    setAlpha(a: number) {
        this._alpha = Math.max(0, Math.min(1, a));
        for (const mesh of this.tileMeshes.values()) {
            (mesh.material as THREE.MeshBasicMaterial).opacity = this._alpha;
            (mesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
        }
        this.renderCb?.();
    }

    setAltitude(alt: number) {
        this._altitude = alt;
        for (const mesh of this.tileMeshes.values()) {
            mesh.position.z = alt;
        }
        this.renderCb?.();
    }

    setTileServer(url: string, maxZoom?: number) {
        if (url === this.tileServer) return;
        this.tileServer = url;
        const matched = TILE_PRESETS.find(p => p.url === url);
        this._maxZoom = maxZoom ?? matched?.maxZoom ?? 19;
        if (this._zoom > this._maxZoom) this._zoom = this._maxZoom;

        // Drop all existing tiles (both loaded & in-flight are implicitly
        // discarded — late callbacks check tileServer via key presence).
        for (const [key, mesh] of this.tileMeshes) {
            this.tileGroup.remove(mesh);
            mesh.geometry.dispose();
            (mesh.material as THREE.MeshBasicMaterial).map?.dispose();
            (mesh.material as THREE.MeshBasicMaterial).dispose();
            this.tileMeshes.delete(key);
        }
        this.tileLoading.clear();

        if (this.currentLatLon) this.updateTiles(this.currentLatLon.lat, this.currentLatLon.lon);
        this.renderCb?.();
    }

    get tileServerUrl(): string { return this.tileServer; }

    get zoom(): number { return this._zoom; }
    get alpha(): number { return this._alpha; }
    get altitude(): number { return this._altitude; }
    get trailLength(): number { return this.trailCount; }
    get lastFix() { return this.currentLatLon; }

    // ============================================================
    // SettingBuilder interface (for M-key settings panel)
    // ============================================================
    addSetting(container: HTMLElement): void {
        const mkLabel = (text: string) => {
            const el = document.createElement('div');
            el.textContent = text;
            el.style.cssText = 'font-size:11px;color:#bbb;margin:4px 0 2px 0;';
            container.appendChild(el);
        };
        const mkNumber = (val: number, min: number, max: number, step: number, cb: (v: number) => void) => {
            const el = document.createElement('input');
            el.type = 'number'; el.value = String(val); el.min = String(min); el.max = String(max); el.step = String(step);
            el.style.cssText = 'width:100%;box-sizing:border-box;background:#333;color:#eee;border:1px solid #555;padding:3px 6px;border-radius:3px;margin-bottom:4px;font-family:monospace;font-size:11px;';
            el.onchange = () => { const v = parseFloat(el.value); if (!isNaN(v)) cb(v); };
            container.appendChild(el);
        };

        // Map on/off checkbox
        const visRow = document.createElement('label');
        visRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:#eee;margin:4px 0 6px 0;cursor:pointer;';
        const visCb = document.createElement('input');
        visCb.type = 'checkbox';
        visCb.checked = this.tileGroup.visible;
        visCb.onchange = () => {
            this.tileGroup.visible = visCb.checked;
            this.renderCb?.();
        };
        visRow.appendChild(visCb);
        const visText = document.createElement('span');
        visText.textContent = 'Show map tiles';
        visRow.appendChild(visText);
        container.appendChild(visRow);

        // Tile provider select
        mkLabel('Tile provider:');
        const select = document.createElement('select');
        select.style.cssText = 'width:100%;box-sizing:border-box;background:#333;color:#eee;border:1px solid #555;padding:3px 6px;border-radius:3px;margin-bottom:4px;font-family:monospace;font-size:11px;';
        for (const p of TILE_PRESETS) {
            const opt = document.createElement('option');
            opt.value = p.url;
            opt.textContent = p.label;
            if (p.url === this.tileServer) opt.selected = true;
            select.appendChild(opt);
        }
        // If current server not in presets, add a "Custom" entry
        if (!TILE_PRESETS.some(p => p.url === this.tileServer)) {
            const opt = document.createElement('option');
            opt.value = this.tileServer;
            opt.textContent = 'Custom';
            opt.selected = true;
            select.appendChild(opt);
        }
        select.onchange = () => {
            const preset = TILE_PRESETS.find(p => p.url === select.value);
            this.setTileServer(select.value, preset?.maxZoom);
        };
        container.appendChild(select);

        mkLabel('Zoom level:');
        mkNumber(this._zoom, 1, 19, 1, (v) => this.setZoom(v));

        mkLabel('Tile alpha:');
        mkNumber(this._alpha, 0.1, 1.0, 0.05, (v) => this.setAlpha(v));

        mkLabel('Ground altitude:');
        mkNumber(this._altitude, -100, 1000, 0.5, (v) => this.setAltitude(v));

        mkLabel('Tile radius:');
        mkNumber(this._tileRadius, 1, 10, 1, (v) => {
            this._tileRadius = Math.max(1, Math.round(v));
            if (this.currentLatLon) this.updateTiles(this.currentLatLon.lat, this.currentLatLon.lon);
            this.renderCb?.();
        });

        if (!this._showTrailControls) return;

        // Info display
        const info = document.createElement('div');
        info.style.cssText = 'font-size:11px;color:#aaa;margin-top:6px;text-align:center;';
        info.textContent = 'trail: ' + this.trailCount + ' pts';
        container.appendChild(info);
        const id = setInterval(() => {
            if (!container.isConnected) { clearInterval(id); return; }
            const p = this.currentLatLon;
            info.textContent = p
                ? 'trail: ' + this.trailCount + ' | ' + p.lat.toFixed(6) + ', ' + p.lon.toFixed(6)
                : 'trail: ' + this.trailCount + ' pts';
        }, 500);

        // Buttons
        const hr = document.createElement('hr');
        hr.style.cssText = 'border:none;border-top:1px solid #444;margin:8px 0;';
        container.appendChild(hr);

        const btnStyle = 'width:100%;background:#444;color:#eee;border:1px solid #666;padding:5px 8px;border-radius:3px;cursor:pointer;font-family:monospace;font-size:12px;margin-bottom:4px;';

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear Trail';
        clearBtn.style.cssText = btnStyle;
        clearBtn.onclick = () => this.clearTrail();
        container.appendChild(clearBtn);

        const resetBtn = document.createElement('button');
        resetBtn.textContent = 'Reset Origin';
        resetBtn.style.cssText = btnStyle;
        resetBtn.onclick = () => this.resetOrigin();
        container.appendChild(resetBtn);
    }

    // ============================================================
    // Tile management
    // ============================================================
    private updateTiles(lat: number, lon: number) {
        if (!this.proj) return;
        const z = this._zoom;
        const cx = Math.floor(lon2tileX(lon, z));
        const cy = Math.floor(lat2tileY(lat, z));
        const r = this._tileRadius;

        const needed = new Set<string>();
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const tx = cx + dx;
                const ty = cy + dy;
                if (ty < 0 || ty >= (1 << z)) continue;
                const wrappedX = ((tx % (1 << z)) + (1 << z)) % (1 << z);
                const key = z + '/' + wrappedX + '/' + ty;
                needed.add(key);
                if (!this.tileMeshes.has(key) && !this.tileLoading.has(key)) {
                    this.loadTile(z, wrappedX, ty, key);
                }
            }
        }

        // Remove tiles that are too far away
        for (const [key, mesh] of this.tileMeshes) {
            if (!needed.has(key)) {
                this.tileGroup.remove(mesh);
                mesh.geometry.dispose();
                (mesh.material as THREE.MeshBasicMaterial).map?.dispose();
                (mesh.material as THREE.MeshBasicMaterial).dispose();
                this.tileMeshes.delete(key);
            }
        }
    }

    private loadTile(z: number, tx: number, ty: number, key: string) {
        this.tileLoading.add(key);

        const url = this.tileServer
            .replace('{z}', String(z))
            .replace('{x}', String(tx))
            .replace('{y}', String(ty));

        this.loader.load(
            url,
            (texture) => {
                this.tileLoading.delete(key);
                if (!this.proj) return;

                texture.minFilter = THREE.LinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.colorSpace = THREE.SRGBColorSpace;

                // Compute tile's world position
                // Tile NW corner lat/lon
                const nwLon = tileX2lon(tx, z);
                const nwLat = tileY2lat(ty, z);
                // Tile SE corner lat/lon
                const seLon = tileX2lon(tx + 1, z);
                const seLat = tileY2lat(ty + 1, z);

                const [nwE, nwN] = this.proj!.toLocal(nwLat, nwLon);
                const [seE, seN] = this.proj!.toLocal(seLat, seLon);

                const width = seE - nwE;
                const height = nwN - seN; // north is positive
                const centerE = (nwE + seE) / 2;
                const centerN = (nwN + seN) / 2;

                const geo = new THREE.PlaneGeometry(Math.abs(width), Math.abs(height));
                const mat = new THREE.MeshBasicMaterial({
                    map: texture,
                    transparent: true,
                    opacity: this._alpha,
                    side: THREE.DoubleSide,
                    depthWrite: false,
                });

                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.set(centerE, centerN, this._altitude);
                mesh.renderOrder = -1;
                mesh.frustumCulled = false;

                // Replace existing tile if race condition
                if (this.tileMeshes.has(key)) {
                    const old = this.tileMeshes.get(key)!;
                    this.tileGroup.remove(old);
                    old.geometry.dispose();
                    (old.material as THREE.MeshBasicMaterial).map?.dispose();
                    (old.material as THREE.MeshBasicMaterial).dispose();
                }

                this.tileMeshes.set(key, mesh);
                this.tileGroup.add(mesh);
                this.renderCb?.();
            },
            undefined,
            (err) => {
                this.tileLoading.delete(key);
                console.warn('[GNSSMapItem] tile load failed', url, err);
            }
        );
    }

    private updateMarkerColor(status: number) {
        const colors: Record<number, number> = {
            [-1]: 0xff4444, // no fix
            0: 0x44bb44,    // fix
            1: 0x44ddff,    // sbas
            2: 0xff8800,    // gbas
        };
        (this.marker.material as THREE.PointsMaterial).color.setHex(colors[status] ?? 0x888888);
    }
}
