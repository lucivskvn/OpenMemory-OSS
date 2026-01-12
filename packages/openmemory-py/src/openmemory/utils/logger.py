import logging
import json
import sys
from ..core.config import env

import re

# Redaction Patterns
RE_OPENAI_KEY = re.compile(r"sk-[a-zA-Z0-9]{20,}")
RE_GOOGLE_KEY = re.compile(r"AIza[a-zA-Z0-9-_]{20,}")

def redact_text(text: str) -> str:
    """Removes sensitive keys from a string."""
    if not isinstance(text, str): return text
    text = RE_OPENAI_KEY.sub("sk-[REDACTED]", text)
    text = RE_GOOGLE_KEY.sub("AIza[REDACTED]", text)
    return text

# Redaction Logic (Structure)
SENSITIVE = ["api_key", "password", "token", "secret", "authorization", "key", "content", "body"]

def redact_struct(obj):
    if isinstance(obj, dict):
        return {k: ("***REDACTED***" if any(s in k.lower() for s in SENSITIVE) else redact_struct(v)) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        # Handle tuple for args consistency
        return type(obj)(redact_struct(x) for x in obj)
    return obj

class JsonFormatter(logging.Formatter):
    def format(self, record):
        # Redact arguments before message formatting to ensure getMessage() uses redacted data
        if record.args:
            record.args = redact_struct(record.args)  # type: ignore[attr-defined]
        if isinstance(record.msg, (dict, list)):
            record.msg = redact_struct(record.msg)

        from ..trace import Tracer
        span = Tracer.current_span()
        
        json_log = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "message": redact_text(record.getMessage()),
            "logger": record.name,
        }
        
        if span:
            json_log["trace_id"] = span.trace_id
            json_log["span_id"] = span.id
            if span.user_id:  # type: ignore[attr-defined]
                json_log["user_id"] = span.user_id  # type: ignore[attr-defined]

        if record.exc_info:
             json_log["exception"] = redact_text(self.formatException(record.exc_info))
        
        return json.dumps(redact_struct(json_log))

class ColorFormatter(logging.Formatter):
    """
    Simple colored formatter for development.
    """
    
    grey = "\x1b[38;20m"
    blue = "\x1b[34;20m"
    yellow = "\x1b[33;20m"
    red = "\x1b[31;20m"
    bold_red = "\x1b[31;1m"
    reset = "\x1b[0m"
    cyan = "\x1b[36;20m"

    FORMAT = "[%(asctime)s] %(levelname)s: %(message)s (%(name)s)"

    def format(self, record):
        from ..trace import Tracer
        span = Tracer.current_span()
        
        # Redact raw message for console too
        record.msg = redact_text(str(record.msg))
        
        log_fmt = self.FORMAT
        if record.levelno == logging.DEBUG:
            color = self.grey
        elif record.levelno == logging.INFO:
            color = self.blue
        elif record.levelno == logging.WARNING:
            color = self.yellow
        elif record.levelno == logging.ERROR:
            color = self.red
        elif record.levelno == logging.CRITICAL:
            color = self.bold_red
        else:
            color = self.reset
            
        formatted = logging.Formatter(f"{color}{log_fmt}{self.reset}").format(record)
        
        if span:
            formatted += f" {self.cyan}[trace_id={span.trace_id[:8]}]{self.reset}"
            
        return formatted

def setup_logging():
    """
    Configure the root logger based on environment settings.
    """
    root = logging.getLogger()
    
    # Set Level
    level = logging.DEBUG if env.verbose else logging.INFO
    root.setLevel(level)
    
    # Determine Formatter
    if env.mode == "production":
        formatter = JsonFormatter()
    else:
        formatter = ColorFormatter()
        
    # Handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    
    # Reset handlers
    if root.handlers:
        for h in root.handlers:
            root.removeHandler(h)
            
    root.addHandler(handler)
    
    # Silence noisy libraries
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    # Hook into Uvicorn if running
    logging.getLogger("uvicorn.access").handlers = [handler]
    logging.getLogger("uvicorn.error").handlers = [handler]
    # Ensure uvicorn doesn't propagate to double log
    logging.getLogger("uvicorn").propagate = False
    
    # Create a startup log
    logger = logging.getLogger("openmemory")
    logger.info(f"Logging initialized. Mode: {env.mode}, Level: {logging.getLevelName(level)}")
