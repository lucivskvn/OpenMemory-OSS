def test_import_openmemory():
    """Simple smoke test to ensure the sdk-py package imports correctly."""
    import openmemory

    # Basic sanity: module should import and be non-empty
    assert openmemory is not None
