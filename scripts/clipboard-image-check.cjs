/**
 * Exercises the same clipboard-image path the app uses when you press Ctrl+V in
 * a terminal: read an image off the clipboard, write it to a PNG, print where.
 *
 *   node_modules\electron\dist\electron.exe scripts\clipboard-image-check.cjs
 */
const { app, clipboard } = require('electron')
const { mkdirSync, writeFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

app.whenReady().then(() => {
  const image = clipboard.readImage()
  if (image.isEmpty()) {
    console.log('RESULT: no image on the clipboard')
    app.exit(2)
    return
  }

  const size = image.getSize()
  const dir = join(app.getPath('userData'), 'pastes')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `paste-${Date.now()}.png`)
  writeFileSync(file, image.toPNG())
  console.log(`RESULT: saved ${size.width}x${size.height} to ${file}`)
  console.log(`BYTES: ${statSync(file).size}`)
  app.exit(0)
})
