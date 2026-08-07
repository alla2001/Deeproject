/**
 * Verifies the rule transfer.ts uses to locate Claude Code's transcripts for a
 * project, by encoding real project paths and checking the folder exists.
 *
 * Getting this wrong is silent: `claude --resume` would simply find no history
 * at the new location after a transfer.
 *
 *   node scripts/check-claude-encoding.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const encode = (p) => p.replace(/[^A-Za-z0-9]/g, '-')

const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
if (!fs.existsSync(projectsRoot)) {
  console.log('no ~/.claude/projects on this machine')
  process.exit(0)
}

const folders = fs.readdirSync(projectsRoot)
// Matched case-insensitively, as transfer.ts does: Windows treats c:\ and C:\
// as one folder but the encoding does not, so a project opened once with a
// lower-case drive letter has a folder starting `c--`.
const has = (name) => folders.some((f) => f.toLowerCase() === name.toLowerCase())
const statePath = path.join(process.env.APPDATA, 'deeproject', 'state.json')

let paths = []
if (fs.existsSync(statePath)) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''))
  paths = (state.projects ?? []).map((p) => p.path)
}
// Fall back to this repo so the check still says something useful.
if (paths.length === 0) paths = [process.cwd()]

let bad = 0
for (const projectPath of paths) {
  const encoded = encode(projectPath)
  const hit = has(encoded)
  if (!hit) bad++
  console.log(`${hit ? 'OK  ' : 'MISS'}  ${projectPath}\n        -> ${encoded}`)
}

console.log(`\nchecked ${paths.length} project(s), ${bad} mismatch(es)`)
console.log(`(${folders.length} transcript folders present)`)

// Round-trip a relocation: the encoding must change with the path.
const before = encode('C:\\Users\\Old Name\\Dev\\My Game')
const after = encode('D:\\Work\\My Game')
console.log(`\nrelocation example:\n  ${before}\n  ${after}`)
process.exit(bad === 0 ? 0 : 1)
