import test from "node:test";
import assert from "node:assert/strict";
import { deliveryBacklogNotice, DELIVERY_BACKLOG_NOTICE_AT } from "../dist/commands/inject.js";

test("a healthy outbox says nothing", () => {
  assert.equal(deliveryBacklogNotice({ pending: 3, rejected: 0 }), null);
});

test("a backlog or a rejection becomes one line the human sees", () => {
  assert.match(
    deliveryBacklogNotice({ pending: DELIVERY_BACKLOG_NOTICE_AT, rejected: 0 }),
    /can't deliver usage to Helm Web \(200 queued\)/,
  );
  assert.match(deliveryBacklogNotice({ pending: 0, rejected: 1 }), /rejected 1 usage record\./);
});
