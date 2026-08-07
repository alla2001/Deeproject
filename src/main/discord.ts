import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DiscordBoard, DiscordPost, DiscordTag } from '@shared/types'

/**
 * Reads a Discord forum channel — the shape people use as a bug tracker: one
 * thread per report, tagged with severity and state.
 *
 * This needs a bot token; Discord has no read-only public API for guild content
 * and using a personal account token is against their terms. The bot only needs
 * View Channel / Read Message History, plus Manage Threads if you want to
 * retag posts from here.
 */

const API = 'https://discord.com/api/v10'

let tokenCache: string | null = null
let tokenLoaded = false

function tokenPath(): string {
  return join(app.getPath('userData'), 'discord-token.bin')
}

export function setDiscordToken(token: string | null): boolean {
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
      writeFileSync(file, Buffer.from(`plain:${tokenCache}`, 'utf8'))
    }
    return true
  } catch (err) {
    console.error('[discord] could not persist token', err)
    return false
  }
}

export function getDiscordToken(): string | null {
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
    tokenCache = asText.startsWith('plain:')
      ? asText.slice('plain:'.length)
      : safeStorage.decryptString(raw)
  } catch (err) {
    console.error('[discord] could not read token', err)
    tokenCache = null
  }
  return tokenCache
}

export function hasDiscordToken(): boolean {
  return Boolean(getDiscordToken())
}

/**
 * Accepts a channel id or any Discord URL containing one.
 * Channel links look like /channels/<guild>/<channel>[/<message>].
 */
export function extractChannelId(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  if (/^\d{15,25}$/.test(value)) return value
  const match = value.match(/channels\/(\d+)\/(\d+)/)
  if (match) return match[2]
  const loose = value.match(/\d{15,25}/)
  return loose ? loose[0] : null
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: true; data: T } | { ok: false; error: string; status?: number }> {
  const token = getDiscordToken()
  if (!token) {
    return { ok: false, error: 'No Discord bot token set. Add one in Settings → Discord.' }
  }

  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })

    if (response.status === 429) {
      const retry = response.headers.get('retry-after') ?? '?'
      return { ok: false, error: `Discord rate limited this request (retry in ${retry}s).`, status: 429 }
    }

    const text = await response.text()
    const parsed = text ? JSON.parse(text) : {}

    if (!response.ok) {
      const message =
        response.status === 401
          ? 'Discord rejected the bot token. Check it in Settings → Discord.'
          : response.status === 403
            ? 'The bot cannot see that channel. Invite it to the server and give it View Channel + Read Message History.'
            : response.status === 404
              ? 'Channel not found. Check the forum channel link or id.'
              : (parsed?.message ?? `Discord returned ${response.status}`)
      return { ok: false, error: message, status: response.status }
    }
    return { ok: true, data: parsed as T }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Could not reach Discord: ${message}` }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Discord channel type 15 is a forum, 16 a media channel. */
const FORUM_TYPES = new Set([15, 16])

function readTags(channel: any): DiscordTag[] {
  return (channel?.available_tags ?? []).map((tag: any) => ({
    id: String(tag.id),
    name: String(tag.name ?? ''),
    emoji: tag.emoji_name ?? null
  }))
}

function threadToPost(thread: any, starter: any | null, tags: DiscordTag[]): DiscordPost {
  const applied: string[] = (thread.applied_tags ?? []).map((id: any) => String(id))
  return {
    id: String(thread.id),
    title: String(thread.name ?? 'Untitled'),
    tags: applied
      .map((id) => tags.find((t) => t.id === id)?.name)
      .filter((name): name is string => Boolean(name)),
    tagIds: applied,
    excerpt: starter?.content ? String(starter.content).slice(0, 400) : '',
    author: starter?.author?.global_name ?? starter?.author?.username ?? null,
    messageCount: Number(thread.message_count ?? 0),
    createdAt: thread.thread_metadata?.create_timestamp
      ? Date.parse(thread.thread_metadata.create_timestamp)
      : null,
    archived: Boolean(thread.thread_metadata?.archived),
    url: thread.guild_id
      ? `https://discord.com/channels/${thread.guild_id}/${thread.id}`
      : null,
    /** First image attached to the opening post, if any. */
    image:
      (starter?.attachments ?? []).find((a: any) => (a?.content_type ?? '').startsWith('image/'))
        ?.url ?? null
  }
}

/**
 * Development aid, matching notion.ts: `DEEPROJECT_DISCORD_FIXTURE=1` serves a
 * canned forum so the panel can be worked on without a bot token.
 */
