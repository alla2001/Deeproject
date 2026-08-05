import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { loadState } from './store'
import { createTask, deleteTask, hasNotionToken, listTasks, updateTask } from './notion'
import {
  getPost,
  hasDiscordToken,
  listPosts,
  setPostArchived,
  setPostTagsByName
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
    description: "Add a new task to this project's Notion board.",
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'The task title.' } },
      required: ['title']
    }
  },
  {
    name: 'update_task',
    description:
      'Update a task. Pass the id from list_tasks plus any of title, done or status.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id from list_tasks.' },
        title: { type: 'string' },
        done: { type: 'boolean' },
        status: {
          type: 'string',
          description: 'Status name; only valid when the board is a database with a status property.'
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
    name: 'update_bug_report',
    description:
      'Retag or close a bug report — for example tagging it "fixed" once you have shipped the fix. Tags are given by name and replace the existing set.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Full replacement tag list, by name.'
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
      "Copy a Discord bug report onto this project's Notion board as a task, keeping its tags in the title.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Report id from list_bug_reports.' }
      },
      required: ['id']
    }
  }
]

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
  const needsForum = name.includes('bug_report')

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

      case 'update_bug_report': {
        const id = typeof args.id === 'string' ? args.id : ''
        if (!id) return textResult('A report id is required.', true)
        const notes: string[] = []
        if (Array.isArray(args.tags)) {
          const result = await setPostTagsByName(forum, id, args.tags.map(String))
          if (!result.ok) return textResult(result.error ?? 'Could not retag.', true)
          notes.push(`tags set to ${args.tags.join(', ')}`)
        }
        if (typeof args.closed === 'boolean') {
          const result = await setPostArchived(id, args.closed)
          if (!result.ok) return textResult(result.error ?? 'Could not change state.', true)
          notes.push(args.closed ? 'closed' : 'reopened')
        }
        if (notes.length === 0) return textResult('Pass tags and/or closed.', true)
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
        const title = post.tags.length > 0 ? `[${post.tags.join('/')}] ${post.title}` : post.title
        const result = await createTask(notionTarget, title)
        return result.ok
          ? textResult(`Created Notion task "${title}".`)
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
        count: tasks.length,
        tasks
      })
    }

    case 'create_task': {
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) return textResult('A non-empty title is required.', true)
      const result = await createTask(target, title)
      return result.ok
        ? textResult(`Created task "${title}".`)
        : textResult(result.error ?? 'Could not create the task.', true)
    }

    case 'update_task': {
      const id = typeof args.id === 'string' ? args.id : ''
      if (!id) return textResult('A task id is required.', true)
      const patch: { title?: string; done?: boolean; status?: string } = {}
      if (typeof args.title === 'string') patch.title = args.title
      if (typeof args.done === 'boolean') patch.done = args.done
      if (typeof args.status === 'string') patch.status = args.status
      if (Object.keys(patch).length === 0) {
        return textResult('Pass at least one of title, done or status.', true)
      }
      const result = await updateTask(target, id, patch)
      return result.ok
        ? textResult('Updated.')
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
          'These tools reach the Notion task board and the Discord bug-report forum linked to this project in Deeproject. Call list_tasks or list_bug_reports first to get ids; get_bug_report returns a report in full with its replies.'
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
