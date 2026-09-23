import { normalizePhrases } from "@/lib/conversation-state";
import { debugError, debugLog, debugWarn } from "@/lib/debug-log";
import type {
  AssistantState,
  ChatHistoryMessage,
  ConversationTiming,
  JevAction,
  JevEvaluationReason,
  JevRequest,
  JevResponse,
  ScheduledSpeechState,
  VTubeHotkey,
} from "@/lib/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actions = new Set<JevAction>(["wait", "backchannel", "respond", "interrupt", "topic"]);
const reasons = new Set<JevEvaluationReason>(["clock_tick"]);

function answerDiagnostics(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const answer = value as Record<string, unknown>;
  return {
    choice: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
    noul: answer.noul,
  };
}

function messages(value: unknown): ChatHistoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { role, content } = item as Record<string, unknown>;
      return (role === "user" || role === "assistant") &&
        typeof content === "string" &&
        content.trim()
        ? [{ role, content: content.trim().slice(0, 4000) } as ChatHistoryMessage]
        : [];
    })
    .slice(-16);
}

function hotkeys(value: unknown): VTubeHotkey[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { id, name, type } = item as Record<string, unknown>;
      return typeof id === "string" && id && typeof name === "string" && typeof type === "string"
        ? [{ id: id.slice(0, 200), name: name.slice(0, 200), type: type.slice(0, 100) }]
        : [];
    })
    .slice(0, 254);
}

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value.slice(0, 100)
    : null;
}

function timing(value: unknown): ConversationTiming | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.now !== "string") return null;
  return {
    now: data.now.slice(0, 100),
    conversationStartedAt:
      typeof data.conversationStartedAt === "string"
        ? data.conversationStartedAt.slice(0, 100)
        : null,
    conversationElapsedMs: nullableNumber(data.conversationElapsedMs),
    currentPartialElapsedMs: nullableNumber(data.currentPartialElapsedMs),
    sinceLastUserActivityMs: nullableNumber(data.sinceLastUserActivityMs),
    sinceLastCommitMs: nullableNumber(data.sinceLastCommitMs),
    assistantStateElapsedMs: nullableNumber(data.assistantStateElapsedMs) ?? 0,
    sinceAssistantSpeechEndedMs: nullableNumber(data.sinceAssistantSpeechEndedMs),
  };
}

