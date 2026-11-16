# 同時セッション数制御（デモ実装）

> 本ドキュメントとコードは、検討用の参考実装（デモ）です。動作を保証するものではありません。
> 本番環境で利用する場合は、貴社の要件に合わせて設計・検証を実施してください。

## 1. 概要

ログイン後にサイトを利用しているブラウザー（または利用者）を 1 セッションとして数え、
会社ごとに設定した最大数を超えないように制御します。Power BI レポートを表示していない利用者も対象です。

- セッション情報は Azure Cosmos DB for NoSQL に保存します（1 アカウントを複数社で共用し、会社ごとにコンテナーを分けます）。
- 同時にログインが集中しても最大数を超えないよう、**スロット方式 + ETag 条件付き更新** で枠を確保します。
- 更新の安全余裕時間、警告時間、TTL、最大数などは **Function App のアプリ設定** で変更できます。
  フロントエンドを再ビルドする必要はありません。
- Functions の実行回数を抑えるため、以下の工夫をしています。
  - heartbeat はブラウザー単位で 1 回だけ送信します（複数タブで重複送信しません）。
  - 既定の `activity` モードは、サーバーの `expiresAt − 安全余裕時間` に、前回延長後の操作があれば延長します。
    操作がなければ通信せず、警告後も無操作ならセッションを解放してログアウトします。
  - 業務 API（ファイル一覧、Power BI 埋め込みトークン発行など）は既定ではポイント読み取りだけで有効性を確認します。
    `SESSION_API_EXTEND=true` にすると、従来どおり業務 API でも延長します。
  - 最後のタブを閉じたときに解放要求を送信します。届かなかった場合は TTL 経過後に自動で解放されます。

## 2. 仕組み

```
Browser ──(SWA 認証)──> Static Web Apps ──/api/*──> Azure Functions ──> Cosmos DB
                                                      (Flex 従量課金)      sessiondb / sessions-<会社>
```

### スロット方式

- コンテナーには、最大数と同じ数の「スロット」ドキュメント（`slot-0000` 〜）を置きます。
  スロットは初回のセッション取得時に自動作成されます。
- `expiresAt`（UNIX 時刻・秒）が現在時刻以前のスロットは「空き」とみなします。
- 空きスロットは ETag 条件付き更新で確保するため、同時に要求が来ても 1 つのスロットを
  2 人が確保することはありません。Functions が複数インスタンスにスケールアウトしても同様です。
- heartbeat と解放は、「自分が保持しているスロットの場合だけ更新する」条件付き部分更新（filter predicate）で
  1 回の通信で行います。

スロットの例：

```json
{
  "id": "slot-0003",
  "companyId": "company-a",
  "type": "slot",
  "slotNo": 3,
  "sessionKey": "<ユーザーとブラウザー ID の SHA-256>",
  "userId": "user01@contoso.com",
  "acquiredAt": 1767225600,
  "expiresAt": 1767226500,
  "lastSeenAt": 1767225900
}
```

### 処理の流れ

| タイミング | ブラウザー | サーバー |
|---|---|---|
| ログイン後 | `POST /api/session/acquire` | 自分のスロットがあれば延長、なければ空きスロットを確保。満席なら 409 |
| 利用中 | 業務 API の呼び出し時にセッションヘッダーを付与 | 所有者・有効期限をポイント読み取りで確認（書き込みなし）。`X-Session-Expires-At` と `X-Session-Extended: false` を返す。無効なら 410 |
| `expiresAt − 安全余裕時間` | 前回の延長以降に操作があり、無操作警告中でなければ `POST /api/session/heartbeat`（ブラウザーで 1 回）。操作なしなら通信なし | 自分のスロットなら延長。他者に割り当て済みなら 410 |
| `最後の操作 + TTL − 警告時間` | 全タブに警告を表示。操作すると閉じ、無操作期限を再計算。サーバーの更新時刻を過ぎている場合だけ即時延長 | |
| 警告後も無操作 | `release`（`reason: idle`、keepalive）をブラウザーで 1 回送信し、全タブで `/.auth/logout` へ移動 | スロットを空きに戻す |
| 410 を受信 | `acquire` で取り直し。満席なら上限画面を表示 | |
| 最後のタブを閉じる | `sendBeacon` で `POST /api/session/release` | スロットを空きに戻す |
| サインアウト | `release` を送信してから `/.auth/logout` | スロットを空きに戻す |
| 異常終了 | （送信なし） | TTL 経過後に空きとして再利用 |