function fixtureBoard(): DiscordBoard {
  const tags: DiscordTag[] = [
    { id: '1', name: 'critical', emoji: '🟥' },
    { id: '2', name: 'major', emoji: '🔧' },
    { id: '3', name: 'minor', emoji: '⚠️' },
    { id: '4', name: 'open', emoji: '📬' },
    { id: '5', name: 'fixed', emoji: '✅' },
    { id: '6', name: 'cant-repro', emoji: '🤔' },
    { id: '7', name: 'wont-fix', emoji: '❌' },
    { id: '8', name: 'carpet', emoji: '🧹' },
    { id: '9', name: 'drain', emoji: '💧' }
  ]

  const rows: [string, string[], string, string, number, number, boolean][] = [
    ['The Music mute ui', ['3', '9'], 'It Doesn’t Do anythin', 'Altim8te', 0, 16, false],
    ['Ui Bug Mobile', ['2', '9'], 'I cant Place generator Instead It Say Dig Mud', 'Altim8te', 2, 16, false],
    ['Feedback Ui Mistake', ['3', '8', '9'], 'The Ui Comes Behind Setings', 'Altim8te', 0, 16, false],
    [
      'The Other Player Cant Do Anything In My Lobby',
      ['9', '1'],
      'Device Pc Username: Slam3_shady GAME: Carpet SEVERITY: critical Bug Description: They Can’t Remove Mud And The Mud Isn’t Removed From Their Screen',
      'Altim8te',
      6,
      16,
      false
    ],
    [
      'invisible mud',
      ['3', '9'],
      'The Mud Is Being Shown To My Alt Acc Not To My Main On pc',
      'Altim8te',
      0,
      16,
      false
    ],
    [
      'Reseting Tutorial Gave Me More Things',
      ['9', '1'],
      'Tutorial resting gives us everything mid game. Steps: 1) load any map 2) open settings 3) hit reset tutorial',
      'Altim8te',
      0,
      16,
      false
    ],
    ['Old crash on join', ['5', '8'], 'Fixed in 0.8.5.', 'RAKIK Alla-Eddine', 3, 240, true]
  ]

  return {
    ok: true,
    channelName: '#bug-tracker (fixture)',
    tags,
    error: null,
    posts: rows.map(([title, tagIds, excerpt, author, messageCount, hoursAgo, archived], i) => ({
      id: `fixture-${i}`,
      title,
      tagIds,
      tags: tagIds.map((id) => tags.find((t) => t.id === id)?.name ?? id),
      excerpt,
      author,
      messageCount,
      createdAt: Date.now() - hoursAgo * 3600 * 1000,
      archived,
      url: null,
      image: null
    }))
  }
}

export async function listPosts(channelRef: string, includeArchived = true): Promise<DiscordBoard> {
  if (process.env.DEEPROJECT_DISCORD_FIXTURE === '1') {
    const board = fixtureBoard()
    return includeArchived ? board : { ...board, posts: board.posts.filter((p) => !p.archived) }
  }

  const empty: DiscordBoard = {
    ok: false,
    channelName: null,
    tags: [],
    posts: [],
    error: null
  }

  const channelId = extractChannelId(channelRef)
  if (!channelId) return { ...empty, error: 'That does not look like a Discord channel link or id.' }

  const channel = await request<any>('GET', `/channels/${channelId}`)
  if (!channel.ok) return { ...empty, error: channel.error }
  if (!FORUM_TYPES.has(Number(channel.data?.type))) {
    return { ...empty, error: 'That channel is not a forum. Link the forum channel itself.' }
  }

  const tags = readTags(channel.data)
  const guildId = channel.data?.guild_id
  const threads: any[] = []

  // Active threads come from the guild endpoint and must be filtered by parent.
  if (guildId) {
    const active = await request<any>('GET', `/guilds/${guildId}/threads/active`)
    if (active.ok) {
      threads.push(
        ...(active.data?.threads ?? []).filter((t: any) => String(t.parent_id) === channelId)
      )
    }
  }

  if (includeArchived) {
    const archived = await request<any>(
      'GET',
      `/channels/${channelId}/threads/archived/public?limit=100`
    )
    if (archived.ok) threads.push(...(archived.data?.threads ?? []))
  }

  // A forum post's opening message shares the thread's id.
  const starters = await Promise.all(
    threads.slice(0, 60).map(async (thread) => {
      const message = await request<any>('GET', `/channels/${thread.id}/messages/${thread.id}`)
      return message.ok ? message.data : null
    })
  )

  const posts = threads.map((thread, i) =>
    threadToPost({ ...thread, guild_id: thread.guild_id ?? guildId }, starters[i] ?? null, tags)
  )
  posts.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))

  return {
    ok: true,
    channelName: channel.data?.name ? `#${channel.data.name}` : null,
    tags,
    posts,
    error: null
  }
}

