[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/test.yml/badge.svg)](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/test.yml)
[![Deploy Cloud Viewer to GitHub Pages](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/deploy-pages.yml)
[![Build VS Code Extension](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/build-extension.yml/badge.svg)](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/build-extension.yml)
# q3dweb
q3dweb is a lightweight 3D point cloud viewer for the browser and VS Code. It is designed to make point cloud data easy to view, share, and inspect without a heavy desktop setup.

It is a WebGL (Three.js) port of [q3dviewer](https://github.com/scomup/q3dviewer).

### Highlights

1. Runs directly in the browser with no dedicated viewer install.
2. Also works as a VS Code extension.
3. Uses a lightweight implementation aimed at handling large point clouds efficiently.
4. Can overlay georeferenced LAS and LAZ data on map tiles.

### Supported File Formats

- PCD
- PLY
- LAS
- LAZ
- E57

## Setup

### Browser

Open the URL below and drag and drop a point cloud file into the viewer.

https://Panasonic-Advanced-Technology.github.io/q3dweb

### VS Code

1. Search for `q3dviewer` in the VS Code Extensions view and install it.

<img width="1186" height="617" alt="vscode_install2" src="https://github.com/user-attachments/assets/34de4d3a-2953-4db0-ad72-470223968d52" />

3. Open a supported point cloud file in VS Code and the q3dweb viewer will launch.

## Usage

### 1. Basic Controls

After you load a point cloud by drag and drop, you can inspect it with the mouse and keyboard.

![drag_pcd.gif](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/3953399/555fee3d-8ec3-4fee-80f6-767844c003da.gif)

| Input | Action |
| --- | --- |
| Right drag | Rotate |
| Left drag | Pan |
| Mouse wheel | Zoom |
| W / A / S / D / Z / X | Move the camera |
| Ctrl + Left Click | Measure the distance between two points |
| Ctrl + Right Click | Reset measurement points |
| M | Toggle the settings menu |
| Space (Film Maker tab) | Add a key frame from the current camera position |
| Delete (Film Maker tab) | Delete the current key frame |

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

## Developing q3dweb

q3dweb is published on GitHub under the MIT License. You can freely inspect, modify, and build it locally.

If you want to work on it locally, install the required packages and build it with the commands below.

### 1. Set Up the Development Environment

```bash
git clone https://github.com/Panasonic-Advanced-Technology/q3dweb.git
cd q3dweb
npm install
cd extension && npm install && cd ..
```

### 2. Run the Browser Version

```bash
# Start the dev server
npm run dev
```

### 3. Run the VS Code Version

```bash
# Build the extension (viewer build + extension compile)
npm run build:extension

# Create a VSIX package
npm run package:extension
```

Once the VSIX package is generated, choose Install from VSIX in the VS Code Extensions view and select the generated file.

## Closing Notes

q3dweb is an ongoing effort to bring the strengths of q3dviewer to the browser and VS Code. The goal is to make point cloud viewing easier to distribute, easier to share, and easier to try.

The project is still evolving, but it is already useful for everyday inspection of point cloud data. Feedback and feature requests are welcome.

## Links

* Source code
  - [q3dweb](https://github.com/Panasonic-Advanced-Technology/q3dweb)
  - [q3dviewer](https://github.com/scomup/q3dviewer)
* Documentation
  - [VSCode とブラウザで使える軽量点群ビューアを作ってみた](https://qiita.com/hrpad/items/588474a1b70d413104f8)
  - [自作の3D点群ビューアーをオープンソース化してみた](https://qiita.com/scomup/items/75c942678c5be47e23e2)

## License / Credits

This project is released under the [MIT License](LICENSE).

For the list of third-party libraries and external services used by this project, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

In particular, viewers that display map tiles require the following attributions.

- **OpenStreetMap tiles**: © OpenStreetMap contributors
  ([License](https://www.openstreetmap.org/copyright))
- **GSI tiles**: Source: GSI Tiles (GSI Maps)
  ([Terms of use](https://maps.gsi.go.jp/development/ichiran.html))

The bundled `laz-perf` WASM module for LAZ decoding is distributed under the Apache License 2.0. See `THIRD_PARTY_NOTICES.md` for details.
