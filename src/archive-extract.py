"""Bounded ZIP member extraction. Called only with private, hash-checked files."""
import hashlib
import json
import os
import pathlib
import resource
import stat
import sys
import unicodedata
import zipfile


def fail(code):
    raise ValueError(code)


def safe_name(info):
    raw = info.orig_filename
    name = raw[:-1] if info.is_dir() else raw
    if (not name or len(raw) > 500 or '\\' in raw or ':' in raw or '\x00' in raw
            or unicodedata.normalize('NFC', raw) != raw
            or any(part in ('', '.', '..') for part in name.split('/'))):
        fail('ARCHIVE_UNSAFE_MEMBER')
    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or (kind == stat.S_IFDIR) != info.is_dir() and kind != 0:
        fail('ARCHIVE_NON_REGULAR_MEMBER')
    if pathlib.PurePosixPath(name).suffix.lower() in ('.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz'):
        fail('ARCHIVE_NESTED_UNSUPPORTED')
    return name


def extract(config):
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (100 * 1024 * 1024, 100 * 1024 * 1024))
    with zipfile.ZipFile(config['archive']) as archive:
        entries = archive.infolist()
        if not 1 <= len(entries) <= 1000:
            fail('ARCHIVE_ENTRY_LIMIT')
        seen, total, selected = set(), 0, None
        for entry in entries:
            name = safe_name(entry)
            if name in seen:
                fail('ARCHIVE_DUPLICATE_MEMBER')
            seen.add(name)
            if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                fail('ARCHIVE_COMPRESSION_UNSUPPORTED')
            if entry.volume != 0:
                fail('ARCHIVE_NATIVE_MULTIPART_UNSUPPORTED')
            total += entry.file_size
            if entry.file_size > 100 * 1024 * 1024 or total > 256 * 1024 * 1024:
                fail('ARCHIVE_EXPANDED_SIZE_LIMIT')
            if entry.file_size > max(1, entry.compress_size) * 100:
                fail('ARCHIVE_COMPRESSION_RATIO_LIMIT')
            if entry.filename == config['member']:
                selected = entry
        if selected is None or selected.is_dir() or selected.file_size < 1:
            fail('ARCHIVE_MEMBER_MISSING')
        if selected.file_size != config['member_size']:
            fail('ARCHIVE_MEMBER_SIZE_MISMATCH')
        digest, size = hashlib.sha256(), 0
        # Never extract a user-controlled pathname. ZipExtFile verifies selected CRC.
        with archive.open(selected) as source, open(config['output'], 'xb') as output:
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > selected.file_size or size > 100 * 1024 * 1024:
                    fail('ARCHIVE_EXPANDED_SIZE_LIMIT')
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if size != selected.file_size or digest.hexdigest() != config['sha256']:
            fail('ARCHIVE_MEMBER_HASH_MISMATCH')
        return {'bytes': size, 'sha256': digest.hexdigest(), 'entries_inspected': len(entries)}


try:
    print(json.dumps(extract(json.loads(sys.stdin.read(4096)))))
except Exception as error:
    code = str(error)
    print(code if code.startswith('ARCHIVE_') and code.replace('_', '').isalnum() else 'ARCHIVE_ZIP_INVALID', file=sys.stderr)
    sys.exit(1)
