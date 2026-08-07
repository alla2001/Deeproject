/**
 * Checks what Deeproject actually sends to Notion and Discord when an agent
 * fills a task or a bug report in.
 *
 *   node_modules/electron/dist/electron.exe scripts/integration-write-test.cjs
 *
 * `fetch` is replaced with a recorder, so the real request bodies are asserted
 * without a token, a workspace or a server. It runs under Electron because
 * notion.ts and discord.ts keep their tokens in safeStorage; --user-data-dir
 * keeps the fake ones out of the real profile.
 */
const { app } = require('electron')
const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const outDir = join(root, 'node_modules', '.cache', 'integration-test')
mkdirSync(outDir, { recursive: true })
const tsconfigPath = join(outDir, 'tsconfig.json')
writeFileSync(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      outDir,
      rootDir: join(root, 'src'),
      module: 'commonjs',
      target: 'es2022',
      moduleResolution: 'node',
      skipLibCheck: true,
      esModuleInterop: true,
      // The sources narrow {ok:true}|{ok:false} unions all over; without strict
      // mode TypeScript cannot follow that and buries the run in errors.
      strict: true,
      baseUrl: root,
      paths: { '@shared/*': ['src/shared/*'] },
      typeRoots: [join(root, 'node_modules', '@types')],
      types: ['node']
    },
    files: [join(root, 'src', 'main', 'notion.ts'), join(root, 'src', 'main', 'discord.ts')]
  })
)
try {
  execFileSync(
    process.execPath,
    [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfigPath],
    { stdio: 'inherit', cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  )
} catch {
  // Throwing here would reach Electron as an uncaught startup exception, which
  // it reports in a modal dialog — invisible to whoever ran this from a shell,
  // and it never returns.
  console.error('compile failed; see the errors above')
  process.exit(1)
}

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` -- ${detail}`}`)
}
const deep = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---- the recorder ----------------------------------------------------------

const sent = []
let routes = {}

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET'
  const body = init.body ? JSON.parse(init.body) : null
  sent.push({ method, url: String(url), body })
  for (const [pattern, responder] of Object.entries(routes)) {
    const [rmethod, rpath] = pattern.split(' ')
    if (rmethod !== method) continue
    if (!new RegExp(rpath).test(String(url))) continue
    const data = typeof responder === 'function' ? responder(body) : responder
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(data ?? {})
    }
  }
  return {
    ok: false,
    status: 404,
    headers: { get: () => null },
    text: async () => JSON.stringify({ message: `no stub for ${method} ${url}` })
  }
}

// Both integrations parse ids before they use them — Notion wants 32 hex
// characters, Discord a 15-25 digit snowflake — so the fixtures have to look
// like the real thing or nothing gets as far as a request.
const DB_ID = '11111111222233334444555566667777'
const DB_DASHED = '11111111-2222-3333-4444-555566667777'
const PAGE_ID = 'aaaaaaaabbbbccccddddeeeeeeeeeeee'
const CHANNEL_ID = '900000000000000001'
const THREAD_ID = '900000000000000009'
const GUILD_ID = '800000000000000001'

/** A board shaped like the CCS one: status plus several select columns. */
const DATABASE = {
  object: 'database',
  id: DB_DASHED,
  title: [{ plain_text: 'CCS Tasks' }],
  properties: {
    Name: { type: 'title', title: {} },
    Status: {
      type: 'status',
      status: {
        options: [
          { id: 's1', name: 'Not started', color: 'default' },
          { id: 's2', name: 'Under Review', color: 'yellow' },
          { id: 's3', name: 'Done', color: 'green' }
        ],
        groups: [{ name: 'Complete', option_ids: ['s3'] }]
      }
    },
    Priority: {
      type: 'select',
      select: { options: [{ name: 'High' }, { name: 'Med' }, { name: 'Low' }] }
    },
    Platform: {
      type: 'multi_select',
      multi_select: { options: [{ name: 'PC' }, { name: 'Mobile' }] }
    }
  }
}

async function notionChecks(notion) {
  notion.setNotionToken('fake-token-for-tests')

  routes = {
    [`GET /databases/${DB_DASHED}$`]: DATABASE,
    'POST /v1/pages$': { id: PAGE_ID, url: `https://notion.so/${PAGE_ID}` },
    [`PATCH /pages/${PAGE_ID}$`]: {},
    [`PATCH /blocks/${PAGE_ID}/children$`]: {}
  }

  console.log('notion: create a task with every detail filled in')
  sent.length = 0
  const created = await notion.createTask(DB_ID, {
    title: 'Mud is invisible on alt accounts',
    status: 'Under Review',
    values: { Priority: ['High'], Platform: ['PC', 'Mobile'], Nonexistent: ['x'] },
    body: [
      '## Steps',
      '1. load any map',
      '2. dig mud on an alt account',
      '',
      'Expected the mud to render.',
      '',
      '```lua',
      'print("hi")',
      '```',
      '- device: PC'
    ].join('\n')
  })

  check('createTask reported ok', created.ok === true, created.error)
  check('returned the new page url', created.url === `https://notion.so/${PAGE_ID}`, created.url)
  check(
    'reported the column the board does not have',
    deep(created.ignored, ['Nonexistent']),
    JSON.stringify(created.ignored)
  )

  const post = sent.find((r) => r.method === 'POST' && r.url.endsWith('/v1/pages'))
  check('posted one page', Boolean(post))
  const props = post?.body?.properties ?? {}
  check(
    'title went to the title column',
    props.Name?.title?.[0]?.text?.content === 'Mud is invisible on alt accounts'
  )
  check('status was set', props.Status?.status?.name === 'Under Review')
  check('a select column was set', props.Priority?.select?.name === 'High')
  check(
    'a multi-select column took both values',
    deep(props.Platform?.multi_select, [{ name: 'PC' }, { name: 'Mobile' }]),
    JSON.stringify(props.Platform)
  )
  check('an unknown column was not sent', props.Nonexistent === undefined)

  const children = post?.body?.children ?? []
  const types = children.map((b) => b.type)
  check(
    'body became real blocks, not one lump of text',
    deep(types, [
      'heading_2',
      'numbered_list_item',
      'numbered_list_item',
      'paragraph',
      'code',
      'bulleted_list_item'
    ]),
    JSON.stringify(types)
  )
  check(
    'the code fence kept its language and content',
    children[4]?.code?.language === 'lua' &&
      children[4]?.code?.rich_text?.[0]?.text?.content === 'print("hi")',
    JSON.stringify(children[4])
  )

  console.log('\nnotion: update columns and append notes')
  sent.length = 0
  const updated = await notion.updateTask(DB_ID, PAGE_ID, {
    values: { Priority: ['Low'], Platform: [] },
    appendBody: 'Fixed in 0.8.6.'
  })
  check('updateTask reported ok', updated.ok === true, updated.error)
  const patch = sent.find((r) => r.method === 'PATCH' && r.url.includes(`/pages/${PAGE_ID}`))
  check('a select column was changed', patch?.body?.properties?.Priority?.select?.name === 'Low')
  check(
    'an empty array cleared a multi-select',
    deep(patch?.body?.properties?.Platform?.multi_select, []),
    JSON.stringify(patch?.body?.properties?.Platform)
  )
  const appended = sent.find((r) => r.url.includes(`/blocks/${PAGE_ID}/children`))
  check(
    'notes were appended as a block',
    appended?.body?.children?.[0]?.paragraph?.rich_text?.[0]?.text?.content === 'Fixed in 0.8.6.',
    JSON.stringify(appended?.body)
  )

  console.log('\nnotion: a bare title still works')
  sent.length = 0
  const simple = await notion.createTask(DB_ID, 'Just a title')
  check('createTask accepts a plain string', simple.ok === true, simple.error)
  check('an empty title is refused', (await notion.createTask(DB_ID, '   ')).ok === false)
}

