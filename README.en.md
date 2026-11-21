<p align="center">
  <img src="./gmail-addon/prismpost-icon.png" alt="PrismPost" width="72" />
</p>

<h1 align="center">PrismPost</h1>

<p align="center">
  <strong>Keep sending and receiving emails with your custom domains in personal Gmail after the Jan 2027 POP3 / "Send mail as" deprecation — using only your own PHP hosting server + a lightweight Gmail Add-on.</strong><br><br>
  <a href="./README.md">日本語版 README</a>
</p>

---

**PrismPost** lets you keep personal Gmail's spam filtering, fast search, mobile app, and Gemini AI while handling multiple custom domain email addresses at **\$0 additional monthly cost** — without migrating DNS to Cloudflare or relying on third-party transactional email APIs (Resend, SendGrid, Brevo, etc.).

---

## 🌐 Hosting Compatibility

[`prismpost-relay.php`](./gmail-addon/prismpost-relay.php) uses only standard PHP (`openssl_verify` and `/usr/sbin/sendmail` via `proc_open`, with automatic fallback to PHP `mail()`) — **no hosting-provider-specific APIs**.

* **Tested on**: Sakura Rental Server (Japan)
* **Works on**: Most PHP 7.1+ shared hosting / cPanel / VPS environments (Xserver, ConoHa WING, Lolipop, standard Linux/FreeBSD VPS, etc.) provided that:
  1. **Inbound forwarding** from your mail host to personal Gmail supports **SRS / ARC** (preserving authentication so Gmail's spam filter stays fully effective).
  2. **Outbound PHP mail** (`sendmail` / `mail()`) on your host passes your domains' **SPF and DKIM** checks, and the relay PHP script can be hosted under **HTTPS**.

---

## 📂 Repository Structure

```text
prismpost/
├── gmail-addon/
│   ├── appsscript.json      # Google Apps Script manifest (minimal 7 OAuth scopes)
│   ├── Code.gs              # Gmail Add-on implementation
│   ├── prismpost-relay.php  # Single-file PHP relay for your HTTPS host (zero edits required)
│   └── prismpost-icon.png   # Add-on icon (256x256 transparent PNG)
├── LICENSE                  # MIT License
├── README.md                # Japanese documentation
└── README.en.md             # English documentation (this file)
```

---

## ✨ Key Features & Architecture

```text
[Inbound]  Sender ──▶ Your Mail Host (auto-forward with SRS/ARC) ──▶ Personal Gmail (spam filter + Gemini AI)

[Outbound] Gmail Draft ──(PrismPost Add-on 🚀 Send)──▶ prismpost-relay.php (HTTPS + Google OIDC) ──▶ sendmail ──▶ Recipient
                                                                                                      └─▶ Inserts SENT copy (+ PrismPost label) into Gmail thread & deletes draft
```

* **Zero Secret Tokens in PHP Code (Google OIDC Auth)**:
  Instead of embedding a hardcoded password/secret token in PHP, the Add-on attaches a Google-signed OpenID Connect ID token (`ScriptApp.getIdentityToken()`). The PHP relay verifies the `RS256` signature against Google's official certificates (`https://www.googleapis.com/oauth2/v1/certs`) and auto-locks on first setup to your Google account (`sub`, `email`, `aud`, and allowed sender domains) inside a non-public lock file (`~/.prismpost-owner-<script-name>.json`, `0600`).
* **Replay & Command-Injection Protection**:
  Every send request requires a ±300s timestamp and HMAC-SHA256 signature over the request body, strict email regex checks, domain allowlist enforcement, and shell-free `proc_open` argument array execution.
* **No Proxy Addresses, 64-Char Limits, or CC Duplication**:
  Compose replies, Reply-All (`Cc`/`Bcc`), new messages, and attachments normally in Gmail, then hit **🚀 送信 (Send)** in the Add-on panel.
* **Privacy & Context Preservation**:
  Rewrites `From` and Gmail's `@mail.gmail.com` suffix on `Message-ID` to your custom domain, inserts a `SENT` copy back into the Gmail thread (via Upload API for attachments up to 35MB) with a `PrismPost` label, and deletes the draft.
* **Per-Sender Signatures & Template Filtering**:
  Configure independent plain/HTML signatures per sender address (automatically placed above reply quotes on every turn without duplicating quoted signatures), and automatically excludes Gmail Templates/Canned Responses from the draft list.
* **Mobile & Multi-User Ready**:
  Works in both Gmail Web and the official Gmail mobile app (iOS / Android). Families or teams can share one Apps Script project and upload separate copies of `prismpost-relay.php` under different filenames (`~/.prismpost-owner-<filename>.json` isolates each user).

---

## 🚀 Quick Setup

### 1. Prepare Your Hosting Server
1. Enable **auto-forwarding** from your custom domain mailboxes to your personal Gmail account (and turn off legacy Gmail POP3 fetching to avoid duplicates).
2. Verify **SPF & DKIM** are enabled for your custom domains on your hosting server.
3. Upload [`gmail-addon/prismpost-relay.php`](./gmail-addon/prismpost-relay.php) to any **HTTPS** directory on your server **without modifying the file** (e.g., `https://yourdomain.com/prismpost/prismpost-relay.php`). One script handles all domains hosted on that server.
   * *(Optional)* For >5MB attachments, ensure PHP `post_max_size` / `memory_limit` in your server's `php.ini` match your target size (e.g., `40M` / `128M`).

### 2. Deploy the Gmail Add-on (Google Apps Script)
1. Create a new project at [script.google.com](https://script.google.com/).
2. Open **Project Settings** and enable **"Show 'appsscript.json' manifest file in editor"**.
3. Copy [`gmail-addon/appsscript.json`](./gmail-addon/appsscript.json) into `appsscript.json` and [`gmail-addon/Code.gs`](./gmail-addon/Code.gs) into `Code.gs`, then save.
4. Click **Deploy > Test deployments > Install** under **Gmail**.

### 3. Pair & Configure in Gmail
1. Open or reload Gmail, open the **PrismPost** icon in the right panel, and approve permissions.
2. Open **⚙️ 設定 (Settings)**, enter your **PHP URL** (`https://yourdomain.com/prismpost/prismpost-relay.php`) and **Sender Profiles** (`info@domain-a.com | Display Name`, one per line), then click **💾 保存 (Save)**.
   * This automatically pairs and locks `prismpost-relay.php` to your Google account and registered domains.
   * *(Optional)* Reopen **⚙️ 設定** to enter per-sender signatures.

---

## 🛡️ Escape Routes (If Gmail Add-ons Ever Change)

Because your domains, DNS, inbound forwarding, and outbound relay (`prismpost-relay.php`) all stay under your own control on your hosting server, you are never locked in:
1. Switch to a time-driven Apps Script trigger that sends drafts tagged with a star/label (zero CardService UI dependency).
2. Trigger `prismpost-relay.php` from a simple Chrome extension.
3. Fall back immediately to your hosting server's webmail or Thunderbird/IMAP at any time with zero migration effort.

---

## 📄 License & Disclaimer

Released under the [MIT License](./LICENSE). Provided **AS-IS** without warranty of any kind; verify SPF/DKIM/forwarding behavior and hosting mail rate limits in your own environment before production use.
