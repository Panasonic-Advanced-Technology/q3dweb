# Third-Party Notices

q3dweb incorporates the following open-source software components.

## Runtime (bundled into `dist/`)

### @material/web

- License: **Apache License 2.0**
- Source: https://github.com/material-components/material-web
- Copyright: Copyright 2022-2026 Google LLC and contributors
- License text: https://github.com/material-components/material-web/blob/main/LICENSE
- Notes: q3dweb uses Material Web typography styles and the `md-ripple`
  component for the settings UI. The Apache 2.0 license is reproduced at the
  bottom of this file.

### lit

- License: BSD-3-Clause
- Source: https://github.com/lit/lit
- Copyright: Copyright (c) 2017 Google LLC
- License text: https://github.com/lit/lit/blob/main/LICENSE

### tslib

- License: 0BSD
- Source: https://github.com/Microsoft/tslib
- Copyright: Copyright (c) Microsoft Corporation
- License text: https://github.com/Microsoft/tslib/blob/main/LICENSE.txt

### three

- License: MIT
- Homepage: https://threejs.org/
- Source: https://github.com/mrdoob/three.js/
- Copyright: (c) 2010-2024 three.js authors
- License text: https://github.com/mrdoob/three.js/blob/dev/LICENSE

### proj4 (with mgrs, wkt-parser)

- License: MIT
- Source: https://github.com/proj4js/proj4js
- Copyright: (c) 2014, Mike Adair, Richard Greenwood, Didier Richard,
  Stephen Irons, Olivier Terral and Calvin Metcalf
- License text: https://github.com/proj4js/proj4js/blob/master/LICENSE.md

### vendor/e57-wasm

- License: MIT
- Source: `vendor/e57-wasm/`
- Notes: q3dweb bundles a locally built WebAssembly module for E57 decoding.
  It uses the Rust `e57` crate (MIT), `wasm-bindgen` / `js-sys` and related
  crates (MIT OR Apache-2.0), `memchr` (Unlicense OR MIT), and
  `unicode-ident` ((MIT OR Apache-2.0) AND Unicode-3.0).

### laz-perf

- License: **Apache License 2.0**
- Source: https://github.com/hobuinc/laz-perf
- Copyright: (c) Howard Butler, Hobu Inc. and contributors
- License text: https://github.com/hobuinc/laz-perf/blob/master/COPYING
- Notes: q3dweb bundles `laz-perf.wasm` to decode LAZ (LASzip-compressed
  LAS) point clouds. The Apache 2.0 license is reproduced at the bottom of
  this file.

## External services (accessed at runtime, not bundled)

q3dweb can overlay map tiles from the following services. Their terms of use
require attribution when the corresponding basemap is displayed:

- **OpenStreetMap** — © OpenStreetMap contributors.
  https://www.openstreetmap.org/copyright
- **GSI Tiles (国土地理院)** — 出典：国土地理院タイル (地理院地図).
  https://maps.gsi.go.jp/development/ichiran.html

## Build-time only (not distributed)

The following are used only during development or build, and are not included
in the published artifacts:

- TypeScript — Apache-2.0 — https://github.com/microsoft/TypeScript
- Vite — MIT — https://github.com/vitejs/vite
- Vitest — MIT — https://github.com/vitest-dev/vitest
- @types/three, @types/proj4 — MIT — https://github.com/DefinitelyTyped/DefinitelyTyped

## VS Code Extension (`q3dweb/extension/`)

The VS Code extension is also MIT-licensed. Build-time-only dependencies
(webpack, ts-loader, eslint, @vscode/vsce, @vscode/test-cli,
@vscode/test-electron, @types/*) are not redistributed in the VSIX and are
each released under MIT or compatible permissive licenses by their respective
owners.

---

## Apache License 2.0 (applies to `laz-perf`)

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

Full text: https://www.apache.org/licenses/LICENSE-2.0.txt
