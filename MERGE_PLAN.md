# Merge Plan: Integrating Main and Fix Branches into Next

**Date:** 2025-11-21  
**Current Branch:** next  
**Target Branches:** origin/main (AWS features), origin/fix-ts-lint-ci-db-bug (critical fixes)

## Status Summary

### Current State
- **next branch**: Behind origin/next by 0 commits (just updated)
- **main branch**: Contains AWS embedding provider support (~20 commits ahead)
- **fix branch**: Contains TS/Lint fixes and Zod downgrade for MCP compatibility

### Key Differences

#### From Main Branch (AWS Features)
1. **AWS Bedrock Integration** - Full AWS embedding provider support
2. **AWS Environment Variables** - Configuration for AWS credentials and region
3. **Documentation Updates** - AWS mentioned in README, Why.md, ARCHITECTURE.md
4. **Dependency Updates** - @aws-sdk/client-s3 already in next

#### From Fix Branch (Already Merged)
✅ All formatting fixes from `origin/fix-ts-lint-ci-db-bug` are now in next (just pulled)
- TypeScript/Lint fixes
- Workflow improvements  
- Code formatting standardization

## What We Need to Do

### 1. Cherry-pick AWS Features from Main
Since next already has the latest fixes, we only need to selectively merge AWS features:

**Files to merge:**
- `backend/src/memory/embed.ts` - Add AWS embedding function
- `backend/src/core/cfg.ts` - Add AWS environment variables
- `README.md` - Add AWS documentation
- `Why.md` - Add AWS references
- `ARCHITECTURE.md` - Add AWS provider documentation
- `.env.example` - Add AWS configuration template
- `docker-compose.yml` - Add AWS environment variables

### 2. Validation Steps
After merge:
1. Run `cd backend && bun install` to ensure dependencies are correct
2. Run `bun run build` to check TypeScript compilation
3. Run tests: `bun test`
4. Verify AWS provider can be selected (even without credentials configured)

### 3. Zod Version Strategy
**Current:** zod@^4.1.12 in next (latest)
**Fix branch had:** zod@^3.23.8 (for MCP compatibility)

**Decision:** Keep zod@^4.1.12 since:
- MCP SDK has been updated to handle newer Zod
- Tests are passing with current version
- If issues arise, we can downgrade later with clear reasoning

## Execution Plan

```bash
# 1. Create a feature branch for AWS integration
git checkout -b feature/aws-embedding-integration next

# 2. Cherry-pick AWS-specific commits from main
# (We'll identify specific commits and apply them)

# 3. Resolve any conflicts favoring next's structure

# 4. Test the integration

# 5. Merge back to next if successful
```

## Risk Assessment

**Low Risk:**
- AWS code is additive (new provider option)
- Doesn't affect existing synthetic/OpenAI/Gemini/Ollama providers
- Environment variables are optional

**Medium Risk:**
- May need to reconcile differences in embed.ts structure
- Need to ensure AWS dependencies don't conflict

**High Risk:**
- None identified

## Rollback Plan

If integration fails:
```bash
git reset --hard origin/next
git stash pop  # Restore WIP AI SDK work
```

## Success Criteria

1. ✅ All existing tests pass
2. ✅ Backend builds successfully  
3. ✅ AWS provider appears in embedding options
4. ✅ Other providers (OpenAI, Gemini, Ollama) still work
5. ✅ No TypeScript/Lint errors introduced
6. ✅ Documentation reflects AWS support

---

**Next Steps:** Execute the cherry-pick strategy for AWS features.
