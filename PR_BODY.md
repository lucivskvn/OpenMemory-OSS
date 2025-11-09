Title: ci(tests): expand SDK Python tests, tighten CI, add Postgres smoke job

Description
-----------
This PR improves CI reliability and accelerates iteration by:

- Expanding Python SDK unit tests to cover nearly all public methods in `openmemory.client` (increased coverage to ~99%).
- Adding negative/edge-case tests for network errors and HTTP errors for `_r`.
- Tightening CI so test jobs fail the workflow when tests fail.
- Adding caching for Bun and pip to speed CI runs.
- Adding a `backend-postgres-smoke` job that runs the backend tests against a Postgres service to catch metadata-backend issues early.
- Ensuring coverage artifacts are uploaded even when jobs fail.

Files changed
-------------
- sdk-py/tests/*.py — new and expanded unit tests
- .github/workflows/ci.yml — caching, Postgres smoke job, artifact behavior, aggregate status job

How to test locally
-------------------
Python SDK (recommended):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install pytest pytest-cov
PYTHONPATH=sdk-py .venv/bin/python -m pytest -q sdk-py
```

Backend (Bun):

```bash
cd backend
bun install
bun test --coverage
```

Notes & follow-ups
------------------
- The CI uploads coverage artifacts to `backend/coverage`; adjust paths if your coverage tool writes elsewhere.
- I can further refine CI caching for larger monorepo speedups and add backend route unit tests if desired.
