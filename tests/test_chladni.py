"""Build-time rules for Chladni: package size, declared capabilities, one name, self-contained, and plates that are complete."""
import importlib.util
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SLUG = 'chladni'
SRC = ROOT / 'apps' / SLUG / 'src'
spec = importlib.util.spec_from_file_location('apps', ROOT / 'tools/apps.py')
apps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apps)


def modes():
    """The plates in modes.js, read by Node (the file is plain JavaScript)."""
    script = 'global.window = {}; require(process.argv[1]); process.stdout.write(JSON.stringify(window.Modes));'
    return json.loads(subprocess.check_output(['node', '-e', script, str(SRC / 'modes.js')]))


def function(body, arguments):
    """A plate's GLSL function body as a Python function (the bodies keep to plain arithmetic)."""
    names = {name: getattr(math, name) for name in ('sin', 'cos', 'sqrt', 'atan', 'floor')}
    names.update({'abs': abs, 'pow': pow, 'min': min, 'max': max, 'PI': math.pi, '__builtins__': {}})
    lines = []
    for line in body.replace('p.x', 'px').replace('p.y', 'py').replace('c.x', 'cx').replace('c.y', 'cy').splitlines():
        match = re.fullmatch(r'\s*if \((.+)\) return (.+);\s*', line)
        lines.append('    if %s: return %s' % match.groups() if match else '    ' + line.strip().rstrip(';'))
    scope = dict(names)
    exec('def f(%s):\n%s' % (arguments, '\n'.join(lines)), scope)
    return scope['f']


