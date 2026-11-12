/**
 * PrismPost Gmail Add-on (Google Apps Script)
 * さくらのレンタルサーバ（PHP中継）＋ 複数独自ドメイン専用版
 *
 * 機能:
 * 1. さくらインターネットから転送されたメールのヘッダー（X-Original-To / Delivered-To / To / Cc 等）を解析し、
 *    登録済みの複数独自ドメインから最適な「差出人アドレス・表示名」を自動選択
 * 2. Gmail上で（Gemini AI等を使って）作成した「返信・全員に返信・新規下書き（To/Cc/Bcc/本文/HTML/添付ファイル）」を取得
 * 3. 個人Gmailの痕跡（From や Message-ID の @mail.gmail.com）を独自ドメインに書き換え、
 *    HMAC-SHA256 署名付き HTTPS 通信でさくらのレンタルサーバ上の PHP 経由で直接送信
 * 4. 送信したメールを Gmail のスレッドに「送信済み (SENT)」として自動追加（次回以降も Gemini AI が文脈を認識可能）
 */

/**
 * ユーザー設定の取得
 */
function getSettings_() {
  var props = PropertiesService.getUserProperties();
  return {
    sakuraEndpointUrl: props.getProperty('SAKURA_ENDPOINT_URL') || '',
    secretToken: props.getProperty('SECRET_TOKEN') || props.getProperty('API_KEY') || '',
    senderProfilesRaw: props.getProperty('SENDER_PROFILES') || ''
  };
}

/**
 * 設定が初期化済みか判定
 */
function hasValidSettings_(settings) {
  return Boolean(settings.sakuraEndpointUrl && settings.secretToken && settings.senderProfilesRaw);
}

/**
 * 登録された差出人プロファイル一覧をパースする
 * 形式（1行に1件）:
 *   info@domain-a.com | 株式会社A サポート
 *   山田 太郎 <taro@domain-b.jp>
 *   support@domain-c.org
 */
function parseSenderProfiles_(settings) {
  var profiles = [];
  var raw = settings.senderProfilesRaw || '';
  var lines = raw.split(/\r?\n/);

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    var email = '';
    var name = '';

    if (line.indexOf('|') !== -1) {
      var parts = line.split('|');
      email = extractPureEmail_(parts[0]);
      name = parts.slice(1).join('|').trim();
    } else {
      var match = line.match(/^([^<]+)<([^>]+)>$/);
      if (match) {
        name = match[1].trim();
        email = match[2].trim();
      } else {
        email = extractPureEmail_(line);
      }
    }

    if (email && email.indexOf('@') !== -1) {
      profiles.push({
        email: email,
        name: name,
        domain: email.split('@')[1].toLowerCase()
      });
    }
  }

  return profiles;
}

/**
 * 1. メールを開いたときのトリガー (Contextual Trigger)
 */
function onGmailMessageOpen(e) {
  var settings = getSettings_();
  if (!hasValidSettings_(settings)) {
    return buildSettingsCard_('最初に「さくらのPHP URL」「秘密トークン」「差出人アドレス一覧」を設定してください。');
  }

  var messageId = e.gmail.messageId;
  var accessToken = e.gmail.accessToken;
  GmailApp.setCurrentMessageAccessToken(accessToken);

  var message = GmailApp.getMessageById(messageId);
  var thread = message.getThread();

  // 元のメールがどの独自ドメインアドレス宛に届いたかを自動推定
  var detectedProfile = detectReceivingProfile_(message, settings);

  // このスレッド内に作成されている下書き（返信・全員に返信）を探す
  var draft = findDraftInThread_(thread.getId());

  return buildThreadReplyCard_({
    messageId: messageId,
    threadId: thread.getId(),
    detectedEmail: detectedProfile.email,
    detectedName: detectedProfile.name,
    settings: settings,
    draft: draft
  });
}

/**
 * 2. ホーム画面（メール未選択時・新規作成メール送信時）のトリガー
 */
function onHomepage(e) {
  var settings = getSettings_();
  if (!hasValidSettings_(settings)) {
    return buildSettingsCard_('最初に「さくらのPHP URL」「秘密トークン」「差出人アドレス一覧」を設定してください。');
  }
  return buildComposeDraftListCard_(settings);
}

