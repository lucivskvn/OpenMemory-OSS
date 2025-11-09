import urllib.request

from openmemory.client import OpenMemory


def make_client(monkeypatch, fake_return=None):
    called = {}

    def fake_r(self, method, path, body=None):
        called['method'] = method
        called['path'] = path
        called['body'] = body
        return fake_return if fake_return is not None else {'ok': True}

    monkeypatch.setattr(OpenMemory, '_r', fake_r)
    return called


def test_query_builds_correct_body(monkeypatch):
    called = make_client(monkeypatch)
    c = OpenMemory()
    res = c.query('hello', k=3, filters={'sector': 'semantic', 'user_id': 'u1'})

    assert called['method'] == 'POST'
    assert called['path'] == '/memory/query'
    assert called['body']['query'] == 'hello'
    assert called['body']['k'] == 3
    assert called['body']['filters']['user_id'] == 'u1'


def test_compression_endpoints(monkeypatch):
    called = make_client(monkeypatch)
    c = OpenMemory()
    c.compress('text', algorithm='semantic')
    assert called['path'] == '/api/compression/compress'

    c.compress_batch(['a', 'b'], algorithm='syntactic')
    assert called['path'] == '/api/compression/batch'

    c.analyze_compression('text')
    assert called['path'] == '/api/compression/analyze'

    c.get_compression_stats()
    assert called['path'] == '/api/compression/stats'


def test_langgraph_methods(monkeypatch):
    called = make_client(monkeypatch)
    c = OpenMemory()
    c.lgm_store('n1', 'content', namespace='ns')
    assert called['path'] == '/lgm/store'

    c.lgm_retrieve('n1', 'q', k=4)
    assert called['path'] == '/lgm/retrieve'

    c.lgm_get_context('n1')
    assert called['path'] == '/lgm/context'

    c.lgm_create_reflection('n1', 'r')
    assert called['path'] == '/lgm/reflection'

    c.lgm_get_config()
    assert called['path'] == '/lgm/config'


def test_user_summary_and_regen(monkeypatch):
    called = make_client(monkeypatch)
    c = OpenMemory()
    c.get_user_summary('u1')
    assert called['path'] == '/users/u1/summary'

    c.regenerate_user_summary('u1')
    assert called['path'] == '/users/u1/summary/regenerate'
