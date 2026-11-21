/**
 * Marks debugging and testing on a running server, so it stays out of the dashboard's real numbers.
 * Run it where the server runs, for example `docker exec bttr-subs node dist/debugMark.js start "Living room"`:
 *
 *   start <configuration|all> [note]   mark from now on (a configuration by name, id, or start of its id)
 *   stop                               end every marking that's open
 *   mark <from> <to> <configuration|all> [note]   mark a past stretch (ISO times, e.g. 2026-01-02T10:00Z)
 *   unmark <id>                        remove a period: what it covered counts as real again
 *   status                             list the periods
 *
 * It writes stats/debug-command.json in the cache folder; the server applies it within 2 s.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { cachePath } from "./cache.js";

const [cmd, ...rest] = process.argv.slice(2);
const usage = "usage: start <configuration|all> [note] | stop | mark <from> <to> <configuration|all> [note] | unmark <id> | status";
const command =
  cmd === "start" && rest[0] ? { cmd, config: rest[0], note: rest.slice(1).join(" ") || undefined }
  : cmd === "mark" && rest.length >= 3 ? { cmd, from: rest[0], to: rest[1], config: rest[2], note: rest.slice(3).join(" ") || undefined }
  : cmd === "unmark" && rest[0] ? { cmd, id: rest[0] }
  : cmd === "stop" || cmd === "status" ? { cmd }
  : undefined;
if (!command) {
  console.error(usage);
  process.exit(2);
}
const dir = cachePath("stats");
const answer = path.join(dir, "debug-command.done.json");
// A server that has served no play has made no stats folder.
await mkdir(dir, { recursive: true });
await rm(answer, { force: true });
await writeFile(path.join(dir, "debug-command.json"), JSON.stringify(command));
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  try {
    const got = JSON.parse(await readFile(answer, "utf8")) as { ok: boolean; message: string };
    await rm(answer, { force: true });
    (got.ok ? console.log : console.error)(got.message);
    process.exit(got.ok ? 0 : 1);
  } catch {}
}
console.error("No answer in 10 s: is the server running, with this cache folder?");
process.exit(1);