/**
 * One report in full: the opening message plus the discussion under it. The
 * board view only carries a short excerpt, which is rarely enough to act on.
 */
export async function getPost(
  postId: string,
  replyLimit = 30
): Promise<
  | { ok: true; title: string; body: string; author: string | null; attachments: string[]; replies: { author: string; content: string; at: number | null }[] }
  | { ok: false; error: string }
> {
  if (process.env.DEEPROJECT_DISCORD_FIXTURE === '1') {
    const post = fixtureBoard().posts.find((p) => p.id === postId)
    return {
      ok: true,
      title: post?.title ?? 'Fixture report',
      body:
        (post?.excerpt ?? '') +
        '\n\nSteps to Reproduce:\n1) load any map\n2) open settings\n3) hit reset tutorial\n\nFrequency: always\nDevice: PC',
      author: post?.author ?? 'Altim8te',
      attachments: [],
      replies: [
        { author: 'RAKIK Alla-Eddine', content: 'Can you share a clip?', at: Date.now() - 3600_000 },
        { author: 'Altim8te', content: 'added above, happens every run', at: Date.now() - 1800_000 }
      ]
    }
  }

  const thread = await request<any>('GET', `/channels/${postId}`)
  if (!thread.ok) return { ok: false, error: thread.error }

  const starter = await request<any>('GET', `/channels/${postId}/messages/${postId}`)
  const messages = await request<any>(
    'GET',
    `/channels/${postId}/messages?limit=${Math.min(100, Math.max(1, replyLimit))}`
  )

  const replies = messages.ok
    ? (messages.data as any[])
        // The opening post comes back in this list too; it is reported separately.
        .filter((m) => String(m.id) !== String(postId))
        .reverse()
        .map((m) => ({
          author: m.author?.global_name ?? m.author?.username ?? 'unknown',
          content: String(m.content ?? ''),
          at: m.timestamp ? Date.parse(m.timestamp) : null
        }))
    : []

  return {
    ok: true,
    title: String(thread.data?.name ?? ''),
    body: starter.ok ? String(starter.data?.content ?? '') : '',
    author: starter.ok
      ? (starter.data?.author?.global_name ?? starter.data?.author?.username ?? null)
      : null,
    attachments: starter.ok
      ? (starter.data?.attachments ?? []).map((a: any) => String(a?.url)).filter(Boolean)
      : [],
    replies
  }
}

/**
 * Resolve tag names to Discord's opaque ids, refusing the whole set if any name
 * is unrecognised. Partially applying tags would leave a report looking
 * classified when it is not.
 */
async function resolveTagNames(
  channelId: string,
  tagNames: string[]
): Promise<{ ok: true; ids: string[]; all: DiscordTag[] } | { ok: false; error: string }> {
  const channel = await request<any>('GET', `/channels/${channelId}`)
  if (!channel.ok) return { ok: false, error: channel.error }
  const tags = readTags(channel.data)

  const ids: string[] = []
  const unknown: string[] = []
  for (const name of tagNames) {
    const match = tags.find((t) => t.name.toLowerCase() === name.trim().toLowerCase())
    if (match) {
      if (!ids.includes(match.id)) ids.push(match.id)
    } else unknown.push(name)
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `No such tag: ${unknown.join(', ')}. Available: ${tags.map((t) => t.name).join(', ')}`
    }
  }
  return { ok: true, ids, all: tags }
}

/** Retag a post using tag names rather than Discord's opaque ids. */
export async function setPostTagsByName(
  channelRef: string,
  postId: string,
  tagNames: string[]
): Promise<{ ok: boolean; error?: string }> {
  const channelId = extractChannelId(channelRef)
  if (!channelId) return { ok: false, error: 'This project has no valid forum channel linked.' }
  const resolved = await resolveTagNames(channelId, tagNames)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  return setPostTags(postId, resolved.ids)
}

/**
 * Adjust a post's tags without having to restate the ones already on it, which
 * is what "tag this fixed" actually means and what a full replacement gets
 * wrong. Returns the resulting tag names.
 */
export async function amendPostTags(
  channelRef: string,
  postId: string,
  add: string[],
  remove: string[]
): Promise<{ ok: boolean; error?: string; tags?: string[] }> {
  const channelId = extractChannelId(channelRef)
  if (!channelId) return { ok: false, error: 'This project has no valid forum channel linked.' }

  const thread = await request<any>('GET', `/channels/${postId}`)
  if (!thread.ok) return { ok: false, error: thread.error }
  const current: string[] = (thread.data?.applied_tags ?? []).map(String)

  const resolved = await resolveTagNames(channelId, [...add, ...remove])
  if (!resolved.ok) return { ok: false, error: resolved.error }

  const idOf = (name: string): string | undefined =>
    resolved.all.find((t) => t.name.toLowerCase() === name.trim().toLowerCase())?.id
  const removeIds = new Set(remove.map(idOf).filter(Boolean) as string[])
  const next = current.filter((id) => !removeIds.has(id))
  for (const name of add) {
    const id = idOf(name)
    if (id && !next.includes(id)) next.push(id)
  }

  const result = await setPostTags(postId, next)
  if (!result.ok) return result
  return {
    ok: true,
    tags: next.map((id) => resolved.all.find((t) => t.id === id)?.name ?? id)
  }
}

