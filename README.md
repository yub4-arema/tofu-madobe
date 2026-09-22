# tofu-madobe

ブラウザを小さく表示・最小化して使う、ローカル常駐型の音声対話AItuberです。

- ElevenLabs Scribe v2 Realtimeが発話を文字列へ変換します。
- 通常会話では確定した文字起こしを`今すぐ送る`からLLMへ送ります。
- 定期発話は通常会話・自然会話のどちらでも有効にでき、発話中も文字起こしを継続します。
- 自然会話ではJevが1秒ごとに会話状況を判断し、必要な場合だけLLMへ発話を依頼します。
- 読み上げはローカルのUtauTTS Serverを使用します。自然会話ではJevがVTube Studioの登録済みホットキーも選択します。
- 会話履歴は開いている画面内だけで保持します。設定はブラウザに保存します。

## セットアップ

```powershell
Copy-Item .env.example .env.local
pnpm install
pnpm dev:local
```

先にUtauTTS Serverを `.env.local` の `UTAUTTS_BASE_URL` で起動してください。LLM、ElevenLabs、TypeSafeのキーも `.env.local` で設定します。VTube Studioを使う場合はPlugin APIを有効にし、ブラウザで <http://localhost:3000> を開いて `常駐を開始` からマイク権限を許可してください。

本番起動は `pnpm build` の後に `pnpm start:local` を使います。

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
- [VTube Studio Public API](https://github.com/DenchiSoft/VTubeStudio)
