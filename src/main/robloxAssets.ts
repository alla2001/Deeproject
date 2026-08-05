import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { RobloxCreator, RobloxUploadResult } from '@shared/types'

/**
 * Uploads files to Roblox through Open Cloud.
 *
 * Open Cloud takes a multipart POST and answers with a long-running operation
 * rather than the asset id, so every upload is followed by polling until
 * moderation and processing finish.
 */

const API = 'https://apis.roblox.com/assets/v1'
/** Roblox can take a while on audio and models; give up rather than hang forever. */
const POLL_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 1500
/** Open Cloud rejects very large payloads; fail early with a clear message. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

interface FormatInfo {
  assetType: string
  contentType: string
}

/** Extension → asset type and content type, per Open Cloud's accepted formats. */
const FORMATS: Record<string, FormatInfo> = {
  '.png': { assetType: 'Decal', contentType: 'image/png' },
  '.jpg': { assetType: 'Decal', contentType: 'image/jpeg' },
  '.jpeg': { assetType: 'Decal', contentType: 'image/jpeg' },
  '.bmp': { assetType: 'Decal', contentType: 'image/bmp' },
  '.tga': { assetType: 'Decal', contentType: 'image/tga' },
  '.mp3': { assetType: 'Audio', contentType: 'audio/mpeg' },
  '.ogg': { assetType: 'Audio', contentType: 'audio/ogg' },
  '.wav': { assetType: 'Audio', contentType: 'audio/wav' },
  '.flac': { assetType: 'Audio', contentType: 'audio/flac' },
  '.fbx': { assetType: 'Model', contentType: 'model/fbx' },
  '.gltf': { assetType: 'Model', contentType: 'model/gltf+json' },
  '.glb': { assetType: 'Model', contentType: 'model/gltf-binary' },
  '.rbxm': { assetType: 'Model', contentType: 'model/x-rbxm' },
  '.rbxmx': { assetType: 'Model', contentType: 'model/x-rbxm' },
  '.mp4': { assetType: 'Video', contentType: 'video/mp4' },
  '.mov': { assetType: 'Video', contentType: 'video/mov' }
}

export function uploadableExtensions(): string[] {
  return Object.keys(FORMATS).map((e) => e.slice(1))
}

export function formatFor(filePath: string): FormatInfo | null {
  return FORMATS[extname(filePath).toLowerCase()] ?? null
}

// ---- api key ---------------------------------------------------------------

let keyCache: string | null = null
let keyLoaded = false

function keyPath(): string {
  return join(app.getPath('userData'), 'roblox-key.bin')
}

export function setRobloxApiKey(key: string | null): boolean {
  const file = keyPath()
  keyCache = key && key.trim() ? key.trim() : null
  keyLoaded = true
  try {
    if (!keyCache) {
      if (existsSync(file)) unlinkSync(file)
      return true
    }
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(file, safeStorage.encryptString(keyCache))
    } else {
      writeFileSync(file, Buffer.from(`plain:${keyCache}`, 'utf8'))
    }
    return true
  } catch (err) {
    console.error('[roblox-assets] could not persist key', err)
    return false
  }
}

export function getRobloxApiKey(): string | null {
  if (keyLoaded) return keyCache
  keyLoaded = true
  const file = keyPath()
  try {
    if (!existsSync(file)) {
      keyCache = null
      return null
    }
    const raw = readFileSync(file)
    const asText = raw.toString('utf8')
    keyCache = asText.startsWith('plain:')
      ? asText.slice('plain:'.length)
      : safeStorage.decryptString(raw)
  } catch (err) {
    console.error('[roblox-assets] could not read key', err)
    keyCache = null
  }
  return keyCache
}

export function hasRobloxApiKey(): boolean {
  return Boolean(getRobloxApiKey())
}

/**
 * Open Cloud has no "who am I" endpoint for API keys, so an obviously bogus
 * operation id is requested: a live key gets a 404, a bad one a 401/403.
 */