/**
 * 3. 作成画面（Compose Trigger）から呼び出されたときのトリガー
 */
function onGmailCompose(e) {
  var settings = getSettings_();
  if (!hasValidSettings_(settings)) {
    return buildSettingsCard_('最初に「さくらのPHP URL」「秘密トークン」「差出人アドレス一覧」を設定してください。');
  }
  return buildComposeDraftListCard_(settings);
}

/**
 * 差出人選択ウィジェット群をセクションに追加する共通関数
 */
function addSenderSelectionWidgets_(section, settings, selectedEmail, selectedName) {
  var profiles = parseSenderProfiles_(settings);

  if (profiles.length > 0) {
    var dropdown = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('selected_profile')
      .setTitle('差出人アカウント（自動検出・切替可）');

    var matched = false;
    for (var i = 0; i < profiles.length; i++) {
      var p = profiles[i];
      var value = p.email + '|' + p.name;
      var label = p.name ? (p.name + ' <' + p.email + '>') : p.email;
      var isSelected = !matched && selectedEmail && (p.email.toLowerCase() === selectedEmail.toLowerCase());
      if (isSelected) matched = true;
      dropdown.addItem(label, value, isSelected);
    }

    if (!matched && selectedEmail) {
      var customVal = selectedEmail + '|' + (selectedName || '');
      var customLabel = (selectedName ? (selectedName + ' <' + selectedEmail + '>') : selectedEmail) + ' (自動検出)';
      dropdown.addItem(customLabel, customVal, true);
    }

    section.addWidget(dropdown);
  }

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('custom_from_email')
      .setTitle('差出人アドレスの手動上書き（任意）')
      .setValue(profiles.length === 0 ? (selectedEmail || '') : '')
      .setHint('空欄なら上のプルダウンのアドレスを使用します')
  );

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('custom_from_name')
      .setTitle('表示名の手動上書き（任意）')
      .setValue(profiles.length === 0 ? (selectedName || '') : '')
      .setHint('空欄なら登録済みの表示名を使用します')
  );
}

/**
 * フォーム入力から最終的な { email, name } を決定する
 */
function resolveSelectedSender_(formInput, settings) {
  var form = formInput || {};
  var customEmail = (form.custom_from_email || '').trim();
  var customName = (form.custom_from_name || '').trim();
  var selectedProfile = form.selected_profile || '';

  var profileEmail = '';
  var profileName = '';
  if (selectedProfile && selectedProfile.indexOf('|') !== -1) {
    var parts = selectedProfile.split('|');
    profileEmail = parts[0].trim();
    profileName = parts.slice(1).join('|').trim();
  } else if (selectedProfile) {
    profileEmail = selectedProfile.trim();
  }

  var profiles = parseSenderProfiles_(settings);
  var fallbackEmail = profiles.length > 0 ? profiles[0].email : '';
  var fallbackName = profiles.length > 0 ? profiles[0].name : '';

  return {
    email: customEmail || profileEmail || fallbackEmail,
    name: customName || profileName || fallbackName
  };
}

/**
 * メールスレッド用の送信カードUIを構築
 */
