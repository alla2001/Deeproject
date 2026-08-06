/**
 * Throwaway profile that opens a terminal, the file tree, the code editor and
 * the Rojo panel side by side against a real Roblox project. Used to verify the
 * new panels without touching the real profile.
 *
 *   node scripts/seed-feature-profile.cjs <profileDir> <projectPath>
 */
const fs = require('node:fs')
const path = require('node:path')

const dir = process.argv[2]
const projectPath = process.argv[3]
// With --fake-notion the profile gets a bogus token and target so the task
// panel renders its real toolbar (the API call then fails with a 401). Lets the
// layout be checked without a live Notion workspace.
const fakeNotion = process.argv.includes('--fake-notion')
if (!dir || !projectPath) {
  console.error('usage: node scripts/seed-feature-profile.cjs <profileDir> <projectPath> [--fake-notion]')
  process.exit(1)
}
fs.mkdirSync(dir, { recursive: true })

const projectId = 'p-feature-0001'
const terminalId = 't-feature-0001'
// A port well away from Rojo's default so a real server can't collide.
const rojoPort = 34999

const editorFile = path.join(projectPath, 'default.project.json')
const editorId = `editor:${editorFile.toLowerCase()}`

const state = {
  schemaVersion: 2,
  projects: [
    {
      id: projectId,
      name: path.basename(projectPath),
      path: projectPath,
      color: '#8b5cf6',
      emoji: '🎮',
      backgroundImage: null,
      backgroundOpacity: 0.18,
      backgroundBlur: 0,
      order: 0,
      collapsed: false,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      rojo: { projectFile: null, port: rojoPort, binary: null, autoStart: true },
      roblox: { placeFile: 'build.rbxlx', placeId: null, universeId: null },
      notion: fakeNotion
        ? { target: 'https://www.notion.so/Tasks-00000000000000000000000000000000', kind: 'database' }
        : { target: null, kind: null },
      discord: fakeNotion
        ? { channel: '000000000000000000', channelName: '#bug-tracker' }
        : { channel: null, channelName: null }
    }
  ],
  terminals: [
    {
      id: terminalId,
      projectId,
      title: 'shell',
      autoTitle: false,
      emoji: '⬛',
      color: '#22c55e',
      backgroundImage: null,
      backgroundOpacity: 0.2,
      backgroundBlur: 0,
      fontSize: null,
      cwd: projectPath,
      // Normally proves the shell is cmd.exe and that UTF-8 renders. With
      // --fake-notion it invokes claude instead, so the MCP attach path runs
      // and writes its --mcp-config file.
      command: fakeNotion ? 'claude --version' : 'echo FEATURE-TEST-OK && ver && chcp',
      presetId: null,
      shellId: null,
      createdAt: Date.now()
    }
  ],
  presets: [],
  settings: { autoStartTerminals: true, sidebarWidth: 250, statsIntervalMs: 2000 }
}

const leaf = (id, group) => ({
  type: 'leaf',
  data: { views: [id], activeView: id, id: group },
  size: 400
})

const layout = {
  grid: {
    root: {
      type: 'branch',
      data: [
        {
          // Stacked so files, ideas and watch are all visible at once.
          type: 'branch',
          data: [
            leaf(`files:${projectId}`, 'g1'),
            { type: 'leaf', data: { views: ['ideas'], activeView: 'ideas', id: 'g5' }, size: 300 },
            { type: 'leaf', data: { views: ['watch'], activeView: 'watch', id: 'g6' }, size: 240 }
          ],
          size: 340
        },
        { type: 'branch', data: [leaf(editorId, 'g2'), leaf(terminalId, 'g3')], size: 560 },
        {
          type: 'branch',
          data: [
            {
              type: 'leaf',
              data: {
                views: [`rojo:${projectId}`, `notion:${projectId}`, `discord:${projectId}`],
                activeView: fakeNotion ? `discord:${projectId}` : `rojo:${projectId}`,
                id: 'g4'
              },
              size: 400
            }
          ],
          size: 420
        }
      ],
      size: 800
    },
    width: 1240,
    height: 800,
    orientation: 'HORIZONTAL'
  },
  panels: {
    [`files:${projectId}`]: {
      id: `files:${projectId}`,
      contentComponent: 'files',
      tabComponent: 'props.defaultTabComponent',
      params: { projectId },
      title: '🎮 files'
    },
    [editorId]: {
      id: editorId,
      contentComponent: 'editor',
      tabComponent: 'props.defaultTabComponent',
      params: { projectId, root: projectPath, filePath: editorFile },
      title: 'default.project.json'
    },
    [terminalId]: {
      id: terminalId,
      contentComponent: 'terminal',
      tabComponent: 'props.defaultTabComponent',
      params: { terminalId },
      title: 'shell'
    },
    [`rojo:${projectId}`]: {
      id: `rojo:${projectId}`,
      contentComponent: 'rojo',
      tabComponent: 'props.defaultTabComponent',
      params: { projectId },
      title: '🧩 rojo'
    },
    [`notion:${projectId}`]: {
      id: `notion:${projectId}`,
      contentComponent: 'notion',
      tabComponent: 'props.defaultTabComponent',
      params: { projectId },
      title: '✅ tasks'
    },
    [`discord:${projectId}`]: {
      id: `discord:${projectId}`,
      contentComponent: 'discord',
      tabComponent: 'props.defaultTabComponent',
      params: { projectId },
      title: '🐛 reports'
    },
    ideas: {
      id: 'ideas',
      contentComponent: 'ideas',
      tabComponent: 'props.defaultTabComponent',
      params: {},
      title: '💡 ideas'
    },
    watch: {
      id: 'watch',
      contentComponent: 'watch',
      tabComponent: 'props.defaultTabComponent',
      params: {},
      title: '▶ watch'
    }
  },
  activeGroup: 'g2'
}

fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2))
fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(layout, null, 2))
if (fakeNotion) {
  // Both token readers treat a `plain:` prefixed file as verbatim text.
  fs.writeFileSync(path.join(dir, 'notion-token.bin'), 'plain:secret_not_a_real_token')
  fs.writeFileSync(path.join(dir, 'discord-token.bin'), 'plain:not_a_real_bot_token')
}
console.log(
  `seeded ${dir}\n  project: ${projectPath}\n  rojo port: ${rojoPort}` +
    (fakeNotion ? '\n  fake notion token + target written' : '')
)
