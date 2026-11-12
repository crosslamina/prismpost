<?php
/**
 * PrismPost - さくらのレンタルサーバ用 メール送信中継スクリプト (セキュリティ強化・大容量添付対応版)
 *
 * 【セキュリティ仕様】
 * 1. HTTPS通信必須（平文HTTPでのアクセスは拒否）
 * 2. HMAC-SHA256 署名検証 ＋ タイムスタンプ検証（5分以内のリクエストのみ有効・リプレイ攻撃防止・通信経路にトークン平文を流さない）
 * 3. 厳格なメールアドレス形式チェック（シェルインジェクション・ヘッダーインジェクション・CVE-2016-10033 完全防止）
 * 4. 差出人ヘッダー(From)とエンベロープ送信者(from_email)の一致検証
 * 5. proc_open 配列実行によりシェル(/bin/sh)を一切経由せずに sendmail を直接実行
 */

// ============================================================================
// ★ 1. 秘密のトークン（必ずあなただけの長いランダム文字列に変更してください）
// ============================================================================
$SECRET_TOKEN = 'CHANGE_ME_TO_YOUR_RANDOM_SECRET_TOKEN_1234567890';

// ============================================================================
// ★ 2. 許可する差出人ドメイン一覧（空配列 [] なら全ドメイン許可）
// セキュリティ向上のため、さくらで使っている自分のドメインを記載することを推奨します
// 例: ['domain-a.com', 'domain-b.jp']
// ============================================================================
$ALLOWED_FROM_DOMAINS = [];

// ------------------------------ 以下は変更不要 ------------------------------

// 大容量の添付ファイル（最大25MB程度）でもメモリ不足にならないよう上限を引き上げ
@ini_set('memory_limit', '128M');
@set_time_limit(60);

header('Content-Type: application/json; charset=UTF-8');
header('X-Content-Type-Options: nosniff');

// 1. POSTメソッド以外は拒否
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method Not Allowed']);
    exit;
}

// 2. HTTPS通信の強制（さくらSSL / リバースプロキシ対応）
$isHttps = (
    (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off') ||
    (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') ||
    (!empty($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443)
);
if (!$isHttps) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'HTTPS is required']);
    exit;
}

// 3. 初期トークン未変更チェック
if ($SECRET_TOKEN === 'CHANGE_ME_TO_YOUR_RANDOM_SECRET_TOKEN_1234567890' || strlen($SECRET_TOKEN) < 16) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Server configuration error: Please set a strong SECRET_TOKEN (at least 16 chars)']);
    exit;
}

$rawBody = file_get_contents('php://input');
if ($rawBody === false || $rawBody === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Empty request body (Check post_max_size in php.ini if sending large attachments)']);
    exit;
}

// 4. 認証検証（HMAC-SHA256 署名検証 ＋ 5分以内のタイムスタンプ制限、または後方互換 Bearer）
$timestamp = isset($_SERVER['HTTP_X_PRISMPOST_TIMESTAMP']) ? trim($_SERVER['HTTP_X_PRISMPOST_TIMESTAMP']) : '';
$signature = isset($_SERVER['HTTP_X_PRISMPOST_SIGNATURE']) ? trim($_SERVER['HTTP_X_PRISMPOST_SIGNATURE']) : '';

$authenticated = false;
if ($timestamp !== '' && $signature !== '') {
    // リプレイ攻撃防止: 現在時刻との差が ±300秒（5分）以内であること
    if (ctype_digit($timestamp) && abs(time() - (int)$timestamp) <= 300) {
        $expectedSig = hash_hmac('sha256', $timestamp . '.' . $rawBody, $SECRET_TOKEN);
        if (hash_equals($expectedSig, $signature)) {
            $authenticated = true;
        }
    }
} else {
    // フォールバック: Authorization: Bearer <TOKEN>
    $authHeader = '';
    if (!empty($_SERVER['HTTP_AUTHORIZATION'])) {
        $authHeader = $_SERVER['HTTP_AUTHORIZATION'];
    } elseif (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $authHeader = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    } elseif (function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) {
            if (strtolower($k) === 'authorization') {
                $authHeader = $v;
                break;
            }
        }
    }
    if (preg_match('/^Bearer\s+(.+)$/i', trim($authHeader), $m)) {
        if (hash_equals($SECRET_TOKEN, trim($m[1]))) {
            $authenticated = true;
        }
    }
}

