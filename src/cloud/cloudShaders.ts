export interface CloudProgramLocations {
    program: WebGLProgram;
    aPos: number;
    aVal: number;
    aColor: number;
    uViewProj: WebGLUniformLocation | null;
    uBoundsMin: WebGLUniformLocation | null;
    uBoundsSize: WebGLUniformLocation | null;
    uValOffset: WebGLUniformLocation | null;
    uValScale: WebGLUniformLocation | null;
    uVMin: WebGLUniformLocation | null;
    uVMax: WebGLUniformLocation | null;
    uPointSize: WebGLUniformLocation | null;
    uWorldSizeFactor: WebGLUniformLocation | null;
    uFlatColor: WebGLUniformLocation | null;
    uEffectiveAlpha: WebGLUniformLocation | null;
}

export interface BlitProgramLocations {
    program: WebGLProgram;
    aPos: number;
    uTex: WebGLUniformLocation | null;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('CloudShader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function linkProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram | null {
    const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    if (!vert || !frag) {
        if (vert) gl.deleteShader(vert);
        if (frag) gl.deleteShader(frag);
        return null;
    }
    const program = gl.createProgram();
    if (!program) {
        gl.deleteShader(vert);
        gl.deleteShader(frag);
        return null;
    }
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    // Bind fixed attribute locations so per-chunk VAOs can be reused across all shader variants.
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.bindAttribLocation(program, 1, 'aVal');
    gl.bindAttribLocation(program, 2, 'aColor');
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('CloudShader link error:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

function buildVertexSource(
    colorMode: number,
    pointType: number,
    isQuantized: boolean,
    hasRGB: boolean,
): string {
    const useRGB = colorMode === 1 && hasRGB;
    const useFlat = colorMode === 2;
    const useRgbFallback = colorMode === 1 && !hasRGB;
    const useIntensity = !useRGB && !useFlat && !useRgbFallback;
    const isWorldSize = pointType >= 1;

    const lines: string[] = [
        'precision highp float;',
        'attribute vec3 aPos;',
    ];
    if (useIntensity) lines.push('attribute float aVal;');
    if (useRGB) lines.push('attribute vec3 aColor;');

    lines.push('uniform mat4 uViewProj;');
    if (isQuantized) {
        lines.push('uniform vec3 uBoundsMin;');
        lines.push('uniform vec3 uBoundsSize;');
    }
    if (useIntensity) {
        if (isQuantized) {
            lines.push('uniform float uValOffset;');
            lines.push('uniform float uValScale;');
        }
        lines.push('uniform float uVMin;');
        lines.push('uniform float uVMax;');
    }
    if (useFlat) {
        lines.push('uniform vec3 uFlatColor;');
    }
    if (isWorldSize) {
        lines.push('uniform float uWorldSizeFactor;');
    } else {
        lines.push('uniform float uPointSize;');
    }

    if (!useFlat && !useRgbFallback) {
        lines.push('varying vec3 vColor;');
    }

    if (useIntensity) {
        lines.push(`
vec3 getRainbowColor(float value_raw) {
    float range = uVMax - uVMin;
    float val = clamp((value_raw - uVMin) / range, 0.0, 1.0);
    float h = val * 0.6666;
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(vec3(h) + K.xyz) * 6.0 - K.www);
    return clamp(p - K.xxx, 0.0, 1.0);
}`);
    }

    lines.push('void main() {');
    if (isQuantized) {
        lines.push('    vec3 worldPos = uBoundsMin + aPos * uBoundsSize;');
    } else {
        lines.push('    vec3 worldPos = aPos;');
    }
    lines.push('    gl_Position = uViewProj * vec4(worldPos, 1.0);');

    if (useIntensity) {
        if (isQuantized) {
            lines.push('    vColor = getRainbowColor(uValOffset + aVal * uValScale);');
        } else {
            lines.push('    vColor = getRainbowColor(aVal);');
        }
    } else if (useRGB) {
        lines.push('    vColor = aColor;');
    }

    if (isWorldSize) {
        lines.push('    gl_PointSize = uWorldSizeFactor / max(abs(gl_Position.w), 0.0001);');
    } else {
        lines.push('    gl_PointSize = uPointSize;');
    }
    lines.push('}');
    return lines.join('\n');
}

function buildFragmentSource(colorMode: number, pointType: number, hasRGB: boolean): string {
    const useFlat = colorMode === 2;
    const isSphere = pointType >= 2;
    const useRgbFallback = colorMode === 1 && !hasRGB;
    const lines: string[] = [
        'precision mediump float;',
        'uniform float uEffectiveAlpha;',
    ];
    if (useFlat) {
        lines.push('uniform vec3 uFlatColor;');
    } else if (!useRgbFallback) {
        lines.push('varying vec3 vColor;');
    }

    lines.push('void main() {');
    if (isSphere) {
        lines.push('    vec2 coord = gl_PointCoord * 2.0 - 1.0;');
        lines.push('    if (dot(coord, coord) > 1.0) discard;');
    }
    if (useFlat) {
        lines.push('    gl_FragColor = vec4(uFlatColor, uEffectiveAlpha);');
    } else if (useRgbFallback) {
        lines.push('    gl_FragColor = vec4(0.0, 0.0, 0.0, uEffectiveAlpha);');
    } else {
        lines.push('    gl_FragColor = vec4(vColor, uEffectiveAlpha);');
    }
    lines.push('}');
    return lines.join('\n');
}

export class CloudShaderCache {
    private readonly gl: WebGLRenderingContext;
    private readonly programs = new Map<string, CloudProgramLocations>();
    private blitProgram: BlitProgramLocations | null = null;

    constructor(gl: WebGLRenderingContext) {
        this.gl = gl;
    }

    getProgram(
        colorMode: number,
        pointType: number,
        isQuantized: boolean,
        hasRGB: boolean,
    ): CloudProgramLocations | null {
        const cm = colorMode >= 1.5 ? 2 : colorMode >= 0.5 ? 1 : 0;
        const pt = pointType >= 1.5 ? 2 : pointType >= 0.5 ? 1 : 0;
        const key = `${cm}_${pt}_${isQuantized ? 1 : 0}_${hasRGB ? 1 : 0}`;
        const existing = this.programs.get(key);
        if (existing) return existing;

        const vertSrc = buildVertexSource(cm, pt, isQuantized, hasRGB);
        const fragSrc = buildFragmentSource(cm, pt, hasRGB);
        const program = linkProgram(this.gl, vertSrc, fragSrc);
        if (!program) return null;

        const locs: CloudProgramLocations = {
            program,
            aPos: this.gl.getAttribLocation(program, 'aPos'),
            aVal: this.gl.getAttribLocation(program, 'aVal'),
            aColor: this.gl.getAttribLocation(program, 'aColor'),
            uViewProj: this.gl.getUniformLocation(program, 'uViewProj'),
            uBoundsMin: this.gl.getUniformLocation(program, 'uBoundsMin'),
            uBoundsSize: this.gl.getUniformLocation(program, 'uBoundsSize'),
            uValOffset: this.gl.getUniformLocation(program, 'uValOffset'),
            uValScale: this.gl.getUniformLocation(program, 'uValScale'),
            uVMin: this.gl.getUniformLocation(program, 'uVMin'),
            uVMax: this.gl.getUniformLocation(program, 'uVMax'),
            uPointSize: this.gl.getUniformLocation(program, 'uPointSize'),
            uWorldSizeFactor: this.gl.getUniformLocation(program, 'uWorldSizeFactor'),
            uFlatColor: this.gl.getUniformLocation(program, 'uFlatColor'),
            uEffectiveAlpha: this.gl.getUniformLocation(program, 'uEffectiveAlpha'),
        };
        this.programs.set(key, locs);
        return locs;
    }

    getBlitProgram(): BlitProgramLocations | null {
        if (this.blitProgram) return this.blitProgram;
        const vertSrc = `
precision mediump float;
attribute vec2 aPos;
varying vec2 vUv;
void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;
        const fragSrc = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() {
    gl_FragColor = texture2D(uTex, vUv);
}`;
        const program = linkProgram(this.gl, vertSrc, fragSrc);
        if (!program) return null;
        this.blitProgram = {
            program,
            aPos: this.gl.getAttribLocation(program, 'aPos'),
            uTex: this.gl.getUniformLocation(program, 'uTex'),
        };
        return this.blitProgram;
    }

    dispose(): void {
        for (const loc of this.programs.values()) {
            this.gl.deleteProgram(loc.program);
        }
        this.programs.clear();
        if (this.blitProgram) {
            this.gl.deleteProgram(this.blitProgram.program);
            this.blitProgram = null;
        }
    }
}