function buildThreadReplyCard_(params) {
  var card = CardService.newCardBuilder();
  card.setHeader(
    CardService.newCardHeader()
      .setTitle('PrismPost 独自ドメイン返信')
      .setSubtitle('さくらのレンタルサーバ経由で送信')
  );

  var senderSection = CardService.newCardSection().setHeader('1. 差出人（複数ドメイン対応）');
  addSenderSelectionWidgets_(senderSection, params.settings, params.detectedEmail, params.detectedName);
  card.addSection(senderSection);

  var draftSection = CardService.newCardSection().setHeader('2. 返信下書き（Gemini作成対応）');

  if (!params.draft) {
    draftSection.addWidget(
      CardService.newTextParagraph().setText(
        '⚠️ <b>このスレッドに返信の下書きが見つかりません。</b><br><br>' +
        '① Gmail画面で「返信」または「全員に返信」を押す<br>' +
        '② 必要に応じて <b>Gemini AI</b> で返信文を作成する<br>' +
        '③ 下の「🔄 下書きを再読み込み」を押してください。<br>' +
        '<i>※Gmailの青い「送信」ボタンは押さないでください。</i>'
      )
    );

    var reloadAction = CardService.newAction()
      .setFunctionName('onReloadThreadCard')
      .setParameters({ messageId: params.messageId });

    draftSection.addWidget(
      CardService.newTextButton()
        .setText('🔄 下書きを再読み込み')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOnClickAction(reloadAction)
    );
  } else {
    var draftMsg = params.draft.getMessage();
    var toStr = draftMsg.getTo() || '(未指定)';
    var ccStr = draftMsg.getCc() || '';
    var bccStr = draftMsg.getBcc() || '';
    var subjStr = draftMsg.getSubject() || '(件名なし)';
    var bodyPreview = (draftMsg.getPlainBody() || '').slice(0, 140);
    var attachments = draftMsg.getAttachments();

    draftSection.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('宛先 (To)')
        .setText(toStr)
        .setWrapText(true)
    );

    if (ccStr) {
      draftSection.addWidget(
        CardService.newDecoratedText()
          .setTopLabel('CC（全員に返信）')
          .setText(ccStr)
          .setWrapText(true)
      );
    }

    if (bccStr) {
      draftSection.addWidget(
        CardService.newDecoratedText()
          .setTopLabel('BCC')
          .setText(bccStr)
          .setWrapText(true)
      );
    }

    draftSection.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('件名 (Subject)')
        .setText(subjStr)
        .setWrapText(true)
    );

    draftSection.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('本文プレビュー' + (attachments.length > 0 ? '（添付 ' + attachments.length + '件）' : ''))
        .setText(bodyPreview ? bodyPreview + '...' : '(本文が空です)')
        .setWrapText(true)
    );

    var sendAction = CardService.newAction()
      .setFunctionName('onSendDraft')
      .setParameters({
        draftId: params.draft.getId(),
        originalMessageId: params.messageId,
        threadId: params.threadId
      });

    var reloadAction2 = CardService.newAction()
      .setFunctionName('onReloadThreadCard')
      .setParameters({ messageId: params.messageId });

    draftSection.addWidget(
      CardService.newButtonSet()
        .addButton(
          CardService.newTextButton()
            .setText('🚀 独自ドメインで送信')
            .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
            .setOnClickAction(sendAction)
        )
        .addButton(
          CardService.newTextButton()
            .setText('🔄 更新')
            .setOnClickAction(reloadAction2)
        )
    );
  }

  card.addSection(draftSection);
  return card.build();
}

/**
 * 新規メール作成用：最新の下書き一覧から選んで独自ドメイン送信するカード
 */
function buildComposeDraftListCard_(settings) {
  var profiles = parseSenderProfiles_(settings);
  var firstEmail = profiles.length > 0 ? profiles[0].email : '';
  var firstName = profiles.length > 0 ? profiles[0].name : '';

  var card = CardService.newCardBuilder();
  card.setHeader(
    CardService.newCardHeader()
      .setTitle('PrismPost 新規・下書き送信')
      .setSubtitle('Gmailの下書きをさくらのレンタルサーバで送信')
  );

  var senderSection = CardService.newCardSection().setHeader('1. 差出人を選択');
  addSenderSelectionWidgets_(senderSection, settings, firstEmail, firstName);
  card.addSection(senderSection);

  var draftSection = CardService.newCardSection().setHeader('2. 送信する下書きを選択（最新5件）');
  var drafts = GmailApp.getDrafts().slice(0, 5);

  if (drafts.length === 0) {
    draftSection.addWidget(
      CardService.newTextParagraph().setText(
        '現在 Gmail に保存されている下書きはありません。<br>' +
        'Gmail の「作成」ボタンからメール（Gemini AI可）を作成してから「🔄 更新」を押してください。'
      )
    );
  } else {
    for (var i = 0; i < drafts.length; i++) {
      var d = drafts[i];
      var msg = d.getMessage();
      var to = msg.getTo() || '(宛先未入力)';
      var cc = msg.getCc();
      var subj = msg.getSubject() || '(件名なし)';

      draftSection.addWidget(
        CardService.newDecoratedText()
          .setTopLabel('To: ' + to + (cc ? ' / Cc: ' + cc : ''))
          .setText(subj)
          .setWrapText(true)
          .setButton(
            CardService.newTextButton()
              .setText('🚀 送信')
              .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
              .setOnClickAction(
                CardService.newAction()
                  .setFunctionName('onSendDraft')
                  .setParameters({
                    draftId: d.getId(),
                    originalMessageId: '',
                    threadId: msg.getThread().getId()
                  })
              )
          )
      );
    }
  }

  draftSection.addWidget(
    CardService.newTextButton()
      .setText('🔄 下書き一覧を更新')
      .setOnClickAction(CardService.newAction().setFunctionName('onHomepage'))
  );

  card.addSection(draftSection);
  return card.build();
}

