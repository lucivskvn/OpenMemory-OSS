
from openmemory.server.routers.temporal import FactRequest
from pydantic import ValidationError

f1 = {
    "subject": "API_S1",
    "predicate": "API_P1",
    "object": "API_O1",
    "confidence": 0.9,
    "metadata": {"source": "test"}
}

try:
    req = FactRequest(**f1)
    print("Validation Successful")
except ValidationError as e:
    print("Validation Failed:")
    print(e.json())
except Exception as e:
    print(f"Other Error: {e}")
