/**
 * Settings panel UI helper functions.
 * Extracted from viewer.ts for modularity.
 */

import * as THREE from 'three';
import { NativeCloudItem } from '../items/NativeCloudItem';
import type { ColorMode } from '../utils/realtimeTypes';
import { createMaterialMenuSelect } from './materialSelect';

// ========== Primitive UI builders ==========

export function attachMaterialRipple(element: HTMLElement): void {
    if (element.querySelector('md-ripple')) return;
    const ripple = document.createElement('md-ripple');
    ripple.setAttribute('aria-hidden', 'true');
    element.prepend(ripple);
}

export function setMaterialButtonLabel(button: HTMLButtonElement, label: string): void {
    let labelEl = button.querySelector('[data-role="material-button-label"]') as HTMLElement | null;
    if (!labelEl) {
        button.textContent = '';
        attachMaterialRipple(button);
        labelEl = document.createElement('span');
        labelEl.setAttribute('data-role', 'material-button-label');
        labelEl.className = 'q3d-material-button-label';
        button.appendChild(labelEl);
    }
    labelEl.textContent = label;
}

export function makeLabel(text: string): HTMLElement {
    const lbl = document.createElement('div');
    lbl.textContent = text;
    lbl.className = 'q3d-setting-label md-typescale-label-medium';
    return lbl;
}

export function makeStaticValue(text: string): HTMLElement {
    const v = document.createElement('div');
    v.textContent = text;
    v.className = 'q3d-setting-static md-typescale-body-medium';
    return v;
}

export function makeTextInput(defaultVal: string, onChange: (val: string) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultVal;
    input.className = 'q3d-setting-control md-typescale-body-medium';
    input.onchange = () => onChange(input.value);
    return input;
}

export function makeSelectInput(
    options: Array<{ label: string; value: string }>,
    selectedValue: string,
    onChange: (value: string) => void,
): HTMLElement {
    return createMaterialMenuSelect(options, selectedValue, onChange).wrapper;
}

export function makeNumberInput(
    value: number, min: number, max: number, step: number,
    onChange: (v: number) => void,
): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = value.toString();
    input.min = min.toString(); input.max = max.toString(); input.step = step.toString();
    input.className = 'q3d-setting-control md-typescale-body-medium';
    input.onchange = () => { const v = parseFloat(input.value); if (!isNaN(v)) onChange(v); };
    return input;
}

export function makeRangeInput(
    value: number, min: number, max: number, step: number,
    onChange: (v: number) => void,
): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'q3d-setting-range';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min.toString();
    slider.max = max.toString();
    slider.step = step.toString();
    slider.value = value.toString();
    slider.className = 'q3d-setting-range-input';

    const precision = step >= 1 ? 0 : Math.max(1, Math.ceil(-Math.log10(step)));
    const valueText = document.createElement('span');
    valueText.className = 'q3d-setting-range-value md-typescale-label-medium';

    const publish = () => {
        const v = parseFloat(slider.value);
        if (Number.isNaN(v)) return;
        valueText.textContent = v.toFixed(precision);
        onChange(v);
    };

    publish();
    slider.oninput = publish;
    slider.onchange = publish;

    wrap.appendChild(slider);
    wrap.appendChild(valueText);
    return wrap;
}

export function makeCheckbox(
    label: string, checked: boolean, onChange: (v: boolean) => void,
): HTMLElement {
    const row = document.createElement('div');
    row.className = 'q3d-setting-checkbox md-typescale-body-medium';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = checked;
    cb.onchange = () => onChange(cb.checked);
    const lbl = document.createElement('label');
    lbl.textContent = label;
    row.appendChild(cb); row.appendChild(lbl);
    return row;
}

export function makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'q3d-setting-button md-typescale-label-large';
    setMaterialButtonLabel(btn, label);
    btn.addEventListener('click', onClick);
    return btn;
}

// ========== Cloud item settings ==========

