#!/usr/bin/env python3
"""Local working directories with committed, versioned rclone WebDAV snapshots."""
import argparse
from contextlib import closing
import fnmatch
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone

STATE = Path('/tmp/rclone-persistence')
ROOTS = (Path('/zeroclaw-data'), Path('/app/data'), Path('/data'))
VERSION = 1
SNAPSHOT = re.compile(r'^\d{8}T\d{12}Z-[0-9a-f]{12}$')
EXCLUDED_DIRS = {'.git', '.ssh', '.gnupg', '.aws', 'node_modules', '__pycache__',
                 'cache', 'caches', '.cache', 'tmp', 'temp', 'logs', 'target'}
EXCLUDED_FILES = ('.env', '.env.*', '*.log', '*.pid', '*.lock', '*-wal', '*-shm', '*-journal',
                  'config.toml', 'rclone.conf', 'auth*.json', 'credentials*', '*secret*',
                  '*keyring*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '.ds_store', '.persistence-*')


class PersistenceError(Exception):
    pass


class Deadline(float):
    def __new__(cls, seconds, cancelled=None):
        value = super().__new__(cls, time.monotonic() + seconds)
        value.cancelled = cancelled
        return value


def log(event, **data):
    print(json.dumps({'event': 'persistence.' + event, **data}, ensure_ascii=False), flush=True)


def number(env, key, default, lower, upper):
    try:
        value = int(env.get(key, str(default)))
    except ValueError:
        raise PersistenceError(f'{key} must be an integer') from None
    if not lower <= value <= upper:
        raise PersistenceError(f'{key} is outside {lower}..{upper}')
    return value


class Config:
    def __init__(self, env=None, allowed_roots=ROOTS):
        from urllib.parse import urlsplit
        env = os.environ if env is None else env
        self.url = env.get('PERSIST_WEBDAV_URL', '')
        parsed = urlsplit(self.url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment):
            raise PersistenceError('PERSIST_WEBDAV_URL must be the HTTPS WebDAV URL from My Page')
        self.user = env.get('PERSIST_WEBDAV_USER', '')
        self.password = env.get('PERSIST_WEBDAV_PASSWORD', '')
        if not self.user or not self.password:
            raise PersistenceError('PERSIST_WEBDAV_USER and PERSIST_WEBDAV_PASSWORD are required')
        self.workspace = env.get('PERSIST_WEBDAV_WORKSPACE', 'trader-workspace')
        relative = env.get('PERSIST_REMOTE_PATH', 'g02-ritup-repo02-mix/production')
        for key, value in [('PERSIST_WEBDAV_WORKSPACE', self.workspace), ('PERSIST_REMOTE_PATH', relative)]:
            if (not value or value.startswith('/') or ':' in value or '\\' in value
                    or any(p in ('', '.', '..') for p in value.split('/')) or any(ord(c) < 32 for c in value)):
                raise PersistenceError(f'{key} must be a dedicated relative remote directory')
        self.remote = self.workspace + '/' + relative
        try:
            self.mappings = json.loads(env.get('PERSIST_PATHS_JSON', '[{"name":"zeroclaw","local":"/zeroclaw-data"}]'))
            self.excludes = json.loads(env.get('PERSIST_EXCLUDE_JSON', '[]'))
        except (ValueError, TypeError):
            raise PersistenceError('PERSIST_PATHS_JSON and PERSIST_EXCLUDE_JSON must be JSON') from None
        if not isinstance(self.mappings, list) or not 1 <= len(self.mappings) <= 16:
            raise PersistenceError('Choose between 1 and 16 directory mappings')
        names, paths = set(), []
        for mapping in self.mappings:
            if (not isinstance(mapping, dict) or set(mapping) != {'name', 'local'}
                    or not isinstance(mapping['name'], str)
                    or not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', mapping['name'])
                    or not isinstance(mapping['local'], str)):
                raise PersistenceError('Each mapping needs a unique name and an absolute local path')
            path = Path(mapping['local'])
            if (not path.is_absolute() or '..' in path.parts or path.resolve() != path
                    or not any(path.is_relative_to(root) for root in allowed_roots)):
                raise PersistenceError('Mappings must be real directories under /zeroclaw-data, /app/data or /data')
            if (mapping['name'] in names or any(path.is_relative_to(p) or p.is_relative_to(path) for p in paths)):
                raise PersistenceError('Mappings must have unique names and non-overlapping paths')
            names.add(mapping['name'])
            paths.append(path)
        if (not isinstance(self.excludes, list) or len(self.excludes) > 100
                or any(not isinstance(p, str) or not p or len(p) > 256 for p in self.excludes)):
            raise PersistenceError('PERSIST_EXCLUDE_JSON must be an array of relative glob patterns')
        self.interval = number(env, 'PERSIST_INTERVAL_SECONDS', 300, 60, 86400)
        self.keep = number(env, 'PERSIST_KEEP_SNAPSHOTS', 288, 2, 10000)
        self.timeout = number(env, 'PERSIST_OPERATION_TIMEOUT_SECONDS', 120, 10, 3600)
        self.shutdown_timeout = number(env, 'PERSIST_SHUTDOWN_TIMEOUT_SECONDS', 25, 5, 600)
        self.max_bytes = number(env, 'PERSIST_MAX_BYTES', 536870912, 1048576, 107374182400)
        self.max_files = number(env, 'PERSIST_MAX_FILES', 10000, 1, 100000)
        self.restore_policy = env.get('PERSIST_RESTORE_POLICY', 'empty')
        if self.restore_policy not in ('empty', 'never'):
            raise PersistenceError('PERSIST_RESTORE_POLICY must be empty or never')

    def excluded(self, relative):
        parts = PurePosixPath(relative).parts
        return (any(p.lower() in EXCLUDED_DIRS for p in parts)
                or any(fnmatch.fnmatchcase(p.lower(), pattern) for p in parts for pattern in EXCLUDED_FILES)
                or any(fnmatch.fnmatchcase(relative, p) or (p.startswith('**/') and fnmatch.fnmatchcase(relative, p[3:]))
                       for p in self.excludes))


class Rclone:
    def __init__(self, config):
        self.config = config
        self.env = {k: os.environ[k] for k in ('PATH', 'HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR') if k in os.environ}
        self.env.update({'GOMEMLIMIT': '48MiB', 'GOGC': '50'})
        # Passwords never appear in argv or a persisted rclone.conf.
        result = subprocess.run(['rclone', 'obscure', '-'], input=config.password, text=True,
                                env=self.env, capture_output=True, timeout=10, check=False)
        if result.returncode:
            raise PersistenceError('rclone could not prepare the WebDAV credential')
        self.env.update({'RCLONE_CONFIG_INFINI_TYPE': 'webdav', 'RCLONE_CONFIG_INFINI_VENDOR': 'other',
                         'RCLONE_CONFIG_INFINI_URL': config.url, 'RCLONE_CONFIG_INFINI_USER': config.user,
                         'RCLONE_CONFIG_INFINI_PASS': result.stdout.strip(),
                         'GOMEMLIMIT': '48MiB', 'GOGC': '50'})

    def path(self, name=''):
        return f'infini:{self.config.remote}/snapshots-v1' + ('/' + name if name else '')

    def call(self, args, deadline):
        budget(deadline)
        command = ['rclone', '--config', '/dev/null', '--transfers', '1', '--checkers', '2',
                   '--buffer-size', '1Mi', '--max-buffer-memory', '4Mi', '--multi-thread-streams', '0',
                   '--max-backlog', '1000', '--max-connections', '4',
                   '--tpslimit', '4', '--tpslimit-burst', '4', '--contimeout', '10s', '--timeout', '30s',
                   '--retries', '3', '--low-level-retries', '3', '--retries-sleep', '2s',
                   '--stats', '0', '--log-level', 'ERROR', *args]
        # Metadata output is spooled to disk, never accumulated unbounded in RAM.
        with tempfile.TemporaryFile() as stdout, subprocess.Popen(command, env=self.env, stdout=stdout, stderr=subprocess.DEVNULL) as process:
            try:
                while True:
                    budget(deadline)
                    try:
                        process.wait(timeout=min(0.5, max(0.001, deadline - time.monotonic())))
                        break
                    except subprocess.TimeoutExpired:
                        continue
            except BaseException:
                process.kill()
                process.wait()
                raise
            limit = 65536 if args[0] == 'cat' else 4 * 1024 * 1024
            if stdout.tell() > limit:
                raise PersistenceError('rclone metadata response exceeded its size limit')
            stdout.seek(0)
            output = stdout.read(limit + 1)
        if process.returncode:
            # Do not echo provider response bodies, URLs, credentials or file names.
            raise PersistenceError(f'rclone {args[0]} failed (exit {process.returncode}); check network, credentials and quota')
        return output

    def names(self, deadline):
        output = self.call(['lsf', self.path(), '--files-only', '--max-depth', '1'], deadline).decode()
        return [line for line in output.splitlines() if line]


class ReadOnlyRclone(Rclone):
    """The inspection command cannot accidentally upload, create or delete remotely."""
    def call(self, args, deadline):
        if (args[0] not in ('lsjson', 'cat', 'copyto') or not args[1].startswith('infini:')
                or (args[0] == 'copyto' and (len(args) != 3 or ':' in args[2]))):
            raise PersistenceError('Cloud mirror only permits remote listing and downloads')
        return super().call(args, deadline)


def budget(deadline):
    if getattr(deadline, 'cancelled', None) is not None and deadline.cancelled.is_set():
        raise PersistenceError('Periodic backup cancelled for service shutdown')
    if time.monotonic() >= deadline:
        raise PersistenceError('Persistence operation exceeded its time budget')


def release_cache(handle):
    # Large temporary copies should not accumulate dirty page cache inside a small cgroup.
    # The workload stays on local disk; this is only an advisory Linux cache hint.
    if hasattr(os, 'posix_fadvise'):
        handle.flush()
        os.fsync(handle.fileno())
        os.posix_fadvise(handle.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)


def cool_file(path):
    if path.stat().st_size >= 8 * 1024 * 1024:
        with path.open('rb') as handle:
            release_cache(handle)


def digest(path, deadline=None):
    sha = hashlib.sha256()
    with path.open('rb') as handle:
        while chunk := handle.read(1024 * 1024):
            if deadline is not None:
                budget(deadline)
            sha.update(chunk)
    cool_file(path)
    return sha.hexdigest()


def files(config, root, relative=Path()):
    folder = root / relative
    if folder.is_symlink() or folder.resolve() != folder:
        raise PersistenceError('A mapped directory contains a symlinked parent')
    if not folder.exists():
        return
    for item in sorted(folder.iterdir()):
        rel = relative / item.name
        if config.excluded(rel.as_posix()) or item.is_symlink():
            continue
        mode = item.stat().st_mode
        if stat.S_ISDIR(mode):
            yield from files(config, root, rel)
        elif stat.S_ISREG(mode):
            yield item, rel


def copy_consistent(source, target, deadline, sqlite_backup=True):
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open('rb') as handle:
        sqlite = sqlite_backup and handle.read(16) == b'SQLite format 3\x00'
    if sqlite:
        # SQLite online backup incorporates committed WAL pages; never copy the live DB/WAL pair.
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=5)) as src:
            with closing(sqlite3.connect(target)) as dst:
                src.backup(dst, pages=256, progress=lambda *_: budget(deadline), sleep=0.05)
                if dst.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise PersistenceError('SQLite snapshot integrity check failed')
    else:
        before = source.stat()
        cool_file(source)
        with source.open('rb') as src, target.open('wb') as dst:
            copied = 0
            while chunk := src.read(1024 * 1024):
                budget(deadline)
                dst.write(chunk)
                copied += len(chunk)
                if copied % (8 * 1024 * 1024) == 0:
                    release_cache(dst)
                    release_cache(src)
        after = source.stat()
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise PersistenceError('A file changed during the snapshot; the next interval will retry')
    target.chmod(0o700 if source.stat().st_mode & 0o100 else 0o600)
    cool_file(target)


