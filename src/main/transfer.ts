import { app } from 'electron'
import { hostname } from 'node:os'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, isAbsolute } from 'node:path'
import type {
  AppState,
  BundleSummary,
  GameIdea,
  PathProbe,
  Project,
  TransferBundle
} from '@shared/types'
import { loadLayout, loadState, saveLayout, saveState } from './store'

const BUNDLE_VERSION = 1
const MANIFEST = 'bundle.json'

/**
 * Claude Code keys a project's transcripts by its absolute path, with every
 * character outside [A-Za-z0-9] replaced by a hyphen — `C:\Users\The Fairy\x`
 * becomes `C--Users-The-Fairy-x`. The encoding is lossy and cannot be reversed,
 * but it does not need to be: on import the *new* path is encoded to find where
 * the transcripts should land so `claude --resume` sees them.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-')
}

function claudeProjectsRoot(): string {
  return join(app.getPath('home'), '.claude', 'projects')
}

/**
 * Locate the transcript folder for a path, tolerating drive-letter case.
 *
 * Windows treats `c:\x` and `C:\x` as the same folder, but the encoding above
 * does not — a project opened once as `c:` gets a folder starting `c--`. An
 * exact-name lookup would quietly find nothing and lose that project's history,
 * so existing folders are matched case-insensitively.
 */
function findTranscriptFolder(encoded: string): string | null {
  const root = claudeProjectsRoot()
  if (!existsSync(root)) return null

  const exact = join(root, encoded)
  if (existsSync(exact)) return exact

  const wanted = encoded.toLowerCase()
  try {
    for (const name of readdirSync(root)) {
      if (name.toLowerCase() === wanted) return join(root, name)
    }
  } catch {
    // Unreadable; treat as absent.
  }
  return null
}

/** Recursive copy that never follows into anything but plain files and dirs. */
function copyTree(from: string, to: string, skipExisting = false): number {
  let count = 0
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      count += copyTree(source, target, skipExisting)
    } else if (entry.isFile()) {
      if (skipExisting && existsSync(target)) continue
      copyFileSync(source, target)
      count++
    }
  }
  return count
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else if (entry.isFile()) {
      try {
        total += statSync(full).size
      } catch {
        // Unreadable file; ignore its size.
      }
    }
  }
  return total
}

// ---- export ----------------------------------------------------------------