/** Build the per-item settings panel for CloudItem (shader-material based). */
export function buildCloudItemSettings(
    item: THREE.Object3D,
    mat: any,
    container: HTMLElement,
    pixelRatio: number,
    onRender: () => void,
): void {
    const geometry   = (item as any).geometry as THREE.BufferGeometry | undefined;
    const pointCount = geometry?.getAttribute('position')?.count;
    const pointTypeUniform = mat.uniforms.pointType;
    const pointSizeUniform = mat.uniforms.pointSize;
    const syncPointTransparency = () => {
        const alpha = mat.uniforms.alpha?.value ?? 1;
        const pointType = pointTypeUniform?.value ?? 0;
        mat.transparent = alpha < 0.99 || pointType > 1.5;
        mat.depthWrite = alpha >= 0.99 && pointType <= 1.5;
    };

    const isPixelPointType   = (value: number) => value < 0.5;
    const getSizeLabelText   = () => !pointTypeUniform ? 'Size:' :
        (isPixelPointType(pointTypeUniform.value) ? 'Size (pixel):' : 'Size (cm):');
    const getPointSizeInput  = () => {
        if (!pointSizeUniform) return 0;
        return (pointTypeUniform && isPixelPointType(pointTypeUniform.value))
            ? pointSizeUniform.value / pixelRatio : pointSizeUniform.value;
    };
    const setStoredPointSize = (v: number) => {
        if (!pointSizeUniform) return;
        pointSizeUniform.value = (pointTypeUniform && isPixelPointType(pointTypeUniform.value))
            ? v * pixelRatio : v;
    };

    let sizeLabel: HTMLElement | null = null;
    let sizeInput: HTMLInputElement | null = null;

    if (typeof pointCount === 'number') {
        container.appendChild(makeLabel('Points:'));
        container.appendChild(makeStaticValue(`${pointCount.toLocaleString()} pts`));
    }

    if (pointTypeUniform) {
        container.appendChild(makeLabel('Point Type:'));
        container.appendChild(makeSelectInput(
            [{ label: 'pixels', value: '0' }, { label: 'flat squares', value: '1' }, { label: 'spheres', value: '2' }],
            String(pointTypeUniform.value),
            (value) => {
                const next = parseInt(value, 10);
                const wasPixel = isPixelPointType(pointTypeUniform.value);
                const willPixel = isPixelPointType(next);
                if (pointSizeUniform) {
                    if (wasPixel && !willPixel) pointSizeUniform.value /= pixelRatio;
                    else if (!wasPixel && willPixel) pointSizeUniform.value *= pixelRatio;
                }
                pointTypeUniform.value = next;
                syncPointTransparency();
                if (sizeLabel) sizeLabel.textContent = getSizeLabelText();
                if (sizeInput) sizeInput.value = getPointSizeInput().toString();
                mat.needsUpdate = true; onRender();
            },
        ));
    }

    if (pointSizeUniform) {
        sizeLabel = makeLabel(getSizeLabelText());
        container.appendChild(sizeLabel);
        sizeInput = makeNumberInput(getPointSizeInput(), 0, 100, 1, (v) => {
            setStoredPointSize(v); mat.needsUpdate = true; onRender();
        });
        container.appendChild(sizeInput);
    }

    if (mat.uniforms.alpha) {
        container.appendChild(makeLabel('Alpha:'));
        container.appendChild(makeRangeInput(mat.uniforms.alpha.value, 0, 1, 0.01, (v) => {
            mat.uniforms.alpha.value = v;
            syncPointTransparency();
            mat.needsUpdate = true; onRender();
        }));
    }

    if (mat.uniforms.colorMode) {
        container.appendChild(makeLabel('Color Mode:'));
        container.appendChild(makeSelectInput(
            [{ label: 'Intensity', value: '0' }, { label: 'RGB', value: '1' }, { label: 'Flat', value: '2' }],
            String(mat.uniforms.colorMode.value),
            (value) => { mat.uniforms.colorMode.value = parseInt(value, 10); mat.needsUpdate = true; onRender(); },
        ));
    }

    if (mat.uniforms.vmin && mat.uniforms.vmax) {
        container.appendChild(makeLabel('Vmin:'));
        container.appendChild(makeNumberInput(mat.uniforms.vmin.value, -100000, 100000, 1, (v) => {
            mat.uniforms.vmin.value = v; mat.needsUpdate = true; onRender();
        }));
        container.appendChild(makeLabel('Vmax:'));
        container.appendChild(makeNumberInput(mat.uniforms.vmax.value, -100000, 100000, 1, (v) => {
            mat.uniforms.vmax.value = v; mat.needsUpdate = true; onRender();
        }));
    }
}

// ========== NativeCloudItem settings ==========

/** Build the per-item settings panel for NativeCloudItem (WebGL-backend based). */
export function buildNativeCloudItemSettings(
    item: NativeCloudItem,
    container: HTMLElement,
    onRender: () => void,
    onColorModeChange?: (mode: ColorMode) => void,
): void {
    container.appendChild(makeLabel('Size:'));
    container.appendChild(makeNumberInput(item.getPointSize(), 0, 100, 1, v => {
        item.setPointSize(v); onRender();
    }));

    container.appendChild(makeLabel('Alpha:'));
    container.appendChild(makeRangeInput(1, 0, 1, 0.01, v => {
        item.setAlpha(v); onRender();
    }));

    container.appendChild(makeLabel('Color Mode:'));
    container.appendChild(makeSelectInput(
        [{ label: 'Intensity', value: 'I' }, { label: 'RGB', value: 'RGB' }, { label: 'Flat', value: 'FLAT' }],
        'FLAT',
        v => {
            item.setColorMode(v as ColorMode);
            onColorModeChange?.(v as ColorMode);
            onRender();
        },
    ));

    container.appendChild(makeLabel('Vmin:'));
    container.appendChild(makeNumberInput(item.getVmin(), -100000, 100000, 1, v => {
        item.setVmin(v); onRender();
    }));

    container.appendChild(makeLabel('Vmax:'));
    container.appendChild(makeNumberInput(item.getVmax(), -100000, 100000, 1, v => {
        item.setVmax(v); onRender();
    }));
}

