use std::io::{self, Read, Seek, SeekFrom};
use wasm_bindgen::{prelude::*, JsCast};

pub struct JsUint8ArrayReader {
    data: js_sys::Uint8Array,
    position: u64,
    len: u64,
}

impl JsUint8ArrayReader {
    pub fn new(data: js_sys::Uint8Array) -> Self {
        Self {
            len: data.length() as u64,
            data,
            position: 0,
        }
    }
}

struct JsChunk {
    data: js_sys::Uint8Array,
    start: u64,
    end: u64,
}

pub struct JsChunkedReader {
    chunks: Vec<JsChunk>,
    position: u64,
    len: u64,
    chunk_index: usize,
}

impl JsChunkedReader {
    pub fn new(chunks: js_sys::Array) -> Result<Self, JsError> {
        let mut js_chunks = Vec::with_capacity(chunks.length() as usize);
        let mut start = 0_u64;

        for value in chunks.iter() {
            let data: js_sys::Uint8Array = value
                .dyn_into()
                .map_err(|_| JsError::new("E57 chunk input must contain Uint8Array values"))?;
            let chunk_len = data.length() as u64;
            let end = start
                .checked_add(chunk_len)
                .ok_or_else(|| JsError::new("E57 chunk input is too large"))?;
            if chunk_len > 0 {
                js_chunks.push(JsChunk { data, start, end });
            }
            start = end;
        }

        Ok(Self {
            chunks: js_chunks,
            position: 0,
            len: start,
            chunk_index: 0,
        })
    }

    fn sync_chunk_index(&mut self) {
        if self.chunk_index < self.chunks.len() {
            let chunk = &self.chunks[self.chunk_index];
            if self.position >= chunk.start && self.position < chunk.end {
                return;
            }
        }

        let mut low = 0_usize;
        let mut high = self.chunks.len();
        while low < high {
            let mid = (low + high) / 2;
            if self.chunks[mid].end <= self.position {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        self.chunk_index = low;
    }
}

fn copy_from_uint8_array(
    source: &js_sys::Uint8Array,
    offset: u64,
    len: usize,
    target: &mut [u8],
) -> io::Result<()> {
    let start = u32::try_from(offset).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "E57 offset exceeds Uint8Array range",
        )
    })?;
    let len_u32 = u32::try_from(len).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "E57 read length exceeds Uint8Array range",
        )
    })?;
    let end = start
        .checked_add(len_u32)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "E57 read range overflow"))?;
    source.subarray(start, end).copy_to(&mut target[..len]);
    Ok(())
}

fn seek_position(current: u64, len: u64, pos: SeekFrom) -> io::Result<u64> {
    let target = match pos {
        SeekFrom::Start(offset) => i128::from(offset),
        SeekFrom::End(offset) => i128::from(len) + i128::from(offset),
        SeekFrom::Current(offset) => i128::from(current) + i128::from(offset),
    };
    if target < 0 {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cannot seek before start of E57 data",
        ))
    } else {
        Ok(target as u64)
    }
}

impl Read for JsUint8ArrayReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.len || buf.is_empty() {
            return Ok(0);
        }
        let available = usize::try_from((self.len - self.position).min(buf.len() as u64))
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "E57 read is too large"))?;
        copy_from_uint8_array(&self.data, self.position, available, buf)?;
        self.position += available as u64;
        Ok(available)
    }
}

impl Seek for JsUint8ArrayReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.position = seek_position(self.position, self.len, pos)?;
        Ok(self.position)
    }
}

impl Read for JsChunkedReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.position >= self.len || buf.is_empty() {
            return Ok(0);
        }

        self.sync_chunk_index();
        let mut written = 0_usize;
        while written < buf.len() && self.position < self.len {
            if self.chunk_index >= self.chunks.len() {
                break;
            }
            let chunk = &self.chunks[self.chunk_index];
            if self.position >= chunk.end {
                self.chunk_index += 1;
                continue;
            }
            if self.position < chunk.start {
                break;
            }

            let chunk_offset = self.position - chunk.start;
            let available =
                usize::try_from((chunk.end - self.position).min((buf.len() - written) as u64))
                    .map_err(|_| {
                        io::Error::new(io::ErrorKind::InvalidInput, "E57 chunk read is too large")
                    })?;
            copy_from_uint8_array(
                &chunk.data,
                chunk_offset,
                available,
                &mut buf[written..written + available],
            )?;
            self.position += available as u64;
            written += available;
            if self.position >= chunk.end {
                self.chunk_index += 1;
            }
        }

        Ok(written)
    }
}

impl Seek for JsChunkedReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.position = seek_position(self.position, self.len, pos)?;
        Ok(self.position)
    }
}
