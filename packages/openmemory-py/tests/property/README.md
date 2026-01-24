# Property-Based Testing for Python

This directory contains property-based tests using Hypothesis for the OpenMemory Python codebase.

## Structure

- `conftest.py` - Pytest configuration and fixtures for property tests
- `strategies.py` - Custom Hypothesis strategies for domain-specific data types
- `properties/` - Individual property test files organized by module

## Running Property Tests

```bash
# Run all property tests
pytest tests/property

# Run specific property test file
pytest tests/property/properties/test_memory_properties.py

# Run with verbose output
pytest tests/property -v

# Run async property tests
pytest tests/property -m asyncio
```

## Property Test Guidelines

1. Each property test should run minimum 100 examples (configured in conftest.py)
2. Use descriptive test names that explain what is being tested
3. Tag tests with the format: `**Feature: openmemory-codebase-improvement, Property {number}: {property_text}**`
4. Focus on universal properties that should hold across all valid inputs
5. Use smart strategies that constrain to the input space intelligently
6. Follow Pydantic V2 patterns for all data models
7. Use `pytest.mark.asyncio` for async property tests

## Example Property Test

```python
import pytest
from hypothesis import given, strategies as st
from .strategies import user_ids, memory_content

@pytest.mark.asyncio
@given(user_id=user_ids(), content=memory_content())
async def test_memory_storage_property(user_id: str, content: str):
    """**Feature: openmemory-codebase-improvement, Property 1: Memory Storage Consistency**"""
    # Property test logic here
    assert True  # Property should hold
```