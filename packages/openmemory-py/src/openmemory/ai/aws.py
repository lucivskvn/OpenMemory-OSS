import json
import os
from typing import List, Dict, Any, Optional
from ..core.config import env
from .adapter import AIAdapter
from .resilience import CircuitBreaker, with_resilience
from .exceptions import handle_provider_error, AIProviderError

try:
    import boto3  # type: ignore[import]
    from botocore.config import Config  # type: ignore[import]
except ImportError:
    boto3 = None  # type: ignore[assignment]
    Config = None  # type: ignore[assignment]  # type: ignore[assignment]
    Config = None  # type: ignore[assignment]

class AwsAdapter(AIAdapter):
    def __init__(self, region: Optional[str] = None, access_key: Optional[str] = None, secret_key: Optional[str] = None):
        if not boto3: raise ImportError("boto3 not installed")

        self.region = region or env.aws_region or os.getenv("AWS_REGION")
        self.access_key = access_key or env.aws_access_key_id or os.getenv("AWS_ACCESS_KEY_ID")
        self.secret_key = secret_key or env.aws_secret_access_key or os.getenv("AWS_SECRET_ACCESS_KEY")

        if not self.region: raise ValueError("AWS Region missing")

        config = Config(  # type: ignore[misc]  # type: ignore[misc]
            region_name=self.region,
            signature_version="v4",
            retries={"max_attempts": 0}, # Handled by our own resilience
            connect_timeout=10,
            read_timeout=30
        )

        self.client = boto3.client(
            service_name="bedrock-runtime",
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key,
            config=config
        )
        self._breakers = {}

    def _get_breaker(self, model: str) -> CircuitBreaker:
        if model not in self._breakers:
            self._breakers[model] = CircuitBreaker(name=f"AWS-{model}", failure_threshold=3)
        return self._breakers[model]

    async def chat(self, messages: List[Dict[str, str]], model: Optional[str] = None, **kwargs) -> str:
        # Assuming Bedrock Titan or Claude payload structure (Claude is common)
        # This is a basic implementation for Claude v2/3 on Bedrock
        m = model or "anthropic.claude-3-sonnet-20240229-v1:0"
        breaker = self._get_breaker(m)

        async def _call():
            prompt = ""
            for msg in messages:
                role = msg["role"]
                content = msg["content"]
                if role == "system": prompt += f"System: {content}\n\n"
                elif role == "user": prompt += f"Human: {content}\n\n"
                elif role == "assistant": prompt += f"Assistant: {content}\n\n"

            prompt += "Assistant:"

            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 1024,
                "messages": [
                    {"role": ms["role"], "content": ms["content"]} for ms in messages if ms["role"] != "system"
                ],
                "system": next((ms["content"] for ms in messages if ms["role"] == "system"), "")
            })

            try:
                # boto3.client.invoke_model is synchronous, usually we'd wrap in run_in_executor
                # for now keeping simple as other adapters did, but Bedrock is a heavy call.
                response = self.client.invoke_model(
                    modelId=m,
                    body=body
                )
                res_body = json.loads(response.get("body").read())
                return res_body["content"][0]["text"]
            except Exception as e:
                raise handle_provider_error("aws", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception as e:
            import logging
            logging.getLogger("aws").error(f"[AI] AWS Bedrock error: {e}")
            raise

    async def embed(self, text: str, model: Optional[str] = None) -> List[float]:
        # Sync boto3 client execution (wrap in executor if strictly async needed, but ok for now)
        # Or use aiobotocore if available? For 1:1 port, std boto3 is fine.
        m = model or "amazon.titan-embed-text-v2:0"
        breaker = self._get_breaker(m)

        async def _call():
            body = json.dumps({
                "inputText": text,
                "dimensions": env.vec_dim or 1024,
                "normalize": True
            })

            try:
                response = self.client.invoke_model(
                    modelId=m,
                    body=body,
                    accept="application/json",
                    contentType="application/json"
                )

                res_body = json.loads(response.get("body").read())
                return res_body.get("embedding")
            except Exception as e:
                raise handle_provider_error("aws", e)

        try:
            return await with_resilience(_call, breaker, should_retry=lambda e: getattr(e, 'retryable', True))
        except Exception:
            raise

    async def embed_batch(self, texts: List[str], model: Optional[str] = None) -> List[List[float]]:
        # AWS Titan doesn't support native batching in invoke_model?
        # Typically loop.
        res = []
        for t in texts:
            res.append(await self.embed(t, model))
        return res
