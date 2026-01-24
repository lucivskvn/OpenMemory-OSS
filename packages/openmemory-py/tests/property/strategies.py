"""
Custom Hypothesis Strategies for OpenMemory Domain Objects

This module provides custom Hypothesis strategies for generating
domain-specific data types used in OpenMemory property-based tests.
"""

from hypothesis import strategies as st
from typing import List, Dict, Any
import string
import re

# Basic data type strategies
def user_ids() -> st.SearchStrategy[str]:
    """Generate valid user IDs."""
    return st.text(
        alphabet=string.ascii_letters + string.digits + "_-",
        min_size=1,
        max_size=50
    ).filter(lambda s: s.strip() and len(s.strip()) > 0)

def memory_content() -> st.SearchStrategy[str]:
    """Generate valid memory content."""
    return st.text(min_size=1, max_size=10000).filter(
        lambda s: s.strip() and len(s.strip()) > 0
    )

def api_keys() -> st.SearchStrategy[str]:
    """Generate valid API keys."""
    return st.text(
        alphabet=string.ascii_letters + string.digits + "_-",
        min_size=32,
        max_size=64
    ).filter(lambda s: re.match(r'^[a-zA-Z0-9_-]+$', s))

def embedding_vectors(dimensions: int = 1536) -> st.SearchStrategy[List[float]]:
    """Generate valid embedding vectors (normalized)."""
    @st.composite
    def normalized_vector(draw):
        # Generate random vector
        vector = draw(st.lists(
            st.floats(min_value=-1.0, max_value=1.0, allow_nan=False, allow_infinity=False),
            min_size=dimensions,
            max_size=dimensions
        ))
        
        # Normalize the vector
        magnitude = sum(x * x for x in vector) ** 0.5
        if magnitude > 0:
            vector = [x / magnitude for x in vector]
        
        return vector
    
    return normalized_vector()

def package_names() -> st.SearchStrategy[str]:
    """Generate valid package names."""
    return st.text(
        alphabet=string.ascii_lowercase + string.digits + "@/_-",
        min_size=1,
        max_size=50
    ).filter(lambda s: re.match(r'^[a-z0-9@/_-]+$', s) and len(s) > 0)

def version_strings() -> st.SearchStrategy[str]:
    """Generate valid semantic version strings."""
    return st.builds(
        lambda major, minor, patch: f"{major}.{minor}.{patch}",
        major=st.integers(min_value=0, max_value=99),
        minor=st.integers(min_value=0, max_value=99),
        patch=st.integers(min_value=0, max_value=99)
    )

def file_paths() -> st.SearchStrategy[str]:
    """Generate valid file paths."""
    return st.text(
        alphabet=string.ascii_letters + string.digits + "._-/",
        min_size=1,
        max_size=255
    ).filter(lambda s: '\0' not in s and s.strip() and len(s.strip()) > 0)

def timestamps() -> st.SearchStrategy[float]:
    """Generate valid timestamps."""
    return st.floats(
        min_value=1577836800.0,  # 2020-01-01
        max_value=1924992000.0,  # 2030-12-31
        allow_nan=False,
        allow_infinity=False
    )

def database_configs() -> st.SearchStrategy[Dict[str, Any]]:
    """Generate valid database configuration objects."""
    return st.fixed_dictionaries({
        'database_url': st.text(min_size=10, max_size=200),
        'vector_dimensions': st.integers(min_value=128, max_value=4096),
        'max_memory_size': st.integers(min_value=1000, max_value=1000000),
        'connection_pool_size': st.integers(min_value=1, max_value=100),
    })

def security_configs() -> st.SearchStrategy[Dict[str, Any]]:
    """Generate valid security configuration objects."""
    return st.fixed_dictionaries({
        'encryption_algorithm': st.sampled_from(['AES-256-GCM', 'ChaCha20-Poly1305']),
        'key_rotation_interval': st.integers(min_value=3600, max_value=86400 * 30),  # 1 hour to 30 days
        'rate_limit_requests': st.integers(min_value=10, max_value=10000),
        'rate_limit_window': st.integers(min_value=60, max_value=3600),  # 1 minute to 1 hour
    })

def memory_metadata() -> st.SearchStrategy[Dict[str, Any]]:
    """Generate valid memory metadata objects."""
    return st.fixed_dictionaries({
        'source': st.text(min_size=1, max_size=100),
        'created_at': timestamps(),
        'updated_at': timestamps(),
        'tags': st.lists(st.text(min_size=1, max_size=50), max_size=10),
        'importance': st.floats(min_value=0.0, max_value=1.0, allow_nan=False),
    })

def temporal_facts() -> st.SearchStrategy[Dict[str, Any]]:
    """Generate valid temporal fact objects."""
    return st.fixed_dictionaries({
        'subject': st.text(min_size=1, max_size=200),
        'predicate': st.text(min_size=1, max_size=100),
        'object': st.text(min_size=1, max_size=200),
        'timestamp': timestamps(),
        'confidence': st.floats(min_value=0.0, max_value=1.0, allow_nan=False),
        'source': st.text(min_size=1, max_size=100),
    })

def query_parameters() -> st.SearchStrategy[Dict[str, Any]]:
    """Generate valid query parameter objects."""
    return st.fixed_dictionaries({
        'query': st.text(min_size=1, max_size=1000),
        'limit': st.integers(min_value=1, max_value=1000),
        'offset': st.integers(min_value=0, max_value=10000),
        'similarity_threshold': st.floats(min_value=0.0, max_value=1.0, allow_nan=False),
        'include_metadata': st.booleans(),
    })

def error_scenarios() -> st.SearchStrategy[Dict[str, Any]]:
    """Generate error scenario configurations for testing error handling."""
    return st.fixed_dictionaries({
        'error_type': st.sampled_from([
            'ValidationError',
            'DatabaseError', 
            'NetworkError',
            'AuthenticationError',
            'RateLimitError'
        ]),
        'should_retry': st.booleans(),
        'retry_count': st.integers(min_value=0, max_value=5),
        'error_message': st.text(min_size=1, max_size=200),
    })

# Composite strategies for complex scenarios
@st.composite
def memory_operations(draw) -> Dict[str, Any]:
    """Generate complex memory operation scenarios."""
    operation_type = draw(st.sampled_from(['create', 'update', 'delete', 'search']))
    
    base = {
        'operation': operation_type,
        'user_id': draw(user_ids()),
        'timestamp': draw(timestamps()),
    }
    
    if operation_type in ['create', 'update']:
        base.update({
            'content': draw(memory_content()),
            'metadata': draw(memory_metadata()),
            'embedding': draw(embedding_vectors()),
        })
    elif operation_type == 'search':
        base.update({
            'query': draw(st.text(min_size=1, max_size=500)),
            'parameters': draw(query_parameters()),
        })
    
    return base

@st.composite
def batch_operations(draw) -> List[Dict[str, Any]]:
    """Generate batch operation scenarios."""
    batch_size = draw(st.integers(min_value=1, max_value=100))
    operations = []
    
    for _ in range(batch_size):
        operations.append(draw(memory_operations()))
    
    return operations