/** Discord refuses a message body longer than this. */
const MESSAGE_LIMIT = 2000

/**
 * Open a new report in the forum.
 *
 * A forum post is a thread whose opening message is created in the same call,
 * so title, body and tags all land together or not at all.
 */
export async function createPost(
  channelRef: string,
  draft: { title: string; body: string; tags?: string[] }
): Promise<{ ok: boolean; error?: string; id?: string; url?: string }> {
  const channelId = extractChannelId(channelRef)
  if (!channelId) return { ok: false, error: 'This project has no valid forum channel linked.' }

  const title = draft.title.trim()
  if (!title) return { ok: false, error: 'A title is required.' }
  const body = draft.body.trim()
  if (!body) return { ok: false, error: 'A body is required; a report with no detail helps nobody.' }
  if (body.length > MESSAGE_LIMIT) {
    return {
      ok: false,
      error: `Discord caps a post at ${MESSAGE_LIMIT} characters; this one is ${body.length}. Shorten it, or put the detail in a reply.`
    }
  }

  let tagIds: string[] = []
  if (draft.tags && draft.tags.length > 0) {
    const resolved = await resolveTagNames(channelId, draft.tags)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    tagIds = resolved.ids
  }

  const result = await request<any>('POST', `/channels/${channelId}/threads`, {
    name: title.slice(0, 100),
    applied_tags: tagIds,
    message: { content: body }
  })
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.status === 403
          ? 'The bot needs Send Messages and Create Posts in that forum to open a report.'
          : result.error
    }
  }

  const id = String(result.data?.id ?? '')
  const guildId = result.data?.guild_id
  return {
    ok: true,
    id,
    url: guildId ? `https://discord.com/channels/${guildId}/${id}` : undefined
  }
}

/** Add a message to an existing report. */
export async function replyToPost(
  postId: string,
  content: string
): Promise<{ ok: boolean; error?: string }> {
  const text = content.trim()
  if (!text) return { ok: false, error: 'A reply needs some text.' }
  if (text.length > MESSAGE_LIMIT) {
    return {
      ok: false,
      error: `Discord caps a message at ${MESSAGE_LIMIT} characters; this one is ${text.length}.`
    }
  }
  const result = await request('POST', `/channels/${postId}/messages`, { content: text })
  if (result.ok) return { ok: true }
  return {
    ok: false,
    error:
      result.status === 403
        ? 'The bot needs Send Messages in that forum to reply.'
        : result.error
  }
}

/** Rename a report. Needs Manage Threads unless the bot opened it. */
export async function setPostTitle(
  postId: string,
  title: string
): Promise<{ ok: boolean; error?: string }> {
  const name = title.trim()
  if (!name) return { ok: false, error: 'A title is required.' }
  const result = await request('PATCH', `/channels/${postId}`, { name: name.slice(0, 100) })
  if (result.ok) return { ok: true }
  return {
    ok: false,
    error:
      result.status === 403
        ? 'The bot needs the Manage Threads permission to rename posts.'
        : result.error
  }
}

/** Replace a post's tags. Needs Manage Threads on the bot. */
export async function setPostTags(
  postId: string,
  tagIds: string[]
): Promise<{ ok: boolean; error?: string }> {
  const result = await request('PATCH', `/channels/${postId}`, { applied_tags: tagIds })
  if (result.ok) return { ok: true }
  return {
    ok: false,
    error:
      result.status === 403
        ? 'The bot needs the Manage Threads permission to retag posts.'
        : result.error
  }
}

/** Archive (close) or reopen a post. */
export async function setPostArchived(
  postId: string,
  archived: boolean
): Promise<{ ok: boolean; error?: string }> {
  const result = await request('PATCH', `/channels/${postId}`, { archived })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

/** Cheap credential check for the settings screen. */
export async function verifyToken(): Promise<{ ok: boolean; user?: string; error?: string }> {
  const result = await request<any>('GET', '/users/@me')
  if (!result.ok) return { ok: false, error: result.error }
  const name = result.data?.username ?? 'bot'
  return { ok: true, user: name }
}
