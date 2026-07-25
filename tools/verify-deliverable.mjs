// Independent acceptance gate for the shipped artifact.
//
//   node tools/verify-deliverable.mjs
//
// Deliberately written apart from the build and QA scripts: it checks the hard,
// non-negotiable claims about index.html (single file, no network, self-contained,
// boots clean, actually playable, survives an iframe) by exercising the built file
// rather than by reading the source that produced it.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { decodePngToRgb } from './png.mjs'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const INDEX = path.join(ROOT, 'index.html')
const MAX_BYTES = 100 * 1024

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const KEYMAP = { ' ': 'Space', '=': 'Equal', '-': 'Minus', "'": 'Quote' }
const keyFor = (ch) => KEYMAP[ch] || ch

if (!fs.existsSync(INDEX)) {
  console.error(`No index.html at ${INDEX} — run "node build.mjs" first.`)
  process.exit(1)
}

// ---------- static checks on the artifact ----------
const html = fs.readFileSync(INDEX, 'utf8')
const bytes = Buffer.byteLength(html)
check('single file under 100KB', bytes <= MAX_BYTES, `${(bytes / 1024).toFixed(1)} KB`)

const externalPatterns = [
  [/<script[^>]+\ssrc=/i, '<script src=>'],
  [/<link[^>]+\shref=/i, '<link href=>'],
  [/https?:\/\//i, 'absolute http(s) URL'],
  [/@font-face/i, '@font-face'],
  [/\bfetch\s*\(/i, 'fetch()'],
  [/XMLHttpRequest/i, 'XMLHttpRequest'],
  [/\bimport\s*\(/i, 'dynamic import()'],
  [/window\.top|parent\./i, 'frame-busting / parent access'],
]
const offenders = externalPatterns.filter(([re]) => re.test(html)).map(([, label]) => label)
check('no external references in source', offenders.length === 0, offenders.join(', ') || 'clean')

const scriptTags = (html.match(/<script/gi) || []).length
check('exactly one inline script tag', scriptTags === 1, `${scriptTags} found`)

// ---------- runtime checks ----------
const browser = await chromium.launch({ args: ['--mute-audio'] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

const offNetwork = []
const consoleErrors = []
const pageErrors = []
page.on('request', (r) => {
  if (!r.url().startsWith('file://') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) {
    offNetwork.push(r.url())
  }
})
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
page.on('pageerror', (e) => pageErrors.push(String(e)))

await page.goto('file://' + INDEX)
await page.waitForFunction('window.__PI && window.__PI.state', null, { timeout: 15000 })
await sleep(1200)

check('zero non-local requests', offNetwork.length === 0, offNetwork.slice(0, 3).join(', ') || 'none')
check('boots to TITLE', (await page.evaluate(() => window.__PI.state())) === 'TITLE')
check('no page errors on boot', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'none')
check('no console errors on boot', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || 'none')

// Title screen must actually render something — a black canvas means a silent failure.
{
  const shot = await page.screenshot({ type: 'png' })
  const { rgb } = decodePngToRgb(shot)
  let lit = 0
  const colours = new Set()
  for (let i = 0; i < rgb.length; i += 3 * 97) {
    const sum = rgb[i] + rgb[i + 1] + rgb[i + 2]
    if (sum > 90) lit++
    colours.add((rgb[i] >> 4) * 289 + (rgb[i + 1] >> 4) * 17 + (rgb[i + 2] >> 4))
  }
  check('title screen renders content', lit > 40 && colours.size > 6, `${lit} lit samples, ${colours.size} distinct colours`)
}

// ---------- play it ----------
const dbg = () =>
  page.evaluate(() => ({
    state: window.__PI.state(),
    score: window.__PI.score(),
    combo: window.__PI.combo(),
    integrity: window.__PI.integrity(),
    wave: window.__PI.wave(),
    boss: window.__PI.boss(),
    enemies: window.__PI.enemies(),
    target: window.__PI.target(),
    errors: window.__PI.errors,
  }))

await page.keyboard.press('Enter')
await sleep(400)
if ((await dbg()).state !== 'PLAYING') {
  for (const ch of 'start') {
    await page.keyboard.press(keyFor(ch))
    await sleep(70)
  }
  await sleep(500)
}
check('a run starts', (await dbg()).state === 'PLAYING')

// Bot that agrees with the game's targeting rule, so a miss means a real defect.
async function playFor(seconds) {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const s = await dbg()
    if (s.state !== 'PLAYING') return s
    const live = s.enemies.filter((e) => e.typed < e.word.length)
    if (!live.length) {
      await sleep(40)
      continue
    }
    let pick
    if (s.target) pick = live.find((e) => e.word === s.target)
    if (!pick) {
      const bw = live.filter((e) => e.kind === 'bossword')
      pick = bw.length
        ? bw.reduce((a, b) => (a.x <= b.x ? a : b))
        : live.reduce((a, b) => (a.y >= b.y ? a : b))
    }
    await page.keyboard.press(keyFor(pick.word[pick.typed]))
    await sleep(55)
  }
  return dbg()
}

const afterPlay = await playFor(12)
check('scoring works', afterPlay.score > 0, `score ${afterPlay.score}, combo ${afterPlay.combo}`)
check('waves advance or hold', afterPlay.wave >= 1, `wave ${afterPlay.wave}`)

// Boss reachable and killable.
await page.evaluate(() => window.__PI.setWave(5))
await sleep(1800)
const bossState = await dbg()
check('boss wave spawns a boss', bossState.boss === true, `boss=${bossState.boss}`)
const beforeBoss = bossState.score
await playFor(14)
const afterBoss = await dbg()
check('boss can be damaged/killed', afterBoss.score > beforeBoss, `score ${beforeBoss} -> ${afterBoss.score}`)

// Performance under the spec's stated load.
await page.evaluate(() => {
  for (let i = 0; i < 30; i++) window.__PI.spawn('token')
  window.__PI.stress(300)
})
const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const ts = []
      let last = performance.now()
      let n = 0
      const tick = (t) => {
        ts.push(t - last)
        last = t
        if (++n < 180) requestAnimationFrame(tick)
        else {
          const sorted = ts.slice().sort((a, b) => a - b)
          resolve({
            avg: 1000 / (ts.reduce((a, b) => a + b, 0) / ts.length),
            p95: sorted[Math.floor(sorted.length * 0.95)],
          })
        }
      }
      requestAnimationFrame(tick)
    })
)
const load = await page.evaluate(() => ({ enemies: window.__PI.enemies().length, particles: window.__PI.particles() }))
check(
  'holds 55+ fps under 30 enemies + 300 particles',
  fps.avg >= 55,
  `${fps.avg.toFixed(1)} fps avg, p95 frame ${fps.p95.toFixed(1)}ms, ${load.enemies} enemies / ${load.particles} particles`
)

// Death, restart, and persistence.
await page.evaluate(() => window.__PI.setIntegrity(1))
await sleep(6000)
const dead = await dbg()
check('reaches game over', dead.state === 'GAME_OVER', `state ${dead.state}`)
await sleep(800)
await page.keyboard.press('Enter')
await sleep(600)
check('restarts from game over', (await dbg()).state === 'PLAYING')

const highBefore = await page.evaluate(() => {
  try { return localStorage.getItem('pi_highscore') } catch { return null }
})
check('persists a high score', highBefore !== null && Number(highBefore) > 0, `pi_highscore=${highBefore}`)

const runtimeErrors = (await dbg()).errors || []
check('no runtime errors across the session', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | ') || 'none')

await ctx.close()

// ---------- iframe embed (how it will live on a portfolio site) ----------
{
  const wrapper = path.join(os.tmpdir(), 'pi-embed-check.html')
  fs.writeFileSync(
    wrapper,
    `<body style="margin:0;background:#111"><iframe src="file://${INDEX}" width="960" height="540" style="border:0"></iframe></body>`
  )
  const c2 = await browser.newContext({ viewport: { width: 1000, height: 600 } })
  const p2 = await c2.newPage()
  const frameErrors = []
  p2.on('pageerror', (e) => frameErrors.push(String(e)))
  await p2.goto('file://' + wrapper)
  await sleep(2500)
  const frame = p2.frames().find((f) => f.url().includes('index.html'))
  let framedState = null
  try {
    framedState = await frame.evaluate(() => window.__PI.state())
  } catch (e) {
    framedState = 'unreachable: ' + e.message
  }
  check('boots inside an iframe', framedState === 'TITLE', `frame state ${framedState}`)
  check('no errors inside the iframe', frameErrors.length === 0, frameErrors.slice(0, 2).join(' | ') || 'none')
  await c2.close()
  fs.rmSync(wrapper, { force: true })
}

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('failed:\n' + failed.map((f) => `  - ${f.name}: ${f.detail || ''}`).join('\n'))
}
process.exit(failed.length ? 1 : 0)
