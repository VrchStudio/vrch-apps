#!/usr/bin/env python3
"""Build and publish official VRCH Apps using Python's standard library and gh."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import tempfile
import unicodedata
from urllib.parse import quote
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'VrchStudio/vrch-apps'
STABLE_VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z')
SLUG = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*\Z')
MAX_PACKAGE, MAX_FILE, MAX_FILES = 128*1024**2, 64*1024**2, 4096
PLAYGROUND_FILES_LIMIT, SCREENSHOT_LIMIT, SCREENSHOTS = 1024*1024, 512*1024, 4
SCREENSHOT_TYPES = {'.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg'}


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


def command(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def gh(*args):
    return command('gh', *args)


def legacy_baseline(root,app,manifest):
    path=root/'apps'/app/'legacy-baseline.json'
    if not path.exists():return None
    value=read_json(path)
    if value.get('version')!=manifest['version']:return None
    if (value.get('appId')!=manifest['id'] or any(not isinstance(value.get(key),str) or not re.fullmatch('[0-9a-f]{64}',value[key]) for key in ('revision','packageDigest'))):
        raise ValueError('Invalid original App baseline identity.')
    return value


def source(app, root=ROOT):
    if not SLUG.fullmatch(app):
        raise ValueError('Use a lowercase App directory name.')
    path = root/'apps'/app/'src'
    if path.is_symlink() or not path.is_dir():
        raise ValueError('App source directory is missing or a symlink.')
    records, names = [], set()
    for file in sorted(path.rglob('*'), key=lambda p: p.relative_to(path).as_posix().encode('utf-8')):
        if file.is_symlink():
            raise ValueError('Source symlinks are not allowed.')
        if file.is_dir():
            continue
        if not file.is_file():
            raise ValueError('Only ordinary files may be packaged.')
        name = file.relative_to(path).as_posix()
        normalized = unicodedata.normalize('NFC', name).casefold()
        if normalized in names or '\\' in name or ':' in name or any(part in ('.git', '.env', '__pycache__') for part in file.relative_to(path).parts):
            raise ValueError('Invalid, conflicting or development-only package path: '+name)
        names.add(normalized)
        data = file.read_bytes()
        if len(data)>MAX_FILE:
            raise ValueError('A source file exceeds 64 MiB.')
        records.append((name, data))
    if len(records)>MAX_FILES or sum(len(data) for _,data in records)>MAX_PACKAGE:
        raise ValueError('App exceeds package limits.')
    files = dict(records)
    manifest = json.loads(files['app.json'])
    if any(type(manifest.get(key)) is not int or manifest[key]!=1 for key in ('schema_version','sdk_version','data_schema_version')):
        raise ValueError('Only schema, SDK and data schema version 1 are supported.')
    if not UUID.fullmatch(manifest.get('id','')) or not STABLE_VERSION.fullmatch(manifest.get('version','')):
        raise ValueError('App must have a UUID and stable x.y.z version.')
    if not isinstance(manifest.get('name'),str) or not manifest['name'].strip() or len(manifest['name'])>48:
        raise ValueError('App name must contain 1 to 48 characters.')
    if manifest.get('entry') not in files or not manifest['entry'].lower().endswith(('.html','.htm')):
        raise ValueError('App HTML entry is missing.')
    caps=manifest.get('capabilities')
    if not isinstance(caps,dict) or set(caps)-{'controls','audio_input','audio_output','video_input','imu_input','websocket'}:
        raise ValueError('Unsupported capabilities.')
    for key in ('controls','audio_input','audio_output','video_input','imu_input'):
        if key in caps and type(caps[key]) is not bool:
            raise ValueError('Capability flags must be boolean.')
    channels=caps.get('websocket',[])
    if not isinstance(channels,list) or len(channels)>32 or any(not isinstance(c,dict) or type(c.get('channel')) is not int or not 1<=c['channel']<=8 or c.get('format') not in ('json','midi','audio','image') for c in channels):
        raise ValueError('Invalid WebSocket capability.')
    digest=content_revision(records)
    baseline=legacy_baseline(root,app,manifest)
    icon=manifest.get('icon')
    historical=baseline is not None and baseline['revision']==digest
    if icon is None and historical:
        pass  # Exact installed baseline only; the next/current release needs an icon.
    elif not isinstance(icon,str) or icon not in files or Path(icon).suffix.lower() not in ('.svg','.png') or not 0<len(files[icon])<=65536:
        raise ValueError('Every official App needs a packaged SVG or PNG icon (up to 64 KiB).')
    return manifest,records,digest


def content_revision(records):
    revision=hashlib.sha256()
    for name,data in records:
        encoded=name.encode('utf-8')
        revision.update(struct.pack('>I',len(encoded))+encoded+struct.pack('>Q',len(data))+hashlib.sha256(data).digest())
    return revision.hexdigest()


def committed_source(slug, commit, root=ROOT):
    """Exact App source files at a published commit, in package order (what raw GitHub serves)."""
    if not SLUG.fullmatch(slug) or not re.fullmatch('[0-9a-f]{40}', commit or ''):
        raise ValueError('Invalid published App source reference.')
    prefix=f'apps/{slug}/src/'
    listing=subprocess.check_output(['git','ls-tree','-r','-z','--full-tree',commit,'--',prefix],cwd=root)
    records=[]
    for entry in filter(None,listing.split(b'\0')):
        meta,path=entry.split(b'\t',1)
        mode,kind,obj=meta.split(b' ')
        if kind!=b'blob' or mode not in (b'100644',b'100755'):
            raise ValueError('Published App source contains a non-regular file.')
        name=path.decode('utf-8')[len(prefix):]
        records.append((name,subprocess.check_output(['git','cat-file','blob',obj.decode('ascii')],cwd=root)))
    return sorted(records,key=lambda record:record[0].encode('utf-8'))


def store_asset(root, data, suffix, limit):
    if not 0 < len(data) <= limit:
        raise ValueError('Catalog asset is too large.')
    digest = hashlib.sha256(data).hexdigest()
    name = digest + '.' + suffix
    path = root / 'catalog/assets' / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {'url': f'https://raw.githubusercontent.com/{REPOSITORY}/main/catalog/assets/{name}', 'sha256': digest, 'size': len(data)}


def read_presentation(root):
    value = read_json(root / 'catalog/presentation.json')
    categories = value.get('categories') if value.get('schemaVersion') == 1 else None
    if not isinstance(categories, list) or not categories or not isinstance(value.get('apps'), dict):
        raise ValueError('Unsupported Playground presentation.')
    ids = [c.get('id') for c in categories if isinstance(c, dict)]
    if len(ids) != len(categories) or len(set(ids)) != len(ids) or any(not isinstance(i, str) or not SLUG.fullmatch(i) for i in ids) \
            or any(not isinstance(c.get('label'), str) or not 0 < len(c['label']) <= 32 for c in categories):
        raise ValueError('Invalid Playground categories.')
    for slug, meta in value['apps'].items():
        if not SLUG.fullmatch(slug) or not isinstance(meta, dict) or meta.get('category') not in ids:
            raise ValueError('Invalid Playground entry: ' + slug)
        featured, tags, shots = meta.get('featured'), meta.get('tags', []), meta.get('screenshots', [])
        if featured is not None and (type(featured) is not int or not 1 <= featured <= 99):
            raise ValueError('Invalid featured order: ' + slug)
        if not isinstance(tags, list) or len(tags) > 4 or any(not isinstance(t, str) or not 0 < len(t) <= 32 for t in tags):
            raise ValueError('Invalid Playground tags: ' + slug)
        if not isinstance(shots, list) or len(shots) > SCREENSHOTS or any(not isinstance(s, str) or Path(s).suffix.lower() not in SCREENSHOT_TYPES or Path(s).is_absolute() or '..' in Path(s).parts for s in shots):
            raise ValueError('Invalid Playground screenshots: ' + slug)
        deferred = meta.get('deferred', [])
        if not isinstance(deferred, list) or len(deferred) > 32 or any(not isinstance(d, str) or not d or d.startswith('/') or '..' in d.split('/') for d in deferred):
            raise ValueError('Invalid Playground deferred files: ' + slug)
    return value


# The Playground may start an App before its deferred files arrive: the App reads them only with fetch, which waits
# for them. Pages, scripts, styles and JSON always arrive before the App starts.
PLAYGROUND_STARTUP_TYPES = ('.html', '.htm', '.js', '.mjs', '.css', '.json')


def deferred_files(slug, prefixes, names):
    # Presentation prefixes are a file path or a directory ending in /; the catalog lists the matching files.
    result = []
    for prefix in prefixes:
        matched = [n for n in names if n == prefix or (prefix.endswith('/') and n.startswith(prefix))]
        if not matched:
            raise ValueError(f'Playground deferred path matches no file in {slug}: {prefix}')
        if any(Path(n).suffix.lower() in PLAYGROUND_STARTUP_TYPES for n in matched):
            raise ValueError(f'Playground cannot defer startup files in {slug}: {prefix}')
        result += [n for n in matched if n not in result]
    return sorted(result, key=lambda n: n.encode('utf-8'))


def write_playground_catalog(catalog, root=None, presentation=None, sources=committed_source):
    """Browser Playground catalog: the published release package plus its exact source files.

    Browsers fetch the package through a same-origin route to the GitHub Release (one request,
    verified against packageDigest); the per-file listing on raw GitHub remains for older Pages and fallback.

    Device catalogs stay unchanged. A listed App is published only when its committed source
    reproduces the recorded content revision.
    """
    root = root or ROOT
    presentation = presentation or read_presentation(root)
    order = {c['id']: i for i, c in enumerate(presentation['categories'])}
    known = {app['slug'] for app in catalog['apps'].values()}
    unknown = set(presentation['apps']) - known
    if unknown:
        raise ValueError('Playground lists unpublished Apps: ' + ', '.join(sorted(unknown)))
    entries = []
    for identifier, app in catalog['apps'].items():
        meta = presentation['apps'].get(app['slug'])
        if not meta:
            continue
        release = app['versions'][app['latest']]
        records = sources(app['slug'], release['sourceCommit'], root)
        files = dict(records)
        manifest = json.loads(files['app.json'])
        if content_revision(records) != release['revision'] or manifest.get('id') != identifier or manifest.get('version') != release['version']:
            raise ValueError('Published source does not reproduce ' + app['slug'] + ' ' + release['version'])
        listing = {'schemaVersion': 1, 'appId': identifier, 'version': release['version'], 'revision': release['revision'],
                   'packageDigest': release['sha256'],
                   'base': f'https://raw.githubusercontent.com/{REPOSITORY}/{release["sourceCommit"]}/apps/{app["slug"]}/src/',
                   'files': [{'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in records]}
        assets = {'files': store_asset(root, json.dumps(listing, ensure_ascii=False, separators=(',', ':')).encode(), 'json', PLAYGROUND_FILES_LIMIT)}
        package = release.get('assetUrl')
        if not isinstance(package, str) or not package.startswith(f'https://github.com/{REPOSITORY}/releases/download/') or not package.endswith('.vrchapp'):
            raise ValueError('Published release has no package asset: ' + app['slug'] + ' ' + release['version'])
        assets['package'] = {'url': package, 'size': release['size'], 'sha256': release['sha256']}
        icon = manifest.get('icon')
        if isinstance(icon, str) and icon in files and Path(icon).suffix.lower() in ('.svg', '.png'):
            assets['icon'] = {**store_asset(root, files[icon], Path(icon).suffix.lower()[1:], 65536),
                              'mediaType': 'image/svg+xml' if icon.lower().endswith('.svg') else 'image/png'}
        shots = []
        for relative in meta.get('screenshots', []):
            path = root / relative
            if path.is_symlink() or not path.is_file():
                raise ValueError('Playground screenshot is missing: ' + relative)
            suffix = path.suffix.lower()
            shots.append({**store_asset(root, path.read_bytes(), suffix[1:], SCREENSHOT_LIMIT), 'mediaType': SCREENSHOT_TYPES[suffix]})
        if shots:
            assets['screenshots'] = shots
        guide = manifest.get('guide') if isinstance(manifest.get('guide'), dict) else {}
        summary = guide.get('description') if isinstance(guide.get('description'), str) else ''
        caps = manifest.get('capabilities', {})
        capabilities = sorted([key for key in ('controls', 'audio_input', 'audio_output', 'video_input', 'imu_input') if caps.get(key) is True]
                              + (['websocket'] if caps.get('websocket') else []))
        entry = {'appId': identifier, 'slug': app['slug'], 'name': manifest['name'], 'version': release['version'],
                 'summary': summary.strip()[:240], 'category': meta['category'], 'featured': meta.get('featured'),
                 'tags': meta.get('tags', []), 'capabilities': capabilities, 'size': release['size'],
                 'revision': release['revision'], 'packageDigest': release['sha256'], 'assets': assets}
        # Roles beyond the controlling instance (an 'output' picture for a large or second screen) mark the App's card.
        roles = sorted({r for r in manifest.get('roles', []) if r in ('output',)}) if isinstance(manifest.get('roles'), list) else []
        if roles:
            entry['roles'] = roles
        deferred = deferred_files(app['slug'], meta.get('deferred', []), [name for name, _ in records])
        if deferred:
            entry['deferred'] = deferred
        entries.append(entry)
    entries.sort(key=lambda e: (order[e['category']], e['name'].casefold()))
    result = {'schemaVersion': 1, 'categories': presentation['categories'], 'apps': entries}
    (root / 'catalog/playground.json').write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
    return result


def build(app, root=ROOT, output=None, source_commit=None):
    manifest,records,revision=source(app,root)
    output=output or root/'dist'/app
    output.mkdir(parents=True,exist_ok=True)
    name=f'{app}-{manifest["version"]}.vrchapp'
    package=output/name
    with tempfile.NamedTemporaryFile(dir=output,delete=False) as staging:
        temporary=Path(staging.name)
    try:
        with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_STORED) as archive:
            # Path order: the device rebuilds this same package and installs an official App only when the digests match.
            for path,data in records:
                info=zipfile.ZipInfo(path,(1980,1,1,0,0,0))
                info.create_system=3
                info.external_attr=(stat.S_IFREG|0o644)<<16
                info.compress_type=zipfile.ZIP_STORED
                info.file_size=len(data)
                with archive.open(info,'w') as entry:
                    entry.write(data)
        if temporary.stat().st_size>MAX_PACKAGE:
            raise ValueError('Canonical package exceeds 128 MiB.')
        digest=hashlib.sha256(temporary.read_bytes()).hexdigest()
        baseline=legacy_baseline(root,app,manifest)
        if baseline and (baseline['revision']!=revision or baseline['packageDigest']!=digest):
            raise ValueError('The original App baseline must match the installed package exactly.')
        temporary.replace(package)
    finally:
        temporary.unlink(missing_ok=True)
    tag=f'{app}-v{manifest["version"]}'
    notes_path=root/'apps'/app/'CHANGELOG.md'
    notes=notes_path.read_text(encoding='utf-8').strip() if notes_path.exists() else ''
    heading=f'## {manifest["version"]}'
    if heading in notes.splitlines():
        notes=notes.split(heading+'\n',1)[1].split('\n## ',1)[0].strip()
    else:
        raise ValueError('Add a CHANGELOG heading for this version: '+heading)
    if len(notes)>4000:
        raise ValueError('Release notes must be at most 4000 characters.')
    release={'version':manifest['version'],'name':manifest['name'],'tag':tag,
             'sourceCommit':source_commit or command('git','rev-parse','HEAD',cwd=root),
             'releaseUrl':f'https://github.com/{REPOSITORY}/releases/tag/{tag}',
             'assetUrl':f'https://github.com/{REPOSITORY}/releases/download/{tag}/{quote(name)}',
             'size':package.stat().st_size,'sha256':digest,'packageDigest':digest,'revision':revision,
             'requires':{'schema':1,'sdk':1,'dataSchema':1,'updateApi':1},'notes':notes}
    result={'schemaVersion':1,'appId':manifest['id'],'slug':app,**release}
    save_json(output/'release.json',result)
    return package,result


def update_catalog(catalog, release):
    if catalog.get('schemaVersion')!=1 or not isinstance(catalog.get('apps'),dict):
        raise ValueError('Unsupported catalog.')
    result=json.loads(json.dumps(catalog))
    app=result['apps'].setdefault(release['appId'],{'slug':release['slug'],'latest':release['version'],'versions':{}})
    if app['slug']!=release['slug']:
        raise ValueError('App identity is already registered to another directory.')
    record={k:v for k,v in release.items() if k not in ('schemaVersion','appId','slug')}
    old=app['versions'].get(release['version'])
    if old and old!=record:
        raise ValueError('A published version already contains different release metadata.')
    if tuple(map(int,release['version'].split('.')))<tuple(map(int,app['latest'].split('.'))):
        raise ValueError('An older release cannot replace the latest version.')
    app['versions'][release['version']]=record
    app['latest']=release['version']
    return result


def catalog_metadata(catalog):
    """Generate presentation metadata only from the exact published source."""
    result=json.loads(json.dumps(catalog))
    for identifier,app in result['apps'].items():
        manifest,records,revision=source(app['slug'],root=ROOT)
        latest=app['versions'][app['latest']]
        if manifest['id']!=identifier or manifest['version']!=app['latest'] or revision!=latest['revision']:
            continue
        if manifest.get('icon'):
            path=manifest['icon'];mime='image/svg+xml' if path.lower().endswith('.svg') else 'image/png'
            app['icon']='data:'+mime+';base64,'+base64.b64encode(dict(records)[path]).decode('ascii')
        if isinstance(manifest.get('guide'),dict):app['guide']=manifest['guide']
    return result


def write_catalog_index(catalog, root=None):
    """Keep the discovery index text-only; hash-addressed artwork/guides load later."""
    root = root or ROOT
    index = json.loads(json.dumps(catalog))
    for app in index['apps'].values():
        assets = {}
        icon = app.pop('icon', None)
        guide = app.pop('guide', None)
        records = []
        if icon:
            prefix, encoded = icon.split(';base64,', 1)
            mime = prefix.removeprefix('data:')
            if mime not in ('image/svg+xml', 'image/png'):
                raise ValueError('Unsupported catalog icon.')
            records.append(('icon', base64.b64decode(encoded, validate=True), mime, 'svg' if mime == 'image/svg+xml' else 'png'))
        if guide:
            records.append(('guide', json.dumps(guide, ensure_ascii=False, separators=(',', ':')).encode(), 'application/json', 'json'))
        for kind, data, mime, suffix in records:
            if not 0 < len(data) <= (65536 if kind == 'icon' else 32768):
                raise ValueError('Catalog asset is too large.')
            digest = hashlib.sha256(data).hexdigest()
            name = digest + '.' + suffix
            path = root / 'catalog/assets' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            assets[kind] = {'url': f'https://raw.githubusercontent.com/{REPOSITORY}/main/catalog/assets/{name}',
                            'sha256': digest, 'size': len(data), 'mediaType': mime}
        app['assets'] = assets
    (root / 'catalog/index.json').write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')) + '\n')
    return index


def published_metadata(catalog, release):
    """A catalog/tool-only commit must not manufacture a second source identity."""
    app=catalog['apps'].get(release['appId'],{})
    old=app.get('versions',{}).get(release['version'])
    if old:
        proposed={k:v for k,v in release.items() if k not in ('schemaVersion','appId','slug','sourceCommit')}
        if app['slug']!=release['slug'] or proposed!={k:v for k,v in old.items() if k!='sourceCommit'}:
            raise ValueError('A published version already contains different release metadata.')
        return {**release,'sourceCommit':old['sourceCommit']}
    return release


def api(path):
    return json.loads(gh('api',path))


def publish(app,version):
    """Called only by the queued release workflow, at the requested commit."""
    if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('GITHUB_REPOSITORY')!=REPOSITORY:
        raise ValueError('Use the release command to run the GitHub release workflow.')
    if not STABLE_VERSION.fullmatch(version):
        raise ValueError('Choose a stable x.y.z version.')
    commit=command('git','rev-parse','HEAD')
    command('git','fetch','origin','main')
    command('git','merge-base','--is-ancestor',commit,'origin/main')
    package,release=build(app,source_commit=commit)
    if release['version']!=version:
        raise ValueError('Requested version differs from app.json at the selected commit.')
    tag=release['tag']
    # Read the current catalog without mixing its commit into the source build.
    catalog=json.loads(command('git','show','origin/main:catalog/stable.json'))
    release=published_metadata(catalog,release)
    save_json(package.parent/'release.json',release)
    update_catalog(catalog,release)
    releases=api(f'repos/{REPOSITORY}/releases?per_page=100')
    existing=next((r for r in releases if r['tag_name']==tag),None)
    if existing is None:
        # A tag without a Release is not silently reused or moved.
        tags=gh('api',f'repos/{REPOSITORY}/git/matching-refs/tags/{tag}')
        if any(x['ref']=='refs/tags/'+tag for x in json.loads(tags)):
            raise ValueError('The release tag already exists without a matching Release.')
        request_file=package.parent/'create-release.json'
        save_json(request_file,{'tag_name':tag,'target_commitish':commit,'draft':True,
                                'name':release['name']+' '+version,'body':release['notes']})
        # Use the creation receipt; the release list can briefly remain stale.
        existing=json.loads(gh('api',f'repos/{REPOSITORY}/releases','--method','POST',
                               '--input',str(request_file)))
    if existing['draft'] and existing['target_commitish']!=commit:
        if existing['assets']:
            raise ValueError('An existing draft with assets points to another source commit.')
        gh('release','edit',tag,'--repo',REPOSITORY,'--target',commit,
           '--notes',release['notes'],'--title',release['name']+' '+version)
    for file in (package,package.parent/'release.json'):
        digest='sha256:'+hashlib.sha256(file.read_bytes()).hexdigest()
        asset=next((a for a in existing['assets'] if a['name']==file.name),None)
        if asset:
            if asset.get('digest')!=digest or asset['size']!=file.stat().st_size:
                raise ValueError('Existing release asset differs: '+file.name)
        elif existing['draft']:
            gh('release','upload',tag,str(file),'--repo',REPOSITORY)
        else:
            raise ValueError('Published release is missing its expected asset.')
    if existing['draft']:
        gh('release','edit',tag,'--repo',REPOSITORY,'--draft=false','--latest=false')
    published=api(f'repos/{REPOSITORY}/releases/tags/{tag}')
    if published['draft']:
        raise ValueError('Release is still a draft; catalog not changed.')
    asset=next(a for a in published['assets'] if a['name']==package.name)
    if asset.get('digest')!='sha256:'+release['sha256']:
        raise ValueError('Published package digest mismatch.')
    # Exercise the actual anonymous public download before advertising it.
    import urllib.request
    digest=hashlib.sha256();size=0
    with urllib.request.urlopen(release['assetUrl'],timeout=60) as response:
        while block:=response.read(1024*1024):
            size+=len(block)
            if size>release['size']:
                raise ValueError('Published package is larger than expected.')
            digest.update(block)
    if size!=release['size'] or digest.hexdigest()!=release['sha256']:
        raise ValueError('Public download does not match the release.')
    # Only the generated catalog changes; unrelated source commits stay intact.
    command('git','fetch','origin','main')
    command('git','checkout','-B','catalog-publish','origin/main')
    path=ROOT/'catalog/stable.json'
    updated=catalog_metadata(update_catalog(read_json(path),release))
    save_json(path,updated)
    write_catalog_index(updated)
    write_playground_catalog(updated)
    if command('git','status','--porcelain','--','catalog/stable.json','catalog/index.json','catalog/playground.json','catalog/assets'):
        command('git','config','user.name','github-actions[bot]')
        command('git','config','user.email','41898282+github-actions[bot]@users.noreply.github.com')
        command('git','add','--','catalog/stable.json','catalog/index.json','catalog/playground.json','catalog/assets')
        command('git','commit','-m',f'release: publish {app} {version} in the catalog')
        command('git','push','origin','HEAD:main')
    print(json.dumps({'release':release['releaseUrl'],'catalog':'published','sha256':release['sha256']}))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['check','build','release','publish','index'])
    parser.add_argument('app',nargs='?')
    parser.add_argument('--version')
    args=parser.parse_args()
    if args.action=='index':
        catalog=read_json(ROOT/'catalog/stable.json')
        write_catalog_index(catalog)
        write_playground_catalog(catalog)
        return
    if not args.app:
        parser.error('App directory is required.')
    if args.action=='publish':
        publish(args.app,args.version or '')
    elif args.action=='release':
        manifest,_,_=source(args.app)
        if args.version!=manifest['version']:
            raise ValueError('Specify the app.json version with --version.')
        if command('git','status','--porcelain'):
            raise ValueError('Commit source changes before publishing.')
        commit=command('git','rev-parse','HEAD')
        command('git','fetch','origin','main')
        command('git','merge-base','--is-ancestor',commit,'origin/main')
        print(gh('workflow','run','release.yml','--repo',REPOSITORY,'--ref','main',
                 '-f','app='+args.app,'-f','version='+args.version,'-f','source_ref='+commit))
        print('Release workflow started. Check GitHub Actions for the final release and catalog result.')
    elif args.action=='check':
        manifest,records,revision=source(args.app)
        print(f'{manifest["name"]} {manifest["version"]}: {len(records)} files, revision {revision}')
    else:
        package,release=build(args.app)
        print(json.dumps({'package':str(package),**release},ensure_ascii=False,indent=2))


if __name__=='__main__':
    try:
        main()
    except (ValueError,KeyError,OSError,subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
