import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  NotionBoard,
  NotionField,
  NotionOption,
  NotionTask,
  NotionTaskPatch
} from '@shared/types'

const API = 'https://api.notion.com/v1'
/** Pinned: this version's database/page shapes are what the mapping below expects. */
const NOTION_VERSION = '2022-06-28'

let tokenCache: string | null = null
let tokenLoaded = false

function tokenPath(): string {
  return join(app.getPath('userData'), 'notion-token.bin')
}

/**
 * The token is written through Electron's safeStorage (DPAPI on Windows) so it
 * is not sitting in plaintext next to the rest of the config.
 */
export function setNotionToken(token: string | null): boolean {
  const file = tokenPath()
  tokenCache = token && token.trim() ? token.trim() : null
  tokenLoaded = true
  try {
    if (!tokenCache) {
      if (existsSync(file)) unlinkSync(file)
      return true
    }
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(file, safeStorage.encryptString(tokenCache))
    } else {
      // Better to store it than to silently drop the user's token.
      writeFileSync(file, Buffer.from(`plain:${tokenCache}`, 'utf8'))
    }
    return true
  } catch (err) {
    console.error('[notion] could not persist token', err)
    return false
  }
}

export function getNotionToken(): string | null {
  if (tokenLoaded) return tokenCache
  tokenLoaded = true
  const file = tokenPath()
  try {
    if (!existsSync(file)) {
      tokenCache = null
      return null
    }
    const raw = readFileSync(file)
    const asText = raw.toString('utf8')
    if (asText.startsWith('plain:')) {
      tokenCache = asText.slice('plain:'.length)
    } else {
      tokenCache = safeStorage.decryptString(raw)
    }
  } catch (err) {
    console.error('[notion] could not read token', err)
    tokenCache = null
  }
  return tokenCache
}

export function hasNotionToken(): boolean {
  return Boolean(getNotionToken())
}

/**
 * Accepts a full Notion URL or a bare id and returns the canonical dashed uuid.
 * Notion URLs look like `.../Some-Page-<32 hex>?v=<32 hex>`; the id we want is
 * the last 32-hex run in the path, never the `?v=` view id.
 */
export function extractNotionId(input: string): string | null {
  const value = input.trim()
  if (!value) return null

  let path = value
  try {
    if (/^https?:\/\//i.test(value)) path = new URL(value).pathname
  } catch {
    // Not a URL; fall through and scan the raw string.
  }

  const matches = path.match(/[0-9a-f]{32}/gi)
  const hex = matches ? matches[matches.length - 1] : null
  if (hex) return dash(hex.toLowerCase())

  const dashed = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return dashed ? dashed[0].toLowerCase() : null
}

function dash(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

interface NotionError {
  message: string
  status?: number
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: true; data: T } | { ok: false; error: NotionError }> {
  const token = getNotionToken()
  if (!token) {
    return { ok: false, error: { message: 'No Notion token set. Add one in Settings → Notion.' } }
  }

  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })

    const text = await response.text()
    const parsed = text ? JSON.parse(text) : {}

    if (!response.ok) {
      const message =
        response.status === 401
          ? 'Notion rejected the token. Check it in Settings → Notion.'
          : response.status === 404
            ? 'Not found. Share the page or database with your integration in Notion (••• → Connections).'
            : (parsed?.message ?? `Notion returned ${response.status}`)
      return { ok: false, error: { message, status: response.status } }
    }
    return { ok: true, data: parsed as T }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: { message: `Could not reach Notion: ${message}` } }
  }
}

// ---- shape helpers ---------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

function plainText(rich: any[] | undefined): string {
  if (!Array.isArray(rich)) return ''
  return rich.map((r) => r?.plain_text ?? '').join('')
}

function findPropByType(props: Record<string, any>, type: string): string | null {
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value?.type === type) return name
  }
  return null
}

interface DatabaseShape {
  titleProp: string | null
  checkboxProp: string | null
  statusProp: string | null
  statusType: 'status' | 'select' | null
  statusOptions: string[]
  /** Status value treated as "done" when there is no checkbox. */
  doneValues: Set<string>
  /** Every status/select/multi-select column, in Notion's own order. */
  fields: NotionField[]
}

const DONE_WORDS = ['done', 'complete', 'completed', 'finished', 'shipped', 'closed']

function optionsOf(prop: any, type: 'status' | 'select' | 'multi_select'): NotionOption[] {
  const raw = prop?.[type]?.options ?? []
  return raw
    .filter((o: any) => o?.name)
    .map((o: any) => ({ name: o.name as string, color: (o.color as string) ?? 'default' }))
}

