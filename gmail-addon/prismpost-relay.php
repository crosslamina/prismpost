<?php
/**
 * PrismPost - レンタルサーバー / VPS 汎用 メール送信中継スクリプト
 * （秘密トークン不要・Google OIDC 電子署名認証 ＋ 大容量添付対応版）
 *
 * 【動作環境】
 * PHP 7.1+ が動作する一般的なレンタルサーバー / VPS / cPanel 等で利用可能
 * （さくらのレンタルサーバ / エックスサーバー / ConoHa WING / ロリポップ 等。
 *   proc_open + sendmail が無効な環境では PHP mail() へ自動フォールバックします）
 *
 * 【仕組みとセキュリティ仕様】
 * 1. このファイルは編集せずにそのまま HTTPS 公開フォルダへアップロードできます。
 * 2. HTTPS通信必須（平文HTTPでのアクセスは拒否）。
 * 3. Google Apps Script が発行する「Google公式電子署名（OIDC IDトークン）」を公開鍵暗号（RS256）で検証し、
 *    あなた本人の Google アカウントからの通信のみを許可します（秘密トークンの事前設定・共有は不要）。
 * 4. 初回接続（アドオンで設定保存）時に、Web非公開領域（~/.prismpost-owner-<PHPファイル名>.json, パーミッション0600）へ
 *    所有者（sub / email / aud / 許可ドメイン一覧）を自動記録してロックします（複数人分を別ファイル名で設置可能）。
 * 5. メール送信時は IDトークンを使った HMAC-SHA256 署名 ＋ 5分以内のタイムスタンプ検証により
 *    リプレイ攻撃・改ざんを防止します。
 * 6. 厳格なメールアドレス検証と proc_open 配列実行によりシェル(/bin/sh)を介さず sendmail を直接実行します。
 */

// ============================================================================
// ★ 任意設定（未変更のままで自動設定・自動ロックされます）
//   より厳格にコード上でも固定したい場合のみ記入してください
// ============================================================================
$ALLOWED_GMAIL_ADDRESS = ''; // 例: 'your-name@gmail.com'（空欄なら初回接続したGoogleアカウントを自動ロック）
$ALLOWED_FROM_DOMAINS = [];  // 例: ['domain-a.com', 'domain-b.jp']（空欄ならアドオン側の登録ドメインを自動同期）

// ------------------------------ 以下は変更不要 ------------------------------

@ini_set('memory_limit', '128M');
@set_time_limit(60);

header('Content-Type: application/json; charset=UTF-8');
header('X-Content-Type-Options: nosniff');

