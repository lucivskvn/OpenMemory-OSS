
import pytest
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from openmemory.ops.extract import extract_image, extract_text  # type: ignore[import-untyped]  # type: ignore[import-untyped]
from openmemory.memory.user_summary import gen_user_summary_smart  # type: ignore[import-untyped]  # type: ignore[import-untyped]

class TestCognitiveParity(unittest.IsolatedAsyncioTestCase):

    @patch("openmemory.ops.extract.AsyncOpenAI")
    @patch.dict("os.environ", {"OPENAI_API_KEY": "test-key"})
    async def test_extract_image_vision(self, mock_openai):
        # Mock client
        mock_client = AsyncMock()
        mock_openai.return_value = mock_client
        
        # Mock Completion response
        mock_resp = MagicMock()
        mock_msg = MagicMock()
        mock_msg.content = "This is a screenshot of code."
        mock_resp.choices = [MagicMock(message=mock_msg)]
        mock_client.chat.completions.create.return_value = mock_resp
        
        img_data = b"fake-image-bytes"
        res = await extract_image(img_data, "image/png")
        
        self.assertEqual(res["text"], "This is a screenshot of code.")
        self.assertEqual(res["metadata"]["content_type"], "image")
        self.assertEqual(res["metadata"]["mime_type"], "image/png")
        self.assertEqual(res["metadata"]["extraction_method"], "gpt-4o-vision")
        
        # Verify call structure
        call_kwargs = mock_client.chat.completions.create.call_args.kwargs
        self.assertEqual(call_kwargs["model"], "gpt-4o")
        msgs = call_kwargs["messages"]
        self.assertEqual(msgs[0]["role"], "user")
        content = msgs[0]["content"]
        self.assertEqual(content[0]["type"], "text")
        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))
        
    @patch("openmemory.ops.extract.extract_image")
    async def test_extract_text_dispatch_image(self, mock_ex_img):
        mock_ex_img.return_value = {"text": "dispatched", "metadata": {}}
        
        await extract_text("image/jpeg", b"data")
        mock_ex_img.assert_called_once()

    @patch("openmemory.memory.user_summary.get_adapter")
    async def test_smart_user_summary(self, mock_get_adapter):
        mock_adapter = AsyncMock()
        mock_get_adapter.return_value = mock_adapter
        mock_adapter.chat.return_value = "User is a senior verified engineer."
        
        mems = [
            {"content": "Fixed bug in authentication", "primary_sector": "procedural", "meta": "{}"}
        ]
        
        summary = await gen_user_summary_smart(mems, "user1")
        
        self.assertEqual(summary, "User is a senior verified engineer.")
        mock_adapter.chat.assert_called_once()
        call_args = mock_adapter.chat.call_args[0] # messages list
        prompt = call_args[0][0]["content"]
        self.assertIn("Fixed bug in authentication", prompt)
        self.assertIn("user1", prompt)

if __name__ == "__main__":
    unittest.main()
