export function spyLoggerMethod(loggerObj: any, methodName: string, onCall?: (...args: any[]) => void) {
    const target = (loggerObj && loggerObj.default) ? loggerObj.default : loggerObj;
    if (!target || typeof target[methodName] !== 'function') {
        throw new Error(`Logger method not found: ${methodName}`);
    }
    const orig = target[methodName];
    let called = false;
    let calls = 0;
    const spy = function (this: any, ...args: any[]) {
        called = true;
        calls++;
        try {
            if (onCall) onCall(...args);
        } catch (e) {
            // swallow handler errors
        }
        return orig.apply(this, args);
    } as any;

    // Copy own properties from original to spy (including symbols) so pino
    // internals that attach metadata to the function object remain available.
    try {
        Object.getOwnPropertyNames(orig).forEach((k) => {
            try {
                const desc = Object.getOwnPropertyDescriptor(orig, k);
                if (desc) Object.defineProperty(spy, k, desc);
            } catch (_) { }
        });
        Object.getOwnPropertySymbols(orig).forEach((s) => {
            try {
                const desc = Object.getOwnPropertyDescriptor(orig, s as any);
                if (desc) Object.defineProperty(spy, s as any, desc);
            } catch (_) { }
        });
    } catch (_) { }

    // Install spy
    target[methodName] = spy;

    return {
        restore() {
            try { target[methodName] = orig; } catch (_) { }
        },
        get called() { return called; },
        get calls() { return calls; },
    } as const;
}