def make_archive(config, temp, deadline):
    stage = temp / 'stage'
    stage.mkdir()
    total, entries = 0, []
    for mapping in config.mappings:
        for source, relative in files(config, Path(mapping['local'])):
            budget(deadline)
            if total + source.stat().st_size > config.max_bytes:
                raise PersistenceError('Snapshot exceeds PERSIST_MAX_BYTES')
            destination = stage / mapping['name'] / relative
            copy_consistent(source, destination, deadline)
            total += destination.stat().st_size
            if total > config.max_bytes:
                raise PersistenceError('Snapshot exceeds PERSIST_MAX_BYTES')
            entries.append(destination)
            if len(entries) > config.max_files:
                raise PersistenceError('Snapshot exceeds PERSIST_MAX_FILES')
    archive = temp / 'snapshot.tar.gz'
    with archive.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', compresslevel=1, mtime=0, filename='') as gz:
        with tarfile.open(fileobj=gz, mode='w') as tar:
            for path in entries:
                budget(deadline)
                info = tarfile.TarInfo(path.relative_to(stage).as_posix())
                info.size = path.stat().st_size
                info.mode = path.stat().st_mode & 0o700
                with path.open('rb') as content:
                    tar.addfile(info, content)
                cool_file(path)
    return archive, {'sha256': digest(archive, deadline), 'bytes': archive.stat().st_size,
                     'unpackedBytes': total, 'fileCount': len(entries),
                     'filesByMapping': {m['name']: sum(p.relative_to(stage).parts[0] == m['name'] for p in entries) for m in config.mappings},
                     'mappings': [m['name'] for m in config.mappings]}


