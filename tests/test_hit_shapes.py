"""Build-time rules for Hit Shapes: package size, declared capabilities, one name, self-contained flat drawing."""
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'apps/hit-shapes/src'
spec = importlib.util.spec_from_file_location('apps', ROOT / 'tools/apps.py')
apps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apps)


class HitShapes(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((SRC / 'app.json').read_text())
        self.text = {path.relative_to(SRC).as_posix(): path.read_text() for path in SRC.rglob('*') if path.is_file()}

    def test_package_is_at_most_half_a_megabyte(self):
        with tempfile.TemporaryDirectory() as temporary:
            package, release = apps.build('hit-shapes', output=Path(temporary), source_commit='0' * 40)
            self.assertLessEqual(package.stat().st_size, 500_000)
            self.assertEqual(release['size'], package.stat().st_size)

    def test_declares_only_controls_sound_and_the_output_picture(self):
        self.assertEqual(self.manifest['capabilities'], {'controls': True, 'audio_output': True})
        self.assertEqual(self.manifest['roles'], ['output'])
        self.assertEqual([section['title'] for section in self.manifest['guide']['sections'][:3]], ['Quick start', 'Common controls', 'Touch'])
        self.assertEqual(len(self.manifest['guide']['sections'][0]['controls']), 3)

    def test_the_name_is_written_once(self):
        # The name and directory are provisional: the source names the App only in app.json, so a rename is one edit.
        name = self.manifest['name']
        self.assertEqual([path for path, text in self.text.items() if name.lower() in text.lower()], ['app.json'])
        self.assertEqual(self.text['app.json'].count(name), 1)
        self.assertEqual([path for path, text in self.text.items() if SRC.parent.name in text], [])

    def test_nothing_is_loaded_from_elsewhere(self):
        for path, text in self.text.items():
            links = [link for link in re.findall(r'(?:https?:)?//[\w.-]+\.\w+[^\s"\']*', text) if not link.startswith('http://www.w3.org/')]
            self.assertEqual(links, [], path)
        scripts = re.findall(r'<script[^>]*src="([^"]+)"', self.text['index.html'])
        self.assertEqual(scripts, ['/apps/sdk/apps-v1.js', 'shapes.js', 'stage.js', 'app.js'])

    def test_the_picture_is_flat_wordless_and_never_random(self):
        for path in ('shapes.js', 'stage.js', 'app.js', 'engine.js'):
            self.assertNotIn('Math.random', self.text[path], path)
        for path in ('shapes.js', 'stage.js'):
            for banned in ('fillText', 'strokeText', 'Gradient', 'shadowBlur', 'filter'):
                self.assertNotIn(banned, self.text[path], path + ' uses ' + banned)

    def test_each_voice_is_one_short_entry_in_engine_order(self):
        shapes = self.text['shapes.js']
        entries = re.findall(r"\n  \{\n    id: '(\w\w)', name: '[^']+', color: [0-3], lane: [0-9.]+, seconds: [0-9.]+,\n(.*?)\n  \},", shapes, re.S)
        ids = [identifier for identifier, _ in entries]
        self.assertEqual(len(ids), 8)
        order = re.search(r'const ((?:\w\w = \d, )+\w\w = \d);', self.text['engine.js']).group(1)
        self.assertEqual(ids, [name for name, _ in sorted((pair.split(' = ') for pair in order.split(', ')), key=lambda pair: int(pair[1]))])
        for identifier, body in entries:
            draw = body[body.index('    draw(g, p) {'):]
            self.assertLessEqual(len(draw.splitlines()), 40, identifier)


if __name__ == '__main__':
    unittest.main()
