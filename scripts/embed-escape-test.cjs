/**
 * Checks the two things `attach` newly promises: that it refuses to report
 * success unless the window really became our child, and that an application
 * which pulls itself back out to the desktop gets put back.
 *
 *   node scripts/embed-escape-test.cjs <parentPid>
 *
 * Spawns its own Notepad as the guinea pig, so nothing the user is working in
 * is touched. The escape is simulated with a direct SetParent(hwnd, 0) from
 * outside the manager — which is exactly what a toolkit reconciling its own
 * window hierarchy does to us.
 */
const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const parentPid = Number(process.argv[2])
if (!parentPid) {
  console.error('usage: node scripts/embed-escape-test.cjs <parentPid>')
  process.exit(2)
}

const root = resolve(__dirname, '..')
const outDir = join(root, 'node_modules', '.cache', 'embed-test')
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
      baseUrl: root,
      paths: { '@shared/*': ['src/shared/*'] },
      typeRoots: [join(root, 'node_modules', '@types')],
      types: ['node']
    },
    files: [join(root, 'src', 'main', 'embed.ts')]
  })
)
// tsc is run through its JS entry point rather than the .cmd shim, which Node
// refuses to spawn without a shell since v20.
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfigPath], {
  stdio: 'inherit',
  cwd: root
})
const { embedManager } = require(join(outDir, 'main', 'embed.js'))

const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const GetAncestor = user32.func('int64_t __stdcall GetAncestor(int64_t hWnd, uint32_t f)')
const SetParent = user32.func('int64_t __stdcall SetParent(int64_t c, int64_t p)')

/**
 * The window's real parent. GetParent is no use here: it answers NULL for
 * anything without WS_CHILD, so it cannot distinguish "loose on the desktop"
 * from "reparented but not yet restyled".
 */
const GA_PARENT = 1
const parentOf = (h) => Number(GetAncestor(h, GA_PARENT))
const desktop = Number(user32.func('int64_t __stdcall GetDesktopWindow()')())

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` (got ${actual}, want ${expected})`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!embedManager.available()) {
    console.error('FFI unavailable:', embedManager.unavailableReason())
    process.exit(1)
  }

  const parent = embedManager.list().find((w) => w.pid === parentPid)
  if (!parent) {
    console.error(`No window found for pid ${parentPid}.`)
    process.exit(1)
  }

  // Character Map rather than Notepad: it is still a plain Win32 program on
  // Windows 11, where Notepad is a Store app whose window belongs to a process
  // other than the one we spawned.
  const hwnd = await embedManager.launch('C:\\Windows\\System32\\charmap.exe')
  if (!hwnd) {
    console.error('Character Map did not put up a window.')
    process.exit(1)
  }
  const child = embedManager.list().find((w) => w.hwnd === hwnd)
  if (!child) {
    console.error('The launched window is not in the candidate list.')
    process.exit(1)
  }

  console.log(`parent : ${parent.title} (hwnd ${parent.hwnd})`)
  console.log(`child  : ${child.title} (hwnd ${child.hwnd}, pid ${child.pid})\n`)

  console.log('attach:')
  const result = embedManager.attach(child.hwnd, parent.hwnd)
  check('attach reported ok', result.ok, true)
  if (!result.ok) {
    console.error(' ', result.error)
    try {
      process.kill(child.pid)
    } catch {
      /* already gone */
    }
    process.exit(1)
  }
  check('parent is the host window', parentOf(child.hwnd), parent.hwnd)

  embedManager.setBounds(child.hwnd, { x: 200, y: 80, width: 800, height: 600 })

  console.log('\nescape and recovery:')
  // Impersonate a toolkit reconciling its own hierarchy.
  SetParent(child.hwnd, 0)
  check('window escaped to the desktop', parentOf(child.hwnd), desktop)
  // The watchdog ticks once a second; give it two.
  await sleep(2200)
  check('watchdog pulled it back in', parentOf(child.hwnd), parent.hwnd)

  console.log('\nrepeated escape is given up on:')
  let escapedEvent = null
  embedManager.on('escaped', (hwnd) => (escapedEvent = hwnd))
  for (let i = 0; i < 6; i++) {
    SetParent(child.hwnd, 0)
    await sleep(1100)
  }
  check('gave up rather than fighting forever', escapedEvent, child.hwnd)
  check('window was left on the desktop', parentOf(child.hwnd), desktop)

  console.log('\nattach refuses a dead window:')
  const bad = embedManager.attach(0x7fffffff, parent.hwnd)
  check('reported failure', bad.ok, false)

  embedManager.detachAll()
  try {
    process.kill(child.pid)
  } catch {
    /* already gone */
  }
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
