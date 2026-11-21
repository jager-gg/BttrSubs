/**
 * The voice detector's thread (see speechChances in vad.ts): hears the windows of audio it is sent,
 * together as they arrive (batchHearer), and sends back each one's chance of speech per frame.
 */
import { parentPort } from "node:worker_threads";
import { batchHearer } from "./vad.js";

const hear = batchHearer();

parentPort?.on("message", (m: { id: number; pcm: ArrayBuffer }) => {
  hear(Buffer.from(m.pcm)).then(
    (chances) => parentPort?.postMessage({ id: m.id, chances }, [chances.buffer as ArrayBuffer]),
    (error: unknown) => parentPort?.postMessage({ id: m.id, error: error instanceof Error ? error.message : String(error) })
  );
});
