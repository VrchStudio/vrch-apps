MediaPipe Tasks Vision 1.0.1: Apache-2.0; see LICENSE.
Copied from the existing Pages/Visuals vendored assets; no new model download.
Face: official Face Landmarker float16 (Lite has incompatible landmark ordering).
Body: official Pose Landmarker Lite float16.
Hand: Pages Hand Landmarker Lite v1, official detector/metadata plus Apache-2.0 Lite landmark model.
Runtime, WASM and models ship with this App; no CDN fetch at runtime.
Visuals model selection, CPU delegate and 192px input retained.
Single-model hardware inspection runs one frame in flight, with no fixed fps cap or forced idle.
Camera capture and inference have separate fps; no Visuals shaders/signal bus.
