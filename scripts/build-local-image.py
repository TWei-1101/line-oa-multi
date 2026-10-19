"""Build for the active Docker engine architecture, using HA's architecture name."""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--tag', default='line-oa:test')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
engine = subprocess.check_output(['docker', 'info', '--format', '{{.Architecture}}'], text=True).strip()
arch, platform = {'aarch64': ('aarch64', 'linux/arm64'), 'arm64': ('aarch64', 'linux/arm64'),
                  'x86_64': ('amd64', 'linux/amd64'), 'amd64': ('amd64', 'linux/amd64')}[engine]
version = json.loads((root / 'line_oa/app/package.json').read_text())['version']
subprocess.run(['docker', 'build', '--provenance=false', '--platform', platform, '--build-arg', f'BUILD_ARCH={arch}',
                '--build-arg', f'BUILD_VERSION={version}', '-t', args.tag, str(root / 'line_oa')], check=True)
print(f'Built {args.tag}: Docker {platform}, Home Assistant {arch}')
