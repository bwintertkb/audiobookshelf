/**
 * Speech recognition in the browser (players/browserTranscriber.js) runs Whisper with transformers.js on
 * ONNX Runtime Web (WebGPU). Only three files of those packages are needed, so instead of installing them
 * (they depend on large native Node packages) they are downloaded from the npm registry at build time,
 * checked against the registry's integrity hashes and served by ABS from static/transcriber/vendor/.
 *
 * Runs before `npm run generate` / `npm run dev`. Does nothing if the files are already there.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// Keep in sync with the vendor path imported by static/transcriber/worker.js
const TRANSFORMERS_VERSION = '4.3.1'
const PACKAGES = [
  {
    tarball: `https://registry.npmjs.org/@huggingface/transformers/-/transformers-${TRANSFORMERS_VERSION}.tgz`,
    integrity: 'sha512-5+voSeUCFK6PCKlY15dPhNOKq3/zOTxDN7oC+Wy9dFb1QZ0TSQomZRRy7URRK8YRuUoE9fGMQTTPC5d/pWBJhA==',
    files: ['package/dist/transformers.min.js']
  },
  {
    // The ONNX Runtime Web version transformers.js 4.3.1 depends on
    tarball: 'https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.31.0-dev.20260914-8d85527a0.tgz',
    integrity: 'sha512-Iy7rtadoBgxS/LLvDr3QW38DB1PNXRnr0GJMcL0TAt7c9qjgVQl83UlGCVyeAnK2InpmW8Uc3PL8XIuqtDeF6g==',
    files: ['package/dist/ort-wasm-simd-threaded.asyncify.mjs', 'package/dist/ort-wasm-simd-threaded.asyncify.wasm']
  }
]
const DEST = path.join(__dirname, '..', 'static', 'transcriber', 'vendor', `transformers-${TRANSFORMERS_VERSION}`)

/** Files of a (gunzipped) tar archive; names are POSIX paths */
function* tarEntries(buffer) {
  let offset = 0
  let longName = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const prefix = field(345, 155)
    let name = longName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const data = buffer.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      // PAX header: may carry the real path of the next entry
      const match = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
      if (match) longName = match[1]
      continue
    }
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    if (type === '0' || type === '') yield { name, data }
  }
}

async function fetchPackage({ tarball, integrity, files }) {
  const response = await fetch(tarball)
  if (!response.ok) throw new Error(`Download of ${tarball} failed: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const [algorithm, expected] = integrity.split(/-(.*)/s)
  const actual = crypto.createHash(algorithm).update(archive).digest('base64')
  if (actual !== expected) throw new Error(`Integrity check failed for ${tarball}`)
  const wanted = new Set(files)
  for (const entry of tarEntries(zlib.gunzipSync(archive))) {
    if (!wanted.has(entry.name)) continue
    fs.writeFileSync(path.join(DEST, path.basename(entry.name)), entry.data)
    wanted.delete(entry.name)
  }
  if (wanted.size) throw new Error(`Missing in ${tarball}: ${[...wanted].join(', ')}`)
}

async function main() {
  const needed = PACKAGES.flatMap((pkg) => pkg.files.map((file) => path.join(DEST, path.basename(file))))
  if (needed.every((file) => fs.existsSync(file))) return
  fs.mkdirSync(DEST, { recursive: true })
  for (const pkg of PACKAGES) await fetchPackage(pkg)
  console.log(`[fetchTranscriberVendor] Downloaded transformers.js ${TRANSFORMERS_VERSION} and ONNX Runtime Web to ${path.relative(process.cwd(), DEST)}`)
}

main().catch((error) => {
  console.error('[fetchTranscriberVendor]', error.message)
  process.exit(1)
})
