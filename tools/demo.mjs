// Records an autoplay demo of the game and produces a loopable GIF (for social posts)
// plus the raw .webm.
//
//   node tools/demo.mjs [--seconds 18] [--width 480] [--fps 12] [--headed]
//
// A scripted bot plays the game through the real keyboard event path — it reads
// window.__PI to decide what to type, so it never typos and builds a clean combo.
// Capture uses Playwright's compositor screencast rather than in-page pixel readback,
// so recording does not perturb the game's frame timing.
//
// Dependency notes: Playwright's bundled ffmpeg is a stripped build (vp8/png only, and
// only the pad/crop/scale filters), so frame-rate changes go through -r, and the GIF is
// written by this repo's own encoder in tools/gif.mjs.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { decodePngToRgb } from './png.mjs'
import { encodeGif } from './gif.mjs'

const FFMPEG = '/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux'
const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const OUT = path.join(ROOT, 'tools', 'shots')
const INDEX = path.join(ROOT, 'index.html')

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const SECONDS = Number(arg('seconds', 18))
const GIF_WIDTH = Number(arg('width', 480))
const GIF_FPS = Number(arg('fps', 12))
const HEADED = Boolean(arg('headed', false))
const SKIP_HEAD = 1.5 // drop the first moments so the GIF opens on action

// Playwright's keyboard wants key names, not characters, for the non-alphanumerics.
const KEYMAP = { ' ': 'Space', '=': 'Equal', '-': 'Minus', "'": "Quote" }
const keyFor = (ch) => KEYMAP[ch] || ch

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!fs.existsSync(INDEX)) {
  console.error(`No index.html at ${INDEX} — run "node build.mjs" first.`)
  process.exit(1)
}

fs.mkdirSync(OUT, { recursive: true })
const vidDir = path.join(OUT, '.video')
fs.rmSync(vidDir, { recursive: true, force: true })

const browser = await chromium.launch({ headless: !HEADED, args: ['--mute-audio'] })
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: vidDir, size: { width: 1280, height: 720 } },
  deviceScaleFactor: 1,
})
const page = await ctx.newPage()

const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push('console: ' + m.text())
})

await page.goto('file://' + INDEX)
await page.waitForFunction('window.__PI && window.__PI.state', null, { timeout: 15000 })

const dbg = () =>
  page.evaluate(() => ({
    state: window.__PI.state(),
    score: window.__PI.score(),
    combo: window.__PI.combo(),
    flow: window.__PI.flow(),
    integrity: window.__PI.integrity(),
    wave: window.__PI.wave(),
    boss: window.__PI.boss(),
    enemies: window.__PI.enemies(),
    target: window.__PI.target(),
  }))

// Choose the next character to type so the bot always agrees with the game's own
// targeting rule (nearest the bottom wins; boss words go left to right).
function nextChar(s) {
  const live = s.enemies.filter((e) => e.typed < e.word.length)
  if (!live.length) return null

  if (s.target) {
    const t = live.find((e) => e.word === s.target)
    if (t) return t.word[t.typed]
  }

  const bossWords = live.filter((e) => e.kind === 'bossword')
  if (bossWords.length) {
    const leftmost = bossWords.reduce((a, b) => (a.x <= b.x ? a : b))
    return leftmost.word[leftmost.typed]
  }

  // Golden system commands are the best-looking moments in the game — grab them.
  const command = live.find((e) => e.kind === 'command')
  if (command) return command.word[command.typed]

  const lowest = live.reduce((a, b) => (a.y >= b.y ? a : b))
  return lowest.word[lowest.typed]
}

console.log('recording an autoplay session…')

// Start the run: the title screen carries a tutorial enemy, so typing it begins wave 1.
await page.keyboard.press('Enter')
await sleep(300)
if ((await dbg()).state !== 'PLAYING') {
  for (const ch of 'start') {
    await page.keyboard.press(keyFor(ch))
    await sleep(70)
  }
  await sleep(400)
}
if ((await dbg()).state !== 'PLAYING') {
  await page.keyboard.press('Enter')
  await sleep(300)
}

