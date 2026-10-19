#!/usr/bin/env python3
"""Create a separate dynamic multi-account fork from pinned upstream snapshots.
This does not touch either input repo. Fails fast on unexpected source changes.
"""
from __future__ import annotations
import argparse
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]

def once(content: str, old: str, new: str, file: str) -> str:
    n = content.count(old)
    if n != 1:
        raise RuntimeError(f'{file}: anchor expected once, found {n}: {old[:85]!r}')
    return content.replace(old, new, 1)

def edit(path: Path, transforms):
    s=path.read_text(encoding='utf-8')
    for old, new in transforms:
        s=once(s,old,new,str(path))
    path.write_text(s,encoding='utf-8')

def addon(path: Path):
    app = path/'line_oa'/'app'
    s=app/'src'/'server.ts'
    edit(s, [
       ('  dataDir?: string;\n', '  dataDir?: string;\n  authManager?: AuthManager;\n  disableDiscovery?: boolean;\n'),
       ('const auth = new AuthManager(dataDir, config.secureCookies);\nawait auth.load();',
        'const auth = options.authManager ?? new AuthManager(dataDir, config.secureCookies);\nif (!options.authManager) await auth.load();'),
       ('const discovery = options.supervisor || supervisorToken\n', 'const discovery = !options.disableDiscovery && (options.supervisor || supervisorToken)\n'),
       ('  pairing, discovery, sessions, contacts, auth, uiServer, apiServer,',
        '  pairing, discovery, sessions, contacts, auth, sender, uiServer, apiServer,\n  startEmbedded() {\n    sessionMonitor.start();\n    if (sessions.getStatus().state === \'VALIDATING\') void sessionMonitor.check();\n  },'),
       ('        server.close(() => resolve()); server.closeIdleConnections();',
        '        if (!server.listening) return resolve();\n        server.close(() => resolve()); server.closeIdleConnections();'),
    ])
    shutil.copyfile(ROOT/'overlay/line_oa/app/src/multi-server.ts',app/'src'/'multi-server.ts')
    shutil.copyfile(ROOT/'overlay/line_oa/app/src/webhook.ts',app/'src'/'webhook.ts')
    for file in ('multi.html','multi.js','multi.css'):
        shutil.copyfile(ROOT/'overlay/line_oa/app/web'/file,app/'web'/file)
    edit(path/'line_oa'/'Dockerfile', [('CMD ["node", "dist/src/server.js"]','CMD ["node", "dist/src/multi-server.js"]')])
    edit(path/'line_oa'/'config.yaml',[
       ('name: LINE OA\n','name: LINE OA Multi\n'),
       ('slug: line_oa\n','slug: line_oa_multi\n'),
       ('description: LINE OA Gateway with Ingress and secure Home Assistant pairing',
        'description: Dynamic multi-account LINE OA Gateway with isolated sessions'),
       ('panel_title: LINE OA\n','panel_title: LINE OA Multi\n'),
    ])
    # Do not repoint image to upstream published single-account image.
    edit(path/'line_oa'/'config.yaml', [('image: ghcr.io/xangin/line-oa-ha-addon\n',
     '# Locally built addon. Build locally or publish a custom multi-account image.\n')])