セッション API とセッション検証済み業務 API の応答には `Cache-Control: no-store` を付けます。
フロントエンドの API 呼び出しも `cache: "no-store"` を指定し、取得済みの古い 410 応答を再利用しません。
410 は明示的な禁止がなければキャッシュされ得るため、新しいセッションを取得しても古い失効応答を
読み続ける問題を防ぐには、サーバー・ブラウザーの両方でキャッシュを無効にする必要があります。

### activity モードの 2 つの時計

| 判定 | 計算式 |
|---|---|
| サーバー更新予定 | `expiresAt − SESSION_RENEWAL_MARGIN_SECONDS` |
| 無操作ログアウト | `最後の操作時刻 + SESSION_TTL_SECONDS` |
| 無操作警告 | `無操作ログアウト時刻 − SESSION_WARNING_SECONDS` |

サーバー更新と無操作判定は独立しています。操作は無操作期限を後ろに移動しますが、
そのたびに API を呼び出すことはありません。サーバー延長成功は `expiresAt` を後ろに移動しますが、
最終操作時刻を変更せず、無操作ログアウトを先送りしません。

既定値（TTL 900 秒、安全余裕 120 秒、警告 60 秒）の例：

- 0 分：取得し、ブラウザー共通の最終操作時刻を初期化します。
- 13 分：サーバー更新予定。操作が継続していれば 1 回だけ延長します。操作がなければ通信しません。
  300 秒や 600 秒ごとの固定 heartbeat は行いません。
- 最終操作から 14 分：警告を表示します。
- 最終操作から 15 分：操作がなければ解放してログアウトします。
  ログアウト後は公開 URL `/session-logged-out?reason=idle` で「無操作のため自動的にログアウトしました。」と表示します。
  この URL 以外の既存ページは引き続き SWA 認証が必要です。
- 1 分時点で一度だけ操作して止めた場合、13 分でサーバーが延長されても、
  無操作警告は 15 分、ログアウトは 16 分のままです。延長時刻からさらに 15 分待つ動作にはしません。
- サーバーの TTL（既定 900 秒）は、端末の異常終了や解放要求の未達時に枠を回収する安全網です。
  クライアントの警告・ログアウトとは別に判定します。

更新予定時刻を過ぎてから操作した場合は即時延長します。
警告を閉じる操作でも、サーバーの期限にまだ余裕があれば API は呼ばず、予定時刻まで待ちます。
ネットワーク障害時はブラウザー全体で 60 秒後に再試行し、操作ごとに連続送信しません。
無操作警告中の自動延長は行わず、無操作期限を過ぎた場合は更新要求が停止中でもログアウトします。
サーバー期限を過ぎてしまった場合は、既存の 410 処理で再取得します。
タブ間の時刻は localStorage で共有し、操作時刻の書き込みは最大 5 秒に 1 回です。
すべて絶対時刻で判定し、カウントダウンを減算してセッション期限を決めることはありません。
タブ登録維持のローカルチェックは最大 60 秒間隔ですが、API 通信の間隔ではありません。

`interval` モードでは従来の固定間隔 heartbeat を継続し、無操作警告・自動ログアウトは行いません。

## 3. 変更・追加ファイル

| ファイル | 内容 |
|---|---|
| `api/shared/session_store.py` | （新規）設定の読み込み、スロットの確保・延長・解放、Cosmos DB へのアクセス |
| `api/session_api.py` | （新規）`/api/session/*` エンドポイントと、業務 API 用のガード（`@require_session`） |
| `api/function_app.py` | セッション API の登録、業務 API へのガードの追加 |
| `api/requirements.txt` | `azure-cosmos` を追加 |
| `api/local.settings.sample.json` | セッション制御の設定値を追加 |
| `api/tests/test_session_store.py` | （新規）単体テスト（Azure リソース不要） |
| `frontend/src/sessionClient.js` | （新規）取得・heartbeat・解放、タブ間の調整 |
| `frontend/src/apiClient.js` | セッションヘッダーの付与、410 受信時の取り直しと再試行 |
| `frontend/src/App.jsx` | ログイン後のセッション取得、上限到達画面、サインアウト時の解放 |
| `api/tests/test_session_api.py` | 検証専用ガード、fail-open / fail-closed、解放理由のテスト |
| `frontend/src/components/SessionIdleWarning.jsx` | iframe を覆う無操作警告、絶対時刻の残り時間、タイトル・全画面制御 |
| `frontend/src/components/SessionDebugPanel.jsx` | debug モードのセッション期限・イベント表示（追加の API 通信なし） |
| `frontend/src/pages/PowerBIPage.jsx` | SDK の操作イベントと終了時のイベント解除 |
| `frontend/src/styles.css` | 警告モーダルの全画面オーバーレイ |
| `frontend/staticwebapp.config.json` | ログアウト通知専用 URL の匿名アクセス |
| `frontend/tests/sessionClient.test.js` | 依存追加なしの時刻・タブ間共有・無操作ログアウトのテスト |

