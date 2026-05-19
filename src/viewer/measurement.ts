/**
 * Point measurement tool (Ctrl+click to place/remove measurement points).
 * Extracted from viewer.ts for modularity.
 */

import * as THREE from 'three';

export interface MeasurementContext {
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    items: { [name: string]: THREE.Object3D };
    centerPointMesh: THREE.Points | null;
    selectedPoints: THREE.Vector3[];
    text2dItem: { setHTML(html: string): void; setText(t: string): void; show(): void; hide(): void; } | null;
    requestRender(): void;
}

export function addMeasurementPoint(e: MouseEvent, ctx: MeasurementContext): void {
    const rect   = ctx.renderer.domElement.getBoundingClientRect();
    const mouse  = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width)  * 2 - 1,
        -((e.clientY - rect.top)  / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, ctx.camera);
    raycaster.params.Points = { threshold: 0.5 };

    const intersectables = Object.values(ctx.items).filter(
        i => i instanceof THREE.Points && i.name !== '' && i !== ctx.centerPointMesh,
    );
    const hits = raycaster.intersectObjects(intersectables, false);
    if (hits.length > 0) {
        let best = hits[0] as any;
        for (let i = 1; i < hits.length; i++) {
            const h = hits[i] as any;
            const bestRay = Number.isFinite(best.distanceToRay) ? best.distanceToRay : Infinity;
            const hRay    = Number.isFinite(h.distanceToRay)    ? h.distanceToRay    : Infinity;
            if (hRay < bestRay || (hRay === bestRay && h.distance < best.distance)) best = h;
        }
        ctx.selectedPoints.push(best.point.clone());
        updateMeasurementMarker(ctx);
    }
}

export function removeMeasurementPoint(ctx: MeasurementContext): void {
    if (ctx.selectedPoints.length > 0) {
        ctx.selectedPoints.pop();
        updateMeasurementMarker(ctx);
    }
}

export function updateMeasurementMarker(ctx: MeasurementContext): void {
    const markerItem = ctx.items['marker'];
    if (markerItem && 'setData' in markerItem) {
        const data = ctx.selectedPoints.map(p => ({
            text: '',
            position: [p.x, p.y, p.z] as [number, number, number],
            color:    [0.0, 1.0, 0.0, 1.0] as [number, number, number, number],
            fontSize: 16, pointSize: 5.0, lineWidth: 1.0,
        }));
        (markerItem as any).setData(data);
    }

    if (ctx.selectedPoints.length >= 2) {
        let totalDist = 0;
        const segments: string[] = [];
        for (let i = 1; i < ctx.selectedPoints.length; i++) {
            const d = ctx.selectedPoints[i].distanceTo(ctx.selectedPoints[i - 1]);
            totalDist += d;
            segments.push(`#${i}→#${i + 1}: ${d.toFixed(3)} m`);
        }
        if (ctx.text2dItem) {
            ctx.text2dItem.setHTML([
                `<b>Measurement</b>`,
                `Points: ${ctx.selectedPoints.length}`,
                ...segments,
                `<span style="color:#fff;">Total: ${totalDist.toFixed(3)} m</span>`,
            ].join('<br>'));
            ctx.text2dItem.show();
        }
    } else if (ctx.selectedPoints.length === 1) {
        const p = ctx.selectedPoints[0];
        if (ctx.text2dItem) {
            ctx.text2dItem.setHTML(
                `<b>Measurement</b><br>` +
                `Point 1: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})<br>` +
                `<span style="color:#aaa;">Ctrl+click another point to measure…</span>`,
            );
            ctx.text2dItem.show();
        }
    } else {
        if (ctx.text2dItem) { ctx.text2dItem.setText(''); ctx.text2dItem.hide(); }
    }
    ctx.requestRender();
}
