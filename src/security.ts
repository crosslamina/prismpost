/**
 * メールアドレス文字列（"Name <email@domain>" または "email@domain"）から
 * 純粋なメールアドレス部分を抽出（ローカルパートのケースは保持し、ドメインパートのみ小文字化）
 */
export function extractEmailAddress(rawAddress: string): string {
  if (!rawAddress) return '';
  let addr = rawAddress.trim();
  const match = addr.match(/<([^>]+)>/);
  if (match && match[1]) {
    addr = match[1].trim();
  }
  const atIdx = addr.lastIndexOf('@');
  if (atIdx === -1) {
    return addr;
  }
  const localPart = addr.slice(0, atIdx);
  const domainPart = addr.slice(atIdx + 1).toLowerCase();
  return `${localPart}@${domainPart}`;
}

/**
 * 送信元メールアドレスが許可されたGmailアドレスと一致するかを検証（大文字小文字を区別せず比較）
 */
export function isAllowedGmailSender(fromHeader: string, allowedGmailAddress: string): boolean {
  const extractedFrom = extractEmailAddress(fromHeader).toLowerCase();
  const normalizedAllowed = extractEmailAddress(allowedGmailAddress).toLowerCase();
  if (!extractedFrom || !normalizedAllowed) return false;
  return extractedFrom === normalizedAllowed;
}

/**
 * 指定されたドメインが許可ドメイン（gmail.com / google.com または許可アドレスのドメイン）と一致・サブドメイン一致するか判定
 */
function isTrustedSenderDomain(domain: string, expectedSenderDomain?: string): boolean {
  const clean = domain.trim().toLowerCase().replace(/^@/, '').replace(/[>;),\s]+$/, '');
  if (!clean) return false;

  const allowedDomains = new Set<string>(['gmail.com', 'google.com', 'googlemail.com']);
  if (expectedSenderDomain) {
    allowedDomains.add(expectedSenderDomain.toLowerCase());
  }

  for (const allowed of allowedDomains) {
    if (clean === allowed || clean.endsWith(`.${allowed}`)) {
      return true;
    }
  }
  return false;
}

/**
 * メールヘッダーから SPF / DKIM 認証結果を検証
 * Cloudflare Email Routing で付与される received-spf または authentication-results ヘッダーを検査し、
 * ドメインが記載されている場合は送信元ドメインとの整合性（Alignment）も検証する
 */
export function verifyEmailAuthentication(
  headers: Headers,
  expectedSenderAddress?: string
): {
  passed: boolean;
  reason?: string;
  spfResult?: string;
  authResults?: string;
} {
  const receivedSpf = (headers.get('received-spf') || '').toLowerCase();
  const authResults = (headers.get('authentication-results') || '').toLowerCase();

  // SPF または Authentication-Results の両方が完全に欠落している場合
  if (!receivedSpf && !authResults) {
    return {
      passed: false,
      reason: 'Missing both received-spf and authentication-results headers',
    };
  }

  const expectedDomain = expectedSenderAddress
    ? extractEmailAddress(expectedSenderAddress).split('@')[1]
    : undefined;

  // 1. received-spf の検証
  let spfPass = false;
  if (
    receivedSpf.startsWith('pass') ||
    receivedSpf.includes('spf=pass') ||
    /\bpass\b/.test(receivedSpf)
  ) {
    // "domain of xxx@domain.com" や "google.com" などの記載がある場合はドメイン整合性を確認
    const domainOfMatch = receivedSpf.match(/domain of\s+([^\s;)]+)/i);
    if (domainOfMatch && domainOfMatch[1]) {
      const spfEntity = domainOfMatch[1];
      const spfDomain = spfEntity.includes('@') ? spfEntity.split('@')[1] : spfEntity;
      spfPass = isTrustedSenderDomain(spfDomain, expectedDomain);
    } else {
      spfPass = true;
    }
  }

  // 2. authentication-results の検証（セクションごとに分割して spf=pass / dkim=pass のドメインを確認）
  let authSpfPass = false;
  let authDkimPass = false;

  if (authResults) {
    const clauses = authResults.split(';');
    for (const clause of clauses) {
      const trimmed = clause.trim();
      if (trimmed.includes('spf=pass')) {
        const mailfromMatch =
          trimmed.match(/smtp\.mailfrom=([^\s;)]+)/i) ||
          trimmed.match(/domain of\s+([^\s;)]+)/i);
        if (mailfromMatch && mailfromMatch[1]) {
          const entity = mailfromMatch[1];
          const domain = entity.includes('@') ? entity.split('@')[1] : entity;
          if (isTrustedSenderDomain(domain, expectedDomain)) {
            authSpfPass = true;
          }
        } else {
          authSpfPass = true;
        }
      }

      if (trimmed.includes('dkim=pass')) {
        const headerIMatch = trimmed.match(/header\.i=([^\s;)]+)/i);
        const headerDMatch = trimmed.match(/header\.d=([^\s;)]+)/i);
        const dkimEntity = headerIMatch?.[1] || headerDMatch?.[1];
        if (dkimEntity) {
          const domain = dkimEntity.includes('@') ? dkimEntity.split('@')[1] : dkimEntity;
          if (isTrustedSenderDomain(domain, expectedDomain)) {
            authDkimPass = true;
          }
        } else {
          authDkimPass = true;
        }
      }
    }
  }

  if (spfPass || authSpfPass || authDkimPass) {
    return {
      passed: true,
      spfResult: receivedSpf,
      authResults: authResults,
    };
  }

  return {
    passed: false,
    reason: `SPF/DKIM check failed: received-spf="${receivedSpf}", authentication-results="${authResults}"`,
    spfResult: receivedSpf,
    authResults: authResults,
  };
}
