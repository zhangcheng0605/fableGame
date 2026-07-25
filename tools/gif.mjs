// Zero-dependency animated GIF89a encoder.
//
// Written for this project because the only ffmpeg available here is Playwright's
// stripped build (vp8/png only — no gif, no h264), and the repo is deliberately
// dependency-free. Takes raw RGB frames, quantises them against a shared palette
// built from a histogram of all frames, and LZW-encodes the result.
//
//   import { encodeGif } from './gif.mjs'
//   const buf = encodeGif({ frames, width, height, delayMs: 50 })  // frames: Uint8Array RGB
//   fs.writeFileSync('out.gif', buf)

class ByteWriter {
  constructor() {
    this.buf = Buffer.alloc(1 << 20)
    this.len = 0
  }
  _need(n) {
    if (this.len + n <= this.buf.length) return
    let size = this.buf.length
    while (size < this.len + n) size *= 2
    const next = Buffer.alloc(size)
    this.buf.copy(next, 0, 0, this.len)
    this.buf = next
  }
  u8(v) {
    this._need(1)
    this.buf[this.len++] = v & 0xff
  }
  u16(v) {
    this._need(2)
    this.buf[this.len++] = v & 0xff
    this.buf[this.len++] = (v >> 8) & 0xff
  }
  bytes(arr) {
    this._need(arr.length)
    for (let i = 0; i < arr.length; i++) this.buf[this.len++] = arr[i]
  }
  ascii(s) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i))
  }
  done() {
    return this.buf.subarray(0, this.len)
  }
}

// GIF wants LZW codes packed LSB-first, emitted in <=255 byte sub-blocks.
class BitPacker {
  constructor(out) {
    this.out = out
    this.block = []
    this.cur = 0
    this.bits = 0
  }
  write(code, size) {
    this.cur |= code << this.bits
    this.bits += size
    while (this.bits >= 8) {
      this.block.push(this.cur & 0xff)
      this.cur >>= 8
      this.bits -= 8
      if (this.block.length === 255) this.flushBlock()
    }
  }
  flushBlock() {
    if (!this.block.length) return
    this.out.u8(this.block.length)
    this.out.bytes(this.block)
    this.block = []
  }
  finish() {
    if (this.bits > 0) {
      this.block.push(this.cur & 0xff)
      this.cur = 0
      this.bits = 0
      if (this.block.length === 255) this.flushBlock()
    }
    this.flushBlock()
    this.out.u8(0) // block terminator
  }
}

function lzwEncode(out, indices, minCodeSize) {
  const CLEAR = 1 << minCodeSize
  const EOI = CLEAR + 1
  const packer = new BitPacker(out)
  out.u8(minCodeSize)

  let dict = new Map()
  let next = EOI + 1
  let codeSize = minCodeSize + 1

  const reset = () => {
    dict = new Map()
    next = EOI + 1
    codeSize = minCodeSize + 1
  }

  packer.write(CLEAR, codeSize)
  reset()

  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]
    // Pack (prefix, k) into one integer key — far cheaper than string keys.
    const key = prefix * 256 + k
    const found = dict.get(key)
    if (found !== undefined) {
      prefix = found
      continue
    }
    packer.write(prefix, codeSize)
    if (next < 4096) {
      dict.set(key, next)
      if (next === 1 << codeSize && codeSize < 12) codeSize++
      next++
    } else {
      packer.write(CLEAR, codeSize)
      reset()
    }
    prefix = k
  }
  packer.write(prefix, codeSize)
  packer.write(EOI, codeSize)
  packer.finish()
}

// Histogram-based palette. The game is a dark scene with a tight accent palette,
// so picking the most frequent colours in a 5-bit-per-channel space beats the cost
// and complexity of median cut, and avoids washing out the neon accents.
function buildPalette(frames, sampleStride = 7) {
  const hist = new Map()
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 3 * sampleStride) {
      const key = ((f[i] >> 3) << 10) | ((f[i + 1] >> 3) << 5) | (f[i + 2] >> 3)
      hist.set(key, (hist.get(key) || 0) + 1)
    }
  }
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256)
  const palette = top.map(([key]) => {
    const r = ((key >> 10) & 31) << 3
    const g = ((key >> 5) & 31) << 3
    const b = (key & 31) << 3
    // Rescale so 31 maps to 255 rather than 248 — keeps whites actually white.
    return [Math.round((r / 248) * 255), Math.round((g / 248) * 255), Math.round((b / 248) * 255)]
  })
  while (palette.length < 256) palette.push([0, 0, 0])
  return palette
}

function quantiser(palette) {
  const cache = new Map()
  return (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i]
      // Weighted for perceived luminance — greens matter most to the eye.
      const dr = (r - p[0]) * 0.3
      const dg = (g - p[1]) * 0.59
      const db = (b - p[2]) * 0.11
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) {
        bestD = d
        best = i
        if (d === 0) break
      }
    }
    cache.set(key, best)
    return best
  }
}

export function encodeGif({ frames, width, height, delayMs = 50, loop = 0 }) {
  if (!frames || !frames.length) throw new Error('encodeGif: no frames')
  const expected = width * height * 3
  for (const [i, f] of frames.entries()) {
    if (f.length !== expected) {
      throw new Error(`encodeGif: frame ${i} is ${f.length} bytes, expected ${expected}`)
    }
  }

  const palette = buildPalette(frames)
  const toIndex = quantiser(palette)
  const out = new ByteWriter()

  out.ascii('GIF89a')
  out.u16(width)
  out.u16(height)
  out.u8(0xf7) // global colour table, 256 entries, 8-bit
  out.u8(0) // background colour index
  out.u8(0) // default pixel aspect ratio
  for (const [r, g, b] of palette) {
    out.u8(r)
    out.u8(g)
    out.u8(b)
  }

  // Netscape looping extension
  out.u8(0x21)
  out.u8(0xff)
  out.u8(0x0b)
  out.ascii('NETSCAPE2.0')
  out.u8(0x03)
  out.u8(0x01)
  out.u16(loop)
  out.u8(0)

  const delayCs = Math.max(2, Math.round(delayMs / 10)) // GIF delay is centiseconds
  const indices = new Uint8Array(width * height)

  for (const frame of frames) {
    for (let p = 0, i = 0; p < indices.length; p++, i += 3) {
      indices[p] = toIndex(frame[i], frame[i + 1], frame[i + 2])
    }

    out.u8(0x21) // graphic control extension
    out.u8(0xf9)
    out.u8(0x04)
    out.u8(0x04) // disposal = do not dispose, no transparency
    out.u16(delayCs)
    out.u8(0)
    out.u8(0)

    out.u8(0x2c) // image descriptor
    out.u16(0)
    out.u16(0)
    out.u16(width)
    out.u16(height)
    out.u8(0)

    lzwEncode(out, indices, 8)
  }

  out.u8(0x3b) // trailer
  return Buffer.from(out.done())
}
