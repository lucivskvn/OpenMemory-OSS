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
