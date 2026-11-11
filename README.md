# VRCH Apps

Official VRCH apps — source code and releases.

Download an App's `.vrchapp` attachment from [Releases](https://github.com/VrchStudio/vrch-apps/releases). Import it using My Apps. Each App has its own version and retains the same App ID between updates. Installation packages contain code and bundled resources, not your device's saved data.

Update notifications require a My Apps platform release with official update support. Existing devices receive that capability through their normal Components and Runtime updates; publishing an App does not upgrade the platform.

## Apps

- [Hardware Check](apps/hardware-check): check controls, audio, touch, camera and motion.
- [Metronome](apps/metronome): keep time with adjustable tempo, meter and subdivisions.
- [Drum 808](apps/drum-808): program twelve synthesized drum voices on a 16-step sequencer.
- [Magic Circle](apps/magic-circle): perform with audio-reactive geometry and synthesized sound.
- [XY Scope](apps/xy-scope): play an oscilloscope synthesizer whose two channels draw the figure you hear, or watch any incoming sound as a wave, XY figure or spectrum.
- [Attractor](apps/attractor): turn the four letters of a two-line formula and watch millions of points draw it as silk.

- [Wavescape](apps/wavescape): play a two-layer wavetable synthesizer with a sequencer and arpeggiator.

- [Flux FX](apps/flux-fx): perform live filter, roll, echo and chop effects over audio input.

- [Shaker Shaker](apps/shaker-shaker): shake or tap a granular percussion instrument.

- [Vape Grain](apps/vape-grain): shape granular instruments with breath and touch.

- [PalmNotes Duo](apps/palmnotes-duo): play notes and octaves with two-hand gestures.

- [BODY VIBES](apps/body-vibes): mix music with arms, body position and head movement.

- [PitchPlay](apps/pitchplay): transform live voice with Giant, Goblin and Robot presets.

- [VibeLive Synth](apps/vibelive-synth): play and blend AI music loops rendered by a connected Mac.

- [Visuals Player](apps/visuals-player): play music-driven visuals, shape them with the knobs and steer them with your hands.

- [Shader Editor](apps/shader-editor): edit and save visual presets with audio and image inputs.

- [Beatbox Coach](apps/beatbox-coach): 把你的嘴巴声音实时变成鼓声，并用示范、对比和打分带你学会 Beatbox。.
- [Disco Ball](apps/disco-ball): A spinning soccer-pattern mirror ball of 32 facets: every facet that lights up plays its own note, in time.
- [Petal FM](apps/petal-fm): A six-operator FM synthesizer with classic-style voices and one-key chords.
- [Pitch Shift](apps/pitch-shift): 把输入的音频实时上下变调一个八度，并能和原声混合出和声。.
- [Vocal Chain](apps/vocal-chain): 给 SM58 这类动圈麦的人声通道：前级增益、降噪、自动修音、失真、OTT，参数分页可调。.
- [Wake Gate](apps/wake-gate): An alarm you can only silence once you are genuinely awake.

- [GM Studio](apps/gm-studio): arrange music with the bundled General MIDI SoundFont.

## Develop

Python 3.10+ is sufficient for building; no private repository or package download is required.

The vrch.io Playground reads `catalog/playground.json`. Edit `catalog/presentation.json` to set an App's group, featured order, extra tags or screenshots, then run `python3 tools/apps.py index`. Each listed App's latest release is described by a file list taken from its exact release commit; the browser downloads those files from GitHub and checks them against the published package before running. Publishing refreshes it automatically.

```sh
python3 tools/apps.py check hardware-check
python3 tools/apps.py build hardware-check
python3 -m unittest discover -s tests -v
```

Edit the App in `apps/<app>/src/`. Its `app.json` is the source of truth for its ID and version. Do not change an existing App's ID. Every official App must include an `icon` path in `app.json` pointing to a bundled image. Use a transparent SVG by default, with a neutral gray/white subject and Deep Pink (`#ff1493`) accent; keep it legible in Launcher, My Apps and Guide. The build rejects missing icons. Put release notes under `## x.y.z` in that App's `CHANGELOG.md`. Build output goes into ignored `dist/<app>/`.

