import jpeg from 'jpeg-js'
import { decode, encode } from 'fast-png'
import { PDFDocument } from 'pdf-lib'
import { sanitizeEvidence } from './sanitize.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('PNG is re-encoded without text metadata and preserves pixels', async () => {
  const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255])
  const input = encode({ width: 2, height: 1, data: pixels, channels: 4, depth: 8, text: { Author: 'Private Reporter', GPS: 'Secret location' } })
  const result = await sanitizeEvidence(input, 'image/png')
  const clean = decode(result.bytes)
  assert(result.verified && result.mimeType === 'image/png', 'PNG was not verified')
  assert(!new TextDecoder().decode(result.bytes).includes('Private Reporter') && Object.keys(clean.text).length === 0, 'PNG metadata survived')
  assert(clean.width === 2 && clean.height === 1 && clean.data.every((byte, index) => byte === pixels[index]), 'PNG pixels changed')
})

Deno.test('JPEG is re-encoded without EXIF and preserves orientation', async () => {
  const image = jpeg.encode({ data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), width: 2, height: 1 }, 90).data
  const exif = new Uint8Array([
    0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0,
    73, 73, 42, 0, 8, 0, 0, 0, 1, 0,
    18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
  ])
  const input = new Uint8Array(image.length + exif.length)
  input.set(image.subarray(0, 2)); input.set(exif, 2); input.set(image.subarray(2), exif.length + 2)
  const identifyingText = new TextEncoder().encode('device-and-GPS-identifiers')
  const marker = new Uint8Array(4 + identifyingText.length)
  marker.set([0xff, 0xe1, 0, identifyingText.length + 2])
  marker.set(identifyingText, 4)
  const tagged = new Uint8Array(input.length + marker.length)
  tagged.set(input.subarray(0, 2)); tagged.set(marker, 2); tagged.set(input.subarray(2), 2 + marker.length)
  const result = await sanitizeEvidence(tagged, 'image/jpeg')
  const clean = jpeg.decode(result.bytes, { useTArray: true })
  assert(result.verified && clean.width === 1 && clean.height === 2, 'JPEG orientation was not preserved')
  assert(!new TextDecoder().decode(result.bytes).includes('Exif'), 'EXIF metadata survived')
  assert(!new TextDecoder().decode(result.bytes).includes('device-and-GPS-identifiers'), 'JPEG identifying metadata survived')
})

Deno.test('plain text converts to a new PDF without document author metadata', async () => {
  const result = await sanitizeEvidence(new TextEncoder().encode('Evidence text\nSecond line'), 'text/plain')
  assert(result.verified && result.mimeType === 'application/pdf', 'Plain text was not converted')
  const pdf = await PDFDocument.load(result.bytes, { updateMetadata: false })
  assert(pdf.getPageCount() === 1 && !pdf.getAuthor() && !pdf.getCreator(), 'PDF contains author metadata')
})

Deno.test('unsupported, malformed and unconvertible files stay unchanged and unverifiable', async () => {
  for (const [mime, bytes] of [
    ['application/pdf', new TextEncoder().encode('%PDF original private metadata')],
    ['video/mp4', new Uint8Array([0, 1, 2])],
    ['image/jpeg', new Uint8Array([255, 216, 1])],
    ['text/plain', new TextEncoder().encode('Non-ASCII: 🚧')],
  ] as const) {
    const result = await sanitizeEvidence(bytes, mime)
    assert(!result.verified && result.mimeType === mime && result.bytes === bytes, `Unsafe fallback for ${mime}`)
  }
  const oversized = new Uint8Array(8 * 1024 * 1024 + 1)
  const result = await sanitizeEvidence(oversized, 'image/png')
  assert(!result.verified && result.bytes === oversized, 'Oversized image did not fall back')
})
