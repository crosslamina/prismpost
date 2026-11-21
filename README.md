<p align="center">
  <img src="./gmail-addon/prismpost-icon.png" alt="PrismPost" width="72" />
</p>

<h1 align="center">PrismPost</h1>

<p align="center">
  <strong>レンタルサーバー / VPS（PHP）＋ Gmail アドオン（Google Apps Script）だけで、<br>2027年1月の Gmail 外部 POP3 / SMTP 廃止後も複数の独自ドメインを送受信する</strong><br><br>
  <a href="./README.en.md">English README</a>
</p>

---

**PrismPost** は、個人 Gmail の **迷惑メールフィルタ** と **Gemini AI** を 100% 活用したまま、複数の独自ドメインメールを追加費用 0 円で送受信するための軽量メール連携システムです。

Cloudflare への DNS 移管や、外部の有料・制限付きメール配信サービス（Resend / SendGrid / Brevo 等）は一切使用しません。

---

## 🌐 対応サーバー環境（汎用性について）

本プロジェクトの PHP リレー（[`prismpost-relay.php`](./gmail-addon/prismpost-relay.php)）は特定のレンタルサーバー専用 API を一切使わず、標準の PHP（`openssl_verify` ＋ `/usr/sbin/sendmail` または `mail()` フォールバック）のみで動作します。

* **動作確認済み**: さくらのレンタルサーバ
* **利用可能な環境**: **エックスサーバー / ConoHa WING / ロリポップ / MixHost / 各種 VPS・cPanel 等、PHP 7.1+ が動作する一般的な Web・メールサーバー全般**

### 利用条件（ご契約サーバーで確認すべき 2 点）
1. **受信側**: サーバーのメール自動転送が **SRS（Sender Rewriting Scheme）/ ARC** に対応していること（個人 Gmail へ自動転送しても SPF/DMARC エラーにならず迷惑メールフィルタが正常動作します）。
2. **送信側**: サーバーの PHP（`sendmail` または `mail()`）から送信したメールに対し、対象ドメインの **SPF / DKIM** 認証が通ること（SSL/HTTPS 公開ディレクトリに `prismpost-relay.php` を配置できること）。

---

## 📂 ファイル構成

```text
prismpost/
├── gmail-addon/
│   ├── appsscript.json      # Google Apps Script マニフェスト（必要最低限の 7 スコープ）
│   ├── Code.gs              # Gmail アドオン本体スクリプト
│   ├── prismpost-relay.php  # レンタルサーバー / VPS 設置用・送信中継 PHP（1ファイル完結）
│   └── prismpost-icon.png   # アドオン用アイコン（256x256 透過PNG）
├── LICENSE                  # MIT License
├── README.md                # 日本語ドキュメント（本ファイル）
└── README.en.md             # English Documentation
```

---

## 🌟 主な機能と仕組み

```text
[受信] 外部送信者 ──▶ あなたのレンタルサーバー (自動転送: SRS/ARC) ──▶ 個人Gmail (迷惑メール対策 & Gemini)

[送信] 個人Gmailの下書き ──(アドオン 🚀 送信)──▶ prismpost-relay.php (HTTPS + Google OIDC検証) ──▶ sendmail ──▶ 相手先
                                                                                                   └─▶ Gmailスレッドへ SENT + PrismPostラベル保存
```

1. **受信（サーバー標準の自動転送）**:
   * お使いのサーバーの管理画面で、独自ドメイン宛メールを個人 Gmail へ自動転送する設定にするだけで完了です。
2. **返信・新規作成（差出人自動判別・自動署名・個人 Gmail 痕跡ゼロ）**:
   * 開いているメールのヘッダー（`X-Original-To` / `X-Forwarded-To` / `Delivered-To` / `To` / `Cc`）から受信ドメインを自動判別し、対応する差出人をプルダウンで自動選択します。
   * 送信時、`From` だけでなく `Message-ID` の `@mail.gmail.com` も独自ドメインに置換し、**登録した差出人別の署名** を引用文（`>` / `gmail_quote`）の直前へ自動挿入します（プレーンテキスト / HTML 両対応・2往復目以降も重複誤判定なし）。
   * Gmail 内部テンプレート（定型文）が下書き一覧へ誤表示されないフィルタリングと、送信済みコピーへの **`PrismPost` ラベル自動付与**、大容量添付（Upload API 最大 35MB）に対応しています。
   * Chrome 拡張機能ではなく Gmail アドオン（`CardService`）のため、**iPhone / Android の公式 Gmail アプリからもそのまま使えます**。
