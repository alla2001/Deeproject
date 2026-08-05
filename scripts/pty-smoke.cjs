/* Standalone check that the prebuilt ConPTY binding loads and spawns. */
const pty = require('@lydell/node-pty')

const p = pty.spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', 'echo PTY_SMOKE_OK'], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
  useConpty: true
})

let out = ''
let done = false
p.onData((d) => {
  out += d
  if (!done && out.includes('PTY_SMOKE_OK')) {
    done = true
    console.log('SPAWN OK pid=' + p.pid)
    p.kill()
  }
})
p.onExit((e) => {
  console.log('EXIT code=' + e.exitCode)
  process.exit(done ? 0 : 1)
})
setTimeout(() => {
  console.log('TIMEOUT bytes=' + out.length + ' :: ' + JSON.stringify(out.slice(0, 200)))
  process.exit(1)
}, 10000)
