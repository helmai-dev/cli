import test from "node:test";
import assert from "node:assert/strict";

import { EventBatcher } from "../dist/lib/event-batcher.js";

test("EventBatcher logs and preserves events when batch delivery fails", async () => {
  const logLines = [];
  const batcher = new EventBatcher(42, "run-ulid-42", {
    flushEvents: async () => {
      throw new Error("backend unavailable");
    },
    log: (message) => {
      logLines.push(message);
    },
  });

  batcher.push("agent.stdout", { raw: "hello" });

  await batcher.flush();

  assert.equal(logLines.length, 1);
  assert.match(logLines[0], /Failed to flush 1 run event\(s\) for run-ulid-42: backend unavailable/);
});