## 4. 設定値（Function App のアプリ設定）

| 名前 | 既定値 | 説明 |
|---|---|---|
| `SESSION_CONTROL_ENABLED` | `false` | `true` でセッション制御を有効にします。`false` の場合は既存の動作のままです |
| `SESSION_COMPANY_ID` | `default` | 会社 ID（パーティションキーの値）。英数字・`-`・`_` |
| `SESSION_MAX_COUNT` | `30` | 最大同時セッション数 |
| `SESSION_HEARTBEAT_MODE` | `activity` | `activity` / `interval`。不正値は警告ログを出し `activity` にします |
| `SESSION_RENEWAL_MARGIN_SECONDS` | `120` | サーバー有効期限の何秒前に更新を試みるか。30〜3600。警告時間 + 60 秒未満なら自動調整します |
| `SESSION_ACTIVITY_CHECK_SECONDS` | `600` | degraded／サーバー期限未取得時の再取得チェック（秒）。60〜3600。正常な activity の定期更新には使いません |
| `SESSION_IDLE_TIMEOUT_SECONDS` | `600` | 旧設定として保持（60〜86400）。現在の activity の無操作判定は TTL を使い、この値は使いません |
| `SESSION_WARNING_SECONDS` | `60` | 警告から自動ログアウトまで（秒）。10〜600 |
| `SESSION_HEARTBEAT_INTERVAL_SECONDS` | `300` | interval モードの heartbeat 間隔（秒）。15〜3600 |
| `SESSION_TTL_SECONDS` | `900` | セッションの有効期限（秒）。下記のモード別最小値を適用します |
| `SESSION_COUNT_MODE` | `browser` | `browser`：ブラウザー単位で数える / `user`：利用者単位で数える |
| `SESSION_RELEASE_ON_CLOSE` | `true` | 最後のタブを閉じたときに解放要求を送るかどうか |
| `SESSION_ENFORCE_ON_API` | `true` | 業務 API の呼び出し時に有効セッションを要求するかどうか |
| `SESSION_API_EXTEND` | `false` | `false`：ポイント読み取りで確認だけ（約 1 KB のスロットで約 1 RU、書き込みなし）。`true`：従来どおり延長し `X-Session-Extended: true` を返す |
| `SESSION_FAIL_OPEN` | `false` | `true`：ストア障害時に利用を継続。取得・延長は `enabled: true, degraded: true` と設定値・errorId を返し、スロットは返さない。上限を一時的に超える可能性があります |
| `COSMOS_ENDPOINT` | （必須） | Cosmos DB のエンドポイント |
| `COSMOS_DATABASE` | `sessiondb` | データベース名 |
| `COSMOS_CONTAINER` | `sessions` | コンテナー名（例：`sessions-company-a`） |
| `COSMOS_KEY` | （空） | ローカル開発でエミュレーターを使う場合のみ設定します。Azure 上ではマネージド ID を使用します |

### TTL の最小値

- `activity`：`SESSION_RENEWAL_MARGIN_SECONDS + 60` 秒。
  指定 TTL が小さい場合は警告ログを出してこの値に引き上げます。
  安全余裕はまず `SESSION_WARNING_SECONDS + 60` 秒以上に調整します。
  既定値の最小 TTL は 180 秒なので、既定 TTL の 900 秒はそのままです。
  更新・警告・ネットワーク再試行に必要な余裕を確保します。
- `interval`：従来どおり heartbeat 間隔の 2 倍未満なら 3 倍に自動調整します。

アプリ設定を変更すると関数アプリが再起動されます。ブラウザー側には、次の取得または延長レスポンスで
モード・各時間設定が反映されます（業務 API の検証だけではこれらの設定は取得しません）。
TTL の変更時は最終操作時刻 + 新しい TTL で無操作期限を再計算しますが、最終操作時刻自体はリセットしません。
最大数を減らした場合、範囲外のスロットを使っているセッションは次の heartbeat（または業務 API の呼び出し）で 410 となり、
空きがあれば取り直し、なければ上限画面になります。

