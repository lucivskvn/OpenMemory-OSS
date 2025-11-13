# Agents Bun Addendum

This note documents agent-related runtime considerations when running agents under Bun.

- When tests or agents send `application/octet-stream`, the server performs lightweight magic-bytes detection for PDF (`%PDF`) and ZIP/DOCX (`PK\x03\x04`). This helps avoid misclassification of common office formats.
- For automated agents that may send raw payloads without correct MIME types, operators can opt into legacy permissive behavior with `OM_ACCEPT_OCTET_LEGACY=true`. This attempts to decode octet-streams as UTF-8 text when the payload appears to be textual.
- Prefer sending accurate content types from agents to avoid unintended parsing behavior.

Testing guidance

- Unit tests should stub heavy parsers (e.g., `pdf-parse`, `mammoth`) when testing extract helpers to keep tests fast and deterministic.
- Tests that exercise octet-stream behavior should set and restore `process.env.OM_ACCEPT_OCTET_LEGACY` to avoid flakiness across test runs.
