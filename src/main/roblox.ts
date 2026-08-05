import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { RobloxConfig } from '@shared/types'
import { focusWindowOfProcess, listWindows } from './windows'

/** Place files Rojo/Studio produce, best candidate first. */
export function findPlaceFiles(projectPath: string): string[] {
  try {
    return readdirSync(projectPath, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.rbxlx?$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * Locate Studio. Roblox installs each build into its own version folder and
 * leaves older ones behind, so the newest is the one to run.
 */
export function findStudioExe(): string | null {
  const roots = [
    join(process.env.LOCALAPPDATA ?? '', 'Roblox', 'Versions'),
    join(process.env.ProgramFiles ?? '', 'Roblox', 'Versions'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'Roblox', 'Versions')
  ].filter((p) => p && existsSync(p))

  let best: { path: string; mtime: number } | null = null
  for (const root of roots) {
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const candidate = join(root, entry, 'RobloxStudioBeta.exe')
      try {
        if (!existsSync(candidate)) continue
        const mtime = statSync(candidate).mtimeMs
        if (!best || mtime > best.mtime) best = { path: candidate, mtime }
      } catch {
        // Unreadable version folder; skip it.
      }
    }
  }
  return best?.path ?? null
}

/**
 * Studio needs the universe that owns a place, not just the place id. This
 * public endpoint maps one to the other; it returns null for places that are
 * private, unpublished or deleted.
 */
export async function lookupUniverseId(placeId: string): Promise<number | null> {
  if (!/^\d+$/.test(placeId)) return null
  try {
    const response = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)
    if (!response.ok) return null
    const data = (await response.json()) as { universeId?: number | null }
    return typeof data.universeId === 'number' ? data.universeId : null
  } catch {
    return null
  }
}

/** Experience name for a universe, used to recognise its Studio window. */
export async function lookupUniverseName(universeId: string): Promise<string | null> {
  if (!/^\d+$/.test(universeId)) return null
  try {
    const response = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`)
    if (!response.ok) return null
    const data = (await response.json()) as { data?: { name?: string }[] }
    return data.data?.[0]?.name ?? null
  } catch {
    return null
  }
}

/** Studio instances this app started, so they can be re-focused rather than duplicated. */
const launched = new Map<string, number>()

/**
 * Find an already-open Studio window for this project.
 *
 * The process we spawned is the most reliable handle, so it is checked first.
 * Failing that — Studio opened by hand, or a previous run of this app — the
 * window title is matched against the place name, since Studio titles its
 * windows after the place being edited.
 */
async function findOpenStudio(
  projectId: string,
  hints: string[]
): Promise<{ pid: number; title: string } | null> {
  const windows = await listWindows('RobloxStudioBeta')
  if (windows.length === 0) {
    launched.delete(projectId)
    return null
  }

  const remembered = launched.get(projectId)
  if (remembered) {
    const match = windows.find((w) => w.pid === remembered)
    if (match) return match
    launched.delete(projectId)
  }

  const needles = hints.map((h) => h.trim().toLowerCase()).filter(Boolean)
  for (const window of windows) {
    const title = window.title.toLowerCase()
    if (needles.some((needle) => title.includes(needle))) return window
  }
  return null
}

/**
 * Open a project in Roblox Studio.
 *
 * A cloud place is launched through Studio's documented command line
 * (`--task EditPlace --placeId .. --universeId ..`). The universe id is not
 * optional: without it Studio reports "could not open the place [0]". A local
 * file is handed to the shell, which routes .rbxl/.rbxlx to Studio via the
 * normal file association.
 */
export async function openInStudio(
  projectPath: string,
  config: RobloxConfig,
  projectId = 'default'
): Promise<{ ok: boolean; error?: string; universeId?: number; focused?: boolean; placeName?: string }> {
  const placeId = config.placeId?.trim()

  // Re-focusing beats opening a second copy of the same place.
  const hints = [config.placeName ?? '', basename(config.placeFile ?? '', extname(config.placeFile ?? ''))]
  const existing = await findOpenStudio(projectId, hints)
  if (existing) {
    const focused = await focusWindowOfProcess(existing.pid)
    return focused
      ? { ok: true, focused: true }
      : { ok: false, error: `Roblox Studio is already open ("${existing.title}") but would not come to the front.` }
  }

  if (placeId) {
    if (!/^\d+$/.test(placeId)) {
      return { ok: false, error: 'Place ID must be numeric.' }
    }

    let universeId = config.universeId?.trim()
    if (universeId && !/^\d+$/.test(universeId)) {
      return { ok: false, error: 'Universe ID must be numeric.' }
    }

    let resolved: number | null = null
    if (!universeId) {
      resolved = await lookupUniverseId(placeId)
      if (resolved === null) {
        return {
          ok: false,
          error:
            `Could not find the universe for place ${placeId}. Roblox only resolves this for ` +
            'published places you can reach — if the place is private or unlisted, open it on ' +
            'the Roblox site and copy the universe (experience) ID into the Universe ID field.'
        }
      }
      universeId = String(resolved)
    }

    const exe = findStudioExe()
    if (!exe) {
      // No install found; fall back to the protocol handler.
      const url = [
        'roblox-studio:1',
        'launchmode:edit',
        'task:EditPlace',
        `placeId:${placeId}`,
        `universeId:${universeId}`
      ].join('+')
      try {
        await shell.openExternal(url)
        return { ok: true, universeId: resolved ?? undefined }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `Roblox Studio was not found: ${message}` }
      }
    }

    try {
      const child = spawn(
        exe,
        ['--task', 'EditPlace', '--placeId', placeId, '--universeId', universeId],
        { detached: true, stdio: 'ignore' }
      )
      child.unref()
      if (child.pid) launched.set(projectId, child.pid)
      // Cache the experience name so a later launch can spot this window even
      // after the app restarts and the remembered pid is gone.
      const placeName = config.placeName ?? (await lookupUniverseName(universeId)) ?? undefined
      return { ok: true, universeId: resolved ?? undefined, placeName }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Could not launch Studio: ${message}` }
    }
  }

  const file = config.placeFile?.trim()
  if (!file) {
    return { ok: false, error: 'No place file or place ID is linked to this project yet.' }
  }

  const resolvedPath = isAbsolute(file) ? file : join(projectPath, file)
  if (!existsSync(resolvedPath)) {
    return { ok: false, error: `Place file not found: ${resolvedPath}` }
  }

  const failure = await shell.openPath(resolvedPath)
  if (failure) return { ok: false, error: failure }
  return { ok: true }
}
