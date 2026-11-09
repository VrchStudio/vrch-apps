# PalmNotes / 掌上音符

An independent My Apps instrument: one hand, seven notes. 1–5 extended fingers
play Do / Re / Mi / Fa / Sol; thumb + pinky plays La (A4), and an OK ring plays
Si (B4). The two special gestures take priority over counting. Use index + middle
for Re and index + middle + ring for Mi. A fist or missing hand releases sound.
The camera, gesture, note and highlighted mapping remain visible together.

Import `palm-notes-0.1.0.vrchapp` (built by `python3 tools/apps.py build palm-notes`) using **My Apps → Import App**, then Launch and
Start. Choose the speaker/headphones in the existing Menu. K2 starts/stops,
K3 rotates the camera upright, K4 mirrors the upright preview, and E1 adjusts
volume. E2 turns through Soft / Bell / Pluck / Retro (press for next); the Tone
menu offers direct selection. The choice is saved. These are synthesized timbres,
not sampled acoustic instruments. Touch controls perform the same operations. Show one complete hand;
spread the fingers you intend to count. Settings save through the SDK.

Maker Preview does not open a camera. Enable **Listen to preview**, then tap
a note for a bounded 600 ms audition. This is sound preview, not recognition.

## Build and checks

The source in `src/` is the App exactly as installed (0.1.0, package SHA256
`35fa787123c2bbf867bf48c07214252a941a34d8e266415d4507e5592f455930`, pinned in
`legacy-baseline.json`). It carries copies of the Pages hand worker, Hand Lite
model, MediaPipe JS/WASM/licenses, PitchPlay portable controls (`controls.css`) and
the shared action-popover CSS block (`popover.css`); a new version takes them
again by hand and needs an icon. Only the normal public My Apps SDK is host-provided.

```sh
python3 tools/apps.py check palm-notes
node tests/palm_notes_core.mjs
node tests/palm_notes_render_voices.mjs
```

The browser tests run against a VRCH Pages checkout (VRCH_PAGES_ROOT, else
`../vrch-web-viewer-pages`) and fetch hash-checked public gesture photos first
(network needed only for this preparation):

```sh
python3 tests/palm_notes_fetch_fixtures.py
node tests/palm_notes_browser.cjs
node tests/palm_notes_preview.cjs
```

The Player test uses actual local TLS Agent/content/SDK, camera ImageBitmap transport,
the actual bundled model and host PCM playback. A canvas MediaStream carries known
photographs in place of a physical camera. Managed processes and MIDI are fixtures.
The Preview test imports the package built by `tools/apps.py build` through the
normal Maker/Relay workflow. Screenshots, measurements and downloaded fixtures stay in
`/tmp/palm-notes/`.

## Recognition and sound

World-space joint angles and palm-relative distances handle left/right hands,
mirroring and rotation without relying on screen-up or a handedness label.
Thumb extension requires joint extension and separation from the palm. The
worker's existing model detection/presence thresholds remain unchanged; its
handedness score is deliberately not treated as a landmark-quality score.
See the [MediaPipe hand result contract](https://developers.google.cn/edge/mediapipe/solutions/vision/hand_landmarker/web_js).

`instrument.json` owns notes, colors and thresholds. Real-model photograph probes
showed that a 155-degree joint threshold rejected extended middle fingers, and
thumb IP estimates can be near 142 degrees. The candidate uses 145/135-degree
finger hysteresis and 135/125-degree thumb IP hysteresis, plus palm geometry.
For OK, image-space thumb/index contact is aspect-corrected and normalized by
the larger palm length/width: enter below 0.20, leave above 0.28, with the other
three fingers extended and a world-distance bound of 0.70 palm units. A side-view
photo showed a 0.164 image ratio but unreliable depth; a width-only 3D test rejected
its touching tips. These are tested starting values, not human-camera qualification.

A changed nonzero gesture needs two samples over at least 45 ms. Zero and missing
hands release immediately on their first result. Stale results are rejected after
260 ms; tracking has at most one frame in flight. Display mirroring is separate
from recognition. Rotation invalidates old results without restarting the camera.

The synthesizer follows playback ACKs through `sdk.audio.openOutput().write()`.
Exactly two 20 ms blocks remain in flight. The four voices use 4–18 ms attack and
45–90 ms release, with distinct harmonic profiles and decay/sustain. Harmonic
coefficients and volume smooth over 8 ms, including rapid preset changes.
An unchanged note never retriggers the voice. No second audio clock or frame-rate
audio timer is used. A UI stall drains the bounded host queue into silence; fresh
PCM generation checks the result's wall-clock lease before sounding again.
This digital path is not a physical latency or listening-quality measurement.

## Delivery boundary

Installed on 120 by file import; it is not in the official catalog. Real hands
(including occlusion, fast transitions and OK/Shaka poses), speaker/headphone
listening, target CPU load and physical latency remain unverified. Design and
findings: Docs `workstreams/apps/palm-notes-review-2026-10-20.md`.

## Review audio and photo fixtures

`render-voices.mjs` generates `/tmp/palm-notes/PalmNotes-four-tones.wav` using the
App's actual synth: Soft at 0s, Bell at 4.62s, Pluck at 9.24s, Retro at 13.86s.
The same phrase is repeated for comparison. This is synthetic review audio.

Additional real-model evaluation photographs are downloaded only into `/tmp`:
[Shaka by Roblespepe](https://commons.wikimedia.org/wiki/File:Shaka-sign.png),
[OK by Steven H. Keys](https://commons.wikimedia.org/wiki/File:OK_Sign.jpg), and
[Tropical / Soyvisual three](https://www.soyvisual.org/fotos/tres) /
[four](https://www.soyvisual.org/fotos/cuatro) (BY-NC-SA). See the source pages for
licenses. They are not included in the App package.
