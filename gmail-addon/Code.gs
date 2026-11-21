/**
 * PrismPost Gmail Add-on (Google Apps Script)
 * レンタルサーバー / VPS（PHP中継）＋ 複数独自ドメイン対応版
 * （秘密トークン不要・Google OIDC 電子署名認証版）
 *
 * 機能:
 * 1. レンタルサーバー等から転送されたメールのヘッダー（X-Original-To / Delivered-To / To / Cc 等）を解析し、
 *    登録済みの複数独自ドメインから最適な「差出人アドレス・表示名」を自動選択
 * 2. Gmail上で作成した下書き（To/Cc/Bcc/本文/HTML/添付ファイル）を取得
 * 3. 個人Gmailの痕跡（From や Message-ID の @mail.gmail.com）を独自ドメインに書き換え、差出人別署名を自動挿入し、
 *    Google公式電子署名 (OIDC IDトークン) ＋ HMAC-SHA256 署名付き HTTPS 通信で PHP スクリプト経由で直接送信
 * 4. 送信したメールを Gmail のスレッドに「送信済み (SENT)」として自動追加し、PrismPost ラベルを付与
 */

var PRISM_ICON_URL = 'https://raw.githubusercontent.com/crosslamina/prismpost/main/gmail-addon/prismpost-icon.png';

/**
 * 共通のプリズムアイコン付きカードヘッダーを生成
 */
function buildPrismHeader_(title, subtitle) {
  var header = CardService.newCardHeader()
    .setTitle(title)
    .setImageUrl(PRISM_ICON_URL)
    .setImageStyle(CardService.ImageStyle.SQUARE);
  if (subtitle) {
    header.setSubtitle(subtitle);
  }
  return header;
}

/**
 * ユーザー設定の取得（旧キー SAKURA_ENDPOINT_URL とも後方互換を維持）
 */
function getSettings_() {
  var props = PropertiesService.getUserProperties();
  var signatures = {};
  var rawSigs = props.getProperty('SIGNATURES_JSON') || '';
  if (rawSigs) {
    try {
      var parsed = JSON.parse(rawSigs);
      if (parsed && typeof parsed === 'object') {
        signatures = parsed;
      }
    } catch (ignoreErr) {}
  }
  return {
    endpointUrl: props.getProperty('RELAY_ENDPOINT_URL') || props.getProperty('SAKURA_ENDPOINT_URL') || '',
    senderProfilesRaw: props.getProperty('SENDER_PROFILES') || '',
    signatures: signatures
  };
}

/**
 * 設定が初期化済みか判定
 */
function hasValidSettings_(settings) {
  return Boolean(settings.endpointUrl && settings.senderProfilesRaw);
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
    return buildSettingsCard_('URL と差出人一覧を設定してください。');
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
    isSentViaPrismPost: isMessageSentViaPrismPost_(message),
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
    return buildSettingsCard_('URL と差出人一覧を設定してください。');
  }
  return buildComposeDraftListCard_(settings);
}

/**
 * 差出人選択ウィジェット群をセクションに追加する共通関数
 */
function addSenderSelectionWidgets_(section, settings, selectedEmail, selectedName, appendSignature) {
  var profiles = parseSenderProfiles_(settings);
  var sigChecked = (typeof appendSignature === 'boolean') ? appendSignature : true;

  if (profiles.length > 0) {
    var dropdown = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('selected_profile')
      .setTitle('差出人');

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

    var sigToggle = CardService.newSelectionInput()
      .setType(CardService.SelectionInputType.CHECK_BOX)
      .setFieldName('append_signature')
      .addItem('✍️ 署名を挿入', 'true', sigChecked);
    section.addWidget(sigToggle);
  } else {
    section.addWidget(
      CardService.newTextParagraph().setText('⚠️ 差出人が未登録です。「⚙️ 設定」から登録してください。')
    );
  }
}

/**
 * 署名自動挿入チェックボックスが ON か判定する
 */
function shouldAppendSignature_(formInput) {
  if (!formInput || formInput.append_signature === undefined || formInput.append_signature === null) {
    return false;
  }
  var val = formInput.append_signature;
  if (Array.isArray(val)) {
    return val.indexOf('true') !== -1;
  }
  return String(val) === 'true';
}

