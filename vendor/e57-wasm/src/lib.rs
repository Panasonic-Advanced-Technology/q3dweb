use e57::{CartesianCoordinate, E57Reader};
mod reader;
use reader::{JsChunkedReader, JsUint8ArrayReader};
use std::io::{Read, Seek};
use wasm_bindgen::prelude::*;

const DEFAULT_SAMPLING_THRESHOLD_BYTES: f64 = 2.0 * 1024.0 * 1024.0 * 1024.0;

fn safe_sampling_threshold_bytes(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        DEFAULT_SAMPLING_THRESHOLD_BYTES
    }
}

fn color_to_u8(value: f32) -> u8 {
    let scaled = (value * 255.0).round();
    if !scaled.is_finite() || scaled <= 0.0 {
        0
    } else if scaled >= 255.0 {
        255
    } else {
        scaled as u8
    }
}

#[wasm_bindgen]
pub struct Points {
    positions: Vec<f32>,
    colors: Vec<u8>,
    intensities: Vec<f32>,
    has_color: bool,
    has_intensity: bool,
}

#[wasm_bindgen]
impl Points {
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.positions.as_slice())
    }

    #[wasm_bindgen(getter)]
    pub fn colors(&self) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(self.colors.as_slice())
    }

    #[wasm_bindgen(getter)]
    pub fn intensities(&self) -> js_sys::Float32Array {
        js_sys::Float32Array::from(self.intensities.as_slice())
    }

    #[wasm_bindgen(getter, js_name = hasColor)]
    pub fn has_color(&self) -> bool {
        self.has_color
    }

    #[wasm_bindgen(getter, js_name = hasIntensity)]
    pub fn has_intensity(&self) -> bool {
        self.has_intensity
    }

    #[wasm_bindgen(getter, js_name = pointCount)]
    pub fn point_count(&self) -> usize {
        self.positions.len() / 3
    }
}

/// Parse the first point cloud of an E57 file.
/// Returns recentered positions (xyz interleaved), colors (rgb 0..255 interleaved) and
/// intensities (0..255 normalized by the library based on the intensity limits).
#[wasm_bindgen(js_name = parsePoints)]
pub fn parse_points(data: js_sys::Uint8Array) -> Result<Points, JsError> {
    parse_points_inner(
        JsUint8ArrayReader::new(data),
        None,
        0.0,
        DEFAULT_SAMPLING_THRESHOLD_BYTES,
    )
}

/// Parse the first point cloud of an E57 file with source-size aware sampling.
#[wasm_bindgen(js_name = parsePointsSampled)]
pub fn parse_points_sampled(
    data: js_sys::Uint8Array,
    max_points: usize,
    source_bytes: f64,
    sampling_threshold_bytes: f64,
) -> Result<Points, JsError> {
    parse_points_inner(
        JsUint8ArrayReader::new(data),
        Some(max_points),
        source_bytes,
        sampling_threshold_bytes,
    )
}

/// Parse chunked E57 input without assembling one large JavaScript ArrayBuffer.
#[wasm_bindgen(js_name = parsePointChunksSampled)]
pub fn parse_point_chunks_sampled(
    chunks: js_sys::Array,
    max_points: usize,
    source_bytes: f64,
    sampling_threshold_bytes: f64,
) -> Result<Points, JsError> {
    parse_points_inner(
        JsChunkedReader::new(chunks)?,
        Some(max_points),
        source_bytes,
        sampling_threshold_bytes,
    )
}

fn parse_points_inner<R>(
    input: R,
    max_points: Option<usize>,
    source_bytes: f64,
    sampling_threshold_bytes: f64,
) -> Result<Points, JsError>
where
    R: Read + Seek,
{
    let mut reader = E57Reader::new(input).map_err(|e| JsError::new(&format!("{e}")))?;

    let clouds = reader.pointclouds();
    let first = clouds
        .into_iter()
        .next()
        .ok_or_else(|| JsError::new("E57 file contains no point clouds"))?;

    let has_color = first.has_color();
    let has_intensity = first.has_intensity();
    let record_count = first.records as usize;
    let point_ratio = match max_points {
        Some(limit) => {
            let safe_limit = limit.max(1);
            if record_count > safe_limit {
                record_count.div_ceil(safe_limit)
            } else {
                1
            }
        }
        None => 1,
    };
    let source_threshold = safe_sampling_threshold_bytes(sampling_threshold_bytes);
    let source_ratio = if source_bytes.is_finite() && source_bytes > source_threshold {
        (source_bytes / source_threshold).ceil() as usize
    } else {
        1
    };
    let sample_ratio = point_ratio.max(source_ratio).max(1);

    let iter = reader
        .pointcloud_simple(&first)
        .map_err(|e| JsError::new(&format!("{e}")))?;

    let estimated = record_count.div_ceil(sample_ratio);
    let mut positions = Vec::with_capacity(estimated * 3);
    let mut colors: Vec<u8> = if has_color {
        Vec::with_capacity(estimated * 3)
    } else {
        Vec::new()
    };
    let mut intensities: Vec<f32> = Vec::with_capacity(estimated);
    let mut sum_x = 0.0_f64;
    let mut sum_y = 0.0_f64;
    let mut sum_z = 0.0_f64;

    for (raw_index, point) in iter.enumerate() {
        if raw_index % sample_ratio != 0 {
            continue;
        }
        let p = point.map_err(|e| JsError::new(&format!("{e}")))?;
        match p.cartesian {
            CartesianCoordinate::Valid { x, y, z } => {
                positions.push(x as f32);
                positions.push(y as f32);
                positions.push(z as f32);
                sum_x += x;
                sum_y += y;
                sum_z += z;
            }
            _ => continue,
        }
        if has_color {
            match p.color {
                Some(c) => {
                    colors.push(color_to_u8(c.red));
                    colors.push(color_to_u8(c.green));
                    colors.push(color_to_u8(c.blue));
                }
                None => {
                    colors.push(0);
                    colors.push(0);
                    colors.push(0);
                }
            }
        }
        if has_intensity {
            intensities.push(p.intensity.unwrap_or(0.0) * 255.0);
        } else {
            intensities.push(0.0);
        }
    }

    let point_count = positions.len() / 3;
    if point_count > 0 {
        let inv_count = 1.0 / point_count as f64;
        let center_x = (sum_x * inv_count) as f32;
        let center_y = (sum_y * inv_count) as f32;
        let center_z = (sum_z * inv_count) as f32;
        for coords in positions.chunks_exact_mut(3) {
            coords[0] -= center_x;
            coords[1] -= center_y;
            coords[2] -= center_z;
        }
    }

    Ok(Points {
        positions,
        colors,
        intensities,
        has_color,
        has_intensity,
    })
}