def unpack(config, archive, stage, metadata, deadline):
    if archive.stat().st_size != metadata['bytes'] or digest(archive, deadline) != metadata['sha256']:
        raise PersistenceError('Snapshot checksum or size does not match its commit manifest')
    names = set(metadata['mappings'])
    total, count, seen = 0, 0, set()
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            budget(deadline)
            p = PurePosixPath(member.name)
            if (not member.isfile() or p.is_absolute() or '..' in p.parts or len(p.parts) < 2
                    or p.parts[0] not in names or member.name in seen or member.size < 0):
                raise PersistenceError('Snapshot contains an unsafe archive entry')
            seen.add(member.name)
            total += member.size
            count += 1
            if total > config.max_bytes or count > config.max_files:
                raise PersistenceError('Restored snapshot exceeds local limits')
            # Current exclusions apply even if an older snapshot included the file.
            if config.excluded('/'.join(p.parts[1:])):
                continue
            target = stage / p
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as src, target.open('xb') as dst:
                copied = 0
                while chunk := src.read(1024 * 1024):
                    budget(deadline)
                    dst.write(chunk)
                    copied += len(chunk)
                    if copied % (8 * 1024 * 1024) == 0:
                        release_cache(dst)
            target.chmod(0o700 if member.mode & 0o100 else 0o600)
            cool_file(target)
    if total != metadata['unpackedBytes'] or count != metadata['fileCount']:
        raise PersistenceError('Snapshot inventory does not match its manifest')