/**
 * フォーム入力から最終的な { email, name } を決定する
 */
function resolveSelectedSender_(formInput, settings) {
  var form = formInput || {};
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

  if (profileEmail) {
    return {
      email: profileEmail,
      name: profileName
    };
  }

  var profiles = parseSenderProfiles_(settings);
  return {
    email: profiles.length > 0 ? profiles[0].email : '',
    name: profiles.length > 0 ? profiles[0].name : ''
  };
}

/**
 * メールスレッド用の送信カードUIを構築
 */
function buildThreadReplyCard_(params) {
  var card = CardService.newCardBuilder();
  card.setHeader(
    buildPrismHeader_('PrismPost')
  );

  if (params.isSentViaPrismPost) {
    card.addSection(
      CardService.newCardSection().addWidget(
        CardService.newDecoratedText()
          .setTopLabel('ステータス')
          .setText('✅ PrismPost 送信済み')
          .setWrapText(true)
      )
    );
  }

  var senderSection = CardService.newCardSection().setHeader('差出人');
  addSenderSelectionWidgets_(senderSection, params.settings, params.detectedEmail, params.detectedName, params.appendSignature);
  card.addSection(senderSection);

  var draftSection = CardService.newCardSection().setHeader('下書き');

  if (!params.draft) {
    draftSection.addWidget(
      CardService.newTextParagraph().setText('下書きがありません。')
    );

    var reloadAction = CardService.newAction()
      .setFunctionName('onReloadThreadCard')
      .setParameters({ messageId: params.messageId });

    draftSection.addWidget(
      CardService.newTextButton()
        .setText('🔄 再読み込み')
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
        .setTopLabel('To')
        .setText(toStr)
        .setWrapText(true)
    );

    if (ccStr) {
      draftSection.addWidget(
        CardService.newDecoratedText()
          .setTopLabel('Cc')
          .setText(ccStr)
          .setWrapText(true)
      );
    }

    if (bccStr) {
      draftSection.addWidget(
        CardService.newDecoratedText()
          .setTopLabel('Bcc')
          .setText(bccStr)
          .setWrapText(true)
      );
    }

    draftSection.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('件名')
        .setText(subjStr)
        .setWrapText(true)
    );

    draftSection.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('本文' + (attachments.length > 0 ? ' (添付' + attachments.length + '件)' : ''))
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
            .setText('🚀 送信')
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

  var navSection = CardService.newCardSection();
  navSection.addWidget(
    CardService.newTextButton()
      .setText('📝 下書き一覧')
      .setOnClickAction(CardService.newAction().setFunctionName('onOpenComposeDraftList'))
  );
  card.addSection(navSection);

  return card.build();
}

/**
 * 新規作成・他の下書き一覧カードへ遷移するアクション（スマホGmailアプリ対応）
 */
function onOpenComposeDraftList(e) {
  var settings = getSettings_();
  var nextCard = hasValidSettings_(settings)
    ? buildComposeDraftListCard_(settings)
    : buildSettingsCard_('URL と差出人一覧を設定してください。');

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(nextCard))
    .build();
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
    buildPrismHeader_('下書き一覧')
  );

  var senderSection = CardService.newCardSection().setHeader('差出人');
  addSenderSelectionWidgets_(senderSection, settings, firstEmail, firstName);
  card.addSection(senderSection);

  var draftSection = CardService.newCardSection().setHeader('下書き');
  var drafts = getSendableDrafts_(5);

  if (drafts.length === 0) {
    draftSection.addWidget(
      CardService.newTextParagraph().setText('送信可能な下書きがありません。')
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
      .setText('🔄 更新')
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
  var appendSig = (e.formInput && e.formInput.selected_profile !== undefined)
    ? shouldAppendSignature_(e.formInput)
    : true;

  var updatedCard = buildThreadReplyCard_({
    messageId: messageId,
    threadId: thread.getId(),
    detectedEmail: selected.email || detected.email,
    detectedName: selected.name || detected.name,
    isSentViaPrismPost: isMessageSentViaPrismPost_(message),
    appendSignature: appendSig,
    settings: settings,
    draft: draft
  });

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(updatedCard))
    .setNotification(CardService.newNotification().setText('下書き情報を更新しました'))
    .build();
}

