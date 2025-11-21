export const formatTime = (ts?: number | string | Date, opts?: { timeOnly?: boolean; dateOnly?: boolean; locale?: string }) => {
    if (!ts) return ""
    const date = typeof ts === "string" || typeof ts === "number" ? new Date(ts) : ts
    const locale = opts?.locale || "en-US"
    if (opts?.timeOnly) {
        return date.toLocaleTimeString(locale, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        })
    }

    if (opts?.dateOnly) {
        return date.toLocaleDateString(locale)
    }

    // Human friendly: medium date + short time
    if ((Intl as any) && typeof (Intl as any).DateTimeFormat === 'function') {
        try {
            return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date as Date)
        } catch (e) {
            // fall back
        }
    }

    return date.toLocaleString(locale)
}
