import pytest
from openmemory.ops.extract import extract_html, estimate_tokens

@pytest.mark.asyncio
async def test_extract_html_sanitization():
    """Verify script/style stripping."""
    malicious_html = """
    <html>
        <head><style>body { display: none; }</style></head>
        <body>
            <h1>Hello</h1>
            <script>alert('xss');</script>
            <p>World</p>
        </body>
    </html>
    """
    res = await extract_html(malicious_html)
    txt = res["text"]
    
    assert "alert" not in txt
    assert "display: none" not in txt
    assert "Hello" in txt
    assert "World" in txt

def test_token_estimation_robustness():
    """Verify estimate_tokens handles corner cases."""
    assert estimate_tokens("") == 0
    assert estimate_tokens("a" * 100) == 25 # 100/4
    
    # Very large input
    large_text = "a" * 1_000_000
    assert estimate_tokens(large_text) == 250_000

@pytest.mark.asyncio
async def test_extract_html_malformed():
    """Verify robustness against malformed HTML."""
    garbage = "<div><p>Unclosed tags everywhere <br> <b>bold"
    res = await extract_html(garbage)
    assert "Unclosed tags everywhere" in res["text"]
    assert "bold" in res["text"]
