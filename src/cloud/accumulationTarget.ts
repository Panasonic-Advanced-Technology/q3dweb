import * as THREE from 'three';

function compileSimpleShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
    }
    return sh;
}

/**
 * Manages offscreen render targets for zero-flicker progressive point cloud accumulation.
 * Uses a dedicated WebGL2 MSAA FBO matching the default framebuffer's sample count,
 * seeded via a WebGL2-compliant fullscreen color+depth pass so multi-pass accumulation
 * matches single-pass direct rendering bit-for-bit with zero GL errors.
 */
export class AccumulationTarget {
    private accumRT: THREE.WebGLRenderTarget | null = null;
    private previewRT: THREE.WebGLRenderTarget | null = null;
    private accumFbo: WebGLFramebuffer | null = null;
    private previewFbo: WebGLFramebuffer | null = null;
    private msaaFbo: WebGLFramebuffer | null = null;
    private msaaColorRb: WebGLRenderbuffer | null = null;
    private msaaDepthRb: WebGLRenderbuffer | null = null;
    private width = 0;
    private height = 0;

    private seedProg: WebGLProgram | null = null;
    private seedColorLoc: WebGLUniformLocation | null = null;
    private seedDepthLoc: WebGLUniformLocation | null = null;
    private seedVao: WebGLVertexArrayObject | null = null;

    private blitScene: THREE.Scene | null = null;
    private blitCamera: THREE.OrthographicCamera | null = null;
    private blitMaterial: THREE.ShaderMaterial | null = null;
    private blitMesh: THREE.Mesh | null = null;

    getWidth(): number { return this.width; }
    getHeight(): number { return this.height; }
    isReady(): boolean { return this.accumRT !== null && this.previewRT !== null; }
    getPreviewFbo(): WebGLFramebuffer | null { return this.previewFbo; }
    getDrawFbo(): WebGLFramebuffer | null { return this.msaaFbo ?? this.accumFbo; }

    ensure(gl: WebGLRenderingContext, isWebGL2: boolean, width: number, height: number): boolean {
        if (this.accumRT && this.previewRT && this.width === width && this.height === height) {
            return true;
        }
        this.disposeTargets(gl);
        this.width = width;
        this.height = height;
        const baseOpts: THREE.RenderTargetOptions = {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            depthBuffer: true,
            stencilBuffer: false,
            samples: 0,
        };
        const accumOpts: THREE.RenderTargetOptions = isWebGL2
            ? { ...baseOpts, depthTexture: new THREE.DepthTexture(width, height, THREE.UnsignedIntType) }
            : baseOpts;

        this.accumRT = new THREE.WebGLRenderTarget(width, height, accumOpts);
        this.previewRT = new THREE.WebGLRenderTarget(width, height, baseOpts);
        this.ensureBlitResources();
        return true;
    }

    beginPreview(
        gl: WebGLRenderingContext,
        renderBaseScene: (target: THREE.WebGLRenderTarget | null) => void,
    ): WebGLFramebuffer | null {
        if (!this.previewRT) return null;
        renderBaseScene(this.previewRT);
        this.previewFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        return this.previewFbo;
    }

    /**
     * Render the base scene into accumRT and seed the WebGL2 MSAA accumulation FBO
     * using a compliant fullscreen quad pass (copies both color and depth with zero GL errors).
     */
    beginAccumulation(
        gl: WebGLRenderingContext,
        isWebGL2: boolean,
        renderer: THREE.WebGLRenderer,
        renderBaseScene: (target: THREE.WebGLRenderTarget | null) => void,
    ): void {
        if (!this.accumRT) return;
        renderBaseScene(this.accumRT);
        this.accumFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        if (!isWebGL2 || !this.accumFbo) return;

        const gl2 = gl as WebGL2RenderingContext;
        this.ensureMsaaFbo(gl2);
        if (!this.msaaFbo) return;

        gl2.bindFramebuffer(gl2.FRAMEBUFFER, this.accumFbo);
        const colorTex = gl2.getFramebufferAttachmentParameter(
            gl2.FRAMEBUFFER,
            gl2.COLOR_ATTACHMENT0,
            gl2.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
        ) as WebGLTexture | null;
        const depthObjType = gl2.getFramebufferAttachmentParameter(
            gl2.FRAMEBUFFER,
            gl2.DEPTH_ATTACHMENT,
            gl2.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE,
        );
        const depthTex = depthObjType === gl2.TEXTURE
            ? (gl2.getFramebufferAttachmentParameter(
                gl2.FRAMEBUFFER,
                gl2.DEPTH_ATTACHMENT,
                gl2.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
            ) as WebGLTexture | null)
            : null;

        this.seedMsaaFromTextures(gl2, colorTex, depthTex, renderer);
    }