function readDatabaseShape(db: any): DatabaseShape {
  const props: Record<string, any> = db?.properties ?? {}

  // Every select-ish column becomes an editable field, so a board with
  // Status / Priority / Type shows all three rather than just the first.
  const fields: NotionField[] = []
  for (const [name, prop] of Object.entries(props)) {
    const type = prop?.type
    if (type === 'status' || type === 'select' || type === 'multi_select') {
      fields.push({ name, type, options: optionsOf(prop, type) })
    }
  }

  const statusProp = findPropByType(props, 'status') ?? findPropByType(props, 'select')
  const statusType = statusProp ? (props[statusProp].type as 'status' | 'select') : null
  const statusOptions = statusProp && statusType ? optionsOf(props[statusProp], statusType).map((o) => o.name) : []

  const doneValues = new Set<string>()
  for (const option of statusOptions) {
    if (DONE_WORDS.includes(option.trim().toLowerCase())) doneValues.add(option)
  }
  // Notion's native Status property groups options; the "Complete" group is
  // authoritative when it is present.
  if (statusProp && statusType === 'status') {
    const groups = props[statusProp].status?.groups ?? []
    const complete = groups.find((g: any) => g?.name?.toLowerCase() === 'complete')
    if (complete) {
      const ids: string[] = complete.option_ids ?? []
      for (const option of props[statusProp].status?.options ?? []) {
        if (ids.includes(option.id)) doneValues.add(option.name)
      }
    }
  }

  return {
    titleProp: findPropByType(props, 'title'),
    checkboxProp: findPropByType(props, 'checkbox'),
    statusProp,
    statusType,
    statusOptions,
    doneValues,
    fields
  }
}

/** Selected option names for one property, whatever its cardinality. */
function readValues(prop: any): string[] {
  if (!prop) return []
  if (prop.type === 'multi_select') {
    return (prop.multi_select ?? []).map((o: any) => o?.name).filter(Boolean)
  }
  if (prop.type === 'status' || prop.type === 'select') {
    const name = prop[prop.type]?.name
    return name ? [name] : []
  }
  return []
}

function pageToTask(page: any, shape: DatabaseShape): NotionTask {
  const props = page?.properties ?? {}
  const title = shape.titleProp ? plainText(props[shape.titleProp]?.title) : ''

  const values: Record<string, string[]> = {}
  for (const field of shape.fields) {
    values[field.name] = readValues(props[field.name])
  }

  const status = shape.statusProp ? (values[shape.statusProp]?.[0] ?? null) : null

  let done = false
  if (shape.checkboxProp) done = Boolean(props[shape.checkboxProp]?.checkbox)
  else if (status) done = shape.doneValues.has(status)

  return {
    id: page.id,
    title: title || 'Untitled',
    done,
    status,
    url: page.url ?? null,
    lastEdited: page.last_edited_time ? Date.parse(page.last_edited_time) : null,
    values
  }
}

function blockToTask(block: any): NotionTask {
  return {
    id: block.id,
    title: plainText(block?.to_do?.rich_text) || 'Untitled',
    done: Boolean(block?.to_do?.checked),
    status: null,
    url: null,
    lastEdited: block.last_edited_time ? Date.parse(block.last_edited_time) : null,
    values: {}
  }
}

// ---- public surface --------------------------------------------------------

const shapeCache = new Map<string, DatabaseShape>()

/** Figure out whether an id points at a database or an ordinary page. */
export async function resolveTarget(
  target: string
): Promise<{ ok: true; kind: 'database' | 'page'; id: string } | { ok: false; error: string }> {
  const id = extractNotionId(target)
  if (!id) return { ok: false, error: 'That does not look like a Notion link or id.' }

  const asDatabase = await request<any>('GET', `/databases/${id}`)
  if (asDatabase.ok) return { ok: true, kind: 'database', id }

  const asPage = await request<any>('GET', `/pages/${id}`)
  if (asPage.ok) return { ok: true, kind: 'page', id }

  return { ok: false, error: asPage.error.message }
}

/**
 * Development aid: `DEEPROJECT_NOTION_FIXTURE=1` serves a canned board instead
 * of calling Notion, so the task table can be worked on without a token or a
 * live workspace. Never set in a packaged run.
 */
