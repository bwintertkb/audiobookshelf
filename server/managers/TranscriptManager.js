const Path = require('path')
const util = require('util')
const zlib = require('zlib')
const fs = require('../libs/fsExtra')
const Ffmpeg = require('../libs/fluentFfmpeg')
const Logger = require('../Logger')

const gzip = util.promisify(zlib.gzip)
const gunzip = util.promisify(zlib.gunzip)

/**
 * Read-along transcripts (format v1) created in the web client (speech recognition on the user's GPU in the
 * browser, or by the local transcribe helper) and uploaded by it.
 * Stored gzipped in the item metadata folder: /metadata/items/<libraryItemId>/transcript.json.gz
 * The folder is removed when the library item is deleted (ApiRouter.handleDeleteLibraryItem).
 *
 * @typedef TranscriptWord
 * @property {string} w
 * @property {number} start
 * @property {number} end
 *
 * @typedef TranscriptSegment
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {TranscriptWord[]} words
 *
 * @typedef Transcript
 * @property {number} version
 * @property {string} libraryItemId
 * @property {string} [model]
 * @property {string} [language]
 * @property {string} [createdAt]
 * @property {number} [durationSec]
 * @property {string} [source]
 * @property {{ino:string, filename:string, startOffset:number, duration:number}[]} [files]
 * @property {TranscriptSegment[]} segments
 *
 * @typedef TranscriptSummary - stored on libraryItem.extraData.transcript
 * @property {string} createdAt
 * @property {number} uploadedAt
 * @property {string} model
 * @property {string} language
 * @property {string} source
 * @property {number} numSegments
 * @property {number} numWords
 */
class TranscriptManager {
  constructor() {
    this.TranscriptFilename = 'transcript.json.gz'
    this.FormatVersion = 1
    /** Uploaded (possibly gzipped) file size limit */
    this.MaxUploadBytes = 64 * 1024 * 1024
    /** Limit after decompression (~25 MB per 50 hours of audio in practice) */
    this.MaxJsonBytes = 256 * 1024 * 1024
    /** Word times may overshoot the end of the audio slightly */
    this.TimeToleranceSec = 1
    /** Longest audio part decoded for browser speech recognition in one request */
    this.MaxAudioPartSec = 900
  }

  /**
   * Decode part of an audio file to raw 16 kHz mono 16-bit PCM (what Whisper expects), for speech recognition in the browser
   *
   * @param {string} path
   * @param {number} start - seconds into the file
   * @param {number} duration - seconds
   * @returns {import('../libs/fluentFfmpeg/index').FfmpegCommand} pipe() it to a stream; emits "error"
   */
  decodeAudioPart(path, start, duration) {
    return Ffmpeg(path).seekInput(start).duration(duration).noVideo().audioChannels(1).audioFrequency(16000).audioCodec('pcm_s16le').format('s16le')
  }

  /**
   * @param {string} libraryItemId
   * @returns {string}
   */
  getTranscriptPath(libraryItemId) {
    return Path.join(global.MetadataPath, 'items', libraryItemId, this.TranscriptFilename)
  }