def read_manifest(raw, snapshot):
    if len(raw) > 65536:
        raise PersistenceError('Snapshot manifest is too large')
    try:
        m = json.loads(raw)
        if (m['version'] != VERSION or m['snapshot'] != snapshot
                or not re.fullmatch(r'[0-9a-f]{64}', m['sha256'])
                or any(type(m[k]) is not int or m[k] < 0 for k in ('bytes', 'unpackedBytes', 'fileCount'))
                or not isinstance(m['mappings'], list) or not 1 <= len(m['mappings']) <= 16
                or len(set(m['mappings'])) != len(m['mappings'])
                or any(not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', name) for name in m['mappings'])
                or not isinstance(m['filesByMapping'], dict) or set(m['filesByMapping']) != set(m['mappings'])
                or any(type(v) is not int or v < 0 for v in m['filesByMapping'].values())
                or sum(m['filesByMapping'].values()) != m['fileCount']):
            raise ValueError()
        return m
    except (KeyError, ValueError, TypeError):
        raise PersistenceError('Invalid snapshot commit manifest') from None


def write_private_text(path, value):
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    try:
        with temporary.open('x', encoding='utf-8') as handle:
            handle.write(value)
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def write_private_json(path, value):
    write_private_text(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def mirror(config, destination, remote=None):
    """Download the latest committed snapshot into an isolated, inspectable directory."""
    import fcntl
    destination = Path(destination).absolute()
    if destination.is_symlink() or destination.resolve() != destination:
        raise PersistenceError('Cloud mirror destination must not contain symlinks')
    if any(destination.is_relative_to(Path(m['local'])) or Path(m['local']).is_relative_to(destination)
           for m in config.mappings):
        raise PersistenceError('Cloud mirror must use a separate directory from application data')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    owner = destination / '.cloud-mirror.json'
    identity = {'version': VERSION, 'remoteDirectory': config.remote, 'purpose': 'read-only-cloud-mirror'}
    if owner.exists():
        if owner.is_symlink() or json.loads(owner.read_text()) != identity:
            raise PersistenceError('Cloud mirror directory belongs to another remote or purpose')
    elif any(destination.iterdir()):
        raise PersistenceError('Cloud mirror needs an empty directory on its first run')
    else:
        write_private_json(owner, identity)
    lock_path = destination / '.mirror.lock'
    if lock_path.is_symlink():
        raise PersistenceError('Cloud mirror lock must not be a symlink')
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise PersistenceError('Another cloud mirror download is already running') from None
        return mirror_locked(config, destination, remote or ReadOnlyRclone(config))


def mirror_locked(config, destination, remote):
    deadline = Deadline(config.timeout)
    latest = destination / 'latest'
    if latest.exists() and not latest.is_symlink():
        raise PersistenceError('Cloud mirror latest path contains unrelated local data')
    relative = config.remote[len(config.workspace) + 1:]
    prefix = relative + '/snapshots-v1/'
    # One bounded listing is also saved when cloud backups have not started yet.
    raw = remote.call(['lsjson', 'infini:' + config.workspace, '--recursive', '--max-depth',
                       str(len(PurePosixPath(relative).parts) + 2)], deadline)
    try:
        entries = json.loads(raw)
        if not isinstance(entries, list):
            raise ValueError()
        inventory = []
        for entry in entries:
            name = entry['Path']
            if (not isinstance(name, str) or not name or PurePosixPath(name).is_absolute()
                    or '..' in PurePosixPath(name).parts or type(entry['IsDir']) is not bool
                    or type(entry['Size']) is not int):
                raise ValueError()
            inventory.append({'path': name, 'directory': entry['IsDir'], 'bytes': entry['Size']})
    except (KeyError, ValueError, TypeError):
        raise PersistenceError('Invalid cloud workspace inventory') from None
    names = [e['path'][len(prefix):] for e in inventory
             if not e['directory'] and e['path'].startswith(prefix) and '/' not in e['path'][len(prefix):]]
    commits = sorted(n[:-5] for n in names if n.endswith('.json') and SNAPSHOT.fullmatch(n[:-5]))
    report = {'version': VERSION, 'checkedAt': datetime.now(timezone.utc).isoformat(),
              'workspace': config.workspace, 'remoteDirectory': config.remote,
              'status': 'no_committed_snapshot', 'committedSnapshots': len(commits),
              'latestSnapshot': None, 'entries': inventory}
    if commits:
        snapshot = commits[-1]
        metadata = read_manifest(remote.call(['cat', remote.path(snapshot + '.json')], deadline), snapshot)
        if (metadata['unpackedBytes'] > config.max_bytes or metadata['bytes'] > config.max_bytes + 1048576
                or metadata['fileCount'] > config.max_files):
            raise PersistenceError('Remote snapshot exceeds local cloud mirror limits')
        snapshots = destination / 'snapshots'
        if snapshots.is_symlink():
            raise PersistenceError('Cloud mirror snapshots directory must not be a symlink')
        snapshots.mkdir(exist_ok=True, mode=0o700)
        saved = snapshots / snapshot
        if saved.is_symlink():
            raise PersistenceError('Cloud mirror snapshot must not be a symlink')
        # Verify cached archives on every inspection, then extract a fresh view.
        with tempfile.TemporaryDirectory(dir=destination, prefix='.download-') as tmp:
            temp = Path(tmp)
            archive = temp / 'snapshot.tar.gz'
            cached = saved / 'snapshot.tar.gz'
            if cached.exists() and not cached.is_symlink() and digest(cached, deadline) == metadata['sha256']:
                copy_consistent(cached, archive, deadline, sqlite_backup=False)
                downloaded = False
            else:
                remote.call(['copyto', remote.path(snapshot + '.tar.gz'), str(archive)], deadline)
                downloaded = True
            stage = temp / 'data'
            stage.mkdir()
            unpack(config, archive, stage, metadata, deadline)
            local_files = []
            for item in sorted(stage.rglob('*')):
                if item.is_file():
                    local_files.append({'path': item.relative_to(stage).as_posix(), 'bytes': item.stat().st_size})
            write_private_json(temp / 'manifest.json', metadata)
            write_private_json(temp / 'files.json', local_files)
            # An already inspected version can be rebuilt from its verified archive.
            if saved.exists():
                shutil.rmtree(saved)
            temp.rename(saved)
        temporary_link = destination / ('.latest-' + uuid.uuid4().hex)
        temporary_link.symlink_to(Path('snapshots') / snapshot / 'data', target_is_directory=True)
        temporary_link.replace(latest)
        report.update({'status': 'verified', 'latestSnapshot': snapshot,
                       'archiveBytes': metadata['bytes'], 'unpackedBytes': metadata['unpackedBytes'],
                       'files': len(local_files), 'mappings': metadata['mappings'],
                       'downloadedArchive': downloaded, 'viewDirectory': 'latest'})
    write_private_json(destination / 'inventory.json', report)
    if commits:
        description = (f"最新已校验快照：`{report['latestSnapshot']}`。\n\n"
                       f"查看文件：`latest/`；{report['files']} 个文件。"
                       "原始归档、提交清单和文件列表保存在 `snapshots/`。\n")
    else:
        description = '云端当前没有已提交快照，尚无可下载的应用数据。目录清单见 `inventory.json`。\n'
        if (destination / 'latest').is_symlink():
            description += '\n`latest/` 是之前拉取的本地副本，当前云端清单已不包含该版本。\n'
    write_private_text(destination / 'README.md',
        '# 云端数据本地查看副本\n\n' + f"检查时间：{report['checkedAt']}\n\n"
        + f"远端目录：`{config.remote}/snapshots-v1/`\n\n" + description
        + '\n此命令仅列目录和下载，不上传、不删除云端文件；不覆盖本地运行数据库。'
          '这里是快照查看副本，修改不会回传。\n')
    log('mirror_complete', status=report['status'], snapshots=len(commits),
        files=report.get('files', 0), snapshot=report['latestSnapshot'])
    return report


class Persistence:
    def __init__(self, config, remote=None, state=STATE):
        self.config = config
        self.remote = remote if remote is not None else Rclone(config)
        self.state = state
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.last_hash = None
        self.last_success = None
        self.cancelled = None

    def status(self, error=None):
        path = self.state / 'status.json'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps({'lastSuccess': self.last_success, 'error': error, 'at': time.time()}))
        temporary.chmod(0o600)
        temporary.replace(path)

    def restore(self):
        deadline = Deadline(self.config.timeout)
        self.remote.call(['mkdir', self.remote.path()], deadline)
        names = self.remote.names(deadline)
        commits = sorted(n[:-5] for n in names if n.endswith('.json') and SNAPSHOT.fullmatch(n[:-5]))
        for mapping in self.config.mappings:
            Path(mapping['local']).mkdir(parents=True, exist_ok=True)
        roots = [Path(m['local']) for m in self.config.mappings]
        if any((root / '.persistence-restore-incomplete').exists() for root in roots):
            raise PersistenceError('An interrupted restore needs a fresh destination; services will not start')
        local_data = {m['name']: next(files(self.config, Path(m['local'])), None) is not None for m in self.config.mappings}
        if not commits or self.config.restore_policy == 'never':
            reason = 'no_committed_snapshot' if not commits else 'policy_never'
            log('restore_skipped', reason=reason)
        else:
            snapshot = commits[-1]
            metadata = read_manifest(self.remote.call(['cat', self.remote.path(snapshot + '.json')], deadline), snapshot)
            if metadata['unpackedBytes'] > self.config.max_bytes or metadata['bytes'] > self.config.max_bytes + 1048576:
                raise PersistenceError('Remote snapshot exceeds PERSIST_MAX_BYTES')
            destinations = [m for m in self.config.mappings if m['name'] in metadata['mappings']]
            missing = [m for m in destinations if metadata['filesByMapping'][m['name']] and not local_data[m['name']]]
            if any(local_data.values()):
                if missing:
                    raise PersistenceError('Some mapped histories are missing while others contain local data; use fresh destinations or explicitly choose never')
                self.last_success = time.time()
                self.status()
                log('restore_skipped', reason='local_data_present')
                return
            with tempfile.TemporaryDirectory(dir=self.state, prefix='restore-') as tmp:
                temp = Path(tmp)
                archive = temp / 'snapshot.tar.gz'
                self.remote.call(['copyto', self.remote.path(snapshot + '.tar.gz'), str(archive)], deadline)
                stage = temp / 'stage'
                stage.mkdir()
                unpack(self.config, archive, stage, metadata, deadline)
                # A killed restore must not be mistaken for an intact local history on the next boot.
                markers = [Path(m['local']) / '.persistence-restore-incomplete' for m in destinations]
                for marker in markers:
                    marker.write_text(snapshot)
                for mapping in destinations:
                    source = stage / mapping['name']
                    if source.exists():
                        for saved in source.rglob('*'):
                            if not saved.is_file():
                                continue
                            target = Path(mapping['local']) / saved.relative_to(source)
                            if target.resolve() != target or target.is_symlink():
                                raise PersistenceError('Restore destination contains a symlink; services will not start')
                            target.parent.mkdir(parents=True, exist_ok=True)
                            copy_consistent(saved, target, deadline, sqlite_backup=False)
                for marker in markers:
                    marker.unlink()
            log('restored', snapshot=snapshot, files=metadata['fileCount'])
        self.last_success = time.time()
        self.status()

    def backup(self, timeout=None, final=False):
        deadline = Deadline(timeout if timeout is not None else self.config.timeout, None if final else self.cancelled)
        with tempfile.TemporaryDirectory(dir=self.state, prefix='backup-') as tmp:
            temp = Path(tmp)
            archive, metadata = make_archive(self.config, temp, deadline)
            if metadata['sha256'] == self.last_hash:
                # Do not silently report remote health when no files have changed.
                self.remote.names(deadline)
                self.last_success = time.time()
                self.status()
                log('unchanged')
                self.prune(deadline)
                return
            snapshot = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:12]
            metadata.update({'version': VERSION, 'snapshot': snapshot})
            manifest = temp / 'manifest.json'
            manifest.write_text(json.dumps(metadata))
            # The manifest is the commit marker and is always uploaded last.
            self.remote.call(['copyto', str(archive), self.remote.path(snapshot + '.tar.gz')], deadline)
            verified = temp / 'remote-verification.tar.gz'
            self.remote.call(['copyto', self.remote.path(snapshot + '.tar.gz'), str(verified)], deadline)
            if digest(verified, deadline) != metadata['sha256']:
                raise PersistenceError('Uploaded snapshot failed downloaded SHA-256 verification; not committed')
            self.remote.call(['copyto', str(manifest), self.remote.path(snapshot + '.json')], deadline)
            self.last_hash = metadata['sha256']
            self.last_success = time.time()
            self.status()
            log('saved', snapshot=snapshot, files=metadata['fileCount'], bytes=metadata['bytes'])
            self.prune(deadline)

    def prune(self, deadline):
        names = self.remote.names(deadline)
        commits = sorted(n[:-5] for n in names if n.endswith('.json') and SNAPSHOT.fullmatch(n[:-5]))
        for old in commits[:-self.config.keep]:
            # Remove the marker first so interrupted pruning cannot advertise a missing archive.
            self.remote.call(['deletefile', self.remote.path(old + '.json')], deadline)
            self.remote.call(['deletefile', self.remote.path(old + '.tar.gz')], deadline)
        # Only our timestamped archives, older than a day, without any commit marker.
        for name in names:
            if name.endswith('.tar.gz') and SNAPSHOT.fullmatch(name[:-7]) and name[:-7] not in commits:
                created = datetime.strptime(name[:-7].split('-')[0], '%Y%m%dT%H%M%S%fZ').replace(tzinfo=timezone.utc)
                if time.time() - created.timestamp() > 86400:
                    self.remote.call(['deletefile', self.remote.path(name)], deadline)