function fixtureBoard(): NotionBoard {
  const fields: NotionField[] = [
    {
      name: 'Status',
      type: 'status',
      options: [
        { name: 'Not started', color: 'default' },
        { name: 'Under Review', color: 'yellow' },
        { name: 'Done', color: 'green' }
      ]
    },
    {
      name: 'Priority',
      type: 'select',
      options: [
        { name: 'High', color: 'red' },
        { name: 'Med', color: 'yellow' },
        { name: 'Low', color: 'green' }
      ]
    },
    {
      name: 'Type',
      type: 'select',
      options: [
        { name: 'Bug', color: 'red' },
        { name: 'Polish', color: 'green' },
        { name: 'Feature', color: 'purple' }
      ]
    },
    {
      name: 'Platform',
      type: 'multi_select',
      options: [
        { name: 'PC', color: 'blue' },
        { name: 'Mobile', color: 'orange' }
      ]
    },
    {
      name: 'Version',
      type: 'select',
      options: [
        { name: '0.8.5', color: 'blue' },
        { name: '0.8.6', color: 'purple' },
        { name: '0.8R', color: 'pink' },
        { name: '0.9', color: 'orange' }
      ]
    }
  ]

  const rows: [string, string, string, string, string[], string][] = [
    ['Player avatars stay invisible after a multiplayer coop session', 'Under Review', 'Med', 'Bug', ['PC'], '0.8.5'],
    ['Job Card Visual improvements', 'Under Review', 'Med', 'Polish', [], '0.8.6'],
    ['when you spend a skill point, the skill point menu flashes', 'Under Review', 'Low', 'Bug', [], '0.8.6'],
    ['[Audio] Adjust footstep SFX based on what player is stepping on', 'Under Review', 'Med', 'Polish', [], '0.8R'],
    ['People reporting Jorny’s set is messed up', 'Under Review', 'High', 'Bug', [], '0.8R'],
    ['Submit Job text can not fit in a capsule', 'Not started', 'Med', 'Bug', ['Mobile'], '0.8R'],
    ['Relaunch under a new experience', 'Not started', '', '', [], '0.8R'],
    ['[EPIC] [Personal Office] Player’s have a “personal office” space', 'Not started', 'High', 'Feature', [], '0.9'],
    ['First Pass Tool Variants', 'Done', 'Med', 'Feature', [], '0.9']
  ]

  return {
    ok: true,
    kind: 'database',
    title: 'CCS Tasks (fixture)',
    statusOptions: ['Not started', 'Under Review', 'Done'],
    fields,
    error: null,
    tasks: rows.map(([title, status, priority, type, platform, version], i) => ({
      id: `fixture-${i}`,
      title,
      done: status === 'Done',
      status: status || null,
      url: null,
      lastEdited: null,
      values: {
        Status: status ? [status] : [],
        Priority: priority ? [priority] : [],
        Type: type ? [type] : [],
        Platform: platform,
        Version: version ? [version] : []
      }
    }))
  }
}

export async function listTasks(target: string): Promise<NotionBoard> {
  if (process.env.DEEPROJECT_NOTION_FIXTURE === '1') return fixtureBoard()

  const empty: NotionBoard = {
    ok: false,
    kind: null,
    title: null,
    tasks: [],
    statusOptions: [],
    fields: [],
    error: null
  }

  const resolved = await resolveTarget(target)
  if (!resolved.ok) return { ...empty, error: resolved.error }

  if (resolved.kind === 'database') {
    const db = await request<any>('GET', `/databases/${resolved.id}`)
    if (!db.ok) return { ...empty, error: db.error.message }
    const shape = readDatabaseShape(db.data)
    shapeCache.set(resolved.id, shape)

    // Boards outgrow one page quickly; walk the cursor so nothing is hidden.
    const results: any[] = []
    let cursor: string | undefined
    do {
      const query = await request<any>('POST', `/databases/${resolved.id}/query`, {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {})
      })
      if (!query.ok) return { ...empty, kind: 'database', error: query.error.message }
      results.push(...(query.data?.results ?? []))
      cursor = query.data?.has_more ? query.data?.next_cursor : undefined
    } while (cursor && results.length < 1000)

    return {
      ok: true,
      kind: 'database',
      title: plainText(db.data?.title) || 'Tasks',
      tasks: results.map((p: any) => pageToTask(p, shape)),
      statusOptions: shape.statusOptions,
      fields: shape.fields,
      error: null
    }
  }

  const page = await request<any>('GET', `/pages/${resolved.id}`)
  const children = await request<any>('GET', `/blocks/${resolved.id}/children?page_size=100`)
  if (!children.ok) return { ...empty, kind: 'page', error: children.error.message }

  const todos = (children.data?.results ?? []).filter((b: any) => b?.type === 'to_do')
  let title = 'Tasks'
  if (page.ok) {
    const props: Record<string, any> = page.data?.properties ?? {}
    const titleProp = findPropByType(props, 'title')
    if (titleProp) title = plainText(props[titleProp]?.title) || title
  }

  return {
    ok: true,
    kind: 'page',
    title,
    tasks: todos.map(blockToTask),
    statusOptions: [],
    fields: [],
    error: null
  }
}

