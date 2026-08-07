/**
 * Checks that a docked window really owns the mouse and keyboard while its
 * panel is in front.
 *
 *   node_modules/electron/dist/electron.exe scripts/embed-input-test.cjs
 *
 * GetFocus reports the focused window *of the calling thread's input queue*.
 * Reading the embedded app's HWND back from our own thread is therefore only
 * possible when the two queues are attached — which is exactly the condition
 * Windows requires before it will let that window capture the mouse. So this
 * asserts the thing that makes drag-selection and mouse-look work, without
 * needing a human to drag anything.
 *
 * It has to run under Electron rather than plain node: AttachThreadInput only
 * works between threads that own message queues, and a bare node process has
 * none — the call would fail for reasons that say nothing about the code.
 */
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

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
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfigPath],
  { stdio: 'inherit', cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
)
const { embedManager } = require(join(outDir, 'main', 'embed.js'))

const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const GetFocus = user32.func('int64_t __stdcall GetFocus()')
const IsChild = user32.func('bool __stdcall IsChild(int64_t parent, int64_t h)')
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(int64_t h)')

/**
 * True when keyboard focus is inside the embedded application.
 *
 * Not simply `GetFocus() === hwnd`: an app handed focus usually passes it
 * straight to one of its own controls, so the honest question is whether the
 * focused window is that app's, not whether it is its outermost frame.
 */
function focusInside(hwnd) {
  const focused = Number(GetFocus())
  return focused !== 0 && (focused === hwnd || Boolean(IsChild(hwnd, focused)))
}

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` (got ${actual}, want ${expected})`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(win) {
  const raw = win.getNativeWindowHandle()
  const parent = raw.length >= 8 ? Number(raw.readBigUInt64LE(0)) : raw.readUInt32LE(0)

  const hwnd = await embedManager.launch('C:\\Windows\\System32\\charmap.exe')
  const child = hwnd && embedManager.list().find((w) => w.hwnd === hwnd)
  if (!child) throw new Error('Character Map did not put up a window.')

  console.log(`parent : hwnd ${parent}`)
  console.log(`child  : ${child.title} (hwnd ${child.hwnd}, pid ${child.pid})\n`)

  const result = embedManager.attach(child.hwnd, parent)
  if (!result.ok) throw new Error(`attach failed: ${result.error}`)
  embedManager.setBounds(child.hwnd, { x: 40, y: 40, width: 700, height: 500 })
  // Focus and capture only mean anything below a foreground window.
  SetForegroundWindow(parent)
  await sleep(400)

  console.log('input sharing:')
  embedManager.focus(child.hwnd)
  check('the docked app holds focus in our own queue', focusInside(child.hwnd), true)

  embedManager.blur(child.hwnd)
  check('focus is given up when the panel goes to the back', focusInside(child.hwnd), false)

  console.log('\nsuspend and restore around window focus:')
  embedManager.focus(child.hwnd)
  embedManager.suspendInput()
  check('dropped while we are in the background', focusInside(child.hwnd), false)
  embedManager.refocus()
  check('restored when we come back', focusInside(child.hwnd), true)

  console.log('\nundocking releases it:')
  embedManager.detach(child.hwnd)
  check('nothing held after detach', focusInside(child.hwnd), false)

  try {
    process.kill(child.pid)
  } catch {
    /* already gone */
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 640, show: true })
  await sleep(600)
  try {
    await run(win)
  } catch (err) {
    console.error(String(err))
    failures++
  }
  embedManager.detachAll()
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  app.exit(failures === 0 ? 0 : 1)
})
