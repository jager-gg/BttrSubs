/**
 * Speech in a stretch of audio, heard by Silero VAD (MIT, github.com/snakers4/silero-vad, v5.1.2,
 * assets/silero_vad.onnx) run by ONNX Runtime's native library, which needs glibc. Loudness alone
 * can't tell speech from a laugh track or music, so it can't time a subtitle by speech.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import * as ort from "onnxruntime-node";
import type { Cue } from "./sync.js";

const RATE = 16000;
/** Silero v5 at 16 kHz takes 512 new samples (32 ms) with the last 64 of the chunk before. */
const CHUNK = 512;
const CONTEXT = 64;
export const VAD_FRAME_MS = (CHUNK / RATE) * 1000;

// ONNX Runtime's native library sends usage events to Microsoft and keeps a device id in ~/.cache
// unless this is set before its first session. Set here, on the main thread before any worker
// starts: a worker's process.env is its own copy and doesn't reach the library. An explicit
// setting is left as it is.
process.env.ORT_DISABLE_TELEMETRY ??= "1";

let session: Promise<ort.InferenceSession> | undefined;

function model(): Promise<ort.InferenceSession> {
  if (!session) {
    // One thread per session: the worker hears one batch at a time, and ffmpeg needs the other cores.
    session = readFile(path.join(process.cwd(), "assets", "silero_vad.onnx")).then((bytes) =>
      ort.InferenceSession.create(bytes, { intraOpNumThreads: 1, interOpNumThreads: 1 })
    );
    session.catch(() => (session = undefined));
  }
  return session;
}

/**
 * How many frames (32 ms each) are heard before letting waiting requests through, when the model runs
 * on the thread that answers lists and downloads (no worker, see speechChances).
 */
const FRAMES_PER_TURN = 64;

/**
 * The chance of speech in each 32 ms of 16 kHz mono 16-bit audio. Heard on a worker thread, so the
 * thread that answers lists and downloads never waits on the model: on a 4-core ARM server, two 40 s
 * windows heard on it at once held it for up to 1.1 s between turns, enough to make a download's own
 * time limit fire late. Heard on this thread when no worker can be started.
 */
export async function speechChances(pcm: Buffer): Promise<Float32Array> {
  const worker = vadWorker();
  if (!worker) return chancesHere(pcm, FRAMES_PER_TURN);
  try {
    return await worker.hear(pcm);
  } catch {
    stopWorker();
    return chancesHere(pcm, FRAMES_PER_TURN);
  }
}

/** speechChances on this thread, letting other work through every `turn` frames (0: never). */
export async function chancesHere(pcm: Buffer, turn = 0): Promise<Float32Array> {
  const vad = await model();
  const samples = samplesOf(pcm);
  const frames = Math.floor(samples.length / CHUNK);
  const out = new Float32Array(frames);
  let state: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(RATE)]), []);
  const input = new Float32Array(CONTEXT + CHUNK);
  for (let f = 0; f < frames; f++) {
    if (turn > 0 && f > 0 && f % turn === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    // The last CONTEXT samples before this chunk (zeros at the start), then the chunk.
    input.fill(0, 0, CONTEXT);
    const start = f * CHUNK;
    if (start >= CONTEXT) input.set(samples.subarray(start - CONTEXT, start), 0);
    input.set(samples.subarray(start, start + CHUNK), CONTEXT);
    const result = await vad.run({ input: new ort.Tensor("float32", input.slice(), [1, CONTEXT + CHUNK]), state, sr });
    out[f] = (result.output.data as Float32Array)[0];
    state = result.stateN;
  }
  return out;
}

/** 16-bit PCM as the model's samples, -1 to 1. */
function samplesOf(pcm: Buffer): Float32Array {
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return samples;
}

/** Windows heard together at most: a file's spots, and another file's beside them. */
const MAX_ROWS = 8;
/** The model's state per window: two layers of 128 values ([2, rows, 128]). */
const STATE = 128;
/**
 * A run of the model doesn't give way to the thread's messages (it finishes before its promise is
 * awaited), so every this many runs the batch lets messages in: windows sent meanwhile join it.
 */
