/**
 * Writes a throwaway userData profile containing one project, four terminals
 * and a pre-built 2x2 dock layout. Used to verify grid docking, layout restore
 * and several concurrent PTYs without touching the real profile.
 *
 *   node scripts/seed-test-profile.cjs <profileDir>
 */
const fs = require('node:fs')
const path = require('node:path')

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/seed-test-profile.cjs <profileDir>')
  process.exit(1)
}
fs.mkdirSync(dir, { recursive: true })

const repo = path.resolve(__dirname, '..')
const wallpaper = 'C:\\Windows\\Web\\Wallpaper\\Spotlight\\img14.jpg'
const hasWallpaper = fs.existsSync(wallpaper)

const projectId = 'p-test-0001'
const specs = [
  { id: 't-0001', title: 'pane one', emoji: '🤖', color: '#d97757', cmd: 'echo PANE-ONE-OK; git --version' },
  { id: 't-0002', title: 'pane two', emoji: '⚡', color: '#7c8cff', cmd: 'echo PANE-TWO-OK; node --version' },
  { id: 't-0003', title: 'pane three', emoji: '🌊', color: '#22c55e', cmd: 'echo PANE-THREE-OK; Get-ChildItem src | Select-Object -First 4 Name' },
  { id: 't-0004', title: 'pane four', emoji: '💀', color: '#f43f5e', cmd: 'echo PANE-FOUR-OK; whoami' }
]

const state = {
  projects: [
    {
      id: projectId,
      name: 'Deeproject',
      path: repo,
      color: '#8b5cf6',
      emoji: '📁',
      backgroundImage: null,
      backgroundOpacity: 0.18,
      backgroundBlur: 0,
      order: 0,
      collapsed: false,
      createdAt: Date.now(),
      lastOpenedAt: Date.now()
    }
  ],
  terminals: specs.map((s, i) => ({
    id: s.id,
    projectId,
    title: s.title,
    autoTitle: false,
    emoji: s.emoji,
    color: s.color,
    // Only the last pane gets an image, so both render paths are exercised.
    backgroundImage: i === 3 && hasWallpaper ? wallpaper : null,
    backgroundOpacity: 0.25,
    backgroundBlur: 2,
    fontSize: null,
    cwd: repo,
    command: s.cmd,
    presetId: null,
    shellId: null,
    createdAt: Date.now()
  })),
  presets: [],
  settings: { autoStartTerminals: true, sidebarWidth: 240 }
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
        { type: 'branch', data: [leaf('t-0001', 'g1'), leaf('t-0003', 'g3')], size: 590 },
        { type: 'branch', data: [leaf('t-0002', 'g2'), leaf('t-0004', 'g4')], size: 590 }
      ],
      size: 800
    },
    width: 1180,
    height: 800,
    orientation: 'HORIZONTAL'
  },
  panels: Object.fromEntries(
    specs.map((s) => [
      s.id,
      {
        id: s.id,
        contentComponent: 'terminal',
        tabComponent: 'props.defaultTabComponent',
        params: { terminalId: s.id },
        title: s.title
      }
    ])
  ),
  activeGroup: 'g1'
}

fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2))
fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(layout, null, 2))
console.log('seeded ' + dir + (hasWallpaper ? ' (with wallpaper)' : ' (no wallpaper found)'))
