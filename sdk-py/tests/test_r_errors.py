import pytest
import urllib.error

from openmemory.client import OpenMemory


class DummyResponse:
    def __init__(self, data=b"{}"):
        self._data = data

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def test_r_raises_on_urlerror(monkeypatch):
    client = OpenMemory()

    def fake_urlopen(req, timeout=60):
        raise urllib.error.URLError('simulated network failure')

    monkeypatch.setattr('urllib.request.urlopen', fake_urlopen)

    with pytest.raises(urllib.error.URLError):
        client.health()


def test_r_raises_on_http_error(monkeypatch):
    client = OpenMemory()

    def fake_urlopen(req, timeout=60):
        raise urllib.error.HTTPError(url=req.full_url if hasattr(req, 'full_url') else 'url', code=500, msg='Internal', hdrs=None, fp=None)

    monkeypatch.setattr('urllib.request.urlopen', fake_urlopen)

    with pytest.raises(urllib.error.HTTPError):
        client.health()


def test_r_timeout_propagates(monkeypatch):
    client = OpenMemory()

    def fake_urlopen(req, timeout=60):
        # simulate a socket timeout by raising the built-in timeout exception
        raise TimeoutError('simulated timeout')

    monkeypatch.setattr('urllib.request.urlopen', fake_urlopen)

    with pytest.raises(TimeoutError):
        client.health()
import urllib.error

from openmemory.client import OpenMemory


def test__r_raises_on_url_error(monkeypatch):
    def fake_urlopen(req, timeout=60):
        raise urllib.error.URLError('no route')

    monkeypatch.setattr('urllib.request.urlopen', fake_urlopen)
    c = OpenMemory()
    try:
        c._r('GET', '/health')
        raised = False
    except Exception as e:
        raised = True
        assert isinstance(e, urllib.error.URLError)
        assert 'no route' in str(e)

    assert raised


def test__r_raises_on_http_error(monkeypatch):
    class FakeHTTPError(Exception):
        pass

    def fake_urlopen(req, timeout=60):
        raise urllib.error.HTTPError(req.full_url, 500, 'err', hdrs=None, fp=None)

    monkeypatch.setattr('urllib.request.urlopen', fake_urlopen)
    c = OpenMemory()
    try:
        c._r('GET', '/health')
        raised = False
    except Exception as e:
        raised = True
        assert isinstance(e, urllib.error.HTTPError)

    assert raised