const JOIN_EVERY = 16;
const letMessagesIn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A window being heard in a batch: its samples, the frame it's at, and its chances so far. */
interface Row {
  samples: Float32Array;
  frames: number;
  f: number;
  out: Float32Array;
  resolve: (chances: Float32Array) => void;
  reject: (error: unknown) => void;
}

/** The [2, rows, 128] state with only the rows kept, or zero rows added after them for windows that join. */
function reshapeState(state: Float32Array, rows: number, keep: boolean[], joining: number): Float32Array {
  const kept = keep.filter(Boolean).length;
  const out = new Float32Array(2 * (kept + joining) * STATE);
  for (let layer = 0; layer < 2; layer++) {
    let to = layer * (kept + joining) * STATE;
    for (let b = 0; b < rows; b++) {
      if (!keep[b]) continue;
      out.set(state.subarray((layer * rows + b) * STATE, (layer * rows + b + 1) * STATE), to);
      to += STATE;
    }
  }
  return out;
}

/**
 * Hears windows together: each run of the model takes the next 32 ms of every window being heard, so
 * the cost of a run is shared. A window joins as soon as it's sent and leaves when it's done; none waits
 * for the others to start or end. The model keeps the rows of a batch apart, so each window's chances
 * are exactly the ones it gets heard alone (chancesHere).
 * Calibration (4-core ARM, a file's five 40 s spots read at once and heard): 5.1 s one after another,
 * 3.8 s together, the same speech heard; five windows already read, 4.4 s and 2.9 s.
 */
export function batchHearer(maxRows = MAX_ROWS): (pcm: Buffer) => Promise<Float32Array> {
  const waiting: Row[] = [];
  let running = false;
  const loop = async () => {
    running = true;
    let rows: Row[] = [];
    try {
      const vad = await model();
      const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(RATE)]), []);
      const width = CONTEXT + CHUNK;
      let state: Float32Array = new Float32Array(0);
      // Windows sent together arrive as separate messages: they're all let in before the first run.
      await letMessagesIn();
      for (let runs = 0; rows.length || waiting.length; runs++) {
        if (runs > 0 && runs % JOIN_EVERY === 0) await letMessagesIn();
        if (waiting.length && rows.length < maxRows) {
          const joining = waiting.splice(0, maxRows - rows.length);
          state = reshapeState(state, rows.length, rows.map(() => true), joining.length);
          rows = rows.concat(joining);
        }
        const n = rows.length;
        // Each row: the last CONTEXT samples before its chunk (zeros at its start), then the chunk.
        const input = new Float32Array(n * width);
        rows.forEach((r, b) => {
          const start = r.f * CHUNK;
          if (start >= CONTEXT) input.set(r.samples.subarray(start - CONTEXT, start), b * width);
          input.set(r.samples.subarray(start, start + CHUNK), b * width + CONTEXT);
        });
        const result = await vad.run({ input: new ort.Tensor("float32", input, [n, width]), state: new ort.Tensor("float32", state, [2, n, STATE]), sr });
        const chances = result.output.data as Float32Array;
        state = new Float32Array(result.stateN.data as Float32Array);
        rows.forEach((r, b) => (r.out[r.f++] = chances[b]));
        const keep = rows.map((r) => r.f < r.frames);
        if (keep.every(Boolean)) continue;
        state = reshapeState(state, n, keep, 0);
        for (const r of rows) if (r.f >= r.frames) r.resolve(r.out);
        rows = rows.filter((_, b) => keep[b]);
      }
    } catch (error) {
      for (const r of [...rows, ...waiting.splice(0)]) r.reject(error);
    } finally {
      running = false;
    }
  };
  return (pcm) =>
    new Promise<Float32Array>((resolve, reject) => {
      const samples = samplesOf(pcm);
      const frames = Math.floor(samples.length / CHUNK);
      if (frames === 0) return resolve(new Float32Array(0));
      waiting.push({ samples, frames, f: 0, out: new Float32Array(frames), resolve, reject });
      if (!running) void loop();
    });
}

