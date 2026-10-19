"""Regression checks for explicit account routing and the raw webhook bridge."""

from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import TestServer
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.line_oa.api import LineOAGatewayClient
from custom_components.line_oa.const import DOMAIN
from custom_components.line_oa.webhook_bridge import register_line_webhook
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession


async def test_required_account_fails_before_gateway(
    hass: HomeAssistant, setup_integration: MockConfigEntry, gateway_state
) -> None:
    """Missing or invalid account must never choose another OA implicitly."""
    for data in ({}, {"account": "../escape"}, {"account": "UPPER"}):
        with pytest.raises(Exception, match="account"):
            await hass.services.async_call(
                DOMAIN, "send_text", {"who": "simon", "message": "hello", **data}, blocking=True
            )
    assert not gateway_state.requests


async def test_client_routes_both_send_types_and_aliases_to_explicit_account(
    hass: HomeAssistant, socket_enabled: None
) -> None:
    """Check account query, payload and exact raw webhook bytes on real HTTP."""
    seen = []

    async def handle(request: web.Request) -> web.Response:
        seen.append(
            (request.path, dict(request.query), await request.read(), dict(request.headers))
        )
        if request.path.endswith("aliases"):
            return web.json_response({"aliases": ["simon"]})
        if request.path.endswith("/line"):
            return web.Response(status=200)
        return web.json_response({"status": "submitted", "request_id": "r", "who": "simon"})

    app = web.Application()
    app.router.add_route("*", "/{path:.*}", handle)
    async with TestServer(app) as server:
        client = LineOAGatewayClient(
            async_get_clientsession(hass), str(server.make_url("")).rstrip("/"), "test-key"
        )
        assert await client.async_get_aliases("alpha") == ["simon"]
        await client.async_send_text("simon", "hi", "alpha")
        await client.async_send_image("simon", b"fake", "image/png", "a.png", "beta")
        raw = b'{ "destination": "U123", "events": [] }\n'
        assert await client.async_forward_line_webhook(raw, "signature") == 200
    assert [item[1].get("account") for item in seen[:3]] == ["alpha", "alpha", "beta"]
    assert seen[-1][2] == raw
    assert seen[-1][3]["X-Line-Signature"] == "signature"


async def test_bridge_consumes_chunked_body_and_serializes_polling(
    hass: HomeAssistant, config_entry: MockConfigEntry
) -> None:
    """Partial stream reads must not truncate signed bytes; polls may not overlap."""
    from types import SimpleNamespace

    from homeassistant.util import dt as dt_util

    client = SimpleNamespace(
        async_forward_line_webhook=AsyncMock(return_value=200),
        async_get_webhook_events=AsyncMock(
            return_value={
                "events": [{"sequence": 1, "account": "alpha", "webhook_event_id": "event001"}]
            }
        ),
    )
    config_entry.add_to_hass(hass)
    config_entry.runtime_data = SimpleNamespace(client=client)
    events = []
    hass.bus.async_listen("line_oa_message", lambda event: events.append(event.data))
    with (
        patch("custom_components.line_oa.webhook_bridge.webhook.async_register") as register,
        patch("custom_components.line_oa.webhook_bridge.async_track_time_interval") as track,
    ):
        register_line_webhook(hass, config_entry)
    handler = register.call_args.args[4]

    class Content:
        async def iter_chunked(self, size):
            for chunk in (b'{"events":', b"[]}", b"\n"):
                yield chunk

    request = SimpleNamespace(
        headers={"X-Line-Signature": "sig"}, content_length=None, content=Content()
    )
    response = await handler(hass, config_entry.data["line_webhook_id"], request)
    assert response.status == 200
    client.async_forward_line_webhook.assert_awaited_once_with(b'{"events":[]}\n', "sig")
    poll = track.call_args.args[1]
    await poll(dt_util.utcnow())
    await poll(dt_util.utcnow())
    await hass.async_block_till_done()
    assert len(events) == 1
    assert config_entry.data["line_webhook_cursor"] == 1