    /** Resolve the multisample accumulation FBO into accumRT.texture (100% WebGL2 spec-compliant). */
    resolveAccumulation(gl: WebGLRenderingContext, isWebGL2: boolean, renderer: THREE.WebGLRenderer): void {
        if (!isWebGL2 || !this.msaaFbo || !this.accumFbo) return;
        const gl2 = gl as WebGL2RenderingContext;
        gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, this.msaaFbo);
        gl2.bindFramebuffer(gl2.DRAW_FRAMEBUFFER, this.accumFbo);
        gl2.blitFramebuffer(
            0, 0, this.width, this.height,
            0, 0, this.width, this.height,
            gl2.COLOR_BUFFER_BIT,
            gl2.NEAREST,
        );
        gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
        renderer.resetState();
    }

    presentAccumulation(renderer: THREE.WebGLRenderer): void {
        if (this.accumRT) this.present(renderer, this.accumRT);
    }

    presentPreview(renderer: THREE.WebGLRenderer): void {
        if (this.previewRT) this.present(renderer, this.previewRT);
    }

    dispose(gl: WebGLRenderingContext | null): void {
        this.disposeTargets(gl);
        if (gl) {
            if (this.seedProg) gl.deleteProgram(this.seedProg);
            if (this.seedVao && typeof (gl as WebGL2RenderingContext).deleteVertexArray === 'function') {
                (gl as WebGL2RenderingContext).deleteVertexArray(this.seedVao);
            }
        }
        this.seedProg = null;
        this.seedColorLoc = null;
        this.seedDepthLoc = null;
        this.seedVao = null;
        this.blitMaterial?.dispose();
        this.blitMesh?.geometry.dispose();
        this.blitMaterial = null;
        this.blitMesh = null;
        this.blitScene = null;
        this.blitCamera = null;
    }

    private ensureMsaaFbo(gl2: WebGL2RenderingContext): void {
        if (this.msaaFbo) return;
        const prevDraw = gl2.getParameter(gl2.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
        const defaultSamples = Number(gl2.getParameter(gl2.SAMPLES) || 0);
        const maxSamples = Number(gl2.getParameter(gl2.MAX_SAMPLES) || 0);
        gl2.bindFramebuffer(gl2.FRAMEBUFFER, prevDraw);

        const targetSamples = Math.min(defaultSamples, maxSamples, 4);
        if (targetSamples <= 1) return;

        const fbo = gl2.createFramebuffer();
        const colorRb = gl2.createRenderbuffer();
        const depthRb = gl2.createRenderbuffer();
        if (!fbo || !colorRb || !depthRb) {
            if (fbo) gl2.deleteFramebuffer(fbo);
            if (colorRb) gl2.deleteRenderbuffer(colorRb);
            if (depthRb) gl2.deleteRenderbuffer(depthRb);
            return;
        }

        gl2.bindFramebuffer(gl2.FRAMEBUFFER, fbo);
        gl2.bindRenderbuffer(gl2.RENDERBUFFER, colorRb);
        gl2.renderbufferStorageMultisample(gl2.RENDERBUFFER, targetSamples, gl2.RGBA8, this.width, this.height);
        gl2.framebufferRenderbuffer(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.RENDERBUFFER, colorRb);

        gl2.bindRenderbuffer(gl2.RENDERBUFFER, depthRb);
        gl2.renderbufferStorageMultisample(gl2.RENDERBUFFER, targetSamples, gl2.DEPTH_COMPONENT24, this.width, this.height);
        gl2.framebufferRenderbuffer(gl2.FRAMEBUFFER, gl2.DEPTH_ATTACHMENT, gl2.RENDERBUFFER, depthRb);

        const status = gl2.checkFramebufferStatus(gl2.FRAMEBUFFER);
        gl2.bindRenderbuffer(gl2.RENDERBUFFER, null);
        gl2.bindFramebuffer(gl2.FRAMEBUFFER, prevDraw);
        if (status === gl2.FRAMEBUFFER_COMPLETE) {
            this.msaaFbo = fbo;
            this.msaaColorRb = colorRb;
            this.msaaDepthRb = depthRb;
        } else {
            gl2.deleteFramebuffer(fbo);
            gl2.deleteRenderbuffer(colorRb);
            gl2.deleteRenderbuffer(depthRb);
        }
    }

    private ensureSeedProgram(gl2: WebGL2RenderingContext): boolean {
        if (this.seedProg) return true;
        const vertSrc = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
        const fragSrc = `#version 300 es
precision highp float;
uniform sampler2D uColor;
uniform sampler2D uDepth;
in vec2 vUv;
out vec4 outColor;
void main() {
    outColor = texture(uColor, vUv);
    gl_FragDepth = texture(uDepth, vUv).r;
}`;
        const vs = compileSimpleShader(gl2, gl2.VERTEX_SHADER, vertSrc);
        const fs = compileSimpleShader(gl2, gl2.FRAGMENT_SHADER, fragSrc);
        if (!vs || !fs) {
            if (vs) gl2.deleteShader(vs);
            if (fs) gl2.deleteShader(fs);
            return false;
        }
        const prog = gl2.createProgram();
        if (!prog) { gl2.deleteShader(vs); gl2.deleteShader(fs); return false; }
        gl2.attachShader(prog, vs);
        gl2.attachShader(prog, fs);
        gl2.linkProgram(prog);
        gl2.deleteShader(vs);
        gl2.deleteShader(fs);
        if (!gl2.getProgramParameter(prog, gl2.LINK_STATUS)) {
            gl2.deleteProgram(prog);
            return false;
        }
        this.seedProg = prog;
        this.seedColorLoc = gl2.getUniformLocation(prog, 'uColor');
        this.seedDepthLoc = gl2.getUniformLocation(prog, 'uDepth');
        this.seedVao = gl2.createVertexArray();
        return true;
    }

    private seedMsaaFromTextures(
        gl2: WebGL2RenderingContext,
        colorTex: WebGLTexture | null,
        depthTex: WebGLTexture | null,
        renderer: THREE.WebGLRenderer,
    ): void {
        if (!this.msaaFbo) return;
        renderer.resetState();
        gl2.bindFramebuffer(gl2.FRAMEBUFFER, this.msaaFbo);
        gl2.viewport(0, 0, this.width, this.height);
        gl2.disable(gl2.SCISSOR_TEST);
        gl2.disable(gl2.BLEND);

        if (colorTex && depthTex && this.ensureSeedProgram(gl2)) {
            gl2.enable(gl2.DEPTH_TEST);
            gl2.depthFunc(gl2.ALWAYS);
            gl2.depthMask(true);
            gl2.useProgram(this.seedProg);
            gl2.activeTexture(gl2.TEXTURE0);
            gl2.bindTexture(gl2.TEXTURE_2D, colorTex);
            gl2.uniform1i(this.seedColorLoc, 0);
            gl2.activeTexture(gl2.TEXTURE1);
            gl2.bindTexture(gl2.TEXTURE_2D, depthTex);
            gl2.uniform1i(this.seedDepthLoc, 1);
            gl2.bindVertexArray(this.seedVao);
            gl2.drawArrays(gl2.TRIANGLES, 0, 3);
            gl2.bindVertexArray(null);
            gl2.activeTexture(gl2.TEXTURE1);
            gl2.bindTexture(gl2.TEXTURE_2D, null);
            gl2.activeTexture(gl2.TEXTURE0);
            gl2.bindTexture(gl2.TEXTURE_2D, null);
            gl2.depthFunc(gl2.LEQUAL);
            gl2.useProgram(null);
        } else {
            gl2.clearColor(0, 0, 0, 1);
            gl2.clear(gl2.COLOR_BUFFER_BIT | gl2.DEPTH_BUFFER_BIT);
        }
        gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
        renderer.resetState();
    }

    private ensureBlitResources(): void {
        if (this.blitScene) return;
        this.blitScene = new THREE.Scene();
        this.blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.blitMaterial = new THREE.ShaderMaterial({
            uniforms: { uTex: { value: null } },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4(position.xy, 0.0, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D uTex;
                varying vec2 vUv;
                void main() {
                    gl_FragColor = texture2D(uTex, vUv);
                }
            `,
            depthTest: false,
            depthWrite: false,
            transparent: false,
        });
        this.blitMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMaterial);
        this.blitMesh.frustumCulled = false;
        this.blitScene.add(this.blitMesh);
    }

    private present(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): void {
        this.ensureBlitResources();
        this.blitMaterial!.uniforms.uTex.value = target.texture;
        renderer.setRenderTarget(null);
        renderer.render(this.blitScene!, this.blitCamera!);
    }

    private disposeTargets(gl: WebGLRenderingContext | null): void {
        if (gl) {
            if (this.msaaFbo) gl.deleteFramebuffer(this.msaaFbo);
            if (this.msaaColorRb) gl.deleteRenderbuffer(this.msaaColorRb);
            if (this.msaaDepthRb) gl.deleteRenderbuffer(this.msaaDepthRb);
        }
        this.msaaFbo = null;
        this.msaaColorRb = null;
        this.msaaDepthRb = null;
        this.accumRT?.depthTexture?.dispose();
        this.accumRT?.dispose();
        this.previewRT?.dispose();
        this.accumRT = null;
        this.previewRT = null;
        this.accumFbo = null;
        this.previewFbo = null;
        this.width = 0;
        this.height = 0;
    }
}
