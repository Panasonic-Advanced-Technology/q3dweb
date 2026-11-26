use crate::reader::{JsChunkedReader, JsUint8ArrayReader};
use crate::{color_to_u8, safe_sampling_threshold_bytes, Points};
use e57::{CartesianCoordinate, E57Reader, PointCloudReaderSimple};
use std::io::{self, Read, Seek, SeekFrom};
use wasm_bindgen::prelude::*;

enum E57InputReader {
    Single(JsUint8ArrayReader),
    Chunked(JsChunkedReader),
}

impl Read for E57InputReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            E57InputReader::Single(r) => r.read(buf),
            E57InputReader::Chunked(r) => r.read(buf),
        }
    }
}

impl Seek for E57InputReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        match self {
            E57InputReader::Single(r) => r.seek(pos),
            E57InputReader::Chunked(r) => r.seek(pos),
        }
    }
}

pub(crate) struct StreamParserCore<R: Read + Seek + 'static> {
    // Field drop order matters: iter borrows reader_ptr, and Drop explicitly releases iter first.
    iter: Option<PointCloudReaderSimple<'static, R>>,
    reader_ptr: *mut E57Reader<R>,
    positions: Vec<f32>,
    colors: Vec<u8>,
    intensities: Vec<f32>,
    has_color: bool,
    has_intensity: bool,
    sample_ratio: usize,
    raw_index: usize,
    total_records: usize,
    done: bool,
}

