# tofu-madobe

ブラウザを小さく表示・最小化して使う、ローカル常駐型の音声対話AItuberです。

- ElevenLabs Scribe v2 Realtimeが発話を文字列へ変換します。
- 通常会話では確定した文字起こしを`今すぐ送る`からLLMへ送ります。
- 定期発話は通常会話・自然会話のどちらでも有効にでき、発話中も文字起こしを継続します。
- 自然会話ではJevが0.5秒ごとに会話状況を判断し、必要な場合だけLLMへ発話を依頼します。
- 読み上げは設定画面からローカルのUtauTTS Serverまたはtts.questのVOICEVOX APIを選択できます。自然会話ではJevがVTube Studioの登録済みホットキーも選択します。
- LLMの出力は全文完成を待たず、`、。！？!?` が出た区切りごとに順次TTSへ渡します。
- 会話履歴は開いている画面内だけで保持します。設定はブラウザに保存します。

## 初回セットアップ

```powershell
Copy-Item .env.example .env.local
pnpm install
```

`.env.local` にLLM、ElevenLabs、TypeSafeのAPIキーを設定します。

音声合成は設定画面で次のどちらかを選べます。

- `UtauTTS（ローカル）`: `.env.local` の `UTAUTTS_*` を使用します。既定の接続先は `http://127.0.0.1:18080` です。
- `VOICEVOX（tts.quest）`: ローカルTTSサーバーは不要です。有効な `VOICEVOX_API_KEY` と残ポイントがある場合に高速合成を利用できます。キーを取得するときはVOICEVOX用の利用登録を有効にしてください。キーが無効、またはポイントがない場合は低速になります。

## 毎回の起動手順

### 1. VTube Studioを使う場合は起動

自然会話でモーションを使う場合はVTube Studioを起動し、Plugin APIを有効にします。VTube Studioを使わない場合は起動しなくても音声会話自体は動作します。

### 2. tofu-madobeを起動

このリポジトリのディレクトリで実行します。

```powershell
pnpm dev:local
```

`dev:local` は `127.0.0.1:18080` を確認し、UtauTTS Serverが止まっていれば自動起動します。既に起動済みならそのServerをそのまま使います。既定では `.data/utautts-v1.3.0/utautts-server.exe` と `Documents/OpenUtau/Singers` を使用し、必要なら `UTAUTTS_SERVER_EXE` / `UTAUTTS_VOICE_DIR` で変更できます。`start:local` も同じ動作です。

`.env.local` の `UTAUTTS_VOICEBANK_ID`、`UTAUTTS_RENDERER`、`UTAUTTS_MODEL_ID` に指定したIDがServer側で利用可能になっている必要があります。必要なら <http://127.0.0.1:18080/> のコンソールUIで音源・Renderer・モデルを確認します。

ブラウザで <http://localhost:3000> を開き、設定画面で音声合成方式を選択して `常駐を開始` を押します。初回はマイク権限を許可します。

自然会話モードで `常駐を開始` するたびに、`.data/logs/natural-<日時>-<ID>.ndjson` が新規作成され、その起動分のログが保存されます。通常会話・定期実行は従来どおり `.data/logs/session.ndjson` を使用します。

## 本番起動

```powershell
pnpm build
pnpm start:local
```

ブラウザを閉じた場合、PCがスリープした場合、ブラウザがタブを破棄した場合は動作しません。最小化中の定期時刻はサーバー側SSEで通知し、文字起こしはScribe Realtimeで継続します。

## 確認

```powershell
pnpm check
pnpm test
```

## 参照資料

- [Gemini APIのOpenAI互換性](https://ai.google.dev/gemini-api/docs/openai?hl=ja)
- [OpenAI JavaScript SDK](https://github.com/openai/openai-node)
- [ElevenLabs Scribe Realtime](https://elevenlabs.io/docs/eleven-api/resources/libraries/scribe-stt/javascript-scribe)
- [TypeSafe AI](https://docs.typesafe.ai/introduction/quickstart)
- [UtauTTS Server](https://github.com/yh2237/UtauTTS/blob/main/docs/server.md)
- [tts.quest VOICEVOX API V3](https://github.com/ts-klassen/ttsQuestV3Voicevox)
- [VTube Studio Public API](https://github.com/DenchiSoft/VTubeStudio)
