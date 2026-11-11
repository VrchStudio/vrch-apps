"""Build-time rules for Attractor: package size, declared capabilities, one name, self-contained, and presets that fill the picture."""
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
SLUG = 'attractor'
SRC = ROOT / 'apps' / SLUG / 'src'
SHARED = ('css', 'scripts', 'webfonts')
spec = importlib.util.spec_from_file_location('apps', ROOT / 'tools/apps.py')
apps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apps)
NAMES = {name: getattr(math, name) for name in ('sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'atan', 'floor')}
NAMES.update({'abs': abs, 'pow': pow, 'min': min, 'max': max, 'sign': lambda v: (v > 0) - (v < 0), '__builtins__': {}})


def formulas():
    """The list in formulas.js, read by Node (the file is plain JavaScript)."""
    script = 'global.window = {}; require(process.argv[1]); process.stdout.write(JSON.stringify(window.Formulas));'
    return json.loads(subprocess.check_output(['node', '-e', script, str(SRC / 'formulas.js')]))


def tracks():
    """The list in tracks.js, read by Node."""
    script = 'global.window = {}; require(process.argv[1]); process.stdout.write(JSON.stringify(window.Tracks));'
    return json.loads(subprocess.check_output(['node', '-e', script, str(SRC / 'tracks.js')]))


def rule(formula):
    """The formula's expressions as a Python function (x, y, z, a, b, c, d) -> the next point, or the rate of change."""
    tidy = lambda text: re.sub(r'\bvec[23]\(', '(', text).replace('p.x', 'x').replace('p.y', 'y').replace('p.z', 'z')
    lines = ['def f(x, y, z, a, b, c, d):'] + ['    ' + tidy(line) for line in formula.get('with', [])] + ['    return ' + tidy(formula.get('flow') or formula['step'])]
    scope = dict(NAMES)
    exec('\n'.join(lines), scope)
    return scope['f']


def advance(formula, f, p, k):
    """One step of a map, or one Runge-Kutta step of a flow."""
    if 'flow' not in formula:
        x, y = f(p[0], p[1], 0.0, *k)
        return (x, y, 0.0)
    dt = formula['dt']
    k1 = f(*p, *k)
    k2 = f(*[p[i] + 0.5 * dt * k1[i] for i in range(3)], *k)
    k3 = f(*[p[i] + 0.5 * dt * k2[i] for i in range(3)], *k)
    k4 = f(*[p[i] + dt * k3[i] for i in range(3)], *k)
    return tuple(p[i] + dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) for i in range(3))


class Attractor(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((SRC / 'app.json').read_text())
        # The App's own text files. (css/, scripts/ and webfonts/ are the shared VRCH interface files, copied from Pages.)
        self.own = [path for path in SRC.rglob('*') if path.is_file() and path.suffix != '.mp3' and path.relative_to(SRC).parts[0] not in SHARED]
        self.text = {path.relative_to(SRC).as_posix(): path.read_text() for path in self.own}

    def test_the_code_is_at_most_0_3_megabytes_and_the_package_8(self):
        # The music (two pieces) and the shared interface files are the large parts; the App's own code stays small.
        self.assertLessEqual(sum(path.stat().st_size for path in self.own), int(0.3 * 1024 * 1024))
        self.assertLessEqual(len([path for path in SRC.rglob('*.mp3')]), 2)
        self.assertEqual(sorted(path.relative_to(SRC).as_posix() for path in SRC.rglob('*.mp3')), sorted(track['file'] for track in tracks()))
        with tempfile.TemporaryDirectory() as temporary:
            package, release = apps.build(SLUG, output=Path(temporary), source_commit='0' * 40)
            self.assertLessEqual(package.stat().st_size, 8 * 1024 * 1024)
            self.assertEqual(release['size'], package.stat().st_size)

    def test_declares_controls_sound_and_the_output_picture(self):
        self.assertEqual(self.manifest['capabilities'], {'controls': True, 'audio_input': True, 'audio_output': True})
        self.assertEqual(self.manifest['roles'], ['output'])
        self.assertEqual([section['title'] for section in self.manifest['guide']['sections'][:3]], ['Quick start', 'Common controls', 'Touch'])
        quick = self.manifest['guide']['sections'][0]['controls']
        self.assertEqual(len(quick), 3)
        self.assertIn('a, b, c and d', quick[0]['action'])

    def test_the_name_is_written_once(self):
        # The name and directory are provisional: the source names the App only in app.json, so a rename is one edit.
        # The one other place is the test entry point the browser tests look for.
        name = self.manifest['name'].lower()
        self.assertEqual(self.text['app.json'].lower().count(name), 1)
        self.assertEqual([line.strip() for line in self.text['app.js'].splitlines() if name in line.lower()], ['window.__%s = {' % name])
        self.assertEqual([path for path, text in self.text.items() if name in text.lower() and path not in ('app.json', 'app.js')], [])

    def test_nothing_is_loaded_from_elsewhere_and_nothing_is_random(self):
        for path, text in self.text.items():
            links = [link for link in re.findall(r'(?:https?:)?//[\w.-]+\.\w+[^\s"\']*', text) if not link.startswith('http://www.w3.org/')]
            self.assertEqual(links, [], path)
            self.assertNotIn('Math.random', text, path)
        self.assertEqual(re.findall(r'<script[^>]*src="([^"]+)"', self.text['index.html']), ['/apps/sdk/apps-v1.js', 'scripts/vrch_pages_dialogs.js', 'formulas.js', 'thread.js', 'picture.js', 'tracks.js', 'music.js', 'app.js'])

    def test_the_source_is_not_packed(self):
        # (tracks.js is data written by the music tool.)
        for path in ('formulas.js', 'thread.js', 'picture.js', 'music.js', 'app.js'):
            self.assertLessEqual(max(len(line) for line in self.text[path].splitlines()), 320, path)

    @unittest.skipUnless(shutil.which('node'), 'Node reads formulas.js')
    def test_every_formula_is_one_complete_entry(self):
        listed = formulas()
        self.assertEqual([formula['id'] for formula in listed], ['dejong', 'clifford', 'svensson', 'dream', 'mira', 'ikeda', 'lorenz', 'aizawa', 'thomas'])
        self.assertEqual(listed[0]['presets'][0], [1.49, -2.28, 2.36, -2.13])
        for formula in listed:
            low, high = formula['range']
            self.assertRegex(formula['id'], r'^[a-z0-9-]{1,24}$')
            self.assertTrue(formula['name'] and 2 <= len(formula['text']) <= 3 and formula['view'] > 0, formula['id'])
            self.assertEqual('flow' in formula, 'dt' in formula, formula['id'])
            self.assertEqual('flow' in formula, formula.get('thread', 0) > 0, formula['id'])
            self.assertTrue(len(formula.get('sway', [1, 1, 1, 1])) == 4 and all(0 <= share <= 1 for share in formula.get('sway', [])), formula['id'])
            self.assertNotEqual('flow' in formula, 'step' in formula, formula['id'])
            self.assertGreaterEqual(len(formula['presets']), 6, formula['id'])
            self.assertEqual(len({tuple(preset) for preset in formula['presets']}), len(formula['presets']), formula['id'])
            for preset in formula['presets']:
                self.assertEqual(len(preset), 4)
                for value in preset:
                    self.assertTrue(low <= value <= high and abs(value * 100 - round(value * 100)) < 1e-9, (formula['id'], preset))

    @unittest.skipUnless(shutil.which('node'), 'Node reads formulas.js')
    def test_every_preset_fills_the_view_without_leaving_it(self):
        for formula in formulas():
            f, view, flow = rule(formula), formula['view'], 'flow' in formula
            centre = (formula.get('centre', []) + [0, 0, 0])[:3]
            for preset in formula['presets']:
                p = (centre[0] + 0.1 * view, centre[1] + 0.07 * view, centre[2] + (0.05 * view if flow else 0.0))
                cells, far = set(), 0.0
                for i in range(9000 if flow else 6000):
                    p = advance(formula, f, p, preset)
                    if i >= (3000 if flow else 500):
                        r = [p[j] - centre[j] for j in range(3)]
                        # A flow turns about its upright axis: what must fit is its distance from that axis and its height.
                        across, up = (math.hypot(r[0], r[1]), r[2]) if flow else (r[0], r[1])
                        far = max(far, abs(across), abs(up))
                        cells.add((int((r[0] / view * 0.5 + 0.5) * 64), int(((r[2] if flow else r[1]) / view * 0.5 + 0.5) * 64)))
                self.assertLessEqual(far, view, (formula['id'], preset, 'leaves the view'))
                # One path of a flow is a thin thread; a map's points scatter over its whole figure.
                self.assertGreaterEqual(len(cells), 100 if flow else 250, (formula['id'], preset, 'collapses'))

    @unittest.skipUnless(shutil.which('node'), 'Node reads formulas.js')
    def test_a_collapsed_setting_is_told_apart(self):
        # De Jong with every letter at 0 lands on one point: the App marks such a figure on the device screen.
        formula = formulas()[0]
        f, p = rule(formula), (0.1, 0.1, 0.0)
        for _ in range(200):
            p = advance(formula, f, p, (0.0, 0.0, 0.0, 0.0))
        self.assertEqual(p, (-1.0, -1.0, 0.0))

    @unittest.skipUnless(shutil.which('node'), 'Node reads tracks.js')
    def test_each_piece_comes_with_what_the_figure_follows(self):
        import base64
        listed = tracks()
        self.assertEqual([track['title'] for track in listed], ['Strange Loop', 'Sacred Orbit'])
        for track in listed:
            levels = base64.b64decode(track['levels'])
            # Three bands for every 20 ms of the piece, and not silence.
            self.assertEqual(len(levels) % 3, 0, track['id'])
            self.assertAlmostEqual(len(levels) / 3 * 0.02, track['duration'], delta=0.05, msg=track['id'])
            self.assertGreater(max(levels), 100, track['id'])
            self.assertTrue(80 <= track['bpm'] <= 140 and len(track['sections']) >= 3, track['id'])
            self.assertEqual(track['sections'], sorted(track['sections']), track['id'])
            self.assertTrue(all(6 <= at <= track['duration'] - 6 for at in track['sections']), track['id'])

    @unittest.skipUnless(shutil.which('node'), 'Node runs thread.js')
    def test_a_flows_line_follows_its_formula(self):
        # thread.js compiles the expressions in formulas.js for itself: its path must be the one the formula gives.
        script = (
            "global.window = global; global.performance = require('perf_hooks').performance;"
            "global.document = {createElement: () => ({remove() {}}), head: {appendChild(s) { (0, eval)(s.textContent); }}};"
            "require(process.argv[1]); require(process.argv[2]); const out = {};"
            "for (const f of window.Formulas.filter(f => f.flow)) { const points = new Float32Array(900), job = window.Thread.path(f, f.presets[0], 300, f.dt, points, 1);"
            " out[f.id] = [job.run(1e9), Array.from(points)]; }"
            "process.stdout.write(JSON.stringify(out));")
        got = json.loads(subprocess.check_output(['node', '-e', script, str(SRC / 'formulas.js'), str(SRC / 'thread.js')]))
        for formula in [f for f in formulas() if 'flow' in f]:
            done, points = got[formula['id']]
            self.assertEqual(done, 'done', formula['id'])
            f, view, centre = rule(formula), formula['view'], (formula.get('centre', []) + [0, 0, 0])[:3]
            p = (centre[0] + 0.137 * view / 3, centre[1] + 0.137 * view * 2 / 3, centre[2] + 0.137 * view)
            for i in range(300):
                for j in range(3):
                    self.assertAlmostEqual(points[3 * i + j], p[j], delta=1e-3 * view, msg=(formula['id'], i))
                p = advance(formula, f, p, formula['presets'][0])


if __name__ == '__main__':
    unittest.main()