function respondJson(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function base64UrlDecode(string $data): ?string
{
    $remainder = strlen($data) % 4;
    if ($remainder > 0) {
        $data .= str_repeat('=', 4 - $remainder);
    }
    $decoded = base64_decode(strtr($data, '-_', '+/'), true);
    return $decoded === false ? null : $decoded;
}

function fetchUrlJson(string $url, int $timeout = 10): ?array
{
    $raw = null;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        $res = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if (is_string($res) && $code >= 200 && $code < 300) {
            $raw = $res;
        }
    }

    if ($raw === null && ini_get('allow_url_fopen')) {
        $ctx = stream_context_create([
            'http' => ['timeout' => $timeout],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $res = @file_get_contents($url, false, $ctx);
        if (is_string($res)) {
            $raw = $res;
        }
    }

    if ($raw === null) {
        return null;
    }
    $json = json_decode($raw, true);
    return is_array($json) ? $json : null;
}

function getGoogleCerts(bool $forceRefresh = false): ?array
{
    $cacheFile = rtrim(sys_get_temp_dir(), '/\\') . '/prismpost_google_certs.json';
    if (!$forceRefresh && is_readable($cacheFile)) {
        $mtime = @filemtime($cacheFile);
        if ($mtime !== false && (time() - $mtime) < 3600) {
            $cached = json_decode((string)@file_get_contents($cacheFile), true);
            if (is_array($cached) && !empty($cached)) {
                return $cached;
            }
        }
    }

    $certs = fetchUrlJson('https://www.googleapis.com/oauth2/v1/certs');
    if (is_array($certs) && !empty($certs)) {
        @file_put_contents($cacheFile, json_encode($certs), LOCK_EX);
        @chmod($cacheFile, 0600);
        return $certs;
    }

    return null;
}

function isValidGoogleClaims(array $claims): bool
{
    $iss = isset($claims['iss']) ? (string)$claims['iss'] : '';
    if ($iss !== 'https://accounts.google.com' && $iss !== 'accounts.google.com') {
        return false;
    }

    $now = time();
    if (!isset($claims['exp']) || !is_numeric($claims['exp']) || (int)$claims['exp'] <= ($now - 30)) {
        return false;
    }
    if (!isset($claims['iat']) || !is_numeric($claims['iat']) || (int)$claims['iat'] > ($now + 60)) {
        return false;
    }

    $emailVerified = $claims['email_verified'] ?? false;
    if ($emailVerified !== true && $emailVerified !== 'true') {
        return false;
    }

    if (empty($claims['sub']) || empty($claims['email']) || empty($claims['aud'])) {
        return false;
    }

    return true;
}

function verifyGoogleIdToken(string $idToken): ?array
{
    $parts = explode('.', $idToken);
    if (count($parts) !== 3) {
        return null;
    }

    [$headerB64, $payloadB64, $sigB64] = $parts;
    $headerJson = base64UrlDecode($headerB64);
    $payloadJson = base64UrlDecode($payloadB64);
    $signature = base64UrlDecode($sigB64);

    if ($headerJson === null || $payloadJson === null || $signature === null) {
        return null;
    }

    $header = json_decode($headerJson, true);
    $payload = json_decode($payloadJson, true);
    if (!is_array($header) || !is_array($payload)) {
        return null;
    }

    if (($header['alg'] ?? '') !== 'RS256') {
        return null;
    }
    if (!isValidGoogleClaims($payload)) {
        return null;
    }

    if (function_exists('openssl_verify') && function_exists('openssl_pkey_get_public')) {
        $kid = isset($header['kid']) ? (string)$header['kid'] : '';
        if ($kid === '') {
            return null;
        }

        $certs = getGoogleCerts(false);
        if (!is_array($certs) || !isset($certs[$kid])) {
            $certs = getGoogleCerts(true);
        }
        if (!is_array($certs) || !isset($certs[$kid]) || !is_string($certs[$kid])) {
            return null;
        }

        $pubKey = openssl_pkey_get_public($certs[$kid]);
        if ($pubKey === false) {
            return null;
        }

        $signingInput = $headerB64 . '.' . $payloadB64;
        $verified = openssl_verify($signingInput, $signature, $pubKey, OPENSSL_ALGO_SHA256) === 1;
        return $verified ? $payload : null;
    }

    // OpenSSL拡張がない環境向けフォールバック（Google公式トークン検証API）
    $tokenInfo = fetchUrlJson('https://oauth2.googleapis.com/tokeninfo?id_token=' . rawurlencode($idToken));
    if (!is_array($tokenInfo) || !isValidGoogleClaims($tokenInfo)) {
        return null;
    }

    return $tokenInfo;
}

function isOutsideDir(string $candidateDir, string $protectedDir): bool
{
    $candReal = realpath($candidateDir);
    $protReal = realpath($protectedDir);
    if ($candReal === false || $protReal === false) {
        return false;
    }
    $candBase = strtolower(basename($candReal));
    if ($candBase === '' || in_array($candBase, ['www', 'public_html', 'htdocs', 'web', 'html'], true)) {
        return false;
    }
    $candNorm = rtrim($candReal, '/\\') . DIRECTORY_SEPARATOR;
    $protNorm = rtrim($protReal, '/\\') . DIRECTORY_SEPARATOR;
    return strpos($candNorm, $protNorm) !== 0;
}

function getOwnerConfigPath(): string
{
    $rawSlug = basename(__FILE__, '.php');
    $scriptSlug = preg_replace('/[^A-Za-z0-9_-]/', '_', (string)$rawSlug);
    if ($scriptSlug === null || $scriptSlug === '') {
        $scriptSlug = 'default';
    }

    $candidates = [];
    if (!empty($_SERVER['HOME'])) {
        $candidates[] = (string)$_SERVER['HOME'];
    }
    $envHome = getenv('HOME');
    if (is_string($envHome) && $envHome !== '') {
        $candidates[] = $envHome;
    }
    if (function_exists('posix_getpwuid') && function_exists('posix_geteuid')) {
        $pw = @posix_getpwuid(@posix_geteuid());
        if (is_array($pw) && !empty($pw['dir'])) {
            $candidates[] = (string)$pw['dir'];
        }
    }
    if (!empty($_SERVER['DOCUMENT_ROOT'])) {
        $parentDocRoot = dirname((string)$_SERVER['DOCUMENT_ROOT']);
        $candidates[] = $parentDocRoot;
    }

    $docRoot = !empty($_SERVER['DOCUMENT_ROOT']) ? (string)$_SERVER['DOCUMENT_ROOT'] : __DIR__;
    foreach ($candidates as $dir) {
        if ($dir !== '' && is_dir($dir) && is_writable($dir) && isOutsideDir($dir, $docRoot) && isOutsideDir($dir, __DIR__)) {
            return rtrim($dir, '/\\') . '/.prismpost-owner-' . $scriptSlug . '.json';
        }
    }

    // ApacheでHTTPアクセスが標準ブロックされる .ht* ファイル名へフォールバック
    return __DIR__ . '/.ht_prismpost_owner_' . $scriptSlug . '.json';
}

function extractBearerToken(): string
{
    $authHeader = '';
    if (!empty($_SERVER['HTTP_AUTHORIZATION'])) {
        $authHeader = (string)$_SERVER['HTTP_AUTHORIZATION'];
    } elseif (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $authHeader = (string)$_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    } elseif (function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) {
            if (strtolower((string)$k) === 'authorization') {
                $authHeader = (string)$v;
                break;
            }
        }
    }

    if (preg_match('/^Bearer\s+(.+)$/i', trim($authHeader), $m)) {
        return trim($m[1]);
    }

    // Apache等のCGI環境で Authorization ヘッダーが除外された場合用のフォールバック
    if (!empty($_SERVER['HTTP_X_PRISMPOST_ID_TOKEN'])) {
        return trim((string)$_SERVER['HTTP_X_PRISMPOST_ID_TOKEN']);
    }

    return '';
}

function normalizeDomainsList($domains): array
{
    if (!is_array($domains)) {
        return [];
    }
    $clean = [];
    foreach ($domains as $d) {
        $d = strtolower(trim((string)$d));
        if ($d !== '' && preg_match('/^[a-z0-9.-]+\.[a-z]{2,}$/', $d)) {
            $clean[$d] = true;
        }
    }
    return array_keys($clean);
}

// 1. POSTメソッド以外は拒否
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respondJson(405, ['ok' => false, 'error' => 'Method Not Allowed']);
}

