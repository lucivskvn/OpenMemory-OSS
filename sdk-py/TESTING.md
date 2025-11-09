Running tests locally

1) Create and activate a Python virtual environment (recommended):

```bash
python3 -m venv .venv
source .venv/bin/activate
```

2) Install test dependencies:

```bash
pip install --upgrade pip
pip install pytest pytest-cov
```

3) Run the Python SDK tests (make the local package importable via PYTHONPATH):

```bash
PYTHONPATH=sdk-py .venv/bin/python -m pytest -q sdk-py
```

Notes
- Tests use monkeypatch to avoid network calls. The project does not require installing the package with pip for tests; using PYTHONPATH keeps iteration fast.
- For richer coverage reports, run pytest with `--cov` flags or configure your environment as desired.
