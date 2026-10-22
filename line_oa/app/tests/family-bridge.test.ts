import test from 'node:test';
import assert from 'node:assert/strict';
import { FamilyBridge, FamilyBridgeError, validateFamilyRequest } from '../src/family-bridge.js';
const token = 'bridge-secret';
const request = { version: 1, event_id: 'evt-1', group_id: 'C' + 'a'.repeat(32), text: 'hello family' };
test('family protocol accepts only the exact text DTO', () => {
  assert.deepEqual(validateFamilyRequest(request, new Set([request.group_id])), request);
  for (const value of [{...request, agent:'main'}, {...request, text:'\0'}, {...request, group_id:'bad'}, {...request, text:''}, {...request, text:'x'.repeat(5001)}, {...request, version:2}]) assert.throws(() => validateFamilyRequest(value, new Set([request.group_id])), FamilyBridgeError);
});
test('family bridge constructs fixed upstream request, rejects command-like text and never forwards headers', async () => {
  let seen: {url: string; init?: RequestInit} | undefined;
  const bridge = new FamilyBridge({ token, groups:[request.group_id], fetch: async (input: RequestInfo | URL, init?: RequestInit) => { seen = {url:String(input),init}; return Response.json({ status:'completed', output:[{type:'message', role:'assistant', content:[{type:'output_text', text:'safe reply'}]}] }); }});
  const out = await bridge.dispatch(request, token);
  assert.equal(out.text, 'safe reply'); assert.equal(seen!.url, 'http://127.0.0.1:18790/v1/responses');
  const body = JSON.parse(String(seen!.init!.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['input','model','stream','user']); assert.equal(body.model, 'openclaw/family-line'); assert.equal(new Headers(seen!.init!.headers).get('x-openclaw-agent-id'),'family-line'); assert.match(JSON.stringify(body), /line-family:v1:family:[a-f0-9]{64}/);
  await assert.rejects(() => bridge.dispatch({...request, event_id:'evt-command', text:' @bot /config'}, token), FamilyBridgeError);
});
test('family ledger caches identical completion and holds changed payloads', async () => {
  let calls = 0; const bridge = new FamilyBridge({ token, groups:[request.group_id], fetch: async () => { calls++; return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}]}); }});
  await bridge.dispatch(request, token); await bridge.dispatch(request, token); assert.equal(calls, 1);
  await assert.rejects(() => bridge.dispatch({...request, text:'changed'}, token), FamilyBridgeError);
});
