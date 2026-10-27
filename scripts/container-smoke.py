"""Build-independent Docker smoke check. Run after building line-oa:test.

Uses an empty Docker volume and no Supervisor token or LINE session. Checks
health, lack of published ports, SIGTERM, restart and persistence. Never sends.
"""
import argparse
import json
import subprocess
import uuid


def run(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', default='line-oa:test')
parser.add_argument('--arch', choices=['amd64', 'aarch64'])
args = parser.parse_args()
image = json.loads(run('image', 'inspect', args.image))[0]
docker_arch = image['Architecture']
expected_arch = args.arch or {'amd64': 'amd64', 'arm64': 'aarch64'}[docker_arch]
assert docker_arch == {'amd64': 'amd64', 'aarch64': 'arm64'}[expected_arch]
assert image['Config']['Labels']['io.hass.arch'] == expected_arch
expected_node_arch = {'amd64': 'x64', 'aarch64': 'arm64'}[expected_arch]
name = "line-oa-smoke-" + uuid.uuid4().hex[:12]
volume = name + "-data"
run("volume", "create", volume)
try:
    run("run", "-d", "--name", name, "-v", volume + ":/data", args.image)
    probe = """let ready=false;for(let i=0;i<40;i++){try{const r=await fetch('http://127.0.0.1:8787/api/v1/health');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,250))}if(!ready)process.exit(1)"""
    run("exec", name, "node", "--input-type=module", "-e", probe)
    details = json.loads(run("inspect", name))[0]
    assert not details["HostConfig"]["PortBindings"]
    identity = json.loads(run("exec", name, "node", "-e", "console.log(require('fs').readFileSync('/data/multi/control/config.json','utf8'))"))["instanceId"]
    node_arch = run('exec', name, 'node', '-p', 'process.arch')
    assert node_arch == expected_node_arch
    labels = image['Config']['Labels']
    assert labels['io.hass.version'] == json.loads(run('exec', name, 'node', '-p', 'JSON.stringify(JSON.parse(require("fs").readFileSync("/app/package.json","utf8")).version)'))
    # Only runtime source, the audited startup/preflight scripts, public web and
    # package metadata; no compiler, tests, adapter utilities or node_modules.
    run("exec", name, "node", "-e", "const fs=require('fs');for(const p of ['/app/node_modules','/app/dist/tests','/usr/local/bin/npm'])if(fs.existsSync(p))process.exit(1);const allowed=new Set(['controlled-start.js','family-downgrade-preflight.js']);const scripts=fs.readdirSync('/app/dist/scripts');if(scripts.length!==allowed.size||scripts.some(p=>!allowed.has(p)))process.exit(1)")
    run("stop", "--time", "30", name)
    assert json.loads(run("inspect", name))[0]["State"]["ExitCode"] == 0
    run("start", name)
    run("exec", name, "node", "--input-type=module", "-e", probe)
    after = json.loads(run("exec", name, "node", "-e", "console.log(require('fs').readFileSync('/data/multi/control/config.json','utf8'))"))["instanceId"]
    assert identity == after
    print(f"Docker smoke passed [{expected_arch}, Node {node_arch}]: health, private ports, graceful stop and stable identity")
finally:
    subprocess.run(["docker", "rm", "-f", name], check=False, capture_output=True)
    subprocess.run(["docker", "volume", "rm", volume], check=False, capture_output=True)
