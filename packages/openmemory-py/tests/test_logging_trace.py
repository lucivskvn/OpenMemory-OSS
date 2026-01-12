import logging
import pytest
import json
from openmemory.utils.logger import JsonFormatter

def test_arg_redaction():
    # Verify JsonFormatter redacts sensitive keys passed as ARGS
    formatter = JsonFormatter()
    
    data = {"body": "very secret body", "other": "safe", "content": "secret content"}
    # Log as arg (Correct usage)
    record = logging.LogRecord("test", logging.INFO, "", 0, "Data: %s", (data,), None)
    
    # My patch in logger.py redacts record.args IN PLACE.
    # format() calls getMessage() which uses args.
    
    msg = formatter.format(record)
    
    print(f"Log Output: {msg}")
    assert "secret content" not in msg, "Sensitive content leaked from args"
    assert "***REDACTED***" in msg, "Redaction placeholder missing"

def test_msg_dict_redaction():
    # Verify redaction if msg IS a dict
    formatter = JsonFormatter()
    data = {"secret": "hide me"}
    record = logging.LogRecord("test", logging.INFO, "", 0, data, (), None)
    
    msg = formatter.format(record)
    print(f"Log Output: {msg}")
    assert "hide me" not in msg
    assert "***REDACTED***" in msg
