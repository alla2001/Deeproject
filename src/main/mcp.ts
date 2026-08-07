import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { loadState } from './store'
import type { NotionTaskPatch } from '@shared/types'
import { createTask, deleteTask, hasNotionToken, listTasks, updateTask } from './notion'
import {
  amendPostTags,
  createPost,
  getPost,
  hasDiscordToken,
  listPosts,
  replyToPost,
  setPostArchived,
  setPostTagsByName,
  setPostTitle
} from './discord'
import { hasRobloxApiKey, uploadAsset } from './robloxAssets'
import { isInside } from './files'

/**
 * A tiny MCP server so a Claude session running in one of our terminals can
 * read and edit the Notion tasks linked to that terminal's project.
 *
 * It lives in the main process rather than a spawned stdio script for two
 * reasons: the Notion logic (and the OS-encrypted token) already lives here, and
 * nothing has to hand the token to a child process through the environment.
 * Claude reaches it over loopback HTTP with a per-run bearer token.
 */

const PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', PROTOCOL_VERSION])

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const TOOLS = [
  {
    name: 'list_tasks',
    description:
      "List the tasks on this project's linked Notion board. Returns each task's id, title, done flag and status.",
    inputSchema: {
      type: 'object',
      properties: {
        include_done: {
          type: 'boolean',
          description: 'Include completed tasks. Defaults to true.'
        },
        query: {
          type: 'string',
          description: 'Optional case-insensitive filter on the title or status.'
        }
      }
    }
  },
  {
    name: 'create_task',
    description:
      "Add a task to this project's Notion board, filled in properly. Call list_tasks first to see the board's `fields` — every column it lists can be set here through `values`, and `body` becomes the page content. Prefer creating a task complete over creating a bare title and correcting it afterwards.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The task title.' },
        body: {
          type: 'string',
          description:
            'Page content for the task: repro steps, context, acceptance criteria. Markdown headings, bullets, numbered lists and ``` code fences are converted to real Notion blocks.'
        },
        status: {
          type: 'string',
          description: "One of the board's statusOptions, e.g. \"Not started\"."
        },
        done: { type: 'boolean', description: 'Mark it complete immediately. Rarely wanted.' },
        values: {
          type: 'object',
          description:
            'Any other column from the board\'s `fields`, by name: {"Priority": "High", "Platform": ["PC", "Mobile"]}. Single-valued columns take a string, multi-select columns take an array. Values must be options that already exist on the board.',
          additionalProperties: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
          }
        }
      },
      required: ['title']
    }
  },
  {
    name: 'update_task',
    description:
      'Update a task. Pass the id from list_tasks plus anything you want to change. `values` sets any column on the board; `append_body` adds notes to the end of the task page without touching what is already written there.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id from list_tasks.' },
        title: { type: 'string' },
        done: { type: 'boolean' },
        status: {
          type: 'string',
          description: 'Status name; only valid when the board is a database with a status property.'
        },
        values: {
          type: 'object',
          description:
            'Columns to set, by name, as in create_task. Pass an empty array to clear a column.',
          additionalProperties: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
          }
        },
        append_body: {
          type: 'string',
          description:
            'Text appended to the end of the task page as new blocks — a findings note, a link to the commit that fixed it. Never overwrites existing content.'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_task',
    description: 'Delete (archive) a task from the board.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  {
    name: 'list_bug_reports',
    description:
      "List bug reports from this project's linked Discord forum. Returns each report's id, title, tags, a short excerpt and reply count. Use get_bug_report for the full text.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter on title, body or tag.' },
        tag: { type: 'string', description: 'Only reports carrying this tag, e.g. "critical".' },
        include_closed: {
          type: 'boolean',
          description: 'Include archived/closed reports. Defaults to false.'
        }
      }
    }
  },
  {
    name: 'get_bug_report',
    description:
      'Read one bug report in full: the opening post, any attachment URLs, and the replies under it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Report id from list_bug_reports.' },
        reply_limit: { type: 'number', description: 'How many replies to include. Defaults to 30.' }
      },
      required: ['id']
    }
  },
  {
    name: 'create_bug_report',
    description:
      "Open a new report in this project's Discord forum — a bug you found, or one a user described that is not filed yet. Call list_bug_reports first for `availableTags`; only tags that already exist on the forum can be applied. Write the body as a real report: what happens, what should happen, how to reproduce it, and where you saw it.",
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'One line naming the symptom. Truncated at 100 characters by Discord.'
        },
        body: {
          type: 'string',
          description:
            'The report itself, up to 2000 characters. Discord renders markdown, so headings, bullets and ``` code fences all work.'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply, by name, from availableTags.'
        }
      },
      required: ['title', 'body']
    }
  },
  {
    name: 'reply_to_bug_report',
    description:
      'Post a reply on a bug report — asking the reporter for a repro, or recording what you found and fixed. Up to 2000 characters, markdown allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Report id from list_bug_reports.' },
        body: { type: 'string' }
      },
      required: ['id', 'body']
    }
  },
  {
    name: 'update_bug_report',
    description:
      'Retag, rename or close a bug report — for example tagging it "fixed" once you have shipped the fix. Prefer add_tags/remove_tags, which leave the other tags alone; `tags` replaces the whole set and will drop any you do not restate.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string', description: 'Rename the report.' },
        add_tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply on top of the ones already there, by name.'
        },
        remove_tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to take off, by name.'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Full replacement tag list, by name. Overrides add_tags/remove_tags.'
        },
        closed: { type: 'boolean', description: 'Archive (close) or reopen the post.' }
      },
      required: ['id']
    }
  },
  {
    name: 'upload_roblox_asset',
    description:
      "Upload a file from this project's folder to Roblox as an asset and return its asset id, ready to use as rbxassetid://<id>. Images become Decals, audio becomes Audio, meshes become Models. Uploads are moderated by Roblox, so an id can take a few seconds.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File to upload, relative to the project folder or absolute inside it.'
        },
        name: { type: 'string', description: 'Display name. Defaults to the file name.' },
        description: { type: 'string' },
        asset_type: {
          type: 'string',
          description:
            'Override the detected type (Decal, Audio, Model, Video, Animation). Rarely needed.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'create_task_from_report',
    description:
      "Copy a Discord bug report onto this project's Notion board as a task. The report's full text, author, attachments and Discord link are carried into the task body, so the task stands on its own. Pass status/values to classify it at the same time — the forum's tags do not map onto the board's columns by themselves.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Report id from list_bug_reports.' },
        title: {
          type: 'string',
          description: "Override the task title. Defaults to the report's own, prefixed with its tags."
        },
        status: { type: 'string' },
        values: {
          type: 'object',
          description: 'Board columns to set, by name, as in create_task.',
          additionalProperties: {
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
          }
        },
        include_replies: {
          type: 'boolean',
          description: 'Copy the discussion under the report too. Defaults to false.'
        }
      },
      required: ['id']
    }
  }
]