function parse(value: unknown): JevRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const transcript = body.transcriptState;
  const reason = body.reason;
  if (
    !Number.isSafeInteger(body.revision) ||
    !Number.isSafeInteger(body.transcriptRevision) ||
    !reasons.has(reason as JevEvaluationReason) ||
    !transcript ||
    typeof transcript !== "object"
  )
    return null;
  const state = transcript as Record<string, unknown>;
  const partial = state.partial;
  if (!partial || typeof partial !== "object") return null;
  const partialState = partial as Record<string, unknown>;
  const assistant = body.assistantState;
  const scheduled = body.scheduledSpeech;
  const parsedTiming = timing(body.timing);
  if (!(assistant === "idle" || assistant === "generating" || assistant === "speaking"))
    return null;
  if (!(scheduled === "idle" || scheduled === "generating" || scheduled === "speaking"))
    return null;
  if (!parsedTiming) return null;
  const active = body.activeTurn;
  const activeTurn =
    active && typeof active === "object"
      ? (() => {
          const item = active as Record<string, unknown>;
          const trigger = item.trigger;
          const jevAction = item.jevAction;
          const startedAt = timestamp(item.startedAt);
          if (
            !(trigger === "user" || trigger === "jev") ||
            !(jevAction === null || actions.has(jevAction as JevAction)) ||
            !startedAt
          )
            return null;
          return {
            trigger: trigger as "user" | "jev",
            jevAction: jevAction as JevAction | null,
            playingText:
              typeof item.playingText === "string" ? item.playingText.slice(0, 1000) : "",
            startedAt,
            playingStartedAt: timestamp(item.playingStartedAt),
            playingElapsedMs: nullableNumber(item.playingElapsedMs),
            playedSentenceCount:
              typeof item.playedSentenceCount === "number" &&
              Number.isSafeInteger(item.playedSentenceCount) &&
              item.playedSentenceCount >= 0
                ? item.playedSentenceCount
                : 0,
            fixedReply: item.fixedReply === true,
          };
        })()
      : null;
  const playback = body.playback;
  if (!playback || typeof playback !== "object") return null;
  const playbackState = playback as Record<string, unknown>;
  const playbackTurnRevision = playbackState.turnRevision;
  const playbackTrigger = playbackState.trigger;
  if (
    !(
      playbackTurnRevision === null ||
      (typeof playbackTurnRevision === "number" && Number.isSafeInteger(playbackTurnRevision))
    ) ||
    !(
      playbackTrigger === null ||
      playbackTrigger === "user" ||
      playbackTrigger === "scheduled" ||
      playbackTrigger === "jev"
    ) ||
    !(playbackState.currentTextStartedAt === null || timestamp(playbackState.currentTextStartedAt))
  )
    return null;
  const recentBackchannelValue = body.recentBackchannel;
  const recentBackchannel =
    recentBackchannelValue && typeof recentBackchannelValue === "object"
      ? (() => {
          const item = recentBackchannelValue as Record<string, unknown>;
          const spokenAt = timestamp(item.spokenAt);
          return typeof item.text === "string" && spokenAt
            ? { text: item.text.slice(0, 200), spokenAt }
            : null;
        })()
      : null;
  const backchannelCooldownRemainingMs = nullableNumber(body.backchannelCooldownRemainingMs);
  if (backchannelCooldownRemainingMs === null) return null;
  return {
    revision: body.revision as number,
    transcriptRevision: body.transcriptRevision as number,
    reason: reason as JevEvaluationReason,
    transcriptState: {
      partial: {
        text: typeof partialState.text === "string" ? partialState.text.slice(0, 4000) : "",
        startedAt: timestamp(partialState.startedAt),
        updatedAt: timestamp(partialState.updatedAt),
        activeForSeconds: nullableNumber(partialState.activeForSeconds),
        unchangedForSeconds: nullableNumber(partialState.unchangedForSeconds),
        overlappedAssistant: partialState.overlappedAssistant === true,
        overlapResolved: partialState.overlapResolved === true,
      },
      confirmed: Array.isArray(state.confirmed)
        ? state.confirmed
            .flatMap((item) => {
              if (!item || typeof item !== "object") return [];
              const entry = item as Record<string, unknown>;
              const startedAt = timestamp(entry.startedAt);
              const committedAt = timestamp(entry.committedAt);
              const speechDurationSeconds = nullableNumber(entry.speechDurationSeconds);
              const committedAgoSeconds = nullableNumber(entry.committedAgoSeconds);
              return typeof entry.text === "string" &&
                entry.text &&
                Number.isSafeInteger(entry.revision) &&
                startedAt &&
                committedAt &&
                speechDurationSeconds !== null &&
                committedAgoSeconds !== null
                ? [
                    {
                      text: entry.text.slice(0, 4000),
                      revision: entry.revision as number,
                      startedAt,
                      committedAt,
                      speechDurationSeconds,
                      committedAgoSeconds,
                      overlappedAssistant: entry.overlappedAssistant === true,
                      overlapResolved: entry.overlapResolved === true,
                    },
                  ]
                : [];
            })
            .slice(-16)
        : [],
      hasUncommittedSpeech: state.hasUncommittedSpeech === true,
    },
    history: messages(body.history),
    assistantState: assistant as AssistantState,
    scheduledSpeech: scheduled as ScheduledSpeechState,
    activeTurn,
    playback: {
      queueBusy: playbackState.queueBusy === true,
      state: assistant as AssistantState,
      turnRevision: playbackTurnRevision as number | null,
      trigger: playbackTrigger as "user" | "scheduled" | "jev" | null,
      fixedReply: playbackState.fixedReply === true,
      currentText:
        typeof playbackState.currentText === "string"
          ? playbackState.currentText.slice(0, 1000)
          : "",
      turnStartedAt: timestamp(playbackState.turnStartedAt),
      currentTextStartedAt: timestamp(playbackState.currentTextStartedAt),
      currentTextElapsedMs: nullableNumber(playbackState.currentTextElapsedMs),
    },
    recentBackchannel,
    backchannelCooldownRemainingMs,
    backchannelPhrases: normalizePhrases(
      Array.isArray(body.backchannelPhrases)
        ? body.backchannelPhrases
            .filter((item): item is string => typeof item === "string")
            .join("\n")
        : "",
    ),
    hotkeys: hotkeys(body.hotkeys),
    timing: parsedTiming,
  };
}

