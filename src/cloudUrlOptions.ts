export interface CloudUrlOptions {
    pointCloudUrl?: string;
    filename?: string;
}

function firstParam(params: URLSearchParams, names: readonly string[]): string | undefined {
    for (const name of names) {
        const value = params.get(name)?.trim();
        if (value) return value;
    }
    return undefined;
}

export function parseCloudUrlOptions(params: URLSearchParams): CloudUrlOptions {
    return {
        pointCloudUrl: firstParam(params, ['cloudUrl', 'pointCloudUrl', 'fileUrl', 'url', 'src', 'file']),
        filename: firstParam(params, ['filename', 'fileName', 'name']),
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