/**
 * 下書きを再読み込みするアクション
 */
function onReloadThreadCard(e) {
  var messageId = e.parameters.messageId;
  var settings = getSettings_();
  var message = GmailApp.getMessageById(messageId);
  var thread = message.getThread();
  var detected = detectReceivingProfile_(message, settings);
  var selected = resolveSelectedSender_(e.formInput, settings);
  var draft = findDraftInThread_(thread.getId());

  var updatedCard = buildThreadReplyCard_({
    messageId: messageId,
    threadId: thread.getId(),
    detectedEmail: selected.email || detected.email,
    detectedName: selected.name || detected.name,
    settings: settings,
    draft: draft
  });

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(updatedCard))
    .setNotification(CardService.newNotification().setText('下書き情報を更新しました'))
    .build();
}

/**
 * 🚀 下書きをさくらのレンタルサーバ経由で送信し、Gmail スレッドに SENT メッセージとして記録して下書きを削除する
 */
function onSendDraft(e) {
  var settings = getSettings_();
  var draftId = e.parameters.draftId;
  var originalMessageId = e.parameters.originalMessageId || '';
  var sender = resolveSelectedSender_(e.formInput, settings);
  var fromEmail = sender.email;
  var fromName = sender.name;

  if (!fromEmail || fromEmail.indexOf('@') === -1) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('❌ エラー: 差出人メールアドレスを設定または選択してください'))
      .build();
  }

  if (!settings.sakuraEndpointUrl || !settings.secretToken) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('❌ エラー: さくらのPHP URLまたは秘密トークンが設定されていません'))
      .build();
  }

  var draft;
  try {
    draft = GmailApp.getDraft(draftId);
  } catch (err) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('❌ 下書きが見つかりませんでした（すでに送信または削除されています）'))
      .build();
  }

  var draftMsg = draft.getMessage();
  var toList = splitAddresses_(draftMsg.getTo());
  var ccList = splitAddresses_(draftMsg.getCc());
  var bccList = splitAddresses_(draftMsg.getBcc());

  if (toList.length === 0) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('❌ エラー: 下書きの宛先 (To) が空です'))
      .build();
  }

  var subject = draftMsg.getSubject() || '(No Subject)';

  // スレッド維持用ヘッダー (In-Reply-To / References) を元のメールから取得
  var customHeaders = {};
  if (originalMessageId) {
    try {
      var origMsg = GmailApp.getMessageById(originalMessageId);
      var rfc822MsgId = origMsg.getHeader('Message-ID') || origMsg.getHeader('Message-Id');
      var origRefs = origMsg.getHeader('References');
      if (rfc822MsgId) {
        customHeaders['In-Reply-To'] = rfc822MsgId;
        customHeaders['References'] = origRefs ? (origRefs + ' ' + rfc822MsgId) : rfc822MsgId;
      }
    } catch (ignoreErr) {}
  }

  var displayFrom = fromName ? (fromName + ' <' + fromEmail + '>') : fromEmail;
  var mimePrepared = buildRewrittenMime_(draftMsg.getRawContent(), fromEmail, fromName, customHeaders);
  var allEnvelopeRecipients = extractAllPureEmails_(toList.concat(ccList).concat(bccList));

  var sendResult = sendViaSakuraPhp_({
    endpointUrl: settings.sakuraEndpointUrl,
    secretToken: settings.secretToken,
    fromEmail: fromEmail,
    recipients: allEnvelopeRecipients,
    rawMime: mimePrepared.outboundMime
  });

  if (!sendResult.ok) {
    return CardService.newActionResponseBuilder()
      .setNotification(
        CardService.newNotification().setText('❌ 送信失敗 (' + sendResult.status + '): ' + sendResult.body)
      )
      .build();
  }

  // 送信成功後:
  // 1. 自分の Gmail スレッドにも送信済みメールとして記録（次回以降 Gemini AI が自分の返信文脈も読めるようにする）
  try {
    insertSentMimeToGmailThread_(mimePrepared.sentCopyMime, e.parameters.threadId);
  } catch (insertErr) {
    console.warn('Could not insert sent copy into Gmail thread:', insertErr);
  }

  // 2. 元々の下書きを削除（誤って個人Gmailから二重送信するのを防止）
  try {
    draft.deleteDraft();
  } catch (delErr) {
    console.warn('Could not delete draft:', delErr);
  }

  var doneCard = CardService.newCardBuilder()
    .setHeader(
      CardService.newCardHeader()
        .setTitle('✅ 送信完了')
        .setSubtitle(displayFrom)
    )
    .addSection(
      CardService.newCardSection()
        .addWidget(
          CardService.newTextParagraph().setText(
            '<b>さくらのレンタルサーバ経由でメールを送信しました！</b><br><br>' +
            '<b>From:</b> ' + escapeHtml_(displayFrom) + '<br>' +
            '<b>To:</b> ' + escapeHtml_(toList.join(', ')) + '<br>' +
            (ccList.length > 0 ? '<b>Cc:</b> ' + escapeHtml_(ccList.join(', ')) + '<br>' : '') +
            '<b>件名:</b> ' + escapeHtml_(subject) + '<br><br>' +
            '<i>※元の下書きは削除され、Gmailスレッドに送信済み履歴が追加されました。</i>'
          )
        )
    )
    .build();

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(doneCard))
    .setNotification(CardService.newNotification().setText('✅ 独自ドメインで送信しました！'))
    .build();
}