// ---------- the worker thread ----------

/** One worker hears every window in turn; it is started on first use and kept, idle, without holding the process open. */
let worker: { hear: (pcm: Buffer) => Promise<Float32Array> } | undefined;
let workerHandle: Worker | undefined;
/** A worker that failed to start is not tried again: speech is then heard on this thread. */
let workerFailed = false;

function vadWorker(): typeof worker {
  if (worker || workerFailed) return worker;
  // Compiled, the worker is dist/vad-worker.js; from the TypeScript sources (tests, scripts) it is
  // loaded through tsx. It takes none of this process's node flags: some (--input-type) refuse a file.
  const fromSources = import.meta.url.endsWith(".ts");
  try {
    workerHandle = new Worker(new URL(fromSources ? "./vad-worker.ts" : "./vad-worker.js", import.meta.url), { execArgv: fromSources ? ["--import", "tsx"] : [] });
  } catch {
    workerFailed = true;
    return undefined;
  }
  const handle = workerHandle;
  const pending = new Map<number, { resolve: (c: Float32Array) => void; reject: (e: Error) => void }>();
  let next = 0;
  handle.unref();
  handle.on("message", (m: { id: number; chances?: Float32Array; error?: string }) => {
    const job = pending.get(m.id);
    if (!job) return;
    pending.delete(m.id);
    if (pending.size === 0) handle.unref();
    if (m.chances) job.resolve(m.chances);
    else job.reject(new Error(m.error ?? "the voice detector failed"));
  });
  const failAll = (error: Error) => {
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };
  handle.on("error", (error: unknown) => failAll(error instanceof Error ? error : new Error(String(error))));
  handle.on("exit", () => failAll(new Error("the voice detector's thread stopped")));
  worker = {
    hear: (pcm) =>
      new Promise<Float32Array>((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        // Held open while it works, so a script waiting on it doesn't end first.
        handle.ref();
        const copy = new Uint8Array(pcm);
        handle.postMessage({ id, pcm: copy.buffer }, [copy.buffer]);
      })
  };
  return worker;
}

function stopWorker(): void {
  void workerHandle?.terminate();
  workerHandle = undefined;
  worker = undefined;
  workerFailed = true;
}

export interface SpeechShape {
  /** Speech starts above this chance, and ends below it minus 0.15 (Silero's own hysteresis). */
  threshold: number;
  /** Pauses shorter than this stay inside one stretch of speech, as words inside one line. */
  joinMs: number;
  minMs: number;
  maxMs: number;
}

export const SPEECH_SHAPE: SpeechShape = { threshold: 0.5, joinMs: 300, minMs: 250, maxMs: 12000 };

/** Stretches of speech from per-frame chances, as cues starting at `from` ms. */
export function speechFromChances(chances: Float32Array, from: number, shape: SpeechShape = SPEECH_SHAPE): Cue[] {
  const spans: Cue[] = [];
  let open: Cue | undefined;
  for (let f = 0; f < chances.length; f++) {
    const at = f * VAD_FRAME_MS;
    if (!open && chances[f] >= shape.threshold) open = { start: at, end: at + VAD_FRAME_MS };
    else if (open && chances[f] >= shape.threshold - 0.15) open.end = at + VAD_FRAME_MS;
    else if (open) {
      const last = spans[spans.length - 1];
      if (last && open.start - last.end <= shape.joinMs) last.end = open.end;
      else spans.push(open);
      open = undefined;
    }
  }
  if (open) {
    const last = spans[spans.length - 1];
    if (last && open.start - last.end <= shape.joinMs) last.end = open.end;
    else spans.push(open);
  }
  return spans
    .filter((s) => s.end - s.start >= shape.minMs && s.end - s.start <= shape.maxMs)
    .map((s) => ({ start: Math.round(from + s.start), end: Math.round(from + s.end) }));
}

/** Speech heard in 16 kHz mono 16-bit audio that starts at `from` ms. */
export async function heardSpeech(pcm: Buffer, from: number): Promise<Cue[]> {
  return speechFromChances(await speechChances(pcm), from);
}
