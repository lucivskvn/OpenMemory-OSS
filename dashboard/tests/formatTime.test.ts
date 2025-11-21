import { describe, test, expect } from 'bun:test'
import { formatTime } from '@/lib/time'

describe('formatTime helper', () => {
    test('returns empty string for undefined or falsy input', () => {
        expect(formatTime(undefined)).toBe('')
        expect(formatTime(null as any)).toBe('')
    })

    test('timeOnly returns HH:MM:SS (24hr) format', () => {
        // Use a fixed timestamp (2025-11-18T15:04:05Z)
        const ts = Date.parse('2025-11-18T15:04:05Z')
        const t = formatTime(ts, { timeOnly: true })
        // Should include seconds and at least one colon
        expect(t.includes(':')).toBe(true)
        expect(/\d{1,2}:\d{2}:\d{2}/.test(t)).toBe(true)
    })

    test('dateOnly returns a date string without a time component', () => {
        const ts = Date.parse('2025-11-18T15:04:05Z')
        const d = formatTime(ts, { dateOnly: true })
        // Should not include ':', which indicates a time
        expect(d.includes(':')).toBe(false)
        // It should include the year 2025
        expect(d.includes('2025') || d.includes('25')).toBe(true)
    })

    test('default returns both a date and a time', () => {
        const ts = Date.parse('2025-11-18T15:04:05Z')
        const r = formatTime(ts)
        // Should include both comma or a year and a time colon
        expect(r.includes(':')).toBe(true)
        // Look for a year or a month short name
        expect(/2025/.test(r) || /Nov|Nov\./.test(r)).toBe(true)
    })

    test('respects locale option', () => {
        const ts = Date.parse('2025-11-18T15:04:05Z')
        const en = formatTime(ts, { locale: 'en-US' })
        const de = formatTime(ts, { locale: 'de-DE' })
        expect(en).not.toBe(de)
    })
})