## 5. Azure 側の準備

以下は Azure CLI の例です。`<...>` は環境に合わせて置き換えてください。

```bash
# 1) Cosmos DB アカウント（全社共通、東日本、単一リージョン書き込み）
#    サーバーレスで作成する例です。プロビジョニング済みスループットの場合は --capabilities を外します。
az cosmosdb create -n <cosmos-account> -g <rg> \
  --locations regionName=japaneast \
  --capabilities EnableServerless

# 2) データベース（全社共通）
az cosmosdb sql database create -a <cosmos-account> -g <rg> -n sessiondb
#    プロビジョニング済みでデータベース共有スループットにする場合は --throughput 400 を付けます

# 3) 会社ごとのコンテナー（パーティションキーは /companyId）
az cosmosdb sql container create -a <cosmos-account> -g <rg> -d sessiondb \
  -n sessions-company-a --partition-key-path /companyId

# 4) 各社の Function App のマネージド ID に、自社のコンテナーだけへのデータ アクセス権を付与
#    00000000-0000-0000-0000-000000000002 = Cosmos DB Built-in Data Contributor
az cosmosdb sql role assignment create -a <cosmos-account> -g <rg> \
  --role-definition-id 00000000-0000-0000-0000-000000000002 \
  --principal-id <function-app-managed-identity-principal-id> \
  --scope "/dbs/sessiondb/colls/sessions-company-a"
```

- コンテナーの作成はアプリからは行いません（データ アクセス用のロールでは作成できないため）。
- アクセスキーによる認証は無効化することを推奨します（アカウントの `disableLocalAuth` プロパティ）。
- Function App のアプリ設定に、上記 4. の値を設定します。
- セッション管理だけであれば、Function App のインスタンス メモリは 512 MB で十分な場合が多く、費用を抑えられます
  （メモリ サイズは関数アプリ単位の設定です）。

## 6. ローカルでの動作確認

1. `api/local.settings.sample.json` を `api/local.settings.json` にコピーし、`COSMOS_ENDPOINT` などを設定します。
   Cosmos DB を用意しない場合は、`SESSION_CONTROL_ENABLED` を `false` にすると既存の動作のまま起動します。
2. `az login` したユーザーに、上記 5. の 4) と同じロールを付与します（`DefaultAzureCredential` が Azure CLI の資格情報を使います）。
3. README の「Local Development」の手順で依存関係をインストールし、API、Vite、SWA CLI を起動します。
4. `http://localhost:4280` を開き、ヘッダーに「● Session active」が表示されることを確認します
   （マウスオーバーで、スロット番号、モード別の更新方式、TTL を表示します）。
5. 確認例
   - `SESSION_MAX_COUNT=1` にして、別のブラウザー（または InPrivate ウィンドウ）でログインすると、上限画面が表示される
   - 1 つ目のブラウザーのタブをすべて閉じてから、2 つ目のブラウザーで「Retry」を押すと利用できる
   - `GET /api/session/status` で、現在の設定値と利用中のセッション数を確認できる
   - ブラウザーの開発者ツールのネットワーク タブで、無操作中は heartbeat が送信されないことを確認できる
6. 単体テスト（Azure リソース不要）

   ```bash
   cd api
   python -m unittest discover -s tests -v
   ```

   フロントエンドのタイマー・タブ間制御のテストとビルド：

   ```powershell
   cd frontend
   node --experimental-vm-modules --test tests\sessionClient.test.js
   npm run build
   ```

### 短い時間での確認

Function App に以下を設定します。TTL は明示的に小さくしないと、既定の 900 秒が維持されます。

```text
SESSION_HEARTBEAT_MODE=activity
SESSION_RENEWAL_MARGIN_SECONDS=80
SESSION_WARNING_SECONDS=20
SESSION_TTL_SECONDS=180
SESSION_API_EXTEND=false
SESSION_FAIL_OPEN=false
```

この場合、サーバー更新予定は取得／延長から約 100 秒後、
無操作警告は最後の操作から 160 秒後、ログアウトは最後の操作から 180 秒後です。
`SESSION_TTL_SECONDS=60` のように小さく設定すると、最小値 `80 + 60 = 140` 秒に自動調整されます。

