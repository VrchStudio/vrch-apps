# VRCH Apps

Official VRCH apps — source code and releases.

Download an App's `.vrchapp` attachment from [Releases](https://github.com/VrchStudio/vrch-apps/releases). Import it using My Apps. Each App has its own version and retains the same App ID between updates. Installation packages contain code and bundled resources, not your device's saved data.

Update notifications require a My Apps platform release with official update support. Existing devices receive that capability through their normal Components and Runtime updates; publishing an App does not upgrade the platform.

## Apps

- [Hardware Check](apps/hardware-check): check controls, audio, touch, camera and motion.
- [Metronome](apps/metronome): keep time with adjustable tempo, meter and subdivisions.
- [Drum 808](apps/drum-808): program twelve synthesized drum voices on a 16-step sequencer.
- [Magic Circle](apps/magic-circle): perform with audio-reactive geometry and synthesized sound.

- [Wavescape](apps/wavescape): play a two-layer wavetable synthesizer with a sequencer and arpeggiator.

- [Flux FX](apps/flux-fx): perform live filter, roll, echo and chop effects over audio input.

- [Shaker Shaker](apps/shaker-shaker): shake or tap a granular percussion instrument.

- [Vape Grain](apps/vape-grain): shape granular instruments with breath and touch.

- [PalmNotes Duo](apps/palmnotes-duo): play notes and octaves with two-hand gestures.

- [BODY VIBES](apps/body-vibes): mix music with arms, body position and head movement.

- [PitchPlay](apps/pitchplay): transform live voice with Giant, Goblin and Robot presets.

- [VibeLive Synth](apps/vibelive-synth): play and blend AI music loops rendered by a connected Mac.

## Develop

Python 3.10+ is sufficient for building; no private repository or package download is required.

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

Both paths run the same queued workflow. It builds the requested source commit, publishes the versioned package and `release.json`, verifies the public download, then updates `catalog/stable.json`. The workflow also embeds catalogue icons from source matching the latest published revision, so browsing does not download App packages. Source pushes alone do not publish an App. The workflow uses GitHub's built-in token; devices need no GitHub credentials.

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
