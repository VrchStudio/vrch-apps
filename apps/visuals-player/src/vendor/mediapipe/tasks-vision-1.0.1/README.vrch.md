# MediaPipe Tasks Vision 1.0.1

This directory vendors the browser bundle and WebAssembly files from the official npm package `@mediapipe/tasks-vision@1.0.1` for same-origin use by Image Viewer V2.

- Upstream: `https://www.npmjs.com/package/@mediapipe/tasks-vision/v/1.0.1`
- npm integrity: `sha512-rvRE2FmAZ6ZxK[...]9QtomhmXk3aUQ==`
- Package license: Apache-2.0; see `LICENSE`.
- Runtime policy: the VRCH analysis Worker refuses every request outside the Viewer origin or its App package (`fetch()`, `importScripts()`, XHR, `sendBeacon()`, WebSocket, EventSource), including the bundle's built-in usage logger (`odml.pa.googleapis.com`). Frames and landmarks stay in the browser.

The Hand, Face and Pose Landmarker adapters are used.

The Viewer uses a classic Worker and calls `FilesetResolver.forVisionTasks()` with its default module flag. The vendored WASM directory keeps only the SIMD loader/binary pair, which every current browser loads; the no-SIMD and `vision_wasm_module_internal.*` pairs are intentionally omitted.