def health(env=None, state=STATE):
    env = os.environ if env is None else env
    if env.get('PERSIST_ENABLED', 'false') != 'true':
        return 0
    try:
        status = json.loads((state / 'status.json').read_text())
        age = time.time() - status['lastSuccess']
        limit = int(env.get('PERSIST_INTERVAL_SECONDS', '300')) * 3 + int(env.get('PERSIST_OPERATION_TIMEOUT_SECONDS', '120'))
        return 0 if 0 <= age <= limit else 1
    except (OSError, ValueError, TypeError, KeyError):
        return 1


def probe():
    config = Config()
    remote = Rclone(config)
    deadline = Deadline(config.timeout)
    name = '.connection-test-' + uuid.uuid4().hex
    folder = remote.path(name)
    uploaded = False
    created = False
    with tempfile.TemporaryDirectory(prefix='webdav-probe-') as tmp:
        original = Path(tmp) / 'probe.bin'
        downloaded = Path(tmp) / 'verified.bin'
        original.write_bytes(os.urandom(32768))
        try:
            remote.call(['mkdir', folder], deadline)
            created = True
            remote.call(['copyto', str(original), folder + '/probe.bin'], deadline)
            uploaded = True
            remote.call(['copyto', folder + '/probe.bin', str(downloaded)], deadline)
            if digest(original) != digest(downloaded):
                raise PersistenceError('WebDAV connection test checksum failed')
            log('probe_verified', remoteDirectory=config.remote, bytes=32768)
        finally:
            cleanup_deadline = Deadline(30)
            if uploaded:
                remote.call(['deletefile', folder + '/probe.bin'], cleanup_deadline)
            if created:
                remote.call(['rmdir', folder], cleanup_deadline)
    log('probe_cleaned')
    return 0