class Chladni(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((SRC / 'app.json').read_text())
        self.files = [path for path in SRC.rglob('*') if path.is_file()]
        self.text = {path.relative_to(SRC).as_posix(): path.read_text() for path in self.files}

    def test_the_package_is_at_most_0_3_megabytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            package, release = apps.build(SLUG, output=Path(temporary), source_commit='0' * 40)
            self.assertLessEqual(package.stat().st_size, int(0.3 * 1024 * 1024))
            self.assertEqual(release['size'], package.stat().st_size)

    def test_declares_controls_sound_out_and_the_output_picture(self):
        self.assertEqual(self.manifest['capabilities'], {'controls': True, 'audio_output': True})
        self.assertEqual(self.manifest['roles'], ['output'])
        self.assertEqual([section['title'] for section in self.manifest['guide']['sections'][:3]], ['Quick start', 'Common controls', 'Touch'])
        self.assertEqual(len(self.manifest['guide']['sections'][0]['controls']), 3)
        # Every knob and key the App reads is in the guide, and nothing is held for a second job.
        listed = [row['control'] for section in self.manifest['guide']['sections'] for row in section.get('controls', [])]
        for control in ('E1 · Turn', 'E1 · Press', 'E2 · Turn', 'E2 · Press', 'E3 · Turn', 'E3 · Press', 'E4 · Turn', 'E4 · Press', 'K2 · Press', 'K3 · Press', 'K3 · Hold', 'K4 · Press'):
            self.assertIn(control, listed)
        self.assertEqual([control for control in listed if 'Hold' in control], ['K3 · Hold'])

    def test_it_does_not_claim_to_be_a_real_plate(self):
        guide = json.dumps(self.manifest['guide']).lower()
        for claim in ('simulat', 'physical', 'physics', 'real resonance', 'accurate'):
            self.assertNotIn(claim, guide)

    def test_the_name_is_written_once(self):
        # The name and directory are provisional: the source names the App only in app.json, so a rename is one edit.
        # The one other place is the test entry point the browser tests look for.
        name = self.manifest['name'].lower()
        self.assertEqual(self.text['app.json'].lower().count(name), 1)
        self.assertEqual([line.strip() for line in self.text['app.js'].splitlines() if name in line.lower()], ['window.__%s = {' % name])
        self.assertEqual([path for path, text in self.text.items() if name in text.lower() and path not in ('app.json', 'app.js')], [])

    def test_nothing_is_loaded_from_elsewhere_and_no_dice_are_thrown(self):
        for path, text in self.text.items():
            links = [link for link in re.findall(r'(?:https?:)?//[\w.-]+\.\w+[^\s"\']*', text) if not link.startswith('http://www.w3.org/')]
            self.assertEqual(links, [], path)
            self.assertNotIn('Math.random', text, path)
        self.assertEqual(re.findall(r'<script[^>]*src="([^"]+)"', self.text['index.html']), ['/apps/sdk/apps-v1.js', 'modes.js', 'sand.js', 'tone.js', 'app.js'])

    def test_the_source_is_not_packed(self):
        for path in ('modes.js', 'sand.js', 'tone.js', 'app.js'):
            self.assertLessEqual(max(len(line) for line in self.text[path].splitlines()), 320, path)

    def test_the_plate_is_in_one_file_and_the_sand_in_another(self):
        # modes.js says how the plate vibrates and nothing about sand; sand.js moves and draws sand and holds no formula of a plate.
        self.assertNotIn('gl_', self.text['modes.js'])
        self.assertNotIn('cos(n', self.text['sand.js'])
        self.assertNotIn('cos(n', self.text['app.js'])
        self.assertIn('To add a plate', self.text['modes.js'])

    @unittest.skipUnless(shutil.which('node'), 'Node reads modes.js')
    def test_every_plate_is_one_complete_entry(self):
        listed = modes()
        self.assertEqual([plate['id'] for plate in listed['plates']], ['square', 'round'])
        self.assertEqual([listed['lowest'], listed['highest']], [1, 12])
        for plate in listed['plates']:
            self.assertRegex(plate['id'], r'^[a-z0-9-]{1,24}$')
            self.assertTrue(plate['name'])
            self.assertEqual(len(plate['overtones']), 3, plate['id'])
            self.assertTrue(all(multiple > 1 and 0 < level <= 1 for multiple, level in plate['overtones']), plate['id'])
            self.assertLessEqual(sum(level for _, level in plate['overtones']), 0.5, plate['id'])

    @unittest.skipUnless(shutil.which('node'), 'Node reads modes.js')
    def test_every_mode_of_every_plate_stays_between_minus_one_and_one_and_has_still_lines(self):
        listed = modes()
        for plate in listed['plates']:
            rim, amplitude = function(plate['rim'], 't'), function(plate['amplitude'], 'px, py, cx, cy, n, m')
            # The rim: one distance for every direction, inside the square.
            for k in range(360):
                t = k * math.pi / 180
                far = rim(t)
                self.assertTrue(0.2 <= far <= 0.5 / max(abs(math.cos(t)), abs(math.sin(t))) + 1e-9, (plate['id'], k, far))
            for n in range(listed['lowest'], listed['highest'] + 1):
                for m in range(listed['lowest'], listed['highest'] + 1):
                    values = []
                    for j in range(33):
                        for i in range(33):
                            x, y = (i + 0.5) / 33, (j + 0.5) / 33
                            t, r = math.atan2(y - 0.5, x - 0.5), math.hypot(x - 0.5, y - 0.5)
                            if r > rim(t):
                                continue
                            values.append(amplitude(x, y, r / rim(t), t, float(n), float(m)))
                    self.assertTrue(all(-1.000001 <= value <= 1.000001 for value in values), (plate['id'], n, m))
                    # Sand needs somewhere to go and something to leave: both signs, and a good share of the plate moving.
                    self.assertTrue(min(values) < -0.3 and max(values) > 0.3, (plate['id'], n, m, min(values), max(values)))

    def test_the_square_plate_is_the_published_formula(self):
        # cos(n pi x) cos(m pi y) - cos(m pi x) cos(n pi y), halved to stay within -1..1; with n = m the single term.
        amplitude = function(modes()['plates'][0]['amplitude'], 'px, py, cx, cy, n, m')
        for n, m, x, y in ((3, 5, 0.21, 0.67), (1, 4, 0.4, 0.9), (7, 2, 0.83, 0.12)):
            want = 0.5 * (math.cos(n * math.pi * x) * math.cos(m * math.pi * y) - math.cos(m * math.pi * x) * math.cos(n * math.pi * y))
            self.assertAlmostEqual(amplitude(x, y, 0, 0, float(n), float(m)), want, places=12)
        self.assertAlmostEqual(amplitude(0.3, 0.8, 0, 0, 4.0, 4.0), math.cos(4 * math.pi * 0.3) * math.cos(4 * math.pi * 0.8), places=12)


if __name__ == '__main__':
    unittest.main()