3. **秘密トークン不要・Google OIDC 電子署名認証**:
   * PHP ファイルへパスワードやトークンを直接書き込む必要はありません。
   * Google Apps Script が発行する **Google 公式 OIDC ID トークン（RS256 公開鍵暗号署名）** を PHP 側で検証し、初回設定保存時に Web 非公開領域（`~/.prismpost-owner-<PHPファイル名>.json`、パーミッション `0600`）へあなたの Google アカウント（`sub` / `email` / `aud` / 許可ドメイン一覧）を自動ロックします。
   * 送信時は本文全体＋タイムスタンプ（±300秒以内）に対する **HMAC-SHA256 署名** も検証し、リプレイ攻撃や改ざんを防ぎます。PHP からの `sendmail` 実行もシェル（`/bin/sh`）を介さない `proc_open` 配列渡しを採用しています。

---

## 🚀 導入手順（約5分）

### ステップ1：レンタルサーバー側の準備
1. **メール転送設定（受信用）**:
   * お使いのサーバーの管理画面で、各独自ドメインのメールアドレスから個人 Gmail へ自動転送する設定にします（※旧来の Gmail「他のアカウントのメールを確認（POP3）」設定が有効な場合は二重受信防止のためオフにします）。
2. **送信認証（SPF / DKIM）の確認**:
   * 各独自ドメインで、ご利用サーバーからのメール送信に対する SPF / DKIM 設定が有効になっていることを確認します。
3. **中継用 PHP のアップロード（送信用）**:
   * [`gmail-addon/prismpost-relay.php`](./gmail-addon/prismpost-relay.php) は **1文字も編集せずそのまま** HTTPS が使える任意の公開ディレクトリへアップロードします（1箇所に置くだけで、同じサーバーに収容されている**全独自ドメイン**の送信に使えます）。
     * 例: `https://yourdomain.com/prismpost/prismpost-relay.php`
   * *(任意)* コード上でも送信元 Google アカウントやドメインをハードコード固定したい場合のみ、25〜26行目の `$ALLOWED_GMAIL_ADDRESS` / `$ALLOWED_FROM_DOMAINS` を記入してください（空欄のままでもステップ3で自動ロック・自動同期されます）。
4. **大容量添付ファイル用の設定（任意）**:
   * 5MB以上の大きな添付ファイルを送信する場合、サーバーの初期設定（`php.ini` の `post_max_size = 8M` 等）に引っかかることがあります。必要に応じてサーバー管理画面の `php.ini` で `post_max_size = 40M` / `memory_limit = 128M` 程度に引き上げてください。