export async function createTask(
  target: string,
  title: string
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveTarget(target)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  if (resolved.kind === 'database') {
    let shape = shapeCache.get(resolved.id)
    if (!shape) {
      const db = await request<any>('GET', `/databases/${resolved.id}`)
      if (!db.ok) return { ok: false, error: db.error.message }
      shape = readDatabaseShape(db.data)
      shapeCache.set(resolved.id, shape)
    }
    if (!shape.titleProp) return { ok: false, error: 'That database has no title property.' }

    const result = await request('POST', '/pages', {
      parent: { database_id: resolved.id },
      properties: {
        [shape.titleProp]: { title: [{ type: 'text', text: { content: title } }] }
      }
    })
    return result.ok ? { ok: true } : { ok: false, error: result.error.message }
  }

  const result = await request('PATCH', `/blocks/${resolved.id}/children`, {
    children: [
      {
        object: 'block',
        type: 'to_do',
        to_do: { rich_text: [{ type: 'text', text: { content: title } }], checked: false }
      }
    ]
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error.message }
}

export async function updateTask(
  target: string,
  taskId: string,
  patch: NotionTaskPatch
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveTarget(target)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  if (resolved.kind === 'page') {
    // Tasks on a plain page are to_do blocks, patched directly.
    const body: any = { to_do: {} }
    if (patch.done !== undefined) body.to_do.checked = patch.done
    if (patch.title !== undefined) {
      body.to_do.rich_text = [{ type: 'text', text: { content: patch.title } }]
    }
    const result = await request('PATCH', `/blocks/${taskId}`, body)
    return result.ok ? { ok: true } : { ok: false, error: result.error.message }
  }

  let shape = shapeCache.get(resolved.id)
  if (!shape) {
    const db = await request<any>('GET', `/databases/${resolved.id}`)
    if (!db.ok) return { ok: false, error: db.error.message }
    shape = readDatabaseShape(db.data)
    shapeCache.set(resolved.id, shape)
  }

  const properties: Record<string, unknown> = {}
  if (patch.title !== undefined && shape.titleProp) {
    properties[shape.titleProp] = { title: [{ type: 'text', text: { content: patch.title } }] }
  }
  if (patch.status !== undefined && shape.statusProp && shape.statusType) {
    properties[shape.statusProp] = { [shape.statusType]: { name: patch.status } }
  }
  // Arbitrary select-ish columns: Priority, Type, a version tag, and so on.
  for (const [name, chosen] of Object.entries(patch.values ?? {})) {
    const field = shape.fields.find((f) => f.name === name)
    if (!field) continue
    if (field.type === 'multi_select') {
      properties[name] = { multi_select: chosen.map((value) => ({ name: value })) }
    } else {
      // Clearing a single-valued property means sending null, not an empty name.
      properties[name] = { [field.type]: chosen[0] ? { name: chosen[0] } : null }
    }
  }
  if (patch.done !== undefined) {
    if (shape.checkboxProp) {
      properties[shape.checkboxProp] = { checkbox: patch.done }
    } else if (shape.statusProp && shape.statusType && shape.statusOptions.length > 0) {
      // No checkbox: fall back to moving the status to a done/not-done option.
      const done = [...shape.doneValues][0] ?? shape.statusOptions[shape.statusOptions.length - 1]
      const notDone = shape.statusOptions.find((o) => !shape.doneValues.has(o))
      const next = patch.done ? done : notDone
      if (next) properties[shape.statusProp] = { [shape.statusType]: { name: next } }
    }
  }

  if (Object.keys(properties).length === 0) {
    return { ok: false, error: 'Nothing on this database can represent that change.' }
  }

  const result = await request('PATCH', `/pages/${taskId}`, { properties })
  return result.ok ? { ok: true } : { ok: false, error: result.error.message }
}

export async function deleteTask(
  target: string,
  taskId: string
): Promise<{ ok: boolean; error?: string }> {
  const resolved = await resolveTarget(target)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  const result =
    resolved.kind === 'database'
      ? await request('PATCH', `/pages/${taskId}`, { archived: true })
      : await request('DELETE', `/blocks/${taskId}`)

  return result.ok ? { ok: true } : { ok: false, error: result.error.message }
}

/** Cheap credential check used by the settings screen. */
export async function verifyToken(): Promise<{ ok: boolean; user?: string; error?: string }> {
  const result = await request<any>('GET', '/users/me')
  if (!result.ok) return { ok: false, error: result.error.message }
  const name = result.data?.name ?? result.data?.bot?.owner?.user?.name ?? 'integration'
  return { ok: true, user: name }
}
