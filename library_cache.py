"""Remove generated Library audio while protecting registered originals."""
from pathlib import Path
import re
import shutil
import stat

from preview_engine import preview_key
from stem_engine import cache_folder


def _safe(path, root):
    if not path.resolve().is_relative_to(root) or path.resolve() == root:
        raise RuntimeError("A cache path is outside the library.")
    if path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
        raise RuntimeError("Linked cache paths cannot be cleared.")


def clear_generated_audio(library, protected_names, source=None):
    root = Path(library).resolve()
    protected = {str(name).casefold() for name in protected_names}
    legacy = [path for path in root.iterdir() if path.is_file() and path.name.casefold() not in protected and
              re.search(r" \((?:Vocals|Instrumental)\)\.(?:mp3|wav|aac|flac|m4a)$", path.name, re.I)]
    if source is None:
        targets = [root / ".stem-cache", root / ".preview-cache", *legacy]
    else:
        source = Path(source)
        legacy = [path for path in legacy if path.stem.rsplit(" (", 1)[0] == source.stem]
        targets = [cache_folder(source), *legacy]
        for audio in [source, *legacy]:
            if audio.is_file():
                key = preview_key(audio)
                targets.extend([root / ".preview-cache" / (key + ".mp3"), root / ".preview-cache" / (key + ".mp3.lock")])
    removed = size = 0
    failures = []
    for target in targets:
        if not target.exists() and not target.is_symlink():
            continue
        _safe(target, root)
        nodes = list(target.rglob("*")) if target.is_dir() else [target]
        for node in nodes:
            _safe(node, root)
        files = [node for node in nodes if node.is_file()]
        total = sum(node.stat().st_size for node in files)
        try:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
            removed += len(files)
            size += total
        except OSError:
            failures.append(target.name)
    return {"removed_files": removed, "removed_bytes": size, "failed_paths": failures}