Hardware Check 1.6.1 builds to SHA256 `e5cf9d6b4ca9a2908afb65774e743badaa4276d6c1c9e839d4ff990658a7802f` and content revision `8ab39b62a645194f314ba560eebee0bef0bd590b9b4fdea109e1e20e31913fa5`.

## Publish

After testing and pushing the intended source commit to `main`, choose **Actions → Release App → Run workflow**, supply the App directory, its version and the full source commit SHA. Or use authenticated GitHub CLI through this single command:

```sh
python3 tools/apps.py release hardware-check --version 1.6.1
```

Both paths run the same workflow. Dispatch Apps one at a time and wait for each run to finish: GitHub concurrency retains only one pending run, so dispatching another replaces it. It builds the requested source commit, publishes the versioned package and `release.json`, verifies the public download, then updates `catalog/stable.json`. The workflow also embeds catalogue icons from source matching the latest published revision, so browsing does not download App packages. Source pushes alone do not publish an App. The workflow uses GitHub's built-in token; devices need no GitHub credentials.

Published assets are immutable. Fixes need a new version. Re-running the same source/version reuses matching assets and completes an interrupted catalog update. Different content under an existing version is rejected. If the Release succeeds but the catalog fails, re-run that same workflow; do not create another version just to repair the index.

For a new App, add `apps/<slug>/src/app.json`, its code/resources and `CHANGELOG.md`. For a newly created App, use a fresh UUID, stable `x.y.z` version, HTML entry and supported schema/SDK/data schema 1. When enrolling an existing App, keep its UUID and first publish an exact baseline so installed copies can be recognized. Historical baselines imported before the icon requirement may lack an icon; all current releases must include one. Run the same commands with its slug.

## Source and resources

This repository contains the Apps and their build tools. The My Apps host and fixed `/apps/sdk/` resources are provided by VRCH devices. App publication is separate from platform/Runtime updates.

Bundled third-party resources retain their own license notices. Public source availability does not replace those notices or grant an additional blanket license to all repository contents. No new blanket license has been selected for VRCH-owned code.

An existing installed App without an icon may declare its original identity in `apps/<slug>/legacy-baseline.json` (`appId`, `version`, `revision`, `packageDigest`). Only that exact source and byte-identical package may be published as the original baseline. Any later version must provide an icon; the exception does not permit editing or replacing the original.

### Audio compatibility checks

Apps that synthesize through `output.createNode(context)` must create the context with `sampleRate: 48000` and `sinkId: {type: "none"}`. The VRCH host selects and plays the physical output. Switching an existing context with `setSinkId` can be blocked by the App sandbox in newer Chromium. Only explicit SDK authorization errors should direct users to allow audio in Menu.

Run the Drum 808 regression with the Pages checkout alongside this repository (or set `VRCH_PAGES_ROOT`):

```sh
node tests/drum808_audio_browser.cjs
```

It exercises the actual Player, SDK and PCM output bridge; browser audio devices are fixtures and newer `setSinkId` policy refusal is emulated on older Chrome. Physical sound still needs device acceptance.

XY Scope has the same check, and two in the real Playground: the synthesizer (silent first picture, the picture against the samples at the host output, the output panel and the share link) and input mode (a tone file as the microphone):

```sh
node tests/xy_scope_audio_browser.cjs
node tests/xy_scope_browser.cjs
node tests/xy_scope_input_browser.cjs
```

### Catalog loading

Releases also generate `catalog/index.json`, a text-only discovery index. Icons and guides live in hash-addressed `catalog/assets/` files and load on demand. `catalog/stable.json` remains compatible with earlier clients. To regenerate discovery files from the published catalog, run `python3 tools/apps.py index`; this does not change any App package or version.