export async function verifyRobloxApiKey(): Promise<{ ok: boolean; error?: string }> {
  const key = getRobloxApiKey()
  if (!key) return { ok: false, error: 'No API key set.' }
  try {
    const response = await fetch(`${API}/operations/00000000-0000-0000-0000-000000000000`, {
      headers: { 'x-api-key': key }
    })
    if (response.status === 401) {
      return { ok: false, error: 'Roblox rejected the API key. Check it was copied in full.' }
    }
    if (response.status === 403) {
      return {
        ok: false,
        error:
          'The key is valid but lacks permission. Give it the asset write scope and add your user or group under the key’s access.'
      }
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Could not reach Roblox: ${message}` }
  }
}

// ---- upload ----------------------------------------------------------------

function operationIdOf(data: any): string | null {
  if (typeof data?.operationId === 'string') return data.operationId
  const path = typeof data?.path === 'string' ? data.path : ''
  const match = path.match(/operations\/(.+)$/)
  return match ? match[1] : null
}

async function pollOperation(operationId: string, key: string): Promise<RobloxUploadResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const response = await fetch(`${API}/operations/${operationId}`, {
      headers: { 'x-api-key': key }
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : {}

    if (!response.ok) {
      // 404 right after creation just means it has not registered yet.
      if (response.status === 404) continue
      return { ok: false, file: '', error: data?.message ?? `Roblox returned ${response.status}` }
    }

    if (data?.done) {
      const assetId = data?.response?.assetId
      if (assetId) return { ok: true, file: '', assetId: String(assetId) }
      const reason = data?.error?.message ?? 'Roblox finished the upload without returning an asset id.'
      return { ok: false, file: '', error: reason }
    }
  }

  return {
    ok: false,
    file: '',
    error: 'Timed out waiting for Roblox to finish processing. It may still appear in your inventory.'
  }
}

export async function uploadAsset(opts: {
  filePath: string
  creator: RobloxCreator
  displayName?: string
  description?: string
  assetType?: string
}): Promise<RobloxUploadResult> {
  const file = basename(opts.filePath)
  const key = getRobloxApiKey()
  if (!key) {
    return { ok: false, file, error: 'No Roblox API key set. Add one in Settings → Roblox.' }
  }
  if (!opts.creator?.id || !/^\d+$/.test(opts.creator.id)) {
    return {
      ok: false,
      file,
      error: 'Set a numeric creator (your user id, or a group id) in the project’s Roblox tab.'
    }
  }
  if (!existsSync(opts.filePath)) return { ok: false, file, error: `File not found: ${opts.filePath}` }

  const format = formatFor(opts.filePath)
  if (!format) {
    return {
      ok: false,
      file,
      error: `Roblox does not accept ${extname(opts.filePath) || 'that file'}. Supported: ${uploadableExtensions().join(', ')}.`
    }
  }

  const size = statSync(opts.filePath).size
  if (size > MAX_UPLOAD_BYTES) {
    return { ok: false, file, error: `${file} is ${(size / 1024 / 1024).toFixed(1)} MB; too large to upload.` }
  }

  const assetType = opts.assetType ?? format.assetType
  const request = {
    assetType,
    displayName: opts.displayName?.trim() || basename(opts.filePath, extname(opts.filePath)),
    description: opts.description?.trim() || 'Uploaded from Deeproject',
    creationContext: {
      creator:
        opts.creator.type === 'group'
          ? { groupId: opts.creator.id }
          : { userId: opts.creator.id }
    }
  }

  try {
    const form = new FormData()
    form.append('request', JSON.stringify(request))
    form.append(
      'fileContent',
      new Blob([readFileSync(opts.filePath)], { type: format.contentType }),
      file
    )

    // Content-Type is deliberately not set: fetch adds the multipart boundary.
    const response = await fetch(`${API}/assets`, {
      method: 'POST',
      headers: { 'x-api-key': key },
      body: form
    })

    const text = await response.text()
    const data = text ? JSON.parse(text) : {}

    if (!response.ok) {
      const message =
        response.status === 401
          ? 'Roblox rejected the API key.'
          : response.status === 403
            ? 'The API key lacks permission to create assets for that creator.'
            : response.status === 400
              ? (data?.message ?? 'Roblox refused the file.')
              : (data?.message ?? `Roblox returned ${response.status}`)
      return { ok: false, file, assetType, error: message }
    }

    const operationId = operationIdOf(data)
    if (!operationId) {
      const assetId = data?.response?.assetId
      if (assetId) return { ok: true, file, assetType, assetId: String(assetId) }
      return { ok: false, file, assetType, error: 'Roblox did not return an operation to follow.' }
    }

    const result = await pollOperation(operationId, key)
    return { ...result, file, assetType }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, file, assetType, error: `Upload failed: ${message}` }
  }
}
