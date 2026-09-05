import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { UsageExcerptUploadBody } from "./api-web.js";

const MAX_FILES = 1000;
const MAX_DISK_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
interface Entry {
  body: UsageExcerptUploadBody;
  attempts: number;
  nextAttemptAt: number;
  rejected?: boolean;
}

/** Sanitized bodies only. A filesystem lock coordinates daemon and proxy;
 * acknowledgement loss replays the same body to an idempotent endpoint. */
export class UsageExcerptOutbox {
  constructor(readonly directory: string) {}

  private files(): string[] {
    try {
      return fs
        .readdirSync(this.directory)
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .sort();
    } catch {
      return [];
    }
  }

  status(): { pending: number; rejected: number; bytes: number } {
    let pending = 0,
      rejected = 0,
      bytes = 0;
    for (const name of this.files()) {
      try {
        const file = path.join(this.directory, name);
        bytes += fs.statSync(file).size;
        let entry: Entry;
        try {
          entry = JSON.parse(fs.readFileSync(file, "utf8")) as Entry;
        } catch {
          continue;
        }
        if (entry.rejected) rejected++;
        else pending++;
      } catch {
        rejected++;
      }
    }
    return { pending, rejected, bytes };
  }

  enqueue(body: UsageExcerptUploadBody): void {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > MAX_BODY_BYTES)
      throw new Error("Excerpt exceeds the upload byte budget.");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(
      this.directory,
      createHash("sha256").update(encoded).digest("hex") + ".json",
    );
    if (fs.existsSync(file)) return;
    const state = this.status();
    if (
      state.pending + state.rejected >= MAX_FILES ||
      state.bytes + Buffer.byteLength(encoded) + 256 > MAX_DISK_BYTES
    ) {
      throw new Error(
        "Excerpt outbox is full; run helm doctor to inspect delivery.",
      );
    }
    const entry: Entry = { body, attempts: 0, nextAttemptAt: 0 };
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    this.writeEntry(temporary, file, entry);
  }

  private writeEntry(temporary: string, file: string, entry: Entry): void {
    const descriptor = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(entry));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
  }

  async flush(
    send: (body: UsageExcerptUploadBody) => Promise<unknown>,
    now = Date.now(),
  ): Promise<number> {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, ".lock");
    try {
      const pid = Number(fs.readFileSync(lock, "utf8"));
      if (!pid) {
        if (Date.now() - fs.statSync(lock).mtimeMs < 30_000) return 0;
        fs.unlinkSync(lock);
      }
      if (pid) {
        try {
          process.kill(pid, 0);
          return 0;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return 0;
        }
        fs.unlinkSync(lock);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return 0;
    }
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch {
      return 0;
    }
    let delivered = 0;
    try {
      for (const name of this.files()) {
        const file = path.join(this.directory, name);
        let entry: Entry;
        try {
          entry = JSON.parse(fs.readFileSync(file, "utf8")) as Entry;
        } catch {
          continue;
        }
        if (entry.rejected || entry.nextAttemptAt > now) continue;
        try {
          await send(entry.body);
          fs.unlinkSync(file);
          delivered++;
          if (delivered >= 4) break;
        } catch (error) {
          const status = (error as { status?: number }).status;
          entry.attempts++;
          entry.rejected = status === 400 || status === 413 || status === 422;
          const retryAfter =
            (error as { retryAfterMs?: number }).retryAfterMs ?? 0;
          entry.nextAttemptAt =
            now +
            Math.max(
              retryAfter,
              Math.min(300_000, 1000 * 2 ** Math.min(entry.attempts, 8)) *
                (0.75 + Math.random() * 0.5),
            );
          const temporary = file + ".tmp";
          this.writeEntry(temporary, file, entry);
          break;
        }
      }
    } finally {
      fs.unlinkSync(lock);
    }
    return delivered;
  }
}
