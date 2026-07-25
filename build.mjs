// Concatenates src/*.js into the single self-contained deliverable, index.html.
//
//   node build.mjs [--watch]
//
// The modules share one function scope, so each source file must only assign onto
// the PI namespace object created in the preamble here. Order is the numeric
// filename prefix: content and utils first, then the engine, then gameplay.

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('.', import.meta.url).pathname)
const SRC = path.join(ROOT, 'src')
const OUT = path.join(ROOT, 'index.html')

const CSS = `
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #000;
  }
  body {
    display: block;
    -webkit-tap-highlight-color: transparent;
  }
  * {
    user-select: none;
    -webkit-user-select: none;
  }
  #game {
    display: block;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    outline: none;
    cursor: none;
    image-rendering: auto;
  }
`

function build() {
  if (!fs.existsSync(SRC)) throw new Error(`no src directory at ${SRC}`)

  const files = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.js'))
    .sort()

  if (!files.length) throw new Error('no source modules found')

  const parts = []
  for (const f of files) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8')
    if (!code.trim()) throw new Error(`${f} is empty`)
    parts.push(`/* ==== ${f} ==== */\n${code.trimEnd()}\n`)
  }

  const html = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PROMPT INJECTION</title>
<style>${CSS}</style>
<canvas id="game"></canvas>
<script>
(function () {
'use strict';
const PI = {};

${parts.join('\n')}

PI.Game.boot();
})();
</script>
`

  fs.writeFileSync(OUT, html)
  const kb = Buffer.byteLength(html) / 1024
  console.log(`built index.html — ${kb.toFixed(1)} KB from ${files.length} modules`)
  for (const f of files) {
    const lines = fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').length
    console.log(`  ${f.padEnd(18)} ${String(lines).padStart(5)} lines`)
  }
  if (kb > 100) console.log(`\nWARNING: over the 100 KB budget in DESIGN.md §14`)
  return html
}

build()

if (process.argv.includes('--watch')) {
  console.log('\nwatching src/ …')
  let timer = null
  fs.watch(SRC, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        build()
      } catch (e) {
        console.error('build failed:', e.message)
      }
    }, 80)
  })
}