  /**
   * Parse an uploaded transcript file (gzipped or plain JSON)
   *
   * @param {{ data?: Buffer, tempFilePath?: string, size?: number }} file - express-fileupload file
   * @returns {Promise<{ transcript?: Transcript, error?: string, status?: number }>}
   */
  async parseUploadedFile(file) {
    if (file.size > this.MaxUploadBytes) {
      return { error: `Transcript file is too large (max ${this.MaxUploadBytes / 1024 / 1024} MB)`, status: 413 }
    }
    let buffer = file.tempFilePath ? await fs.readFile(file.tempFilePath) : file.data
    if (!buffer?.length) {
      return { error: 'Transcript file is empty', status: 400 }
    }
    // gzip magic number
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      try {
        buffer = await gunzip(buffer, { maxOutputLength: this.MaxJsonBytes })
      } catch (error) {
        if (error.code === 'ERR_BUFFER_TOO_LARGE') {
          return { error: 'Transcript is too large after decompression', status: 413 }
        }
        return { error: 'Transcript file is not valid gzip', status: 400 }
      }
    }
    if (buffer.length > this.MaxJsonBytes) {
      return { error: 'Transcript is too large', status: 413 }
    }
    try {
      return { transcript: JSON.parse(buffer.toString('utf8')) }
    } catch (error) {
      return { error: 'Transcript file is not valid JSON', status: 400 }
    }
  }

  /**
   * @param {*} transcript
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {string|null} error message or null if valid
   */
  validateTranscript(transcript, libraryItem) {
    if (!transcript || typeof transcript !== 'object' || Array.isArray(transcript)) {
      return 'Transcript must be a JSON object'
    }
    if (transcript.version !== this.FormatVersion) {
      return `Unsupported transcript version "${transcript.version}" (expected ${this.FormatVersion})`
    }
    if (transcript.libraryItemId !== libraryItem.id) {
      return 'Transcript libraryItemId does not match the library item'
    }
    for (const key of ['model', 'language', 'createdAt', 'source']) {
      if (transcript[key] !== undefined && transcript[key] !== null && typeof transcript[key] !== 'string') {
        return `Transcript ${key} must be a string`
      }
    }
    if (transcript.files !== undefined && !Array.isArray(transcript.files)) {
      return 'Transcript files must be an array'
    }
    if (!Array.isArray(transcript.segments)) {
      return 'Transcript segments must be an array'
    }

    const isTime = (t) => typeof t === 'number' && Number.isFinite(t)
    const tracksDuration = libraryItem.media.includedAudioFiles.reduce((total, af) => total + (af.duration || 0), 0)
    const maxTime = tracksDuration + this.TimeToleranceSec

    let lastSegmentStart = -Infinity
    let lastWordStart = -Infinity
    for (let i = 0; i < transcript.segments.length; i++) {
      const segment = transcript.segments[i]
      if (!segment || typeof segment !== 'object') return `Segment ${i} is invalid`
      if (!isTime(segment.start) || !isTime(segment.end)) return `Segment ${i} start/end must be numbers`
      if (segment.start < 0 || segment.end < segment.start || segment.end > maxTime) return `Segment ${i} times are out of range`
      if (segment.start < lastSegmentStart) return `Segment ${i} starts before the previous segment`
      lastSegmentStart = segment.start
      if (typeof segment.text !== 'string') return `Segment ${i} text must be a string`
      if (!Array.isArray(segment.words)) return `Segment ${i} words must be an array`

      for (let j = 0; j < segment.words.length; j++) {
        const word = segment.words[j]
        if (!word || typeof word !== 'object' || typeof word.w !== 'string') return `Segment ${i} word ${j} is invalid`
        if (!isTime(word.start) || !isTime(word.end)) return `Segment ${i} word ${j} start/end must be numbers`
        if (word.start < 0 || word.end < word.start || word.end > maxTime) return `Segment ${i} word ${j} times are out of range`
        // Clients binary search word start times
        if (word.start < lastWordStart) return `Segment ${i} word ${j} starts before the previous word`
        lastWordStart = word.start
      }
    }
    return null
  }

  /**
   * @param {Transcript} transcript
   * @returns {TranscriptSummary}
   */
  getSummary(transcript) {
    return {
      createdAt: transcript.createdAt || null,
      uploadedAt: Date.now(),
      model: transcript.model || null,
      language: transcript.language || null,
      source: transcript.source || null,
      numSegments: transcript.segments.length,
      numWords: transcript.segments.reduce((total, segment) => total + segment.words.length, 0)
    }
  }

  /**
   * Write the transcript gzipped, replacing any existing one atomically
   *
   * @param {string} libraryItemId
   * @param {Transcript} transcript
   */
  async saveTranscript(libraryItemId, transcript) {
    const transcriptPath = this.getTranscriptPath(libraryItemId)
    await fs.ensureDir(Path.dirname(transcriptPath))
    const compressed = await gzip(Buffer.from(JSON.stringify(transcript), 'utf8'))
    const tempPath = `${transcriptPath}.tmp`
    await fs.writeFile(tempPath, compressed)
    await fs.rename(tempPath, transcriptPath)
    Logger.info(`[TranscriptManager] Saved transcript for library item "${libraryItemId}" (${compressed.length} bytes)`)
  }

  /**
   * @param {string} libraryItemId
   * @returns {Promise<boolean>} true if a transcript file was removed
   */
  async removeTranscript(libraryItemId) {
    const transcriptPath = this.getTranscriptPath(libraryItemId)
    if (!(await fs.pathExists(transcriptPath))) return false
    await fs.remove(transcriptPath)
    Logger.info(`[TranscriptManager] Removed transcript for library item "${libraryItemId}"`)
    return true
  }
}
module.exports = new TranscriptManager()
