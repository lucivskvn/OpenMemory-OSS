# Ollama Sidecar Deployment Guide

This guide explains how to run an Ollama sidecar alongside OpenMemory to provide local embeddings and multimodal models.

## Why use a sidecar

- Local models avoid external API costs and improve privacy.
- Ollama provides a lightweight local model manager with a REST API.
- Running Ollama as a sidecar keeps model files co-located with the OpenMemory container and simplifies networking.

## Docker Compose (included)

The repository's `docker-compose.yml` includes an `ollama` service and a named volume `ollama_models` for model persistence. By default the OpenMemory service is configured to point to `http://ollama:11434` when running in Docker.

To start both services:

```bash
# From repo root
docker compose up --build -d
```

For rootless Podman users, create the volumes with the host uid/gid to avoid permission issues:

```bash
podman volume create ollama_models --driver local --opt o=uid=$(id -u),gid=$(id -g)
podman volume create openmemory_data --driver local --opt o=uid=$(id -u),gid=$(id -g)
```

## Pulling models

Use OpenMemory's HTTP management endpoint to pull models into the Ollama sidecar:

```bash
curl -X POST http://localhost:8080/embed/ollama/pull \
  -H "Content-Type: application/json" \
  -d '{"model":"nomic-embed-text"}'
```

Alternatively, exec into the Ollama container and use the `ollama` CLI:

```bash
docker compose exec ollama ollama pull nomic-embed-text
```

## Recommended models

- `nomic-embed-text` — Compact, reasonably accurate embedding model (recommended default)
- `mxbai-embed-large` — Higher-dimensional embeddings for advanced semantic use-cases
- `llava:13b` — Multimodal vision+text model for image understanding
- `whisper:tiny` — Speech-to-text for audio ingestion

## Resource considerations

- CPU-only inference is slower but usable for development. Set `OM_OLLAMA_NUM_GPU=0` for CPU-only.
- For GPU acceleration, configure `OM_OLLAMA_NUM_GPU` and ensure the environment has compatible drivers. The sidecar image will require GPU device access when launching with Docker.

## Health checks and monitoring

- OpenMemory exposes `/embed/ollama/status` and `/embed/ollama/list` for quick checks.
- The Docker healthcheck uses `ollama list` to verify the sidecar is responsive.

## Troubleshooting

- Permission errors with volumes on Podman: ensure volumes were created with `--opt o=uid=$(id -u),gid=$(id -g)`.
- Ollama CLI missing: verify the `ollama/ollama:0.3.0` image used in `docker-compose.yml` is available and up-to-date.
- If models do not appear in `GET /embed/ollama/list`, check Ollama logs via `docker compose logs ollama`.

## Security

- Ollama binds to `0.0.0.0:11434` in the sidecar by default; limit access via Docker network isolation or firewall rules.
- Do not expose the Ollama port publicly unless you have additional authentication in front of it.

## Cleanup

To remove all Ollama models (cleanup the volume):

```bash
docker compose down
docker volume rm ollama_models
```

For Podman:

```bash
podman volume rm ollama_models
```
