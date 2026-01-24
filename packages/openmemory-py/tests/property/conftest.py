"""
Property-Based Testing Configuration for OpenMemory Python

This file provides pytest configuration and fixtures for property-based testing
using Hypothesis in the OpenMemory Python codebase.
"""

import pytest
from hypothesis import settings, Verbosity
from typing import AsyncGenerator
import asyncio

# Configure Hypothesis settings for property tests
# Reduced examples for faster execution while maintaining correctness validation
settings.register_profile("default", max_examples=25, verbosity=Verbosity.verbose)
settings.register_profile("ci", max_examples=50, verbosity=Verbosity.normal)
settings.register_profile("dev", max_examples=20, verbosity=Verbosity.verbose)

# Load the appropriate profile
settings.load_profile("default")

# Configure pytest-asyncio
pytest_plugins = ("pytest_asyncio",)

@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for the test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()

@pytest.fixture
async def test_db_path() -> AsyncGenerator[str, None]:
    """
    Provide a test database path for property tests.
    Follows OpenMemory naming conventions.
    """
    import time
    import random
    import string
    
    # Generate unique test database path
    timestamp = int(time.time() * 1000)
    random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    db_path = f"test_property_{timestamp}_{random_suffix}.sqlite"
    
    yield db_path
    
    # Cleanup after test
    try:
        import os
        if os.path.exists(db_path):
            os.remove(db_path)
    except Exception as e:
        print(f"Warning: Failed to cleanup test database {db_path}: {e}")

@pytest.fixture
def property_test_config():
    """
    Configuration for property tests.
    """
    return {
        "max_examples": 25,
        "deadline": 10000,  # 10 seconds per example
        "verbosity": Verbosity.verbose,
    }

@pytest.fixture
def performance_property_config():
    """
    Configuration for performance-sensitive property tests.
    """
    return {
        "max_examples": 20,
        "deadline": 20000,  # 20 seconds per example
        "verbosity": Verbosity.verbose,
    }

@pytest.fixture
def integration_property_config():
    """
    Configuration for integration property tests.
    """
    return {
        "max_examples": 15,
        "deadline": 30000,  # 30 seconds per example
        "verbosity": Verbosity.verbose,
    }

# Pytest markers for different types of property tests
def pytest_configure(config):
    """Configure custom pytest markers."""
    config.addinivalue_line(
        "markers", "property: mark test as a property-based test"
    )
    config.addinivalue_line(
        "markers", "property_performance: mark test as a performance property test"
    )
    config.addinivalue_line(
        "markers", "property_integration: mark test as an integration property test"
    )
    config.addinivalue_line(
        "markers", "property_security: mark test as a security property test"
    )

# Async test configuration
@pytest.fixture(scope="session")
def anyio_backend():
    """Configure anyio backend for async tests."""
    return "asyncio"