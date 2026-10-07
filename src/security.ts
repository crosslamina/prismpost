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
  return extractedFrom === normalizedAllowed;
}

/**
 * メールヘッダーから SPF / DKIM 認証結果を検証
 * Cloudflare Email Routing で付与される received-spf または authentication-results ヘッダーを検査
 */
export function verifyEmailAuthentication(headers: Headers): {
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

  // 1. received-spf の検証: 'pass' から始まっているか、または 'pass (' などの成功文字列を含むか
  // 例: "pass (cloudflare.com: domain of user@gmail.com designates ...)"
  const spfPass =
    receivedSpf.startsWith('pass') ||
    receivedSpf.includes('spf=pass') ||
    /\bpass\b/.test(receivedSpf);

  // 2. authentication-results の検証: 'spf=pass' または 'dkim=pass' が含まれるか
  // 例: "mx.cloudflare.com; spf=pass ... dkim=pass ..."
  const authSpfPass = authResults.includes('spf=pass');
  const authDkimPass = authResults.includes('dkim=pass');

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
