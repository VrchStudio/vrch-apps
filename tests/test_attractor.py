"""Build-time rules for Attractor: package size, declared capabilities, one name, self-contained, and presets that fill the picture."""
import importlib.util
import json
import math
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SLUG = 'attractor'
SRC = ROOT / 'apps' / SLUG / 'src'
spec = importlib.util.spec_from_file_location('apps', ROOT / 'tools/apps.py')
apps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apps)
ENTRY = re.compile(r"\{\s*id: '([a-z0-9-]+)',\s*name: '([^']+)',\s*text: \['([^']+)', '([^']+)'\],\s*range: \[(-?[\d.]+), (-?[\d.]+)\],\s*view: ([\d.]+),\s*step: '([^']+)',\s*presets: \[(.*?)\],\s*\},", re.S)


def formulas(text):
    found = []
    for identifier, name, first, second, low, high, view, step, presets in ENTRY.findall(text):
        sets = [tuple(float(v) for v in row.split(',')) for row in re.findall(r'\[([^\]]+)\]', presets)]
        found.append({'id': identifier, 'name': name, 'text': (first, second), 'range': (float(low), float(high)), 'view': float(view), 'step': step, 'presets': sets, 'raw': presets})
    return found


def stepper(expression):
    """The GLSL step as a Python function of (x, y, a, b, c, d)."""
    source = re.sub(r'\bvec2\(', '(', expression).replace('p.x', 'x').replace('p.y', 'y')
    names = {name: getattr(math, name) for name in ('sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'atan', 'floor')}
    names.update({'abs': abs, 'pow': pow, 'min': min, 'max': max, '__builtins__': {}})
    return eval('lambda x, y, a, b, c, d: ' + source, names)


class Attractor(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((SRC / 'app.json').read_text())
        self.text = {path.relative_to(SRC).as_posix(): path.read_text() for path in SRC.rglob('*') if path.is_file()}
        self.formulas = formulas(self.text['formulas.js'])

    def test_package_is_at_most_0_3_megabytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            package, release = apps.build(SLUG, output=Path(temporary), source_commit='0' * 40)
            self.assertLessEqual(package.stat().st_size, int(0.3 * 1024 * 1024))
            self.assertEqual(release['size'], package.stat().st_size)

    def test_declares_only_controls_and_the_output_picture(self):
        self.assertEqual(self.manifest['capabilities'], {'controls': True})
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
        self.assertEqual(re.findall(r'<script[^>]*src="([^"]+)"', self.text['index.html']), ['/apps/sdk/apps-v1.js', 'formulas.js', 'picture.js', 'app.js'])

    def test_the_source_is_not_packed(self):
        for path in ('formulas.js', 'picture.js', 'app.js'):
            self.assertLessEqual(max(len(line) for line in self.text[path].splitlines()), 320, path)

    def test_every_formula_is_one_complete_entry(self):
        self.assertEqual(len(self.formulas), self.text['formulas.js'].count("\n    id: '"))
        self.assertEqual([formula['id'] for formula in self.formulas], ['dejong', 'clifford', 'svensson', 'dream'])
        self.assertEqual(self.formulas[0]['presets'][0], (1.49, -2.28, 2.36, -2.13))
        for formula in self.formulas:
            low, high = formula['range']
            self.assertGreaterEqual(len(formula['presets']), 6, formula['id'])
            self.assertEqual(len(set(formula['presets'])), len(formula['presets']), formula['id'])
            for preset in formula['presets']:
                self.assertEqual(len(preset), 4)
                for value in preset:
                    self.assertTrue(low <= value <= high and abs(value * 100 - round(value * 100)) < 1e-9, (formula['id'], preset))

    def test_every_preset_fills_the_square_without_leaving_it(self):
        for formula in self.formulas:
            step, view = stepper(formula['step']), formula['view']
            for preset in formula['presets']:
                x = y = 0.1
                cells, far = set(), 0.0
                for i in range(6000):
                    x, y = step(x, y, *preset)
                    if i >= 500:
                        far = max(far, abs(x), abs(y))
                        cells.add((int((x / view * 0.5 + 0.5) * 64), int((y / view * 0.5 + 0.5) * 64)))
                self.assertLessEqual(far, view, (formula['id'], preset, 'leaves the square'))
                self.assertGreaterEqual(len(cells), 250, (formula['id'], preset, 'collapses'))

    def test_a_collapsed_setting_is_told_apart(self):
        # De Jong with every letter at 0 lands on one point: the App marks such a figure on the device screen.
        step = stepper(self.formulas[0]['step'])
        x = y = 0.1
        for _ in range(200):
            x, y = step(x, y, 0.0, 0.0, 0.0, 0.0)
        self.assertEqual((x, y), (-1.0, -1.0))


if __name__ == '__main__':
    unittest.main()
