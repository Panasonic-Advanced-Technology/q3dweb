/* tslint:disable */
/* eslint-disable */

export class Points {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly colors: Uint8Array;
    readonly hasColor: boolean;
    readonly hasIntensity: boolean;
    readonly intensities: Float32Array;
    readonly pointCount: number;
    readonly positions: Float32Array;
}

/**
 * Parse chunked E57 input without assembling one large JavaScript ArrayBuffer.
 */
export function parsePointChunksSampled(chunks: Array<any>, max_points: number, source_bytes: number, sampling_threshold_bytes: number): Points;

/**
 * Parse the first point cloud of an E57 file.
 * Returns recentered positions (xyz interleaved), colors (rgb 0..255 interleaved) and
 * intensities (0..255 normalized by the library based on the intensity limits).
 */
export function parsePoints(data: Uint8Array): Points;

/**
 * Parse the first point cloud of an E57 file with source-size aware sampling.
 */
export function parsePointsSampled(data: Uint8Array, max_points: number, source_bytes: number, sampling_threshold_bytes: number): Points;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_points_free: (a: number, b: number) => void;
    readonly parsePointChunksSampled: (a: any, b: number, c: number, d: number) => [number, number, number];
    readonly parsePoints: (a: any) => [number, number, number];
    readonly parsePointsSampled: (a: any, b: number, c: number, d: number) => [number, number, number];
    readonly points_colors: (a: number) => any;
    readonly points_hasColor: (a: number) => number;
    readonly points_hasIntensity: (a: number) => number;
    readonly points_intensities: (a: number) => any;
    readonly points_pointCount: (a: number) => number;
    readonly points_positions: (a: number) => any;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
