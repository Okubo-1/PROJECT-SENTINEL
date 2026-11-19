import jpeg from 'jpeg-js'
import { decode as decodePng, encode as encodePng } from 'fast-png'
import exifr from 'exifr'
import { PDFDocument, StandardFonts } from 'pdf-lib'

export type SanitizedEvidence = { bytes: Uint8Array; mimeType: string; verified: boolean }
const maxPixels = 12_000_000
const maxInput = 8 * 1024 * 1024

function pngIsStatic(bytes: Uint8Array): boolean {
  if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let ended = false
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    if (length > bytes.length - offset - 12) return false
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (type === 'acTL' || type === 'eXIf') return false
    if (type === 'IHDR') {
      const width = view.getUint32(offset + 8)
      const height = view.getUint32(offset + 12)
      if (!width || !height || width * height > maxPixels) return false
    }
    offset += length + 12
    if (type === 'IEND') { ended = offset === bytes.length; break }
  }
  return ended
}

function orientPixels(data: Uint8Array, width: number, height: number, orientation: number) {
  const swap = orientation >= 5
  const outputWidth = swap ? height : width
  const outputHeight = swap ? width : height
  const output = new Uint8Array(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx = x
      let dy = y
      switch (orientation) {
        case 2: dx = width - 1 - x; break
        case 3: dx = width - 1 - x; dy = height - 1 - y; break
        case 4: dy = height - 1 - y; break
        case 5: dx = y; dy = x; break
        case 6: dx = height - 1 - y; dy = x; break
        case 7: dx = height - 1 - y; dy = width - 1 - x; break
        case 8: dx = y; dy = width - 1 - x; break
      }
      const source = (y * width + x) * 4
      output.set(data.subarray(source, source + 4), (dy * outputWidth + dx) * 4)
    }
  }
  return { data: output, width: outputWidth, height: outputHeight }
}

async function textToPdf(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.length > 200_000) return null
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (code !== 9 && code !== 10 && code !== 13 && (code < 32 || code > 126)) return null
  }
  const pdf = await PDFDocument.create({ updateMetadata: false })
  const font = await pdf.embedFont(StandardFonts.Courier)
  let page = pdf.addPage([612, 792])
  let y = 750
  for (const line of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    const chunks = line.match(/.{1,85}/g) || ['']
    for (const chunk of chunks) {
      if (y < 42) { page = pdf.addPage([612, 792]); y = 750 }
      page.drawText(chunk, { x: 42, y, size: 10, font })
      y -= 14
    }
  }
  return await pdf.save()
}

export async function sanitizeEvidence(bytes: Uint8Array, mimeType: string): Promise<SanitizedEvidence> {
  const original = { bytes, mimeType, verified: false }
  if (!bytes.length || bytes.length > maxInput) return original
  try {
    if (mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
      const exif = await exifr.parse(bytes, { pick: ['Orientation'], translateValues: false })
      const orientation = exif?.Orientation ?? 1
      if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) return original
      const image = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 12, maxMemoryUsageInMB: 128 })
      if (!image.width || !image.height || image.width * image.height > maxPixels) return original
      const rotated = orientPixels(image.data, image.width, image.height, orientation)
      return { bytes: jpeg.encode(rotated, 90).data, mimeType, verified: true }
    }
    if (mimeType === 'image/png' && pngIsStatic(bytes)) {
      const image = decodePng(bytes, { checkCrc: true })
      if (image.transparency && !image.palette) return original
      return { bytes: encodePng({
        width: image.width, height: image.height, data: image.data, depth: image.depth,
        channels: image.channels, palette: image.palette, transparency: image.transparency,
      }), mimeType, verified: true }
    }
    if (mimeType === 'text/plain') {
      const pdf = await textToPdf(bytes)
      if (pdf) return { bytes: pdf, mimeType: 'application/pdf', verified: true }
    }
  } catch {
    // The original file is retained and explicitly marked unverifiable.
    return original
  }
  return original
}
