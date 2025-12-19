// Structured logger implementation
const serializeError = (err: any) => {
    if (err instanceof Error) {
        return {
            message: err.message,
            stack: err.stack,
            name: err.name,
            ...err, // include custom properties
        };
    }
    return err;
};

const format = (level: string, message: string, meta?: any) => {
    const timestamp = new Date().toISOString();

    // Handle Error objects in meta
    let processedMeta = meta;
    if (meta) {
        if (meta instanceof Error) {
            processedMeta = { error: serializeError(meta) };
        } else if (typeof meta === 'object') {
            processedMeta = {};
            for (const key in meta) {
                if (key === 'error' || meta[key] instanceof Error) {
                    processedMeta[key] = serializeError(meta[key]);
                } else {
                    processedMeta[key] = meta[key];
                }
            }
        }
    }

    return JSON.stringify({
        timestamp,
        level,
        message,
        ...processedMeta,
    });
};

export const log = {
    info: (message: string, meta?: any) => console.log(format("INFO", message, meta)),
    error: (message: string, meta?: any) => console.error(format("ERROR", message, meta)),
    warn: (message: string, meta?: any) => console.warn(format("WARN", message, meta)),
    debug: (message: string, meta?: any) => {
        if (process.env.DEBUG) console.debug(format("DEBUG", message, meta));
    },
};