def hacs(path: Path):
    root=path/'custom_components'/'line_oa'
    ap=root/'api.py'
    edit(ap,[
      ('import uuid\n', 'import uuid\nfrom urllib.parse import quote\n'),
      ('async def async_get_aliases(self) -> list[str]:', 'async def async_get_aliases(self, account: str | None = None) -> list[str]:'),
      ('resp = await self._get(API_ALIASES)\n', 'resp = await self._get(f"{API_ALIASES}?account={quote(account, safe=\'\')}" if account else API_ALIASES)\n'),
      ('async def async_send_text(self, who: str, message: str) -> SendResult:',
       'async def async_send_text(self, who: str, message: str, account: str | None = None) -> SendResult:'),
      ('payload = {"who": who, "message": message, "request_id": request_id}',
       'payload = {"who": who, "message": message, "request_id": request_id}\n        if account:\n            payload["account"] = account'),
      ('API_MESSAGES_TEXT, request_id, TEXT_POST_TIMEOUT, json_body=payload',
       '(f"{API_MESSAGES_TEXT}?account={quote(account, safe=\'\')}" if account else API_MESSAGES_TEXT), request_id, TEXT_POST_TIMEOUT, json_body=payload'),
      ('        filename: str,\n    ) -> SendResult:',
       '        filename: str,\n        account: str,\n    ) -> SendResult:'),
      ('API_MESSAGES_IMAGE, request_id, IMAGE_POST_TIMEOUT, form=form',
       '(f"{API_MESSAGES_IMAGE}?account={quote(account, safe=\'\')}" if account else API_MESSAGES_IMAGE), request_id, IMAGE_POST_TIMEOUT, form=form'),
    ])
    svc=root/'services.py'
    s=svc.read_text()
    s=once(s,'from collections.abc import Awaitable\n', 'from collections.abc import Awaitable\nimport re\n', str(svc))
    s=once(s, 'def single_who(value: Any) -> str:', '''def single_account(value: Any) -> str:
    """Account IDs are explicit, never guessed from other fields."""
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", value):
        raise vol.Invalid("account must be a lowercase account ID (1-32 chars)")
    return value


def single_who(value: Any) -> str:''', str(svc))
    # Additional account field is required to fail closed on wrong account; no default.
    assert s.count('vol.Required(ATTR_WHO): single_who,')==3
    s=s.replace('vol.Required(ATTR_WHO): single_who,',
      'vol.Required("account"): single_account,\n        vol.Required(ATTR_WHO): single_who,')
    s=once(s,'async def _async_check_alias(hass: HomeAssistant, entry: LineOAConfigEntry, who: str) -> None:',
        'async def _async_check_alias(hass: HomeAssistant, entry: LineOAConfigEntry, who: str, account: str) -> None:',str(svc))
    s=once(s,'aliases = await entry.runtime_data.client.async_get_aliases()',
      'aliases = await entry.runtime_data.client.async_get_aliases(account)',str(svc))
    s=once(s,'    *,\n    kind: str,\n) -> ServiceResponse:', '    *,\n    kind: str,\n    account: str,\n) -> ServiceResponse:',str(svc))
    s=once(s,'client.async_send_image(who, image.content, image.content_type, image.filename),',
      'client.async_send_image(who, image.content, image.content_type, image.filename, account),',str(svc))
    assert s.count('await _async_check_alias(hass, entry, who)')==3
    s=s.replace('await _async_check_alias(hass, entry, who)', 'await _async_check_alias(hass, entry, who, call.data["account"])')
    s=once(s,'entry.runtime_data.client.async_send_text(who, call.data[ATTR_MESSAGE]),',
      'entry.runtime_data.client.async_send_text(who, call.data[ATTR_MESSAGE], call.data["account"]),',str(svc))
    assert s.count('kind="image")')==2
    s=s.replace('kind="image")','kind="image", account=call.data["account"])')
    s=once(s,'kind="screen shot")', 'kind="screen shot", account=call.data["account"])',str(svc))
    svc.write_text(s)
    yaml=root/'services.yaml'
    lines=yaml.read_text().splitlines(keepends=True)
    indices=[i for i,line in enumerate(lines) if line == '  fields:\n']
    if len(indices)!=3: raise RuntimeError('services.yaml fields changed')
    for i in reversed(indices):
       lines.insert(i+1,'    account:\n      required: true\n      example: invest\n      selector:\n        text:\n')
    yaml.write_text(''.join(lines))
    # Register HA's public webhook endpoint while leaving Gateway API private.
    init=root/'__init__.py'
    edit(init,[
      ('from .services import async_setup_services\n',
       'from .services import async_setup_services\nfrom .webhook_bridge import register_line_webhook\n'),
      ('    entry.runtime_data = coordinator\n',
       '    entry.runtime_data = coordinator\n    register_line_webhook(hass, entry)\n'),
    ])
    shutil.copyfile(ROOT/'overlay/hacs/custom_components/line_oa/webhook_bridge.py',root/'webhook_bridge.py')
    # Extend the existing aiohttp client; do not modify or retry LINE sends.
    suffix = """

    async def async_forward_line_webhook(self, raw: bytes, signature: str) -> int:
        \"\"\"Forward raw LINE POST for verification at the internal Gateway.\"\"\"
        async with self._session.post(
            f\"{self._base_url}/api/v1/webhook/line\",
            data=raw,
            headers={**self._headers(), \"X-Line-Signature\": signature,
                     \"Content-Type\": \"application/json\"},
            timeout=aiohttp.ClientTimeout(total=10, sock_connect=5),
            allow_redirects=False,
        ) as response:
            await response.content.read(1024)
            return response.status

    async def async_get_webhook_events(self, after: int) -> dict[str, Any]:
        \"\"\"Read durable, bounded inbox for HA event bus delivery.\"\"\"
        resp = await self._get(f\"/api/v1/webhook/events?after={after}\")
        if not isinstance(resp.body, dict):
            raise GatewayResponseError(\"Webhook event response malformed\")
        return resp.body
"""
    suffix = suffix.replace('\\\"', '"')
    ap.write_text(ap.read_text() + suffix)
    # Show the webhook path in session status sensor attributes.
    sensor=root/'sensor.py'
    edit(sensor, [
      ('return {"account_name": data.account_name if data else None}',
       'return {"account_name": data.account_name if data else None,\n'
       '                "webhook_path": "/api/webhook/" + str(self.coordinator.config_entry.data.get("line_webhook_id", ""))}')
    ])

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--addon-source',type=Path,required=True)
    parser.add_argument('--hacs-source',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    a=parser.parse_args()
    if a.output.exists():parser.error('output directory already exists: '+str(a.output))
    for dir, relative in [(a.addon_source,'line_oa/app/src/server.ts'), (a.hacs_source,'custom_components/line_oa/services.py')]:
        if not (dir/relative).is_file():parser.error('not a complete upstream source: '+str(dir))
    a.output.mkdir(parents=True)
    try:
        destAddon=a.output/'line-oa-ha-addon-dynamic'
        destHacs=a.output/'line-oa-hacs-dynamic'
        shutil.copytree(a.addon_source,destAddon,ignore=shutil.ignore_patterns('.git','node_modules','dist','.cache'))
        shutil.copytree(a.hacs_source,destHacs,ignore=shutil.ignore_patterns('.git','__pycache__','.pytest_cache'))
        addon(destAddon)
        hacs(destHacs)
        print('Created separate, single-add-on dynamic-account build:',a.output)
        print('Read README.md before building; upstream source changes may need reconciliation.')
    except Exception:
        shutil.rmtree(a.output)
        raise
if __name__=='__main__': main()