// 2. HTTPS通信の強制（レンタルサーバーSSL / リバースプロキシ対応）
$isHttps = (
    (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') ||
    (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower((string)$_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') ||
    (!empty($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443)
);
if (!$isHttps) {
    respondJson(403, ['ok' => false, 'error' => 'HTTPS is required']);
}

$rawBody = file_get_contents('php://input');
if ($rawBody === false || $rawBody === '') {
    respondJson(400, ['ok' => false, 'error' => 'Empty request body (Check post_max_size in php.ini if sending large attachments)']);
}

// 3. Google OIDC IDトークン署名検証
$idToken = extractBearerToken();
if ($idToken === '') {
    respondJson(401, ['ok' => false, 'error' => 'Unauthorized (Missing Google OIDC Bearer token)']);
}

$claims = verifyGoogleIdToken($idToken);
if ($claims === null) {
    respondJson(401, ['ok' => false, 'error' => 'Unauthorized (Invalid or expired Google OIDC signature)']);
}

$callerSub = (string)$claims['sub'];
$callerEmail = strtolower(trim((string)$claims['email']));
$callerAud = (string)$claims['aud'];

if ($ALLOWED_GMAIL_ADDRESS !== '' && $callerEmail !== strtolower(trim($ALLOWED_GMAIL_ADDRESS))) {
    respondJson(403, ['ok' => false, 'error' => 'Forbidden (Google account is not in ALLOWED_GMAIL_ADDRESS)']);
}

// 4. 所有者ロック設定ファイル (.prismpost-owner-<PHPファイル名>.json) の読み込みと検証
$ownerPath = getOwnerConfigPath();
$existingOwner = null;
if (is_file($ownerPath)) {
    $ownerRaw = @file_get_contents($ownerPath);
    $decodedOwner = is_string($ownerRaw) ? json_decode($ownerRaw, true) : null;
    if (!is_array($decodedOwner) || empty($decodedOwner['sub']) || empty($decodedOwner['email'])) {
        respondJson(500, ['ok' => false, 'error' => 'Server configuration error: corrupted owner lock file']);
    }
    $existingOwner = $decodedOwner;

    $subMatch = hash_equals((string)$existingOwner['sub'], $callerSub);
    $emailMatch = strtolower(trim((string)$existingOwner['email'])) === $callerEmail;
    $audMatch = empty($existingOwner['aud']) || hash_equals((string)$existingOwner['aud'], $callerAud);

    if (!$subMatch || !$emailMatch || !$audMatch) {
        respondJson(403, ['ok' => false, 'error' => 'Forbidden (This endpoint is locked to another Google account or Apps Script project)']);
    }
}

$data = json_decode($rawBody, true);
if (!is_array($data)) {
    respondJson(400, ['ok' => false, 'error' => 'Invalid JSON payload']);
}

$action = isset($data['action']) ? (string)$data['action'] : 'send';

// 5A. ペアリング・設定同期アクション（アドオンで「設定を保存」したときに呼ばれる）
if ($action === 'pair') {
    $incomingDomains = normalizeDomainsList($data['allowed_domains'] ?? []);
    $now = time();
    $ownerRecord = [
        'sub' => $callerSub,
        'email' => $callerEmail,
        'aud' => $callerAud,
        'allowed_domains' => $incomingDomains,
        'paired_at' => $existingOwner['paired_at'] ?? $now,
        'updated_at' => $now,
    ];

    $written = @file_put_contents($ownerPath, json_encode($ownerRecord, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
    if ($written === false) {
        respondJson(500, ['ok' => false, 'error' => 'Failed to write owner lock file']);
    }
    @chmod($ownerPath, 0600);

    respondJson(200, [
        'ok' => true,
        'owner_email' => $callerEmail,
        'allowed_domains' => $incomingDomains,
    ]);
}

// 5B. メール送信アクション：HMAC-SHA256 署名 ＋ 5分以内のタイムスタンプ検証
$timestamp = isset($_SERVER['HTTP_X_PRISMPOST_TIMESTAMP']) ? trim((string)$_SERVER['HTTP_X_PRISMPOST_TIMESTAMP']) : '';
$signature = isset($_SERVER['HTTP_X_PRISMPOST_SIGNATURE']) ? trim((string)$_SERVER['HTTP_X_PRISMPOST_SIGNATURE']) : '';

if ($timestamp === '' || $signature === '' || !ctype_digit($timestamp) || abs(time() - (int)$timestamp) > 300) {
    respondJson(401, ['ok' => false, 'error' => 'Unauthorized (Missing or expired X-PrismPost-Timestamp)']);
}

$expectedSig = hash_hmac('sha256', $timestamp . '.' . $rawBody, $idToken);
if (!hash_equals($expectedSig, $signature)) {
    respondJson(401, ['ok' => false, 'error' => 'Unauthorized (Invalid X-PrismPost-Signature)']);
}

// 初回接続が send リクエストだった場合も所有者ロックファイルを作成
if ($existingOwner === null) {
    $now = time();
    $initialDomains = !empty($ALLOWED_FROM_DOMAINS) ? normalizeDomainsList($ALLOWED_FROM_DOMAINS) : [];
    $existingOwner = [
        'sub' => $callerSub,
        'email' => $callerEmail,
        'aud' => $callerAud,
        'allowed_domains' => $initialDomains,
        'paired_at' => $now,
        'updated_at' => $now,
    ];
    @file_put_contents($ownerPath, json_encode($existingOwner, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
    @chmod($ownerPath, 0600);
}

$fromEmail = isset($data['from_email']) ? trim((string)$data['from_email']) : '';
$recipients = isset($data['recipients']) && is_array($data['recipients']) ? $data['recipients'] : [];
$rawMime = isset($data['raw_mime']) ? (string)$data['raw_mime'] : '';

// 6. メールアドレスの厳格なホワイトリスト正規表現検証（クォートやスペース、ハイフン始まりを完全拒否）
$strictEmailRegex = '/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/';

if (
    !preg_match($strictEmailRegex, $fromEmail) ||
    !filter_var($fromEmail, FILTER_VALIDATE_EMAIL) ||
    strpos($fromEmail, '-') === 0
) {
    respondJson(400, ['ok' => false, 'error' => 'Invalid from_email']);
}

$effectiveAllowedDomains = !empty($ALLOWED_FROM_DOMAINS)
    ? normalizeDomainsList($ALLOWED_FROM_DOMAINS)
    : normalizeDomainsList($existingOwner['allowed_domains'] ?? []);

if (!empty($effectiveAllowedDomains)) {
    $fromDomain = strtolower((string)substr(strrchr($fromEmail, '@'), 1));
    if (!in_array($fromDomain, $effectiveAllowedDomains, true)) {
        respondJson(403, ['ok' => false, 'error' => 'Sender domain (' . $fromDomain . ') is not in allowed domains']);
    }
}

$cleanRecipients = [];
foreach ($recipients as $rcpt) {
    $rcpt = trim((string)$rcpt);
    if ($rcpt === '') {
        continue;
    }
    if (
        !preg_match($strictEmailRegex, $rcpt) ||
        !filter_var($rcpt, FILTER_VALIDATE_EMAIL) ||
        strpos($rcpt, '-') === 0
    ) {
        respondJson(400, ['ok' => false, 'error' => 'Invalid recipient address: ' . $rcpt]);
    }
    $cleanRecipients[] = $rcpt;
}

if (empty($cleanRecipients) || $rawMime === '') {
    respondJson(400, ['ok' => false, 'error' => 'Missing recipients or raw_mime']);
}

// 7. 改行コードを LF に統一（Unix/FreeBSD sendmail での MIME バウンダリ・添付ファイル破損防止）
$normalizedMime = preg_replace("/\r\n|\r/", "\n", $rawMime);

// サーバー標準の sendmail バイナリへ直接パイプ渡し（シェルを経由しない配列指定）
$sendmailPath = '/usr/sbin/sendmail';
if (!is_executable($sendmailPath)) {
    $sendmailPath = '/usr/lib/sendmail';
}

if (function_exists('proc_open') && is_executable($sendmailPath)) {
    $cmd = array_merge([$sendmailPath, '-i', '-f', $fromEmail, '--'], $cleanRecipients);
    $descriptors = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];

    $process = proc_open($cmd, $descriptors, $pipes);
    if (is_resource($process)) {
        $totalLen = strlen($normalizedMime);
        $written = 0;
        while ($written < $totalLen) {
            $chunk = substr($normalizedMime, $written, 65536);
            $bytes = fwrite($pipes[0], $chunk);
            if ($bytes === false || $bytes === 0) {
                break;
            }
            $written += $bytes;
        }
        fclose($pipes[0]);

        $stdout = stream_get_contents($pipes[1]);
        fclose($pipes[1]);

        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[2]);

        $exitCode = proc_close($process);
        if ($exitCode === 0) {
            respondJson(200, [
                'ok' => true,
                'method' => 'sendmail',
                'from' => $fromEmail,
                'recipients_count' => count($cleanRecipients),
            ]);
        } else {
            respondJson(500, [
                'ok' => false,
                'error' => 'sendmail exited with code ' . $exitCode,
                'stderr' => $stderr,
                'stdout' => $stdout,
            ]);
        }
    }
}

// フォールバック: proc_open が使えない環境の場合は PHP 標準の mail() 関数を使用
$parts = explode("\n\n", $normalizedMime, 2);
$rawHeaderBlock = $parts[0] ?? '';
$mimeBody = $parts[1] ?? '';

$headerLines = explode("\n", $rawHeaderBlock);
$filteredHeaders = [];
$subjectHeader = '';
$currentHeaderName = '';
$skipCurrentFolded = false;

foreach ($headerLines as $line) {
    if (preg_match('/^[ \t]/', $line)) {
        if ($skipCurrentFolded) {
            if ($currentHeaderName === 'subject') {
                $subjectHeader .= "\r\n" . $line;
            }
            continue;
        }
        $filteredHeaders[] = $line;
        continue;
    }
    if (preg_match('/^([A-Za-z0-9-]+):\s*(.*)$/', $line, $m)) {
        $currentHeaderName = strtolower($m[1]);
        if ($currentHeaderName === 'to') {
            $skipCurrentFolded = true;
            continue;
        }
        if ($currentHeaderName === 'subject') {
            $skipCurrentFolded = true;
            $subjectHeader = $m[2];
            continue;
        }
    }
    $skipCurrentFolded = false;
    $filteredHeaders[] = $line;
}

$additionalHeaders = implode("\r\n", $filteredHeaders);
$toParam = implode(', ', $cleanRecipients);
$ok = mail($toParam, $subjectHeader, $mimeBody, $additionalHeaders, '-f' . $fromEmail);

if ($ok) {
    respondJson(200, [
        'ok' => true,
        'method' => 'php_mail',
        'from' => $fromEmail,
        'recipients_count' => count($cleanRecipients),
    ]);
} else {
    respondJson(500, ['ok' => false, 'error' => 'PHP mail() failed']);
}
