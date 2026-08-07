/**
 * Bare SetParent, with nothing else in the way.
 *
 *   node scripts/setparent-probe.cjs <parentHwnd> <childHwnd>
 *
 * Exists to tell a Windows refusal apart from a bug in our own wrapper: it
 * calls the API directly and prints what Windows reports before and after.
 */
const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

const SetParent = user32.func('int64_t __stdcall SetParent(int64_t c, int64_t p)')
const GetParent = user32.func('int64_t __stdcall GetParent(int64_t h)')
const IsWindow = user32.func('bool __stdcall IsWindow(int64_t h)')
const GetWindowLongPtrW = user32.func('int64_t __stdcall GetWindowLongPtrW(int64_t h, int i)')
const SetLastError = kernel32.func('void __stdcall SetLastError(uint32_t code)')
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()')

const parent = Number(process.argv[2])
const child = Number(process.argv[3])
if (!parent || !child) {
  console.error('usage: node scripts/setparent-probe.cjs <parentHwnd> <childHwnd>')
  process.exit(2)
}

console.log('parent alive:', IsWindow(parent), ' child alive:', IsWindow(child))
console.log('child style before: 0x' + (Number(GetWindowLongPtrW(child, -16)) >>> 0).toString(16))
console.log('child parent before:', Number(GetParent(child)))

// Clearing it first means a nonzero value afterwards genuinely came from this call.
SetLastError(0)
const prev = SetParent(child, parent)
const err = Number(GetLastError())
console.log('SetParent returned:', Number(prev), ' GetLastError:', err)
console.log('child parent after:', Number(GetParent(child)))

// Put it straight back so nothing is left hanging off another process's window.
SetParent(child, 0)
console.log('restored parent:', Number(GetParent(child)))
