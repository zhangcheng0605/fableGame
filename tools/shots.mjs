// Captures presentable screenshots of key moments into tools/shots/.
//
//   node tools/shots.mjs
//
// Drives a real play session so the HUD carries a believable score and combo, then
// pauses on the interesting frames. Used for the README and for eyeballing polish.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const OUT = path.join(ROOT, 'tools', 'shots')
const INDEX = path.join(ROOT, 'index.html')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const KEYMAP = { ' ': 'Space', '=': 'Equal', '-': 'Minus', "'": 'Quote' }
const keyFor = (ch) => KEYMAP[ch] || ch

fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ args: ['--mute-audio'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto('file://' + INDEX)
await page.waitForFunction('window.__PI && window.__PI.state')

const dbg = () =>
  page.evaluate(() => ({
    state: window.__PI.state(),
    score: window.__PI.score(),
    combo: window.__PI.combo(),
    flow: window.__PI.flow(),
    wave: window.__PI.wave(),
    boss: window.__PI.boss(),
    integrity: window.__PI.integrity(),
    enemies: window.__PI.enemies(),
    target: window.__PI.target(),
  }))

const shot = async (name) => {
  const p = path.join(OUT, name + '.png')
  await page.screenshot({ path: p })
  console.log('  ' + name + '.png')
}

function nextChar(s) {
  const live = s.enemies.filter(
    (e) => e.typed < e.word.length && e.alive !== false && !e.dying && (e.spawnT === undefined || e.spawnT > 0.4)
  )
  if (!live.length) return null
  if (s.target) {
    const t = live.find((e) => e.word === s.target)
    if (t) return t.word[t.typed]
  }
  const bw = live.filter((e) => e.kind === 'bossword')
  if (bw.length) {
    const l = bw.reduce((a, b) => (a.x <= b.x ? a : b))
    return l.word[l.typed]
  }
  const lowest = live.reduce((a, b) => (a.y >= b.y ? a : b))
  return lowest.word[lowest.typed]
}

async function play(seconds) {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const s = await dbg()
    if (s.state !== 'PLAYING') return s
    const ch = nextChar(s)
    if (!ch) { await sleep(40); continue }
    await page.keyboard.press(keyFor(ch))
    await sleep(52)
  }
  return dbg()
}

console.log('capturing:')

// title: mid-assembly, then settled
await sleep(280)
await shot('title-assembling')
await sleep(2000)
await shot('title')

await page.keyboard.press('Enter')
await sleep(600)

// populate the screen so gameplay looks alive, then build a combo
await page.evaluate(() => { for (let i = 0; i < 5; i++) window.__PI.spawn('token') })
await play(7)
await page.evaluate(() => {
  window.__PI.setWave(4)
  for (let i = 0; i < 3; i++) window.__PI.spawn('halluc')
  window.__PI.spawn('jail')
  window.__PI.spawn('overflow')
})
await sleep(900)
await shot('gameplay')

// flow state
await page.evaluate(() => window.__PI.setCombo(30))
await play(2.5)
await page.evaluate(() => { window.__PI.spawn('halluc'); window.__PI.spawn('jail') })
await sleep(700)
await shot('flow')

// damaged context bar
await page.evaluate(() => window.__PI.setIntegrity(42))
await sleep(500)
await shot('context-damaged')

// boss: intro then mid-fight
await page.evaluate(() => window.__PI.setWave(5))
await sleep(700)
await shot('boss-intro')
await sleep(1400)
await shot('boss')
await play(3)
await shot('boss-fight')

// game over
await page.evaluate(() => window.__PI.setIntegrity(1))
let s = await dbg()
for (let i = 0; i < 50 && s.state !== 'GAME_OVER'; i++) { await sleep(400); s = await dbg() }
await sleep(900)
await shot('gameover')

console.log(errors.length ? '\npage errors: ' + errors.slice(0, 5).join(' | ') : '\nno page errors')
await browser.close()
