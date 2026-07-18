# tofu-madobe

ブラウザを小さく表示・最小化して使う、ローカル常駐型の音声対話AItuberです。

- マイクON中の発話区間をため、定期実行時に1本のWAVとしてAIへ送信します。
- `今すぐ送る` は現在までの録音をその場で送信し、返答を開始します。
- 録音が無い定期実行では短い一人雑談を行います。
- 手動・定期実行・自動対話を切り替えられます。自動対話は、最低発話時間を満たしたあと指定時間の無音が続くと送信します。
- OpenAI互換Chat Completions、VOICEVOX、VTube Studioモーションに対応します。
- 会話履歴と送信済み録音はローカルの `.data` だけに保存します。

## セットアップ

```powershell
Copy-Item .env.example .env.local
pnpm install
pnpm dev:local
```

VOICEVOXをローカルで使う場合は先に起動します。外部のsu-shiki/TTSQuest APIを使う場合は `.env.local` に `SU_SHIKI_API_KEY` を設定し、次で起動します。

```powershell
pnpm dev:api
```

どちらのスクリプトも `.env.local` の `VOICEVOX_MODE` を一時的に上書きします。VTube StudioではPlugin APIを有効にし、ブラウザで <http://localhost:3000> を開いて `常駐を開始` からマイク権限を許可してください。

本番起動は `pnpm build` の後に `pnpm start:local` または `pnpm start:api` を使います。サーバーログはターミナルと `.data/logs/server.ndjson` に残ります。受信音声の有無、文の切り出し、VOICEVOX合成、音声配信、返答完了・失敗を記録します。

ブラウザを閉じた場合、PCがスリープした場合、ブラウザがタブを破棄した場合は動作しません。最小化中の定期時刻はサーバー側SSEで通知し、録音はAudioWorkletで継続します。

## 確認

```powershell
pnpm check
```
