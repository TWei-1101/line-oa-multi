"""Patcher smoke tests against source-compatible fixture, no network required."""
from pathlib import Path
import sys
import tempfile
import subprocess
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import build

class TestBuild(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.addon=self.root/'addon'; self.hacs=self.root/'hacs'
        (self.addon/'line_oa/app/src').mkdir(parents=True)
        (self.addon/'line_oa/app/web').mkdir(parents=True)
        (self.hacs/'custom_components/line_oa').mkdir(parents=True)
        (self.addon/'line_oa/app/src/server.ts').write_text('''export interface GatewayOptions {\n  dataDir?: string;\n}\nconst auth = new AuthManager(dataDir, config.secureCookies);\nawait auth.load();\nconst discovery = options.supervisor || supervisorToken\nreturn {\n  pairing, discovery, sessions, contacts, auth, uiServer, apiServer,\n  async stop() {\n        server.close(() => resolve()); server.closeIdleConnections();\n  }\n};\n''')
        (self.addon/'line_oa/Dockerfile').write_text('CMD ["node", "dist/src/server.js"]\n')
        (self.addon/'line_oa/config.yaml').write_text('''name: LINE OA\nslug: line_oa\nimage: ghcr.io/xangin/line-oa-ha-addon\ndescription: LINE OA Gateway with Ingress and secure Home Assistant pairing\npanel_title: LINE OA\n''')
        (self.hacs/'custom_components/line_oa/api.py').write_text('''import uuid\nAPI_ALIASES="/api/v1/aliases"\nasync def async_get_aliases(self) -> list[str]:\n    resp = await self._get(API_ALIASES)\nasync def async_send_text(self, who: str, message: str) -> SendResult:\n    payload = {"who": who, "message": message, "request_id": request_id}\n    return await self._post_message(\n        API_MESSAGES_TEXT, request_id, TEXT_POST_TIMEOUT, json_body=payload\n    )\nasync def async_send_image(\n    self,who: str,image: bytes,content_type: str,filename: str,\n) -> SendResult:\n        filename: str,\n    ) -> SendResult:\n    return await self._post_message(\n        API_MESSAGES_IMAGE, request_id, IMAGE_POST_TIMEOUT, form=form\n    )\n''')
        svc='''from collections.abc import Awaitable\n
def single_who(value: Any) -> str:
    return value

def _get_entry(hass: HomeAssistant):\n    return entries[0]\nasync def _async_check_alias(hass: HomeAssistant, entry: LineOAConfigEntry, who: str) -> None:\n    aliases = await entry.runtime_data.client.async_get_aliases()\n\nasync def _async_send_image(\n    *,\n    kind: str,\n) -> ServiceResponse:\n    client.async_send_image(who, image.content, image.content_type, image.filename),\n'''
        svc+=''.join('''vol.Required(ATTR_WHO): single_who,\n    await _async_check_alias(hass, entry, who)\n''' for _ in range(3))
        svc+='''entry.runtime_data.client.async_send_text(who, call.data[ATTR_MESSAGE]),\nreturn await _async_send_image(hass, entry, who, image, kind="image")\nreturn await _async_send_image(hass, entry, who, image, kind="image")\nreturn await _async_send_image(hass, entry, who, image, kind="screen shot")\n'''
        (self.hacs/'custom_components/line_oa/services.py').write_text(svc)
        (self.hacs/'custom_components/line_oa/services.yaml').write_text('send_text:\n  fields:\n    who:\nsend_image:\n  fields:\n    who:\nsend_screen_shot:\n  fields:\n    who:\n')
        (self.hacs/'custom_components/line_oa/__init__.py').write_text('from .services import async_setup_services\n    entry.runtime_data = coordinator\n')
        (self.hacs/'custom_components/line_oa/sensor.py').write_text('return {"account_name": data.account_name if data else None}\n')

    def tearDown(self):self.temp.cleanup()

    def test_patch_and_no_hardcoded_accounts(self):
        # Patch isolated copies; inputs must not change.
        import shutil
        dst=self.root/'dst'
        shutil.copytree(self.addon,dst/'addon')
        shutil.copytree(self.hacs,dst/'hacs')
        original=(self.addon/'line_oa/app/src/server.ts').read_text()
        build.addon(dst/'addon'); build.hacs(dst/'hacs')
        patched=(dst/'addon/line_oa/app/src/multi-server.ts').read_text()
        self.assertIn('addAccount(id:', patched)
        self.assertIn('const MAX_ACCOUNTS = 20',patched)
        self.assertIn("accountDir,id",patched)
        for name in ('main','invest','crypto'):
            self.assertNotIn(f"'{name}'",patched)
        self.assertEqual(original,(self.addon/'line_oa/app/src/server.ts').read_text())
        s=(dst/'hacs/custom_components/line_oa/services.py').read_text()
        self.assertEqual(s.count('vol.Required("account")'),3)
        self.assertEqual(s.count('call.data["account"]'),7)
        self.assertEqual((dst/'addon/line_oa/config.yaml').read_text().count('image:'),0)
        self.assertIn('slug: line_oa_multi', (dst/'addon/line_oa/config.yaml').read_text())
        self.assertTrue((dst/'addon/line_oa/app/src/webhook.ts').exists())
        self.assertTrue((dst/'hacs/custom_components/line_oa/webhook_bridge.py').exists())

    def test_fails_closed_if_upstream_changes(self):
        p=self.addon/'line_oa/app/src/server.ts'
        p.write_text(p.read_text().replace('  dataDir?: string;','  directory?: string;'))
        with self.assertRaisesRegex(RuntimeError,'anchor expected once'):
            build.addon(self.addon)

if __name__=='__main__':unittest.main()
