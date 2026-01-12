import os
import time
import json
import asyncio
import tempfile
import re
import logging
from typing import Dict, Any, Union, Optional

logger = logging.getLogger("openmemory.ops.extract")

# Dependencies
# pdf-parse -> pypdf
# mammoth -> mammoth
# turndown -> markdownify
# openai -> openai
# ffmpeg -> pydub or subprocess ffmpeg call? "fluent-ffmpeg" in Node.

import httpx
from pypdf import PdfReader
import mammoth
from markdownify import markdownify as md
from openai import AsyncOpenAI
from ..core.config import env

# Port of backend/src/ops/extract.ts

import math

def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)

async def extract_pdf(data: bytes) -> Dict[str, Any]:
    # pypdf logic
    import io
    reader = PdfReader(io.BytesIO(data))
    text = ""
    for page in reader.pages:
        text += page.extract_text() + "\n"
        
    return {
        "text": text,
        "metadata": {
            "content_type": "pdf",
            "char_count": len(text),
            "estimated_tokens": estimate_tokens(text),
            "extraction_method": "pypdf",
            "pages": len(reader.pages)
        }
    }

async def extract_docx(data: bytes) -> Dict[str, Any]:
    # mammoth logic
    import io
    result = mammoth.extract_raw_text(io.BytesIO(data))
    text = result.value
    return {
        "text": text,
        "metadata": {
            "content_type": "docx",
            "char_count": len(text),
            "estimated_tokens": estimate_tokens(text),
            "extraction_method": "mammoth",
            "messages": [str(m) for m in result.messages]
        }
    }

async def extract_html(html: str) -> Dict[str, Any]:
    # Robust sanitization: Remove script and style blocks entirely (content included)
    cleaned_html = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', html, flags=re.DOTALL | re.IGNORECASE)
    
    text = md(cleaned_html, heading_style="ATX", code_language="", strip=["script", "style"])
    return {
        "text": text,
        "metadata": {
            "content_type": "html",
            "char_count": len(text),
            "estimated_tokens": estimate_tokens(text),
            "extraction_method": "markdownify",
            "original_html_length": len(html)
        }
    }

async def extract_url(url: str, user_id: Optional[str] = None) -> Dict[str, Any]:
    from ..utils.security import validate_url
    is_valid, err = await validate_url(url)
    if not is_valid:
        raise ValueError(err)

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, follow_redirects=True)
        resp.raise_for_status()
        html = resp.text
        
    return await extract_html(html)

async def extract_audio(data: bytes, mime_type: str, user_id: Optional[str] = None) -> Dict[str, Any]:
    from ..ai.adapters import get_adapter
    adapter = await get_adapter(user_id)
    api_key = getattr(adapter, "api_key", None) or env.openai_key or os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OpenAI API key required for audio transcription")
        
    if len(data) > 25 * 1024 * 1024:
        raise ValueError("Audio file too large (max 25MB)")
        
    ext = ".mp3"
    if "wav" in mime_type: ext = ".wav"
    elif "m4a" in mime_type: ext = ".m4a"
    elif "ogg" in mime_type: ext = ".ogg"
    elif "webm" in mime_type: ext = ".webm"
    
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
        
    try:
        client = AsyncOpenAI(api_key=api_key)
        with open(tmp_path, "rb") as f:
            transcription = await client.audio.transcriptions.create(
                file=f,
                model="whisper-1",
                response_format="verbose_json"
            )
            
        text = transcription.text
        return {
            "text": text,
            "metadata": {
                "content_type": "audio",
                "char_count": len(text),
                "estimated_tokens": estimate_tokens(text),
                "extraction_method": "whisper",
                "audio_format": ext.replace(".", ""),
                "file_size_bytes": len(data),
                "duration_seconds": getattr(transcription, "duration", None),
                "language": getattr(transcription, "language", None)
            }
        }
    except Exception as e:
        logger.error(f"Audio extraction failed: {e}", exc_info=True)
        raise e
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

