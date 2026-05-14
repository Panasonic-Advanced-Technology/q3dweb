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
    private pointCount: number;

    constructor(positions: Float32Array, values: Float32Array, options: CloudItemOptions = {}, rgbColors?: Float32Array | Uint8Array) {
        if (positions.length !== values.length * 3) {
            throw new Error('positions length must be values length * 3');
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('value', new THREE.BufferAttribute(values, 1));

        if (rgbColors) {
            geometry.setAttribute('color', new THREE.BufferAttribute(CloudItem.toUint8Colors(rgbColors), 3, true));
            options.colorMode = 'RGB';
        } else {
            geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(positions.length), 3, true));
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
        this.markAttributesDirty();
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

        this.ensureCapacity(this.pointCount + appendCount);

        const positionArray = this.getPositionArray();
        const valueArray = this.getValueArray();
        const colorArray = this.getColorArray();
        const incomingColors = rgbColors ? CloudItem.toUint8Colors(rgbColors) : null;

        let currentCount = this.pointCount;

        if (maxPoints !== undefined && maxPoints > 0 && currentCount + appendCount > maxPoints) {
            const overflow = currentCount + appendCount - maxPoints;

            if (overflow >= currentCount) {
                const keepFromIncoming = Math.min(appendCount, maxPoints);
                const srcOffsetPoints = appendCount - keepFromIncoming;
                const srcOffsetPos = srcOffsetPoints * 3;

                positionArray.set(positions.subarray(srcOffsetPos), 0);
                valueArray.set(values.subarray(srcOffsetPoints), 0);
                if (incomingColors) {
                    colorArray.set(incomingColors.subarray(srcOffsetPos), 0);
                } else {
                    colorArray.fill(0, 0, keepFromIncoming * 3);
                }

                this.pointCount = keepFromIncoming;
                this.markAttributesDirty();
                return this.pointCount;
            }

            const keepOldCount = currentCount - overflow;
            positionArray.copyWithin(0, overflow * 3, currentCount * 3);
            valueArray.copyWithin(0, overflow, currentCount);
            colorArray.copyWithin(0, overflow * 3, currentCount * 3);
            currentCount = keepOldCount;
        }

        const dstOffsetPos = currentCount * 3;
        positionArray.set(positions, dstOffsetPos);
        valueArray.set(values, currentCount);
        if (incomingColors) {
            colorArray.set(incomingColors, dstOffsetPos);
        } else {
            colorArray.fill(0, dstOffsetPos, dstOffsetPos + appendCount * 3);
        }

        this.pointCount = currentCount + appendCount;
        this.markAttributesDirty();
        return this.pointCount;
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

        this.geometry.setAttribute('position', new THREE.BufferAttribute(nextPos, 3));
        this.geometry.setAttribute('value', new THREE.BufferAttribute(nextVal, 1));
        this.geometry.setAttribute('color', new THREE.BufferAttribute(nextColor, 3, true));
    }

    private markAttributesDirty(): void {
        const positionAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
        const valueAttr = this.geometry.getAttribute('value') as THREE.BufferAttribute;
        const colorAttr = this.geometry.getAttribute('color') as THREE.BufferAttribute;

        positionAttr.needsUpdate = true;
        valueAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
        this.geometry.setDrawRange(0, this.pointCount);
        this.geometry.boundingBox = null;
        this.geometry.boundingSphere = null;
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
}

export class CloudShaderMaterial extends THREE.ShaderMaterial {
    constructor(options: CloudItemOptions) {
        const uniforms = {
            pointSize: { value: options.size || 1.0 },
            alpha: { value: options.alpha !== undefined ? options.alpha : 1.0 },
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
            transparent: true,
            depthTest: true,
            depthWrite: false, // usually better for transparent points
        });
    }
}
