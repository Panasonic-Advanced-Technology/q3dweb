import * as THREE from 'three';
import { makeCheckbox, makeLabel, makeNumberInput } from '../viewer/settingsUI';

export interface GridItemOptions {
    size?: number;
    spacing?: number;
    color?: number | string;
    opacity?: number;
    offset?: [number, number, number];
}

/**
 * XY plane grid.
 * Port of q3dviewer GridItem.
 */
export class GridItem extends THREE.LineSegments {
    private gridSize: number;
    private gridSpacing: number;
    private gridOffset: [number, number, number];
    renderCb: (() => void) | null = null;

    constructor(options: GridItemOptions = {}) {
        const size = options.size ?? 100;
        const spacing = options.spacing ?? 20;
        const offset: [number, number, number] = options.offset ?? [0, 0, 0];
        const opacity = options.opacity ?? 0.25;

        const geometry = GridItem.buildGeometry(size, spacing, offset);

        const material = new THREE.LineBasicMaterial({
            color: options.color ?? 0xffffff,
            transparent: opacity < 1.0,
            opacity: opacity,
        });

        super(geometry, material);
        this.gridSize = size;
        this.gridSpacing = spacing;
        this.gridOffset = offset;
    }

    private static buildGeometry(size: number, spacing: number, offset: [number, number, number]): THREE.BufferGeometry {
        const [ox, oy, oz] = offset;
        const half = size / 2;
        const vertices: number[] = [];

        for (let i = -half; i <= half + 0.001; i += spacing) {
            // Lines parallel to Y axis
            vertices.push(i + ox, -half + oy, oz, i + ox, half + oy, oz);
            // Lines parallel to X axis
            vertices.push(-half + ox, i + oy, oz, half + ox, i + oy, oz);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        return geometry;
    }

    setSize(size: number) {
        if (size <= 0) return;
        this.gridSize = size;
        this.rebuild();
    }

    setSpacing(spacing: number) {
        if (spacing > 0) {
            this.gridSpacing = spacing;
            this.rebuild();
        }
    }

    setOffset(offset: [number, number, number]) {
        this.gridOffset = offset;
        this.rebuild();
    }

    addSetting(container: HTMLElement): void {
        container.appendChild(makeCheckbox('Show Grid', this.visible, (visible) => {
            this.visible = visible;
            this.renderCb?.();
        }));
        container.appendChild(makeLabel('Spacing:'));
        container.appendChild(makeNumberInput(this.gridSpacing, 0.1, 100000, 0.1, (v) => this.setSpacing(v)));
    }

    private rebuild() {
        this.geometry.dispose();
        this.geometry = GridItem.buildGeometry(this.gridSize, this.gridSpacing, this.gridOffset);
        this.renderCb?.();
    }
}
