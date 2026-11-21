/**
 * Tests never touch real DNS: every name resolves to one public address unless a test says
 * otherwise (src/net.ts looks a name up before fetching it).
 * The files tests read are served from this machine, which is allowed here as PRIVATE_STREAM_HOSTS
 * would (src/reads.ts).
 */
import { vi } from "vitest";

// Set in the environment, before any test loads src/config.ts with its own settings.
process.env.PRIVATE_STREAM_HOSTS = "127.0.0.1,localhost";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }])
}));
