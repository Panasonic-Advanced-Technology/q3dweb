import * as THREE from 'three';

function colorModeToUniformValue(colorMode?: 'FLAT' | 'I' | 'RGB'): number {
    switch (colorMode) {
        case 'RGB':
            return 1;
        case 'FLAT':
            return 2;
        case 'I':
        default:
            return 0;
    }
}

function pointTypeToUniformValue(pointType?: 'PIXEL' | 'SQUARE' | 'SPHERE'): number {
    switch (pointType) {
        case 'SQUARE':
            return 1;
        case 'SPHERE':
            return 2;
        case 'PIXEL':
        default:
            return 0;
    }
}

export interface CloudItemOptions {
    size?: number;
    alpha?: number;
    colorMode?: 'FLAT' | 'I' | 'RGB';
    color?: string;
    pointType?: 'PIXEL' | 'SQUARE' | 'SPHERE';
}

export class CloudItem extends THREE.Points {
    private static readonly GROWTH_STEP_POINTS = 1_000_000;
    private pointCount: number;
    private lastAppendMeta: {
        appendRequested: number;
        appendActual: number;
        dirtyPoints: number;
        didDownsample: boolean;
        resetToIncomingTailOnly: boolean;
        totalPoints: number;
    } | null = null;

    constructor(positions: Float32Array, values: Float32Array, options: CloudItemOptions = {}, rgbColors?: Float32Array | Uint8Array) {
        if (positions.length !== values.length * 3) {
            throw new Error('positions length must be values length * 3');
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', CloudItem.makeDynamicAttribute(positions, 3));
        geometry.setAttribute('value', CloudItem.makeDynamicAttribute(values, 1));

        if (rgbColors) {
            geometry.setAttribute('color', CloudItem.makeDynamicAttribute(CloudItem.toUint8Colors(rgbColors), 3, true));
            options.colorMode = 'RGB';
        } else {
            geometry.setAttribute('color', CloudItem.makeDynamicAttribute(new Uint8Array(positions.length), 3, true));
        }
        geometry.setDrawRange(0, values.length);

        const material = new CloudShaderMaterial(options);

        super(geometry, material);
        this.pointCount = values.length;
        this.frustumCulled = false; // often necessary for custom shaders or dynamic bounds
    }

    getPointCount(): number {
        return this.pointCount;
    }

    getLastAppendMeta(): {
        appendRequested: number;
        appendActual: number;
        dirtyPoints: number;
        didDownsample: boolean;
        resetToIncomingTailOnly: boolean;
        totalPoints: number;
    } | null {
        return this.lastAppendMeta;
    }

    replacePoints(positions: Float32Array, values: Float32Array, rgbColors?: Float32Array | Uint8Array): void {
        if (positions.length !== values.length * 3) {
            throw new Error('positions length must be values length * 3');
        }

        const nextCount = values.length;
        this.ensureCapacity(nextCount);

        const positionArray = this.getPositionArray();
        const valueArray = this.getValueArray();
        const colorArray = this.getColorArray();

        positionArray.set(positions, 0);
        valueArray.set(values, 0);

        if (rgbColors) {
            colorArray.set(CloudItem.toUint8Colors(rgbColors), 0);
        } else if (nextCount > 0) {
            colorArray.fill(0, 0, nextCount * 3);
        }

        this.pointCount = nextCount;
        this.markAttributesDirtyRange(0, nextCount);
    }

    appendPoints(
        positions: Float32Array,
        values: Float32Array,
        rgbColors?: Float32Array | Uint8Array,
        maxPoints?: number,
    ): number {
        if (positions.length !== values.length * 3) {
            throw new Error('positions length must be values length * 3');
        }

        const appendCount = values.length;
        if (appendCount === 0) return this.pointCount;

        const limit = maxPoints !== undefined && maxPoints > 0
            ? Math.max(1, Math.floor(maxPoints))
            : undefined;

        let appendPositions = positions;
        let appendValues = values;
        let incomingColors = rgbColors ? CloudItem.toUint8Colors(rgbColors) : null;
        let appendActualCount = appendCount;

        // Like python CloudItem: if incoming chunk itself is too large, decimate first.
        if (limit !== undefined) {
            while (appendActualCount > Math.floor(limit * 0.9)) {
                const half = CloudItem.downsampleChunkHalf(appendPositions, appendValues, incomingColors);
                appendPositions = half.positions;
                appendValues = half.values;
                incomingColors = half.colors;
                appendActualCount = appendValues.length;
                if (appendActualCount <= 1) break;
            }
        }

        const targetCount = this.pointCount + appendActualCount;
        this.ensureCapacityIncremental(targetCount, limit);

        let didDownsample = false;
        let capacity = this.getCapacityPoints();
        while (this.pointCount > 1 && this.pointCount + appendActualCount > capacity) {
            this.downsampleExistingHalfInPlace();
            didDownsample = true;
        }

        const positionArray = this.getPositionArray();
        const valueArray = this.getValueArray();
        const colorArray = this.getColorArray();

        let currentCount = this.pointCount;

        // If a single incoming chunk still exceeds capacity, keep its tail.
        let resetToIncomingTailOnly = false;
        capacity = this.getCapacityPoints();
        if (appendActualCount > capacity) {
            const keepFromIncoming = capacity;
            const srcOffsetPoints = appendActualCount - keepFromIncoming;
            const srcOffsetPos = srcOffsetPoints * 3;
            appendPositions = appendPositions.subarray(srcOffsetPos);
            appendValues = appendValues.subarray(srcOffsetPoints);
            incomingColors = incomingColors ? incomingColors.subarray(srcOffsetPos) : null;
            appendActualCount = keepFromIncoming;
            currentCount = 0;
            resetToIncomingTailOnly = true;
        }

        const dstOffsetPos = currentCount * 3;
        positionArray.set(appendPositions, dstOffsetPos);
        valueArray.set(appendValues, currentCount);
        if (incomingColors) {
            colorArray.set(incomingColors, dstOffsetPos);
        } else {
            colorArray.fill(0, dstOffsetPos, dstOffsetPos + appendActualCount * 3);
        }

        this.pointCount = currentCount + appendActualCount;

        // Fast path: when we only append, upload only the appended tail.
        // Slow path: when downsample/reset happened, upload the whole active range.
        const dirtyStartPoint = (didDownsample || resetToIncomingTailOnly) ? 0 : currentCount;
        const dirtyCountPoints = (didDownsample || resetToIncomingTailOnly)
            ? this.pointCount
            : appendActualCount;
        this.markAttributesDirtyRange(dirtyStartPoint, dirtyCountPoints);
        this.lastAppendMeta = {
            appendRequested: appendCount,
            appendActual: appendActualCount,
            dirtyPoints: dirtyCountPoints,
            didDownsample,
            resetToIncomingTailOnly,
            totalPoints: this.pointCount,
        };
        return this.pointCount;
    }

    private downsampleExistingHalfInPlace(): void {
        if (this.pointCount <= 1) return;

        const positionArray = this.getPositionArray();
        const valueArray = this.getValueArray();
        const colorArray = this.getColorArray();

        let writePoint = 0;
        for (let readPoint = 0; readPoint < this.pointCount; readPoint += 2) {
            const readPos = readPoint * 3;
            const writePos = writePoint * 3;

            positionArray[writePos] = positionArray[readPos];
            positionArray[writePos + 1] = positionArray[readPos + 1];
            positionArray[writePos + 2] = positionArray[readPos + 2];

            valueArray[writePoint] = valueArray[readPoint];

            colorArray[writePos] = colorArray[readPos];
            colorArray[writePos + 1] = colorArray[readPos + 1];
            colorArray[writePos + 2] = colorArray[readPos + 2];
            writePoint++;
        }

        this.pointCount = writePoint;
    }

    updateViewport(height: number) {
        const material = this.material as CloudShaderMaterial;
        material.uniforms.viewportHeight.value = Math.max(height, 1);
    }

    private ensureCapacity(requiredPoints: number): void {
        const positionAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
        const currentCapacity = positionAttr.array.length / 3;
        if (requiredPoints <= currentCapacity) return;

        const newCapacity = Math.max(requiredPoints, currentCapacity * 2, 1024);
        const nextPos = new Float32Array(newCapacity * 3);
        const nextVal = new Float32Array(newCapacity);
        const nextColor = new Uint8Array(newCapacity * 3);

        const positionArray = this.getPositionArray();
        const valueArray = this.getValueArray();
        const colorArray = this.getColorArray();
        const copiedPosLen = this.pointCount * 3;

        if (copiedPosLen > 0) {
            nextPos.set(positionArray.subarray(0, copiedPosLen), 0);
            nextVal.set(valueArray.subarray(0, this.pointCount), 0);
            nextColor.set(colorArray.subarray(0, copiedPosLen), 0);
        }

        this.geometry.setAttribute('position', CloudItem.makeDynamicAttribute(nextPos, 3));
        this.geometry.setAttribute('value', CloudItem.makeDynamicAttribute(nextVal, 1));
        this.geometry.setAttribute('color', CloudItem.makeDynamicAttribute(nextColor, 3, true));
    }

    private ensureCapacityIncremental(requiredPoints: number, maxCapacity?: number): void {
        const currentCapacity = this.getCapacityPoints();
        if (requiredPoints <= currentCapacity) return;

        let nextCapacity = Math.max(currentCapacity, CloudItem.GROWTH_STEP_POINTS);
        while (requiredPoints > nextCapacity && (maxCapacity === undefined || nextCapacity < maxCapacity)) {
            nextCapacity += CloudItem.GROWTH_STEP_POINTS;
        }
        if (maxCapacity !== undefined) {
            nextCapacity = Math.min(nextCapacity, maxCapacity);
        }

        if (nextCapacity > currentCapacity) {
            this.ensureCapacity(nextCapacity);
        }
    }

    private markAttributesDirtyRange(startPoint: number, countPoints: number): void {
        const positionAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
        const valueAttr = this.geometry.getAttribute('value') as THREE.BufferAttribute;
        const colorAttr = this.geometry.getAttribute('color') as THREE.BufferAttribute;

        this.setUpdateRange(positionAttr, startPoint * 3, countPoints * 3);
        this.setUpdateRange(valueAttr, startPoint, countPoints);
        this.setUpdateRange(colorAttr, startPoint * 3, countPoints * 3);

        positionAttr.needsUpdate = true;
        valueAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
        this.geometry.setDrawRange(0, this.pointCount);
        this.geometry.boundingBox = null;
        this.geometry.boundingSphere = null;
    }

    private static makeDynamicAttribute(
        array: Float32Array | Uint8Array,
        itemSize: number,
        normalized: boolean = false,
    ): THREE.BufferAttribute {
        const attr = new THREE.BufferAttribute(array, itemSize, normalized);
        attr.setUsage(THREE.DynamicDrawUsage);
        return attr;
    }

    private setUpdateRange(attr: THREE.BufferAttribute, start: number, count: number): void {
        if (count <= 0) return;
        attr.clearUpdateRanges();
        attr.addUpdateRange(start, count);
    }

    private getCapacityPoints(): number {
        const positionAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
        return (positionAttr.array as Float32Array).length / 3;
    }

    private getPositionArray(): Float32Array {
        const attr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
        return attr.array as Float32Array;
    }

    private getValueArray(): Float32Array {
        const attr = this.geometry.getAttribute('value') as THREE.BufferAttribute;
        return attr.array as Float32Array;
    }

    private getColorArray(): Uint8Array {
        const attr = this.geometry.getAttribute('color') as THREE.BufferAttribute;
        return attr.array as Uint8Array;
    }

    private static toUint8Colors(rgbColors: Float32Array | Uint8Array): Uint8Array {
        if (rgbColors instanceof Uint8Array || rgbColors instanceof Uint8ClampedArray) {
            return rgbColors;
        }

        const out = new Uint8Array(rgbColors.length);
        for (let i = 0; i < rgbColors.length; i++) {
            const v = rgbColors[i];
            const scaled = v <= 1.0 ? v * 255 : v;
            out[i] = Math.max(0, Math.min(255, Math.round(scaled)));
        }
        return out;
    }

    private static downsampleChunkHalf(
        positions: Float32Array,
        values: Float32Array,
        colors: Uint8Array | null,
    ): { positions: Float32Array; values: Float32Array; colors: Uint8Array | null } {
        const srcCount = values.length;
        const dstCount = Math.ceil(srcCount / 2);
        const dstPos = new Float32Array(dstCount * 3);
        const dstVal = new Float32Array(dstCount);
        const dstCol = colors ? new Uint8Array(dstCount * 3) : null;

        let write = 0;
        for (let read = 0; read < srcCount; read += 2) {
            const readPos = read * 3;
            const writePos = write * 3;
            dstPos[writePos] = positions[readPos];
            dstPos[writePos + 1] = positions[readPos + 1];
            dstPos[writePos + 2] = positions[readPos + 2];
            dstVal[write] = values[read];
            if (dstCol && colors) {
                dstCol[writePos] = colors[readPos];
                dstCol[writePos + 1] = colors[readPos + 1];
                dstCol[writePos + 2] = colors[readPos + 2];
            }
            write++;
        }

        return {
            positions: dstPos,
            values: dstVal,
            colors: dstCol,
        };
    }
}

export class CloudShaderMaterial extends THREE.ShaderMaterial {
    constructor(options: CloudItemOptions) {
        const alpha = options.alpha !== undefined ? options.alpha : 1.0;
        const uniforms = {
            pointSize: { value: options.size || 1.0 },
            alpha: { value: alpha },
            vmin: { value: 0.0 },
            vmax: { value: 255.0 },
            colorMode: { value: colorModeToUniformValue(options.colorMode) },
            flatColor: { value: new THREE.Color(options.color || 'white') },
            pointType: { value: pointTypeToUniformValue(options.pointType) },
            viewportHeight: { value: 1.0 },
        };

        const vertexShader = `
            attribute float value;
            attribute vec3 color;
            varying vec3 vColor;
            uniform float vmin;
            uniform float vmax;
            uniform float pointSize;
            uniform float colorMode;
            uniform vec3 flatColor;
            uniform float pointType;
            uniform float viewportHeight;

            vec3 getRainbowColor(float value_raw) {
                float range = vmax - vmin;
                float val = (value_raw - vmin) / range;
                val = clamp(val, 0.0, 1.0);

                float h = val * 0.6666; 
                float s = 1.0; 
                float v = 1.0;

                vec3 c = vec3(h, s, v);
                vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
                vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
                return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
            }

            void main() {
                vec3 rainbowColor = getRainbowColor(value);
                float rgbWeight = 1.0 - step(0.5, abs(colorMode - 1.0));
                float flatWeight = step(1.5, colorMode);
                vec3 mixedColor = mix(rainbowColor, color, rgbWeight);
                vColor = mix(mixedColor, flatColor, flatWeight);

                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                gl_Position = projectionMatrix * mvPosition;

                float worldPointSize = (pointSize * 0.01) * projectionMatrix[1][1] * viewportHeight * 0.5 / max(abs(gl_Position.w), 0.0001);
                float worldMode = step(0.5, pointType);
                gl_PointSize = mix(pointSize, worldPointSize, worldMode);
            }
        `;

        const fragmentShader = `
            varying vec3 vColor;
            uniform float alpha;
            uniform float pointType;

            void main() {
                vec2 coord = gl_PointCoord * 2.0 - 1.0;
                float sphereEnabled = step(1.5, pointType);
                float insideSphere = 1.0 - step(1.0, dot(coord, coord));
                float pointAlpha = alpha * mix(1.0, insideSphere, sphereEnabled);
                gl_FragColor = vec4(vColor, pointAlpha);
            }
        `;

        super({
            uniforms: uniforms,
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            transparent: alpha < 0.99,
            depthTest: true,
            depthWrite: alpha >= 0.99,
        });
    }
}
