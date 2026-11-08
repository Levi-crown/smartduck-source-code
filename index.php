<?php

declare(strict_types=1);

// Serve the login template at the site root so the browser stays on `/`.
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
header("Pragma: no-cache");
header("Expires: 0");
readfile(__DIR__ . DIRECTORY_SEPARATOR . "loginform.html");
