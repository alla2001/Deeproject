/**
 * End-to-end check of the window-docking mechanism, without the UI.
 *
 *   node scripts/embed-attach-test.cjs <parentPid> <childTitleMatch>
 *
 * Compiles src/main/embed.ts on its own (it deliberately imports nothing from
 * electron), docks the matching window into the window owned by <parentPid>,
 * resizes it, then hands it back — asserting the parent and the window styles
 * at each step. Run it against a spare Deeproject instance and a throwaway app:
 *
 *   node scripts/embed-attach-test.cjs 1234 "Character Map"
 */
const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const [, , parentPidArg, titleMatch = 'Character Map'] = process.argv
const parentPid = Number(parentPidArg)
if (!parentPid) {
  console.error('usage: node scripts/embed-attach-test.cjs <parentPid> [childTitleMatch]')
  process.exit(2)
}

// --- build the module under test -------------------------------------------
const root = resolve(__dirname, '..')
// Inside the repo rather than %TEMP%, so the compiled module's require('koffi')
// resolves against the project's own node_modules.
const outDir = join(root, 'node_modules', '.cache', 'embed-test')
mkdirSync(outDir, { recursive: true })
// A generated tsconfig rather than CLI flags, because the @shared path mapping
// cannot be expressed on the command line.
const tsconfigPath = join(outDir, 'tsconfig.json')
writeFileSync(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      outDir,
      // The @shared type import pulls src/shared into the program, so src/ is
      // the common root and the output lands under <outDir>/main/.
      rootDir: join(root, 'src'),
      module: 'commonjs',
      target: 'es2022',
      moduleResolution: 'node',
      skipLibCheck: true,
      esModuleInterop: true,
      baseUrl: root,
      paths: { '@shared/*': ['src/shared/*'] },
      // The generated config lives in a temp directory, so @types has to be
      // pointed at explicitly rather than found by walking upwards.
      typeRoots: [join(root, 'node_modules', '@types')],
      types: ['node']
    },
    files: [join(root, 'src', 'main', 'embed.ts')]
  })
)
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', tsconfigPath], {
  stdio: 'inherit',
  cwd: root
})
const { embedManager } = require(join(outDir, 'main', 'embed.js'))

// --- independent observers, so we assert on Windows rather than on ourselves -
const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const GetParent = user32.func('int64_t __stdcall GetParent(int64_t hWnd)')
const GetWindowLongPtrW = user32.func('int64_t __stdcall GetWindowLongPtrW(int64_t h, int i)')
const GetClipCursor = user32.func('bool __stdcall GetClipCursor(void *rect)')
const GetWindowRectRaw = user32.func('bool __stdcall GetWindowRect(int64_t h, void *rect)')

function readRect(fn, arg) {
  const buf = Buffer.alloc(16)
  const ok = arg === undefined ? fn(buf) : fn(arg, buf)
  if (!ok) return null
  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12)
  }
}

/**
 * True when the cursor is fenced to exactly this window.
 *
 * Testing "is the clip smaller than the desktop" does not work: an unclipped
 * cursor reports the monitor rectangle, which is the same order of size as a
 * docked panel. Comparing against the window's own rect is unambiguous.
 */
function clippedTo(hwnd) {
  const clip = readRect(GetClipCursor)
  const win = readRect(GetWindowRectRaw, hwnd)
  if (!clip || !win) return false
  return (
    clip.left === win.left &&
    clip.top === win.top &&
    clip.right === win.right &&
    clip.bottom === win.bottom
  )
}
const GWL_STYLE = -16
const WS_CHILD = 0x40000000

const WS_MINIMIZE = 0x20000000
const WS_MAXIMIZE = 0x01000000

function styleOf(hwnd) {
  return Number(GetWindowLongPtrW(hwnd, GWL_STYLE)) >>> 0
}

/**
 * Compare styles without the minimised/maximised bits. Docking deliberately
 * normalises a window's state, and undocking brings it back on screen rather
 * than to the taskbar, so those two bits legitimately differ across the trip.
 */
function shapeOf(hwnd) {
  return (styleOf(hwnd) & ~(WS_MINIMIZE | WS_MAXIMIZE)) >>> 0
}

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` (got ${actual}, want ${expected})`}`)
}

if (!embedManager.available()) {
  console.error('FFI unavailable:', embedManager.unavailableReason())
  process.exit(1)
}

const windows = embedManager.list()
const parent = windows.find((w) => w.pid === parentPid)
const child = windows.find((w) => w.title.toLowerCase().includes(titleMatch.toLowerCase()))

if (!parent) {
  console.error(`No window found for pid ${parentPid}.`)
  process.exit(1)
}
if (!child) {
  console.error(`No window whose title contains "${titleMatch}".`)
  process.exit(1)
}

console.log(`parent : ${parent.title}  (hwnd ${parent.hwnd}, pid ${parent.pid})`)
console.log(`child  : ${child.title}  (hwnd ${child.hwnd}, pid ${child.pid})\n`)

const originalStyle = shapeOf(child.hwnd)
const originalParent = GetParent(child.hwnd)

console.log('attach:')
const result = embedManager.attach(child.hwnd, parent.hwnd)
check('attach reported ok', result.ok, true)
if (!result.ok) {
  console.error(result.error)
  process.exit(1)
}
check('parent is now the host window', GetParent(child.hwnd), parent.hwnd)
check('WS_CHILD is set', (styleOf(child.hwnd) & WS_CHILD) >>> 0, WS_CHILD)

console.log('\nbounds:')
embedManager.setBounds(child.hwnd, { x: 340, y: 60, width: 900, height: 700 })
const placed = readRect(GetWindowRectRaw, child.hwnd)
check('window is 900 wide where it was put', placed && placed.right - placed.left, 900)
check('window is 700 tall where it was put', placed && placed.bottom - placed.top, 700)

console.log('\nmouse capture:')
check('nothing is confined to begin with', clippedTo(child.hwnd), false)
check('capture reported ok', embedManager.captureMouse(child.hwnd), true)
check('cursor is fenced to the docked window', clippedTo(child.hwnd), true)
check('manager knows who holds it', embedManager.capturedWindow(), child.hwnd)

embedManager.releaseMouse()
check('cursor freed on release', clippedTo(child.hwnd), false)
check('manager no longer holds it', embedManager.capturedWindow(), null)

// The dangerous case: capture, then let go of the window without releasing
// first. Detach has to free the cursor on the way out.
embedManager.captureMouse(child.hwnd)
check('confined again before the detach test', clippedTo(child.hwnd), true)

// Leave it docked briefly so a screenshot taken alongside catches it.
const holdMs = Number(process.env.EMBED_TEST_HOLD_MS ?? 6000)
setTimeout(() => {
  console.log('\ndetach:')
  const detached = embedManager.detach(child.hwnd)
  check('detach reported ok', detached, true)
  check('detach freed the captured cursor', clippedTo(child.hwnd), false)
  check('parent restored to the desktop', GetParent(child.hwnd), originalParent)
  check('style restored', shapeOf(child.hwnd), originalStyle)

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}, holdMs)