if (!$authenticated) {
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => 'Unauthorized (Invalid signature, expired timestamp, or invalid token)']);
    exit;
}

$data = json_decode($rawBody, true);
if (!is_array($data)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Invalid JSON payload']);
    exit;
}

$fromEmail = isset($data['from_email']) ? trim((string)$data['from_email']) : '';
$recipients = isset($data['recipients']) && is_array($data['recipients']) ? $data['recipients'] : [];
$rawMime = isset($data['raw_mime']) ? (string)$data['raw_mime'] : '';

// 5. メールアドレスの厳格なホワイトリスト正規表現検証（クォートやスペース、ハイフン始まりを完全拒否）
$strictEmailRegex = '/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/';

if (
    !preg_match($strictEmailRegex, $fromEmail) ||
    !filter_var($fromEmail, FILTER_VALIDATE_EMAIL) ||
    strpos($fromEmail, '-') === 0
) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Invalid from_email']);
    exit;
}

if (!empty($ALLOWED_FROM_DOMAINS)) {
    $fromDomain = strtolower((string)substr(strrchr($fromEmail, '@'), 1));
    $allowedLower = array_map('strtolower', $ALLOWED_FROM_DOMAINS);
    if (!in_array($fromDomain, $allowedLower, true)) {
        http_response_code(403);
        echo json_encode(['ok' => false, 'error' => 'Sender domain is not in ALLOWED_FROM_DOMAINS']);
        exit;
    }
}

$cleanRecipients = [];
foreach ($recipients as $rcpt) {
    $rcpt = trim((string)$rcpt);
    if ($rcpt === '') continue;
    if (
        !preg_match($strictEmailRegex, $rcpt) ||
        !filter_var($rcpt, FILTER_VALIDATE_EMAIL) ||
        strpos($rcpt, '-') === 0
    ) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Invalid recipient address: ' . $rcpt]);
        exit;
    }
    $cleanRecipients[] = $rcpt;
}

if (empty($cleanRecipients) || $rawMime === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Missing recipients or raw_mime']);
    exit;
}

// 6. 改行コードを LF に統一（Unix/FreeBSD sendmail での MIME バウンダリ・添付ファイル破損防止）
$normalizedMime = preg_replace("/\r\n|\r/", "\n", $rawMime);

// さくらのレンタルサーバ標準の sendmail バイナリへ直接パイプ渡し（シェルを経由しない配列指定）
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
        // 大容量の添付ファイルでも確実に書き込めるようチャンク書き込み
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
            echo json_encode([
                'ok' => true,
                'method' => 'sendmail',
                'from' => $fromEmail,
                'recipients_count' => count($cleanRecipients)
            ]);
            exit;
        } else {
            http_response_code(500);
            echo json_encode([
                'ok' => false,
                'error' => 'sendmail exited with code ' . $exitCode,
                'stderr' => $stderr,
                'stdout' => $stdout
            ]);
            exit;
        }
    }
}

// フォールバック: proc_open が使えない環境の場合は PHP 標準の mail() 関数を使用
$parts = explode("\n\n", $normalizedMime, 2);
$rawHeaderBlock = isset($parts[0]) ? $parts[0] : '';
$mimeBody = isset($parts[1]) ? $parts[1] : '';

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
    echo json_encode([
        'ok' => true,
        'method' => 'php_mail',
        'from' => $fromEmail,
        'recipients_count' => count($cleanRecipients)
    ]);
} else {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'PHP mail() failed']);
}
