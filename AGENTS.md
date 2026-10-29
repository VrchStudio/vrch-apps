# Working on VRCH Apps

- Every official App must declare a packaged icon in app.json. Default to a transparent SVG with a neutral gray/white subject and Deep Pink (#ff1493) accent, legible in Launcher, My Apps and Guide. Keep the icon through updates.
- Audio Apps using SDK output.createNode must construct their 48 kHz AudioContext with sinkId: {type: "none"}; the host owns physical output routing. Test the real SDK PCM bridge under restricted speaker-selection, including start/stop/retry. Do not classify every browser NotAllowedError as missing Menu authorization.
- Keep the packaged guide accurate; the official catalog publishes guide and icon metadata from the exact latest released source.
- Keep each App's UUID stable. Update its version once per release and add short user-facing release notes.
- Use `python3 tools/apps.py check/build <app>` and focused tests. Build only from `apps/<app>/src`; never include device data, credentials or local working files.
- Preserve unknown App files and JSON fields. Keep packaged third-party license notices. Do not alter a published version's content.
- Run `python3 -m unittest discover -s tests -v` when changing the shared build/release tool. Keep package format compatible with the device host.
- Release only after an explicit publish request. Use `tools/apps.py release` or the Release App workflow; do not manually upload alternate packages or edit the generated stable catalog.
- Source publication, catalog publication, platform delivery and device acceptance are separate results. Report the actual outcome of each.
- Preserve other contributors' work. Stage explicit files. Do not commit build output, temporary backups, logs or test screenshots.
