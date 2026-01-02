export const now = (): number => Date.now();
export const rid = (): string => globalThis.crypto.randomUUID();
export const j = JSON.stringify;
export const p = <t = any>(x: string): t => JSON.parse(x);

