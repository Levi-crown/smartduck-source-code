<?php

declare(strict_types=1);

// Router for PHP's local development server. Production Apache uses .htaccess.
$documentRoot = realpath(__DIR__);
$requestPath = rawurldecode((string) (parse_url($_SERVER["REQUEST_URI"] ?? "/", PHP_URL_PATH) ?: "/"));
$requestPath = "/" . ltrim(str_replace("\\", "/", $requestPath), "/");
$remoteAddress = trim((string) ($_SERVER["REMOTE_ADDR"] ?? ""));
$isLoopbackRequest = in_array($remoteAddress, ["", "127.0.0.1", "::1"], true);

// Production (Vercel) exposes the API at the neutral "/api/data" path, plus the
// legacy action-shaped paths ("/api/sensor-readings", ...) and "/api/backend",
// all rewritten to backend.php in vercel.json. The dev server resolves the same
// paths so the frontend behaves identically here. "data" and "backend" are
// carriers, not actions: the action rides in the query string or the
// X-Smartduck-Action header, so they are excluded from the action-seeding
// below. The already-flashed ESP32 firmware builds "?action=" URLs against
// "/api/backend" at runtime and must keep working untouched.
$apiActionPath = null;
if (preg_match("#^/api/([a-z][a-z-]*)$#", $requestPath, $apiMatch) === 1
    && !in_array($apiMatch[1], ["backend", "data"], true)) {
    $apiActionPath = $apiMatch[1];
}
$isApiRequest = $apiActionPath !== null
    || strcasecmp($requestPath, "/api/data") === 0
    || strcasecmp($requestPath, "/api/backend") === 0
    || strcasecmp($requestPath, "/api/backend.php") === 0;

// The PHP port is also reachable from the LAN for the ESP32. Remote devices
// only need the API; never expose project files or local credentials there.
if (!$isLoopbackRequest && !$isApiRequest) {
    http_response_code(404);
    header("Content-Type: text/plain; charset=utf-8");
    echo "Not Found";
    return true;
}

if ($isApiRequest) {
    // For an action-shaped path, seed $_GET["action"] from the URL so the
    // dispatcher sees the same value the "?action=" form would have carried.
    // A query string still present (e.g. "?username=") is preserved; an action
    // already in the query is left alone so both forms behave identically.
    if ($apiActionPath !== null && ($_GET["action"] ?? "") === "") {
        $_GET["action"] = $apiActionPath;
        $_REQUEST["action"] = $apiActionPath;
    }
    $_SERVER["SCRIPT_NAME"] = "/api/backend.php";
    $_SERVER["PHP_SELF"] = "/api/backend.php";
    require __DIR__ . DIRECTORY_SEPARATOR . "api" . DIRECTORY_SEPARATOR . "backend.php";
    return true;
}

$requestedBasename = strtolower(basename($requestPath));
if (
    preg_match("#(?:^|/)\.#", $requestPath) === 1
    || in_array($requestedBasename, ["gmail.txt", "firebase-service-account.json", "secrets.h"], true)
) {
    http_response_code(404);
    header("Content-Type: text/plain; charset=utf-8");
    echo "Not Found";
    return true;
}

function local_redirect(string $path): never
{
    $query = trim((string) ($_SERVER["QUERY_STRING"] ?? ""));
    header("Location: " . $path . ($query !== "" ? "?" . $query : ""), true, 308);
    exit;
}

if ($requestPath === "/loginform.html" || $requestPath === "/index.html") {
    local_redirect("/");
}

if (preg_match("#^/(.*?/)?index\.html$#i", $requestPath, $matches) === 1) {
    local_redirect("/" . ($matches[1] ?? ""));
}

if (str_ends_with(strtolower($requestPath), ".html")) {
    local_redirect(substr($requestPath, 0, -5));
}

if ($requestPath === "/") {
    require __DIR__ . DIRECTORY_SEPARATOR . "index.php";
    return true;
}

$relativePath = ltrim($requestPath, "/");
$physicalPath = realpath(__DIR__ . DIRECTORY_SEPARATOR . str_replace("/", DIRECTORY_SEPARATOR, $relativePath));
$insideDocumentRoot = static fn (string $path): bool => $documentRoot !== false
    && ($path === $documentRoot || str_starts_with($path, $documentRoot . DIRECTORY_SEPARATOR));

// Let PHP's server handle existing assets and PHP endpoints normally.
if ($physicalPath !== false && $insideDocumentRoot($physicalPath)) {
    return false;
}

$htmlPath = realpath(__DIR__ . DIRECTORY_SEPARATOR . str_replace("/", DIRECTORY_SEPARATOR, rtrim($relativePath, "/")) . ".html");
if ($htmlPath !== false && $insideDocumentRoot($htmlPath) && is_file($htmlPath)) {
    header("Content-Type: text/html; charset=utf-8");
    header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
    header("Pragma: no-cache");
    header("Expires: 0");
    readfile($htmlPath);
    return true;
}

return false;
