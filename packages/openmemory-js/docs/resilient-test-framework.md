# OpenMemory Resilient Test Framework

## Overview

The OpenMemory Resilient Test Framework is a memory-aware, OOM-prevention test execution system designed to provide stable and reliable testing for the OpenMemory codebase. It replaces the previous generic test suite with an intelligent framework that manages memory usage, prevents out-of-memory errors, and provides clear phase-based test organization.

## Key Features

### 🧠 Memory Management
- **Dynamic Memory Allocation**: Automatically detects system memory and allocates appropriate heap sizes
- **Per-Phase Memory Limits**: Each test phase has configurable memory limits based on system capacity
- **OOM Prevention**: Monitors memory usage in real-time and terminates tests before system exhaustion
- **Garbage Collection**: Automatic garbage collection between test phases and patterns
- **Memory Leak Detection**: Identifies and prevents memory leaks in long-running test scenarios

### 🔒 Process Isolation
- **Isolated Execution**: Memory-intensive tests run in separate processes
- **Process Monitoring**: Real-time monitoring of process memory usage and health
- **Automatic Termination**: Stuck or runaway processes are automatically terminated
- **Resource Cleanup**: Comprehensive cleanup of processes, files, and resources

### ⏱️ Intelligent Timeouts
- **Escalating Timeouts**: Different timeout values for unit, integration, E2E, and performance tests
- **Watchdog Protection**: Multi-level watchdog system prevents infinite hangs
- **Graceful Termination**: Escalating termination strategies (SIGTERM → SIGKILL → platform-specific)

### 📊 Phase-Based Organization
- **Clear Structure**: Tests organized into logical phases with descriptive names
- **Priority System**: Critical vs non-critical phases with appropriate handling
- **Retry Logic**: Configurable retry attempts for flaky tests
- **Skip Logic**: Non-critical phases are skipped if critical phases fail

## Test Phases

### 1. Core Infrastructure Validation
- **Purpose**: Database, security, and configuration validation
- **Memory**: 20% of system memory
- **Timeout**: 15 seconds
- **Critical**: Yes
- **Isolation**: No

### 2. Memory Engine Verification
- **Purpose**: HSG engine, embeddings, and vector operations
- **Memory**: 40% of system memory
- **Timeout**: 25 seconds
- **Critical**: Yes
- **Isolation**: Yes

### 3. API Server Integration
- **Purpose**: ElysiaJS routes, middleware, and server functionality
- **Memory**: 30% of system memory
- **Timeout**: 20 seconds
- **Critical**: Yes
- **Isolation**: No

### 4. End-to-End Workflows
- **Purpose**: CLI integration and client workflows
- **Memory**: 50% of system memory
- **Timeout**: 45 seconds
- **Critical**: Yes
- **Isolation**: Yes

### 5. Performance & Load Testing
- **Purpose**: Benchmarks, stress tests, and performance validation
- **Memory**: 60% of system memory
- **Timeout**: 90 seconds
- **Critical**: No
- **Isolation**: Yes

### 6. Property-Based Correctness
- **Purpose**: Universal properties and correctness validation
- **Memory**: 40% of system memory
- **Timeout**: 120 seconds
- **Critical**: No
- **Isolation**: Yes

## Usage

### Running the Complete Framework
```bash
# Run all test phases with memory management
bun run test:resilient

# Run specific phases
bun run test:core          # Core Infrastructure
bun run test:memory        # Memory Engine
bun run test:server        # API Server
bun run test:integration   # End-to-End
bun run test:performance   # Performance Tests
bun run test:properties    # Property-Based Tests
```

### Configuration

The framework automatically detects system capabilities and configures itself appropriately. Key configuration points:

- **System Memory Detection**: Automatically detects available system memory
- **Memory Limits**: Caps maximum heap size at 8GB for stability
- **Concurrent Processes**: Limits concurrent processes based on available memory
- **Timeout Escalation**: Provides appropriate timeouts for different test types

### Environment Variables

The framework sets optimal environment variables for test execution:

```bash
OM_TIER=local
OM_EMBEDDINGS=local
OM_DB_PATH=:memory:
OM_LOG_LEVEL=error
OM_TELEMETRY_ENABLED=false
OM_TEST_MODE=true
NODE_OPTIONS=--max-old-space-size=<calculated> --expose-gc
```

## Memory Management Details

### Dynamic Memory Allocation
- Detects system memory at runtime
- Allocates memory based on available resources
- Caps maximum heap size for system stability
- Provides per-phase memory limits

### OOM Prevention
- Real-time memory monitoring every 2 seconds
- Warning at 85% memory usage
- Critical termination at 95% memory usage
- Automatic garbage collection when memory is high

### Process Isolation
- Memory-intensive tests run in separate processes
- Each process has its own memory limit
- Process memory usage is monitored independently
- Failed processes don't affect other tests

## Error Handling

### Memory Exhaustion
- Tests are terminated before system OOM
- Clear error messages indicate memory issues
- Suggestions for increasing memory limits
- Graceful degradation for non-critical phases

### Process Failures
- Stuck processes are automatically terminated
- Escalating termination strategies
- Comprehensive cleanup of resources
- Detailed error reporting

### Timeout Handling
- Multiple timeout layers (test, process, watchdog)
- Graceful termination with cleanup
- Clear timeout error messages
- Diagnostic information for debugging

## System Requirements

### Minimum Requirements
- **Memory**: 2GB system RAM
- **Node.js**: Version 18+ (for Bun compatibility)
- **Disk Space**: 1GB free space for test artifacts

### Recommended Requirements
- **Memory**: 8GB+ system RAM
- **CPU**: Multi-core processor for parallel execution
- **Disk Space**: 5GB+ free space for comprehensive testing

## Monitoring and Diagnostics

### Real-Time Monitoring
- Memory usage tracking per phase
- Process health monitoring
- Timeout warnings and alerts
- Performance metrics collection

### Comprehensive Reporting
- Phase-by-phase results
- Memory usage statistics
- Execution time tracking
- Success/failure analysis

### Diagnostic Information
- Clear error messages
- Memory usage at failure
- Process termination reasons
- Suggestions for resolution

## Benefits

### Stability
- Prevents system crashes from OOM
- Handles stuck and runaway processes
- Provides graceful error recovery
- Maintains system responsiveness

### Performance
- Optimized memory usage
- Parallel execution where safe
- Efficient resource cleanup
- Minimal system impact

### Reliability
- Consistent test execution
- Reduced flaky test failures
- Comprehensive error handling
- Predictable resource usage

### Maintainability
- Clear phase organization
- Centralized configuration
- Comprehensive logging
- Easy debugging and troubleshooting

## Migration from Previous Test Suite

The new framework is backward compatible with existing tests while providing enhanced capabilities:

1. **Automatic Detection**: Existing test files are automatically included in appropriate phases
2. **Enhanced Execution**: Tests run with memory management and timeout protection
3. **Improved Reporting**: Better error messages and diagnostic information
4. **Graceful Degradation**: Non-critical test failures don't block the entire suite

## Future Enhancements

- **Distributed Testing**: Support for running tests across multiple machines
- **Cloud Integration**: Integration with cloud-based testing services
- **Advanced Analytics**: Machine learning-based test optimization
- **Custom Phases**: User-defined test phases and configurations