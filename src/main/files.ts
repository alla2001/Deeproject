import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { FileEntry, ReadFileResult } from '@shared/types'

/** Files above this are refused rather than loaded into the editor. */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024

/** Noise that would swamp a project tree. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'release',
  'build',
  '.next',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target'
])

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.lua': 'lua',
  '.luau': 'lua',
  '.rs': 'rust',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'shell',
  '.bash': 'shell',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.xml': 'xml',
  '.svg': 'xml',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.gitignore': 'plaintext',
  '.txt': 'plaintext',
  '.log': 'plaintext'
}

export function languageForPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  if (LANGUAGE_BY_EXT[ext]) return LANGUAGE_BY_EXT[ext]
  const base = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'plaintext'
  return 'plaintext'
}

/**
 * Guard against a renderer asking for something outside the project it claims
 * to be browsing. Paths are resolved before comparison so `..` cannot escape.
 */
export function isInside(root: string, target: string): boolean {
  const a = resolve(root)
  const b = resolve(target)
  if (a === b) return true
  return b.startsWith(a.endsWith(sep) ? a : a + sep)
}

export async function listDirectory(dirPath: string): Promise<FileEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const out: FileEntry[] = []

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
    // Symlinks are reported by their own type rather than followed, so a loop
    // in the tree can't hang the walk.
    const full = join(dirPath, entry.name)
    let size = 0
    let modified = 0
    try {
      const info = await stat(full)
      size = info.size
      modified = info.mtimeMs
    } catch {
      // Unreadable entries still get listed, just without metadata.
    }
    out.push({
      name: entry.name,
      path: full,
      isDirectory: entry.isDirectory(),
      size,
      modified
    })
  }

  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return out
}

/** Heuristic: a NUL byte in the first block means this isn't text. */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000)
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

export async function readTextFile(filePath: string): Promise<ReadFileResult> {
  const base: ReadFileResult = {
    ok: false,
    path: filePath,
    content: '',
    language: languageForPath(filePath),
    error: null,
    modified: 0
  }

  try {
    const info = await stat(filePath)
    if (info.isDirectory()) return { ...base, error: 'That path is a folder.' }
    if (info.size > MAX_EDITABLE_BYTES) {
      const mb = (info.size / 1024 / 1024).toFixed(1)
      return { ...base, error: `File is ${mb} MB; too large to open here.` }
    }

    const buffer = await readFile(filePath)
    if (looksBinary(buffer)) return { ...base, error: 'This looks like a binary file.' }

    return {
      ...base,
      ok: true,
      content: buffer.toString('utf8'),
      modified: info.mtimeMs
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ...base, error: message }
  }
}

export async function writeTextFile(
  filePath: string,
  content: string,
  expectedModified: number | null
): Promise<{ ok: boolean; modified: number; error?: string; conflict?: boolean }> {
  try {
    if (expectedModified !== null && existsSync(filePath)) {
      const info = await stat(filePath)
      // Guard against silently overwriting an edit made outside the app.
      if (Math.abs(info.mtimeMs - expectedModified) > 1) {
        return {
          ok: false,
          modified: info.mtimeMs,
          conflict: true,
          error: 'This file changed on disk since you opened it.'
        }
      }
    }
    await writeFile(filePath, content, 'utf8')
    const info = await stat(filePath)
    return { ok: true, modified: info.mtimeMs }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, modified: 0, error: message }
  }
}

/**
 * Flat recursive file list used by quick-open. Bounded so a huge tree cannot
 * stall the UI or blow up the IPC payload.
 */
export async function walkFiles(root: string, limit = 8000): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = [root]

  while (queue.length > 0 && out.length < limit) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= limit) break
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        queue.push(join(dir, entry.name))
      } else if (entry.isFile()) {
        out.push(join(dir, entry.name))
      }
    }
  }
  return out
}
