# PrismPost (GhostMail)

Cloudflare Workers (Email Routing API) 上で動作する、個人Gmailと独自ドメインを安全かつ透過的に中継するステートレス・メールプロキシです。

Gmail における外部 POP3/SMTP 紐づけ機能の廃止に伴い、**個人 Gmail の UI や Gemini 返信・検索機能、スマート作成を活用したまま、独自ドメイン経由で透過的に送受信を行う** ことができます。

---

## 🌟 特徴

1. **受信の透過性 (Inbound Relay)**:
   - 独自ドメイン宛に届いたメールを受信し、`Reply-To` ヘッダーを暗号化トークン付きのプロキシアドレス（`reply+{token}@{targetDomain}`）に書き換えて個人 Gmail へ転送。
   - Gmail の返信ボタンを押すだけで、自動的にプロキシアドレス宛の返信が作成されます。
2. **返信の自動再送 (Outbound Re-send)**:
   - 個人 Gmail からプロキシアドレス宛に返信されたメールを受信。
   - 暗号化トークンを復号して本来の相手先アドレスを特定し、Resend API 経由で独自ドメイン名義（`info@{targetDomain}` 等）で相手へ正規送信。
3. **厳格なセキュリティ検証**:
   - `received-spf` および `authentication-results` ヘッダーを検査し、Gmail 正当サーバー以外からの偽装送信を即時遮断・破棄。
   - Web Crypto API (AES-256-GCM) によるトークンの暗号化・改ざん検知・有効期限（デフォルト30日）管理。
4. **スレッド整合性の維持 & 添付ファイル対応**:
   - `In-Reply-To` および `References` ヘッダーを引き継ぎ、メールクライアントのスレッド表示が途切れません。
   - 添付ファイルを自動で Base64 にエンコードして Resend API 経由で相手へ転送。
5. **完全ステートレス & 複数ドメイン対応**:
   - データベース（KV/D1等）不要。トークン自体に必要な情報が暗号化されて内包されているため、単一の Worker で無制限の複数独自ドメインを処理可能。

---

## 📂 プロジェクト構成

```
prismpost/
├── src/
│   ├── index.ts        # Worker メインエントリポイント (Email Routing ハンドラ)
│   ├── crypto.ts       # Web Crypto API による AES-256-GCM トークン生成・復号
│   ├── security.ts     # SPF / DKIM 認証ヘッダーおよび送信元 Gmail アドレス検証
│   ├── resend.ts       # Resend API (HTTP REST) 送信クライアント
│   └── types.ts        # 環境変数および内部データ型定義
├── test/
│   ├── crypto.test.ts   # 暗号化・復号・改ざん・有効期限切れのユニットテスト
│   ├── security.test.ts # メールアドレス正規化・SPF/DKIM 検証のユニットテスト
│   └── relay.test.ts    # 受信転送・返信再送・添付ファイル・複数ドメインの統合テスト
├── wrangler.toml       # Cloudflare Workers 設定
├── package.json        # 依存関係およびスクリプト
├── tsconfig.json       # TypeScript 設定
└── .env.example        # 環境変数サンプル
```

---

## ⚙️ 環境変数・シークレット一覧

| 変数名 | 必須 | 区分 | 説明 |
|---|---|---|---|
| `ALLOWED_GMAIL_ADDRESS` | ○ | Secret / Var | 許可する個人 Gmail アドレス (例: `your-account@gmail.com`) |
| `SECRET_KEY` | ○ | Secret | AES-256-GCM 暗号化用の 32 バイト以上のシークレットキー |
| `RESEND_API_KEY` | ○ | Secret | Resend の API キー (`re_...`) |
| `DEFAULT_SENDER_NAME` | 任意 | Var | 送信者表示名 (デフォルト: `PrismPost`) |
| `TOKEN_EXPIRATION_DAYS` | 任意 | Var | トークンの有効期限日数 (デフォルト: `30`) |

---

## 🚀 デプロイと設定手順

### 1. 依存パッケージのインストール
```bash
npm install
```

### 2. シークレットの設定 (Cloudflare Workers)
Wrangler CLI を用いて、機密情報を Cloudflare Workers に登録します。

```bash
# 暗号化シークレットキー (ランダムな文字列)
npx wrangler secret put SECRET_KEY

# Resend API キー
npx wrangler secret put RESEND_API_KEY

# 許可する個人Gmailアドレス
npx wrangler secret put ALLOWED_GMAIL_ADDRESS
```

### 3. Worker のデプロイ
```bash
npm run deploy
```

### 4. Cloudflare Email Routing のルーティング設定
Cloudflare ダッシュボード上で独自ドメインの Email Routing を設定します。

1. **ドメイン設定**: Cloudflare ダッシュボードで対象ドメインの **Email Routing (メールルーティング)** を有効化（MX / SPF レコードが自動設定されます）。
2. **ルーティングルールの作成**:
   - **カスタムアドレス / Catch-all**:
     - 送信先（Action）: **Worker へ送信 (Send to a Worker)**
     - 選択する Worker: `prismpost`

※ 複数ドメインで運用する場合は、各ドメインの Email Routing で同じ `prismpost` Worker を指定するだけで自動的にマルチドメイン対応として動作します。

### 5. Resend のドメイン認証
[Resend](https://resend.com) のダッシュボードで送信元となる独自ドメイン（`yourdomain.com` 等）を登録し、指示に従って DNS レコード (DKIM / SPF) を追加してドメインを認証 (`Verified`) してください。

---

## 🧪 テストの実行

Vitest を用いた包括的な単体・統合テストスイートが同梱されています。

```bash
# 全テストの実行
npm test

# 型チェック
npm run typecheck
```

---

## 🔒 セキュリティモデル

- **アドレス偽装対策**: `message.from` が `ALLOWED_GMAIL_ADDRESS` の場合のみ返信フローを実行し、かつ `received-spf` や `authentication-results` で SPF/DKIM が Pass していることを厳格に検証します。
- **リプレイ / 改ざん攻撃対策**: AES-256-GCM の認証付き暗号 (AEAD) を採用しており、トークンが1ビットでも改ざんされていた場合は復号時に即時拒絶されます。
- **有効期限**: トークン内に生成タイムスタンプが埋め込まれており、設定日数（デフォルト30日）を経過したトークンは無効化されます。
- **エラー通知**: 万が一無効なトークンや期限切れのトークンで返信された場合、個人 Gmail 宛てにエラー通知メールが送られ、メッセージは Cloudflare 上で安全に破棄されます。
