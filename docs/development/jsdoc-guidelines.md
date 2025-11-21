# Documentation & JSDoc / TSDoc Guidelines

This guide standardizes in-repo documentation, code comments, and JSDoc/TSDoc usage across OpenMemory.

## Goals

- Make public functions and modules easy to discover and use by external SDK users and internal devs.
- Use consistent tags and examples so tools like `jsdoc-to-markdown` and `typedoc` can produce reliable docs.
- Prefer TSDoc for TypeScript code; it is compatible with many JSDoc tags, but also supports TypeScript-accurate types.

## Core rules

### 1. Scope & visibility

- Document every exported function, class, and public constant in `backend/`, `sdk-js/`, and `sdk-py` wrapper files.
- Mark internal helpers with `@internal` (or private) and avoid documenting them in the public API docsite.

### 2. Use TSDoc compatible syntax in TypeScript files

- Use `/** .. */` block comments above declarations.
- Prefer type annotations in the signature instead of `@type` in the JSDoc block when the language is TypeScript.
- Common tags: `@param`, `@returns` (or `@return`), `@throws`, `@example`, `@deprecated`, `@see`, `@module`, `@internal`

### 3. `@param` & `@returns`

- Always name each `@param` with the exact parameter name and include short type or shape explanation only when types are ambiguous.
- For `@returns`, always document the value, not the type (types come from the signature). If the function can return `null`/`undefined`, mention it.
    - Example:

       ```ts

   ```ts
     /**
      * Create a new memory for a given user.
      * @param userId - The user's UUID (v4).
      * @param data - Optional object with metadata to store in the memory.
      * @returns {Promise<Memory>} The created Memory object.
      * @throws {ValidationError} If validation fails for input data.
      * @example
      * ```ts
      * const memory = await createMemory(userId, { text: 'Met at airport' });
      * ```
      */
       export async function createMemory(userId: string, data?: any): Promise<Memory> {}
       ```

### 4. Examples
   - Provide at least one `@example` for non-trivial exported functions and for SDK examples.
   - Keep examples short and realistic.

### 5. Deprecation & migration paths
   - Add `@deprecated` tag if the API will be removed or behavior will change; include migration steps.

### 6. Tools & enforcement (optional)
   - Consider adding `eslint-plugin-jsdoc` or `@microsoft/tsdoc` rules to the project linting.
   - Use `jsdoc-to-markdown` to centralize and render documentation from JSDoc/TSDoc comments.

### 7. Docs consolidation
   - Use the `docs/` tree for guidelines and larger how-tos. Keep top-level `README.md` focused on setup and quickstarts.
   - Add the JSDoc/TSDoc link to `CONTRIBUTING.md`.

### 8. Scripts & helper modules
   - For scripts under `scripts/` and `backend/scripts`, document top-level `main()` or CLI flags using `@module` and `@example`.
   - Provide consistent usage outputs (which many scripts already include). Always exit with `process.exit(1)` for invalid args.

### 9. Examples of tags to use
   - `@param` - parameter explanation.
   - `@returns` - what is returned (mention nullable/Promise).
   - `@throws` - list errors that may be thrown.
   - `@example` - usage.
   - `@internal` or `@private` - hide from public docs.

### 10. Minimal JSDoc for tests

   - Tests may have light docblocks to describe the scenario; prefer test names that explain behavior.

---

If you want, I can add eslint rules and update the CI to run JSDoc/TSDoc checks; ask and I'll propose a set of changes.

Contributors: follow GitHub PRs and reference this doc; the maintainers will review doc-specific changes in PRs.
