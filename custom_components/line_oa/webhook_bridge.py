"""LINE official webhook bridge for a single, dynamic multi-account Add-on.

HA exposes only /api/webhook/<opaque-id>. The raw request is forwarded without
transformation to the paired internal Gateway for channel-secret verification.
Verified events are retrieved from the durable Gateway inbox and fired on the
Home Assistant event bus (event type: line_oa_message). No auto-reply occurs.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
import logging
from typing import Any

import aiohttp
from aiohttp import web

from homeassistant.components import webhook
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval

from .api import LineOAError

LOGGER = logging.getLogger(__name__)
ID_KEY = "line_webhook_id"
CURSOR_KEY = "line_webhook_cursor"
EVENT_TYPE = "line_oa_message"
MAX_RAW = 256 * 1024


def register_line_webhook(hass: HomeAssistant, entry: Any) -> None:
    """Install one public webhook for all LINE OA accounts in this Gateway."""
    webhook_id = entry.data.get(ID_KEY)
    if not isinstance(webhook_id, str) or not webhook_id:
        webhook_id = webhook.async_generate_id()
        hass.config_entries.async_update_entry(entry, data={**entry.data, ID_KEY: webhook_id})

    async def handle(_hass: HomeAssistant, _webhook_id: str, request: web.Request) -> web.Response:
        signature = request.headers.get("X-Line-Signature", "")
        if not signature:
            return web.Response(status=401)
        if request.content_length is not None and request.content_length > MAX_RAW:
            return web.Response(status=413)
        # The original bytes and signature MUST be unchanged by a JSON parser.
        chunks = []
        size = 0
        async for chunk in request.content.iter_chunked(16384):
            size += len(chunk)
            if size > MAX_RAW:
                return web.Response(status=413)
            chunks.append(chunk)
        raw = b"".join(chunks)
        client = entry.runtime_data.client
        try:
            result = await client.async_forward_line_webhook(raw, signature)
        except aiohttp.ClientError, TimeoutError:
            LOGGER.warning("LINE webhook Gateway unavailable")
            return web.Response(status=503)
        if result == 200:
            return web.Response(status=200, text="OK")
        # Never claim success on failed signature / wrong destination / full inbox.
        return web.Response(status=result if 400 <= result < 600 else 502)

    webhook.async_register(
        hass,
        "line_oa",
        "LINE OA Multi Incoming",
        webhook_id,
        handle,
        local_only=False,
        allowed_methods=["POST"],
    )
    entry.async_on_unload(lambda: webhook.async_unregister(hass, webhook_id))

    poll_lock = asyncio.Lock()

    async def poll_events(_now: Any) -> None:
        if poll_lock.locked():
            return
        async with poll_lock:
            await drain_events()

    async def drain_events() -> None:
        try:
            cursor = int(entry.data.get(CURSOR_KEY, 0))
            result = await entry.runtime_data.client.async_get_webhook_events(cursor)
            events = result["events"]
            if not isinstance(events, list):
                return
            for item in events:
                if not isinstance(item, dict) or not isinstance(item.get("sequence"), int):
                    continue
                if item["sequence"] <= cursor:
                    continue
                # If inbox retention skipped data, log the gap (cannot reconstruct).
                if item["sequence"] > cursor + 1 and cursor > 0:
                    LOGGER.warning(
                        "LINE webhook inbox gap: expected %s got %s", cursor + 1, item["sequence"]
                    )
                hass.bus.async_fire(EVENT_TYPE, item)
                cursor = item["sequence"]
            if cursor != entry.data.get(CURSOR_KEY, 0):
                hass.config_entries.async_update_entry(
                    entry, data={**entry.data, CURSOR_KEY: cursor}
                )
        except aiohttp.ClientError, LineOAError, TimeoutError, ValueError, KeyError, TypeError:
            LOGGER.debug("LINE webhook event poll unavailable")

    entry.async_on_unload(async_track_time_interval(hass, poll_events, timedelta(seconds=5)))
    # Queue may contain events received while Home Assistant was restarting.
    entry.async_create_background_task(hass, poll_events(None), "LINE OA webhook inbox catch-up")
