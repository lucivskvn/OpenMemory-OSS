@echo off
setlocal

echo [START] Checking for Nvidia GPU...
nvidia-smi >nul 2>&1
if %errorlevel% equ 0 (
    echo [INFO] Nvidia GPU detected! Starting with GPU support...
    docker-compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
) else (
    echo [INFO] No Nvidia GPU detected or nvidia-smi failed. Starting in CPU mode...
    docker-compose up -d
)

if %errorlevel% neq 0 (
    echo [ERROR] Failed to start containers.
    exit /b %errorlevel%
)

echo [INFO] OpenMemory stack is starting...
echo [INFO] Dashboard: http://localhost:8080
echo [INFO] Ollama: http://localhost:11434
endlocal
