/**
 * Point / surface measurement tool (Ctrl+click to place/remove measurement points).
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

type MeasurementTarget = THREE.Points | THREE.Mesh;

function collectMeasurementTargets(ctx: MeasurementContext): MeasurementTarget[] {
    const targets: MeasurementTarget[] = [];
    for (const item of Object.values(ctx.items)) {
        item.traverseVisible((object) => {
            if (object === ctx.centerPointMesh) return;
            if (object instanceof THREE.Points) {
                if (object.name === '') return;
                targets.push(object);
                return;
            }
            if (object instanceof THREE.Mesh && object.userData.measurementTarget === true) {
                targets.push(object);
            }
        });
    }
    return targets;
}

function chooseBestMeasurementHit(hits: THREE.Intersection[]): THREE.Intersection {
    let best = hits[0];
    for (let i = 1; i < hits.length; i++) {
        const hit = hits[i];
        const bestRay = Number.isFinite((best as any).distanceToRay) ? (best as any).distanceToRay : Number.POSITIVE_INFINITY;
        const hitRay = Number.isFinite((hit as any).distanceToRay) ? (hit as any).distanceToRay : Number.POSITIVE_INFINITY;
        const bestPriority = Number.isFinite(bestRay) ? 0 : 1;
        const hitPriority = Number.isFinite(hitRay) ? 0 : 1;
        if (hitPriority < bestPriority) {
            best = hit;
            continue;
        }
        if (hitPriority > bestPriority) continue;
        if (hitRay < bestRay || (hitRay === bestRay && hit.distance < best.distance)) {
            best = hit;
        }
    }
    return best;
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

    const intersectables = collectMeasurementTargets(ctx);
    const hits = raycaster.intersectObjects(intersectables, false);
    if (hits.length > 0) {
        const best = chooseBestMeasurementHit(hits);
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
