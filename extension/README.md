# q3dviewer

q3dviewer is a VS Code extension for viewing point cloud files (`.pcd`, `.ply`, `.las`, `.laz`, `.e57`) in 3D.
It embeds a q3dweb-based WebView so you can inspect point clouds directly inside the editor by rotating, panning, and zooming.

## Usage

1. Install this extension in VS Code.
2. Open a `.pcd`, `.ply`, `.las`, `.laz`, or `.e57` file.
3. If the file does not open automatically, use "Reopen With..." and select
   **Point Cloud Viewer**.
4. Press `M` to show / hide the settings panel.

### 1. Basic Controls

After you load a point cloud by drag and drop, you can inspect it with the mouse and keyboard.

![drag_pcd.gif](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/3953399/555fee3d-8ec3-4fee-80f6-767844c003da.gif)

| Input | Action |
| --- | --- |
| Right drag | Rotate |
| Left drag | Pan |
| Mouse wheel | Zoom |
| `W` `A` `S` `D` `Z` `X` | Move camera |
| `Shift` + move keys | Faster movement |
| `Ctrl + Left Click` | Measure distance between two points |
| `Ctrl + Right Click` | Reset measurement points |
| `M` | Toggle settings menu (preserves the active tab) |
| `Space` (Film Maker tab) | Add key frame from current camera |
| `Delete` (Film Maker tab) | Remove current key frame |

### 2. LAS / LAZ Map Overlay

If a LAS or LAZ file includes coordinate reference system information, q3dweb can read it and overlay the point cloud on map tiles.

The following map sources are available by default.

- OpenStreetMap
- GSI Standard Map
- GSI Pale Map
- GSI Seamless Aerial Photo
- GSI Blank Map

<img width="528" height="327" alt="map" src="https://github.com/user-attachments/assets/1dcf11f2-7fa0-466c-95f1-dee6a25ff064" />

### 3. Creating Demo Videos

q3dweb also includes a Film Maker workflow for creating camera fly-throughs. Open the Film Maker tab in the settings panel, save camera positions as key frames, and preview the interpolated camera motion.

You can then record and download the playback as a video file. The default setting targets MP4/H.264 when the browser supports it and otherwise falls back to another MediaRecorder-compatible format.

![firm_l.gif](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/3953399/15a0b61b-453d-4579-ba71-665d21289389.gif)

## Supported Formats

- **PCD** (`.pcd`): binary and ASCII
- **PLY** (`.ply`): ASCII, binary little-endian, binary big-endian
- **LAS** (`.las`): point data record formats 0–3, 6–8
- **LAZ** (`.laz`): LAZ-compressed LAS via `laz-perf`
- **E57** (`.e57`): XYZ / RGB / intensity via a bundled Rust + WebAssembly reader
- Large files are transferred to the WebView in chunks to keep memory use bounded

## Current Limitations

- `binary_compressed` PCD is not supported.
- E57: fields beyond XYZ + RGB / intensity are decoded best-effort only.
- Extremely large clouds may exceed browser memory; a pre-load estimate is
  surfaced in the settings panel when available.

## Links
* Source code
  - [q3dweb](https://github.com/Panasonic-Advanced-Technology/q3dweb)
  - [q3dviewer](https://github.com/scomup/q3dviewer)
* Documentation
  - [VSCode とブラウザで使える軽量点群ビューアを作ってみた](https://qiita.com/hrpad/items/588474a1b70d413104f8)
  - [自作の3D点群ビューアーをオープンソース化してみた](https://qiita.com/scomup/items/75c942678c5be47e23e2)

## License

MIT. See `LICENSE.txt` in the packaged extension.