impl<R: Read + Seek + 'static> StreamParserCore<R> {
    pub(crate) fn new(
        input: R,
        max_points: Option<usize>,
        source_bytes: f64,
        sampling_threshold_bytes: f64,
    ) -> Result<Self, String> {
        let reader = E57Reader::new(input).map_err(|e| format!("{e}"))?;
        let first = reader
            .pointclouds()
            .into_iter()
            .next()
            .ok_or_else(|| "E57 file contains no point clouds".to_string())?;

        let has_color = first.has_color();
        let has_intensity = first.has_intensity();
        let total_records = first.records as usize;
        let point_ratio = match max_points {
            Some(limit) => {
                let safe_limit = limit.max(1);
                if total_records > safe_limit {
                    total_records.div_ceil(safe_limit)
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

        let reader_ptr = Box::into_raw(Box::new(reader));
        // SAFETY: reader_ptr is heap-pinned for the lifetime of StreamParserCore and never accessed
        // again until iter is dropped in close_reader().
        let iter_result = unsafe { (&mut *reader_ptr).pointcloud_simple(&first) };
        let iter = match iter_result {
            Ok(it) => it,
            Err(e) => {
                unsafe {
                    drop(Box::from_raw(reader_ptr));
                }
                return Err(format!("{e}"));
            }
        };

        let estimated = total_records.div_ceil(sample_ratio);
        let positions = Vec::with_capacity(estimated * 3);
        let colors = if has_color {
            Vec::with_capacity(estimated * 3)
        } else {
            Vec::new()
        };
        let intensities = Vec::with_capacity(estimated);

        Ok(Self {
            iter: Some(iter),
            reader_ptr,
            positions,
            colors,
            intensities,
            has_color,
            has_intensity,
            sample_ratio,
            raw_index: 0,
            total_records,
            done: false,
        })
    }

    pub(crate) fn step(&mut self, max_records: usize) -> Result<bool, String> {
        if self.done {
            return Ok(true);
        }
        let limit = max_records.max(1);
        let sample_ratio = self.sample_ratio;
        let has_color = self.has_color;
        let has_intensity = self.has_intensity;

        if let Some(iter) = self.iter.as_mut() {
            for _ in 0..limit {
                match iter.next() {
                    None => {
                        self.done = true;
                        break;
                    }
                    Some(point) => {
                        let raw_index = self.raw_index;
                        self.raw_index = raw_index.saturating_add(1);
                        if raw_index % sample_ratio != 0 {
                            continue;
                        }
                        let p = point.map_err(|e| format!("{e}"))?;
                        match p.cartesian {
                            CartesianCoordinate::Valid { x, y, z } => {
                                self.positions.push(x as f32);
                                self.positions.push(y as f32);
                                self.positions.push(z as f32);
                            }
                            _ => continue,
                        }
                        if has_color {
                            match p.color {
                                Some(c) => {
                                    self.colors.push(color_to_u8(c.red));
                                    self.colors.push(color_to_u8(c.green));
                                    self.colors.push(color_to_u8(c.blue));
                                }
                                None => {
                                    self.colors.push(0);
                                    self.colors.push(0);
                                    self.colors.push(0);
                                }
                            }
                        }
                        if has_intensity {
                            self.intensities.push(p.intensity.unwrap_or(0.0) * 255.0);
                        } else {
                            self.intensities.push(0.0);
                        }
                    }
                }
            }
        } else {
            self.done = true;
        }

        if self.done {
            self.close_reader();
        }
        Ok(self.done)
    }

    pub(crate) fn processed_records(&self) -> usize {
        self.raw_index
    }

    pub(crate) fn total_records(&self) -> usize {
        self.total_records
    }

    pub(crate) fn take_points(&mut self) -> Points {
        self.done = true;
        self.close_reader();
        Points::new(
            std::mem::take(&mut self.positions),
            std::mem::take(&mut self.colors),
            std::mem::take(&mut self.intensities),
            self.has_color,
            self.has_intensity,
        )
    }

    fn close_reader(&mut self) {
        self.iter = None;
        if !self.reader_ptr.is_null() {
            unsafe {
                drop(Box::from_raw(self.reader_ptr));
            }
            self.reader_ptr = std::ptr::null_mut();
        }
    }
}

impl<R: Read + Seek + 'static> Drop for StreamParserCore<R> {
    fn drop(&mut self) {
        self.close_reader();
    }
}

/// Incremental E57 parser that decodes bounded batches per call so JavaScript can yield
/// to the browser event loop and report accurate progress without freezing the UI.
#[wasm_bindgen]
pub struct E57StreamParser {
    core: StreamParserCore<E57InputReader>,
}

#[wasm_bindgen]
impl E57StreamParser {
    #[wasm_bindgen(js_name = fromChunks)]
    pub fn from_chunks(
        chunks: js_sys::Array,
        max_points: usize,
        source_bytes: f64,
        sampling_threshold_bytes: f64,
    ) -> Result<E57StreamParser, JsError> {
        let reader = JsChunkedReader::new(chunks)?;
        let core = StreamParserCore::new(
            E57InputReader::Chunked(reader),
            Some(max_points),
            source_bytes,
            sampling_threshold_bytes,
        )
        .map_err(|e| JsError::new(&e))?;
        Ok(E57StreamParser { core })
    }

    #[wasm_bindgen(js_name = fromUint8Array)]
    pub fn from_uint8_array(
        data: js_sys::Uint8Array,
        max_points: usize,
        source_bytes: f64,
        sampling_threshold_bytes: f64,
    ) -> Result<E57StreamParser, JsError> {
        let reader = JsUint8ArrayReader::new(data);
        let core = StreamParserCore::new(
            E57InputReader::Single(reader),
            Some(max_points),
            source_bytes,
            sampling_threshold_bytes,
        )
        .map_err(|e| JsError::new(&e))?;
        Ok(E57StreamParser { core })
    }

    pub fn step(&mut self, max_records: usize) -> Result<bool, JsError> {
        self.core.step(max_records).map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(getter, js_name = processedRecords)]
    pub fn processed_records(&self) -> usize {
        self.core.processed_records()
    }

    #[wasm_bindgen(getter, js_name = totalRecords)]
    pub fn total_records(&self) -> usize {
        self.core.total_records()
    }

    #[wasm_bindgen(js_name = takePoints)]
    pub fn take_points(&mut self) -> Points {
        self.core.take_points()
    }
}
