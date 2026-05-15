import * as THREE from 'three';
import type { ColorMode } from './realtimeTypes';

export class WebGLCloudBackend {
    private static readonly CAPACITY_STEP = 1_000_000;
    private gl: WebGLRenderingContext | null = null;
    private program: WebGLProgram | null = null;
    private vbo: WebGLBuffer | null = null;
    private aPosition = -1;
    private aValue = -1;
    private uView: WebGLUniformLocation | null = null;
    private uProj: WebGLUniformLocation | null = null;
    private uVMin: WebGLUniformLocation | null = null;
    private uVMax: WebGLUniformLocation | null = null;
    private uPointSize: WebGLUniformLocation | null = null;
    private uColorMode: WebGLUniformLocation | null = null;
    private uFlatColor: WebGLUniformLocation | null = null;
    private uAlpha: WebGLUniformLocation | null = null;
    private cpuBuffer = new Float32Array(0);
    private capacityPoints = 0;
    private pointCount = 0;
    private maxPoints = 5_000_000;

    reset(maxPoints: number): void {
        this.maxPoints = Math.max(1, Math.floor(maxPoints));
        this.pointCount = 0;
    }

    getPointCount(): number {
        return this.pointCount;
    }

    append(
        renderer: THREE.WebGLRenderer,
        positions: Float32Array,
        values: Float32Array,
        maxPoints: number,
    ): void {
        if (positions.length !== values.length * 3) return;
        if (values.length === 0) return;

        this.maxPoints = Math.max(1, Math.floor(maxPoints));
        this.ensureInitialized(renderer);
        if (!this.gl || !this.vbo) return;

        let appendPos = positions;
        let appendVal = values;

        while (appendVal.length > Math.floor(this.maxPoints * 0.9) && appendVal.length > 1) {
            const halfCount = Math.ceil(appendVal.length / 2);
            const nextPos = new Float32Array(halfCount * 3);
            const nextVal = new Float32Array(halfCount);
            let w = 0;
            for (let r = 0; r < appendVal.length; r += 2) {
                const rp = r * 3;
                const wp = w * 3;
                nextPos[wp] = appendPos[rp];
                nextPos[wp + 1] = appendPos[rp + 1];
                nextPos[wp + 2] = appendPos[rp + 2];
                nextVal[w] = appendVal[r];
                w++;
            }
            appendPos = nextPos;
            appendVal = nextVal;
        }

        this.ensureCapacity(Math.min(this.maxPoints, this.pointCount + appendVal.length));
        if (!this.vbo) return;

        let didDownsample = false;
        while (this.pointCount > 1 && this.pointCount + appendVal.length > this.capacityPoints) {
            this.downsampleExistingHalfInPlace();
            didDownsample = true;
        }

        let currentCount = this.pointCount;
        if (appendVal.length > this.capacityPoints) {
            const keep = this.capacityPoints;
            const srcStart = appendVal.length - keep;
            appendVal = appendVal.subarray(srcStart);
            appendPos = appendPos.subarray(srcStart * 3);
            currentCount = 0;
            didDownsample = true;
        }

        for (let i = 0; i < appendVal.length; i++) {
            const srcPos = i * 3;
            const dstPoint = currentCount + i;
            const dst = dstPoint * 4;
            this.cpuBuffer[dst] = appendPos[srcPos];
            this.cpuBuffer[dst + 1] = appendPos[srcPos + 1];
            this.cpuBuffer[dst + 2] = appendPos[srcPos + 2];
            this.cpuBuffer[dst + 3] = appendVal[i];
        }

        this.pointCount = currentCount + appendVal.length;

        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        if (didDownsample || currentCount === 0) {
            const uploaded = this.cpuBuffer.subarray(0, this.pointCount * 4);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, uploaded);
        } else {
            const dstStart = currentCount * 4;
            const uploaded = this.cpuBuffer.subarray(dstStart, (currentCount + appendVal.length) * 4);
            gl.bufferSubData(gl.ARRAY_BUFFER, currentCount * 16, uploaded);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    draw(
        renderer: THREE.WebGLRenderer,
        camera: THREE.PerspectiveCamera,
        colorMode: ColorMode,
        dataMin: number,
        dataMax: number,
        pointSize: number,
        alpha: number,
    ): void {
        if (this.pointCount <= 0) return;
        if (colorMode === 'RGB') return;

        this.ensureInitialized(renderer);
        if (!this.gl || !this.program || !this.vbo) return;

        const gl = this.gl;
        const view = camera.matrixWorldInverse.elements;
        const proj = camera.projectionMatrix.elements;

        renderer.resetState();

        gl.enable(gl.DEPTH_TEST);
        if (alpha < 0.99) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
        } else {
            gl.disable(gl.BLEND);
            gl.depthMask(true);
        }

        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.uView, false, view as unknown as Float32List);
        gl.uniformMatrix4fv(this.uProj, false, proj as unknown as Float32List);
        gl.uniform1f(this.uVMin, dataMin);
        gl.uniform1f(this.uVMax, dataMax);
        gl.uniform1f(this.uPointSize, pointSize);
        gl.uniform1f(this.uColorMode, colorMode === 'FLAT' ? 2 : 0);
        gl.uniform3f(this.uFlatColor, 1, 1, 1);
        gl.uniform1f(this.uAlpha, alpha);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.enableVertexAttribArray(this.aPosition);
        gl.enableVertexAttribArray(this.aValue);
        gl.vertexAttribPointer(this.aPosition, 3, gl.FLOAT, false, 16, 0);
        gl.vertexAttribPointer(this.aValue, 1, gl.FLOAT, false, 16, 12);
        gl.drawArrays(gl.POINTS, 0, this.pointCount);
        gl.disableVertexAttribArray(this.aPosition);
        gl.disableVertexAttribArray(this.aValue);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.useProgram(null);
        gl.depthMask(true);

