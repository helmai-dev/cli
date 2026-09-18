# Jev on the wrap path

Read `docs/NORTH_STAR.md`, `docs/GTM.md`, and `docs/HANDOFF.md` first. This file does not replace them.

Jev (TypeSafe System One) is the judgment Helm uses to decide which **tool results** are still needed in the live provider request. It is not auto-compact and not a smarter summary.

## Lock

Compaction (an LLM summary of the thread) is waste. Before that happens, wrap intercepts the request:

1. Collect tool_use / tool_result pairs. Pin the first message and the newest few.
2. Send Helm Web a bounded catalog: the current user goal, tool name, input preview, result size, head/tail. Never the transcript, never the full result, never system/developer messages.
3. Helm Web asks Jev one Noul per candidate: “does the current task still need the verbatim contents of this result?”
4. Drop only when that probability is **below 0.35**. Uncertain (~0.5) keeps the result. Fail-open keeps everything.
5. The original is stored on this laptop. The request carries a stub with the store key so the model can re-run the tool or restore via `GET /helm/tool-result/:key` on the loopback proxy.

The TypeSafe / Jev API key lives on Helm Web (`TYPESAFE_API_KEY` / `JEV_AI_API_KEY`). It must not go to the CLI, Inertia, Vite, or Desktop.

If dropping spent results is not enough and the session is still about to compact, `/handoff` then `/handon` (`docs/HANDOFF.md`).

## What this is not

- Not the [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) Claude Code plugin. Wrap / intercept stays the product (`docs/GTM.md`).
- Not a dashboard plugin or `helm hooks install` integration.
- Not a Verified Saving until Helm Web prices a measured token delta from the intercept. Bytes dropped locally are not a dollar.

## Honesty

Same as North Star: no invented dollars, no full transcripts off-box, no keys on the laptop client.
