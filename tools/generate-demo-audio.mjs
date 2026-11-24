import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = path.resolve("data/demo");
await mkdir(output, { recursive: true });
const sampleRate = 22_050;
const seconds = 5;
const samples = sampleRate * seconds;
const audio = Buffer.alloc(44 + samples * 2);
audio.write("RIFF", 0, "ascii");
audio.writeUInt32LE(audio.length - 8, 4);
audio.write("WAVEfmt ", 8, "ascii");
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(sampleRate, 24);
audio.writeUInt32LE(sampleRate * 2, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write("data", 36, "ascii");
audio.writeUInt32LE(samples * 2, 40);
for (let n = 0; n < samples; n++) {
  const t = n / sampleRate;
  const envelope = Math.min(1, t * 4) * Math.min(1, (seconds - t) * 4);
  const tone = Math.sin(2 * Math.PI * 220 * t) * 0.24 + Math.sin(2 * Math.PI * 330 * t) * 0.12;
  audio.writeInt16LE(Math.round(tone * envelope * 32767), 44 + n * 2);
}
await writeFile(path.join(output, "synthetic_demo.wav"), audio);
await writeFile(path.join(output, "manifest.json"), JSON.stringify({
  providerId: "development:mixora-synthetic",
  sourceType: "DEVELOPMENT_TEST",
  tracks: [{
    externalId: "synthetic-demo-v1", audioFile: "synthetic_demo.wav",
    title: "Synthetic test tone", artist: "Synthetic test audio",
    album: "MIXORA development fixtures", category: "ANY", genre: "Test audio",
    language: "UNKNOWN", durationMs: seconds * 1000,
  }],
}, null, 2) + "\n");
console.log("Generated original synthetic WAV and development-only manifest in data/demo");
