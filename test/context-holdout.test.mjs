import test from "node:test";
import assert from "node:assert/strict";
import { contextHoldoutRate, isContextHoldout } from "../dist/lib/context-holdout.js";

const now = new Date("2026-09-24T15:00:00Z");

test("the default control group is about one day in ten per device and project", () => {
  let held = 0;
  const trials = 4000;
  for (let i = 0; i < trials; i++) {
    if (isContextHoldout({ deviceUlid: `device-${i}`, projectHint: "billing", now, rate: 0.1 })) held++;
  }
  assert.ok(held > trials * 0.08 && held < trials * 0.12, `held ${held} of ${trials}`);
});

test("the draw is stable within a UTC day and can change the next day", () => {
  const input = { deviceUlid: "01J3ZB4YJQWERTYUIOPASDFGHJ", projectHint: "billing", rate: 0.5 };
  const morning = isContextHoldout({ ...input, now: new Date("2026-09-24T01:00:00Z") });
  const night = isContextHoldout({ ...input, now: new Date("2026-09-24T23:59:00Z") });
  assert.equal(morning, night);
  const days = new Set();
  for (let d = 1; d <= 20; d++) {
    days.add(isContextHoldout({ ...input, now: new Date(`2026-10-${String(d).padStart(2, "0")}T12:00:00Z`) }));
  }
  assert.equal(days.size, 2, "over twenty days both groups occur");
});

test("no device, no project, or rate zero never holds out", () => {
  assert.equal(isContextHoldout({ deviceUlid: null, projectHint: "billing", now, rate: 1 }), false);
  assert.equal(isContextHoldout({ deviceUlid: "d", projectHint: "", now, rate: 1 }), false);
  assert.equal(isContextHoldout({ deviceUlid: "d", projectHint: "billing", now, rate: 0 }), false);
});

test("HELM_CONTEXT_HOLDOUT opts out or overrides the rate, capped at half", () => {
  assert.equal(contextHoldoutRate({}), 0.1);
  assert.equal(contextHoldoutRate({ HELM_CONTEXT_HOLDOUT: "0" }), 0);
  assert.equal(contextHoldoutRate({ HELM_CONTEXT_HOLDOUT: "0.2" }), 0.2);
  assert.equal(contextHoldoutRate({ HELM_CONTEXT_HOLDOUT: "0.9" }), 0.5);
  assert.equal(contextHoldoutRate({ HELM_CONTEXT_HOLDOUT: "nope" }), 0);
});
