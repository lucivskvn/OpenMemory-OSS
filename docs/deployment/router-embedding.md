# Router CPU Embedding Mode Deployment Guide

**PHASE 2.5 Implementation**: This implements a CPU router on top of Ollama embeddings rather than a full MoE layer. SB-MoE (Sparse Mixture-of-Experts) / MUVERA-style approximations are deferred to later phases.

## Overview

The router CPU embedding mode provides sector-based model routing on top of Ollama embeddings. Instead of using a single model for all sectors, it selects optimized models per brain sector (episodic, semantic, procedural, emotional, reflective) to improve recall accuracy while maintaining CPU-only operation.

## Architecture

- **Single-expert-per-sector routing**: Each brain sector routes to one Ollama model
- **Ollama integration**: Uses standard Ollama API with fallback to synthetic embeddings
- **Sector-aware fusion**: Optional SIMD-optimized hybrid fusion for improved quality
- **Caching**: Configurable TTL caching for router decisions
- **Fallback mechanism**: Graceful degradation to synthetic embeddings if Ollama fails

## Required Environment Variables

```bash
# Enable router CPU mode
OM_EMBED_KIND=router_cpu

# Essential: Ollama endpoint
OM_OLLAMA_URL=http://localhost:11434

# Optional: Router behavior tuning
OM_ROUTER_CACHE_TTL_MS=30000        # Decision cache TTL (30s default)
OM_ROUTER_FALLBACK_ENABLED=true     # Fallback to synthetic if Ollama fails
OM_ROUTER_SIMD_ENABLED=true         # Enable SIMD optimizations

# Optional: Override sector-to-model mappings (JSON)
OM_ROUTER_SECTOR_MODELS='{"episodic":"nomic-embed-text","semantic":"nomic-embed-text","procedural":"bge-small-en-v1.5","emotional":"nomic-embed-text","reflective":"nomic-embed-text"}'
```

## Model Requirements

Ensure these Ollama models are pulled for optimal performance:

```bash
# Required: Fast, high-quality embedding models
ollama pull nomic-embed-text      # 768d, general-purpose, fast
ollama pull bge-small-en-v1.5     # 384d, optimized for procedural content
```

### Alternative Models (Higher Quality / Larger)

```bash
ollama pull mxbai-embed-large      # 1024d, more accurate but slower
ollama pull snowflake-arctic-embed # 1024d, enterprise-grade
```

## System Requirements for CPU-only VPS

- **Minimum**: 4 vCPU, 8GB RAM, 1GB storage per model (2GB+ for multiple models)
- **Recommended**: 6 vCPU, 16GB RAM, SSD storage
- **Disk**: ~500MB per embedding model + ~500MB for runtime

### Example Deployment Configurations

#### DigitalOcean VPS (Basic)
```bash
# Start Ollama service
docker run -d --name ollama \
  -p 11434:11434 \
  -v ollama_models:/root/.ollama \
  ollama/ollama:latest

# Pull required models
docker exec ollama ollama pull nomic-embed-text
docker exec ollama ollama pull bge-small-en-v1.5

# Start OpenMemory
OM_EMBED_KIND=router_cpu \
OM_OLLAMA_URL=http://localhost:11434 \
bun start
```

#### AWS EC2 (m6i.large)
```bash
# Instance: m6i.large (2 vCPU, 8GB RAM)
# Storage: 30GB GP3 SSD

# System setup
sudo apt update && sudo apt install -y docker.io
sudo systemctl start docker
sudo usermod -aG docker ubuntu

# Start Ollama with larger model size limit
docker run -d --name ollama \
  --gpus all \
  -p 11434:11434 \
  -v ollama_models:/root/.ollama \
  -e OLLAMA_MAX_LOADED_MODELS=3 \
  -e OLLAMA_NUM_THREAD=4 \
  ollama/ollama:latest

# Pull models in parallel
docker exec -d ollama ollama pull nomic-embed-text &
docker exec -d ollama ollama pull bge-small-en-v1.5 &
wait
```

## Verification

### Health Checks

```bash
# Check Ollama connectivity
curl -s http://localhost:11434/api/tags | jq '.models | length'

# Check router configuration
curl -s http://localhost:8080/embed/config | jq '.router_enabled'

# Test embedding generation
curl -X POST http://localhost:8080/embed/config \
  -H "Content-Type: application/json" \
  -d '{"text":"test content","sectors":["semantic"]}'
```

### Performance Benchmarking

```bash
# Basic throughput test (routes through different models per sector)
curl -X POST http://localhost:8080/memory/add \
  -H "Content-Type: application/json" \
  -d '{
    "content": "User performed complex task successfully",
    "user_id": "bench_user",
    "sectors": ["episodic", "procedural", "reflective"]
  }'

# Router performance test
time curl -X POST http://localhost:8080/memory/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "complex task",
    "k": 5,
    "user_id": "bench_user"
  }'
```

### Expected Performance Characteristics

- **Latency**: 150-300ms per embedding (Ollama inference + routing overhead)
- **Throughput**: 50-100 embeddings/sec on 4 vCPU
- **Memory usage**: 2-4GB RAM with 2-3 models loaded
- **Storage**: 750MB-1.5GB for models + SQLite database

## Troubleshooting

### Common Issues

**Vector dimension mismatches**
- Ensure all Ollama models output the same dimensionality (768d recommended)
- Check `OM_VEC_DIM` matches model outputs

**Ollama connectivity failures**
```bash
# Check Ollama status
curl http://localhost:11434/api/health

# Check model loading
curl http://localhost:11434/api/tags

# Restart Ollama if needed
docker restart ollama
```

**High memory usage**
```bash
# Limit concurrent Ollama workers
export OLLAMA_NUM_THREAD=2

# Unload unused models
curl -X POST http://localhost:8080/embed/ollama/delete \
  -H "Content-Type: application/json" \
  -d '{"model":"unused-model"}'
```

### Monitoring

Router-specific logs include:
- `[EMBED] Router decision: semantic → nomic-embed-text`
- `[EMBED] Router fusion: 0.6:0.4 ratio for semantic`
- `[EMBED] Router CPU: processing sector semantic with model nomic-embed-text`

Enable debug logging with `OM_LOG_EMBED_LEVEL=debug` to see routing decisions.

## Links

- [Main README](../../README.md)
- [Environment Configuration](../../.env.example)
- [Ollama Sidecar Documentation](./ollama-sidecar.md)