1. 同じブラウザーで 2 タブ開き、同じスロットになることを確認します。
2. 操作を継続し、サーバー有効期限の 80 秒前に延長がブラウザー全体で 1 回だけ送信されることを確認します。
3. 操作を止め、最終操作から約 160 秒で全タブに警告、さらに 20 秒で全タブがログアウトすることを確認します。
   解放 API の理由が `idle` で 1 回、通知ページの文言が表示されることを確認します。
4. 取得から 10 秒時点に一度だけ操作して止め、サーバー延長後も警告は 170 秒、ログアウトは 190 秒のままであることを確認します。
5. 警告表示中に操作して閉じること、スリープから無操作期限を過ぎて復帰すると操作による復活より先にログアウトすることを確認します。
6. Power BI で下記の操作を試し、開発ビルドの Console にイベント名・`visual.type` が出ることを確認します。
   初期ロードの `pageChanged` だけでは操作時刻が更新されないことも確認します。
7. 全画面で警告を待ち、全画面が解除されて警告が iframe の前に出ることを確認します。
8. `SESSION_HEARTBEAT_MODE=interval` に変え、次の取得／延長以降に固定間隔へ切り替わり警告が出ないことを確認します。
9. 検証用の Cosmos DB 接続不良で、`SESSION_FAIL_OPEN=false` は 503、
   `true` は degraded レスポンスと errorId 付き警告ログになることを確認します。
   degraded 中も業務 API を利用でき、次回チェックで再取得し、復旧後は通常の上限制御に戻ることを確認します。

### 操作として数えるもの

通常のページでは `pointerdown`、`keydown`、`wheel`、`touchstart` を capture / passive で検知します。
`mousemove` や `scroll` は検知対象にしません。タブの表示・フォーカス・復帰だけでも操作とは数えません。

Power BI の cross-origin iframe 内は親ページの入力イベントが届かないため、SDK イベントを使用します。

| Power BI の操作 | SDK イベント／制約 |
|---|---|
| スライサー変更 | `dataSelected`（実機テストで要確認。範囲・相対スライサーなどでは通知されない場合があります） |
| ページ変更 | `pageChanged`（最初の `loaded` / `rendered` より前は除外） |
| ビジュアルクリック | `visualClicked` / `dataSelected` |
| レポートのボタン | `buttonClicked` |
| 拡張コマンド | `commandTriggered` |
| レポート内スクロール | 検出できません。スクロールだけでは無操作扱いになります |

### UI のデバッグ表示

開発ビルドでは `Session debug` パネルを自動表示します。
本番ビルドでは通常は非表示ですが、ログイン後に URL に `?sessionDebug=1` を付けると表示します。
例：`/powerbi?sessionDebug=1`。上部ナビゲーションとサインイン後のリダイレクトでもフラグを保持します。
フラグを削除すると本番のパネルは非表示になります。認証・上限制御を無効にするフラグではありません。

- スロット名、モード・状態、サーバー有効期限、サーバー更新予定・次回再試行時刻、
  無操作警告・自動ログアウトの予定時刻と残り秒数を表示します。
- 最終操作時刻・延長時刻と無操作期限はブラウザー内の全タブで共有します。
  最近のイベント一覧はこのタブのみ、最大 20 件です。入力したキーや文字、トークン、資格情報は記録しません。
- イベント名、Power BI の `visual.type`、操作として採用されたか、
  警告／ログアウト時刻が何秒後ろに移動したかを確認できます。
  初期ロード中の `pageChanged` は `Ignored: initial-load` と表示し、期限を変更しません。
- 操作で後ろに移動するのはクライアントの無操作期限です。
  サーバーの有効期限は延長成功時だけ更新します。検証専用 API の呼び出しだけでは延長しません。
  `Server renewal due` はサーバー `expiresAt − 安全余裕`、
  `Auto logout at` は最後の操作 + TTL です。延長成功だけでは後者は動きません。
  `waiting for activity` の場合、更新予定時刻を過ぎても通信せずに操作を待ちます。
- パネルは 1 秒ごとにローカル情報を読み取るだけで、追加の API ポーリングや操作時刻更新は行いません。
  画面を眺めているだけでは期限は延長されません。時刻はブラウザーのローカルタイムゾーンで表示します。

確認例：パネルの `Idle warning at` を控えてから、ページのクリック／キー入力やレポートのスライサー変更を行います。
`Last event` が更新され、`Recent events` の該当行で `accepted` と期限の移動を確認してください。
スライサーが SDK イベントを通知しない場合は、その操作の行は出ません（ビジュアルの種類ごとに実機で確認してください）。

