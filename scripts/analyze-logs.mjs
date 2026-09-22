import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const logFile = path.join(process.cwd(), ".data", "logs", "session.ndjson");

if (!existsSync(logFile)) {
  console.log(`Log file not found: ${logFile}`);
  console.log("Start a conversation first to generate session logs.");
  process.exit(0);
}

const rawLines = readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
const entries = [];
for (const line of rawLines) {
  try {
    entries.push(JSON.parse(line));
  } catch {
    // Skip corrupted lines
  }
}

console.log(`=======================================================`);
console.log(`  tofu-madobe Conversation Log Analysis`);
console.log(`  Total entries: ${entries.length}`);
console.log(`=======================================================\n`);

const actionCounts = {
  wait: 0,
  backchannel: 0,
  respond: 0,
  interrupt: 0,
  topic: 0,
};

const backchannelCounts = {};
const jevDecisions = [];
const executedTurns = [];
const discards = [];
const speechTimeline = [];

for (const entry of entries) {
  const { time, scope, event, details } = entry;

  // Scribe events
  if (scope?.includes("scribe") || event?.includes("Scribe")) {
    if (event === "commit applied" || event === "Scribe commit did not append") {
      speechTimeline.push({
        time,
        source: "Scribe",
        event: "commit",
        text: details?.text,
      });
    }
  }

  // Jev action response
  if (event === "action response completed") {
    const act = details?.result?.action;
    const chosen = details?.selectedAction;
    const phrase = details?.result?.backchannelText;
    const timedWaitNoul = details?.timedWaitNoul;
    const diag = details?.answerDiagnostics;

    if (act && actionCounts[act] !== undefined) {
      actionCounts[act]++;
    }

    if (act === "backchannel" && phrase) {
      backchannelCounts[phrase] = (backchannelCounts[phrase] || 0) + 1;
    }

    jevDecisions.push({
      time,
      revision: details?.result?.revision,
      finalAction: act,
      selectedAction: chosen,
      phrase,
      timedWaitNoul,
      diagnostics: diag,
    });

    speechTimeline.push({
      time,
      source: "Jev",
      event: `action:${act}${phrase ? ` ("${phrase}")` : ""}`,
      details: { chosen, timedWaitNoul },
    });
  }

  // Jev response discarded / blocked
  if (
    event === "action blocked by runtime state" ||
    event === "response discarded before application"
  ) {
    discards.push({
      time,
      event,
      details,
    });
    speechTimeline.push({
      time,
      source: "RuntimeGuard",
      event: `blocked/discarded: ${event}`,
      details,
    });
  }

  // Backchannel suppressed
  if (event === "backchannel suppressed by cooldown") {
    discards.push({
      time,
      event: "backchannel_cooldown",
      details,
    });
    speechTimeline.push({
      time,
      source: "CooldownGuard",
      event: "backchannel suppressed",
      details,
    });
  }

  // Turn started / sentence playback
  if (event === "turn accepted") {
    executedTurns.push({
      time,
      revision: details?.revision,
      options: details?.options,
    });
    speechTimeline.push({
      time,
      source: "Turn",
      event: `start (trigger: ${details?.options?.trigger}, jevAction: ${details?.options?.jevAction})`,
      text: details?.options?.text || details?.options?.fixedReply,
    });
  }

  if (event === "sentence playback started") {
    speechTimeline.push({
      time,
      source: "Audio",
      event: `playback started [${details?.fixedReply ? "fixed-backchannel" : "sentence"}]`,
      text: details?.text,
    });
  }

  if (event === "yielding current turn to user") {
    speechTimeline.push({
      time,
      source: "Interrupt",
      event: "yielded to user",
      text: details?.spokenText,
    });
  }
}

// 1. Jev Action Counts
console.log(`--- [1. Jev Action Counts] ---`);
for (const [action, count] of Object.entries(actionCounts)) {
  console.log(`  ${action.padEnd(12)}: ${count}`);
}

// 2. Backchannel Phrases
console.log(`\n--- [2. Backchannel Phrases Played] ---`);
if (Object.keys(backchannelCounts).length === 0) {
  console.log(`  (None)`);
} else {
  for (const [phrase, count] of Object.entries(backchannelCounts)) {
    console.log(`  ${phrase.padEnd(12)}: ${count}`);
  }
}

// 3. Blocked / Discarded Decisions
console.log(`\n--- [3. Blocked / Suppressed Decisions] (${discards.length}) ---`);
if (discards.length === 0) {
  console.log(`  (None - all actions executed successfully)`);
} else {
  for (const d of discards.slice(-5)) {
    console.log(`  [${d.time}] ${d.event}:`, JSON.stringify(d.details));
  }
  if (discards.length > 5) {
    console.log(`  ... and ${discards.length - 5} more.`);
  }
}

// 4. Recent Timeline
console.log(`\n--- [4. Recent Timeline (Last 20 Events)] ---`);
for (const item of speechTimeline.slice(-20)) {
  console.log(
    `  ${item.time.slice(11, 23)} [${item.source.padEnd(14)}] ${item.event}${
      item.text ? ` -> "${item.text.slice(0, 50)}"` : ""
    }`,
  );
}
console.log(`\n=======================================================\n`);