async def extract_video(data: bytes, user_id: Optional[str] = None) -> Dict[str, Any]:
    # Extract audio using ffmpeg
    # requires ffmpeg installed
    import subprocess
    
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as vid_tmp:
        vid_tmp.write(data)
        vid_path = vid_tmp.name
        
    audio_path = vid_path.replace(".mp4", ".mp3")
    
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", vid_path, "-vn", "-acodec", "libmp3lame", audio_path],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        
        with open(audio_path, "rb") as f:
            audio_data = f.read()
            
        res = await extract_audio(audio_data, "audio/mp3", user_id=user_id)
        res["metadata"]["content_type"] = "video"
        res["metadata"]["extraction_method"] = "ffmpeg+whisper"
        res["metadata"]["video_size"] = len(data)
        return res
        
    except FileNotFoundError:
        raise RuntimeError("FFmpeg not found - ensure ffmpeg is installed for video transcription")
    except Exception as e:
        logger.error(f"Video extraction failed: {e}", exc_info=True)
        raise e
    finally:
        if os.path.exists(vid_path): os.unlink(vid_path)
        if os.path.exists(audio_path): os.unlink(audio_path)

async def extract_image(data: bytes, mime_type: str, user_id: Optional[str] = None) -> Dict[str, Any]:
    from ..ai.adapters import get_adapter
    adapter = await get_adapter(user_id)
    api_key = getattr(adapter, "api_key", None) or env.openai_key or os.getenv("OPENAI_API_KEY")
    if not api_key:
        # Fallback to simple metadata if no key
        return {
            "text": "[Image Content - No OCR/Vision API Key provided]",
            "metadata": {
                "content_type": "image",
                "mime_type": mime_type,
                "size_bytes": len(data),
                "extraction_method": "placeholder"
            }
        }
    
    import base64
    b64_img = base64.b64encode(data).decode('utf-8')
    data_url = f"data:{mime_type};base64,{b64_img}"
    
    try:
        client = AsyncOpenAI(api_key=api_key)
        response = await client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Describe this image in detail, capturing all visible text and visual elements."},
                        {"type": "image_url", "image_url": {"url": data_url}}
                    ],
                }
            ],
            max_tokens=1000
        )
        text = response.choices[0].message.content
        if not text:
            text = "[Image Content - No description generated]"
        return {
            "text": text,
            "metadata": {
                "content_type": "image",
                "mime_type": mime_type,
                "size_bytes": len(data),
                "extraction_method": "gpt-4o-vision",
                "estimated_tokens": estimate_tokens(text)
            }
        }
    except Exception as e:
        logger.error(f"Image extraction failed: {e}")
        return {
            "text": f"[Image Content - Extraction Failed: {str(e)}]",
            "metadata": {
                "content_type": "image",
                "error": str(e)
            }
        }

async def extract_text(content_type: str, data: Union[str, bytes], user_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Main dispatcher for extracting text from various content types.
    """
    ctype = content_type.lower()
    
    import base64
    
    # Helper to ensure we have bytes for binary formats
    def to_bytes(d: Union[str, bytes]) -> bytes:
        if isinstance(d, bytes): return d
        if isinstance(d, str):
            if d.startswith("data:") or len(d) % 4 == 0: # Rough check for b64
                 try:
                     return base64.b64decode(d.split(",")[-1])
                 except: pass
            return d.encode("utf-8")
        return bytes(d) # last resort

    # Check images
    if any(x in ctype for x in ["image", "png", "jpg", "jpeg", "gif", "webp"]):
        return await extract_image(to_bytes(data), f"image/{ctype.replace('image/','')}", user_id=user_id)

    # Check audio
    if any(x in ctype for x in ["audio", "mp3", "wav", "m4a", "ogg", "webm"]) and "video" not in ctype:
        return await extract_audio(to_bytes(data), ctype, user_id=user_id)
        
    # Check video
    if any(x in ctype for x in ["video", "mp4", "avi", "mov"]):
        return await extract_video(to_bytes(data), user_id=user_id)
        
    # Check PDF
    if "pdf" in ctype:
        return await extract_pdf(to_bytes(data))
        
    # Check DOCX
    if "docx" in ctype or ctype.endswith(".doc") or "msword" in ctype:
        return await extract_docx(to_bytes(data))
        
    # Check HTML
    if "html" in ctype or "htm" in ctype:
        s = data.decode("utf-8") if isinstance(data, bytes) else data
        return await extract_html(s) # type: ignore
        
    # Check Text/Markdown
    if any(x in ctype for x in ["markdown", "md", "txt", "text"]):
        s = data.decode("utf-8") if isinstance(data, bytes) else str(data)
        return {
            "text": s,
            "metadata": {
                "content_type": "markdown" if "markdown" in ctype or "md" in ctype else "txt",
                "char_count": len(s),
                "estimated_tokens": estimate_tokens(s),
                "extraction_method": "passthrough"
            }
        }
        
    raise ValueError(f"Unsupported content type: {content_type}")