// ========== Film Maker settings panel builder ==========

export interface FilmMakerUIContext {
    filmMaker: any; // FilmMaker instance
    isPlayingFilm: boolean;
    isRecordingFilm: boolean;
    videoFileName: string;
    videoMimeType: string;
    addKeyFrameFromCamera(): void;
    deleteCurrentKeyFrame(): void;
    togglePlayback(): void;
    downloadLastRecording(): boolean;
    selectKeyFrame(i: number): void;
    jumpToKeyFrame(i: number): void;
    refreshFilmMakerList(): void;
    setIsRecordingFilm(v: boolean): void;
    setVideoFileName(v: string): void;
    setVideoMimeType(v: string): void;
    setLinVel(i: number, v: number): void;
    setAngVel(i: number, v: number): void;
    setStopTime(i: number, v: number): void;
}

export interface FilmMakerUIRefs {
    listEl: HTMLElement;
    playBtn: HTMLButtonElement;
    spinLin: HTMLInputElement;
    spinAng: HTMLInputElement;
    spinStop: HTMLInputElement;
}

export function buildFilmMakerSettings(
    container: HTMLElement,
    ctx: FilmMakerUIContext,
): FilmMakerUIRefs {
    container.appendChild(makeButton('Add Key Frame (Space)', () => ctx.addKeyFrameFromCamera()));
    container.appendChild(makeButton('Delete Key Frame (Delete)', () => ctx.deleteCurrentKeyFrame()));

    const playBtn = makeButton('Play', () => ctx.togglePlayback());
    container.appendChild(playBtn);

    container.appendChild(makeCheckbox('Record', ctx.isRecordingFilm, (v) => ctx.setIsRecordingFilm(v)));
    container.appendChild(makeLabel('Video File Name:'));
    container.appendChild(makeTextInput(ctx.videoFileName, (val) => ctx.setVideoFileName(val)));
    container.appendChild(makeLabel('Codec (MediaRecorder mimeType):'));
    const codecs = ['video/mp4;codecs=h264', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm;codecs=h264'];
    container.appendChild(makeSelectInput(codecs.map(c => ({ label: c, value: c })), ctx.videoMimeType, (val) => ctx.setVideoMimeType(val)));
    container.appendChild(makeButton('Download Last Recording', () => ctx.downloadLastRecording()));

    container.appendChild(makeLabel('Key Frames (double-click to jump):'));
    const list = document.createElement('div');
    list.className = 'q3d-keyframe-list';
    container.appendChild(list);

    container.appendChild(makeLabel('Linear Velocity (m/s):'));
    const spinLin = makeNumberInput(10, 0, 1000, 0.1, (v) => ctx.setLinVel(ctx.filmMaker.currentIndex, v));
    container.appendChild(spinLin);

    container.appendChild(makeLabel('Angular Velocity (deg/s):'));
    const spinAng = makeNumberInput(60, 0, 360, 0.1, (v) => ctx.setAngVel(ctx.filmMaker.currentIndex, v * Math.PI / 180));
    container.appendChild(spinAng);

    container.appendChild(makeLabel('Stop Time (s):'));
    const spinStop = makeNumberInput(0, 0, 100, 0.1, (v) => ctx.setStopTime(ctx.filmMaker.currentIndex, v));
    container.appendChild(spinStop);

    return { listEl: list, playBtn, spinLin, spinAng, spinStop };
}

export function refreshFilmMakerList(
    listEl: HTMLElement,
    filmMaker: any,
    onSelect: (i: number) => void,
    onJump: (i: number) => void,
): void {
    listEl.innerHTML = '';
    const sel = filmMaker.currentIndex;
    filmMaker.keyFrames.forEach((_kf: any, i: number) => {
        const row = document.createElement('div');
        row.textContent = `Frame ${i + 1}`;
        row.className = 'q3d-keyframe-row md-typescale-body-medium';
        row.dataset.index = String(i);
        row.style.cssText = `${
            i === sel ? 'background:#a33;color:#fff;' : 'background:#252525;color:#eee;'
        }`;
        row.addEventListener('click', () => onSelect(i));
        row.addEventListener('dblclick', () => onJump(i));
        listEl.appendChild(row);
    });
}

export function syncFilmMakerSpinboxes(
    filmMaker: any,
    spinLin: HTMLInputElement | null,
    spinAng: HTMLInputElement | null,
    spinStop: HTMLInputElement | null,
): void {
    const kf = filmMaker.keyFrames[filmMaker.currentIndex];
    if (!kf) return;
    if (spinLin) spinLin.value = kf.linVel.toString();
    if (spinAng) spinAng.value = (kf.angVel * 180 / Math.PI).toFixed(2);
    if (spinStop) spinStop.value = kf.stopTime.toString();
}
