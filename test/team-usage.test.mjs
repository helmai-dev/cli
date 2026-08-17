import test from "node:test";
import assert from "node:assert/strict";

import { getTeamUsage, teamUsageEndpoint } from "../dist/lib/api-web.js";

function rollupFixture(overrides = {}) {
  return {
    days: 30,
    since: "2026-07-18",
    totals: {
      cost_usd: 42.5,
      sessions: 12,
      calls: 40,
      input_tokens: 1000,
      output_tokens: 200,
      cache_write_tokens: 100,
      cache_read_tokens: 800,
      total_tokens: 2100,
      cache_read_share: 0.4211,
    },
    by_day: [{ day: "2026-08-01", cost_usd: 42.5, total_tokens: 2100, output_tokens: 200, sessions: 12 }],
    by_user: [{ user_id: "u1", name: "Ada", cost_usd: 42.5, total_tokens: 2100, sessions: 12 }],
    by_project: [{ project: "helm-cli", cost_usd: 42.5, total_tokens: 2100, sessions: 12 }],
    by_provider: [{ provider: "claude", cost_usd: 42.5, total_tokens: 2100, sessions: 12 }],
    by_model: [
      {
        provider: "claude",
        model: "claude-opus-4",
        cost_usd: 42.5,
        total_tokens: 2100,
        calls: 40,
      },
    ],
    ...overrides,
  };
}

test("team usage endpoint is GET /teams/{team}/usage?days=", () => {
  assert.equal(teamUsageEndpoint("team-9", 14), "/teams/team-9/usage?days=14");
  assert.equal(
    teamUsageEndpoint("team/with spaces", 30),
    "/teams/team%2Fwith%20spaces/usage?days=30",
  );
});

test("getTeamUsage GETs the rollup envelope and returns data", async () => {
  const calls = [];
  const data = rollupFixture();
  const requester = async (endpoint, options) => {
    calls.push({ endpoint, options });
    return { data };
  };

  const rollup = await getTeamUsage("team-9", 14, requester);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, "/teams/team-9/usage?days=14");
  assert.equal(calls[0].options?.method, "GET");
  assert.equal(calls[0].options?.body, undefined);
  assert.equal(rollup.totals.cost_usd, 42.5);
  assert.equal(rollup.by_user[0].name, "Ada");
  assert.equal(Object.hasOwn(rollup, "identified_savings_usd"), false);
});

test("getTeamUsage refuses a payload that is not a { data } envelope", async () => {
  await assert.rejects(
    () => getTeamUsage("team-9", 30, async () => ({ totals: { cost_usd: 1 } })),
    /data/,
  );
});