def supervise(command):
    if not command:
        raise PersistenceError('A service command is required')
    enabled = os.environ.get('PERSIST_ENABLED', 'false')
    if enabled not in ('true', 'false'):
        raise PersistenceError('PERSIST_ENABLED must be true or false')
    # Do not pass the WebDAV credentials to the application or its agent tools.
    app_env = {k: v for k, v in os.environ.items() if not k.startswith(('PERSIST_WEBDAV_', 'RCLONE_'))}
    if enabled == 'false':
        os.execvpe(command[0], command, app_env)
    config = Config()
    persistence = Persistence(config)
    persistence.restore()  # Failed restore blocks service startup; never silently start with lost memory.
    process = subprocess.Popen(command, env=app_env)
    stopped = threading.Event()
    persistence.cancelled = stopped

    def stop(_signum, _frame):
        stopped.set()
        if process.poll() is None:
            process.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    next_backup = time.monotonic() + config.interval
    while process.poll() is None and not stopped.wait(min(1, max(0, next_backup - time.monotonic()))):
        if time.monotonic() >= next_backup:
            try:
                persistence.backup()
            except Exception as error:
                # Errors are bounded, sanitized messages; application data never enters the log.
                message = str(error) if isinstance(error, PersistenceError) else type(error).__name__
                persistence.status(message)
                log('backup_failed', error=message)
            next_backup = time.monotonic() + config.interval
    try:
        code = process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        code = process.wait()
    try:
        persistence.backup(timeout=config.shutdown_timeout, final=True)
    except Exception as error:
        message = str(error) if isinstance(error, PersistenceError) else type(error).__name__
        persistence.status(message)
        log('final_backup_failed', error=message)
        if code == 0:
            code = 1
    return code if code >= 0 else 128 - code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['run', 'validate', 'health', 'probe', 'mirror'])
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == 'health':
        return health()
    if args.action == 'probe':
        return probe()
    if args.action == 'mirror':
        if len(args.command) != 1:
            raise PersistenceError('Cloud mirror needs one isolated destination directory')
        mirror(Config(), args.command[0])
        return 0
    if args.action == 'validate':
        config = Config()
        log('config_valid', mappings=config.mappings, remoteDirectory=config.remote,
            intervalSeconds=config.interval, keepSnapshots=config.keep)
        return 0
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    return supervise(command)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        message = str(error) if isinstance(error, PersistenceError) else type(error).__name__
        log('fatal', error=message)
        sys.exit(1)