/**
 * 🚀 下書きを PHP リレー経由で送信し、Gmail スレッドに SENT メッセージとして記録して下書きを削除する
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

  if (!settings.endpointUrl) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('❌ エラー: PHP URL が設定されていません'))
      .build();
  }

  var idToken = ScriptApp.getIdentityToken();
  if (!idToken) {
    return CardService.newActionResponseBuilder()
      .setNotification(CardService.newNotification().setText('❌ エラー: Google IDトークンを取得できません。アドオンの権限を再承認してください'))
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
  var signatureText = '';
  if (shouldAppendSignature_(e.formInput) && settings.signatures) {
    signatureText = settings.signatures[fromEmail.toLowerCase()] || '';
  }
  var mimePrepared = buildRewrittenMime_(draftMsg.getRawContent(), fromEmail, fromName, customHeaders, signatureText);
  var allEnvelopeRecipients = extractAllPureEmails_(toList.concat(ccList).concat(bccList));

  var sendResult = sendViaRelayPhp_({
    endpointUrl: settings.endpointUrl,
    idToken: idToken,
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
      buildPrismHeader_('✅ 送信完了', displayFrom)
    )
    .addSection(
      CardService.newCardSection()
        .addWidget(
          CardService.newTextParagraph().setText(
            '<b>From:</b> ' + escapeHtml_(displayFrom) + '<br>' +
            '<b>To:</b> ' + escapeHtml_(toList.join(', ')) + '<br>' +
            (ccList.length > 0 ? '<b>Cc:</b> ' + escapeHtml_(ccList.join(', ')) + '<br>' : '') +
            '<b>件名:</b> ' + escapeHtml_(subject)
          )
        )
    )
    .build();

  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(doneCard))
    .setNotification(CardService.newNotification().setText('✅ 送信しました'))
    .build();
}

/**
 * サーバー上の PHP エンドポイントへ署名付き POST リクエストを送る共通関数
 */
