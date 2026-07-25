import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import httpx
from openmemory.utils.fetch import (
    is_ip_private_or_restricted,
    fetch_with_ssrf_protection,
)

def _setup_mock_200_response():
    mock_resp = MagicMock()
    mock_resp.is_redirect = False
    mock_resp.status_code = 200
    mock_resp.headers = httpx.Headers({"content-type": "text/html"})
    mock_resp.text = "success"
    mock_resp.aiter_bytes = MagicMock()

    async def mock_aiter():
        yield b"success"

    mock_resp.aiter_bytes.return_value = mock_aiter()
    return mock_resp


def _setup_stream_context(mock_resp):
    mock_stream_ctx = AsyncMock()
    mock_stream_ctx.__aenter__.return_value = mock_resp
    mock_stream_ctx.__aexit__.return_value = None
    return mock_stream_ctx


def test_is_ip_private_or_restricted_ipv4():
    restricted_ips = [
        "127.0.0.1", "10.0.0.5", "172.16.31.254",
        "192.168.1.100", "169.254.1.1", "100.64.0.50", "0.0.0.0"
    ]
    for ip in restricted_ips:
        assert is_ip_private_or_restricted(ip) is True

    assert is_ip_private_or_restricted("8.8.8.8") is False


def test_is_ip_private_or_restricted_ipv6():
    restricted_ipv6s = [
        "::1", "::", "fe80::1", "fc00::abc",
        "ff02::1", "::ffff:127.0.0.1"
    ]
    for ip in restricted_ipv6s:
        assert is_ip_private_or_restricted(ip) is True

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
    mock_resp2 = _setup_mock_200_response()

    # Configure context manager for stream()
    mock_stream_ctx1 = _setup_stream_context(mock_resp1)
    mock_stream_ctx2 = _setup_stream_context(mock_resp2)

    mock_client.stream.side_effect = [mock_stream_ctx1, mock_stream_ctx2]

    headers = {
        "Authorization": "Bearer token123",
        "Cookie": "session=abc",
        "Cookie2": "session2=def",
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

    # First call headers and kwargs
    first_call_headers = calls[0][1]["headers"]
    first_call_kwargs = calls[0][1]

    assert "custom-header" in {k.lower() for k in first_call_headers.keys()}
    assert "authorization" in {k.lower() for k in first_call_headers.keys()}
    assert "cookie" in {k.lower() for k in first_call_headers.keys()}
    assert "cookie2" in {k.lower() for k in first_call_headers.keys()}
    assert "x-api-key" in {k.lower() for k in first_call_headers.keys()}
    assert first_call_kwargs.get("auth") == ("username", "password")
    assert first_call_kwargs.get("cookies") == {"foo": "bar"}

    # Second call headers and kwargs
    second_call_headers = calls[1][1]["headers"]
    second_call_kwargs = calls[1][1]

    assert "custom-header" in {k.lower() for k in second_call_headers.keys()}
    assert "authorization" not in {k.lower() for k in second_call_headers.keys()}
    assert "cookie" not in {k.lower() for k in second_call_headers.keys()}
    assert "cookie2" not in {k.lower() for k in second_call_headers.keys()}
    assert "x-api-key" not in {k.lower() for k in second_call_headers.keys()}
    assert "auth" not in second_call_kwargs
    assert "cookies" not in second_call_kwargs


@pytest.mark.asyncio
@patch("openmemory.utils.fetch.create_ssrf_protected_client")
async def test_fetch_with_ssrf_protection_chunked_redirect_body(mock_create_client):
    mock_client = MagicMock()
    mock_create_client.return_value = mock_client

    # First request: 302 redirect with a mock aiter_bytes (chunked body) and mock aread method
    mock_resp1 = MagicMock()
    mock_resp1.is_redirect = True
    mock_resp1.status_code = 302
    mock_resp1.headers = httpx.Headers({"location": "https://attacker.com/leak"})
    mock_resp1_aiter = MagicMock()
    mock_resp1.aiter_bytes = mock_resp1_aiter
    mock_resp1_aread = AsyncMock()
    mock_resp1.aread = mock_resp1_aread

    # Second request: 200 OK
    mock_resp2 = _setup_mock_200_response()

    mock_stream_ctx1 = _setup_stream_context(mock_resp1)
    mock_stream_ctx2 = _setup_stream_context(mock_resp2)

    mock_client.stream.side_effect = [mock_stream_ctx1, mock_stream_ctx2]

    resp = await fetch_with_ssrf_protection("https://example.com/start")

    assert resp.status_code == 200
    assert resp.text == "success"

    # Verify that the redirect response's body was NEVER read/buffered (neither aread nor aiter_bytes was called)
    mock_resp1_aiter.assert_not_called()
    mock_resp1_aread.assert_not_called()
