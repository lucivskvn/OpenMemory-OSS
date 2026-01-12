#!/bin/bash

echo "[START] Checking for Nvidia GPU..."

if command -v nvidia-smi &> /dev/null; then
    echo "[INFO] Nvidia GPU detected! Starting with GPU support..."
    docker-compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
else
    echo "[INFO] No Nvidia GPU detected. Starting in CPU mode..."
    docker-compose up -d
fi

if [ $? -eq 0 ]; then
    echo "[INFO] OpenMemory stack is starting..."
    echo "[INFO] Dashboard: http://localhost:8080"
    echo "[INFO] Ollama: http://localhost:11434"
else
    echo "[ERROR] Failed to start containers."
    exit 1
fi
