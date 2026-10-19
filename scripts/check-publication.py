"""Fail publication checks without echoing potentially sensitive matching content."""
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent.parent
names = sorted(set(subprocess.check_output(
    ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard", "-z"]
).decode().split("\0")) - {""})
errors = []
patterns = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "GitHub credential": re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})"),
    "private workstation path": re.compile("/" + "Users/" + r"[^\s\"']+"),
    "private LAN address": re.compile(r"\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b"),
}
for name in names:
    path = root / name
    if not path.is_file():
        errors.append(f"Missing tracked file: {name}")
        continue
    parts = Path(name).parts
    if set(parts) & {"node_modules", "dist", "data", "secrets", "runtime", ".git"} or path.name == ".env" or path.suffix in {".tar", ".tgz", ".gz", ".zip", ".log", ".pem", ".key"}:
        errors.append(f"Private/generated file in publication: {name}")
    if path.stat().st_size > 5 * 1024 * 1024:
        errors.append(f"Unexpected large file: {name}")
    try:
        content = path.read_text()
    except UnicodeDecodeError:
        continue
    for label, pattern in patterns.items():
        if pattern.search(content):
            errors.append(f"{label}: {name} (matching content withheld)")
    if path.suffix == ".md":
        for target in re.findall(r"\]\(([^\s)]+)\)", content):
            if re.match(r"(?:[a-z]+:|#)", target):
                continue
            target = target.split("#", 1)[0]
            if target and not (path.parent / target).exists():
                errors.append(f"Broken local Markdown link: {name} -> {target}")
assert not errors, "\n".join(errors)
print(f"Publication checks passed: {len(names)} files; private/generated paths, common credentials and local links checked")
