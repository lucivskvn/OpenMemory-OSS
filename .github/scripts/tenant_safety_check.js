#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const ROOT = process.cwd()
const DIRS = ['backend/src', 'tests', 'sdk-js', 'sdk-py']
// Load optional whitelist file to allow audited exceptions. Each non-empty
// line is treated as a substring match against the file path. Lines starting
// with '#' are ignored.
const WHITELIST_PATH = path.join(ROOT, '.github', 'tenant-safety-whitelist.txt')
let WHITELIST = []
try {
    if (fs.existsSync(WHITELIST_PATH)) {
        WHITELIST = fs.readFileSync(WHITELIST_PATH, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    }
} catch (e) {
    // non-fatal
    WHITELIST = []
}

function isWhitelisted(file) {
    if (!WHITELIST || !WHITELIST.length) return false
    for (const pat of WHITELIST) {
        if (file.includes(pat)) return true
    }
    return false
}
const EXTS = ['.ts', '.tsx', '.js', '.jsx']

const methods = [
    'q.del_vec.run',
    'q.del_vec_sector.run',
    'q.del_mem.run',
    'q.del_waypoints.run',
    'q.prune_waypoints.run'
]

function walk(dir, files = []) {
    if (!fs.existsSync(dir)) return files
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        const stat = fs.statSync(full)
        if (stat.isDirectory()) {
            if (name === 'node_modules' || name === '.git') continue
            walk(full, files)
        } else if (stat.isFile()) {
            if (EXTS.includes(path.extname(name))) files.push(full)
        }
    }
    return files
}

function stripComments(src) {
    let out = ''
    let i = 0
    let inS = false, inD = false, inT = false, esc = false
    while (i < src.length) {
        const ch = src[i]
        const next2 = src.slice(i, i + 2)
        if (!inS && !inD && !inT && next2 === '//') {
            // skip until EOL
            i += 2
            while (i < src.length && src[i] !== '\n') i++
            continue
        }
        if (!inS && !inD && !inT && next2 === '/*') {
            // skip block comment
            i += 2
            while (i < src.length && src.slice(i, i + 2) !== '*/') i++
            i += 2
            continue
        }
        if (esc) { out += ch; esc = false; i++; continue }
        if (ch === '\\') { out += ch; esc = true; i++; continue }
        if (!inD && !inT && ch === "'") { inS = !inS; out += ch; i++; continue }
        if (!inS && !inT && ch === '"') { inD = !inD; out += ch; i++; continue }
        if (!inS && !inD && ch === '`') { inT = !inT; out += ch; i++; continue }
        out += ch; i++
    }
    return out
}

function extractArgs(content, startIdx) {
    // startIdx is index of '('
    let i = startIdx + 1
    let depth = 1
    let inS = false, inD = false, inT = false, esc = false
    while (i < content.length) {
        const ch = content[i]
        if (esc) { esc = false; i++; continue }
        if (ch === '\\') { esc = true; i++; continue }
        if (!inD && !inT && ch === "'") { inS = !inS; i++; continue }
        if (!inS && !inT && ch === '"') { inD = !inD; i++; continue }
        if (!inS && !inD && ch === '`') { inT = !inT; i++; continue }
        if (inS || inD || inT) { i++; continue }
        if (ch === '(') { depth++ } else if (ch === ')') { depth--; if (depth === 0) return { args: content.slice(startIdx + 1, i), end: i } }
        i++
    }
    return null
}

function splitTopLevelArgs(argsStr) {
    const args = []
    let i = 0
    let cur = ''
    let depth = 0
    let inS = false, inD = false, inT = false, esc = false
    while (i < argsStr.length) {
        const ch = argsStr[i]
        if (esc) { cur += ch; esc = false; i++; continue }
        if (ch === '\\') { cur += ch; esc = true; i++; continue }
        if (!inD && !inT && ch === "'") { inS = !inS; cur += ch; i++; continue }
        if (!inS && !inT && ch === '"') { inD = !inD; cur += ch; i++; continue }
        if (!inS && !inD && ch === '`') { inT = !inT; cur += ch; i++; continue }
        if (inS || inD || inT) { cur += ch; i++; continue }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; i++; continue }
        if (ch === ')' || ch === ']' || ch === '}') { depth--; cur += ch; i++; continue }
        if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; i++; continue }
        cur += ch; i++
    }
    if (cur.trim() !== '') args.push(cur.trim())
    return args
}

function findMatchesInFile(file) {
    const src = fs.readFileSync(file, 'utf8')
    const clean = stripComments(src)
    const matches = []
    for (const m of methods) {
        let idx = 0
        while (true) {
            const pos = clean.indexOf(m, idx)
            if (pos === -1) break
            const parenPos = clean.indexOf('(', pos + m.length)
            if (parenPos === -1) { idx = pos + m.length; continue }
            const res = extractArgs(clean, parenPos)
            if (!res) { idx = pos + m.length; continue }
            const argsStr = res.args
            const args = splitTopLevelArgs(argsStr)
            let flag = false
            if (args.length < 2) flag = true
            else {
                const second = args[1].trim()
                if (second === 'null' || second === 'undefined') flag = true
            }
            if (flag) {
                const line = clean.slice(0, pos).split('\n').length
                matches.push({ method: m, file, line, snippet: clean.slice(pos, res.end + 1).split('\n').slice(0, 5).join('\n') })
            }
            idx = res.end + 1
        }
    }
    return matches
}

let totalMatches = []
for (const d of DIRS) {
    const full = path.join(ROOT, d)
    const files = walk(full)
    for (const f of files) {
        if (isWhitelisted(f)) continue
        const ms = findMatchesInFile(f)
        if (ms.length) totalMatches = totalMatches.concat(ms)
    }
}

if (totalMatches.length) {
    console.error('\nTenant safety check failed: found destructive q.* calls without tenant-scoping (missing second arg or null/undefined).')
    for (const m of totalMatches) {
        console.error(`\n${m.file}:${m.line} -> ${m.method}\n${m.snippet}\n`)
    }
    process.exit(1)
} else {
    console.log('Tenant safety check: no problematic invocations found.')
    process.exit(0)
}
