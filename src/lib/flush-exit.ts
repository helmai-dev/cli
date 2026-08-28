/**
 * process.exit() does not wait for piped stdout to drain: anything past the
 * OS pipe buffer (64KB on macOS/Linux) is silently dropped. That truncated
 * every large NDJSON response — a `code-bridge` bootstrap just past 64KB came
 * back to Helm Code as unparseable JSON. Wait for the buffer to empty (with a
 * cap, so a stuck reader can never wedge the CLI) before exiting.
 */
export interface DrainableStream {
  writableLength: number;
  once(event: "drain", listener: () => void): unknown;
}

export function waitForStreamDrain(
  stream: DrainableStream,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableLength === 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    const check = (): void => {
      if (stream.writableLength === 0) {
        clearTimeout(timer);
        resolve();
      } else {
        stream.once("drain", check);
      }
    };
    stream.once("drain", check);
  });
}