function postSignedToRelay_(endpointUrl, idToken, payloadObj) {
  var payloadStr = JSON.stringify(payloadObj);
  var timestamp = String(Math.floor(Date.now() / 1000));
  var sigBytes = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(timestamp + '.' + payloadStr).getBytes(),
    Utilities.newBlob(idToken).getBytes()
  );
  var signatureHex = bytesToHex_(sigBytes);

  var response = UrlFetchApp.fetch(endpointUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + idToken,
      'X-PrismPost-Id-Token': idToken,
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
 * サーバー上の PHP エンドポイント経由で送信
 * Google OIDC IDトークン + HMAC-SHA256 署名（タイムスタンプ付き）で安全に認証する
 */
function sendViaRelayPhp_(params) {
  var idToken = params.idToken || ScriptApp.getIdentityToken();
  return postSignedToRelay_(params.endpointUrl, idToken, {
    action: 'send',
    from_email: params.fromEmail,
    recipients: params.recipients,
    raw_mime: params.rawMime
  });
}

/**
 * 設定保存時にリレーサーバーと Google アカウントのペアリング（所有者ロック・許可ドメイン同期）を行う
 */
function pairWithRelayServer_(endpointUrl, allowedDomains) {
  var idToken = ScriptApp.getIdentityToken();
  if (!idToken) {
    return {
      ok: false,
      status: 0,
      body: 'Google IDトークンを取得できませんでした。アドオンの権限を再承認してください。'
    };
  }

  var res = postSignedToRelay_(endpointUrl, idToken, {
    action: 'pair',
    allowed_domains: allowedDomains
  });

  var parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch (ignoreErr) {}

  return {
    ok: res.ok && parsed && parsed.ok === true,
    status: res.status,
    body: res.body,
    ownerEmail: parsed && parsed.owner_email ? parsed.owner_email : '',
    allowedDomains: parsed && parsed.allowed_domains ? parsed.allowed_domains : allowedDomains
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
function buildRewrittenMime_(rawMime, fromEmail, fromName, customHeaders, signatureText) {
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

  // 4. 差出人ごとの署名を本文 (text/plain および text/html) に自動挿入
  if (signatureText && signatureText.trim() !== '') {
    var withSig = injectSignatureIntoRawMime_(headerPart, bodyPart, signatureText);
    headerPart = withSig.headerPart;
    bodyPart = withSig.bodyPart;
  }

  // 送信用は Bcc ヘッダー行を取り除く（エンベロープ宛先のみで配送するため）
  var outboundHeaderPart = headerPart.replace(/^Bcc:.*(?:\r?\n[ \t].*)*\r?\n?/im, '');

  // 自分の Gmail スレッドに保存する控えにだけ内部判定用ヘッダーを付与（相手には送らない）
  var sentCopyHeaderPart = 'X-PrismPost-Sent: true\r\n' + headerPart;

  return {
    outboundMime: outboundHeaderPart + bodyPart,
    sentCopyMime: sentCopyHeaderPart + bodyPart
  };
}

/**
 * Raw MIME のヘッダー・ボディ対に対して署名を挿入する
 */
function injectSignatureIntoRawMime_(headerPart, bodyPart, signatureText) {
  var updated = injectSignatureIntoMimeEntity_(headerPart + bodyPart, signatureText);
  var sep = updated.match(/\r?\n\r?\n/);
  if (!sep) {
    return { headerPart: headerPart, bodyPart: bodyPart };
  }
  return {
    headerPart: updated.slice(0, sep.index),
    bodyPart: updated.slice(sep.index)
  };
}

/**
 * 単一または multipart/* MIME エンティティ内の text/plain・text/html パートに署名を挿入
 */
function injectSignatureIntoMimeEntity_(rawEntity, signatureText) {
  var sep = rawEntity.match(/\r?\n\r?\n/);
  if (!sep) return rawEntity;

  var entHeader = rawEntity.slice(0, sep.index);
  var entSep = sep[0];
  var entBody = rawEntity.slice(sep.index + entSep.length);

  var disposition = getUnfoldedHeader_(entHeader, 'Content-Disposition');
  if (/\battachment\b/i.test(disposition)) {
    return rawEntity;
  }

  var contentType = getUnfoldedHeader_(entHeader, 'Content-Type');

  // multipart/* の場合は各パートを再帰処理（添付ファイル等には触れない）
  if (/^\s*multipart\//i.test(contentType)) {
    var boundaryMatch = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    if (!boundaryMatch) return rawEntity;
    var boundary = boundaryMatch[1] || boundaryMatch[2];
    var updatedMultipart = injectSignatureIntoMultipartBody_(entBody, boundary, signatureText);
    return entHeader + entSep + updatedMultipart;
  }

  var isPlain = contentType === '' || /^\s*text\/plain\b/i.test(contentType);
  var isHtml = /^\s*text\/html\b/i.test(contentType);
  if (!isPlain && !isHtml) {
    return rawEntity;
  }

  var charsetMatch = contentType.match(/charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  var charset = (charsetMatch && (charsetMatch[1] || charsetMatch[2])) || 'UTF-8';
  var cte = getUnfoldedHeader_(entHeader, 'Content-Transfer-Encoding').trim().toLowerCase();

  var decodedText;
  try {
    decodedText = decodeMimeBodyText_(entBody, cte, charset);
  } catch (err) {
    console.warn('Failed to decode MIME body for signature insertion:', err);
    return rawEntity;
  }

  var updatedText = isHtml
    ? insertSignatureHtml_(decodedText, signatureText)
    : insertSignaturePlain_(decodedText, signatureText);

  if (updatedText === decodedText) {
    return rawEntity;
  }

  var b64Wrapped = encodeUtf8Base64Wrapped_(updatedText);
  var updatedHeader = ensureUtf8Base64Headers_(entHeader, isHtml ? 'text/html' : 'text/plain');
  return updatedHeader + entSep + b64Wrapped;
}

/**
 * multipart ボディ内の各境界パートを処理して再構築する
 */
function injectSignatureIntoMultipartBody_(body, boundary, signatureText) {
  var re = new RegExp('(^|\\r?\\n)(--' + escapeRegExp_(boundary) + ')(--|\\r?\\n)', 'g');
  var out = [];
  var inPart = false;
  var partStart = 0;
  var match;

  while ((match = re.exec(body)) !== null) {
    if (!inPart) {
      out.push(body.slice(0, match.index));
      if (match[3] === '--') {
        out.push(body.slice(match.index));
        return out.join('');
      }
      out.push(match[0]);
      inPart = true;
      partStart = re.lastIndex;
      continue;
    }

    var partContent = body.slice(partStart, match.index);
    out.push(injectSignatureIntoMimeEntity_(partContent, signatureText));

    if (match[3] === '--') {
      out.push(body.slice(match.index));
      return out.join('');
    }
    out.push(match[0]);
    partStart = re.lastIndex;
  }

  if (inPart && partStart <= body.length) {
    out.push(body.slice(partStart));
  }
  return out.length > 0 ? out.join('') : body;
}

/**
 * 折りたたみヘッダーを展開して値を取得する
 */
function getUnfoldedHeader_(headerPart, headerName) {
  var re = new RegExp('^' + escapeRegExp_(headerName) + ':\\s*([\\s\\S]*?)(?=\\r?\\n[^ \\t]|$)', 'im');
  var match = headerPart.match(re);
  if (!match) return '';
  return match[1].replace(/\r?\n[ \t]+/g, ' ').trim();
}

/**
 * MIME ボディを Content-Transfer-Encoding に従って文字列へデコードする
 */
function decodeMimeBodyText_(bodyStr, cte, charset) {
  var cs = charset || 'UTF-8';
  if (cte === 'base64') {
    var cleaned = bodyStr.replace(/\s+/g, '');
    if (!cleaned) return '';
    return Utilities.newBlob(Utilities.base64Decode(cleaned)).getDataAsString(cs);
  }
  if (cte === 'quoted-printable') {
    return decodeQuotedPrintable_(bodyStr, cs);
  }
  return bodyStr;
}

/**
 * Quoted-Printable 文字列をバイト配列経由で正しく UTF-8 等へデコードする
 */
function decodeQuotedPrintable_(str, charset) {
  var cleaned = str.replace(/=\r?\n/g, '');
  var bytes = [];
  for (var i = 0; i < cleaned.length; i++) {
    var ch = cleaned.charAt(i);
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.substr(i + 1, 2))) {
      var val = parseInt(cleaned.substr(i + 1, 2), 16);
      bytes.push(val > 127 ? val - 256 : val);
      i += 2;
    } else {
      var code = cleaned.charCodeAt(i);
      if (code < 128) {
        bytes.push(code);
      } else {
        var extraBytes = Utilities.newBlob(ch, 'text/plain').getBytes();
        for (var j = 0; j < extraBytes.length; j++) {
          bytes.push(extraBytes[j]);
        }
      }
    }
  }
  return Utilities.newBlob(bytes).getDataAsString(charset || 'UTF-8');
}

/**
 * UTF-8 Base64（76文字改行）にエンコードする
 */
function encodeUtf8Base64Wrapped_(text) {
  var rawBytes = Utilities.newBlob(text, 'text/plain').getBytes();
  var b64 = Utilities.base64Encode(rawBytes);
  var chunks = b64.match(/.{1,76}/g);
  return chunks ? chunks.join('\r\n') : '';
}

/**
 * Content-Type を charset="UTF-8"、Content-Transfer-Encoding を base64 に更新する
 */
function ensureUtf8Base64Headers_(headerPart, defaultMimeType) {
  var updated = headerPart;

  if (/^Content-Type:/im.test(updated)) {
    updated = updated.replace(/^(Content-Type:.*(?:\r?\n[ \t].*)*)/im, function (full) {
      if (/charset\s*=/i.test(full)) {
        return full.replace(/charset\s*=\s*(?:"[^"]+"|[^;\s]+)/i, 'charset="UTF-8"');
      }
      return full + '; charset="UTF-8"';
    });
  } else {
    updated += '\r\nContent-Type: ' + defaultMimeType + '; charset="UTF-8"';
  }

  if (/^Content-Transfer-Encoding:/im.test(updated)) {
    updated = updated.replace(/^Content-Transfer-Encoding:.*(?:\r?\n[ \t].*)*/im, 'Content-Transfer-Encoding: base64');
  } else {
    updated += '\r\nContent-Transfer-Encoding: base64';
  }

  return updated;
}

/**
 * プレーンテキスト本文に署名を挿入する（引用文があればその直前、なければ末尾）
 * 重複チェックは「引用文より上の今回書いたエリア」のみを対象とするため、2往復目以降も正しく付与される
 */
function insertSignaturePlain_(text, sig) {
  var cleanSig = String(sig || '').replace(/\r?\n/g, '\r\n').trim();
  if (!cleanSig) return text;

  var quotePatterns = [
    /(?:\r?\n)On [^\r\n]+(?:\r?\n[^\r\n]{1,80})?wrote:\s*(?=\r?\n)/,
    /(?:\r?\n)\d{4}年\d{1,2}月\d{1,2}日[^\r\n]*(?:\r?\n[^\r\n]{1,80})?:\s*(?=\r?\n)/,
    /(?:\r?\n)-----Original Message-----/,
    /(?:\r?\n)>/
  ];

  var earliestIdx = -1;
  for (var i = 0; i < quotePatterns.length; i++) {
    var m = quotePatterns[i].exec(text);
    if (m && (earliestIdx === -1 || m.index < earliestIdx)) {
      earliestIdx = m.index;
    }
  }

  var targetArea = earliestIdx !== -1 ? text.slice(0, earliestIdx) : text;
  var normSig = cleanSig.replace(/\r\n/g, '\n');
  if (targetArea.replace(/\r\n/g, '\n').indexOf(normSig) !== -1) {
    return text;
  }

  if (earliestIdx !== -1) {
    var before = text.slice(0, earliestIdx).replace(/[\r\n]+$/, '');
    var after = text.slice(earliestIdx).replace(/^\r?\n/, '');
    return before + '\r\n\r\n' + cleanSig + '\r\n\r\n' + after;
  }

  return text.replace(/[\r\n]+$/, '') + '\r\n\r\n' + cleanSig + '\r\n';
}

/**
 * HTML 本文に署名を挿入する（引用ブロックがあればその直前、なければ </body> 直前または末尾）
 * 重複チェックは「引用ブロックより上の今回書いたエリア」のみを対象とするため、2往復目以降も正しく付与される
 */
function insertSignatureHtml_(html, sig) {
  var cleanSig = String(sig || '').replace(/\r\n/g, '\n').trim();
  if (!cleanSig) return html;

  var markers = [
    /<div\b[^>]*class=["'][^"']*gmail_quote/i,
    /<blockquote\b/i,
    /<\/body>/i
  ];

  var matchIdx = -1;
  for (var i = 0; i < markers.length; i++) {
    var m = markers[i].exec(html);
    if (m) {
      matchIdx = m.index;
      break;
    }
  }

  var targetHtml = matchIdx !== -1 ? html.slice(0, matchIdx) : html;
  var escapedSigHtml = escapeHtml_(cleanSig).replace(/\r?\n/g, '<br>');
  if (targetHtml.indexOf('prismpost-signature') !== -1 || targetHtml.indexOf(escapedSigHtml) !== -1) {
    return html;
  }

  var sigHtml = '<br clear="all"><div class="prismpost-signature" style="margin-top:12px;white-space:pre-wrap;">' +
    escapedSigHtml +
    '</div><br>';

  if (matchIdx !== -1) {
    return html.slice(0, matchIdx) + sigHtml + html.slice(matchIdx);
  }

  return html + sigHtml;
}

function escapeRegExp_(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * 開いているメールが PrismPost 経由で送信されたものか判定する
 */
function isMessageSentViaPrismPost_(message) {
  if (!message) return false;
  try {
    return (message.getHeader('X-PrismPost-Sent') || '').trim().toLowerCase() === 'true';
  } catch (ignoreErr) {
    return false;
  }
}

/**
 * Gmail 上に「PrismPost」ラベルを取得（なければ自動作成）してラベル ID を返す
 */
function getOrCreatePrismPostLabelId_() {
  try {
    var listRes = Gmail.Users.Labels.list('me');
    var labels = (listRes && listRes.labels) ? listRes.labels : [];
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].name === 'PrismPost') {
        return labels[i].id;
      }
    }
    var created = Gmail.Users.Labels.create({
      name: 'PrismPost',
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show'
    }, 'me');
    return created && created.id ? created.id : null;
  } catch (err) {
    console.warn('Could not get or create PrismPost label:', err);
    return null;
  }
}

/**
 * 送信したメールの控えを Gmail の該当スレッドに「SENT（送信済み）」＋「PrismPost」ラベル付きで追加する
 * 小容量（2MB未満）は標準API、大容量添付ファイル付き（最大35MB）は upload エンドポイントを使用
 */
function insertSentMimeToGmailThread_(sentCopyMime, threadId) {
  var mimeBytes = Utilities.newBlob(sentCopyMime).getBytes();
  var labelIds = ['SENT'];
  var prismPostLabelId = getOrCreatePrismPostLabelId_();
  if (prismPostLabelId) {
    labelIds.push(prismPostLabelId);
  }

  if (mimeBytes.length < 2 * 1024 * 1024) {
    var encoded = Utilities.base64EncodeWebSafe(mimeBytes);
    var resource = {
      raw: encoded,
      labelIds: labelIds
    };
    if (threadId) {
      resource.threadId = threadId;
    }
    Gmail.Users.Messages.insert(resource, 'me');
    return;
  }

  var metadata = { labelIds: labelIds };
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
 * 転送された受信メールのヘッダーを解析し、
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
 * 送信対象として有効な下書きメッセージか判定する
 * Gmail内部ではテンプレート（定型文）も宛先空の下書きとして保存されるため除外する
 */
function isSendableDraftMessage_(msg) {
  if (!msg) return false;
  try {
    var cannedHeader = msg.getHeader('X-Gm-Canned-Response');
    if (cannedHeader && cannedHeader.trim() !== '') {
      return false;
    }
  } catch (ignoreErr) {}

  var to = (msg.getTo() || '').trim();
  var cc = (msg.getCc() || '').trim();
  var bcc = (msg.getBcc() || '').trim();
  return Boolean(to || cc || bcc);
}

/**
 * テンプレート等を除外し、送信可能な最新の下書き一覧を指定件数まで取得する
 */
function getSendableDrafts_(limit) {
  var allDrafts = GmailApp.getDrafts();
  var result = [];
  for (var i = 0; i < allDrafts.length; i++) {
    try {
      var d = allDrafts[i];
      if (isSendableDraftMessage_(d.getMessage())) {
        result.push(d);
        if (result.length >= limit) {
          break;
        }
      }
    } catch (ignoreErr) {}
  }
  return result;
}

/**
 * 指定されたスレッドID内にある最新の下書き（GmailDraft）を探す
 */
function findDraftInThread_(threadId) {
  var drafts = GmailApp.getDrafts();
  for (var i = 0; i < drafts.length; i++) {
    try {
      var msg = drafts[i].getMessage();
      if (msg.getThread().getId() === threadId && isSendableDraftMessage_(msg)) {
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
    buildPrismHeader_('⚙️ 設定')
  );

  var section = CardService.newCardSection();
  if (noticeText) {
    section.addWidget(CardService.newTextParagraph().setText('ℹ️ ' + noticeText));
  }

  var myEmail = Session.getActiveUser().getEmail() || '(取得できません)';
  section.addWidget(
    CardService.newDecoratedText()
      .setTopLabel('認証アカウント')
      .setText(myEmail)
      .setWrapText(true)
  );

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('relay_endpoint_url')
      .setTitle('PHP URL')
      .setValue(settings.endpointUrl)
      .setHint('https://yourdomain.com/prismpost-relay.php')
  );

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('sender_profiles')
      .setTitle('差出人一覧（1行1件）')
      .setMultiline(true)
      .setValue(settings.senderProfilesRaw)
      .setHint('info@example.com | 表示名')
  );

  card.addSection(section);

  var profiles = parseSenderProfiles_(settings);
  var sigSection = CardService.newCardSection().setHeader('✍️ 署名');

  for (var i = 0; i < profiles.length; i++) {
    var p = profiles[i];
    var emailKey = p.email.toLowerCase();
    sigSection.addWidget(
      CardService.newTextInput()
        .setFieldName('sig__' + emailKey)
        .setTitle(p.email)
        .setMultiline(true)
        .setValue((settings.signatures && settings.signatures[emailKey]) || '')
    );
  }

  sigSection.addWidget(
    CardService.newTextButton()
      .setText('💾 保存')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('onSaveSettings'))
  );

  card.addSection(sigSection);
  return card.build();
}

/**
 * 設定を保存し、リレーサーバーと Google アカウントのペアリングを実行するアクション
 */
function onSaveSettings(e) {
  var form = e.formInput || {};
  var props = PropertiesService.getUserProperties();

  var rawEndpointUrl = form.relay_endpoint_url !== undefined ? form.relay_endpoint_url : form.sakura_endpoint_url;
  if (rawEndpointUrl !== undefined) {
    var trimmedUrl = rawEndpointUrl.trim();
    props.setProperty('RELAY_ENDPOINT_URL', trimmedUrl);
    props.setProperty('SAKURA_ENDPOINT_URL', trimmedUrl);
  }
  if (form.sender_profiles !== undefined) {
    props.setProperty('SENDER_PROFILES', form.sender_profiles.trim());
  }

  var signatures = getSettings_().signatures || {};
  var formKeys = Object.keys(form);
  for (var kIdx = 0; kIdx < formKeys.length; kIdx++) {
    var formKey = formKeys[kIdx];
    if (formKey.indexOf('sig__') === 0) {
      var emailKey = formKey.slice(5).toLowerCase();
      signatures[emailKey] = String(form[formKey] || '').replace(/\r\n/g, '\n').trim();
    }
  }
  props.setProperty('SIGNATURES_JSON', JSON.stringify(signatures));

  props.deleteProperty('SECRET_TOKEN');
  props.deleteProperty('API_KEY');

  var settings = getSettings_();
  if (!settings.endpointUrl || settings.endpointUrl.indexOf('https://') !== 0) {
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(
        buildSettingsCard_('❌ https:// から始まる URL を入力してください。')
      ))
      .setNotification(CardService.newNotification().setText('❌ https:// の URL が必要です'))
      .build();
  }

  var profiles = parseSenderProfiles_(settings);
  if (profiles.length === 0) {
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(
        buildSettingsCard_('❌ 差出人メールアドレスを1件以上入力してください。')
      ))
      .setNotification(CardService.newNotification().setText('❌ 差出人アドレスが必要です'))
      .build();
  }

  var domainMap = {};
  var allowedDomains = [];
  for (var i = 0; i < profiles.length; i++) {
    if (!domainMap[profiles[i].domain]) {
      domainMap[profiles[i].domain] = true;
      allowedDomains.push(profiles[i].domain);
    }
  }

  var pairResult = pairWithRelayServer_(settings.endpointUrl, allowedDomains);
  if (!pairResult.ok) {
    return CardService.newActionResponseBuilder()
      .setNavigation(CardService.newNavigation().updateCard(
        buildSettingsCard_('⚠️ 連携失敗 (' + pairResult.status + '): ' + pairResult.body)
      ))
      .setNotification(CardService.newNotification().setText('❌ 連携失敗 (' + pairResult.status + ')'))
      .build();
  }

  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('✅ 保存しました (' + pairResult.ownerEmail + ')'))
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

/**
 * デバッグ用：Apps Script エディタ上から自分の UserProperties（保存済み設定）を確認する
 * エディタ上部の関数選択で「debugShowMyProperties」を選んで「▷ 実行」を押してください
 */
function debugShowMyProperties() {
  var all = PropertiesService.getUserProperties().getProperties();
  console.log(JSON.stringify(all, null, 2));
  return all;
}
