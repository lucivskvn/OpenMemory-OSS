import os
from openmemory.core.cfg import config, env


def test_default_metadata_backend():
    assert env.get('metadata_backend') == 'sqlite'


def test_default_vector_backend():
    assert env.get('vector_backend') == 'sqlite'


def test_vec_dim_default():
    assert env.get('vec_dim') == 1536


def test_configure_overrides(tmp_path):
    # simulate override
    config.configure({'metadata_backend': 'postgres', 'vec_dim': 512})
    assert env.get('metadata_backend') == 'postgres'
    assert env.get('vec_dim') == 512
    # cleanup by resetting known defaults
    config.configure({'metadata_backend': os.getenv('OM_METADATA_BACKEND', 'sqlite'), 'vec_dim': int(os.getenv('OM_VEC_DIM', '1536'))})
