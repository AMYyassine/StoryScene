import json
import unittest
from unittest.mock import patch
import httpx
from app.providers import HuggingFaceProvider
from app.domain import DomainError


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.provider = HuggingFaceProvider()
        self.provider.token = "hf_dummy_test_token"
        self.provider.model = "test/model"
        self.client_class = httpx.AsyncClient

    def client(self, handler):
        return patch("app.providers.httpx.AsyncClient", side_effect=lambda **kwargs: self.client_class(transport=httpx.MockTransport(handler), **kwargs))

    async def test_documented_chat_endpoint_and_json_response(self):
        def respond(request):
            self.assertEqual(str(request.url), "https://router.huggingface.co/v1/chat/completions")
            self.assertEqual(request.headers["Authorization"], "Bearer hf_dummy_test_token")
            data = json.loads(request.content)
            self.assertEqual(data["model"], "test/model")
            self.assertEqual(data["messages"][0]["role"], "system")
            return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": '```json\n{"findings":[],"coverage":"All supplied text"}\n```'}}]})
        with self.client(respond):
            result = await self.provider.call("check", {"request": "Check continuity", "document": {}})
        self.assertEqual(result["findings"], [])

    async def test_authentication_error_does_not_expose_provider_body(self):
        with self.client(lambda request: httpx.Response(401, json={"error": "Never echo this provider body"})):
            with self.assertRaisesRegex(DomainError, "Token rejected") as raised:
                await self.provider.call("check", {})
        self.assertNotIn("provider body", str(raised.exception))

    async def test_truncated_or_invalid_json_is_rejected(self):
        for reason, text in [("length", '{"findings":'), ("stop", "not JSON")]:
            with self.client(lambda request: httpx.Response(200, json={"choices": [{"finish_reason": reason, "message": {"content": text}}]})):
                with self.assertRaises(DomainError):
                    await self.provider.call("check", {})

    async def test_context_limit_before_network(self):
        def forbidden(request):
            self.fail("Oversized context must not leave this computer")
        with self.client(forbidden):
            with self.assertRaisesRegex(DomainError, "No text was truncated or sent"):
                await self.provider.call("check", {"story": "x" * 60001})

    async def test_timeout_is_actionable(self):
        def fail(request):
            raise httpx.ReadTimeout("timeout", request=request)
        with self.client(fail):
            with self.assertRaisesRegex(DomainError, "timed out"):
                await self.provider.call("edit", {})
