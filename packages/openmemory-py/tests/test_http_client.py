
import unittest
from unittest.mock import MagicMock, AsyncMock, patch
from openmemory.client import MemoryClient

class TestMemoryClient(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = MemoryClient(base_url="http://test-api", token="test-token")
        # Mock the internal _client.request
        self.client._client.request = AsyncMock()
        self.mock_resp = MagicMock()
        self.mock_resp.status_code = 200
        self.mock_resp.json.return_value = {"success": True}
        self.client._client.request.return_value = self.mock_resp

    async def test_users_register(self):
        await self.client.register_user("u1", "admin")
        
        self.client._client.request.assert_called_with(
            "POST", 
            "http://test-api/users/register", 
            json={"userId": "u1", "scope": "admin"}, 
            params=None, 
            headers={"Content-Type": "application/json", "Authorization": "Bearer test-token", "x-api-key": "test-token"}
        )

    async def test_users_list_keys(self):
        self.mock_resp.json.return_value = {"keys": [{"userId": "u1"}]}
        res = await self.client.list_api_keys()
        self.assertEqual(len(res), 1)
        self.client._client.request.assert_called_with(
            "GET", "http://test-api/users/keys", json=None, params=None, headers=unittest.mock.ANY
        )

    async def test_ide_session_start(self):
        await self.client.start_ide_session("proj1", "vscode", "u1")
        self.client._client.request.assert_called_with(
            "POST", 
            "http://test-api/api/ide/session/start", 
            json={"projectName": "proj1", "ideName": "vscode", "userId": "u1"},
            params=None, headers=unittest.mock.ANY
        )

    async def test_ide_event(self):
        await self.client.send_ide_event("sess1", "save", "foo.ts", "content", "ts", {"meta": 1}, "u1")
        self.client._client.request.assert_called_with(
            "POST", 
            "http://test-api/api/ide/events", 
            json={
                "sessionId": "sess1", 
                "eventType": "save", 
                "filePath": "foo.ts", 
                "content": "content", 
                "language": "ts", 
                "metadata": {"meta": 1}, 
                "userId": "u1"
            },
            params=None, headers=unittest.mock.ANY
        )

    async def test_temporal_current_fact(self):
        self.mock_resp.json.return_value = {"fact": {"id": "f1"}}
        res = await self.client.get_current_fact("sub", "pred")
        self.assertEqual(res["id"], "f1")
        self.client._client.request.assert_called_with(
            "GET", "http://test-api/api/temporal/fact/current", 
            json=None, 
            params={"subject": "sub", "predicate": "pred"}, 
            headers=unittest.mock.ANY
        )

    async def test_dynamics_calculate_salience(self):
        await self.client.calculate_salience(initial_salience=0.9)
        self.client._client.request.assert_called_with(
            "POST", "http://test-api/dynamics/salience/calculate",
            json={
                "initialSalience": 0.9,
                "decayLambda": 0.01,
                "recallCount": 0,
                "emotionalFrequency": 0,
                "timeElapsedDays": 0
            },
            params=None, headers=unittest.mock.ANY
        )

    async def test_dynamics_spreading_activation(self):
        await self.client.spreading_activation(["m1", "m2"], 5)
        self.client._client.request.assert_called_with(
            "POST", "http://test-api/dynamics/activation/spreading",
            json={"initialMemoryIds": ["m1", "m2"], "maxIterations": 5},
            params=None, headers=unittest.mock.ANY
        )

if __name__ == "__main__":
    unittest.main()