const t0 = Date.now()
let bossJumped = false
let nudgedFlow = false
const timeline = []

while ((Date.now() - t0) / 1000 < SECONDS) {
  const elapsed = (Date.now() - t0) / 1000
  const s = await dbg()

  if (s.state !== 'PLAYING') break

  // Mid-clip: jump to a boss wave so the recording shows the boss choreography.
  if (!bossJumped && elapsed > SECONDS * 0.55) {
    bossJumped = true
    const target = s.wave <= 5 ? 5 : Math.ceil((s.wave + 1) / 5) * 5
    await page.evaluate((w) => window.__PI.setWave(w), target)
    timeline.push(`${elapsed.toFixed(1)}s jumped to boss wave ${target}`)
    await sleep(250)
    continue
  }

  // The bot is fast, but 25 kills for flow state may not land inside a short clip.
  if (!nudgedFlow && !s.flow && elapsed > SECONDS * 0.3 && s.combo < 24) {
    nudgedFlow = true
    await page.evaluate(() => window.__PI.setCombo(24))
    timeline.push(`${elapsed.toFixed(1)}s combo nudged to 24 to reach flow state in-clip`)
  }

  const ch = nextChar(s)
  if (!ch) {
    await sleep(40)
    continue
  }
  await page.keyboard.press(keyFor(ch))
  // Human-ish cadence: fast, slightly irregular.
  await sleep(48 + Math.random() * 34)
}

const final = await dbg()
timeline.push(
  `final: score=${final.score} combo=${final.combo} wave=${final.wave} integrity=${final.integrity} flow=${final.flow}`
)
console.log(timeline.map((l) => '  ' + l).join('\n'))
if (pageErrors.length) {
  console.log('\n!! page errors during the demo:')
  for (const e of pageErrors.slice(0, 10)) console.log('  ' + e)
}

await ctx.close()
await browser.close()

const webmName = fs.readdirSync(vidDir).find((f) => f.endsWith('.webm'))
if (!webmName) {
  console.error('Playwright produced no video')
  process.exit(1)
}
const webm = path.join(OUT, 'demo.webm')
fs.copyFileSync(path.join(vidDir, webmName), webm)
fs.rmSync(vidDir, { recursive: true, force: true })
console.log(`\nwebm: ${webm} (${(fs.statSync(webm).size / 1e6).toFixed(2)} MB)`)

const frameDir = path.join(OUT, '.frames')
fs.rmSync(frameDir, { recursive: true, force: true })
fs.mkdirSync(frameDir, { recursive: true })
execFileSync(
  FFMPEG,
  [
    '-ss', String(SKIP_HEAD),
    '-i', webm,
    '-vf', `scale=${GIF_WIDTH}:-2`,
    '-r', String(GIF_FPS),
    '-y', path.join(frameDir, 'f%04d.png'),
  ],
  { stdio: 'pipe' }
)

const files = fs.readdirSync(frameDir).filter((f) => f.endsWith('.png')).sort()
const frames = []
let w = 0
let h = 0
for (const f of files) {
  const d = decodePngToRgb(fs.readFileSync(path.join(frameDir, f)))
  w = d.width
  h = d.height
  frames.push(d.rgb)
}
fs.rmSync(frameDir, { recursive: true, force: true })

const gif = encodeGif({ frames, width: w, height: h, delayMs: Math.round(1000 / GIF_FPS) })
const gifPath = path.join(OUT, 'demo.gif')
fs.writeFileSync(gifPath, gif)
console.log(
  `gif:  ${gifPath} (${w}x${h}, ${frames.length} frames @ ${GIF_FPS}fps, ${(gif.length / 1e6).toFixed(2)} MB)`
)
if (gif.length > 8e6) {
  console.log('note: over 8 MB — re-run with --width 400 --fps 10 for a smaller file')
}
process.exit(pageErrors.length ? 1 : 0)
