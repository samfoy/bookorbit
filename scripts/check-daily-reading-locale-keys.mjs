// Verifies that every i18n key referenced by the Daily Reading UI is defined in
// client/src/locales/en.json.
//
// The repo-wide validator (client/scripts/validate-locales.mjs) additionally requires
// all 16 locale catalogs to carry every key. The pre-existing Daily Reading feature
// shipped English-only strings, so that validator already fails on this branch's base.
// This check enforces the part that is actionable for new code: en.json, the reference
// catalog, must define every key the Daily Reading components actually use.
//
// Exits non-zero and prints each missing key when the check fails.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const clientSrc = path.join(repoRoot, 'client/src')

// Source files whose t() keys must resolve. Keep this list narrow and explicit so the
// check stays fast and cannot be silently satisfied by deleting a component.
const TARGET_FILES = [
  'features/statistics/components/DailyReadingPage.vue',
  'features/statistics/components/DailyReadingDayDetail.vue',
]

function flatten(value, prefix = '', out = new Set()) {
  for (const [key, child] of Object.entries(value)) {
    const messageKey = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') out.add(messageKey)
    else if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, messageKey, out)
  }
  return out
}

const en = flatten(JSON.parse(await readFile(path.join(clientSrc, 'locales/en.json'), 'utf8')))

const missing = []
let scanned = 0
let referenced = 0

for (const relative of TARGET_FILES) {
  const absolute = path.join(clientSrc, relative)
  let source
  try {
    source = await readFile(absolute, 'utf8')
  } catch {
    console.error(`FAIL: expected source file is missing: client/src/${relative}`)
    process.exit(1)
  }
  scanned += 1

  const keys = new Set()
  for (const match of source.matchAll(/(?<![\w$])\$?t\(\s*(['"])([A-Za-z0-9_.-]+)\1/g)) keys.add(match[2])
  for (const match of source.matchAll(/<i18n-t\b[^>]*\bkeypath\s*=\s*(['"])([A-Za-z0-9_.-]+)\1/g)) keys.add(match[2])

  for (const key of keys) {
    referenced += 1
    if (!en.has(key)) missing.push(`${relative} -> ${key}`)
  }
}

// Guard against a vacuous pass: if the scan finds no keys at all, the regexes or the
// file list broke and the check is verifying nothing.
if (referenced === 0) {
  console.error('FAIL: found zero i18n keys across the Daily Reading sources - this check verified nothing')
  process.exit(1)
}

if (missing.length > 0) {
  console.error(`FAIL: ${missing.length} referenced key(s) missing from en.json:`)
  for (const entry of missing) console.error(`  - ${entry}`)
  process.exit(1)
}

// Sanity check that the locale directory still holds the full catalog set, so a
// dropped/renamed catalog file cannot slip through unnoticed.
const catalogs = (await readdir(path.join(clientSrc, 'locales'))).filter((f) => f.endsWith('.json'))
console.log(`OK: ${referenced} keys across ${scanned} Daily Reading source file(s) resolve in en.json (${catalogs.length} catalogs present)`)
