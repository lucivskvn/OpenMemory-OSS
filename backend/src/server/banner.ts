import logger from "../core/logger";

export function showBanner(banner: string) {
    // When running unit tests we want ZERO banner noise. Short-circuit
    // early so neither the structured base64 log nor the console banner
    // gets emitted. We rely on NODE_ENV==='test' as the detection used
    // by the test runner.
    try {
        if (process.env.NODE_ENV === "test") {
            return;
        }

        const b64 = Buffer.from(banner, "utf8").toString("base64");
        // Structured log retains the banner data in a machine-readable field
        logger.info({ banner_b64: b64 }, "OpenMemory banner (base64)");
    } catch (e) {
        // Fallback to a simple log if encoding fails
        logger.info("OpenMemory banner (raw)");
    }

    // Print a colored banner for interactive terminals only, with extra padding
    try {
        const pad = "\n\n"; // two blank lines to provide better separation from logs
        const delayMs = 10; // small fade-in delay to reduce log interleaving
        if (typeof process !== "undefined" && (process.stdout as any)?.isTTY) {
            const green = "\x1b[32m";
            const reset = "\x1b[0m";
            // Print with a tiny delay to allow prior log processors to flush
            setTimeout(() => {
                console.log(pad + green + banner + reset + pad);
            }, delayMs);
        } else {
            // Non-TTY: still print the banner raw with padding, delayed slightly
            setTimeout(() => {
                console.log(pad + banner + pad);
            }, delayMs);
        }
    } catch (e) {
        // ignore
    }
}
