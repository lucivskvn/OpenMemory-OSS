export const formatNumber = (
    n?: number | string,
    opts?: { locale?: string; maximumFractionDigits?: number; compact?: boolean }
) => {
    if (n === undefined || n === null) return ""
    const val = typeof n === "string" ? Number(n) : n
    if (Number.isNaN(Number(val))) return String(n)

    const locale = opts?.locale || "en-US"
    const maximumFractionDigits = opts?.maximumFractionDigits

    const formatOptions: Intl.NumberFormatOptions = {}
    if (opts?.compact) {
        formatOptions.notation = "compact"
        if (maximumFractionDigits !== undefined) formatOptions.maximumFractionDigits = maximumFractionDigits
        else formatOptions.maximumFractionDigits = 1
    } else {
        // default: show no decimals unless requested
        if (maximumFractionDigits !== undefined) formatOptions.maximumFractionDigits = maximumFractionDigits
    }

    try {
        return new Intl.NumberFormat(locale, formatOptions).format(Number(val))
    } catch (e) {
        return String(val)
    }
}
