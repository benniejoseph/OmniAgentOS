"""Bounded native source and application manifests. No effects on import."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import unicodedata


class NativeRefused(Exception):
    """Fixed non-secret failure category, never child output."""


def require(value, category):
    if not value:
        raise NativeRefused(category)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value)).hexdigest()


def seal(kind, value, field):
    return dict(value, **{field: digest({"contract": "asael-self-improvement", "version": 1, "kind": kind, "value": value})})


def verify_seal(kind, value, field):
    require(isinstance(value, dict) and field in value, "native_sealed_record_missing")
    body = {key: item for key, item in value.items() if key != field}
    require(seal(kind, body, field) == value, "native_sealed_record_changed")
    return body


def relative_path(value):
    require(isinstance(value, str) and 0 < len(value) <= 1000 and "\\" not in value
            and not re.search(r"[\x00-\x1f\x7f]", value), "native_path_invalid")
    require(not value.startswith("/") and all(part not in ("", ".", "..") for part in value.split("/")), "native_path_invalid")
    return value


def private_directory(path):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            "native_private_directory_required")
    return path.resolve()


def read_regular(path, maximum=64 * 1024 * 1024):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum and info.st_nlink == 1, "native_regular_file_required")
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        opened = os.fstat(stream.fileno())
        require((info.st_dev, info.st_ino) == (opened.st_dev, opened.st_ino), "native_file_changed")
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    require(len(raw) <= maximum and (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) ==
            (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "native_file_changed")
    return raw


def tree_manifest(root, kind="source", *, maximum_bytes=512 * 1024 * 1024, maximum_entries=30000):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink() and kind in ("source", "bundle"), "native_tree_invalid")
    root = root.resolve()
    rows, identities, total = [], set(), 0
    for folder, directories, files in os.walk(root, followlinks=False):
        for name in sorted([*directories, *files]):
            path = Path(folder) / name
            relative = relative_path(path.relative_to(root).as_posix())
            identity = unicodedata.normalize("NFC", relative).casefold()
            require(identity not in identities, "native_case_or_unicode_collision")
            identities.add(identity)
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                require(kind == "bundle", "native_source_symlink_forbidden")
                target = os.readlink(path)
                require(not PurePosixPath(target).is_absolute() and not re.search(r"[\x00-\x1f\x7f]", target), "native_bundle_link_invalid")
                try:
                    resolved = path.resolve(strict=True)
                except (OSError, RuntimeError):
                    raise NativeRefused("native_bundle_link_invalid") from None
                require(resolved.is_relative_to(root), "native_bundle_link_escape")
                rows.append({"path": relative, "kind": "symlink", "target": target})
            elif stat.S_ISDIR(info.st_mode):
                rows.append({"path": relative, "kind": "directory"})
            else:
                if kind == "source":
                    require(all(part != ".git" and not part.startswith(".env") for part in relative.split("/")), "native_source_private_path")
                raw = read_regular(path, maximum_bytes)
                total += len(raw)
                require(total <= maximum_bytes, "native_tree_size_exceeded")
                rows.append({"path": relative, "kind": "file", "size": len(raw), "sha256": digest(raw), "executable": bool(info.st_mode & 0o111)})
            require(len(rows) <= maximum_entries, "native_tree_entries_exceeded")
    rows.sort(key=lambda row: row["path"])
    body = {"version": 1, "kind": kind, "entries": rows, "totalBytes": total}
    return {**body, "manifestSha256": digest(body)}


def verify_manifest(root, expected, kind="source", **bounds):
    require(isinstance(expected, dict) and set(expected) == {"version", "kind", "entries", "totalBytes", "manifestSha256"}, "native_manifest_invalid")
    body = {key: value for key, value in expected.items() if key != "manifestSha256"}
    require(expected["kind"] == kind and expected["version"] == 1 and digest(body) == expected["manifestSha256"], "native_manifest_binding_changed")
    actual = tree_manifest(root, kind, **bounds)
    require(actual == expected, "native_tree_changed")
    return actual


def verify_source_files_unchanged(root, manifest):
    """Generated output may be new; no admitted source byte or mode may change."""
    root = Path(root).resolve()
    for row in manifest["entries"]:
        path = root / relative_path(row["path"])
        require(path.resolve().is_relative_to(root), "native_source_path_escape")
        if row["kind"] == "file":
            require(not path.is_symlink() and digest(read_regular(path)) == row["sha256"]
                    and bool(path.stat().st_mode & 0o111) == row["executable"], "native_source_changed_during_build")


def bundle_identity(root):
    root = Path(root).resolve()
    try:
        value = plistlib.loads(read_regular(root / "Contents/Info.plist", 1_000_000))
    except (ValueError, plistlib.InvalidFileException):
        raise NativeRefused("native_bundle_info_invalid") from None
    fields = {key: value.get(key) for key in ("CFBundleIdentifier", "CFBundleExecutable", "CFBundleShortVersionString", "CFBundleVersion")}
    require(all(isinstance(value, str) and 0 < len(value) <= 200 for value in fields.values()), "native_bundle_info_invalid")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+", fields["CFBundleExecutable"]), "native_bundle_executable_invalid")
    executable = root / "Contents/MacOS" / fields["CFBundleExecutable"]
    require(executable.is_file() and not executable.is_symlink() and executable.stat().st_mode & 0o111, "native_bundle_executable_missing")
    require(re.fullmatch(r"\d+\.\d+\.\d+", fields["CFBundleShortVersionString"])
            and re.fullmatch(r"[1-9][0-9]{0,8}", fields["CFBundleVersion"]), "native_bundle_version_invalid")
    return fields
