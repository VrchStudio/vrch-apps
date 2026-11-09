#!/usr/bin/env python3
"""Visuals Player and Shader Editor: the App sources are complete and local, and the files they take from VRCH Pages
match a Pages checkout (tools/pages_sync.py), when one is present (VRCH_PAGES_ROOT or ../vrch-web-viewer-pages)."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import pages_sync  # noqa: E402

PAGES = Path(os.environ.get('VRCH_PAGES_ROOT') or ROOT.parent / 'vrch-web-viewer-pages')
HAS_PAGES = (PAGES / 'static/scripts').is_dir()
HASHES = r"""
const fs = require('fs'), path = require('path');
global.window = globalThis;
const root = process.argv[1];
require(path.join(root, 'scripts/vrch_pages_scene_spec.js'));
const contract = require(path.join(root, 'scripts/vrch_pages_scene_contract.js'));
(async () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'scenes/v1/catalog.json'))), out = [];
  for (const entry of catalog.entries) {
    const definition = JSON.parse(fs.readFileSync(path.join(root, 'scenes/v1', entry.definition_path)));
    contract.validateDefinition(definition, {trusted: entry.trusted === true});
    out.push([entry.scene_ref.scene_id, entry.scene_ref.content_hash, await contract.sha256Ref(definition)]);
  }
  console.log(JSON.stringify(out));
})().catch(error => { console.error(error); process.exit(1); });
"""


def names(source):
    return sorted(p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file())


def local_references(test, source):
    html = (source / 'index.html').read_text()
    for relative in re.findall(r'(?:src|href)="([^"]+)"', html):
        if relative == '/apps/sdk/apps-v1.js':
            continue
        test.assertFalse(urlsplit(relative).scheme or relative.startswith('/'), relative)
        test.assertTrue((source / urlsplit(relative).path).is_file(), relative)
    for css in (source / 'css').glob('*.css'):
        for url in pages_sync.URL.findall(css.read_text()):
            if url.startswith(('#', 'data:')):
                continue
            test.assertTrue((css.parent / urlsplit(url).path).resolve().is_file(), css.name + ' ' + url)
    test.assertNotIn('<!--', html)


class VisualsPlayerSource(unittest.TestCase):
    source = ROOT / 'apps/visuals-player/src'

    def test_budget_and_contents(self):
        files = names(self.source)
        self.assertLessEqual(sum((self.source / n).stat().st_size for n in files), 40 * 1024 * 1024)
        for forbidden in ('hand_landmarker', 'face_landmarker', 'nosimd'):
            self.assertFalse([n for n in files if forbidden in n], forbidden)
        self.assertEqual([n for n in files if n.endswith(('.task', '.wasm'))],
                         ['models/mediapipe/pose_landmarker-lite-float16-v1.task', 'vendor/mediapipe/tasks-vision-1.0.1/wasm/vision_wasm_internal.wasm'])
        curated = [item for item in pages_sync.selection(self.source)['items'] if item['collection'] == 'curated']
        packaged = json.loads((self.source / 'scenes/v1/catalog.json').read_text())['entries']
        self.assertEqual([e['scene_ref']['scene_id'] for e in packaged], [item['scene_id'] for item in curated])
        for item in curated:
            self.assertIn(item['thumbnail'], files)
        for track in json.loads((self.source / 'music/index.json').read_text())['tracks']:
            self.assertIn('music/' + track['file'], files)
            self.assertTrue(track['sections'] and track['bpm'] > 0, track['id'])
        pictures = json.loads((self.source / 'pictures/index.json').read_text())['pictures']
        self.assertGreaterEqual(len(pictures), 2)
        for picture in pictures:
            self.assertIn('pictures/' + picture['file'], files)
        capabilities = json.loads((self.source / 'app.json').read_text())['capabilities']
        self.assertTrue(all(capabilities[name] for name in ('controls', 'audio_input', 'audio_output', 'video_input')))
        self.assertIn('id="visual-settings"', (self.source / 'index.html').read_text())
        local_references(self, self.source)

    @unittest.skipUnless(shutil.which('node'), 'node is not installed')
    def test_content_hashes(self):
        rows = json.loads(subprocess.check_output(['node', '-e', HASHES, str(self.source)]))
        self.assertTrue(rows)
        for scene_id, listed, computed in rows:
            self.assertEqual(listed, computed, scene_id)


class ShaderEditorSource(unittest.TestCase):
    source = ROOT / 'apps/shader-editor/src'

    def test_contents(self):
        files = names(self.source)
        manifest = json.loads((self.source / 'app.json').read_text())
        self.assertEqual(set(manifest['capabilities']), {'audio_input', 'video_input', 'websocket'})
        self.assertEqual(len(manifest['capabilities']['websocket']), 16)
        for absent in ('scripts/vrch_pages_gateway_auth_utils.js', 'scripts/vrch_pages_scene_settings_bridge.js',
                       'scripts/vrch_pages_websocket_utils.js', 'models/mediapipe/face_landmarker-lite-v1.task'):
            self.assertNotIn(absent, files)
        self.assertFalse([n for n in files if 'nosimd' in n])
        for present in ('scripts/vrch_pages_landmark_worker.js', 'models/mediapipe/hand_landmarker-lite-v1.task',
                        'models/mediapipe/face_landmarker-float16-v1.task', 'models/mediapipe/pose_landmarker-lite-float16-v1.task',
                        'vendor/mediapipe/tasks-vision-1.0.1/wasm/vision_wasm_internal.wasm', 'licenses/three-LICENSE.txt',
                        'licenses/font-awesome-LICENSE.txt', 'webfonts/courier-prime-sans-LICENSE.txt'):
            self.assertIn(present, files)
        for entry in json.loads((self.source / 'scenes/v1/catalog.json').read_text())['entries']:
            definition = json.loads((self.source / 'scenes/v1' / entry['definition_path']).read_text())
            self.assertIn('runtime', definition)
            thumbnail = definition.get('catalog', {}).get('thumbnail_ref', '')
            if thumbnail.startswith('scenes/'):
                self.assertIn(thumbnail, files)
        awesome = (self.source / 'css/fontawesome-local.css').read_text()
        self.assertEqual(awesome.count('{'), awesome.count('}'))
        self.assertIn('font-family:"Font Awesome 6 Free"', awesome)
        local_references(self, self.source)


@unittest.skipUnless(HAS_PAGES, 'no VRCH Pages checkout')
class PagesSync(unittest.TestCase):
    def test_sources_match_pages(self):
        for app in pages_sync.APPS:
            self.assertEqual(pages_sync.compare(app, PAGES)[0], {'missing': [], 'extra': [], 'changed': []}, app)

    def test_reports_and_repairs_a_fork_keeping_the_apps_own_files(self):
        with tempfile.TemporaryDirectory(prefix='pages-sync-') as temporary:
            copy = Path(temporary) / 'src'
            shutil.copytree(ROOT / 'apps/visuals-player/src', copy)
            (copy / 'scripts/vrch_pages_scene_mirror.js').write_text('// forked\n')
            (copy / 'scripts/stale.js').write_text('// gone from Pages\n')
            (copy / 'scenes/v1/catalog.json').unlink()
            html = (copy / 'index.html').read_text()
            (copy / 'index.html').write_text(html.replace('aria-label="Visual Settings"', 'aria-label="Old Settings"', 1))
            (copy / 'notes.txt').write_text('the App own file\n')
            app = (copy / 'app.js').read_bytes()
            self.assertEqual(pages_sync.compare('visuals-player', PAGES, copy)[0],
                             {'missing': ['scenes/v1/catalog.json'], 'extra': ['scripts/stale.js'],
                              'changed': ['index.html', 'scripts/vrch_pages_scene_mirror.js']})
            pages_sync.write('visuals-player', PAGES, copy)
            self.assertEqual(pages_sync.compare('visuals-player', PAGES, copy)[0], {'missing': [], 'extra': [], 'changed': []})
            self.assertEqual((copy / 'app.js').read_bytes(), app)
            self.assertTrue((copy / 'notes.txt').is_file())


if __name__ == '__main__':
    unittest.main()

