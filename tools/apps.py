#!/usr/bin/env python3
"""Build and publish official VRCH Apps using Python's standard library and gh."""
import argparse
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


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


def command(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def gh(*args):
    return command('gh', *args)


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
    revision=hashlib.sha256()
    for name,data in records:
        encoded=name.encode('utf-8')
        revision.update(struct.pack('>I',len(encoded))+encoded+struct.pack('>Q',len(data))+hashlib.sha256(data).digest())
    return manifest,records,revision.hexdigest()


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
    update_catalog(catalog,release)
    releases=api(f'repos/{REPOSITORY}/releases?per_page=100')
    existing=next((r for r in releases if r['tag_name']==tag),None)
    if existing is None:
        # A tag without a Release is not silently reused or moved.
        tags=gh('api',f'repos/{REPOSITORY}/git/matching-refs/tags/{tag}')
        if any(x['ref']=='refs/tags/'+tag for x in json.loads(tags)):
            raise ValueError('The release tag already exists without a matching Release.')
        notes_file=package.parent/'notes.md'
        notes_file.write_text(release['notes'],encoding='utf-8')
        gh('release','create',tag,'--repo',REPOSITORY,'--target',commit,'--draft',
           '--title',release['name']+' '+version,'--notes-file',str(notes_file))
        existing=api(f'repos/{REPOSITORY}/releases/tags/{tag}')
    if existing['draft'] and existing['target_commitish']!=commit:
        raise ValueError('An existing draft points to another source commit.')
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
    updated=update_catalog(read_json(path),release)
    save_json(path,updated)
    if command('git','status','--porcelain','--','catalog/stable.json'):
        command('git','config','user.name','github-actions[bot]')
        command('git','config','user.email','41898282+github-actions[bot]@users.noreply.github.com')
        command('git','add','--','catalog/stable.json')
        command('git','commit','-m',f'release: publish {app} {version} in the catalog')
        command('git','push','origin','HEAD:main')
    print(json.dumps({'release':release['releaseUrl'],'catalog':'published','sha256':release['sha256']}))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['check','build','release','publish'])
    parser.add_argument('app')
    parser.add_argument('--version')
    args=parser.parse_args()
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
