from openmemory.client import OpenMemory


def test_exhaustive_client_methods(monkeypatch):
    """Call most public methods to ensure broad coverage of `client.py`."""

    def fake_r(self, method, path, body=None):
        # Return a shape that satisfies most call sites
        return {
            'ok': True,
            'id': 'id-1',
            'memory_id': 'mem-1',
            'primary_sector': 'semantic',
            'sectors': ['semantic'],
            'deduplicated': True,
            'updated': True,
            'success': True,
        }

    monkeypatch.setattr(OpenMemory, '_r', fake_r)

    c = OpenMemory(api_key='k', base_url='http://example.com/')

    # Basic endpoints
    assert c.health()['ok']
    assert c.get_health()['ok']
    assert c.sectors()['ok']
    assert c.get_sectors()['ok']

    # Memory operations
    add_res = c.add('hello', tags=['t'], metadata={'m': 1}, salience=0.5, user_id='u1')
    assert add_res['id'] == 'id-1'

    qres = c.query('q', k=2, filters={'user_id': 'u1'})
    assert qres['ok']

    assert c.query_sector('q', 'semantic', k=3)['ok']
    assert c.reinforce('mem-1', boost=0.4)['ok']
    assert c.update('mem-1', content='x', tags=['a'])['updated']
    assert c.delete('mem-1')['ok']

    # Listing/pagination
    assert c.all(limit=5, offset=0)['ok']
    assert c.get_by_sector('semantic', limit=5, offset=0)['ok']

    # User endpoints
    assert c.get_user_memories('u1')['ok']
    assert c.get_user_summary('u1')['ok']
    assert c.regenerate_user_summary('u1')['ok']

    # IDE endpoints
    assert c.ide_store_event('edit', file_path='a.py', content='x')['ok']
    assert c.ide_query_context('q', k=3, session_id='s1')['ok']
    assert c.ide_start_session(user_id='u1', project_name='p')['ok']
    assert c.ide_end_session('s1')['ok']
    assert c.ide_get_patterns('s1')['ok']

    # Compression
    assert c.compress('txt', algorithm='semantic')['ok']
    assert c.compress_batch(['a', 'b'], algorithm='semantic')['ok']
    assert c.analyze_compression('t')['ok']
    assert c.get_compression_stats()['ok']

    # LangGraph
    assert c.lgm_store('n1', 'content', namespace='ns')['ok']
    assert c.lgm_retrieve('n1', 'q', k=4)['ok']
    assert c.lgm_get_context('n1')['ok']
    assert c.lgm_create_reflection('n1', 'r')['ok']
    assert c.lgm_get_config()['ok']
