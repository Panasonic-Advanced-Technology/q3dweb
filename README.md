[![Tests](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/test.yml/badge.svg)](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/test.yml)
[![Deploy Cloud Viewer to GitHub Pages](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/deploy-pages.yml)
[![Build VS Code Extension](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/build-extension.yml/badge.svg)](https://github.com/Panasonic-Advanced-Technology/q3dweb/actions/workflows/build-extension.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
# q3dweb
q3dweb is a lightweight 3D point cloud viewer for the browser and VS Code. It is designed to make point cloud data easy to view, share, and inspect without a heavy desktop setup.

It is a WebGL (Three.js) port of [q3dviewer](https://github.com/scomup/q3dviewer).

### Highlights

1. Runs directly in the browser with no dedicated viewer install.
2. Also works as a VS Code extension.
3. Supports three viewer modes: `cloud_viewer`, `film_maker`, and `realtime_viewer`.
4. Accepts URL query parameters for remote point clouds and realtime ROS configuration.
5. Automatically down-samples very large point clouds to fit the available memory budget.
6. Supports mouse, keyboard, and mobile touch controls.
7. Can overlay georeferenced LAS and LAZ data on map tiles.

### Supported File Formats

- PCD
- PLY
- LAS
- LAZ
- E57

## Setup

### Browser

Open the URL below in a browser.

https://Panasonic-Advanced-Technology.github.io/q3dweb

The default mode is `cloud_viewer`. You can also open a specific viewer mode directly with the `mode` query parameter.

```text
https://Panasonic-Advanced-Technology.github.io/q3dweb/?mode=cloud
https://Panasonic-Advanced-Technology.github.io/q3dweb/?mode=film_maker
https://Panasonic-Advanced-Technology.github.io/q3dweb/?mode=realtime
```

### VS Code

1. Search for `q3dviewer` in the VS Code Extensions view and install it.

<img width="1186" height="617" alt="vscode_install2" src="https://github.com/user-attachments/assets/34de4d3a-2953-4db0-ad72-470223968d52" />

2. Open a supported point cloud file in VS Code and q3dweb will launch.
3. Use the `Viewer Mode` selector at the top of the settings panel to switch between `cloud_viewer`, `film_maker`, and `realtime_viewer`.

## Usage

### 1. Viewer Modes

The settings panel starts with a `Viewer Mode` selector.

| UI Label | URL `mode` value | Purpose |
| --- | --- | --- |
| `cloud_viewer` | `cloud` | Open local or remote point cloud files and inspect them interactively. |
| `film_maker` | `film_maker` | Create key frames, preview camera motion, and export recordings. |
| `realtime_viewer` | `realtime` | Subscribe to ROS data through rosbridge and render PointCloud2 streams in realtime. |

### 2. Basic Controls

After you load a point cloud, you can inspect it with the mouse and keyboard.

![drag_pcd.gif](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/3953399/555fee3d-8ec3-4fee-80f6-767844c003da.gif)

#### Mouse and Keyboard

| Input | Action |
| --- | --- |
| Right drag | Rotate |
| Left drag | Pan |
| Mouse wheel | Zoom |
| W / A / S / D / Z / X | Move the camera |
| Ctrl + Left Click | Measure the distance between two points |
| Ctrl + Right Click | Reset measurement points |
| M | Toggle the settings menu |
| Space (`film_maker` mode) | Add a key frame from the current camera position |
| Delete (`film_maker` mode) | Delete the current key frame |

#### Touch

| Input | Action |
| --- | --- |
| One-finger drag | Pan |
| Two-finger pinch | Zoom |
| Two-finger vertical parallel drag | Pitch rotation |
| Two-finger twist | Yaw rotation |

On primary touch devices, distance measurement shortcuts are disabled so touch gestures can be used without conflicts.

### 3. Cloud Viewer

`cloud_viewer` is the default mode. You can:

- Drag and drop `.pcd`, `.ply`, `.las`, `.laz`, or `.e57` files.
- Open a remote point cloud by URL.
- Tune point rendering from the settings panel or URL parameters.
- Let q3dweb automatically down-sample very large files when needed.

#### Cloud Viewer Query Parameters

Use `?mode=cloud` with any of the parameters below. Canonical names are shown here; several compatibility aliases are also accepted.

| Parameter | Meaning |
| --- | --- |
| `cloudUrl` | Remote point cloud URL. Accepts `.pcd`, `.ply`, `.las`, `.laz`, or `.e57`. |
| `filename` | Optional filename hint when the URL does not end with a supported extension. |
| `maxPoints` | Optional visual point budget. |
| `pointSize` | Point size. |
| `pointType` | `PIXEL`, `SQUARE`, or `SPHERE` (case-insensitive aliases such as `pixel`, `square`, `sphere` also work). |
| `alpha` | Point opacity in the range `0.0` to `1.0`. |
| `colorMode` | `I`, `RGB`, or `FLAT` (aliases such as `intensity`, `rgb`, `flat` also work). |
| `vmin` / `vmax` | Intensity range used by intensity color mode. |
| `backgroundColor` | Background color, for example `#0b1020`. |
| `showCenter` | Whether to show the red orbit center marker. Accepts `true` / `false`, `1` / `0`, `yes` / `no`, `on` / `off`. |

Example:

```text
https://Panasonic-Advanced-Technology.github.io/q3dweb/?mode=cloud&cloudUrl=https://example.com/sample.laz&filename=sample.laz&pointType=sphere&pointSize=3&colorMode=rgb&backgroundColor=%230b1020&showCenter=false
```

### 4. LAS / LAZ Map Overlay

If a LAS or LAZ file includes coordinate reference system information, q3dweb can read it and overlay the point cloud on map tiles.

The following map sources are available by default.

- OpenStreetMap
- GSI Standard Map
- GSI Pale Map
- GSI Seamless Aerial Photo
- GSI Blank Map

<img width="528" height="327" alt="map" src="https://github.com/user-attachments/assets/1dcf11f2-7fa0-466c-95f1-dee6a25ff064" />

### 5. Realtime Viewer

`realtime_viewer` connects to a rosbridge WebSocket and consumes:

- `sensor_msgs/PointCloud2` for the live point cloud topic
- `nav_msgs/Odometry` for the odometry topic

To use it interactively:

1. Switch `Viewer Mode` to `realtime_viewer`.
2. Enter the ROS Bridge URL, Cloud Topic, Odom Topic, and point budgets.
3. Click `Connect`.

You can also configure it entirely from the URL.

#### Realtime Viewer Query Parameters

Use `?mode=realtime` with the following parameters.

| Parameter | Meaning |
| --- | --- |
| `ros` | rosbridge WebSocket URL such as `ws://localhost:9090` or `wss://robot.example.com/rosbridge`. |
| `cloudTopic` | PointCloud2 topic name. |
| `odomTopic` | Odometry topic name. |
| `maxPointsPerScan` | Max decoded points kept from each scan. |
| `maxAccumulatedPoints` | Max accumulated points kept in the map. |

Canonical parameter names are shown above. q3dweb also accepts aliases such as `rosbridgeUrl`, `topic`, `odom`, `scanPoints`, and `maxPoints`.

Example:

```text
https://Panasonic-Advanced-Technology.github.io/q3dweb/?mode=realtime&ros=ws://localhost:9090&cloudTopic=/cloud_registered&odomTopic=/odometry&maxPointsPerScan=3200&maxAccumulatedPoints=1200000
```

If you open q3dweb from an `https://` origin, most browsers require a secure WebSocket endpoint (`wss://`).

### 6. Creating Demo Videos

q3dweb also includes a Film Maker workflow for creating camera fly-throughs. Switch `Viewer Mode` to `film_maker`, save camera positions as key frames, and preview the interpolated camera motion.

You can then record and download the playback as a video file. The default setting targets MP4/H.264 when the browser supports it and otherwise falls back to another MediaRecorder-compatible format.

![firm_l.gif](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/3953399/15a0b61b-453d-4579-ba71-665d21289389.gif)

### 7. Distance Measuring

You can measure distance by holding Control and left-clicking.

If you click multiple times, you can also measure the total length.

Press Control and right-click to undo.

<img width="486" height="324" alt="measure" src="https://github.com/user-attachments/assets/135907d5-5765-45f3-a294-22c64dbcce73" />

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

# Build a production bundle
npm run build

# Preview the production bundle locally
npm run preview -- --host 127.0.0.1 --port 4173
```

### 3. Run the VS Code Version

```bash
# Build the extension (viewer build + extension compile)
npm run build:extension

# Create a VSIX package
npm run package:extension
```

### 4. Run the Test Suite

```bash
# Unit tests
npm run test:unit:ci

# End-to-end tests
npm run test:e2e:ci
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
