import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".flac": "audio/flac",
};

export type AudioFile = {
  bytes: Buffer;
  byteSize: number;
  sha256: string;
  mimeType: string;
  extension: string;
  durationMs: number | null;
  tags: { title?: string; artist?: string; album?: string; genre?: string; year?: number };
};

function wavMetadata(bytes: Buffer): { durationMs: number; tags: AudioFile["tags"] } {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) !== bytes.length - 8) {
    throw new Error("Invalid WAV header");
  }
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  const tags: AudioFile["tags"] = {};
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length > bytes.length - offset) throw new Error("Invalid WAV chunk length");
    if (type === "fmt ") {
      if (length < 16 || bytes.readUInt16LE(offset) !== 1) throw new Error("Only PCM WAV is supported for test audio");
      const channels = bytes.readUInt16LE(offset + 2);
      const sampleRate = bytes.readUInt32LE(offset + 4);
      const bits = bytes.readUInt16LE(offset + 14);
      byteRate = bytes.readUInt32LE(offset + 8);
      if (channels < 1 || channels > 2 || sampleRate < 8_000 || sampleRate > 192_000 ||
          ![8, 16, 24, 32].includes(bits) || byteRate !== sampleRate * channels * bits / 8) {
        throw new Error("Invalid WAV format");
      }
    }
    if (type === "data") dataBytes += length;
    if (type === "LIST" && length >= 4 && bytes.toString("ascii", offset, offset + 4) === "INFO") {
      let info = offset + 4;
      while (info + 8 <= offset + length) {
        const field = bytes.toString("ascii", info, info + 4);
        const size = bytes.readUInt32LE(info + 4);
        info += 8;
        if (size > offset + length - info) break;
        const value = bytes.toString("utf8", info, info + size).replace(/\0.*$/, "").trim();
        if (field === "INAM") tags.title = value;
        if (field === "IART") tags.artist = value;
        if (field === "IPRD") tags.album = value;
        if (field === "IGNR") tags.genre = value;
        if (field === "ICRD") tags.year = Number.parseInt(value.slice(0, 4), 10) || undefined;
        info += size + (size % 2);
      }
    }
    offset += length + (length % 2);
  }
  if (!byteRate || !dataBytes) throw new Error("WAV has no audio samples");
  return { durationMs: Math.round(dataBytes * 1000 / byteRate), tags };
}

function synchsafe(bytes: Buffer, offset: number): number {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

function mp3Metadata(bytes: Buffer): { durationMs: number | null; tags: AudioFile["tags"] } {
  const tags: AudioFile["tags"] = {};
  let durationMs: number | null = null;
  let audioOffset = 0;
  if (bytes.toString("ascii", 0, 3) === "ID3") {
    const version = bytes[3];
    if (version !== 3 && version !== 4) throw new Error("Unsupported ID3 tag version");
    const end = 10 + synchsafe(bytes, 6);
    if (end > bytes.length) throw new Error("Truncated ID3 tag");
    audioOffset = end;
    let offset = 10;
    while (offset + 10 <= end) {
      const id = bytes.toString("ascii", offset, offset + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = version === 4 ? synchsafe(bytes, offset + 4) : bytes.readUInt32BE(offset + 4);
      offset += 10;
      if (size > end - offset) throw new Error("Invalid ID3 frame length");
      if (id.startsWith("T") && size > 1) {
        const encoding = bytes[offset];
        let text = "";
        if (encoding === 0 || encoding === 3) text = bytes.toString(encoding === 3 ? "utf8" : "latin1", offset + 1, offset + size);
        if (encoding === 1 && size > 3) text = bytes.toString("utf16le", offset + 3, offset + size);
        text = text.split("\0")[0].trim();
        if (id === "TIT2") tags.title = text;
        if (id === "TPE1") tags.artist = text;
        if (id === "TALB") tags.album = text;
        if (id === "TCON") tags.genre = text;
        if (id === "TDRC" || id === "TYER") tags.year = Number.parseInt(text.slice(0, 4), 10) || undefined;
        if (id === "TLEN") durationMs = Number.parseInt(text, 10) || null;
      }
      offset += size;
    }
  }
  let frame = false;
  for (let n = audioOffset; n + 4 <= Math.min(bytes.length, audioOffset + 4096); n++) {
    if (bytes[n] === 0xff && (bytes[n + 1] & 0xe0) === 0xe0 &&
        (bytes[n + 1] & 0x06) !== 0 && (bytes[n + 2] & 0xf0) !== 0 &&
        (bytes[n + 2] & 0xf0) !== 0xf0 && (bytes[n + 2] & 0x0c) !== 0x0c) { frame = true; break; }
  }
  if (!frame) throw new Error("MP3 has no valid audio frame");
  return { durationMs, tags };
}

export async function inspectAudioFile(file: string): Promise<AudioFile> {
  const info = await stat(file);
  if (!info.isFile() || info.size < 44 || info.size > MAX_AUDIO_BYTES) throw new Error("Audio file size must be 44 bytes to 25 MB");
  const extension = path.extname(file).toLowerCase();
  const mimeType = MIME[extension];
  if (!mimeType) throw new Error("Unsupported audio extension");
  const bytes = await readFile(file);
  let durationMs: number | null = null;
  let tags: AudioFile["tags"] = {};
  if (extension === ".wav") ({ durationMs, tags } = wavMetadata(bytes));
  else if (extension === ".mp3") ({ durationMs, tags } = mp3Metadata(bytes));
  else {
    const valid = extension === ".flac" ? bytes.toString("ascii", 0, 4) === "fLaC" :
      extension === ".ogg" ? bytes.toString("ascii", 0, 4) === "OggS" :
      extension === ".m4a" ? bytes.toString("ascii", 4, 8) === "ftyp" :
      false;
    if (!valid) throw new Error("Audio content does not match its extension");
  }
  return { bytes, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType, extension, durationMs, tags };
}