/**
 * Read a `values` argument.
 *
 * The schema asks for arrays for multi-select columns and strings elsewhere,
 * and models mix the two freely, so both are accepted and normalised rather
 * than rejected on a technicality.
 */
function readValues(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[name] = value.trim() ? [value] : []
    else if (Array.isArray(value)) out[name] = value.map(String).filter(Boolean)
    else if (value === null) out[name] = []
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function readStrings(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) return raw.map(String)
  return undefined
}

/** Warn about names the board had no column for, rather than staying silent. */
function ignoredNote(ignored: string[] | undefined): string {
  if (!ignored || ignored.length === 0) return ''
  return ` Ignored — this board has no such column: ${ignored.join(', ')}.`
}

let server: Server | null = null
let port = 0
let secret = ''

export function mcpReady(): boolean {
  return server !== null && port > 0
}

/** Notion target for a project, or null when it isn't usable. */
function targetFor(projectId: string): string | null {
  if (!hasNotionToken()) return null
  const project = loadState().projects.find((p) => p.id === projectId)
  const target = project?.notion.target?.trim()
  return target ? target : null
}

/** Discord forum channel for a project, or null when it isn't usable. */
function forumFor(projectId: string): string | null {
  if (!hasDiscordToken()) return null
  const project = loadState().projects.find((p) => p.id === projectId)
  const channel = project?.discord.channel?.trim()
  return channel ? channel : null
}

function textResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return { content: [{ type: 'text', text }], isError }
}

async function callTool(
  projectId: string,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (name === 'upload_roblox_asset') {
    const project = loadState().projects.find((p) => p.id === projectId)
    if (!project) return textResult('That project no longer exists.', true)
    if (!hasRobloxApiKey()) {
      return textResult('No Roblox API key set. Add one in Deeproject under Settings → Roblox.', true)
    }
    const creatorId = project.roblox.creatorId?.trim()
    if (!creatorId) {
      return textResult(
        'This project has no Roblox creator set. Add a user or group id in its Roblox tab.',
        true
      )
    }

    const raw = typeof args.path === 'string' ? args.path : ''
    if (!raw) return textResult('A file path is required.', true)
    const filePath = isAbsolute(raw) ? raw : join(project.path, raw)
    // Uploading is public and irreversible, so keep it inside the project.
    if (!isInside(project.path, filePath)) {
      return textResult('That file is outside the project folder.', true)
    }

    const result = await uploadAsset({
      filePath,
      creator: { type: project.roblox.creatorType, id: creatorId },
      displayName: typeof args.name === 'string' ? args.name : undefined,
      description: typeof args.description === 'string' ? args.description : undefined,
      assetType: typeof args.asset_type === 'string' ? args.asset_type : undefined
    })

    return result.ok
      ? textResult({
          file: result.file,
          assetType: result.assetType,
          assetId: result.assetId,
          reference: `rbxassetid://${result.assetId}`
        })
      : textResult(result.error ?? 'Upload failed.', true)
  }

  const forum = forumFor(projectId)
  // create_task_from_report reads the forum before it writes to Notion, so it
  // belongs on this side of the fence too.
  const needsForum = name.includes('bug_report') || name === 'create_task_from_report'

  if (needsForum && !forum) {
    return textResult(
      'This project has no Discord forum linked, or no Discord bot token is set in Deeproject.',
      true
    )
  }

  if (forum) {
    switch (name) {
      case 'list_bug_reports': {
        const board = await listPosts(forum, args.include_closed === true)
        if (!board.ok) return textResult(board.error ?? 'Could not read the forum.', true)
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
        const tag = typeof args.tag === 'string' ? args.tag.trim().toLowerCase() : ''
        const posts = board.posts.filter((post) => {
          if (tag && !post.tags.some((t) => t.toLowerCase() === tag)) return false
          if (!query) return true
          return (
            post.title.toLowerCase().includes(query) ||
            post.excerpt.toLowerCase().includes(query) ||
            post.tags.some((t) => t.toLowerCase().includes(query))
          )
        })
        return textResult({
          channel: board.channelName,
          availableTags: board.tags.map((t) => t.name),
          count: posts.length,
          reports: posts.map((p) => ({
            id: p.id,
            title: p.title,
            tags: p.tags,
            excerpt: p.excerpt,
            author: p.author,
            replies: p.messageCount,
            closed: p.archived,
            url: p.url
          }))
        })
      }

      case 'get_bug_report': {
        const id = typeof args.id === 'string' ? args.id : ''
        if (!id) return textResult('A report id is required.', true)
        const limit = typeof args.reply_limit === 'number' ? args.reply_limit : 30
        const post = await getPost(id, limit)
        return post.ok ? textResult(post) : textResult(post.error, true)
      }

      case 'create_bug_report': {
        const result = await createPost(forum, {
          title: typeof args.title === 'string' ? args.title : '',
          body: typeof args.body === 'string' ? args.body : '',
          tags: readStrings(args.tags)
        })
        return result.ok
          ? textResult({ created: true, id: result.id, url: result.url })
          : textResult(result.error ?? 'Could not open the report.', true)
      }

      case 'reply_to_bug_report': {
        const id = typeof args.id === 'string' ? args.id : ''
        if (!id) return textResult('A report id is required.', true)
        const result = await replyToPost(id, typeof args.body === 'string' ? args.body : '')
        return result.ok
          ? textResult('Replied.')
          : textResult(result.error ?? 'Could not reply.', true)
      }

      case 'update_bug_report': {
        const id = typeof args.id === 'string' ? args.id : ''
        if (!id) return textResult('A report id is required.', true)
        const notes: string[] = []

        if (typeof args.title === 'string') {
          const result = await setPostTitle(id, args.title)
          if (!result.ok) return textResult(result.error ?? 'Could not rename.', true)
          notes.push(`renamed to "${args.title}"`)
        }

        const replacement = readStrings(args.tags)
        const add = readStrings(args.add_tags) ?? []
        const remove = readStrings(args.remove_tags) ?? []
        if (replacement) {
          const result = await setPostTagsByName(forum, id, replacement)
          if (!result.ok) return textResult(result.error ?? 'Could not retag.', true)
          notes.push(`tags set to ${replacement.join(', ') || '(none)'}`)
        } else if (add.length > 0 || remove.length > 0) {
          const result = await amendPostTags(forum, id, add, remove)
          if (!result.ok) return textResult(result.error ?? 'Could not retag.', true)
          notes.push(`tags now ${result.tags?.join(', ') || '(none)'}`)
        }

        if (typeof args.closed === 'boolean') {
          const result = await setPostArchived(id, args.closed)
          if (!result.ok) return textResult(result.error ?? 'Could not change state.', true)
          notes.push(args.closed ? 'closed' : 'reopened')
        }
        if (notes.length === 0) {
          return textResult('Pass title, add_tags/remove_tags, tags and/or closed.', true)
        }
        return textResult(`Updated: ${notes.join('; ')}.`)
      }

      case 'create_task_from_report': {
        const notionTarget = targetFor(projectId)
        if (!notionTarget) {
          return textResult('This project has no Notion board linked to copy the report onto.', true)
        }
        const id = typeof args.id === 'string' ? args.id : ''
        if (!id) return textResult('A report id is required.', true)
        const board = await listPosts(forum, true)
        if (!board.ok) return textResult(board.error ?? 'Could not read the forum.', true)
        const post = board.posts.find((p) => p.id === id)
        if (!post) return textResult(`No report with id ${id}.`, true)

        // The excerpt on the board is truncated, so read the report properly:
        // a task carrying half the repro steps is worse than no task.
        const full = await getPost(id, args.include_replies === true ? 30 : 0)

        const title =
          typeof args.title === 'string' && args.title.trim()
            ? args.title.trim()
            : post.tags.length > 0
              ? `[${post.tags.join('/')}] ${post.title}`
              : post.title

        const lines: string[] = []
        lines.push(full.ok && full.body ? full.body : post.excerpt)
        lines.push('')
        lines.push('## Reported on Discord')
        const author = (full.ok ? full.author : null) ?? post.author
        if (author) lines.push(`- Reporter: ${author}`)
        if (post.tags.length > 0) lines.push(`- Forum tags: ${post.tags.join(', ')}`)
        if (post.url) lines.push(`- Thread: ${post.url}`)
        if (full.ok && full.attachments.length > 0) {
          lines.push('- Attachments:')
          for (const url of full.attachments) lines.push(`  - ${url}`)
        }
        if (args.include_replies === true && full.ok && full.replies.length > 0) {
          lines.push('')
          lines.push('## Discussion')
          for (const reply of full.replies) lines.push(`- **${reply.author}**: ${reply.content}`)
        }

        const result = await createTask(notionTarget, {
          title,
          body: lines.join('\n'),
          status: typeof args.status === 'string' ? args.status : undefined,
          values: readValues(args.values)
        })
        return result.ok
          ? textResult(
              `Created Notion task "${title}".${result.url ? ` ${result.url}` : ''}${ignoredNote(result.ignored)}`
            )
          : textResult(result.error ?? 'Could not create the task.', true)
      }
    }
  }

  const target = targetFor(projectId)
  if (!target) {
    return textResult(
      'This project has no Notion board linked, or no Notion token is set in Deeproject.',
      true
    )
  }

  switch (name) {
    case 'list_tasks': {
      const board = await listTasks(target)
      if (!board.ok) return textResult(board.error ?? 'Could not read the board.', true)
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const includeDone = args.include_done !== false
      const tasks = board.tasks.filter((task) => {
        if (!includeDone && task.done) return false
        if (!query) return true
        return (
          task.title.toLowerCase().includes(query) ||
          (task.status ?? '').toLowerCase().includes(query)
        )
      })
      return textResult({
        board: board.title,
        kind: board.kind,
        statusOptions: board.statusOptions,
        // The whole editable schema, so a task can be filled in properly at
        // creation instead of being guessed at and corrected.
        fields: board.fields.map((f) => ({
          name: f.name,
          type: f.type,
          options: f.options.map((o) => o.name)
        })),
        count: tasks.length,
        tasks
      })
    }

    case 'create_task': {
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) return textResult('A non-empty title is required.', true)
      const result = await createTask(target, {
        title,
        body: typeof args.body === 'string' ? args.body : undefined,
        status: typeof args.status === 'string' ? args.status : undefined,
        done: typeof args.done === 'boolean' ? args.done : undefined,
        values: readValues(args.values)
      })
      return result.ok
        ? textResult(
            `Created task "${title}".${result.url ? ` ${result.url}` : ''}${ignoredNote(result.ignored)}`
          )
        : textResult(result.error ?? 'Could not create the task.', true)
    }

    case 'update_task': {
      const id = typeof args.id === 'string' ? args.id : ''
      if (!id) return textResult('A task id is required.', true)
      const patch: NotionTaskPatch = {}
      if (typeof args.title === 'string') patch.title = args.title
      if (typeof args.done === 'boolean') patch.done = args.done
      if (typeof args.status === 'string') patch.status = args.status
      const values = readValues(args.values)
      if (values) patch.values = values
      if (typeof args.append_body === 'string') patch.appendBody = args.append_body
      if (Object.keys(patch).length === 0) {
        return textResult(
          'Pass at least one of title, done, status, values or append_body.',
          true
        )
      }
      const result = await updateTask(target, id, patch)
      return result.ok
        ? textResult(`Updated.${ignoredNote(result.ignored)}`)
        : textResult(result.error ?? 'Could not update the task.', true)
    }

    case 'delete_task': {
      const id = typeof args.id === 'string' ? args.id : ''
      if (!id) return textResult('A task id is required.', true)
      const result = await deleteTask(target, id)
      return result.ok
        ? textResult('Deleted.')
        : textResult(result.error ?? 'Could not delete the task.', true)
    }

    default:
      return textResult(`Unknown tool: ${name}`, true)
  }
}

