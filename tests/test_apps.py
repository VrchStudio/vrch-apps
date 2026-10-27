import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec=importlib.util.spec_from_file_location('apps',Path(__file__).resolve().parents[1]/'tools/apps.py')
apps=importlib.util.module_from_spec(spec)
spec.loader.exec_module(apps)


class Packages(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.src=self.root/'apps/demo/src'
        self.src.mkdir(parents=True)
        self.manifest={'schema_version':1,'sdk_version':1,'data_schema_version':1,
                       'id':'f8f1c78b-6c03-4ed8-9d65-8237803d09e9','name':'Demo','version':'1.0.0',
                       'entry':'index.html','capabilities':{'controls':True},'future':{'keep':True}}
        (self.src/'app.json').write_text(json.dumps(self.manifest))
        (self.src/'index.html').write_bytes(b'<p>demo</p>\n')
        (self.src/'unknown.bin').write_bytes(bytes(range(256)))
        (self.src.parent/'CHANGELOG.md').write_text('# Demo\n\n## 1.0.0\n\nFirst version.\n')

    def build(self):
        return apps.build('demo',root=self.root,source_commit='a'*40)

    def test_deterministic_and_preserves_all_bytes(self):
        path,first=self.build()
        original=path.read_bytes()
        for file in self.src.iterdir():
            file.touch()
        again,second=self.build()
        self.assertEqual(original,again.read_bytes())
        self.assertEqual(first,second)
        with zipfile.ZipFile(path) as package:
            for name in package.namelist():
                self.assertEqual(package.read(name),(self.src/name).read_bytes())
                self.assertEqual(package.getinfo(name).compress_type,zipfile.ZIP_STORED)
                self.assertEqual(package.getinfo(name).date_time,(1980,1,1,0,0,0))

    def test_contents_not_mtime_determine_revision(self):
        _,before=self.build()
        (self.src/'unknown.bin').write_bytes(b'changed')
        _,after=self.build()
        self.assertNotEqual(before['revision'],after['revision'])
        self.assertNotEqual(before['sha256'],after['sha256'])

    def test_symlink_rejected(self):
        (self.src/'escape').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError,'symlinks'):
            self.build()

    def test_case_collision_rejected(self):
        (self.src/'INDEX.HTML').write_bytes(b'collision')
        with self.assertRaisesRegex(ValueError,'conflicting'):
            self.build()

    def test_schema_change_rejected(self):
        self.manifest['data_schema_version']=2
        (self.src/'app.json').write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError,'schema'):
            self.build()

    def test_nonstable_version_rejected(self):
        self.manifest['version']='1.0.0-preview.1'
        (self.src/'app.json').write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError,'stable'):
            self.build()

    def test_missing_release_notes_rejected(self):
        (self.src.parent/'CHANGELOG.md').write_text('# Demo\n')
        with self.assertRaisesRegex(ValueError,'CHANGELOG'):
            self.build()

    def test_catalog_idempotent_and_preserves_other_apps(self):
        _,release=self.build()
        catalog={'schemaVersion':1,'apps':{'other':{'untouched':True}}}
        before=copy.deepcopy(catalog)
        updated=apps.update_catalog(catalog,release)
        self.assertEqual(catalog,before)
        self.assertEqual(updated['apps']['other'],before['apps']['other'])
        self.assertEqual(apps.update_catalog(updated,release),updated)

    def test_catalog_rejects_replacing_published_content(self):
        _,release=self.build()
        catalog=apps.update_catalog({'schemaVersion':1,'apps':{}},release)
        release['revision']='0'*64
        with self.assertRaisesRegex(ValueError,'different'):
            apps.update_catalog(catalog,release)

    def test_catalog_rejects_downgrade(self):
        _,release=self.build()
        newer={**release,'version':'1.1.0','tag':'demo-v1.1.0'}
        catalog=apps.update_catalog({'schemaVersion':1,'apps':{}},newer)
        with self.assertRaisesRegex(ValueError,'older'):
            apps.update_catalog(catalog,release)

    def test_catalog_rejects_identity_collision(self):
        _,release=self.build()
        catalog=apps.update_catalog({'schemaVersion':1,'apps':{}},release)
        release['slug']='another-app'
        with self.assertRaisesRegex(ValueError,'identity'):
            apps.update_catalog(catalog,release)

    def test_publish_requires_workflow(self):
        with self.assertRaisesRegex(ValueError,'workflow'):
            apps.publish('demo','1.0.0')


class HardwareBaseline(unittest.TestCase):
    def test_build_matches_accepted_release(self):
        root=Path(__file__).resolve().parents[1]
        manifest=json.loads((root/'apps/hardware-check/src/app.json').read_text())
        if manifest['version']!='1.6.1':
            self.skipTest('Historical 1.6.1 byte baseline applies to its release only.')
        with tempfile.TemporaryDirectory() as directory:
            path,release=apps.build('hardware-check',root=root,output=Path(directory),source_commit='a'*40)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),'e5cf9d6b4ca9a2908afb65774e743badaa4276d6c1c9e839d4ff990658a7802f')
            self.assertEqual(release['revision'],'8ab39b62a645194f314ba560eebee0bef0bd590b9b4fdea109e1e20e31913fa5')


if __name__=='__main__':
    unittest.main()