export function exportBundle(
  targetDir: string,
  opts: { includeConversations: boolean }
): { ok: boolean; error?: string; bytes?: number; projects?: number; conversations?: number } {
  try {
    mkdirSync(targetDir, { recursive: true })
    const state = loadState()

    // Idea attachments live in our own store; copy them in beside the manifest.
    const images: Record<string, string[]> = {}
    for (const idea of state.ideas) {
      if (idea.images.length === 0) continue
      const dest = join(targetDir, 'images', idea.id)
      mkdirSync(dest, { recursive: true })
      const names: string[] = []
      for (const image of idea.images) {
        if (!existsSync(image)) continue
        const name = basename(image)
        copyFileSync(image, join(dest, name))
        names.push(name)
      }
      if (names.length > 0) images[idea.id] = names
    }

    const conversations: string[] = []
    if (opts.includeConversations) {
      for (const project of state.projects) {
        const source = findTranscriptFolder(encodeProjectPath(project.path))
        if (!source) continue
        copyTree(source, join(targetDir, 'claude', project.id))
        conversations.push(project.id)
      }
    }

    const bundle: TransferBundle = {
      kind: 'deeproject-bundle',
      version: BUNDLE_VERSION,
      exportedAt: Date.now(),
      machine: hostname(),
      home: app.getPath('home'),
      state,
      layout: loadLayout(),
      images,
      conversations
    }

    writeFileSync(join(targetDir, MANIFEST), JSON.stringify(bundle, null, 2), 'utf8')

    return {
      ok: true,
      bytes: dirSize(targetDir),
      projects: state.projects.length,
      conversations: conversations.length
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

/** Rough size of what an export would produce, so the UI can warn first. */
export function estimateConversationBytes(): number {
  const state = loadState()
  let total = 0
  for (const project of state.projects) {
    const folder = findTranscriptFolder(encodeProjectPath(project.path))
    if (folder) total += dirSize(folder)
  }
  return total
}

// ---- import ----------------------------------------------------------------

function readManifest(bundleDir: string): TransferBundle | null {
  try {
    const raw = readFileSync(join(bundleDir, MANIFEST), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw) as TransferBundle
    if (parsed?.kind !== 'deeproject-bundle') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Work out where each project should live on this machine.
 *
 * Tried in order: the original path; the same path with the exporting machine's
 * home folder swapped for this one's; and a folder of the same name sitting
 * beside a project that has already been located. Anything still missing is
 * left for the user to point at.
 */
export function probeBundle(bundleDir: string): BundleSummary {
  const bundle = readManifest(bundleDir)
  if (!bundle) {
    return { ok: false, error: 'That folder does not contain a Deeproject bundle.' }
  }

  const home = app.getPath('home')
  const projects: PathProbe[] = []
  const resolvedParents = new Set<string>()

  for (const project of bundle.state.projects) {
    let resolved = project.path
    let guessed = false

    if (!existsSync(resolved) && bundle.home && project.path.startsWith(bundle.home)) {
      const swapped = join(home, project.path.slice(bundle.home.length))
      if (existsSync(swapped)) {
        resolved = swapped
        guessed = true
      }
    }

    if (!existsSync(resolved)) {
      const name = basename(project.path)
      for (const parent of resolvedParents) {
        const candidate = join(parent, name)
        if (existsSync(candidate)) {
          resolved = candidate
          guessed = true
          break
        }
      }
    }

    const exists = existsSync(resolved)
    if (exists) resolvedParents.add(dirname(resolved))

    projects.push({
      projectId: project.id,
      name: project.name,
      originalPath: project.path,
      resolvedPath: resolved,
      exists,
      guessed
    })
  }

  return {
    ok: true,
    exportedAt: bundle.exportedAt,
    machine: bundle.machine,
    projects,
    counts: {
      projects: bundle.state.projects.length,
      terminals: bundle.state.terminals.length,
      ideas: bundle.state.ideas.length,
      videos: bundle.state.videos.length,
      images: Object.values(bundle.images).reduce((n, list) => n + list.length, 0)
    }
  }
}

/** Rewrite every stored path that sat under `from` so it sits under `to`. */
function remapProject(project: Project, to: string): Project {
  const from = project.path
  if (from === to) return project
  const roblox = { ...project.roblox }
  if (roblox.placeFile && isAbsolute(roblox.placeFile) && roblox.placeFile.startsWith(from)) {
    roblox.placeFile = join(to, roblox.placeFile.slice(from.length))
  }
  const rojo = { ...project.rojo }
  if (rojo.projectFile && isAbsolute(rojo.projectFile) && rojo.projectFile.startsWith(from)) {
    rojo.projectFile = join(to, rojo.projectFile.slice(from.length))
  }
  return { ...project, path: to, roblox, rojo }
}

export function applyBundle(
  bundleDir: string,
  options: { mode: 'replace' | 'merge'; paths: Record<string, string> }
): { ok: boolean; error?: string; imported?: number; conversations?: number } {
  const bundle = readManifest(bundleDir)
  if (!bundle) return { ok: false, error: 'That folder does not contain a Deeproject bundle.' }

  try {
    const current = loadState()
    const userData = app.getPath('userData')

    // Keep a copy of what was here before overwriting anything.
    const backup = join(userData, `state.before-import-${Date.now()}.json`)
    writeFileSync(backup, JSON.stringify(current, null, 2), 'utf8')

    const incoming: AppState = JSON.parse(JSON.stringify(bundle.state))

    // 1. Relocate projects, and any terminal working directory beneath them.
    const moved = new Map<string, string>()
    incoming.projects = incoming.projects.map((project) => {
      const to = options.paths[project.id] ?? project.path
      if (to !== project.path) moved.set(project.path, to)
      return remapProject(project, to)
    })

    incoming.terminals = incoming.terminals.map((terminal) => {
      for (const [from, to] of moved) {
        if (terminal.cwd === from || terminal.cwd.startsWith(from + '\\')) {
          return { ...terminal, cwd: join(to, terminal.cwd.slice(from.length)) }
        }
      }
      return terminal
    })

    // 2. Bring idea attachments into this machine's store.
    incoming.ideas = incoming.ideas.map((idea: GameIdea) => {
      const names = bundle.images[idea.id]
      if (!names || names.length === 0) return { ...idea, images: [] }
      const dest = join(userData, 'idea-images', idea.id)
      mkdirSync(dest, { recursive: true })
      const restored: string[] = []
      for (const name of names) {
        const source = join(bundleDir, 'images', idea.id, name)
        if (!existsSync(source)) continue
        const target = join(dest, name)
        copyFileSync(source, target)
        restored.push(target)
      }
      return { ...idea, images: restored }
    })

    // 3. Drop Claude's transcripts under the folder name the *new* path encodes,
    //    otherwise `claude --resume` would not find them after a relocation.
    let conversations = 0
    for (const projectId of bundle.conversations ?? []) {
      const source = join(bundleDir, 'claude', projectId)
      if (!existsSync(source)) continue
      const project = incoming.projects.find((p) => p.id === projectId)
      if (!project) continue
      const encoded = encodeProjectPath(project.path)
      // Merge into a folder that already differs only by drive-letter case,
      // rather than creating a second one Claude would never read.
      const target = findTranscriptFolder(encoded) ?? join(claudeProjectsRoot(), encoded)
      // Existing files win: never clobber a conversation already on this machine.
      copyTree(source, target, true)
      conversations++
    }

    // 4. Merge or replace.
    let next: AppState
    if (options.mode === 'merge') {
      const known = new Set(current.projects.map((p) => p.id))
      const knownTerminals = new Set(current.terminals.map((t) => t.id))
      const knownIdeas = new Set(current.ideas.map((i) => i.id))
      const knownVideos = new Set(current.videos.map((v) => v.url))
      next = {
        ...current,
        projects: [...current.projects, ...incoming.projects.filter((p) => !known.has(p.id))],
        terminals: [
          ...current.terminals,
          ...incoming.terminals.filter((t) => !knownTerminals.has(t.id))
        ],
        ideas: [...current.ideas, ...incoming.ideas.filter((i) => !knownIdeas.has(i.id))],
        videos: [...current.videos, ...incoming.videos.filter((v) => !knownVideos.has(v.url))]
      }
    } else {
      next = incoming
      // The layout only makes sense alongside a full replacement.
      if (bundle.layout) saveLayout(bundle.layout)
    }

    saveState(next, true)
    return { ok: true, imported: incoming.projects.length, conversations }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

/** Used by the relocation UI to confirm a folder the user picked. */
export function pathExists(target: string): boolean {
  try {
    return existsSync(target) && statSync(target).isDirectory()
  } catch {
    return false
  }
}
