/* @ts-self-types="./e57_wasm.d.ts" */

export class Points {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Points.prototype);
        obj.__wbg_ptr = ptr;
        PointsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PointsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_points_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get colors() {
        const ret = wasm.points_colors(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {boolean}
     */
    get hasColor() {
        const ret = wasm.points_hasColor(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    get hasIntensity() {
        const ret = wasm.points_hasIntensity(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {Float32Array}
     */
    get intensities() {
        const ret = wasm.points_intensities(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get pointCount() {
        const ret = wasm.points_pointCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    get positions() {
        const ret = wasm.points_positions(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) Points.prototype[Symbol.dispose] = Points.prototype.free;

/**
 * Parse chunked E57 input without assembling one large JavaScript ArrayBuffer.
 * @param {Array<any>} chunks
 * @param {number} max_points
 * @param {number} source_bytes
 * @param {number} sampling_threshold_bytes
 * @returns {Points}
 */
export function parsePointChunksSampled(chunks, max_points, source_bytes, sampling_threshold_bytes) {
    const ret = wasm.parsePointChunksSampled(chunks, max_points, source_bytes, sampling_threshold_bytes);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Points.__wrap(ret[0]);
}

/**
 * Parse the first point cloud of an E57 file.
 * Returns recentered positions (xyz interleaved), colors (rgb 0..255 interleaved) and
 * intensities (0..255 normalized by the library based on the intensity limits).
 * @param {Uint8Array} data
 * @returns {Points}
 */
export function parsePoints(data) {
    const ret = wasm.parsePoints(data);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Points.__wrap(ret[0]);
}

/**
 * Parse the first point cloud of an E57 file with source-size aware sampling.
 * @param {Uint8Array} data
 * @param {number} max_points
 * @param {number} source_bytes
 * @param {number} sampling_threshold_bytes
 * @returns {Points}
 */
export function parsePointsSampled(data, max_points, source_bytes, sampling_threshold_bytes) {
    const ret = wasm.parsePointsSampled(data, max_points, source_bytes, sampling_threshold_bytes);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Points.__wrap(ret[0]);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_960c155d3d49e4c2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_6b64449b9b9ed33c: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_get_unchecked_17f53dad852b9588: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_instanceof_Uint8Array_152ba1f289edcf3f: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_length_3d4ecd04bd8d22f1: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_9f1775224cf1d815: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_from_slice_b5ea43e23f6008c0: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_b6858b485924da4e: function(arg0, arg1) {
            const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_prototypesetcall_a6b02eb00b0f4ce2: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_subarray_f8ca46a25b1f5e0d: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./e57_wasm_bg.js": import0,
    };
}

const PointsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_points_free(ptr >>> 0, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('e57_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
