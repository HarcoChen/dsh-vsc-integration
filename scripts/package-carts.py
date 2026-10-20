"""Repackage a verified VSIX payload using CodeArts' root-level CARTS layout."""
import json
import sys
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile

source = Path(sys.argv[1])
with ZipFile(source) as archive:
    payload = {}
    for entry in archive.infolist():
        if not entry.filename.startswith('extension/') or entry.is_dir():
            continue
        name = entry.filename[len('extension/'):]
        if '..' in PurePosixPath(name).parts or name.startswith('/') or name in payload:
            raise ValueError(f'Unsafe or duplicate entry: {name}')
        payload[name] = archive.read(entry)
manifest = json.loads(payload['package.json'])
for required in ['readme.md', manifest['main'].removeprefix('./'), manifest['icon'],
                 'node_modules/ws/package.json', 'vendor/dsh-jev-integration/package.json']:
    if required not in payload:
        raise ValueError(f'Missing required file: {required}')
target = source.with_name(f"{manifest['publisher'].lower()}.{manifest['name']}-{manifest['version']}.carts")
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for name, data in payload.items():
        archive.writestr('README.md' if name == 'readme.md' else name, data)
with ZipFile(target) as archive:
    if archive.testzip() is not None:
        raise ValueError('Corrupt CARTS archive')
    for name, data in payload.items():
        if archive.read('README.md' if name == 'readme.md' else name) != data:
            raise ValueError(f'Payload mismatch: {name}')
print(f'Verified {len(payload)} files in {target}')
