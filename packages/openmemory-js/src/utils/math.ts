export const clamp_f = (val: number, min = 0, max = 1): number => {
    if (!Number.isFinite(val)) return min;
    return Math.max(min, Math.min(max, val));
};
