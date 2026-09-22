import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsTextlessJevTurn,
  canApplyJevAction,
  canPlayBackchannel,
  migrateSettings,
  normalizePhrases,
  scheduledFollowUp,
  shouldApplyJevResponse,
  shouldEvaluateJev,
  transcriptSnapshot,
  unhandledPartial,
} from "../lib/conversation-state.ts";

test("legacy settings, scheduled overlay, and stale Jev revisions", () => {
  assert.deepEqual(
    ["manual", "scheduled", "auto"].map((mode) => {
      const settings = migrateSettings({ mode });
      return [settings.mode, settings.scheduledEnabled];
    }),
    [
      ["normal", false],
      ["normal", true],
      ["natural", false],
    ],
  );
  assert.equal(scheduledFollowUp("normal", true, false), "normal");
  assert.equal(scheduledFollowUp("normal", false, true), "await-commit");
  assert.equal(scheduledFollowUp("natural", true, false), "natural");
  assert.equal(shouldApplyJevResponse(4, 4, 9, 9), true);
  assert.equal(shouldApplyJevResponse(4, 5, 9, 9), false);
  assert.equal(shouldApplyJevResponse(4, 4, 9, 10), true);
  assert.equal(shouldEvaluateJev(true, "natural", "idle", "idle", "clock_tick"), true);
  assert.equal(shouldEvaluateJev(true, "natural", "speaking", "idle", "clock_tick"), true);
  assert.equal(canPlayBackchannel(null, 1000), true);
  assert.equal(canPlayBackchannel(1000, 3999), false);
  assert.equal(canPlayBackchannel(1000, 4000), true);
  assert.deepEqual(normalizePhrases("うん。\n\nうん。\nなるほど。"), ["うん。", "なるほど。"]);
  assert.equal(canApplyJevAction("interrupt", false), true);
  assert.equal(canApplyJevAction("interrupt", true), true);
  assert.equal(canApplyJevAction("backchannel", true), false);
  assert.equal(canApplyJevAction("respond", false), true);
  assert.equal(allowsTextlessJevTurn("respond", "clock_tick"), true);
  assert.equal(allowsTextlessJevTurn("topic", "clock_tick"), true);
  assert.equal(unhandledPartial("今日は晴れですね", "今日は晴れ"), "ですね");
  assert.equal(unhandledPartial("今日は雨です", "今日は晴れ"), "今日は雨です");

  assert.deepEqual(
    transcriptSnapshot(
      [
        {
          text: "10秒待って。",
          revision: 1,
          startedAt: 1_000,
          committedAt: 3_000,
          overlappedAssistant: false,
          overlapResolved: false,
        },
      ],
      "まだ話して",
      11_000,
      12_000,
      true,
      false,
      13_000,
    ),
    {
      partial: {
        text: "まだ話して",
        startedAt: "1970-01-01T00:00:11.000Z",
        updatedAt: "1970-01-01T00:00:12.000Z",
        activeForSeconds: 2,
        unchangedForSeconds: 1,
        overlappedAssistant: true,
        overlapResolved: false,
      },
      confirmed: [
        {
          text: "10秒待って。",
          revision: 1,
          startedAt: "1970-01-01T00:00:01.000Z",
          committedAt: "1970-01-01T00:00:03.000Z",
          speechDurationSeconds: 2,
          committedAgoSeconds: 10,
          overlappedAssistant: false,
          overlapResolved: false,
        },
      ],
      hasUncommittedSpeech: true,
    },
  );
});
