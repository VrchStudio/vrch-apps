#!/usr/bin/env python3
"""Refresh, in an App's source, the files it takes from VRCH Pages.

Visuals Player and Shader Editor run the Pages visuals engine, and Attractor uses the shared panel styles. These
files in apps/<app>/src are copies of a Pages
checkout: the scripts/ and css/ files that index.html loads (and the fonts those styles use), the scene catalog with
its definitions and thumbnails, MediaPipe tracking, and, in Visuals Player, the Visual Settings dialog inside
index.html. Every other file is the App's own and is edited here. To use another shared script, add its tag to
index.html and run --write.

  python3 tools/pages_sync.py visuals-player           # report what differs from Pages (exit 1 if anything does)
  python3 tools/pages_sync.py visuals-player --write   # take Pages' files into the source

Pages is VRCH_PAGES_ROOT, else ../vrch-web-viewer-pages. A source that changes needs a new App version to release.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MEDIAPIPE = 'vendor/mediapipe/tasks-vision-1.0.1'
FONT_LICENSES = ('webfonts/montserrat-LICENSE.txt', 'webfonts/courier-prime-sans-LICENSE.txt')
# Directories whose files all come from Pages: a file there that Pages no longer gives is stale.
SHARED = ('scripts/', 'css/', 'webfonts/', 'vendor/', 'models/', 'scenes/')
# The Apps carry only the SIMD runtime, which every current browser loads; their copy of the vendor note says so.
PAGES_WASM = 'The vendored WASM directory therefore keeps the reachable SIMD and no-SIMD loader/binary pairs; the unused `vision_wasm_module_internal.*` pair is intentionally omitted.'
APP_WASM = 'The vendored WASM directory keeps only the SIMD loader/binary pair, which every current browser loads; the no-SIMD and `vision_wasm_module_internal.*` pairs are intentionally omitted.'
APPS = {
    'visuals-player': {
        'files': ('scripts/vrch_pages_landmark_worker.js', MEDIAPIPE + '/vision_bundle.js', MEDIAPIPE + '/LICENSE',
                  MEDIAPIPE + '/README.vrch.md', MEDIAPIPE + '/wasm/vision_wasm_internal.js', MEDIAPIPE + '/wasm/vision_wasm_internal.wasm',
                  'models/mediapipe/pose_landmarker-lite-float16-v1.task', 'models/mediapipe/README.md') + FONT_LICENSES,
        'mediapipe': False, 'scenes': 'curated', 'visual_settings': True,
    },
    # Attractor takes only the look of its Player panel: the shared styles, their fonts and the dialog header.
    'attractor': {'files': FONT_LICENSES, 'mediapipe': False, 'scenes': None, 'visual_settings': False},
    'shader-editor': {
        'files': ('scripts/vrch_pages_landmark_worker.js', 'models/mediapipe/hand_landmarker-lite-v1.task',
                  'models/mediapipe/face_landmarker-float16-v1.task', 'models/mediapipe/pose_landmarker-lite-float16-v1.task',
                  'models/mediapipe/README.md') + FONT_LICENSES,
        'mediapipe': True, 'scenes': 'all', 'visual_settings': False,
    },
}
URL = re.compile(r'url\(["\']?([^\)"\']+)')


def pages_root(value=None):
    root = Path(value or os.environ.get('VRCH_PAGES_ROOT') or ROOT.parent / 'vrch-web-viewer-pages')
    if not (root / 'static/scripts').is_dir():
        raise SystemExit('VRCH Pages checkout not found: ' + str(root))
    return root


def selection(static):
    source = (static / 'scripts/vrch_pages_scene_selection.js').read_text()
    start = source.index('const data=') + len('const data=')
    return json.JSONDecoder().raw_decode(source[start:])[0]


def fontawesome(css, static):
    # The site's Font Awesome sheet lists legacy font fallbacks that are not shipped; keep the available faces.
    def face(match):
        def sources(found):
            values = [part for part in found.group(1).split(',')
                      if all((static / 'css' / urlsplit(url).path).is_file() for url in URL.findall(part))]
            return 'src:' + ','.join(values)
        rule = re.sub(r'src:([^;}]+)', sources, match.group(0))
        return '' if re.search(r'src:;', rule) else rule
    return re.sub(r'@font-face\s*\{[^}]+\}', face, css)


def visual_settings(static):
    page = (static / 'vrch_visual_settings.html').read_text()
    match = re.search(r'<div id="visual-settings"[\s\S]*</div>\s*(?=</body>)', page)
    if not match:
        raise ValueError('Visual Settings markup not found in vrch_visual_settings.html')
    return match.group(0).strip()


def element_end(html, start):
    depth = 0
    for match in re.finditer(r'<(/?)div\b[^>]*>', html[start:]):
        depth += -1 if match.group(1) else 1
        if depth == 0:
            return start + match.end()
    raise ValueError('Unclosed <div id="visual-settings"> in index.html')


def expected(app, pages, source):
    """Every file the App takes from Pages, by its path in the App source, with the content Pages gives now."""
    spec, static = APPS[app], pages / 'static'
    files = {}
    def take(relative, data=None):
        files[relative] = (static / relative).read_bytes() if data is None else data
    html = (source / 'index.html').read_text()
    for name in re.findall(r'<script(?: defer)? src="scripts/([^"]+)"', html):
        take('scripts/' + name)
    for name in re.findall(r'<link rel="stylesheet" href="css/([^"]+)"', html):
        css = (static / 'css' / name).read_text()
        if name == 'fontawesome-local.css':
            css = fontawesome(css, static)
        take('css/' + name, css.encode())
        for url in URL.findall(css):
            parsed = urlsplit(url)
            if parsed.scheme or url.startswith('#'):
                if parsed.scheme not in ('', 'data'):
                    raise ValueError('App CSS must use local resources: ' + url)
                continue
            take((static / 'css' / parsed.path).resolve().relative_to(static.resolve()).as_posix())
    for relative in spec['files']:
        take(relative)
    if spec['mediapipe']:
        for asset in sorted((static / MEDIAPIPE).rglob('*')):
            if asset.is_file() and 'nosimd' not in asset.name:
                take(asset.relative_to(static).as_posix())
    note = MEDIAPIPE + '/README.vrch.md'
    if note in files:
        text = files[note].decode()
        if PAGES_WASM not in text:
            raise ValueError('The MediaPipe vendor note changed; update APP_WASM in tools/pages_sync.py.')
        files[note] = text.replace(PAGES_WASM, APP_WASM).encode()
    if not spec['scenes']:
        return files
    catalog = json.loads((static / 'scenes/v1/catalog.json').read_text())
    chosen = selection(static)['items']
    if spec['scenes'] == 'curated':
        entries = {entry['scene_ref']['scene_id']: entry for entry in catalog['entries']}
        picked = []
        for item in chosen:
            if item['collection'] != 'curated':
                continue
            entry = entries.get(item['scene_id'])
            if not entry:
                raise ValueError('Visual is not in the site catalog: ' + item['scene_id'])
            take('scenes/v1/' + entry['definition_path'])
            if item.get('thumbnail'):
                take(item['thumbnail'])
            picked.append(entry)
        catalog['entries'] = picked
    else:
        for entry in catalog['entries']:
            relative = 'scenes/v1/' + entry['definition_path']
            take(relative)
            thumbnail = json.loads((static / relative).read_text()).get('catalog', {}).get('thumbnail_ref', '')
            if thumbnail.startswith('scenes/'):
                take(thumbnail)
        for item in chosen:
            if item.get('thumbnail'):
                take(item['thumbnail'])
    files['scenes/v1/catalog.json'] = (json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    if spec['visual_settings']:
        start = html.index('<div id="visual-settings"')
        files['index.html'] = (html[:start] + visual_settings(static) + html[element_end(html, start):]).encode()
    return files


def compare(app, pages, source=None):
    source = Path(source or ROOT / 'apps' / app / 'src')
    files = expected(app, pages, source)
    present = {path.relative_to(source).as_posix() for path in source.rglob('*') if path.is_file()}
    return {
        'missing': sorted(name for name in files if name not in present),
        'extra': sorted(name for name in present if name.startswith(SHARED) and name not in files),
        'changed': sorted(name for name in files if name in present and (source / name).read_bytes() != files[name]),
    }, files


def write(app, pages, source=None):
    source = Path(source or ROOT / 'apps' / app / 'src')
    result, files = compare(app, pages, source)
    for name in result['missing'] + result['changed']:
        target = source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(files[name])
        target.chmod(0o644)
    for name in result['extra']:
        (source / name).unlink()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('app', choices=sorted(APPS))
    parser.add_argument('--pages', help='VRCH Pages checkout (default VRCH_PAGES_ROOT or ../vrch-web-viewer-pages)')
    parser.add_argument('--write', action='store_true', help="take Pages' files into the App source")
    args = parser.parse_args()
    pages = pages_root(args.pages)
    if args.write:
        print(json.dumps(write(args.app, pages)))
        return 0
    result, _ = compare(args.app, pages)
    print(json.dumps(result))
    return 1 if any(result.values()) else 0


if __name__ == '__main__':
    sys.exit(main())