async function callJev(
  input: JevRequest,
  scope: string,
  request: Request,
  questions: Record<string, unknown>,
) {
  const url = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1/systemone";
  const payload = {
    model: process.env.TYPESAFE_MODEL ?? "jev-latest",
    state: JSON.stringify(input),
    questions,
  };
  debugLog(scope, "upstream request started", { url, payload, authConfigured: true });
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: request.signal,
    });
    const data = await response.json().catch(() => null);
    debugLog(scope, "upstream response received", {
      status: response.status,
      ok: response.ok,
      data,
      elapsedMs: Date.now() - startedAt,
    });
    return { response, data };
  } catch (error) {
    debugError(scope, "upstream request failed", error, {
      elapsedMs: Date.now() - startedAt,
      aborted: request.signal.aborted,
    });
    throw error;
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  if (!process.env.TYPESAFE_API_KEY) {
    debugWarn("jev-route", "request rejected: TYPESAFE_API_KEY is missing");
    return Response.json({ error: { message: "TYPESAFE_API_KEYが必要です。" } }, { status: 500 });
  }
  const raw = await request.json().catch((error: unknown) => {
    debugError("jev-route", "request JSON parse failed", error);
    return null;
  });
  const input = parse(raw);
  if (!input) {
    debugWarn("jev-route", "request rejected: invalid input", { raw });
    return Response.json({ error: { message: "Jevへの入力が不正です。" } }, { status: 400 });
  }
  const scope = `jev-route:${input.revision}`;
  debugLog(scope, "request accepted", { input });

  const hasOverlappedSpeech =
    (input.transcriptState.partial.overlappedAssistant &&
      !input.transcriptState.partial.overlapResolved) ||
    input.transcriptState.confirmed.some(
      ({ overlappedAssistant, overlapResolved }) => overlappedAssistant && !overlapResolved,
    );
  const floorEvaluation =
    input.reason === "clock_tick" &&
    !input.activeTurn?.fixedReply &&
    !input.playback.fixedReply &&
    input.assistantState === "speaking" &&
    (input.transcriptState.hasUncommittedSpeech || hasOverlappedSpeech);

  if (floorEvaluation) {
    let upstream;
    try {
      upstream = await callJev(input, scope, request, {
        floor_control: {
          type: "choice",
          instructions:
            "madobeは現在発話中です。届いたユーザー発話の意図を判断し、madobeが発話を続けるべきか（keep_floor）、ユーザーに発話権を返すべきか（yield_floor）を選んでください。" +
            "partial.textは更新途中のため短い語の後に続きが来る可能性を考慮してください。" +
            "madobeが答えようとしている内容をユーザーがまだ求めている・理解できていない場合はkeep_floor。" +
            "ユーザーが明確に停止・訂正・話題転換を求めている場合はyield_floor。",
          criteria: {
            keep_floor:
              "「うん」「あー」「なるほど」「へえ」など短い傾聴反応・笑い；madobeが答えようとしている同じ問いの継続や繰り返し（「なんだっけ」「わかんない」「教えて」など）；「え、何？」「もう一回」など現在の回答を求め続けている；新しい話題か補足か判断できない短い発話",
            yield_floor:
              "「いや違う」「ちょっと待って」「それは違う」など明確な訂正・停止要求；「やっぱいいや」「それは置いといて」「他にさ」「別の話なんだけど」など話題の撤回・転換；新しい主張や情報を積極的に話し始めた",
          },
        },
      });
    } catch (error) {
      return Response.json(
        { error: { message: error instanceof Error ? error.message : "Jevへ接続できません。" } },
        { status: 502 },
      );
    }
    const data = upstream.data as { answers?: { floor_control?: unknown } } | null;
    const floorControl = (data?.answers?.floor_control as Record<string, unknown> | undefined)
      ?.choice;
    if (
      !upstream.response.ok ||
      !(floorControl === "keep_floor" || floorControl === "yield_floor")
    ) {
      debugWarn(scope, "floor response rejected", {
        status: upstream.response.status,
        floorControl,
        data,
      });
      return Response.json(
        { error: { message: "Jevの発話権制御応答が不正です。" } },
        { status: 502 },
      );
    }
    const result: JevResponse = {
      revision: input.revision,
      kind: "floor",
      floorControl,
      diagnostics: answerDiagnostics(data?.answers?.floor_control) as Record<string, unknown>,
    };
    debugLog(scope, "floor response completed", {
      result,
      answerDiagnostics: answerDiagnostics(data?.answers?.floor_control),
      elapsedMs: Date.now() - startedAt,
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  }


  const hotkeyChoices = input.hotkeys.map((hotkey, index) => ({ key: `hotkey_${index}`, hotkey }));
  const backchannelPhraseChoices = input.backchannelPhrases.map((text, index) => ({
    key: `phrase_${index}`,
    text,
  }));
  const actionCriteria: Record<string, string> = {
    wait: "今この0.5秒間だけ発声せず聞き役に徹するのが自然な場合に限って選ぶ。相づちを打つべきタイミング、ユーザーが返答を求めている場合、または十分な沈黙がある場合はwaitを選ばない。迷った場合の既定値としてwaitを使ってはいけない。",
    backchannel:
      "ユーザーが発話中であり、相手の発話を遮らずに『うん』『なるほど』などの短い相づちを1回挟んで傾聴の姿勢を示す。相づちクールダウンが0で、ユーザーの話が数秒以上続いている場合に選ぶ",
    respond:
      "今ここでLLMへ返答生成を依頼する。ユーザーが発話を終えた、返答を求めた、質問が十分明確、または会話上すぐ返すべきと判断した場合に選ぶ。partial.textが疑問・依頼として文意が完結していて（「〜だったっけ？」「〜って何？」「〜を教えて」など）unchangedForSecondsが0.6以上の場合は、confirmedが空でもrespondを選ぶ。commitを待つ必要はない。返答内容や方向性はJevで決めず、LLMへ任せる",
    interrupt: "緊急の訂正、停止要求、明確な発話権の奪取など、本当に今の発話へ割り込む必要がある",
    topic:
      "ユーザー入力がなく、未応答のconfirmedもなく、会話が空いて十分な時間が経過したため自分から新しい話題を始める。ユーザーの発話への返答ならrespondを選ぶ",
  };
  const phraseDescriptions: Record<string, string> = {
    "うん。": "基本的・ニュートラルな相づち。相手の話を遮らず淡々と聞き進める際に最も自然。",
    "あー。": "相手の言いたいことや前提を把握したときの受容・感嘆の相づち。",
    "なるほど。": "理由や背景、仕組み、ロジックの説明を聞いて合点がいった・理解したときの相づち。",
    "たしかに。": "相手の意見や指摘、評価に共感・同意するときの相づち。",
    "そうなんだ。": "相手の身の回りの出来事、近況報告、新しい事実を興味深く受け止める相づち。",
    "へえ。": "意外な事実や珍しい情報、面白いポイントに対して軽く驚き・関心を示す相づち。",
  };
  const backchannelPhraseCriteria = Object.fromEntries(
    (backchannelPhraseChoices.length > 0
      ? backchannelPhraseChoices
      : [{ key: "phrase_0", text: "うん。" }]
    ).map(({ key, text }) => {
      const desc = phraseDescriptions[text] || `相づち文言「${text}」`;
      return [key, `「${text}」: ${desc}`];
    }),
  );
  const hotkeyCriteria = Object.fromEntries([
    ["none", "ホットキーを実行しない"],
    ...hotkeyChoices.map(({ key, hotkey }) => [
      key,
      `${hotkey.name} (${hotkey.type}, ID: ${hotkey.id})`,
    ]),
  ]);

  const recentBcText = input.recentBackchannel?.text;
  const backchannelInstructions =
    "actionでbackchannelを選んだ場合に再生する相づち文言を一つ選んでください。" +
    "ユーザーの話している内容（説明・ロジック・意見・出来事の報告・単なる継続）に最も適した文言を選びます。" +
    (recentBcText
      ? ` 直前の相づちは「${recentBcText}」でした。同じ相づちを機械的に連打せず、文脈に合う別の自然な相づちを優先してください。`
      : " 会話の流れに合う自然な相づちを選びます。");

  let upstream;
  try {
    upstream = await callJev(input, scope, request, {
      action: {
        type: "choice",
        instructions:
          "デスクトップ常駐AItuberが今この0.5秒tickで取る会話上の行動を一つ選んでください。partial.textはScribeが現在認識中の未確定全文、confirmedはVADで確定した区間です。各confirmedにはcommittedAgoSecondsがあり、発話が確定してから何秒経ったかを示します。Jevは返答内容・話題・説明の方向性を作りません。Jevが決めるのは、今だけ待つ、定型相づちを返す、LLMへ返答生成を依頼する、本当に割り込む、自発話を始める、のタイミングだけです。未応答のconfirmedが残っている場合、明示的な待機指定が有効な間を除き、waitを繰り返さずrespondを選んでください。ユーザーが『N秒後に話して』と指定している場合は、現在時刻・committedAgoSeconds・sinceLastCommitMsを比較し、指定時間を過ぎたらrespondまたはtopicを選んでください。ユーザーが継続して話しており相づちクールダウンが0なら、聞き手として積極的にbackchannelを選んでください。固定相づちの再生中だけは新しい発話を開始せずwaitを選んでください。partial.textが疑問・依頼として文意が完結していて（例：「〜だったっけ？」「〜って何？」「〜を教えて」「なんだっけなあ」）unchangedForSecondsが0.6以上であればconfirmedが空でもrespondを選んでください。commitを待つ必要はありません。",
        criteria: actionCriteria,
      },
      backchannel_phrase: {
        type: "choice",
        instructions: backchannelInstructions,
        criteria: backchannelPhraseCriteria,
      },
      timed_wait_active: {
        type: "noul",
        instructions:
          "Does any entry in `transcriptState.confirmed` tell the assistant to wait N seconds, with that same entry's `committedAgoSeconds` still less than N? For example, text saying 10秒待って with committedAgoSeconds 5 is yes; with committedAgoSeconds 12 it is no. A later user message cancelling the wait is also no.",
      },
      hotkey: {
        type: "choice",
        instructions:
          "同じ会話状況に合うVTube Studioホットキーを一つ選んでください。actionの回答には依存せず、不要ならnoneにしてください。",
        criteria: hotkeyCriteria,
      },
    });
  } catch (error) {
    return Response.json(
      { error: { message: error instanceof Error ? error.message : "Jevへ接続できません。" } },
      { status: 502 },
    );
  }
  const data = upstream.data as {
    answers?: Record<string, unknown>;
  } | null;
  if (!upstream.response.ok) {
    debugWarn(scope, "upstream response rejected", { status: upstream.response.status, data });
    return Response.json(
      { error: { message: `Jev request failed: ${upstream.response.status}` } },
      { status: 502 },
    );
  }
  const selectedAction = (data?.answers?.action as Record<string, unknown> | undefined)?.choice;
  const timedWaitNoul = (data?.answers?.timed_wait_active as Record<string, unknown> | undefined)
    ?.noul;
  const selectedHotkey = (data?.answers?.hotkey as Record<string, unknown> | undefined)?.choice;
  const selectedPhraseKey = (
    data?.answers?.backchannel_phrase as Record<string, unknown> | undefined
  )?.choice;
  const selectedPhrase =
    backchannelPhraseChoices.find(({ key }) => key === selectedPhraseKey)?.text ??
    input.backchannelPhrases[0] ??
    "うん。";

  if (typeof selectedAction !== "string" || !actions.has(selectedAction as JevAction)) {
    debugWarn(scope, "upstream action rejected", { selectedAction, data });
    return Response.json({ error: { message: "Jevのaction応答が不正です。" } }, { status: 502 });
  }
  if (typeof timedWaitNoul !== "number" || timedWaitNoul < 0 || timedWaitNoul > 1) {
    debugWarn(scope, "upstream timed wait answer rejected", { timedWaitNoul, data });
    return Response.json({ error: { message: "Jevの待機時間判断が不正です。" } }, { status: 502 });
  }
  const timedWait = timedWaitNoul >= 0.5;
  const action: JevAction = timedWait ? "wait" : (selectedAction as JevAction);
  const diagnostics = Object.fromEntries(
    Object.entries(data?.answers ?? {}).map(([key, answer]) => [key, answerDiagnostics(answer)]),
  );
  const result: JevResponse = {
    revision: input.revision,
    kind: "action",
    action,
    backchannelText: !timedWait && action === "backchannel" ? selectedPhrase : null,
    hotkeyID: hotkeyChoices.find(({ key }) => key === selectedHotkey)?.hotkey.id ?? null,
    diagnostics,
  };
  debugLog(scope, "action response completed", {
    result,
    selectedAction,
    timedWaitNoul,
    selectedHotkeyChoice: selectedHotkey,
    answerDiagnostics: Object.fromEntries(
      Object.entries(data?.answers ?? {}).map(([key, answer]) => [key, answerDiagnostics(answer)]),
    ),
    elapsedMs: Date.now() - startedAt,
  });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