### ステップ2：Google Apps Script にアドオンを設置
1. [Google Apps Script (script.google.com)](https://script.google.com/) を開き、**「新しいプロジェクト」** を作成します。
2. 左メニューの **「プロジェクトの設定（歯車アイコン）」** を開き、**「「appsscript.json」マニフェスト ファイルをエディタで表示する」** にチェックを入れます。
3. 左メニューの **「エディタ（`<>`アイコン）」** に戻り：
   * `appsscript.json` に [`gmail-addon/appsscript.json`](./gmail-addon/appsscript.json) の内容を貼り付けます。
   * `コード.gs`（または `Code.gs`）に [`gmail-addon/Code.gs`](./gmail-addon/Code.gs) の内容を貼り付けて保存（`Ctrl + S`）します。
   * *(任意)* アイコン画像を自前サーバーから配信したい場合は、`appsscript.json` の `logoUrl` と `Code.gs` の `PRISM_ICON_URL` をご自身の環境に合わせて書き換えてください（初期値は本リポジトリの [`prismpost-icon.png`](./gmail-addon/prismpost-icon.png) を参照します）。
4. 右上の **「デプロイ」＞「デプロイをテスト」** をクリックし、「アプリケーション(Gmail)」の **「インストール」** を押して完了です。

### ステップ3：Gmail 画面で初期設定（自動ペアリング）
1. Gmail を開き（またはリロードし）、右端のサイドパネルに表示される **PrismPost アイコン** をクリックし、アクセス権限を承認します。
2. 上部メニュー（`⋮`）または初回表示の **「⚙️ 設定」** 画面に以下を入力して **「💾 保存」** を押します：
   * **PHP URL**: `https://yourdomain.com/prismpost/prismpost-relay.php`
   * **差出人一覧（1行に1件・複数ドメイン可）**:
     ```text
     info@domain-a.com | 株式会社A サポート
     taro@domain-b.jp | 山田 太郎
     contact@domain-c.net
     ```
3. Google OIDC 電子署名によってサーバーと自動ペアリングされ、Web 非公開領域（`~/.prismpost-owner-<PHPファイル名>.json`）にあなたのアカウントと許可ドメイン一覧がロックされます。
4. **署名の登録（任意）**:
   差出人を保存したあと再度 **「⚙️ 設定」** を開くと、登録したアドレスごとの **「✍️ 署名」** 入力欄が自動で表示されます（通常のテキストを入力して保存すれば、送信時に本文末尾・引用文直前へ自動挿入されます）。
   * *(補足)* Apps Script プロジェクトを作り直したり別の Google アカウントへ切り替えたりしたい場合は、サーバー上の `~/.prismpost-owner-<PHPファイル名>.json` を削除してから再度「💾 保存」を押してください。

---

## 👨‍👩‍👧‍👦 家族・チーム（別 Google アカウント）で併用する場合

1. **サーバー側**:
   * 同じ [`prismpost-relay.php`](./gmail-addon/prismpost-relay.php) を、**別のファイル名**（例：`prismpost-family.php`）でもう 1 つ公開ディレクトリへアップロードします（ファイルは無編集で OK）。
   * ロックファイルは PHP ファイル名ごとに別名（`~/.prismpost-owner-prismpost-family.json`）で自動生成されるため、アカウントや許可ドメインは完全に分離されます。
2. **Apps Script アドオン側**:
   * Google Apps Script 画面右上の「共有」から、家族・メンバーの Google アカウントを **編集者** として追加します。
   * 相手のブラウザでプロジェクトを開き、「デプロイ」＞「デプロイをテスト」＞「インストール」を実行します。
   * 相手の Gmail からアドオン設定を開き、2つ目の PHP URL（`https://yourdomain.com/prismpost/prismpost-family.php`）と相手用の差出人一覧を保存すれば完了です（`UserProperties` は Google アカウントごとに独立しています）。

---

## 💡 普段の使い方

* **PC ブラウザ**: 届いたメールを開き、返信（または新規作成）の下書きを作成したら、右サイドパネルの PrismPost から **「🔄 再読み込み / 更新」 → 「🚀 送信」** を押します（※Gmail 下部の青い通常送信ボタンは押さないでください）。
* **スマホ Gmail アプリ**: 下書きを書いたあと作成画面を左上の `×` 等で閉じると下書き保存されます。開いているスレッドの最下部にある「利用可能なアドオン」＞ PrismPost から送信できます（新規下書きを送る場合は最下部の **「📝 下書き一覧」** ボタンから一覧へ切り替え可能です）。

---

## 📜 設計の経緯（ここに至るまでの紆余曲折）

本プロジェクトは「個人 Gmail の外部 POP3 受信・外部 SMTP 送信（名前を付けて送信）が 2027 年 1 月に廃止された後も、**Gmail の強力な迷惑メールフィルタ** と **Gemini AI** を使いながら複数の独自ドメインで送受信したい」という目的からスタートし、以下の 4 段階の検証を経て現在の最小構成に辿り着きました。

### 第1段階：Cloudflare Worker によるプロキシアドレス暗号化方式（却下）
* **仕組み**: Cloudflare Email Routing Worker で受信時に `Reply-To` を暗号化プロキシアドレス（`reply+{token}@domain`）へ書き換え、Gmail標準の「送信」ボタンで返信されたメールを Worker で復号して Resend API で再送する方式。
* **判明した問題点**:
  * メールアドレスのローカル部（`@`より前）には **RFC 5321 の 64文字制限** があり、AES-GCM 暗号化トークンを入れると制限を超過して送信エラーになる。
  * トークンをなくして可読アドレス変換（`sender+user=domain@my-domain`）にしても、**「全員に返信（CC）」** を行うと複数のプロキシアドレス宛に同時にメールが飛び、相手へ同じ返信が何通も重複送信されてしまう。
  * バウンスメール対策、引用文中のプロキシアドレス漏洩対策など、メール仕様（RFC）とのいたちごっこが発生した。

### 第2段階：DB（KV / D1）方式・カスタムヘッダー方式（却下）
* **仕組み**: 64文字制限や CC 問題を回避するため、Cloudflare D1 / KV にスレッド情報を保存する案や、`X-PrismPost-*` といった独自ヘッダーを DB 代わりに使う案を検討。
* **判明した問題点**:
  * メールクライアント（Gmail）の仕様上、**受信メールに付与した独自ヘッダー（`X-*`）は、返信メールには引き継がれない**（引き継がれるのは `In-Reply-To` と `References` のみ）。
  * また、Cloudflare Email Routing の `message.forward()` は標準ヘッダーの書き換えを制限しており、そもそも複数の独自ドメインのネームサーバー（DNS）をすべて Cloudflare に移管しなければならないという運用上の大きなハードルがあった。

### 第3段階：Gmail アドオン（Google Apps Script）への発想転換
* **転換点**: 「Gmailの青い送信ボタンを押すために返信先アドレスを偽装する」のではなく、**「Gmailで下書き（Gemini AI可）を作り、右サイドバーのアドオンのボタンから外部送信する」** という方式へ転換。
* **解決したこと**:
  * 下書きの `To` / `Cc` / `Bcc` / `添付ファイル` をそのまま取得して直接送れるため、**64文字制限・CC重複問題・DB管理・プロキシアドレス変換がすべて不要**になった。
  * 送信後に Gmail API（`Users.Messages.insert`）でスレッドに `SENT`（送信済み）として控えを戻すことで、次回以降も Gemini AI が自分の返信内容を含めてスレッドの文脈を把握できるようになった。

### 第4段階：レンタルサーバー（PHP）完結型へ（最終形）
* **決定打**: すでに独自ドメインを運用しているレンタルサーバー（検証環境：さくらのレンタルサーバ）の機能をそのまま活かす構成へ着地。
  * **受信**: サーバーのメール自動転送は **SRS / ARC に対応** しているため、Cloudflare を介さず直接個人 Gmail へ自動転送しても SPF/DMARC エラーにならず、Gmail の迷惑メールフィルタが 100% 機能する。
  * **送信**: Google Apps Script は仕様上 SMTP（ポート587/465）に直接接続できないが、レンタルサーバー上に 1 ファイルの中継スクリプト（[`prismpost-relay.php`](./gmail-addon/prismpost-relay.php)）を置くことで、HTTPS 経由でサーバー自身のメール機能（`sendmail` / `mail()`）から直接送信できる。
* **結果**: Cloudflare への DNS 移管も、Resend / Brevo 等の外部配信サービス（無料枠のドメイン数制限や通数制限）も一切不要となり、**追加費用ゼロ・外部依存ゼロ・実質2ファイルのみ** の現在の構成が完成した。

---

## 🛡️ 将来もし「Gmail アドオン」が廃止・仕様変更されたら？（BCP / 脱出ルート）

万が一、将来 Google が Google Workspace Add-ons（右サイドバーのカード UI）の仕様を変更したり、個人 Gmail アカウントでのテストデプロイを制限したりした場合でも、**「受信（自動転送）」と「送信エンジン（[`prismpost-relay.php`](./gmail-addon/prismpost-relay.php)）」の主権がすべて自分自身のサーバー側にあるため、詰むことはありません。**

いざという時は、`prismpost-relay.php` をそのまま活かして以下のいずれかの方法へ 10 分程度で移行できます。

1. **Apps Script の「スター（⭐）/ ラベル自動送信」方式（アドオン UI 不要）**:
   右サイドバーのアドオン画面（`CardService`）を使わず、Google Apps Script の時間主導型トリガー（1分おき等）で特定のスター／送信待ちラベルが付いた下書きだけを自動検知して `prismpost-relay.php` へ送信します。
2. **PC ブラウザの Chrome 拡張機能 / ブックマークレット方式**:
   Google Apps Script 自体に制限がかかった場合でも、手元の Chrome ブラウザ拡張機能から Gmail 画面の下書きを取得して直接 `prismpost-relay.php` を叩いて送信できます。
3. **レンタルサーバーの Web メール / 標準メールソフトへの即時フォールバック**:
   ドメインの DNS もメールボックスもすべてサーバー側にそのまま残っているため、Google 側で障害や急な仕様変更が起きた当日であっても、設定変更ゼロで Web メールや Thunderbird / 標準メールアプリから即座に送受信を継続できます。

---

## 📄 ライセンス・免責事項

* 本ソフトウェアは [MIT License](./LICENSE) のもとで公開されています。
* 本ソフトウェアは「現状のまま（AS-IS）」無保証で提供されます。ご利用のレンタルサーバー環境における SPF / DKIM / 転送挙動・迷惑メール判定・大量送信制限等については、ご自身の環境にて十分テストのうえ**自己責任**にてご利用ください。個別環境向けのセットアップサポートは行っておりません。
