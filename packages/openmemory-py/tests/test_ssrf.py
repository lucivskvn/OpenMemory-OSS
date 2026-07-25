import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import httpx
from openmemory.utils.fetch import (
    is_ip_private_or_restricted,
    fetch_with_ssrf_protection,
)

def test_is_ip_private_or_restricted_ipv4():
    assert is_ip_private_or_restricted("127.0.0.1") is True
    assert is_ip_private_or_restricted("10.0.0.5") is True
    assert is_ip_private_or_restricted("172.16.31.254") is True
    assert is_ip_private_or_restricted("192.168.1.100") is True
    assert is_ip_private_or_restricted("169.254.1.1") is True
    assert is_ip_private_or_restricted("100.64.0.50") is True
    assert is_ip_private_or_restricted("0.0.0.0") is True
    assert is_ip_private_or_restricted("8.8.8.8") is False


def test_is_ip_private_or_restricted_ipv6():
    assert is_ip_private_or_restricted("::1") is True
    assert is_ip_private_or_restricted("::") is True
    assert is_ip_private_or_restricted("fe80::1") is True
    assert is_ip_private_or_restricted("fc00::abc") is True
    assert is_ip_private_or_restricted("ff02::1") is True
    assert is_ip_private_or_restricted("::ffff:127.0.0.1") is True
    assert is_ip_private_or_restricted("::ffff:8.8.8.8") is False


@pytest.mark.asyncio
@patch("openmemory.utils.fetch.create_ssrf_protected_client")
async def test_fetch_with_ssrf_protection_cross_origin_redirect(mock_create_client):
    # Setup mock responses for redirect flow
    mock_client = MagicMock()
    mock_create_client.return_value = mock_client

    # First request response: a redirect
    mock_resp1 = MagicMock()
    mock_resp1.is_redirect = True
    mock_resp1.status_code = 302
    mock_resp1.headers = httpx.Headers({"location": "https://attacker.com/leak"})
    mock_resp1.aread = AsyncMock()

    # Second request response: 200 OK
    mock_resp2 = MagicMock()
    mock_resp2.is_redirect = False
    mock_resp2.status_code = 200
    mock_resp2.headers = httpx.Headers({"content-type": "text/html"})
    mock_resp2.text = "success"
    mock_resp2.aiter_bytes = MagicMock()

    async def mock_aiter():
        yield b"success"

    mock_resp2.aiter_bytes.return_value = mock_aiter()

    # Configure context manager for stream()
    mock_stream_ctx1 = AsyncMock()
    mock_stream_ctx1.__aenter__.return_value = mock_resp1
    mock_stream_ctx1.__aexit__.return_value = None

    mock_stream_ctx2 = AsyncMock()
    mock_stream_ctx2.__aenter__.return_value = mock_resp2
    mock_stream_ctx2.__aexit__.return_value = None

    mock_client.stream.side_effect = [mock_stream_ctx1, mock_stream_ctx2]

    headers = {
        "Authorization": "Bearer token123",
        "Cookie": "session=abc",
        "X-API-Key": "secret-key",
        "Custom-Header": "value"
    }

    resp = await fetch_with_ssrf_protection(
        "https://example.com/start",
        headers=headers,
        auth=("username", "password"),
        cookies={"foo": "bar"},
    )

    assert resp.status_code == 200
    assert resp.text == "success"

    # Verify that the second call (redirect target) stripped cross-origin credentials
    calls = mock_client.stream.call_args_list
    assert len(calls) == 2

    # Second call headers and kwargs
    second_call_headers = calls[1][1]["headers"]
    second_call_kwargs = calls[1][1]

    assert "custom-header" in {k.lower() for k in second_call_headers.keys()}
    assert "authorization" not in {k.lower() for k in second_call_headers.keys()}
    assert "cookie" not in {k.lower() for k in second_call_headers.keys()}
    assert "x-api-key" not in {k.lower() for k in second_call_headers.keys()}
    assert "auth" not in second_call_kwargs
    assert "cookies" not in second_call_kwargs