        renderer.resetState();
    }

    private ensureInitialized(renderer: THREE.WebGLRenderer): void {
        if (this.gl && this.program && this.vbo) return;

        this.gl = renderer.getContext();
        const gl = this.gl;

        if (!this.program) {
            const vertSrc = `
                attribute vec3 aPosition;
                attribute float aValue;
                uniform mat4 uView;
                uniform mat4 uProj;
                uniform float uVMin;
                uniform float uVMax;
                uniform float uPointSize;
                uniform float uColorMode;
                uniform vec3 uFlatColor;
                varying vec3 vColor;

                vec3 rainbow(float x) {
                    float t = clamp((x - uVMin) / max(uVMax - uVMin, 1e-6), 0.0, 1.0);
                    float h = t * 0.6666;
                    vec3 K = vec3(1.0, 2.0 / 3.0, 1.0 / 3.0);
                    vec3 p = abs(fract(vec3(h) + K) * 6.0 - vec3(3.0));
                    return clamp(p - vec3(1.0), 0.0, 1.0);
                }

                void main() {
                    vec3 c = rainbow(aValue);
                    if (uColorMode > 1.5) c = uFlatColor;
                    vColor = c;
                    vec4 mv = uView * vec4(aPosition, 1.0);
                    gl_Position = uProj * mv;
                    gl_PointSize = uPointSize;
                }
            `;
            const fragSrc = `
                precision mediump float;
                varying vec3 vColor;
                uniform float uAlpha;
                void main() {
                    gl_FragColor = vec4(vColor, uAlpha);
                }
            `;

            const vert = this.compileShader(gl, gl.VERTEX_SHADER, vertSrc);
            const frag = this.compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
            const program = gl.createProgram();
            if (!vert || !frag || !program) return;
            gl.attachShader(program, vert);
            gl.attachShader(program, frag);
            gl.linkProgram(program);
            gl.deleteShader(vert);
            gl.deleteShader(frag);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                gl.deleteProgram(program);
                return;
            }
            this.program = program;
            this.aPosition = gl.getAttribLocation(program, 'aPosition');
            this.aValue = gl.getAttribLocation(program, 'aValue');
            this.uView = gl.getUniformLocation(program, 'uView');
            this.uProj = gl.getUniformLocation(program, 'uProj');
            this.uVMin = gl.getUniformLocation(program, 'uVMin');
            this.uVMax = gl.getUniformLocation(program, 'uVMax');
            this.uPointSize = gl.getUniformLocation(program, 'uPointSize');
            this.uColorMode = gl.getUniformLocation(program, 'uColorMode');
            this.uFlatColor = gl.getUniformLocation(program, 'uFlatColor');
            this.uAlpha = gl.getUniformLocation(program, 'uAlpha');
        }

        if (!this.vbo) {
            this.vbo = gl.createBuffer();
        }

        this.ensureCapacity(Math.min(this.maxPoints, WebGLCloudBackend.CAPACITY_STEP));
    }

    private ensureCapacity(requiredPoints: number): void {
        if (!this.gl || !this.vbo) return;
        if (requiredPoints <= this.capacityPoints) return;

        let next = Math.max(this.capacityPoints, WebGLCloudBackend.CAPACITY_STEP);
        while (next < requiredPoints && next < this.maxPoints) {
            next += WebGLCloudBackend.CAPACITY_STEP;
        }
        next = Math.min(next, this.maxPoints);
        if (next <= this.capacityPoints) return;

        const nextCpu = new Float32Array(next * 4);
        if (this.pointCount > 0 && this.cpuBuffer.length > 0) {
            nextCpu.set(this.cpuBuffer.subarray(0, this.pointCount * 4), 0);
        }
        this.cpuBuffer = nextCpu;
        this.capacityPoints = next;

        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.capacityPoints * 16, gl.DYNAMIC_DRAW);
        if (this.pointCount > 0) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cpuBuffer.subarray(0, this.pointCount * 4));
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    private downsampleExistingHalfInPlace(): void {
        if (this.pointCount <= 1) return;
        let write = 0;
        for (let read = 0; read < this.pointCount; read += 2) {
            const src = read * 4;
            const dst = write * 4;
            this.cpuBuffer[dst] = this.cpuBuffer[src];
            this.cpuBuffer[dst + 1] = this.cpuBuffer[src + 1];
            this.cpuBuffer[dst + 2] = this.cpuBuffer[src + 2];
            this.cpuBuffer[dst + 3] = this.cpuBuffer[src + 3];
            write++;
        }
        this.pointCount = write;
    }

    private compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }
}