## 7. API 一覧

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/session/acquire` | `{ "browserId": "..." }`。成功時は 200（`slotId`、`expiresAt`、設定値）、満席時は 409 |
| POST | `/api/session/heartbeat` | `{ "browserId": "...", "slotId": "slot-0001" }`。成功時は 200、失効時は 410 |
| POST | `/api/session/release` | `{ "browserId": "...", "slotId": "slot-0001", "reason": "logout" }`。204。理由は `logout` / `idle` / `close` のみ。不正な理由・省略は `logout`。不正な `slotId` は 400、`slotId` 省略時は所有する枠を検索して解放します |
| GET | `/api/session/status` | 設定値と利用中のセッション数（デモ用です。本番では管理者に限定してください） |

業務 API（`/api/folders`、`/api/files`、`/api/upload`、`/api/download`、`/api/delete`、`/api/reports`、`/api/reports/embed`）は、
`X-Session-Browser` / `X-Session-Slot` ヘッダーでセッションを確認し、無効な場合は 410 を返します。
`/api/profile` はセッション取得前に呼び出すため、対象外です。

## 8. 費用調整の目安

activity モードの費用は主に `TTL − 安全余裕` と、実際に操作があるブラウザー数に依存します。
ローカルなタイマー確認だけでは Functions / Cosmos DB の通信費用は発生しません。
TTL を長くすると継続操作中の延長要求を減らせますが、無操作で退出するまでの時間も長くなります。
期限直前の操作・ネットワーク再試行では別途延長要求が発生します。
業務 API の検証では約 1 KB のスロットのポイント読み取りは約 1 RU で、延長書き込みはありません。
`SESSION_API_EXTEND=true` では業務 API の書き込み分が加わり、その延長後の定期 heartbeat は抑制されます。

以下は interval モードの比較例です。Functions の費用は実行回数・実行時間・メモリ サイズに依存します。

| heartbeat 間隔 | TTL の目安 | 実行回数（60 秒間隔との比較） | 異常終了時に枠が空くまで |
|---|---|---|---|
| 60 秒 | 3〜5 分 | 1 | 最大 3〜5 分 |
| 300 秒（interval の既定） | 15 分 | 1/5 | 最大 15 分 |
| 600 秒 | 30 分 | 1/10 | 最大 30 分 |

## 9. 注意事項

- タブを閉じたときの解放要求はベストエフォートです。届かなかった場合は TTL 経過後に解放されます。
- 1 つのタブで再読み込みすると、一度解放してから取り直します。満席の状態では、まれに取り直せないことがあります。
  気になる場合は `SESSION_RELEASE_ON_CLOSE=false` にすると、解放は TTL のみで行います。
- InPrivate ウィンドウや別のブラウザーは、別のセッションとして数えます（`SESSION_COUNT_MODE=browser` の場合）。
- Cosmos DB に接続できない場合、既定ではセッション API と業務 API は 503 を返します（上限を守ることを優先）。
  `SESSION_FAIL_OPEN=true` なら取得・延長と業務 API を継続し、毎回 errorId 付き警告ログを出します。
  入力不正・満席・失効は障害扱いにしません。degraded 中は次のチェックで再取得します。
  スロット未取得の業務 API は障害継続を確認して通すため、追加の状態確認が発生します。
  **fail-open では一時的に同時セッション上限を超える可能性があります。**
- ETag による排他制御は単一リージョン書き込みを前提としています。複数リージョン書き込みは使用しないでください。
- スロットの期限はサーバー時刻、操作・警告・ログアウトはブラウザーの絶対時刻です。端末の時計を正しく同期してください。
- 背景タブはタイマーが間引かれ、スリープ中は実行されません。表示・フォーカス・pageshow・storage で即座に再判定し、
  ログアウト時刻を過ぎていれば警告を経由せずログアウトします。停止中のタブは復帰するまで画面遷移できません。
- 警告は全タブに表示し、タイトルに「【まもなくログアウト】」を付けます。背景タブを自動的に前面化しません。
  全画面では Fullscreen API で解除を試みますが、ブラウザーに拒否された場合は解除できないことがあります。
  通知の許可要求は行いません。
- Web Locks 対応ブラウザーの同一オリジン内で、延長と自動解放を排他制御します。
  Web Locks 非対応時は localStorage のフラグによるベストエフォートで、同時要求の厳密な排除は保証できません。
  localStorage が使えない場合は警告ログを出してタブ単位で動作し、タブ間共有はできません。
