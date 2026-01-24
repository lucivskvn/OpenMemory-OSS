# OpenMemory Test Standards & Naming Convention

## Test Naming Convention

All tests must follow this standardized naming pattern:

### Phase-Based Organization
- **Phase 1**: Core Infrastructure & Database (✅ 9 tests passing)
- **Phase 2**: Memory & HSG Engine (✅ 10 tests passing)
- **Phase 3**: API & Server Layer (✅ 3 tests passing)
- **Phase 4**: Integration & End-to-End (✅ 6 tests passing)
- **Phase 5**: Performance & Load Testing
- **Phase 6**: Security & Authentication  
- **Phase 7**: Property-Based Testing

### Naming Format
```
Phase{N} {Component} > {Feature} > {Specific Test Case}
```

### Examples
```typescript
describe("Phase1 Core Infrastructure", () => {
  describe("Database Operations", () => {
    test("should initialize all required tables", () => {});
    test("should handle transaction rollbacks correctly", () => {});
  });
});

describe("Phase2 Memory Engine", () => {
  describe("HSG Classification", () => {
    test("should classify episodic content accurately", () => {});
    test("should handle duplicate content via simhash", () => {});
  });
});

describe("Phase3 API Server", () => {
  describe("Health Endpoints", () => {
    test("should return 200 for /health endpoint", () => {});
    test("should return system metrics for /dashboard/health", () => {});
  });
});
```

## Current Test Status

### ✅ Passing Phases
- **Phase1**: Core Infrastructure (9 tests) - Database operations, security isolation
- **Phase2**: Memory Engine (10 tests) - HSG memory operations, classification, search
- **Phase3**: API Server (3 tests) - Server health checks and basic endpoints
- **Phase4**: Integration (6 tests) - Core infrastructure integration, deduplication
- **Phase7**: Property-Based Testing (17 tests) - Dependency audit, security, version consistency
- **Phase4**: Integration (6 tests) - Core infrastructure integration, deduplication
- **Phase7**: Property-Based Testing (15 tests) - Dependency audit, security, version consistency

### 🔄 In Progress
- **Phase5**: Performance tests need standardization
- **Phase6**: Security tests need consolidation

## Test Categories

### Unit Tests (`test/unit/`)
- Individual function/class testing
- Mocked dependencies
- Fast execution (<100ms per test)

### Integration Tests (`test/integration/`)
- Component interaction testing
- Real database connections
- Medium execution (<1s per test)

### End-to-End Tests (`test/e2e/`)
- Full workflow testing
- Real services
- Slower execution (<10s per test)

### Property Tests (`test/property/`)
- Property-based testing
- Randomized inputs
- Correctness verification

### Performance Tests (`test/performance/`)
- Load testing
- Memory leak detection
- Benchmark validation

## Test Environment Standards

### Environment Variables
```bash
OM_TIER=local
OM_EMBEDDINGS=local
OM_DB_PATH=:memory:
OM_LOG_LEVEL=error
OM_TELEMETRY_ENABLED=false
OM_TEST_MODE=true
OM_API_KEYS=test-key-123
OM_ADMIN_KEY=admin-test-key-456
OM_TEST_TIMEOUT=30000
OM_KEEP_DB=true  # For tests that need persistent DB across test cases
```

### Mock Standards
- Use `bun:test` mocking framework
- Mock external dependencies (Redis, APIs, Embeddings)
- Provide realistic mock data
- Clean up mocks in `afterEach`

### Database Standards
- Use `:memory:` for unit tests
- Use test containers for integration tests
- Clean up data between tests
- Use transactions for isolation
- Set `OM_KEEP_DB=true` for tests that need persistent DB

## Error Handling Standards

### Expected Errors
- Test error conditions explicitly
- Verify error messages and types
- Test recovery mechanisms

### Timeout Handling
- Set appropriate timeouts (30s max)
- Handle async operations properly
- Prevent hanging tests

## Performance Standards

### Test Execution Time
- Unit tests: <100ms
- Integration tests: <1s
- E2E tests: <10s
- Property tests: <30s

### Resource Usage
- Memory: <512MB per test suite
- CPU: Reasonable utilization
- Network: Mock external calls

## Reporting Standards

### Test Output
- Clear, descriptive test names
- Meaningful assertions
- Proper error messages
- Coverage reporting

### Generated Reports Location
All automated reports should be generated in the following fixed locations:

- **Coverage Reports**: `packages/openmemory-js/coverage/` (HTML and lcov.info)
- **Test Results**: Console output only (no separate files)
- **Performance Reports**: `packages/openmemory-js/test/performance/results/` (if needed)
- **Security Scan Reports**: Console output or append to `SECURITY.md` in root
- **Dependency Audit**: Console output or append to existing docs

**Important**: Do NOT create scattered report files. All reports should either:
1. Go to the designated folders above
2. Be output to console only
3. Be appended to existing documentation files

### CI/CD Integration
- All tests must pass
- Coverage thresholds enforced
- Performance regression detection
- Security vulnerability scanning

## Test Runner Usage

### Run All Phases
```bash
bun run test:phases
```

### Run Individual Phases
```bash
bun run test:phase1  # Core Infrastructure
bun run test:phase2  # Memory Engine
bun run test:phase3  # API Server
bun run test:phase4  # Integration Tests
bun run test:phase7  # Property-Based Tests
```

### Run Specific Tests
```bash
bun test ./test/core/security.test.ts
bun test ./test/phase2-memory-engine.test.ts
```

## Recent Fixes Applied

### ✅ Fixed Issues
1. **Database Connection Issues**: Fixed in-memory database isolation between tests
2. **Embedding System Mocking**: Added proper mocks for embedding system in test mode
3. **Test Runner Patterns**: Fixed file pattern matching for multiple test files
4. **Security Test Isolation**: Ensured proper user isolation testing
5. **Test Count Reporting**: Fixed test count parsing in test runner

### 🔧 Key Solutions
- Mock embedding system to prevent model loading in tests
- Use `q` object instead of `allAsync` for consistent database connections
- Set `OM_KEEP_DB=true` for tests needing persistent database state
- Proper error handling and timeout management
- Standardized Phase-based naming convention