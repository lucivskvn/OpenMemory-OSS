
import pytest
import numpy as np
from openmemory.utils.chunking import chunk_text
from openmemory.utils.keyword import extract_keywords
from openmemory.utils.vectors import cos_sim, compress_vec_for_storage

def test_chunking_offsets_accuracy():
    """Verify that chunk offsets point exactly to the source text."""
    txt = "First paragraph. Has two sentences.\n\nSecond paragraph! Also has some text? Yes."
    chunks = chunk_text(txt, tgt=10, ovr=0.2)
    
    assert len(chunks) > 1
    for c in chunks:
        expected = txt[c["start"]:c["end"]]
        assert c["text"] == expected
        assert c["tokens"] > 0

def test_chunking_overlap_logic():
    """Verify that chunks share content via sentence-based overlap."""
    txt = "Sentence one. Sentence two. Sentence three. Sentence four. Sentence five."
    chunks = chunk_text(txt, tgt=5, ovr=0.5)
    
    assert len(chunks) >= 2
    shared = False
    for s0 in chunks[0]["text"].split("."):
        if not s0.strip(): continue
        if s0.strip() + "." in chunks[1]["text"]:
            shared = True
            break
    assert shared

def test_keyword_ngrams():
    """Verify keyword extraction includes n-grams."""
    text = "Artificial Intelligence is cool"
    keywords = extract_keywords(text)
    assert any("_" in k for k in keywords)

def test_vector_sim_and_compression():
    """Verify vector utilities."""
    v1 = [1.0, 0.0, 0.0]
    v2 = [0.0, 1.0, 0.0]
    assert cos_sim(v1, v2) == 0.0
    
    v3 = [1.0, 1.0, 0.0]
    assert cos_sim(v1, v3) > 0.7
    
    vec = [1.0, 2.0, 3.0, 4.0]
    comp = compress_vec_for_storage(vec, 2)
    assert len(comp) == 2
    assert np.isclose(np.linalg.norm(comp), 1.0)