const FORUM = {
  id: CHANNEL_ID,
  name: 'bug-tracker',
  type: 15,
  guild_id: GUILD_ID,
  available_tags: [
    { id: 't1', name: 'critical', emoji_name: '🟥' },
    { id: 't2', name: 'open', emoji_name: '📬' },
    { id: 't3', name: 'fixed', emoji_name: '✅' }
  ]
}

async function discordChecks(discord) {
  discord.setDiscordToken('fake-bot-token')

  routes = {
    [`GET /channels/${CHANNEL_ID}$`]: FORUM,
    [`GET /channels/${THREAD_ID}$`]: { id: THREAD_ID, applied_tags: ['t1', 't2'] },
    [`POST /channels/${CHANNEL_ID}/threads$`]: { id: THREAD_ID, guild_id: GUILD_ID },
    [`POST /channels/${THREAD_ID}/messages$`]: { id: '900000000000000100' },
    [`PATCH /channels/${THREAD_ID}$`]: {}
  }

  console.log('\ndiscord: open a report')
  sent.length = 0
  const opened = await discord.createPost(CHANNEL_ID, {
    title: 'Mud is invisible on alt accounts',
    body: 'Steps:\n1. load any map\n2. dig mud on an alt',
    tags: ['critical', 'open']
  })
  check('createPost reported ok', opened.ok === true, opened.error)
  check(
    'returned a link to the thread',
    opened.url === `https://discord.com/channels/${GUILD_ID}/${THREAD_ID}`,
    opened.url
  )
  const thread = sent.find((r) => r.method === 'POST' && r.url.endsWith('/threads'))
  check('title became the thread name', thread?.body?.name === 'Mud is invisible on alt accounts')
  check('body became the opening message', thread?.body?.message?.content?.startsWith('Steps:'))
  check(
    'tag names were resolved to ids',
    deep(thread?.body?.applied_tags, ['t1', 't2']),
    JSON.stringify(thread?.body?.applied_tags)
  )

  const bogus = await discord.createPost(CHANNEL_ID, {
    title: 'x',
    body: 'y',
    tags: ['not-a-tag']
  })
  check('an unknown tag is refused rather than dropped', bogus.ok === false)
  check('and the message says what is available', /critical, open, fixed/.test(bogus.error ?? ''))
  check(
    'an empty body is refused',
    (await discord.createPost(CHANNEL_ID, { title: 'x', body: '  ' })).ok === false
  )
  check(
    'an over-long body is refused with its length',
    /2001/.test(
      (await discord.createPost(CHANNEL_ID, { title: 'x', body: 'a'.repeat(2001) })).error ?? ''
    )
  )

  console.log('\ndiscord: amend tags without restating them')
  sent.length = 0
  const amended = await discord.amendPostTags(CHANNEL_ID, THREAD_ID, ['fixed'], ['open'])
  check('amendPostTags reported ok', amended.ok === true, amended.error)
  check(
    'kept critical, dropped open, added fixed',
    deep(amended.tags, ['critical', 'fixed']),
    JSON.stringify(amended.tags)
  )

  console.log('\ndiscord: reply and rename')
  sent.length = 0
  const replied = await discord.replyToPost(THREAD_ID, 'Fixed in 0.8.6.')
  check('replyToPost reported ok', replied.ok === true, replied.error)
  check(
    'the reply was posted to the thread',
    sent.some((r) => r.url.endsWith(`/channels/${THREAD_ID}/messages`) && r.body?.content === 'Fixed in 0.8.6.')
  )
  const renamed = await discord.setPostTitle(THREAD_ID, 'Invisible mud (alt accounts)')
  check('setPostTitle reported ok', renamed.ok === true, renamed.error)
  check('an empty reply is refused', (await discord.replyToPost(THREAD_ID, ' ')).ok === false)
}

app.whenReady().then(async () => {
  try {
    await notionChecks(require(join(outDir, 'main', 'notion.js')))
    await discordChecks(require(join(outDir, 'main', 'discord.js')))
  } catch (err) {
    console.error(err)
    failures++
  }
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  app.exit(failures === 0 ? 0 : 1)
})
