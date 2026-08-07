/**
 * Proves the window-embedding FFI works on this machine: enumerates every
 * top-level window koffi can see, with its pid and owning executable.
 *
 *   node scripts/embed-smoke.cjs
 *
 * Nothing is reparented here — this only exercises the read-only half of the
 * user32 surface that src/main/embed.ts relies on.
 */
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

// HWNDs are declared as int64 rather than `void *` so they cross the IPC
// boundary as plain numbers; every real handle fits in a double.
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(int64_t hwnd, int64_t lParam)')

const EnumWindows = user32.func(
  'bool __stdcall EnumWindows(EnumWindowsProc *proc, int64_t lParam)'
)
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(int64_t hWnd)')
const GetWindowTextW = user32.func(
  'int __stdcall GetWindowTextW(int64_t hWnd, void *lpString, int nMaxCount)'
)
const GetClassNameW = user32.func(
  'int __stdcall GetClassNameW(int64_t hWnd, void *lpClassName, int nMaxCount)'
)
const GetWindowThreadProcessId = user32.func(
  'uint32_t __stdcall GetWindowThreadProcessId(int64_t hWnd, void *lpdwProcessId)'
)

const OpenProcess = kernel32.func(
  'int64_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'
)
const QueryFullProcessImageNameW = kernel32.func(
  'bool __stdcall QueryFullProcessImageNameW(int64_t h, uint32_t flags, void *buf, void *size)'
)
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(int64_t h)')

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

function wide(bytes) {
  return Buffer.alloc(bytes)
}

function decode(buf, chars) {
  return buf.toString('ucs2', 0, chars * 2)
}

function windowText(hwnd) {
  const buf = wide(1024)
  const n = GetWindowTextW(hwnd, buf, 512)
  return n > 0 ? decode(buf, n) : ''
}

function className(hwnd) {
  const buf = wide(512)
  const n = GetClassNameW(hwnd, buf, 256)
  return n > 0 ? decode(buf, n) : ''
}

function pidOf(hwnd) {
  const out = Buffer.alloc(4)
  GetWindowThreadProcessId(hwnd, out)
  return out.readUInt32LE(0)
}

function exeOf(pid) {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle || handle === 0) return ''
  try {
    const buf = wide(2048)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(1024, 0)
    if (!QueryFullProcessImageNameW(handle, 0, buf, size)) return ''
    return decode(buf, size.readUInt32LE(0))
  } finally {
    CloseHandle(handle)
  }
}

const rows = []
const cb = koffi.register((hwnd) => {
  if (!IsWindowVisible(hwnd)) return true
  const title = windowText(hwnd)
  if (!title.trim()) return true
  const pid = pidOf(hwnd)
  rows.push({ hwnd, pid, title, cls: className(hwnd), exe: exeOf(pid) })
  return true
}, koffi.pointer(EnumWindowsProc))

try {
  EnumWindows(cb, 0)
} finally {
  koffi.unregister(cb)
}

console.log(`${rows.length} visible top-level windows with a title:\n`)
for (const r of rows.slice(0, 40)) {
  const exe = r.exe ? r.exe.split(/[\\/]/).pop() : '?'
  console.log(
    `  hwnd=${String(r.hwnd).padStart(10)}  pid=${String(r.pid).padStart(6)}  ` +
      `${exe.padEnd(24)} [${r.cls.slice(0, 22).padEnd(22)}] ${r.title.slice(0, 50)}`
  )
}
if (rows.length > 40) console.log(`  … and ${rows.length - 40} more`)