/**
 * さくらのレンタルサーバ上の PHP エンドポイント経由で送信
 * HMAC-SHA256 署名（タイムスタンプ付き）により、通信経路上に秘密トークン自体を流さずリプレイ攻撃も防ぐ
 */
function sendViaSakuraPhp_(params) {
  var payloadStr = JSON.stringify({
    from_email: params.fromEmail,
    recipients: params.recipients,
    raw_mime: params.rawMime
  });

  var timestamp = String(Math.floor(Date.now() / 1000));
  var sigBytes = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(timestamp + '.' + payloadStr).getBytes(),
    Utilities.newBlob(params.secretToken).getBytes()
  );
  var signatureHex = bytesToHex_(sigBytes);

  var response = UrlFetchApp.fetch(params.endpointUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-PrismPost-Timestamp': timestamp,
      'X-PrismPost-Signature': signatureHex
    },
    payload: payloadStr,
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  return {
    ok: code >= 200 && code < 300,
    status: code,
    body: response.getContentText()
  };
}

/**
 * バイト配列を16進文字列に変換
 */
function bytesToHex_(bytes) {
  var hex = [];
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b < 0) b += 256;
    var s = b.toString(16);
    hex.push(s.length === 1 ? '0' + s : s);
  }
  return hex.join('');
}

/**
 * Gmail下書きの Raw MIME から個人Gmailの痕跡（From / Message-ID）を独自ドメインに書き換え、
 * 送信用MIME（Bccヘッダー除去済み）とGmailスレッド保存用MIMEを生成する
 */
