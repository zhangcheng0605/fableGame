// Minimal PNG decoder — enough to read back the frames ffmpeg extracts from a
// screen recording. Handles 8-bit non-interlaced greyscale/RGB/RGBA, which is all
// ffmpeg's png encoder produces here. Zero dependencies (node:zlib does the inflate).

import zlib from 'node:zlib'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

// Decode to a packed RGB Uint8Array (3 bytes per pixel).
export function decodePngToRgb(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG')

  let width = 0
  let height = 0
  let colorType = -1
  const idat = []
  let pos = 8

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const bitDepth = data[8]
      colorType = data[9]
      const interlace = data[12]
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
      if (interlace !== 0) throw new Error('interlaced PNG unsupported')
      if (![0, 2, 6].includes(colorType)) throw new Error(`unsupported colour type ${colorType}`)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len // length + type + data + crc
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * 3)
  let prev = Buffer.alloc(stride)
  let rp = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const line = Buffer.from(raw.subarray(rp, rp + stride))
    rp += stride

    if (filter === 1) {
      for (let i = channels; i < stride; i++) line[i] = (line[i] + line[i - channels]) & 0xff
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? line[i - channels] : 0
        line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? line[i - channels] : 0
        const c = i >= channels ? prev[i - channels] : 0
        line[i] = (line[i] + paeth(a, prev[i], c)) & 0xff
      }
    } else if (filter !== 0) {
      throw new Error(`unknown PNG filter ${filter}`)
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 3
      if (channels === 1) {
        out[d] = out[d + 1] = out[d + 2] = line[s]
      } else {
        out[d] = line[s]
        out[d + 1] = line[s + 1]
        out[d + 2] = line[s + 2]
      }
    }
    prev = line
  }

  return { width, height, rgb: out }
}
