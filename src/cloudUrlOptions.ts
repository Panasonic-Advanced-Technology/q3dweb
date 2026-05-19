export interface CloudUrlOptions {
    pointCloudUrl?: string;
    filename?: string;
    maxPoints?: number;
    pointSize?: number;
    pointType?: 'PIXEL' | 'SQUARE' | 'SPHERE';
    alpha?: number;
    colorMode?: 'I' | 'RGB' | 'FLAT';
    vmin?: number;
    vmax?: number;
    backgroundColor?: string;
    showCenter?: boolean;
}

function firstParam(params: URLSearchParams, names: readonly string[]): string | undefined {
    for (const name of names) {
        const value = params.get(name)?.trim();
        if (value) return value;
    }
    return undefined;
}

function numberParam(params: URLSearchParams, names: readonly string[], min = -Infinity, max = Infinity): number | undefined {
    const value = firstParam(params, names);
    if (!value) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return undefined;
    return parsed;
}

function positiveIntegerParam(params: URLSearchParams, names: readonly string[]): number | undefined {
    const value = numberParam(params, names, 1);
    return value === undefined ? undefined : Math.floor(value);
}

function booleanParam(params: URLSearchParams, names: readonly string[]): boolean | undefined {
    const value = firstParam(params, names)?.toLowerCase();
    if (!value) return undefined;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return undefined;
}

function pointTypeParam(params: URLSearchParams): CloudUrlOptions['pointType'] {
    const value = firstParam(params, ['pointType', 'point_type', 'cloudPointType'])?.toLowerCase();
    if (!value) return undefined;
    if (['pixel', 'pixels'].includes(value)) return 'PIXEL';
    if (['square', 'squares', 'flat_square', 'flat_squares'].includes(value)) return 'SQUARE';
    if (['sphere', 'spheres'].includes(value)) return 'SPHERE';
    return undefined;
}

function colorModeParam(params: URLSearchParams): CloudUrlOptions['colorMode'] {
    const value = firstParam(params, ['colorMode', 'color_mode', 'cloudColorMode'])?.toLowerCase();
    if (!value) return undefined;
    if (['i', 'intensity'].includes(value)) return 'I';
    if (value === 'rgb') return 'RGB';
    if (['flat', 'flatcolor', 'flat_color'].includes(value)) return 'FLAT';
    return undefined;
}

export function parseCloudUrlOptions(params: URLSearchParams): CloudUrlOptions {
    return {
        pointCloudUrl: firstParam(params, ['cloudUrl', 'pointCloudUrl', 'fileUrl', 'url', 'src', 'file']),
        filename: firstParam(params, ['filename', 'fileName', 'name']),
        maxPoints: positiveIntegerParam(params, ['maxPoints', 'max_points', 'maxVisualPoints', 'max_points_visual', 'maxPointCount']),
        pointSize: numberParam(params, ['pointSize', 'point_size', 'size'], 0, 100),
        pointType: pointTypeParam(params),
        alpha: numberParam(params, ['alpha', 'opacity'], 0, 1),
        colorMode: colorModeParam(params),
        vmin: numberParam(params, ['vmin', 'valueMin', 'intensityMin', 'min']),
        vmax: numberParam(params, ['vmax', 'valueMax', 'intensityMax', 'max']),
        backgroundColor: firstParam(params, ['backgroundColor', 'background', 'bgColor', 'bg']),
        showCenter: booleanParam(params, ['showCenter', 'show_center', 'centerPoint']),
    };
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function inferPointCloudFilename(sourceUrl: string): string | undefined {
    try {
        const base = globalThis.location?.href ?? 'http://localhost/';
        const url = new URL(sourceUrl, base);
        const lastSegment = safeDecode(url.pathname.split('/').filter(Boolean).pop() ?? '');
        return lastSegment || undefined;
    } catch {
        const path = sourceUrl.split(/[?#]/, 1)[0];
        const lastSegment = path.split('/').filter(Boolean).pop();
        return lastSegment ? safeDecode(lastSegment) : undefined;
    }
}