function buildRewrittenMime_(rawMime, fromEmail, fromName, customHeaders) {
  var encodedFrom = formatMimeAddress_(fromEmail, fromName);
  var fromDomain = (fromEmail.split('@')[1] || 'local').trim();

  var sepMatch = rawMime.match(/\r?\n\r?\n/);
  var headerPart = sepMatch ? rawMime.slice(0, sepMatch.index) : rawMime;
  var bodyPart = sepMatch ? rawMime.slice(sepMatch.index) : '';

  // 1. From ヘッダーを独自ドメインに置換
  if (/^From:/im.test(headerPart)) {
    headerPart = headerPart.replace(/^From:.*(?:\r?\n[ \t].*)*/im, 'From: ' + encodedFrom);
  } else {
    headerPart = 'From: ' + encodedFrom + '\r\n' + headerPart;
  }

  // 2. Message-ID の @mail.gmail.com を独自ドメインに置換（ヘッダーからの個人Gmail推測も防止）
  headerPart = headerPart.replace(/^(Message-ID:\s*<[^>@]+)>?@mail\.gmail\.com>/im, '$1@' + fromDomain + '>');

  // 3. In-Reply-To / References の補完
  if (customHeaders['In-Reply-To'] && !/^In-Reply-To:/im.test(headerPart)) {
    headerPart = 'In-Reply-To: ' + customHeaders['In-Reply-To'] + '\r\n' + headerPart;
  }
  if (customHeaders['References'] && !/^References:/im.test(headerPart)) {
    headerPart = 'References: ' + customHeaders['References'] + '\r\n' + headerPart;
  }

  // 送信用は Bcc ヘッダー行を取り除く（エンベロープ宛先のみで配送するため）
  var outboundHeaderPart = headerPart.replace(/^Bcc:.*(?:\r?\n[ \t].*)*\r?\n?/im, '');

  return {
    outboundMime: outboundHeaderPart + bodyPart,
    sentCopyMime: headerPart + bodyPart
  };
}

/**
 * 日本語を含む表示名を RFC 2047 (UTF-8 Base64) 形式にエンコードして From ヘッダー文字列を作る
 */
function formatMimeAddress_(email, name) {
  if (!name) return email;
  if (/^[\x20-\x7E]+$/.test(name)) {
    return '"' + name.replace(/"/g, '\\"') + '" <' + email + '>';
  }
  var b64 = Utilities.base64Encode(Utilities.newBlob(name, 'text/plain').getBytes());
  return '=?UTF-8?B?' + b64 + '?= <' + email + '>';
}

/**
 * 送信したメールの控えを Gmail の該当スレッドに「SENT（送信済み）」として追加する
 * 小容量（2MB未満）は標準API、大容量添付ファイル付き（最大35MB）は upload エンドポイントを使用
 */
function insertSentMimeToGmailThread_(sentCopyMime, threadId) {
  var mimeBytes = Utilities.newBlob(sentCopyMime).getBytes();

  if (mimeBytes.length < 2 * 1024 * 1024) {
    var encoded = Utilities.base64EncodeWebSafe(mimeBytes);
    var resource = {
      raw: encoded,
      labelIds: ['SENT']
    };
    if (threadId) {
      resource.threadId = threadId;
    }
    Gmail.Users.Messages.insert(resource, 'me');
    return;
  }

  var metadata = { labelIds: ['SENT'] };
  if (threadId) metadata.threadId = threadId;

  var boundary = 'prismpost_upload_' + Utilities.getUuid();
  var body =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: message/rfc822\r\n\r\n' +
    sentCopyMime + '\r\n' +
    '--' + boundary + '--';

  UrlFetchApp.fetch('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages?uploadType=multipart', {
    method: 'post',
    contentType: 'multipart/related; boundary=' + boundary,
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
    },
    payload: Utilities.newBlob(body).getBytes(),
    muteHttpExceptions: true
  });
}

/**
 * さくらインターネットから転送された受信メールのヘッダーを解析し、
 * 登録済みのどの独自ドメインアドレス（および表示名）宛に届いたメールかを自動判別する
 */
function detectReceivingProfile_(message, settings) {
  var myGmail = Session.getActiveUser().getEmail().toLowerCase();
  var profiles = parseSenderProfiles_(settings);
  var candidates = [];

  var headersToCheck = [
    message.getHeader('X-Original-To'),
    message.getHeader('X-Forwarded-To'),
    message.getHeader('Delivered-To'),
    message.getTo(),
    message.getCc()
  ];

  for (var i = 0; i < headersToCheck.length; i++) {
    var list = splitAddresses_(headersToCheck[i]);
    for (var j = 0; j < list.length; j++) {
      var email = extractPureEmail_(list[j]);
      if (email && email.toLowerCase() !== myGmail && !email.toLowerCase().endsWith('@gmail.com')) {
        candidates.push(email);
      }
    }
  }

  for (var c = 0; c < candidates.length; c++) {
    var candLower = candidates[c].toLowerCase();
    for (var p = 0; p < profiles.length; p++) {
      if (profiles[p].email.toLowerCase() === candLower) {
        return profiles[p];
      }
    }
  }

  for (var c2 = 0; c2 < candidates.length; c2++) {
    var candEmail = candidates[c2];
    var candDomain = (candEmail.split('@')[1] || '').toLowerCase();
    for (var p2 = 0; p2 < profiles.length; p2++) {
      if (profiles[p2].domain === candDomain) {
        return {
          email: candEmail,
          name: profiles[p2].name,
          domain: candDomain
        };
      }
    }
  }

  if (profiles.length > 0) {
    return profiles[0];
  }

  return {
    email: candidates[0] || '',
    name: ''
  };
}

