"""Check exclusion rules using the same PurePath.match semantics as Supervisor.

No live data or secrets. This does not claim the local-build image is excluded:
Supervisor embeds image.tar until a downloadable image is configured.
"""
from pathlib import Path, PurePosixPath
import json
import re

root = Path(__file__).resolve().parent.parent
config = (root / "line_oa/config.yaml").read_text()
block = config.split("backup_exclude:\n", 1)[1].split("options:", 1)[0]
patterns = [line.strip()[2:].strip('"\'') for line in block.splitlines() if line.strip().startswith("- ")]
origin = PurePosixPath("/data/apps/data/local_line_oa")
def excluded(relative):
    return any((origin / relative).match(pattern) for pattern in patterns)

for item in ["tmp", "tmp/photo.png", "tmp/nested/payload", "cache", "cache/download.bin", "cache/nested/blob", ".cache", ".cache/large.bin", "logs", "logs/service.log", "service.log", "nested/service.log"]:
    # Excluding the directory prevents traversal, including files nested more deeply.
    path = PurePosixPath(item)
    assert excluded(path) or any(excluded(parent) for parent in path.parents if str(parent) != "."), item
for item in ["config.json", "aliases.json", "options.json", "secrets", "secrets/line-session.json", "secrets/api-key.json", "secrets/admin.json"]:
    assert not excluded(item), item
version = json.loads((root / "line_oa/app/package.json").read_text())["version"]
assert f'version: "{version}"' in config
assert f"const version = '{version}';" in (root / "line_oa/app/src/server.ts").read_text()
assert f'ARG BUILD_VERSION={version}' in (root / "line_oa/Dockerfile").read_text()
print("Backup exclusions preserve credentials/settings and exclude recreatable data; version metadata matches")
if not re.search(r"^image:", config, re.M):
    print("Local-build mode: Supervisor still includes image.tar; registry publication is required before switching")
