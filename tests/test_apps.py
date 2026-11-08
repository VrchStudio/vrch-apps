import copy
import hashlib
import importlib.util
import json
import os
import struct
from pathlib import Path
import tempfile
import unittest
from unittest import mock
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
                       'entry':'index.html','icon':'icon.svg','capabilities':{'controls':True},'future':{'keep':True}}
        (self.src/'app.json').write_text(json.dumps(self.manifest))
        (self.src/'index.html').write_bytes(b'<p>demo</p>\n')
        (self.src/'icon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M4 4h24v24H4Z"/></svg>')
        (self.src/'unknown.bin').write_bytes(bytes(range(256)))
        (self.src.parent/'CHANGELOG.md').write_text('# Demo\n\n## 1.0.0\n\nFirst version.\n')

    def build(self):
        return apps.build('demo',root=self.root,source_commit='a'*40)

    def test_deferred_files_come_last_in_presentation_order(self):
        (self.src/'media').mkdir()
        for name in ('a.mp3','a.vpf','b.mp3'):
            (self.src/'media'/name).write_bytes(name.encode())
        (self.root/'catalog').mkdir()
        presentation={'schemaVersion':1,'categories':[{'id':'tools','label':'Tools'}],'apps':{'demo':{'category':'tools','deferred':['media/a.vpf','media/a.mp3','media/']}}}
        (self.root/'catalog/presentation.json').write_text(json.dumps(presentation))
        path,release=self.build()
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(archive.namelist(),['app.json','icon.svg','index.html','unknown.bin','media/a.vpf','media/a.mp3','media/b.mp3'])
        manifest,records,revision=apps.source('demo',root=self.root)
        self.assertEqual(release['revision'],revision)
        # Without deferred files the package keeps path order.
        (self.root/'catalog/presentation.json').write_text(json.dumps({**presentation,'apps':{'demo':{'category':'tools'}}}))
        path,_=self.build()
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(archive.namelist(),[name for name,_ in records])

    def test_official_icon_required(self):
        for value in (None, '', 'missing.svg', 'index.html', 'https://example.com/icon.svg'):
            with self.subTest(icon=value):
                self.manifest['icon']=value
                (self.src/'app.json').write_text(json.dumps(self.manifest))
                with self.assertRaisesRegex(ValueError,'icon'):
                    self.build()

    def test_empty_and_oversized_icon_rejected(self):
        for data in (b'', b'x'*65537):
            (self.src/'icon.svg').write_bytes(data)
            with self.assertRaisesRegex(ValueError,'icon'):
                self.build()

    def test_legacy_baseline_only_allows_exact_original(self):
        self.manifest.pop('icon')
        (self.src/'app.json').write_text(json.dumps(self.manifest))
        (self.src/'icon.svg').unlink()
        records=[(p.name,p.read_bytes()) for p in sorted(self.src.iterdir())]
        revision=hashlib.sha256()
        package=self.root/'original.vrchapp'
        with zipfile.ZipFile(package,'w',compression=zipfile.ZIP_STORED) as archive:
            for name,data in records:
                encoded=name.encode();revision.update(struct.pack('>I',len(encoded))+encoded+struct.pack('>Q',len(data))+hashlib.sha256(data).digest())
                info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.create_system=3;info.external_attr=0o100644<<16
                archive.writestr(info,data)
        baseline={'appId':self.manifest['id'],'version':'1.0.0','revision':revision.hexdigest(),'packageDigest':hashlib.sha256(package.read_bytes()).hexdigest()}
        pin=self.root/'apps/demo/legacy-baseline.json';pin.write_text(json.dumps(baseline))
        built,_=self.build();self.assertEqual(built.read_bytes(),package.read_bytes())
        baseline['packageDigest']='0'*64;pin.write_text(json.dumps(baseline))
        with self.assertRaisesRegex(ValueError,'baseline'):self.build()
        baseline['packageDigest']=hashlib.sha256(package.read_bytes()).hexdigest();pin.write_text(json.dumps(baseline))
        (self.src/'index.html').write_text('Edited original')
        with self.assertRaises(ValueError):self.build()
        self.manifest['version']='1.0.1';(self.src/'app.json').write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError,'icon'):self.build()

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

    def test_retry_after_catalog_commit_keeps_original_source(self):
        _,release=self.build()
        catalog=apps.update_catalog({'schemaVersion':1,'apps':{}},release)
        retry={**release,'sourceCommit':'b'*40}
        self.assertEqual(apps.published_metadata(catalog,retry),release)
        retry['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'different'):
            apps.published_metadata(catalog,retry)

    def test_catalog_metadata_preserve_immutable_releases(self):
        self.manifest['guide']={'description':'Play the demo.','sections':[{'title':'Quick start','controls':[{'control':'E1','action':'Start.'}]}]}
        (self.src/'app.json').write_text(json.dumps(self.manifest))
        _,release=self.build()
        catalog=apps.update_catalog({'schemaVersion':1,'apps':{}},release)
        with mock.patch.object(apps,'ROOT',self.root):
            result=apps.catalog_metadata(catalog)
        self.assertEqual(result['apps'][release['appId']]['guide'],self.manifest['guide'])
        self.assertTrue(result['apps'][release['appId']]['icon'].startswith('data:image/svg+xml;base64,'))
        self.assertEqual(result['apps'][release['appId']]['versions'],catalog['apps'][release['appId']]['versions'])
        (self.src/'index.html').write_text('Unpublished changes')
        with mock.patch.object(apps,'ROOT',self.root):
            self.assertEqual(apps.catalog_metadata(catalog),catalog)

    def test_lightweight_index_externalizes_exact_assets(self):
        _, release = self.build()
        catalog = apps.update_catalog({'schemaVersion':1,'apps':{}}, release)
        with mock.patch.object(apps, 'ROOT', self.root):
            catalog = apps.catalog_metadata(catalog)
        entry = catalog['apps'][release['appId']]
        entry['guide'] = {'description': 'Test guide.', 'sections': []}
        before = json.dumps(catalog)
        index = apps.write_catalog_index(catalog, root=self.root)
        self.assertEqual(json.dumps(catalog), before)
        slim = index['apps'][release['appId']]
        self.assertNotIn('icon', slim)
        self.assertNotIn('guide', slim)
        self.assertEqual(slim['versions'], entry['versions'])
        for asset in slim['assets'].values():
            data = (self.root/'catalog/assets'/asset['url'].rsplit('/', 1)[-1]).read_bytes()
            self.assertEqual(len(data), asset['size'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), asset['sha256'])
        self.assertEqual(apps.write_catalog_index(catalog, root=self.root), index)

    def test_playground_catalog_uses_exact_committed_source(self):
        import subprocess
        def git(*args):
            return subprocess.check_output(['git',*args],cwd=self.root,text=True).strip()
        git('init','-q');git('-c','user.name=t','-c','user.email=t@example.test','add','apps')
        git('-c','user.name=t','-c','user.email=t@example.test','commit','-q','-m','source')
        commit=git('rev-parse','HEAD')
        manifest,records,revision=apps.source('demo',root=self.root)
        release={'version':'1.0.0','sourceCommit':commit,'revision':revision,'sha256':'a'*64,'size':10,'assetUrl':'https://github.com/VrchStudio/vrch-apps/releases/download/demo-v1.0.0/demo-1.0.0.vrchapp'}
        catalog={'schemaVersion':1,'apps':{self.manifest['id']:{'slug':'demo','latest':'1.0.0','versions':{'1.0.0':release}}}}
        presentation={'schemaVersion':1,'categories':[{'id':'tools','label':'Tools'}],'apps':{'demo':{'category':'tools','featured':2,'tags':['Try me']}}}
        # Later uncommitted edits must not leak into the published listing.
        (self.src/'index.html').write_bytes(b'<p>changed</p>\n')
        result=apps.write_playground_catalog(catalog,root=self.root,presentation=presentation)
        entry=result['apps'][0]
        self.assertEqual((entry['slug'],entry['category'],entry['featured'],entry['tags'],entry['capabilities']),('demo','tools',2,['Try me'],['controls']))
        listing=json.loads((self.root/'catalog/assets'/(entry['assets']['files']['sha256']+'.json')).read_bytes())
        self.assertEqual(listing['base'],f'https://raw.githubusercontent.com/VrchStudio/vrch-apps/{commit}/apps/demo/src/')
        self.assertEqual([f['path'] for f in listing['files']],[name for name,_ in records])
        self.assertEqual(apps.content_revision([(f['path'],dict(records)[f['path']]) for f in listing['files']]),revision)
        self.assertEqual(entry['assets']['icon']['mediaType'],'image/svg+xml')
        # The release package is listed as one verified download.
        self.assertEqual(entry['assets']['package'],{'url':release['assetUrl'],'size':10,'sha256':'a'*64})
        with self.assertRaises(ValueError):
            apps.write_playground_catalog({'schemaVersion':1,'apps':{self.manifest['id']:{**catalog['apps'][self.manifest['id']],'versions':{'1.0.0':{k:v for k,v in release.items() if k!='assetUrl'}}}}},root=self.root,presentation=presentation)
        # A recorded revision the committed source cannot reproduce is never advertised.
        with self.assertRaises(ValueError):
            apps.write_playground_catalog({'schemaVersion':1,'apps':{self.manifest['id']:{**catalog['apps'][self.manifest['id']],'versions':{'1.0.0':{**release,'revision':'b'*64}}}}},root=self.root,presentation=presentation)
        with self.assertRaises(ValueError):
            apps.write_playground_catalog(catalog,root=self.root,presentation={**presentation,'apps':{'missing':{'category':'tools'}}})
        # Deferred files are opt-in, listed by path, and never include what the App needs to start.
        self.assertNotIn('deferred',entry)
        names=['app.json','index.html','media/a.mp3','media/b.vpf','media/index.json','vendor/run.wasm']
        self.assertEqual(apps.deferred_files('demo',['vendor/run.wasm','media/b.vpf','media/a.mp3'],names),['media/a.mp3','media/b.vpf','vendor/run.wasm'])
        for prefixes in (['media/'],['index.html'],['missing/']):
            with self.assertRaises(ValueError):apps.deferred_files('demo',prefixes,names)
        (self.root/'catalog').mkdir(exist_ok=True)
        (self.root/'catalog/presentation.json').write_text(json.dumps({**presentation,'apps':{'demo':{'category':'tools','deferred':['../x']}}}))
        with self.assertRaises(ValueError):apps.read_presentation(self.root)

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

    def test_new_draft_uses_creation_receipt_when_list_is_stale(self):
        package,release=self.build()
        catalog={'schemaVersion':1,'apps':{}}
        (self.root/'catalog').mkdir()
        (self.root/'catalog/stable.json').write_text(json.dumps(catalog))
        (self.root/'catalog/presentation.json').write_text(json.dumps({'schemaVersion':1,'categories':[{'id':'tools','label':'Tools'}],'apps':{}}))
        draft={'id':42,'draft':True,'tag_name':release['tag'],'target_commitish':'a'*40,'assets':[]}
        calls=[]
        def github(*args):
            calls.append(args)
            if args[0]=='api':
                endpoint=args[1]
                if '--method' in args:
                    payload=json.loads(Path(args[args.index('--input')+1]).read_text())
                    self.assertTrue(payload['draft'])
                    self.assertEqual(payload['tag_name'],release['tag'])
                    return json.dumps(draft)
                if 'matching-refs' in endpoint or '?per_page=' in endpoint:
                    return '[]'  # Listing deliberately never observes the new draft.
                if '/releases/tags/' in endpoint:
                    return json.dumps({**draft,'draft':False})
            if args[:2]==('release','upload'):
                file=Path(args[3]);draft['assets'].append({'name':file.name,'size':file.stat().st_size,
                    'digest':'sha256:'+hashlib.sha256(file.read_bytes()).hexdigest()})
            return ''
        def command(*args,**kwargs):
            if args[:2]==('git','rev-parse'):return 'a'*40
            if args[:2]==('git','show'):return json.dumps(catalog)
            return ''
        with mock.patch.dict(os.environ,{'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':apps.REPOSITORY}), \
             mock.patch.object(apps,'ROOT',self.root), mock.patch.object(apps,'build',return_value=(package,release)), \
             mock.patch.object(apps,'gh',side_effect=github), mock.patch.object(apps,'command',side_effect=command), \
             mock.patch('urllib.request.urlopen',side_effect=lambda *a,**k: package.open('rb')):
            apps.publish('demo','1.0.0')
        result=json.loads((self.root/'catalog/stable.json').read_text())
        self.assertEqual(result['apps'][release['appId']]['latest'],'1.0.0')
        self.assertEqual(sum('?per_page=' in str(c) for c in calls),1)
        self.assertEqual(json.loads((self.root/'catalog/playground.json').read_text())['apps'],[])

    def test_publish_requires_workflow(self):
        with mock.patch.dict(os.environ, {'GITHUB_ACTIONS':'false'}), self.assertRaisesRegex(ValueError,'workflow'):
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
