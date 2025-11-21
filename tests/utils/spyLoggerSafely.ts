export function spyLoggerMethod(
  loggerObj: any,
  methodName: string,
  onCall?: (...args: any[]) => void,
) {
  // Resolve possible module default wrappers
  const target = loggerObj && loggerObj.default ? loggerObj.default : loggerObj;

  // Track whether we had an original to restore later
  const orig =
    target && typeof target[methodName] === 'function'
      ? target[methodName]
      : undefined;
  let called = false;
  let calls = 0;

  // Create a spy that calls the original when available, and always
  // invokes the onCall handler safely.
  const spy = function (this: any, ...args: any[]) {
    called = true;
    calls++;
    try {
      if (onCall) onCall(...args);
    } catch (e) {}
    try {
      if (typeof orig === 'function') return orig.apply(this, args);
    } catch (e) {}
    return undefined;
  } as any;

  // If we have an original function, copy its own properties (and symbols)
  // onto the spy so libraries like pino that attach metadata aren't broken.
  try {
    if (orig) {
      Object.getOwnPropertyNames(orig).forEach((k) => {
        try {
          const desc = Object.getOwnPropertyDescriptor(orig, k);
          if (desc) Object.defineProperty(spy, k, desc);
        } catch (_) {}
      });
      Object.getOwnPropertySymbols(orig).forEach((s) => {
        try {
          const desc = Object.getOwnPropertyDescriptor(orig, s as any);
          if (desc) Object.defineProperty(spy, s as any, desc);
        } catch (_) {}
      });
    }
  } catch (_) {}

  // Safely install the spy; if target is missing, create a minimal object
  // to attach the spy to so callers can still restore it later.
  try {
    if (!target) {
      // If no target present, create a dummy holder on the provided loggerObj
      // so callers using the module shape don't fail.
      if (loggerObj && typeof loggerObj === 'object') {
        (loggerObj as any)[methodName] = spy;
      }
    } else {
      try {
        target[methodName] = spy;
      } catch (_) {
        // last-resort: define property if assignment fails
        try {
          Object.defineProperty(target, methodName, {
            value: spy,
            configurable: true,
            writable: true,
          });
        } catch (_) {}
      }
    }
  } catch (_) {}

  return {
    restore() {
      try {
        if (target && typeof orig !== 'undefined') {
          target[methodName] = orig;
        } else if (
          loggerObj &&
          typeof loggerObj === 'object' &&
          typeof (loggerObj as any)[methodName] === 'function'
        ) {
          // remove the dummy we created
          try {
            delete (loggerObj as any)[methodName];
          } catch (_) {}
        }
      } catch (_) {}
    },
    get called() {
      return called;
    },
    get calls() {
      return calls;
    },
  } as const;
}
