// LEGACY NODE SERVER (REMOVED)
//
// The legacy Node `server.js` implementation has been intentionally removed
// in favor of the Bun-native server in `backend/src/server/server.ts`.
//
// This file remains as an informational placeholder to avoid accidental
// runtime `require()` errors on systems that still try to import it. Do not
// add runtime behavior here. The canonical server entrypoint is the TypeScript
// Bun implementation (`server.ts`).

module.exports = function legacyServerPlaceholder() {
    throw new Error(
        'Legacy Node server removed: use the Bun server at backend/src/server/server.ts'
    );
};