/**
 * 指定されたスレッドID内にある最新の下書き（GmailDraft）を探す
 */
function findDraftInThread_(threadId) {
  var drafts = GmailApp.getDrafts();
  for (var i = 0; i < drafts.length; i++) {
    try {
      if (drafts[i].getMessage().getThread().getId() === threadId) {
        return drafts[i];
      }
    } catch (e) {}
  }
  return null;
}

/**
 * 設定画面を開く
 */
function onOpenSettings() {
  return buildSettingsCard_('');
}

/**
 * 設定カードUIを構築
 */
function buildSettingsCard_(noticeText) {
  var settings = getSettings_();
  var card = CardService.newCardBuilder();
  card.setHeader(
    CardService.newCardHeader()
      .setTitle('⚙️ PrismPost 設定')
      .setSubtitle('さくらのレンタルサーバ＆複数独自ドメイン設定')
  );

  var section = CardService.newCardSection();
  if (noticeText) {
    section.addWidget(CardService.newTextParagraph().setText('ℹ️ ' + noticeText));
  }

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('sakura_endpoint_url')
      .setTitle('さくらサーバに設置した PHP の URL (必須)')
      .setValue(settings.sakuraEndpointUrl)
      .setHint('例: https://yourdomain.com/prismpost-send.php')
  );

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('secret_token')
      .setTitle('秘密トークン ($SECRET_TOKEN) (必須)')
      .setValue(settings.secretToken)
      .setHint('sakura-relay.php に設定した16文字以上のランダム文字列')
  );

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('sender_profiles')
      .setTitle('差出人アドレス一覧（1行に1件・複数ドメイン可）(必須)')
      .setMultiline(true)
      .setValue(settings.senderProfilesRaw)
      .setHint('例:\ninfo@domain-a.com | 株式会社A サポート\ntaro@domain-b.jp | 山田 太郎')
  );

  section.addWidget(
    CardService.newTextButton()
      .setText('💾 設定を保存')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('onSaveSettings'))
  );

  card.addSection(section);
  return card.build();
}

/**
 * 設定を保存するアクション
 */
function onSaveSettings(e) {
  var form = e.formInput || {};
  var props = PropertiesService.getUserProperties();

  if (form.sakura_endpoint_url !== undefined) {
    props.setProperty('SAKURA_ENDPOINT_URL', form.sakura_endpoint_url.trim());
  }
  if (form.secret_token !== undefined) {
    props.setProperty('SECRET_TOKEN', form.secret_token.trim());
  }
  if (form.sender_profiles !== undefined) {
    props.setProperty('SENDER_PROFILES', form.sender_profiles.trim());
  }

  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('✅ 設定を保存しました'))
    .setNavigation(CardService.newNavigation().popToRoot())
    .build();
}

/**
 * カンマ区切りのアドレス文字列を配列に分割
 */
function splitAddresses_(raw) {
  if (!raw) return [];
  var result = [];
  var current = '';
  var inQuotes = false;

  for (var i = 0; i < raw.length; i++) {
    var ch = raw.charAt(i);
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ',' && !inQuotes) {
      if (current.trim()) result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

/**
 * "Name <user@domain>" から純粋な user@domain を抽出
 */
function extractPureEmail_(addr) {
  if (!addr) return '';
  var match = addr.match(/<([^>]+)>/);
  return (match ? match[1] : addr).trim();
}

/**
 * アドレス配列から重複なしの純粋なメールアドレス一覧を抽出
 */
function extractAllPureEmails_(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var email = extractPureEmail_(list[i]);
    var lower = email.toLowerCase();
    if (email && email.indexOf('@') !== -1 && !seen[lower]) {
      seen[lower] = true;
      out.push(email);
    }
  }
  return out;
}

function escapeHtml_(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
