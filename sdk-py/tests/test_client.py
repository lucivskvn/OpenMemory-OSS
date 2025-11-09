import urllib.request

import pytest

from openmemory.client import OpenMemory


def test_constructor_defaults():
    c = OpenMemory()
    assert c.k == ''
    assert c.u == 'http://localhost:8080'


def test_add_includes_user_id(monkeypatch):
    called = {}

    def fake_r(self, method, path, body=None):
        called['method'] = method
        called['path'] = path
        called['body'] = body
        return {'id': 'abc'}

    monkeypatch.setattr(OpenMemory, '_r', fake_r)
    c = OpenMemory()
    res = c.add('hello world', user_id='u1')

    assert called['method'] == 'POST'
    assert called['path'] == '/memory/add'
    assert called['body']['user_id'] == 'u1'
    assert res['id'] == 'abc'


def test_query_sector_calls_query(monkeypatch):
    called = {}

    def fake_query(self, query, k, filters):
        called['query'] = query
        called['k'] = k
        called['filters'] = filters
        return {'ok': True}

    monkeypatch.setattr(OpenMemory, 'query', fake_query)
    c = OpenMemory()
    res = c.query_sector('find me', 'semantic', 5)

    assert called['query'] == 'find me'
    assert called['k'] == 5
    assert called['filters'] == {'sector': 'semantic'}
    assert res['ok'] is True


def test_all_constructs_url_with_sector(monkeypatch):
    called = {}

    def fake_r(self, method, path, body=None):
        called['method'] = method
        called['path'] = path
        return {'ok': True}

    monkeypatch.setattr(OpenMemory, '_r', fake_r)
    c = OpenMemory()
    c.all(limit=10, offset=2, sector='semantic')

    assert '&sector=semantic' in called['path']


def test__r_sets_auth_header(monkeypatch):
    captured = {}

    class DummyResp:
        def read(self):
            return b'{"ok": true}'

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_urlopen(req, timeout=60):
        # urllib.request.Request exposes headers via .headers
        captured['headers'] = getattr(req, 'headers', {})
        return DummyResp()

    monkeypatch.setattr(urllib.request, 'urlopen', fake_urlopen)
    c = OpenMemory(api_key='secret', base_url='http://example.com/')
    res = c._r('GET', '/health')

    # urllib may capitalize header names; check case-insensitively
    auth_val = None
    for k, v in captured['headers'].items():
        if k.lower() == 'authorization':
            auth_val = v
            break
    assert auth_val == 'Bearer secret'


def test_update_builds_payload(monkeypatch):
    called = {}

    def fake_r(self, method, path, body=None):
        called['method'] = method
        called['path'] = path
        called['body'] = body
        return {'id': 'm1', 'updated': True}

    monkeypatch.setattr(OpenMemory, '_r', fake_r)
    c = OpenMemory()
    res = c.update('m1', content='new', tags=['x'], metadata={'a': 1})

    assert called['method'] == 'PATCH'
    assert called['path'] == '/memory/m1'
    assert called['body']['content'] == 'new'
    assert res['updated'] is True


def test_delete_calls_delete(monkeypatch):
    called = {}

    def fake_r(self, method, path, body=None):
        called['method'] = method
        called['path'] = path
        return {'ok': True}

    monkeypatch.setattr(OpenMemory, '_r', fake_r)
    c = OpenMemory()
    res = c.delete('m1')

    assert called['method'] == 'DELETE'
    assert called['path'] == '/memory/m1'
    assert res['ok'] is True


def test_reinforce_calls_post(monkeypatch):
    called = {}

    def fake_r(self, method, path, body=None):
        called['method'] = method
        called['path'] = path
        called['body'] = body
        return {'ok': True}

    monkeypatch.setattr(OpenMemory, '_r', fake_r)
    c = OpenMemory()
    res = c.reinforce('m1', boost=0.3)

    assert called['method'] == 'POST'
    assert called['path'] == '/memory/reinforce'
    assert called['body']['id'] == 'm1'
    assert called['body']['boost'] == 0.3
    assert res['ok'] is True


def test_ide_store_event_builds_payload(monkeypatch):
    called = {}

    def fake_r(self, method, path, body=None):
        called['method'] = method
        called['path'] = path
        called['body'] = body
        return {'ok': True, 'memory_id': 'z'}

    monkeypatch.setattr(OpenMemory, '_r', fake_r)
    c = OpenMemory()
    res = c.ide_store_event('edit', file_path='a.py', content='x')

    assert called['method'] == 'POST'
    assert called['path'] == '/api/ide/events'
    assert called['body']['event_type'] == 'edit'
    assert res['ok'] is True
    assert res['ok'] is True