async function handleRpc(
  projectId: string,
  message: JsonRpcRequest
): Promise<Record<string, unknown> | null> {
  const { method, id } = message
  // Notifications carry no id and expect no response.
  const isNotification = id === undefined || id === null

  const reply = (result: unknown): Record<string, unknown> | null =>
    isNotification ? null : { jsonrpc: '2.0', id, result }

  const fail = (code: number, msg: string): Record<string, unknown> | null =>
    isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: msg } }

  switch (method) {
    case 'initialize': {
      const asked = (message.params?.protocolVersion as string) ?? PROTOCOL_VERSION
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'deeproject-tasks', version: app.getVersion() },
        instructions:
          "These tools reach the Notion task board and the Discord bug-report forum linked to this project in Deeproject. Call list_tasks or list_bug_reports first: as well as the ids you will need, they report what a task or report can carry — list_tasks returns the board's `fields`, every column with its allowed options, and list_bug_reports returns the forum's `availableTags`. Fill those in when you create something rather than filing a bare title and correcting it afterwards. get_bug_report returns a report in full with its replies."
      })
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return reply({})

    case 'tools/list':
      return reply({ tools: TOOLS })

    case 'tools/call': {
      const name = message.params?.name as string
      const args = (message.params?.arguments as Record<string, unknown>) ?? {}
      if (!name) return fail(-32602, 'Missing tool name')
      try {
        return reply(await callTool(projectId, name, args))
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        return reply(textResult(text, true))
      }
    }

    case 'resources/list':
      return reply({ resources: [] })

    case 'prompts/list':
      return reply({ prompts: [] })

    default:
      return fail(-32601, `Method not found: ${method}`)
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      // Nothing legitimate is this large; refuse rather than buffer forever.
      if (data.length > 4 * 1024 * 1024) reject(new Error('payload too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const match = url.pathname.match(/^\/mcp\/([\w-]+)$/)

  const auth = req.headers.authorization ?? ''
  if (!match || auth !== `Bearer ${secret}`) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }
  const projectId = match[1]

  if (req.method === 'DELETE') {
    res.writeHead(200).end()
    return
  }
  if (req.method !== 'POST') {
    // No server-initiated stream is offered, so GET has nothing to give.
    res.writeHead(405, { Allow: 'POST, DELETE' }).end()
    return
  }

  let parsed: JsonRpcRequest | JsonRpcRequest[]
  try {
    parsed = JSON.parse(await readBody(req))
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    return
  }

  const batch = Array.isArray(parsed) ? parsed : [parsed]
  const responses: Record<string, unknown>[] = []
  for (const message of batch) {
    const response = await handleRpc(projectId, message)
    if (response) responses.push(response)
  }

  if (responses.length === 0) {
    // Everything was a notification.
    res.writeHead(202).end()
    return
  }

  const body = JSON.stringify(Array.isArray(parsed) ? responses : responses[0])
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

export function startMcpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) return resolve()
    secret = randomBytes(24).toString('hex')
    const created = createServer((req, res) => {
      void onRequest(req, res).catch((err) => {
        console.error('[mcp]', err)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })

    created.on('error', (err) => {
      console.error('[mcp] server error', err)
      server = null
      port = 0
      resolve()
    })

    // Port 0 lets the OS pick; loopback only so nothing off-machine can reach it.
    created.listen(0, '127.0.0.1', () => {
      const address = created.address()
      port = typeof address === 'object' && address ? address.port : 0
      server = created
      resolve()
    })
  })
}

