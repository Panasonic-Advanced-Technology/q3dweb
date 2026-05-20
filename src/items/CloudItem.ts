import * as THREE from 'three';

type CloudColorModeUniform = 0 | 1 | 2;

type CloudUniformState = {
    pointSize: { value: number };
    alpha: { value: number };
    vmin: { value: number };
    vmax: { value: number };
    colorMode: { value: CloudColorModeUniform };
    flatColor: { value: THREE.Color };
    pointType: { value: number };
    viewportHeight: { value: number };
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
const fract = (value: number): number => value - Math.floor(value);

function rainbowChannel(hue: number, offset: number): number {
    const p = Math.abs(fract(hue + offset) * 6 - 3);
    return clamp01(p - 1);
}

function writeRainbowColor(valueRaw: number, vmin: number, vmax: number, target: Uint8Array, offset: number): void {
    const range = Math.max(vmax - vmin, 1e-6);
    const value = clamp01((valueRaw - vmin) / range);
    const hue = value * 0.6666;
    target[offset] = clampByte(rainbowChannel(hue, 1.0) * 255);
    target[offset + 1] = clampByte(rainbowChannel(hue, 2.0 / 3.0) * 255);
    target[offset + 2] = clampByte(rainbowChannel(hue, 1.0 / 3.0) * 255);
}

function colorModeToUniformValue(colorMode?: 'FLAT' | 'I' | 'RGB'): CloudColorModeUniform {
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
    private sourceColorArray: Uint8Array;
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

        const displayColors = new Uint8Array(positions.length);
        const sourceColors = new Uint8Array(positions.length);

        if (rgbColors) {
            sourceColors.set(CloudItem.toUint8Colors(rgbColors), 0);
            options.colorMode = 'RGB';
        }
        geometry.setAttribute('color', CloudItem.makeDynamicAttribute(displayColors, 3, true));
        geometry.setDrawRange(0, values.length);

        const material = new CloudShaderMaterial(options);

        super(geometry, material);
        this.pointCount = values.length;
        this.sourceColorArray = sourceColors;
        this.frustumCulled = false; // often necessary for custom shaders or dynamic bounds
        material.attachCloudItem(this);
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
        const sourceColorArray = this.getSourceColorArray();

        positionArray.set(positions, 0);
        valueArray.set(values, 0);

        if (rgbColors) {
            sourceColorArray.set(CloudItem.toUint8Colors(rgbColors), 0);
        } else if (nextCount > 0) {
            sourceColorArray.fill(0, 0, nextCount * 3);
        }

        this.pointCount = nextCount;
        this.updateDisplayedColors(0, nextCount);
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
        const sourceColorArray = this.getSourceColorArray();

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
            sourceColorArray.set(incomingColors, dstOffsetPos);
        } else {
            sourceColorArray.fill(0, dstOffsetPos, dstOffsetPos + appendActualCount * 3);
        }

        this.pointCount = currentCount + appendActualCount;

        // Fast path: when we only append, upload only the appended tail.
        // Slow path: when downsample/reset happened, upload the whole active range.
        const dirtyStartPoint = (didDownsample || resetToIncomingTailOnly) ? 0 : currentCount;
        const dirtyCountPoints = (didDownsample || resetToIncomingTailOnly)
            ? this.pointCount
            : appendActualCount;
        this.updateDisplayedColors(dirtyStartPoint, dirtyCountPoints);
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
        const sourceColorArray = this.getSourceColorArray();
        const colorArray = this.getColorArray();

        let writePoint = 0;
        for (let readPoint = 0; readPoint < this.pointCount; readPoint += 2) {
            const readPos = readPoint * 3;
            const writePos = writePoint * 3;

            positionArray[writePos] = positionArray[readPos];
            positionArray[writePos + 1] = positionArray[readPos + 1];
            positionArray[writePos + 2] = positionArray[readPos + 2];

            valueArray[writePoint] = valueArray[readPoint];

            sourceColorArray[writePos] = sourceColorArray[readPos];
            sourceColorArray[writePos + 1] = sourceColorArray[readPos + 1];
            sourceColorArray[writePos + 2] = sourceColorArray[readPos + 2];

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

    applyMaterialState(): void {
        if (this.pointCount <= 0) return;
        this.updateDisplayedColors(0, this.pointCount);
        this.markColorDirtyRange(0, this.pointCount);
    }

    private ensureCapacity(requiredPoints: number): void {
        const positionAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
        const currentCapacity = positionAttr.array.length / 3;
        if (requiredPoints <= currentCapacity) return;

        const newCapacity = Math.max(requiredPoints, currentCapacity * 2, 1024);
        const nextPos = new Float32Array(newCapacity * 3);
        const nextVal = new Float32Array(newCapacity);
        const nextColor = new Uint8Array(newCapacity * 3);
        const nextSourceColor = new Uint8Array(newCapacity * 3);

        const positionArray = this.getPositionArray();
        const valueArray = this.getValueArray();
        const colorArray = this.getColorArray();
        const sourceColorArray = this.getSourceColorArray();
        const copiedPosLen = this.pointCount * 3;

        if (copiedPosLen > 0) {
            nextPos.set(positionArray.subarray(0, copiedPosLen), 0);
            nextVal.set(valueArray.subarray(0, this.pointCount), 0);
            nextColor.set(colorArray.subarray(0, copiedPosLen), 0);
            nextSourceColor.set(sourceColorArray.subarray(0, copiedPosLen), 0);
        }

        this.sourceColorArray = nextSourceColor;
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

    private markColorDirtyRange(startPoint: number, countPoints: number): void {
        const colorAttr = this.geometry.getAttribute('color') as THREE.BufferAttribute;
        this.setUpdateRange(colorAttr, startPoint * 3, countPoints * 3);
        colorAttr.needsUpdate = true;
        this.geometry.setDrawRange(0, this.pointCount);
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

    private getSourceColorArray(): Uint8Array {
        return this.sourceColorArray;
    }

    private updateDisplayedColors(startPoint: number, countPoints: number): void {
        if (countPoints <= 0 || this.pointCount <= 0) return;

        const material = this.material as CloudShaderMaterial;
        const displayColors = this.getColorArray();
        const sourceColors = this.getSourceColorArray();
        const values = this.getValueArray();
        const pointCount = Math.min(this.pointCount, startPoint + countPoints);
        const mode = material.uniforms.colorMode.value;

        if (mode === 1) {
            const srcStart = startPoint * 3;
            const srcEnd = pointCount * 3;
            displayColors.set(sourceColors.subarray(srcStart, srcEnd), srcStart);
            return;
        }

        if (mode === 2) {
            const flatColor = material.uniforms.flatColor.value;
            const r = clampByte(flatColor.r * 255);
            const g = clampByte(flatColor.g * 255);
            const b = clampByte(flatColor.b * 255);
            for (let point = startPoint; point < pointCount; point++) {
                const offset = point * 3;
                displayColors[offset] = r;
                displayColors[offset + 1] = g;
                displayColors[offset + 2] = b;
            }
            return;
        }

        const vmin = material.uniforms.vmin.value;
        const vmax = material.uniforms.vmax.value;
        for (let point = startPoint; point < pointCount; point++) {
            writeRainbowColor(values[point], vmin, vmax, displayColors, point * 3);
        }
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

export class CloudShaderMaterial extends THREE.PointsMaterial {
    declare uniforms: CloudUniformState;
    private cloudItem: CloudItem | null = null;
    private static sphereAlphaMap: THREE.Texture | null = null;

    constructor(options: CloudItemOptions) {
        const alpha = options.alpha !== undefined ? options.alpha : 1.0;
        const pointType = pointTypeToUniformValue(options.pointType);
        const uniforms: CloudUniformState = {
            pointSize: { value: options.size || 1.0 },
            alpha: { value: alpha },
            vmin: { value: 0.0 },
            vmax: { value: 255.0 },
            colorMode: { value: colorModeToUniformValue(options.colorMode) as CloudColorModeUniform },
            flatColor: { value: new THREE.Color(options.color || 'white') },
            pointType: { value: pointType },
            viewportHeight: { value: 1.0 },
        };

        super({
            size: uniforms.pointSize.value,
            opacity: alpha,
            transparent: alpha < 0.99 || pointType > 1.5,
            depthTest: true,
            depthWrite: alpha >= 0.99 && pointType <= 1.5,
            vertexColors: true,
            sizeAttenuation: pointType !== 0,
        });

        this.uniforms = uniforms;
        this.applyUniformState();
    }

    attachCloudItem(cloudItem: CloudItem): void {
        this.cloudItem = cloudItem;
        this.applyUniformState();
    }

    override set needsUpdate(value: boolean) {
        if (value) {
            this.applyUniformState();
            return;
        }
        super.needsUpdate = value;
    }

    override get needsUpdate(): boolean {
        return super.needsUpdate;
    }

    private applyUniformState(): void {
        const pointType = this.uniforms.pointType.value;
        const alpha = this.uniforms.alpha.value;

        this.size = this.uniforms.pointSize.value;
        this.opacity = alpha;
        this.transparent = alpha < 0.99 || pointType > 1.5;
        this.depthWrite = alpha >= 0.99 && pointType <= 1.5;
        this.sizeAttenuation = pointType !== 0;

        if (pointType > 1.5) {
            this.alphaMap = CloudShaderMaterial.getSphereAlphaMap();
            this.alphaTest = 0.5;
        } else {
            this.alphaMap = null;
            this.alphaTest = 0;
        }

        this.cloudItem?.applyMaterialState();
        super.needsUpdate = true;
    }

    private static getSphereAlphaMap(): THREE.Texture {
        if (CloudShaderMaterial.sphereAlphaMap) return CloudShaderMaterial.sphereAlphaMap;

        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            CloudShaderMaterial.sphereAlphaMap = new THREE.Texture();
            CloudShaderMaterial.sphereAlphaMap.needsUpdate = true;
            return CloudShaderMaterial.sphereAlphaMap;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width / 2 - 2, 0, Math.PI * 2);
        ctx.fill();

        CloudShaderMaterial.sphereAlphaMap = new THREE.CanvasTexture(canvas);
        CloudShaderMaterial.sphereAlphaMap.needsUpdate = true;
        return CloudShaderMaterial.sphereAlphaMap;
    }
}
