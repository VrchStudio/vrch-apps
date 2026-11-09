#!/usr/bin/env python3
"""Fetch public upstream MediaPipe test photos; never include them in the App."""
import hashlib
from pathlib import Path
import urllib.request

FIXTURES = {
    'thumb_up': '5d673c081ab13b8a1812269ff57047066f9c33c07db5f4178089e8cb3fdc0291',
    'fist': '43fa1cabf3f90d574accc9a56986e2ee48638ce59fc65af1846487f73bb2ef24',
    'pointing_up': 'ecf8ca2611d08fa25948a4fc10710af9120e88243a54da6356bacea17ff3e36e',
    'victory': '84cb8853e3df614e0cb5c93a25e3e2f38ea5e4f92fd428ee7d867ed3479d5764',
}
destination = Path('/tmp/palm-notes')
destination.mkdir(parents=True, exist_ok=True)
for name, digest in FIXTURES.items():
    target = destination / (name + '.jpg')
    data = target.read_bytes() if target.exists() else urllib.request.urlopen(
        'https://storage.googleapis.com/mediapipe-assets/' + name + '.jpg', timeout=30).read()
    assert hashlib.sha256(data).hexdigest() == digest, name + ': upstream fixture changed'
    target.write_bytes(data)
    print(name, 'verified')

# Public evaluation photographs only; not shipped in the App. Attribution:
# Roblespepe (Shaka, Commons GFDL/CC licensing), Steven H. Keys (OK, Commons),
# Tropical / Soyvisual (three/four, BY-NC-SA). Source pages are in the README.
EXTRA = {
    'shaka.png': ('https://upload.wikimedia.org/wikipedia/commons/0/05/Shaka-sign.png', '87a7ff3195a6527e7239e32d4abf97084bfee00857cbee4aaf13d9fd53140b5f'),
    'ok.jpg': ('https://upload.wikimedia.org/wikipedia/commons/1/19/OK_Sign.jpg', '9be62cf56067cc80b24abc5472a290687df8afa115176393acab6ac8af9c0ba9'),
    'hand-3.jpg': ('https://www.soyvisual.org/sites/default/files/styles/augmentative_resource_download/public/images/photos/num_0004.jpg?itok=O6Fi18m6', '6ce510c74e64a2438469f0e8b66170d49e7ef01344c20198709734f1f33685aa'),
    'hand-4.jpg': ('https://www.soyvisual.org/sites/default/files/styles/augmentative_resource_download/public/images/photos/num_0005.jpg?itok=fBM_vGmT', 'e5ed7ff8bcb8af2a6806695d4eb9395f6eeaa3ca85be4bcab32b2a4f76f63bc8'),
}
for name, (url, digest) in EXTRA.items():
    target = destination / name
    data = target.read_bytes() if target.exists() else urllib.request.urlopen(
        urllib.request.Request(url, headers={'User-Agent': 'PalmNotes-Test/0.1 (local gesture evaluation)'}), timeout=30).read()
    assert hashlib.sha256(data).hexdigest() == digest, name + ': upstream fixture changed'
    target.write_bytes(data)
    print(name, 'verified')