export function stopMcpServer(): void {
  server?.close()
  server = null
  port = 0
}

/** Write (and return) the --mcp-config file for one project. */
function writeConfig(projectId: string): string {
  const dir = join(app.getPath('userData'), 'mcp')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${projectId}.json`)
  const config = {
    mcpServers: {
      'deeproject-tasks': {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp/${projectId}`,
        headers: { Authorization: `Bearer ${secret}` }
      }
    }
  }
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  return file
}

/** True when the command's first word invokes the Claude CLI. */
function isClaudeCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const bare = first.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/, '')
  return bare === 'claude'
}

/**
 * Append `--mcp-config` to a Claude invocation so the session can reach this
 * project's task tools. Any other command is returned untouched.
 */
export function augmentClaudeCommand(command: string | null, projectId: string | null): string | null {
  if (!command || !projectId || !mcpReady()) return command
  if (!isClaudeCommand(command)) return command
  // Already wired up by the user; don't fight their flags.
  if (/--mcp-config\b/.test(command)) return command
  // Attach if any integration is usable for this project.
  if (!targetFor(projectId) && !forumFor(projectId) && !hasRobloxApiKey()) return command

  try {
    const file = writeConfig(projectId)
    return `${command} --mcp-config "${file}"`
  } catch (err) {
    console.error('[mcp] could not write config', err)
    return command
  }
}
