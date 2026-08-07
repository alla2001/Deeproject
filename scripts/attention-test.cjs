/**
 * Checks the rules that decide when a terminal is asking for you.
 *
 *   node scripts/attention-test.cjs
 *
 * The watcher is pure logic over output timing, CPU readings and focus, so it
 * runs under plain node with a fake clock -- no PTY, no Electron, and no
 * waiting six seconds per case.
 */
const { execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const outDir = join(root, 'node_modules', '.cache', 'attention-test')
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
      strict: true,
      baseUrl: root,
      paths: { '@shared/*': ['src/shared/*'] },
      typeRoots: [join(root, 'node_modules', '@types')],
      types: ['node']
    },
    files: [join(root, 'src', 'main', 'attention.ts')]
  })
)
execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfigPath],
  { stdio: 'inherit', cwd: root }
)

// ---- fake clock and timer --------------------------------------------------

let now = 1_700_000_000_000
const sweeps = []

Date.now = () => now
// The watcher schedules its sweep lazily, the first time a terminal produces
// output -- so these stay installed for the whole run, not just across the
// require. Driving the sweep by hand is what makes a six-second threshold cost
// no real time to test.
globalThis.setInterval = (fn) => {
  sweeps.push(fn)
  return { id: sweeps.length }
}
globalThis.clearInterval = (handle) => {
  if (handle && typeof handle === 'object') sweeps.length = 0
}

const { attentionWatcher: w } = require(join(outDir, 'main', 'attention.js'))

/** Advance the clock and run whatever sweeps the watcher had scheduled. */
function tick(ms) {
  now += ms
  for (const fn of [...sweeps]) fn()
}

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`
  )
}
const state = (id) => w.states()[id] ?? {}

// Nothing is being looked at, and the window is behind something else, unless a
// test says otherwise.
w.setIdleMs(6000)
w.setFocus(null, false)

console.log('a session that goes quiet is flagged')
w.onStatus('a', 'starting')
w.onStatus('a', 'running')
// Past the startup grace: this is a session that has been working, not one
// that has just printed a banner.
tick(20000)
w.onData('a', 'thinking about it\n')
w.onStats([{ terminalId: 'a', cpu: 40 }])
tick(3000)
check('still busy three seconds in', state('a').activity, 'busy')
check('and not asking for anything yet', state('a').needsYou, false)
tick(4000)
check('busy CPU keeps it from being called idle', state('a').needsYou, false)
w.onStats([{ terminalId: 'a', cpu: 0.2 }])
tick(1000)
check('quiet plus idle CPU flags it', state('a').needsYou, true)
check('and says why', state('a').reason, 'quiet')
check('with the last of its output', state('a').tail, 'thinking about it')
check('activity reads as waiting', state('a').activity, 'waiting')

console.log('\nlooking at it clears the flag')
w.setFocus('a', true)
check('cleared', state('a').needsYou, false)
check('and the reason with it', state('a').reason, null)

console.log('\nit does not re-flag while you are looking at it')
w.onData('a', 'more output\n')
tick(8000)
check('stays clear', state('a').needsYou, false)

console.log('\na window-title sequence is not a bell')
w.onStatus('t', 'starting')
w.onStatus('t', 'running')
// What ConPTY sends within a second of any shell starting. Its terminator is
// BEL, so a naive search finds a "bell" in every terminal ever opened.
w.onData('t', '\x1b]0;C:\\Windows\\system32\\cmd.exe\x07Microsoft Windows\r\n')
check('not treated as a request for attention', state('t').needsYou, false)
check('and the escape is kept out of the tail', state('t').tail, 'Microsoft Windows')

console.log('\nthe bell does not wait for the quiet period')
w.setFocus(null, false)
w.onStatus('b', 'running')
w.onData('b', 'Do you want to allow this?\x07')
check('flagged immediately', state('b').needsYou, true)
check('for the right reason', state('b').reason, 'bell')
check('and the bell is not left in the text', state('b').tail, 'Do you want to allow this?')

console.log('\nexiting after real work flags; an untouched shell does not')
w.onStatus('c', 'running')
w.onData('c', 'built ok\n')
w.onStatus('c', 'exited')
check('a run that produced output flags on exit', state('c').needsYou, true)
check('for the right reason', state('c').reason, 'exited')

w.onStatus('d', 'running')
w.onStatus('d', 'exited')
check('a run that never said anything stays silent', state('d').needsYou, false)

console.log('\nrestarting clears what the last run left behind')
w.onStatus('c', 'starting')
check('flag gone', state('c').needsYou, false)
check('tail gone', state('c').tail, '')

console.log('\nsilence alone is not enough without output')
w.onStatus('e', 'starting')
w.onStatus('e', 'running')
w.onStats([{ terminalId: 'e', cpu: 0 }])
tick(20000)
check('a shell sitting at a prompt is not "waiting on you"', state('e').needsYou, false)

console.log('\na shell that prints its banner and sits there is left alone')
w.onStatus('h', 'starting')
w.onStatus('h', 'running')
w.onData('h', 'Microsoft Windows [Version 10.0.26200]\r\nC:\\Users\\me>')
w.onStats([{ terminalId: 'h', cpu: 0 }])
tick(8000)
check('not flagged seconds after you opened the tab', state('h').needsYou, false)
tick(10000)
check('but a run that stays quiet past the grace is', state('h').needsYou, true)

console.log('\nwithout CPU readings it waits longer before speaking')
w.onStatus('f', 'starting')
w.onStatus('f', 'running')
tick(20000)
w.onData('f', 'working\n')
tick(6500)
check('the plain idle threshold is not enough on its own', state('f').needsYou, false)
tick(4000)
check('but it does get there', state('f').needsYou, true)

console.log('\nturning it off clears everything and stops flagging')
w.setIdleMs(0)
check('previous flags cleared', state('f').needsYou, false)
w.onStatus('g', 'running')
w.onData('g', 'hello\x07')
check('the bell is ignored too', state('g').needsYou, false)
tick(30000)
check('and so is going quiet', state('g').needsYou, false)

console.log('\ndisposing forgets a terminal')
w.setIdleMs(6000)
w.dispose('a')
check('gone from the report', state('a').activity, undefined)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
