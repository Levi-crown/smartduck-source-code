const SVG_NS = "http://www.w3.org/2000/svg";

// ============================================================
// AUTHENTICATION SYSTEM
// ============================================================

const AUTH_KEY = "smartduck_authenticated";
const USER_KEY = "smartduck_user";
const USERNAME_KEY = "smartduck_username";
const ROLE_KEY = "smartduck_role";
const DISPLAY_ROLE_KEY = "smartduck_display_role";
const SESSION_ID_KEY = "smartduck_session_id";
const SESSION_NOTICE_KEY = "smartduck_session_notice";
const ACCOUNTS_KEY = "smartduck_accounts";
const ACCOUNTS_VERSION_KEY = "smartduck_accounts_version";
const ACCOUNTS_VERSION = "2026-05-13-live-accounts";
const USER_BATCHES_KEY = "smartduck_user_batches";
const USER_BATCH_DELETED_KEY = "smartduck_user_deleted_batches";
const BATCH_SYNC_STORAGE_KEY = "smartduck_batch_sync";
// Background poll cadences.
//
// ETags save response bytes, but each poll still authenticates and reads
// Firebase, and the project runs on the Spark plan: 10 GB downloaded a month,
// with every backend-to-Firebase request paying a TLS handshake. So one poll
// does the live work: component-status, every few seconds on every signed-in
// page, carries the components, the newest sensor sample, and change markers
// for the sensor history, batches and notifications. Those lists are fetched
// only when their marker moves; their own timers below are slow fallbacks.
// On pages that show live data, or with the controls open, the poll asks the
// backend to keep the ESP32 polling fast too (watch=1), so a press reaches the
// hardware and shows here within about 4-5 seconds. Elsewhere it polls slowly
// and without watch=1, letting the device fall back to its idle pace. Every
// request is a Vercel function invocation against the monthly allowance as
// well as a Firebase read, so neither pace is faster than it needs to be.
const COMPONENT_STATUS_POLL_INTERVAL_MS = 4000;
const COMPONENT_STATUS_IDLE_POLL_INTERVAL_MS = 15000;
// While a press waits for the ESP32 to confirm it, the status is checked this
// often instead of waiting for the next background poll.
const COMMAND_CONFIRMATION_POLL_INTERVAL_MS = 1000;
// The batch list and sensor history keep their old cadence only against a
// backend that sends no change markers. Once the markers arrive, those timers
// fetch at most once per fallback interval, in case a marker is missed.
// The automation-override confirmation refreshes the batch list itself before
// it decides, so the batch sync never has to be fast for it.
const BATCH_SYNC_INTERVAL_MS = 5000;
const SENSOR_READINGS_POLL_INTERVAL_MS = 10000;
const CHANGE_MARKER_FALLBACK_MS = 60000;
const NOTIFICATION_POLL_INTERVAL_MS = 120000;
const INCUBATOR_EGG_CAPACITY = 60;
const IS_ROLE_SUBPATH = /\/(admin|user)\//i.test(window.location.pathname.replace(/\\/g, "/"));
const IS_LOCAL_PREVIEW = window.location.protocol === "file:" || ["127.0.0.1", "localhost"].includes(window.location.hostname);
// The dashboard reaches the API at "/api/backend" -- the one path the live
// Vercel deploy reliably resolves (a registered function; the /api/data
// function and the /api/* rewrites did not resolve on the live deploy, which
// broke sign-in, so this is the safe, proven path). The action name is still
// hidden: backendFetch() sends it in the X-Smartduck-Action header, so each
// call shows only "backend" with no ?action= naming the operation.
// Extensionless (no ".php") avoids the cleanUrls 308. The ESP32 firmware uses
// this same path.
const SAME_ORIGIN_BACKEND_ENDPOINT = new URL(IS_ROLE_SUBPATH ? "../api/backend" : "./api/backend", window.location.href).toString();
const IS_LOCAL_PHP_SERVER = ["", "8000", "8001"].includes(window.location.port);
const LOCAL_BACKEND_ENDPOINT = window.location.protocol === "file:"
  ? "https://127.0.0.1:8000/api/backend"
  : IS_LOCAL_PHP_SERVER
    ? SAME_ORIGIN_BACKEND_ENDPOINT
    : `https://${window.location.hostname}:8000/api/backend`;
// Local/file/Live Server previews use the local PHP backend. Other deployments
// use their same-origin PHP backend.
const BACKEND_ENDPOINT = IS_LOCAL_PREVIEW ? LOCAL_BACKEND_ENDPOINT : SAME_ORIGIN_BACKEND_ENDPOINT;
// Reach the backend with the "?action=<name>" form. Clean action-shaped paths
// (/api/login, /api/sensor-readings) were attempted, but the rewrite that maps
// them back to backend.php did not resolve on the live Vercel deploy, so every
// clean path 404'd and sign-in failed. Until that rewrite is confirmed working
// on the hosting side, keep addressing the backend the way it actually answers
// (backend.php?action=...), which the network probe returns 200 for. The ESP32
// firmware already uses this same form.
const apiUrl = (action) => `${BACKEND_ENDPOINT}?action=${action}`;
const localApiUrl = (action) => `${LOCAL_BACKEND_ENDPOINT}?action=${action}`;
// The dashboard's own requests are relabelled so the network panel shows one
// neutral "data" entry per call instead of naming the operation in the URL.
// backendFetch() lifts the "action" out of the query string, sends it in the
// X-Smartduck-Action header instead, and points the request at BACKEND_ENDPOINT
// with the remaining query params preserved. Purely cosmetic: the backend reads
// the same action, and every auth check is unchanged. The ESP32 firmware keeps
// using the ?action= form, which the backend still accepts.
function backendFetch(url, options = {}) {
  let action = "";
  let rewritten = url;
  try {
    const parsed = new URL(url, window.location.href);
    action = parsed.searchParams.get("action") || "";
    if (action) {
      parsed.searchParams.delete("action");
      // Keep any surviving params (username, hours, cache-buster) on the
      // neutral endpoint; the network panel still shows only "backend".
      const base = new URL(BACKEND_ENDPOINT, window.location.href);
      for (const [key, value] of parsed.searchParams.entries()) {
        base.searchParams.append(key, value);
      }
      rewritten = base.toString();
    }
  } catch (error) {
    // A non-parseable URL (should not happen for API calls) falls through to a
    // plain fetch so nothing silently breaks.
    return fetch(url, options);
  }
  if (!action) return fetch(url, options);
  const headers = { ...(options.headers || {}), "X-Smartduck-Action": action };
  const sessionId = sessionStorage.getItem(SESSION_ID_KEY);
  if (sessionId && action !== "login") headers["X-Smartduck-Session"] = sessionId;
  return fetch(rewritten, { ...options, headers });
}
const LOGIN_ENDPOINT = apiUrl("login");
const LOGOUT_ENDPOINT = apiUrl("logout");
const SESSION_ENDPOINT = apiUrl("session");
const ACCOUNTS_ENDPOINT = apiUrl("accounts");
const CREATE_ACCOUNT_ENDPOINT = apiUrl("create-account");
const UPDATE_ACCOUNT_ENDPOINT = apiUrl("update-account");
const DELETE_ACCOUNT_ENDPOINT = apiUrl("delete-account");
const UPDATE_PASSWORD_ENDPOINT = apiUrl("update-password");
const OTP_SEND_ENDPOINT = apiUrl("send-otp");
const OTP_VERIFY_ENDPOINT = apiUrl("verify-otp");
const LOCAL_OTP_SEND_ENDPOINT = localApiUrl("send-otp");
const LOCAL_OTP_VERIFY_ENDPOINT = localApiUrl("verify-otp");
const SETTINGS_ENDPOINT = apiUrl("settings");
const COMPONENT_COMMAND_ENDPOINT = apiUrl("component-command");
const COMPONENT_STATUS_ENDPOINT = apiUrl("component-status");
const COMPONENT_STATUS_WATCH_ENDPOINT = `${COMPONENT_STATUS_ENDPOINT}&watch=1`;
const BATCHES_ENDPOINT = apiUrl("batches");
const BATCH_ENDPOINT = apiUrl("batch");
const DELETE_BATCH_ENDPOINT = apiUrl("delete-batch");
const COMPLETE_SCHEDULE_ENDPOINT = apiUrl("complete-schedule");
const NOTIFICATIONS_ENDPOINT = apiUrl("notifications");
const NOTIFICATION_READ_ENDPOINT = apiUrl("notification-read");
const NOTIFICATION_ENDPOINT = apiUrl("notification");
const DELETE_NOTIFICATIONS_ENDPOINT = apiUrl("delete-notifications");
const REPORTS_ENDPOINT = apiUrl("reports");
const ACTIVITY_ENDPOINT = apiUrl("activity");
const HISTORY_ENDPOINT = apiUrl("history");
const DELETE_HISTORY_ENDPOINT = apiUrl("delete-history");
const SENSOR_READINGS_ENDPOINT = apiUrl("sensor-readings");
const SENSOR_HISTORY_CACHE_KEY = "smartduck_sensor_history_v1";
const SENSOR_HISTORY_HOURS = 168;
const SENSOR_HISTORY_LIMIT = 500;
const SENSOR_LIVE_FRESHNESS_MS = 10 * 1000;
const OTP_PURPOSE_ACCOUNT_VERIFICATION = "account-verification";
const OTP_PURPOSE_PASSWORD_RESET = "password-reset";
const OTP_REQUEST_TIMEOUT_MS = 10000;
const otpEndpointByRequest = new Map();
const accountState = {
  cache: [],
  readyPromise: null,
};

function cloneAccounts(accounts) {
  return accounts.map((account) => ({ ...account }));
}

function writeLocalAccounts(accounts) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  localStorage.setItem(ACCOUNTS_VERSION_KEY, ACCOUNTS_VERSION);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeAccounts(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter(Boolean).map((account) => ({ ...account }));
  }
  return Object.values(value).filter(Boolean).map((account) => ({ ...account }));
}

let expiredSessionHandled = false;
let backendSessionCheckPromise = null;
const SESSION_CONFIRMATION_RETRY_DELAYS_MS = [0, 150, 350];

// Called when the backend rejects a request as unauthenticated. The dashboards
// are already rendered at that point, so the only safe move is to drop the
// cached identity and return to the login screen.
function handleExpiredSession(reason = "session_expired") {
  if (expiredSessionHandled) return;
  if (!getPathRole()) return; // Already on the login screen.
  expiredSessionHandled = true;
  if (reason === "session_replaced") sessionStorage.setItem(SESSION_NOTICE_KEY, "session_replaced");
  clearAuthenticationSession();
  redirectToLogin({ replaceHistory: true });
}

// A single API request can fail independently (for example, while a serverless
// instance is warming up). Verify the authoritative session endpoint before
// clearing browser state so a component error cannot eject a signed-in user.
async function checkBackendSessionAuthentication() {
  if (backendSessionCheckPromise) return backendSessionCheckPromise;

  backendSessionCheckPromise = (async () => {
    let explicitSignedOutResponses = 0;

    for (const delayMs of SESSION_CONFIRMATION_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        const payload = await requestBackendJson(`${SESSION_ENDPOINT}&_=${Date.now()}`, {
          allowUnauthenticated: true,
          timeoutMs: 8000,
        });
        if (payload.authenticated === true) return true;
        if (payload.reason === "session_replaced") {
          handleExpiredSession("session_replaced");
          return false;
        }
        if (payload.authenticated === false) explicitSignedOutResponses += 1;
      } catch {
        // A network failure is not proof that the user signed out. Keep trying
        // so a momentary serverless/database race cannot clear a valid login.
      }
    }

    return explicitSignedOutResponses === SESSION_CONFIRMATION_RETRY_DELAYS_MS.length
      ? false
      : null;
  })().finally(() => {
    backendSessionCheckPromise = null;
  });

  return backendSessionCheckPromise;
}

async function requestBackendJson(url, options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 20000);
  try {
    return await requestBackendJsonAttempt(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error("The server is taking too long to respond. Please check your connection and try again.");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function requestBackendJsonAttempt(url, options = {}) {
  const response = await backendFetch(url, {
    method: options.method || "GET",
    cache: "no-store",
    // The backend identifies the caller by session cookie, so it has to travel.
    // "include" rather than "same-origin" because a Live Server preview runs on
    // its own port and reaches the PHP backend on 8000 — a different origin, but
    // still the same site, so the SameSite=Lax cookie is sent and the backend
    // only reflects CORS credentials back to origins it allows.
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  const payload = await response.json().catch((error) => {
    if (options.signal?.aborted) throw error;
    return {};
  });
  if (!response.ok) {
    if (response.status === 401 && payload.reason === "session_replaced" && !options.allowUnauthenticated) {
      handleExpiredSession("session_replaced");
    }
    const isMissingSessionResponse = response.status === 401
      && payload.message === "Sign in to continue.";
    if (isMissingSessionResponse && payload.reason !== "session_replaced" && !options.allowUnauthenticated) {
      const sessionAuthenticated = await checkBackendSessionAuthentication();
      if (sessionAuthenticated === false) {
        handleExpiredSession();
      } else if (
        sessionAuthenticated === true
        && !options.sessionRecoveryAttempted
        && (options.method || "GET").toUpperCase() === "GET"
      ) {
        // The rejected request landed on a transiently stale instance while the
        // session endpoint accepted the same cookie. Retry the action once.
        return requestBackendJson(url, { ...options, sessionRecoveryAttempted: true });
      }
    }
    const error = new Error(payload.message || "Backend request failed.");
    error.status = response.status;
    error.reason = payload.reason || "";
    if (Number.isFinite(Number(payload.retryAfterSeconds))) {
      error.retryAfterSeconds = Math.max(0, Number(payload.retryAfterSeconds));
    }
    if (Number.isFinite(Number(payload.remainingAttempts))) {
      error.remainingAttempts = Math.max(0, Number(payload.remainingAttempts));
    }
    throw error;
  }

  return payload;
}

// Conditional polling for the live screens.
//
// The live screens poll these endpoints every few seconds. Sending the whole
// body back on every one of those polls is what once ran the old database's
// egress quota down while almost no data was being produced. The server tags
// each response with an ETag; when the answer has
// not changed it replies 304 with no body and this returns the previous
// payload, so callers are unaffected and the screen still updates the instant
// something actually changes.
//
// The cache is keyed per URL and holds only the last response, so a stale
// entry cannot outlive the next change.
const conditionalResponseCache = new Map();

async function requestBackendJsonConditional(url, cacheKey = url, signal) {
  const cached = conditionalResponseCache.get(cacheKey);
  const response = await backendFetch(url, {
    method: "GET",
    signal,
    // "no-store" would stop the browser sending If-None-Match at all, and
    // "default" would let it answer from its own cache without asking. This
    // always reaches the server and always revalidates.
    cache: "no-cache",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
    },
  });

  if (response.status === 304 && cached) {
    return cached.payload;
  }

  if (!response.ok) {
    // Errors (and a 304 arriving with nothing cached) go through the shared
    // helper, which owns session-expiry handling and the one-shot retry.
    // Nothing has been read off this response body, so re-requesting is safe.
    conditionalResponseCache.delete(cacheKey);
    return requestBackendJson(url, { signal });
  }

  const payload = await response.json();
  // A response without an ETag simply is not cacheable — use it as-is rather
  // than issuing a second request for the same data.
  const etag = response.headers.get("ETag");
  if (etag) {
    conditionalResponseCache.set(cacheKey, { etag, payload });
  } else {
    conditionalResponseCache.delete(cacheKey);
  }
  return payload;
}

async function loadAccountsFromBackend() {
  const payload = await requestBackendJson(ACCOUNTS_ENDPOINT);
  return normalizeAccounts(payload.accounts);
}

async function getAccounts(forceRefresh = false) {
  if (!forceRefresh && accountState.cache.length > 0) {
    return cloneAccounts(accountState.cache);
  }

  if (!forceRefresh && accountState.readyPromise) {
    await accountState.readyPromise;
    return cloneAccounts(accountState.cache);
  }

  accountState.readyPromise = (async () => {
    try {
      const remoteAccounts = await loadAccountsFromBackend();
      accountState.cache = cloneAccounts(remoteAccounts);
      writeLocalAccounts(accountState.cache);
    } finally {
      // Clearing this only on success parked a rejected promise here, and every
      // later getAccounts() call re-threw that same stale failure.
      accountState.readyPromise = null;
    }
  })();

  await accountState.readyPromise;
  return cloneAccounts(accountState.cache);
}

function setAccountsCache(accounts) {
  accountState.cache = cloneAccounts(accounts);
  writeLocalAccounts(accountState.cache);
  return cloneAccounts(accountState.cache);
}

async function findAccountByUsername(username) {
  return (await getAccounts()).find(
    (account) => account.username.toLowerCase() === username.trim().toLowerCase(),
  ) || null;
}

async function findAccountByEmail(email) {
  return (await getAccounts()).find(
    (account) => account.email.toLowerCase() === email.trim().toLowerCase(),
  ) || null;
}

async function updateAccountPassword(username, nextPassword, currentPassword = "") {
  const payload = await requestBackendJson(UPDATE_PASSWORD_ENDPOINT, {
    method: "POST",
    body: {
      username,
      password: nextPassword,
      ...(currentPassword ? { currentPassword } : {}),
    },
  });
  // The new password is already saved by the time we get here, so refreshing the
  // roster is only a cache concern and must never turn a completed change into a
  // failure. The forgot-password flow runs signed out, where the accounts
  // endpoint answers 401 "Sign in to continue." -- that error used to surface as
  // "Password update failed" even though the password had been changed.
  await getAccounts(true).catch(() => {});
  return payload.account ? { ...payload.account } : null;
}

async function updateAccountRecord(username, nextFields) {
  const payload = await requestBackendJson(UPDATE_ACCOUNT_ENDPOINT, {
    method: "POST",
    body: {
      username,
      actingUsername: getAuthenticatedUsername(),
      fields: nextFields,
    },
  });
  await getAccounts(true);
  return payload.account ? { ...payload.account } : null;
}

async function removeAccountByUsername(username) {
  await requestBackendJson(DELETE_ACCOUNT_ENDPOINT, {
    method: "POST",
    body: {
      username,
      actingUsername: getAuthenticatedUsername(),
    },
  });
  await getAccounts(true);
  return true;
}

async function createAccount(account) {
  const payload = await requestBackendJson(CREATE_ACCOUNT_ENDPOINT, {
    method: "POST",
    body: {
      ...account,
      actingUsername: getAuthenticatedUsername(),
    },
  });
  await getAccounts(true);
  return payload.account ? { ...payload.account } : null;
}

function isAuthenticated() {
  return sessionStorage.getItem(AUTH_KEY) === "true";
}

function normalizeRole(role) {
  const normalized = String(role || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (normalized === "user") return "user";
  return "admin";
}

function getPathRole() {
  const pathname = window.location.pathname.replace(/\\/g, "/").toLowerCase();
  if (pathname.includes("/user/")) return "user";
  if (pathname.includes("/admin/")) return "admin";
  return null;
}

function getAccountShellRole(account) {
  const displayRole = String(account?.accountRole || "").trim().toLowerCase();
  if (displayRole === "operator") return "user";
  return normalizeRole(account?.role || "admin");
}

function getAuthenticatedRole() {
  const storedRole = normalizeRole(sessionStorage.getItem(ROLE_KEY) || "");
  const pathRole = getPathRole();

  return normalizeRole(storedRole || pathRole || "admin");
}

function getRoleLabel(role = getAuthenticatedRole()) {
  return sessionStorage.getItem(DISPLAY_ROLE_KEY) || (role === "user" ? "System User" : "Administrator");
}

function getAuthenticatedUser() {
  const role = getAuthenticatedRole();
  return sessionStorage.getItem(USER_KEY) || (role === "user" ? "Standard User" : "Admin User");
}

function getAuthenticatedUsername() {
  return sessionStorage.getItem(USERNAME_KEY) || sessionStorage.getItem(USER_KEY) || "";
}

async function login(username, password) {
  const payload = await requestBackendJson(LOGIN_ENDPOINT, {
    method: "POST",
    body: { username, password },
  });
  const authenticatedAccount = payload.account ? { ...payload.account } : null;
  if (!authenticatedAccount) return null;
  if (!payload.sessionId) throw new Error("Please refresh SmartDuck before signing in again.");
  sessionStorage.setItem(SESSION_ID_KEY, payload.sessionId);
  // Do not enter the dashboard until the browser proves that the HttpOnly
  // session cookie survived the login response. This prevents a successful
  // form response followed by an immediate bounce back from the first API call.
  const sessionPayload = await requestBackendJson(SESSION_ENDPOINT, {
    allowUnauthenticated: true,
  });
  const sessionUsername = String(sessionPayload.account?.username || "").trim().toLowerCase();
  if (sessionPayload.authenticated !== true
      || sessionUsername !== String(authenticatedAccount.username || "").trim().toLowerCase()) {
    throw new Error("The secure login session could not be established. Please sign in again.");
  }
  const shellRole = getAccountShellRole(authenticatedAccount);
  sessionStorage.setItem(AUTH_KEY, "true");
  sessionStorage.setItem(USER_KEY, authenticatedAccount.name);
  sessionStorage.setItem(USERNAME_KEY, authenticatedAccount.username);
  sessionStorage.setItem(ROLE_KEY, shellRole);
  sessionStorage.setItem(DISPLAY_ROLE_KEY, getManagedAccountRole(authenticatedAccount));
  accountState.cache = [];
  return { ...authenticatedAccount, role: shellRole };
}

function clearAuthenticationSession() {
  sessionStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(USERNAME_KEY);
  sessionStorage.removeItem(ROLE_KEY);
  sessionStorage.removeItem(DISPLAY_ROLE_KEY);
  sessionStorage.removeItem(SESSION_ID_KEY);
  accountState.cache = [];
  accountState.readyPromise = null;
  pageTemplateCache.clear();
  // Some of these responses are scoped to the signed-in account, so a cached
  // body must never survive into a different session.
  conditionalResponseCache.clear();
}

function logout() {
  // Drop the server session too; clearing sessionStorage alone would leave the
  // cookie valid and the account still reachable from this browser.
  const backendLogout = requestBackendJson(LOGOUT_ENDPOINT, {
    method: "POST",
    allowUnauthenticated: true,
  }).catch(() => {});
  clearAuthenticationSession();
  void backendLogout.finally(() => redirectToLogin({ replaceHistory: true }));
}

let loginLockoutUntil = 0;
let loginLockoutTimer = null;

function formatLoginLockoutTime(seconds) {
  const safeSeconds = Math.max(0, Math.ceil(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function isLoginLockedOut() {
  return loginLockoutUntil > Date.now();
}

function updateLoginLockoutUi(loginForm) {
  const submitButton = loginForm?.querySelector('button[type="submit"]');
  const buttonLabel = submitButton?.querySelector("span:first-child");
  const status = document.getElementById("login-lockout-status");
  const remainingSeconds = Math.max(0, Math.ceil((loginLockoutUntil - Date.now()) / 1000));

  if (remainingSeconds > 0) {
    if (submitButton) submitButton.disabled = true;
    if (buttonLabel) buttonLabel.textContent = `Try again in ${formatLoginLockoutTime(remainingSeconds)}`;
    if (status) {
      status.hidden = false;
      status.textContent = `Login temporarily locked. Try again in ${formatLoginLockoutTime(remainingSeconds)}.`;
    }
    return;
  }

  loginLockoutUntil = 0;
  if (loginLockoutTimer) {
    clearInterval(loginLockoutTimer);
    loginLockoutTimer = null;
  }
  if (submitButton) submitButton.disabled = false;
  if (buttonLabel) buttonLabel.textContent = "Sign in";
  if (status) {
    status.hidden = true;
    status.textContent = "";
  }
}

function startLoginLockout(loginForm, retryAfterSeconds) {
  const seconds = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 300));
  loginLockoutUntil = Date.now() + seconds * 1000;
  if (loginLockoutTimer) clearInterval(loginLockoutTimer);
  updateLoginLockoutUi(loginForm);
  loginLockoutTimer = setInterval(() => updateLoginLockoutUi(loginForm), 1000);
}

async function requestLogout() {
  const result = await openActionDialog({
    eyebrow: "Secure Sign Out",
    title: "Log out of SmartDuck?",
    body: "Your current session will end and you will need to sign in again to access the dashboard.",
    confirmLabel: "Logout",
    cancelLabel: "Cancel",
    tone: "danger",
  });

  if (result.confirmed) {
    logout();
  }
}

function initializeAuth() {
  const loginForm = document.getElementById("login-form");
  const usernameInput = document.getElementById("username");
  const passwordInput = document.getElementById("password");

  initializePasswordToggles();

  [usernameInput, passwordInput].forEach((input) => {
    input?.addEventListener("input", () => setInputInvalid(input, false));
  });

  loginForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isLoginLockedOut()) {
      updateLoginLockoutUi(loginForm);
      return;
    }
    const username = usernameInput?.value.trim() || "";
    const password = passwordInput?.value || "";
    const submitButton = loginForm.querySelector('button[type="submit"]');

    clearFormInvalidState(loginForm);

    if (!username) {
      setInputInvalid(usernameInput, true);
      await showWarningCard("Username required", "Enter your SmartDuck username before signing in.", usernameInput);
      return;
    }

    if (!password) {
      setInputInvalid(passwordInput, true);
      await showWarningCard("Password required", "Enter your password before signing in.", passwordInput);
      return;
    }

    if (submitButton) submitButton.disabled = true;
    try {
      const account = await login(username, password);
      if (!account) throw new Error("The backend did not return an account.");
      if (usernameInput) usernameInput.value = "";
      if (passwordInput) passwordInput.value = "";
      resetPasswordVisibility(loginForm || document);
      redirectToPage(getDefaultPageId(account.role), account.role, { replaceHistory: true });
    } catch (error) {
      setInputInvalid(usernameInput, true);
      setInputInvalid(passwordInput, true);
      if (error instanceof Error && error.status === 429) {
        startLoginLockout(loginForm, error.retryAfterSeconds);
        await showWarningCard(
          "Login temporarily locked",
          error.message || "Too many failed login attempts. Try again in 5 minutes.",
          usernameInput,
        );
      } else if (error instanceof Error && error.status === 401) {
        const remainingAttempts = Number(error.remainingAttempts);
        const attemptMessage = Number.isFinite(remainingAttempts) && remainingAttempts > 0
          ? ` You have ${remainingAttempts} attempt${remainingAttempts === 1 ? "" : "s"} remaining before a 5-minute lockout.`
          : "";
        await showWarningCard(
          "Invalid credentials",
          `The username or password does not match any SmartDuck account.${attemptMessage}`,
          usernameInput,
        );
      } else {
        await showWarningCard(
          "Sign in unavailable",
          error instanceof Error ? error.message : "Unable to contact the SmartDuck login service.",
          usernameInput,
        );
      }
      if (passwordInput) passwordInput.value = "";
      resetPasswordVisibility(loginForm || document);
    } finally {
      if (submitButton && !isLoginLockedOut()) submitButton.disabled = false;
    }
  });

  if (isLoginScreen()) {
    if (isAuthenticated()) {
      redirectToPage(getDefaultPageId(), getAuthenticatedRole(), { replaceHistory: true });
    }
    return;
  }

  if (!isAuthenticated()) {
    redirectToLogin({ replaceHistory: true });
    return;
  }

  const role = getAuthenticatedRole();
  const pathRole = getPathRole();
  const currentPage = document.body.dataset.page || getDefaultPageId(role);

  if (pathRole && pathRole !== role) {
    redirectToPage(getDefaultPageId(role), role, { replaceHistory: true });
    return;
  }

  if (!isPageAllowed(currentPage, role)) {
    redirectToPage(getDefaultPageId(role), role, { replaceHistory: true });
    return;
  }

  if (!pathRole) {
    redirectToPage(currentPage, role, { replaceHistory: true });
  }
}

function maskEmail(email) {
  const [localPart = "", domain = ""] = email.split("@");
  if (!localPart || !domain) return email;
  const visible = localPart.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(localPart.length - 2, 1))}@${domain}`;
}

function isValidGmailAddress(email) {
  return /^[a-zA-Z0-9._%+-]+@gmail\.com$/i.test(String(email || "").trim());
}

const USERNAME_MIN_LENGTH = 2;
const USERNAME_MAX_LENGTH = 30;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 64;
const USERNAME_POLICY_MESSAGE = "Username: 2–30 characters; use letters, numbers, dots, underscores, or hyphens; maximum 3 identical letters in a row.";
const PASSWORD_POLICY_MESSAGE = "Password must be 8–64 characters and include uppercase, lowercase, number, and special character.";
const RESERVED_USERNAMES = new Set(["admin", "administrator", "root", "system", "smartduck", "support", "security"]);
const BLOCKED_PASSWORD_FINGERPRINTS = new Set([
  "123456789012345",
  "adminadministrator",
  "iloveyouiloveyou",
  "letmeinletmein",
  "password123",
  "password123456",
  "passwordpassword",
  "qwertyqwerty123",
  "qwertyuiopasdfg",
  "smartduck123456",
  "smartduckpassword",
]);

function credentialFingerprint(value) {
  return String(value || "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function limitRepeatedUsernameCharacters(value) {
  return String(value || "").replace(/([a-z])\1{3,}/gi, "$1$1$1");
}

function usernameValueAfterInsertion(input, insertedText) {
  const value = String(input?.value || "");
  const start = Number.isInteger(input?.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isInteger(input?.selectionEnd) ? input.selectionEnd : start;
  return `${value.slice(0, start)}${insertedText}${value.slice(end)}`;
}

function wouldExceedUsernameLetterRepeat(input, insertedText) {
  return /([a-z])\1{3}/i.test(usernameValueAfterInsertion(input, String(insertedText || "")));
}

function evaluateUsernamePolicy(value) {
  const username = String(value || "").trim();
  const length = Array.from(username).length;
  const checks = [
    {
      key: "length",
      label: `${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} characters`,
      met: length >= USERNAME_MIN_LENGTH && length <= USERNAME_MAX_LENGTH,
      error: `Use ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters for the username.`,
    },
    {
      key: "edges",
      label: "Starts with a letter and ends with a letter or number",
      met: /^[a-z].*[a-z0-9]$/i.test(username),
      error: "Start the username with a letter and end it with a letter or number.",
    },
    {
      key: "characters",
      label: "Letters, numbers, dots, underscores, or hyphens only",
      met: /^[a-z0-9._-]+$/i.test(username) && !/[._-]{2}/.test(username),
      error: "Use only letters, numbers, dots, underscores, or hyphens, without adjacent separators.",
    },
    {
      key: "repeated",
      label: "Maximum 3 identical letters in a row",
      met: username !== "" && !/([a-z])\1{3}/i.test(username),
      error: "Do not repeat the same username letter more than three times in a row.",
    },
    {
      key: "reserved",
      label: "Not a reserved SmartDuck username",
      met: username !== "" && !RESERVED_USERNAMES.has(username.toLowerCase()),
      error: "Choose a username that is not reserved by SmartDuck.",
    },
  ];
  return { value: username, checks, valid: checks.every((check) => check.met) };
}

function evaluatePasswordPolicy(value, { username = "", email = "" } = {}) {
  const password = String(value || "");
  const length = Array.from(password).length;
  const fingerprint = credentialFingerprint(password);
  const usernameFingerprint = credentialFingerprint(username);
  const emailFingerprint = credentialFingerprint(String(email || "").split("@")[0]);
  const isContextSafe = !fingerprint.includes("smartduck")
    && !(usernameFingerprint.length >= USERNAME_MIN_LENGTH && fingerprint.includes(usernameFingerprint))
    && !(emailFingerprint.length >= USERNAME_MIN_LENGTH && fingerprint.includes(emailFingerprint));
  const isNotCommon = fingerprint !== "" && !BLOCKED_PASSWORD_FINGERPRINTS.has(fingerprint);
  const checks = [
    {
      key: "length",
      label: `${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`,
      met: length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH,
      error: length > PASSWORD_MAX_LENGTH
        ? `Use no more than ${PASSWORD_MAX_LENGTH} characters for the password.`
        : `Use at least ${PASSWORD_MIN_LENGTH} characters for the password.`,
    },
    {
      key: "uppercase",
      label: "At least one uppercase letter",
      met: /[A-Z]/.test(password),
      error: PASSWORD_POLICY_MESSAGE,
    },
    {
      key: "lowercase",
      label: "At least one lowercase letter",
      met: /[a-z]/.test(password),
      error: PASSWORD_POLICY_MESSAGE,
    },
    {
      key: "number",
      label: "At least one number",
      met: /\d/.test(password),
      error: PASSWORD_POLICY_MESSAGE,
    },
    {
      key: "special",
      label: "At least one special character",
      met: /[^a-z0-9\s]/i.test(password),
      error: PASSWORD_POLICY_MESSAGE,
    },
    {
      key: "spaces",
      label: "No spaces",
      met: password !== "" && !/\s/.test(password),
      error: "Password must not contain spaces.",
    },
    {
      key: "common",
      label: "Not a common or predictable password",
      met: isNotCommon,
      error: "Choose a password that is not common or predictable.",
    },
    {
      key: "context",
      label: "Does not contain SmartDuck, your username, or Gmail name",
      met: password !== "" && isContextSafe,
      error: "Do not base the password on SmartDuck, the username, or the Gmail name.",
    },
  ];
  return { value: password, checks, valid: checks.every((check) => check.met) };
}

function getCredentialPolicyContext(input) {
  const usernameSelector = input?.dataset.credentialUsernameSource || "";
  const emailSelector = input?.dataset.credentialEmailSource || "";
  if (usernameSelector || emailSelector) {
    return {
      username: usernameSelector ? document.querySelector(usernameSelector)?.value || "" : "",
      email: emailSelector ? document.querySelector(emailSelector)?.value || "" : "",
    };
  }
  if (input === app.recoveryPasswordInput) {
    return { username: state.recovery.account?.username || "", email: state.recovery.email || "" };
  }
  if (input === app.userPasswordResetNewInput) {
    return { username: state.userPasswordReset.account?.username || "", email: state.userPasswordReset.email || "" };
  }
  if (input?.matches("[data-profile-password-new]")) {
    return {
      username: state.profileQuick.password.account?.username || "",
      email: state.profileQuick.password.account?.email || "",
    };
  }
  return {};
}

function renderCredentialSecurityGuide(input) {
  if (!input) return;
  const kind = input.dataset.credentialSecurity;
  const anchor = input.closest(".password-field, .profile-password-input-wrap") || input;
  let guide = anchor.nextElementSibling;
  if (!(guide instanceof HTMLElement) || !guide.classList.contains("credential-security-guide")) {
    guide = document.createElement("div");
    guide.className = "credential-security-guide";
    guide.setAttribute("aria-live", "polite");
    anchor.insertAdjacentElement("afterend", guide);
  }

  const policy = kind === "username"
    ? evaluateUsernamePolicy(input.value)
    : evaluatePasswordPolicy(input.value, getCredentialPolicyContext(input));
  const hasValue = String(input.value || "") !== "";
  guide.dataset.policyValid = String(hasValue && policy.valid);
  guide.textContent = kind === "username" ? USERNAME_POLICY_MESSAGE : PASSWORD_POLICY_MESSAGE;
}

function bindCredentialSecurityGuides(root = document) {
  root.querySelectorAll("[data-credential-security]").forEach((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.credentialSecurityBound !== "true") {
      input.dataset.credentialSecurityBound = "true";
      input.addEventListener("beforeinput", (event) => {
        if (input.dataset.credentialSecurity !== "username"
          || event.isComposing
          || event.inputType !== "insertText"
          || typeof event.data !== "string") return;
        if (wouldExceedUsernameLetterRepeat(input, event.data)) event.preventDefault();
      });
      input.addEventListener("input", () => {
        if (input.dataset.credentialSecurity === "username") {
          const caret = input.selectionStart;
          const limitedValue = limitRepeatedUsernameCharacters(input.value);
          if (limitedValue !== input.value) {
            input.value = limitedValue;
            if (Number.isInteger(caret)) input.setSelectionRange(Math.min(caret, limitedValue.length), Math.min(caret, limitedValue.length));
          }
        }
        renderCredentialSecurityGuide(input);
      });
      const relatedSelectors = [input.dataset.credentialUsernameSource, input.dataset.credentialEmailSource].filter(Boolean);
      relatedSelectors.forEach((selector) => {
        document.querySelector(selector)?.addEventListener("input", () => renderCredentialSecurityGuide(input));
      });
    }
    renderCredentialSecurityGuide(input);
  });
}

function firstCredentialPolicyError(policy) {
  return policy.checks.find((check) => !check.met)?.error || "Use a stronger credential.";
}

function setInputInvalid(input, isInvalid) {
  if (!input) return;
  input.classList.toggle("is-invalid", Boolean(isInvalid));
}

function clearFormInvalidState(form) {
  form?.querySelectorAll(".is-invalid").forEach((input) => input.classList.remove("is-invalid"));
}

function getPasswordToggleIcon(isVisible) {
  if (isVisible) {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 3l18 18"></path>
        <path d="M10.58 10.58a2 2 0 1 0 2.83 2.83"></path>
        <path d="M9.88 5.09A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8-0.61 1.71-1.62 3.21-2.9 4.38"></path>
        <path d="M6.61 6.61C4.62 8 3.12 9.84 2 12c1.73 4.89 6 8 10 8 1.73 0 3.38-0.46 4.84-1.28"></path>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12s3.5-8 10-8 10 8 10 8-3.5 8-10 8-10-8-10-8Z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
}

function syncPasswordToggleButton(button, input) {
  if (!button || !input) return;
  const isVisible = input.type === "text";
  button.innerHTML = getPasswordToggleIcon(isVisible);
  button.setAttribute("aria-label", isVisible ? "Hide password" : "Show password");
  button.setAttribute("aria-pressed", String(isVisible));
}

function resetPasswordVisibility(scope = document) {
  const toggleButtons = scope?.querySelectorAll ? scope.querySelectorAll("[data-password-toggle]") : [];
  toggleButtons.forEach((button) => {
    const input = document.getElementById(button.dataset.passwordTarget || "");
    if (!input) return;
    input.type = "password";
    syncPasswordToggleButton(button, input);
  });
}

// The eye buttons ship empty in the markup -- their icon only ever comes from
// syncPasswordToggleButton -- and the dialogs that carry them (user setup, the
// managed password reset panel) live inside #dashboard-container, which a route
// swap empties and refills with fresh nodes. A per-button listener bound at
// startup therefore dies with the node it was attached to, leaving the new
// button unbound *and* blank. Delegate the click to the document once so a
// toggle works however late its button enters the page.
function bindPasswordToggleDelegation() {
  if (document.body?.dataset.passwordToggleDelegated === "true") return;

  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-password-toggle]");
    if (!button) return;
    const input = document.getElementById(button.dataset.passwordTarget || "");
    if (!input) return;

    event.preventDefault();
    input.type = input.type === "password" ? "text" : "password";
    syncPasswordToggleButton(button, input);
    input.focus({ preventScroll: true });
  });

  if (document.body) document.body.dataset.passwordToggleDelegated = "true";
}

function initializePasswordToggles(scope = document) {
  bindPasswordToggleDelegation();

  const buttons = scope?.querySelectorAll ? scope.querySelectorAll("[data-password-toggle]") : [];
  buttons.forEach((button) => {
    const input = document.getElementById(button.dataset.passwordTarget || "");
    if (!input) return;
    // Draw the glyph. Clicks are handled by the delegated listener above, so a
    // button replaced by a route swap needs nothing rebound -- only redrawn.
    syncPasswordToggleButton(button, input);
  });
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getRecoveryOtpInputs() {
  return Array.from(document.querySelectorAll("[data-otp-input]"));
}

function readRecoveryOtpValue() {
  return getRecoveryOtpInputs()
    .map((input) => input.value.trim())
    .join("");
}

function otpRequestKey(email, purpose) {
  return `${purpose}:${String(email || "").trim().toLowerCase()}`;
}

async function postOtpDelivery(endpoint, email, purpose) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), OTP_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await backendFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, purpose }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("OTP delivery took too long. Please try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || "Unable to send OTP code.");
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function requestOtpDelivery(email, purpose = OTP_PURPOSE_PASSWORD_RESET) {
  let payload;
  let verifyEndpoint = OTP_VERIFY_ENDPOINT;

  try {
    payload = await postOtpDelivery(OTP_SEND_ENDPOINT, email, purpose);
  } catch (error) {
    const canUseLocalFallback = IS_LOCAL_PREVIEW
      && LOCAL_OTP_SEND_ENDPOINT !== OTP_SEND_ENDPOINT
      && (!Number.isInteger(error?.status) || error.status >= 500);
    if (!canUseLocalFallback) throw error;

    console.warn("Hosted OTP is unavailable; using the local development fallback.", error);
    payload = await postOtpDelivery(LOCAL_OTP_SEND_ENDPOINT, email, purpose);
    verifyEndpoint = LOCAL_OTP_VERIFY_ENDPOINT;
  }

  otpEndpointByRequest.set(otpRequestKey(email, purpose), verifyEndpoint);

  if (payload.deliveryMode === "development" && payload.developmentCode) {
    showToast("Development OTP", `Use this local OTP: ${payload.developmentCode}`);
    console.warn("SmartDuck development OTP:", payload.developmentCode);
  }

  return payload;
}

function getUserSetupOtpSubmitButton() {
  return app.userSetupOtpForm?.querySelector('button[type="submit"]') || null;
}

function clearUserSetupOtpInputs() {
  getUserSetupOtpInputs().forEach((input) => {
    input.value = "";
  });
}

function fillUserSetupOtpInputs(code) {
  const digits = String(code || "").replace(/\D/g, "").slice(0, 6).split("");
  getUserSetupOtpInputs().forEach((input, index) => {
    input.value = digits[index] || "";
  });
}

function hideUserSetupOtpStatus() {
  if (!app.userSetupOtpStatus) return;
  app.userSetupOtpStatus.hidden = true;
}

function showUserSetupOtpStatus(title, body) {
  if (!app.userSetupOtpStatus) return;
  const titleNode = app.userSetupOtpStatus.querySelector(".user-setup-status__title");
  const copyNode = app.userSetupOtpStatus.querySelector(".user-setup-status__copy");
  if (titleNode) titleNode.textContent = title;
  if (copyNode) copyNode.textContent = body;
  app.userSetupOtpStatus.hidden = false;
}

function hideUserSetupDevOtp() {
  if (app.userSetupDevOtp) {
    app.userSetupDevOtp.hidden = true;
  }
  if (app.userSetupDevOtpCode) {
    app.userSetupDevOtpCode.textContent = "";
  }
  state.userSetup.delivery = null;
}

function showUserSetupDevOtp(code) {
  if (!app.userSetupDevOtp || !app.userSetupDevOtpCode) return;
  app.userSetupDevOtpCode.textContent = code;
  app.userSetupDevOtp.hidden = false;
}

function setUserSetupOtpRequestState(isSending) {
  state.userSetup.isSendingOtp = Boolean(isSending);
  if (app.userSetupResendButton) {
    app.userSetupResendButton.disabled = Boolean(isSending);
    app.userSetupResendButton.textContent = isSending ? "Sending OTP..." : "Resend OTP";
  }

  const submitButton = getUserSetupOtpSubmitButton();
  if (submitButton) {
    submitButton.disabled = Boolean(isSending);
    submitButton.textContent = isSending ? "Sending..." : "Create Account";
  }
}

function applyUserSetupOtpDelivery(payload, email) {
  state.userSetup.delivery = payload;
  hideUserSetupOtpStatus();

  if (payload?.deliveryMode === "development" && payload.developmentCode) {
    showUserSetupDevOtp(payload.developmentCode);
    fillUserSetupOtpInputs(payload.developmentCode);
    showToast("Development OTP", `Local preview code for ${email}: ${payload.developmentCode}`);
    return;
  }

  hideUserSetupDevOtp();
  showToast("OTP sent", `Check ${email} for the SmartDuck verification code.`);
}

async function verifyOtpCode(email, code, purpose = OTP_PURPOSE_PASSWORD_RESET) {
  const requestKey = otpRequestKey(email, purpose);
  const verifyEndpoint = otpEndpointByRequest.get(requestKey) || OTP_VERIFY_ENDPOINT;
  const response = await backendFetch(verifyEndpoint, {
    method: "POST",
    // A verified reset is recorded in the backend session, so the cookie the
    // response sets has to be kept for the update-password call that follows.
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, code, purpose }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || "Unable to verify OTP code.");
  }

  if (payload.success) {
    otpEndpointByRequest.delete(requestKey);
  }
  // The username is only present for a verified password reset, and it is how
  // the recovery flow learns which account it just proved ownership of.
  return { success: Boolean(payload.success), username: payload.username || "" };
}

function setRecoveryCopy(step) {
  if (!app.recoveryTitle || !app.recoveryDescription) return;

  if (step === 1) {
    app.recoveryTitle.textContent = "Recover your account";
    app.recoveryDescription.textContent = "Enter your Gmail address to continue to the OTP step.";
    return;
  }

  if (step === 2) {
    const email = maskEmail(state.recovery.email || state.recovery.account?.email || "your Gmail address");
    app.recoveryTitle.textContent = "Enter OTP code";
    app.recoveryDescription.textContent = `Type the 6-digit code sent to ${email}.`;
    return;
  }

  app.recoveryTitle.textContent = "Create a new password";
  app.recoveryDescription.textContent = "Set the new password for your SmartDuck account.";
}

function setRecoveryStep(step) {
  state.recovery.step = step;
  setRecoveryCopy(step);
  document.querySelectorAll("[data-recovery-step-card]").forEach((card) => {
    card.classList.toggle("is-active", Number(card.dataset.recoveryStepCard) === step);
  });
  document.querySelectorAll("[data-recovery-step]").forEach((panel) => {
    panel.hidden = Number(panel.dataset.recoveryStep) !== step;
  });
}

function hideRecoveryOtpAlert() {
  if (!app.recoveryOtpAlert) return;
  app.recoveryOtpAlert.hidden = true;
}

function showRecoveryOtpAlert(title, message) {
  if (!app.recoveryOtpAlert) return;
  const titleNode = app.recoveryOtpAlert.querySelector(".recovery-alert__title");
  const copyNode = app.recoveryOtpAlert.querySelector(".recovery-alert__copy");
  if (titleNode) titleNode.textContent = title;
  if (copyNode) copyNode.textContent = message;
  app.recoveryOtpAlert.hidden = false;
}

function resetRecoveryFlow() {
  state.recovery.step = 1;
  state.recovery.account = null;
  state.recovery.email = "";
  state.recovery.otpCode = "";
  app.recoveryEmailForm?.reset();
  app.recoveryOtpForm?.reset();
  app.recoveryPasswordForm?.reset();
  getRecoveryOtpInputs().forEach((input) => {
    input.value = "";
  });
  resetPasswordVisibility(app.recoveryPasswordForm || document);
  hideRecoveryOtpAlert();
  setRecoveryStep(1);
  bindCredentialSecurityGuides(app.recoveryPasswordForm || document);
}

function syncModalOpenState() {
  const hasOpenModal = [
    app.recoveryModal,
    app.userSetupModal,
    app.userDetailModal,
    app.batchEntryModal,
    app.historyDetailModal,
    app.notificationModal,
    app.actionDialog,
  ].some((node) => Boolean(node && !node.hidden));
  document.body.classList.toggle("modal-open", hasOpenModal);
}

function openRecoveryModal() {
  if (!app.recoveryModal) return;
  resetRecoveryFlow();
  app.recoveryModal.hidden = false;
  app.recoveryModal.setAttribute("aria-hidden", "false");
  syncModalOpenState();
  window.setTimeout(() => app.recoveryEmailInput?.focus(), 0);
}

function closeRecoveryModal() {
  if (!app.recoveryModal) return;
  app.recoveryModal.hidden = true;
  app.recoveryModal.setAttribute("aria-hidden", "true");
  syncModalOpenState();
}

function ensureActionDialog() {
  if (app.actionDialog) return;

  const wrapper = document.createElement("div");
  wrapper.className = "action-dialog";
  wrapper.hidden = true;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = `
    <button class="action-dialog__backdrop" type="button" tabindex="-1" aria-label="Close action dialog"></button>
    <div class="action-dialog__card" role="dialog" aria-modal="true" aria-labelledby="action-dialog-title">
      <p class="action-dialog__eyebrow">SmartDuck Action</p>
      <h2 id="action-dialog-title" class="action-dialog__title"></h2>
      <p class="action-dialog__body"></p>
      <input class="action-dialog__input" type="text" hidden />
      <div class="action-dialog__actions">
        <button class="action-dialog__button action-dialog__button--secondary" type="button">Cancel</button>
        <button class="action-dialog__button action-dialog__button--primary" type="button">Confirm</button>
      </div>
    </div>
  `;

  document.body.appendChild(wrapper);

  app.actionDialog = wrapper;
  app.actionDialogBackdrop = wrapper.querySelector(".action-dialog__backdrop");
  app.actionDialogEyebrow = wrapper.querySelector(".action-dialog__eyebrow");
  app.actionDialogTitle = wrapper.querySelector(".action-dialog__title");
  app.actionDialogBody = wrapper.querySelector(".action-dialog__body");
  app.actionDialogInput = wrapper.querySelector(".action-dialog__input");
  app.actionDialogActions = wrapper.querySelector(".action-dialog__actions");
  app.actionDialogCancel = wrapper.querySelector(".action-dialog__button--secondary");
  app.actionDialogConfirm = wrapper.querySelector(".action-dialog__button--primary");
}

function closeActionDialog(result = { confirmed: false, value: "" }) {
  if (!app.actionDialog) return;

  app.actionDialog.hidden = true;
  app.actionDialog.setAttribute("aria-hidden", "true");
  app.actionDialogInput.value = "";
  app.actionDialogInput.hidden = true;
  syncModalOpenState();

  if (state.actionDialog.onKeydown) {
    document.removeEventListener("keydown", state.actionDialog.onKeydown);
    state.actionDialog.onKeydown = null;
  }

  const resolver = state.actionDialog.resolve;
  state.actionDialog.resolve = null;
  if (resolver) resolver(result);
}

function openActionDialog({
  eyebrow = "SmartDuck Action",
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  mode = "confirm",
  tone = "default",
  initialValue = "",
  placeholder = "",
}) {
  ensureActionDialog();

  app.actionDialogEyebrow.textContent = eyebrow;
  app.actionDialogTitle.textContent = title;
  app.actionDialogBody.textContent = body;
  app.actionDialogCancel.textContent = cancelLabel;
  app.actionDialogConfirm.textContent = confirmLabel;
  app.actionDialogActions.classList.toggle("action-dialog__actions--single", mode === "alert");
  app.actionDialogCancel.hidden = mode === "alert";
  app.actionDialog.classList.toggle("action-dialog--danger", tone === "danger");

  if (mode === "prompt") {
    app.actionDialogInput.hidden = false;
    app.actionDialogInput.value = initialValue;
    app.actionDialogInput.placeholder = placeholder;
  } else {
    app.actionDialogInput.hidden = true;
    app.actionDialogInput.value = "";
    app.actionDialogInput.placeholder = "";
  }

  app.actionDialog.hidden = false;
  app.actionDialog.setAttribute("aria-hidden", "false");
  syncModalOpenState();

  return new Promise((resolve) => {
    state.actionDialog.resolve = resolve;

    app.actionDialogBackdrop.onclick = () => closeActionDialog({ confirmed: false, value: "" });
    app.actionDialogCancel.onclick = () => closeActionDialog({ confirmed: false, value: "" });
    app.actionDialogConfirm.onclick = () => {
      closeActionDialog({
        confirmed: true,
        value: app.actionDialogInput.hidden ? "" : app.actionDialogInput.value.trim(),
      });
    };

    state.actionDialog.onKeydown = (event) => {
      if (app.actionDialog?.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeActionDialog({ confirmed: false, value: "" });
      }
      if (event.key === "Enter") {
        event.preventDefault();
        closeActionDialog({
          confirmed: true,
          value: app.actionDialogInput.hidden ? "" : app.actionDialogInput.value.trim(),
        });
      }
    };
    document.addEventListener("keydown", state.actionDialog.onKeydown);

    window.setTimeout(() => {
      if (mode === "prompt") {
        app.actionDialogInput.focus();
        app.actionDialogInput.select();
      } else {
        app.actionDialogConfirm.focus();
      }
    }, 0);
  });
}

async function showWarningCard(title, body, focusTarget = null) {
  await openActionDialog({
    eyebrow: "SmartDuck Warning",
    title,
    body,
    confirmLabel: "Okay",
    mode: "alert",
  });

  if (focusTarget) {
    window.setTimeout(() => focusTarget.focus(), 0);
  }
}

async function showSuccessCard(title, body, focusTarget = null) {
  await openActionDialog({
    eyebrow: "SmartDuck Success",
    title,
    body,
    confirmLabel: "Okay",
    mode: "alert",
  });

  if (focusTarget) {
    window.setTimeout(() => focusTarget.focus(), 0);
  }
}

function dispatchRecoveryOtp(account) {
  state.recovery.account = account;
  state.recovery.email = account.email;
  state.recovery.otpCode = "";
  getRecoveryOtpInputs().forEach((input) => {
    input.value = "";
  });
  hideRecoveryOtpAlert();
  setRecoveryStep(2);
  getRecoveryOtpInputs()[0]?.focus();
  showToast("OTP sent", `Check ${account.email} for the 6-digit code.`);
}

function initializePasswordRecovery() {
  if (!isLoginScreen()) return;

  bindCredentialSecurityGuides(app.recoveryPasswordForm || document);

  [app.recoveryEmailInput, app.recoveryPasswordInput, app.recoveryPasswordConfirmInput].forEach((input) => {
    input?.addEventListener("input", () => setInputInvalid(input, false));
  });

  app.forgotPasswordButton?.addEventListener("click", openRecoveryModal);
  app.recoveryBackdrop?.addEventListener("click", closeRecoveryModal);
  app.recoveryCloseButton?.addEventListener("click", closeRecoveryModal);

  app.recoveryEmailForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = app.recoveryEmailInput?.value.trim() || "";
    const submitButton = app.recoveryEmailForm?.querySelector('button[type="submit"]');
    clearFormInvalidState(app.recoveryEmailForm);

    if (!email) {
      setInputInvalid(app.recoveryEmailInput, true);
      await showWarningCard("Gmail required", "Enter the Gmail address linked to your SmartDuck account.", app.recoveryEmailInput);
      return;
    }

    if (submitButton) submitButton.disabled = true;

    try {
      if (!isValidGmailAddress(email)) {
        setInputInvalid(app.recoveryEmailInput, true);
        await showWarningCard(
          "Invalid Gmail",
          "Enter a valid Gmail address ending in @gmail.com.",
          app.recoveryEmailInput,
        );
        return;
      }

      // The account lookup is the backend's job now. Asking it here meant
      // downloading the whole account list before anyone had signed in, and it
      // told strangers which Gmail addresses are registered. send-otp answers
      // the same way for known and unknown addresses.
      await requestOtpDelivery(email, OTP_PURPOSE_PASSWORD_RESET);
      dispatchRecoveryOtp({ email });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to send OTP code.";
      await showWarningCard("OTP send failed", message, app.recoveryEmailInput);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });

  app.recoveryResendButton?.addEventListener("click", async () => {
    if (!state.recovery.account) return;
    app.recoveryResendButton.disabled = true;
    try {
      await requestOtpDelivery(state.recovery.account.email, OTP_PURPOSE_PASSWORD_RESET);
      dispatchRecoveryOtp(state.recovery.account);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to resend OTP code.";
      await showWarningCard("OTP resend failed", message, getRecoveryOtpInputs()[0] || null);
    } finally {
      app.recoveryResendButton.disabled = false;
    }
  });

  app.recoveryBackToEmailButton?.addEventListener("click", () => {
    hideRecoveryOtpAlert();
    setRecoveryStep(1);
    app.recoveryEmailInput?.focus();
  });

  app.recoveryBackToOtpButton?.addEventListener("click", () => {
    setRecoveryStep(2);
    getRecoveryOtpInputs()[0]?.focus();
  });

  getRecoveryOtpInputs().forEach((input, index, inputs) => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 1);
      hideRecoveryOtpAlert();
      if (input.value && index < inputs.length - 1) {
        inputs[index + 1].focus();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        inputs[index - 1].focus();
      }
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        inputs[index - 1].focus();
      }
      if (event.key === "ArrowRight" && index < inputs.length - 1) {
        event.preventDefault();
        inputs[index + 1].focus();
      }
    });
  });

  app.recoveryOtpForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const otpCode = readRecoveryOtpValue();
    hideRecoveryOtpAlert();

    if (otpCode.length !== 6) {
      showRecoveryOtpAlert("OTP required", "Enter the full 6-digit OTP code before continuing.");
      getRecoveryOtpInputs()[0]?.focus();
      return;
    }

    try {
      const otpResult = await verifyOtpCode(state.recovery.email, otpCode);
      if (!otpResult.success) {
        showRecoveryOtpAlert("Incorrect OTP code", "Please try again using the latest 6-digit code.");
        getRecoveryOtpInputs()[0]?.focus();
        return;
      }

      // Learned from the verified OTP rather than a pre-login account lookup.
      state.recovery.account = {
        ...(state.recovery.account || {}),
        username: otpResult.username,
        email: state.recovery.email,
      };
      state.recovery.otpCode = otpCode;
      setRecoveryStep(3);
      app.recoveryPasswordInput?.focus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to verify OTP code.";
      showRecoveryOtpAlert("OTP verification failed", message);
      getRecoveryOtpInputs()[0]?.focus();
    }
  });

  app.recoveryPasswordForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextPassword = app.recoveryPasswordInput?.value || "";
    const confirmPassword = app.recoveryPasswordConfirmInput?.value || "";
    const submitButton = app.recoveryPasswordForm?.querySelector('button[type="submit"]');
    clearFormInvalidState(app.recoveryPasswordForm);

    if (!nextPassword) {
      setInputInvalid(app.recoveryPasswordInput, true);
      await showWarningCard("Password required", "Enter a new password to continue.", app.recoveryPasswordInput);
      return;
    }

    const passwordPolicy = evaluatePasswordPolicy(nextPassword, {
      username: state.recovery.account?.username || "",
      email: state.recovery.email || "",
    });
    if (!passwordPolicy.valid) {
      setInputInvalid(app.recoveryPasswordInput, true);
      await showWarningCard("Password is not secure yet", firstCredentialPolicyError(passwordPolicy), app.recoveryPasswordInput);
      return;
    }

    if (!confirmPassword) {
      setInputInvalid(app.recoveryPasswordConfirmInput, true);
      await showWarningCard("Confirm your password", "Re-enter the new password in the confirm field.", app.recoveryPasswordConfirmInput);
      return;
    }

    if (nextPassword !== confirmPassword) {
      setInputInvalid(app.recoveryPasswordInput, true);
      setInputInvalid(app.recoveryPasswordConfirmInput, true);
      await showWarningCard("Passwords do not match", "The new password and confirm password must be the same.", app.recoveryPasswordInput);
      return;
    }

    if (!state.recovery.account?.username) {
      await showWarningCard(
        "Recovery session expired",
        "Start the forgot password flow again before updating the password.",
        app.recoveryEmailInput,
      );
      setRecoveryStep(1);
      return;
    }

    if (submitButton) submitButton.disabled = true;

    try {
      const updatedAccount = await updateAccountPassword(state.recovery.account.username, nextPassword);
      closeRecoveryModal();
      resetRecoveryFlow();
      await showSuccessCard(
        "Password updated",
        updatedAccount
          ? `The password for ${updatedAccount.username} was changed successfully. You can now sign in using the new password.`
          : "Your SmartDuck password was changed successfully. You can now sign in using the new password.",
        document.getElementById("username"),
      );
      showToast(
        "Password updated",
        updatedAccount
          ? `Sign in using the new password for ${updatedAccount.username}.`
          : "Your new password has been saved in the frontend flow.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update the password.";
      await showWarningCard("Password update failed", message, app.recoveryPasswordInput);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app.recoveryModal && !app.recoveryModal.hidden) {
      closeRecoveryModal();
    }
  });
}

function isUsersScreen() {
  return document.body.dataset.page === "users";
}

function getManagedAccountName(account) {
  return String(account.name || account.username || "User").trim();
}

function getManagedAccountRole(account) {
  const customRole = String(account.accountRole || "").trim();
  if (customRole.toLowerCase().replace(/\s+/g, "") === "superadmin") return "Supervisor";
  if (customRole) return customRole;
  if (account.role === "admin") return "Administrator";
  return account.role === "user" ? "Operator" : "Administrator";
}

function getManagedRoleBadgeClass(roleLabel) {
  const normalized = String(roleLabel).trim().toLowerCase();
  if (normalized === "administrator") return "badge--purple";
  if (normalized === "supervisor") return "badge--blue";
  if (normalized === "operator") return "badge--green";
  return "badge--gray";
}

function getManagedAccountStatus(account) {
  return account.active === false ? "Inactive" : "Active";
}

function getManagedStatusBadgeClass(statusLabel) {
  return String(statusLabel).trim().toLowerCase() === "active" ? "badge--green" : "badge--gray";
}

function formatAccountDateDisplay(value, options = {}) {
  const { includeTime = true, fallback = "Never" } = options;
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const datePart = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (!includeTime) return datePart;
  const timePart = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart} ${timePart}`;
}

function formatAccountLastLogin(value) {
  return formatAccountDateDisplay(value, { includeTime: true, fallback: "Never" });
}

function formatAccountCreatedDate(value) {
  return formatAccountDateDisplay(value, { includeTime: false, fallback: "Not available" });
}

function getManagedRoleTone(roleLabel) {
  const normalized = String(roleLabel || "").trim().toLowerCase();
  if (normalized === "administrator") return "purple";
  if (normalized === "supervisor") return "blue";
  if (normalized === "operator") return "green";
  return "gray";
}

function getManagedUserPermissions(account) {
  if (isAdminCapableAccount(account)) {
    return [
      "View Dashboard",
      "View Monitoring",
      "Manage Reports",
      "Manage Users",
    ];
  }

  if (getManagedAccountRole(account) === "Supervisor") {
    return [
      "View Dashboard",
      "View Monitoring",
      "Manage Batches",
      "View Notifications",
      "View Reports",
    ];
  }

  return [
    "View Dashboard",
    "View Monitoring",
    "Update Tasks",
    "Review Schedules",
    "View Notifications",
  ];
}

function normalizeManagedRole(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "supervisor") return "Supervisor";
  if (normalized === "operator") return "Operator";
  return "";
}

function mapManagedRoleToSystemRole(roleLabel) {
  return roleLabel === "Supervisor" ? "admin" : "user";
}

function isAdminCapableAccount(account) {
  return String(account?.role || "").trim().toLowerCase() === "admin";
}

function countAdminCapableAccounts(accounts) {
  return accounts.filter((account) => isAdminCapableAccount(account)).length;
}

function getDeleteBlockReason(account, accounts) {
  const username = String(account?.username || "").trim().toLowerCase();
  const authenticatedUsername = getAuthenticatedUsername().trim().toLowerCase();

  if (username && authenticatedUsername && username === authenticatedUsername) {
    return "You cannot delete the account currently signed in.";
  }

  if (isAdminCapableAccount(account) && countAdminCapableAccounts(accounts) <= 1) {
    return "At least one admin or supervisor account must remain.";
  }

  return "";
}

function getDeactivateBlockReason(account, accounts) {
  if (account?.active === false) {
    return "This account is already inactive.";
  }

  const username = String(account?.username || "").trim().toLowerCase();
  const authenticatedUsername = getAuthenticatedUsername().trim().toLowerCase();

  if (username && authenticatedUsername && username === authenticatedUsername) {
    return "You cannot deactivate the account currently signed in.";
  }

  if (isAdminCapableAccount(account) && countAdminCapableAccounts(accounts.filter((entry) => entry.active !== false)) <= 1) {
    return "At least one active admin or supervisor account must remain.";
  }

  return "";
}

function getUserSetupOtpInputs() {
  return Array.from(document.querySelectorAll("[data-user-otp-input]"));
}

function readUserSetupOtpValue() {
  return getUserSetupOtpInputs()
    .map((input) => input.value.trim())
    .join("");
}

function hideUserSetupOtpAlert() {
  if (!app.userSetupOtpAlert) return;
  app.userSetupOtpAlert.hidden = true;
}

function showUserSetupOtpAlert(title, message) {
  if (!app.userSetupOtpAlert) return;
  const titleNode = app.userSetupOtpAlert.querySelector(".user-setup-alert__title");
  const copyNode = app.userSetupOtpAlert.querySelector(".user-setup-alert__copy");
  if (titleNode) titleNode.textContent = title;
  if (copyNode) copyNode.textContent = message;
  app.userSetupOtpAlert.hidden = false;
}

function setUserSetupStep(step) {
  state.userSetup.step = step;
  document.querySelectorAll("[data-user-setup-card]").forEach((card) => {
    card.classList.toggle("is-active", Number(card.dataset.userSetupCard) === step);
  });
  document.querySelectorAll("[data-user-setup-step]").forEach((panel) => {
    panel.hidden = Number(panel.dataset.userSetupStep) !== step;
  });

  if (app.userSetupCopy) {
    app.userSetupCopy.textContent = step === 1
      ? "Add a SmartDuck account, then verify it via Gmail OTP before saving."
      : `Enter the 6-digit OTP sent to ${maskEmail(state.userSetup.email || "your Gmail address")}.`;
  }

  if (app.userSetupOtpCopy) {
    app.userSetupOtpCopy.textContent = `We sent a 6-digit SmartDuck OTP code to ${maskEmail(state.userSetup.email || "your Gmail address")}.`;
  }
}

function resetUserSetupFlow() {
  state.userSetup.step = 1;
  state.userSetup.pendingAccount = null;
  state.userSetup.email = "";
  state.userSetup.delivery = null;
  state.userSetup.isSendingOtp = false;
  app.userSetupDetailsForm?.reset();
  app.userSetupOtpForm?.reset();
  clearFormInvalidState(app.userSetupDetailsForm);
  clearFormInvalidState(app.userSetupOtpForm);
  getUserSetupOtpInputs().forEach((input) => {
    input.value = "";
  });
  resetPasswordVisibility(app.userSetupDetailsForm || document);
  hideUserSetupOtpAlert();
  hideUserSetupOtpStatus();
  hideUserSetupDevOtp();
  setUserSetupOtpRequestState(false);
  setUserSetupStep(1);
  bindCredentialSecurityGuides(app.userSetupDetailsForm || document);
}

function openUserSetupModal() {
  if (!app.userSetupModal) return;
  resetUserSetupFlow();
  app.userSetupModal.hidden = false;
  app.userSetupModal.setAttribute("aria-hidden", "false");
  // Same as the detail dialog: its icons come from the page markup and are only
  // ever drawn here.
  hydrateIcons(app.userSetupModal);
  syncModalOpenState();
  window.setTimeout(() => app.userSetupUsernameInput?.focus(), 0);
}

function closeUserSetupModal() {
  if (!app.userSetupModal) return;
  app.userSetupModal.hidden = true;
  app.userSetupModal.setAttribute("aria-hidden", "true");
  syncModalOpenState();
  resetUserSetupFlow();
}

async function getManagedAccountByUsername(username) {
  const normalizedUsername = String(username || "").trim().toLowerCase();
  if (!normalizedUsername) return null;
  return (await getAccounts()).find(
    (account) => String(account.username || "").trim().toLowerCase() === normalizedUsername,
  ) || null;
}

function getManagedAccountAvatarImage(account) {
  const avatarImage = String(account?.avatarImage || account?.avatar || account?.photo || "").trim();
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(avatarImage) ? avatarImage : "";
}

function renderManagedTableAvatar(account) {
  const avatarImage = getManagedAccountAvatarImage(account);
  const displayName = getManagedAccountName(account);
  if (!avatarImage) {
    return `<span class="table-avatar">${escapeHtml(initials(displayName))}</span>`;
  }

  return `
    <span class="table-avatar table-avatar--image">
      <img class="table-avatar__image" src="${escapeHtml(avatarImage)}" alt="${escapeHtml(displayName)}" />
    </span>
  `;
}

function renderManagedDetailAvatar(account) {
  if (!app.userDetailAvatar) return;
  const avatarImage = getManagedAccountAvatarImage(account);
  const displayName = getManagedAccountName(account);
  app.userDetailAvatar.classList.toggle("has-image", Boolean(avatarImage));

  if (avatarImage) {
    app.userDetailAvatar.innerHTML = `<img class="users-detail-card__avatar-image" src="${escapeHtml(avatarImage)}" alt="${escapeHtml(displayName)}" />`;
    return;
  }

  app.userDetailAvatar.textContent = initials(displayName);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Unable to read the selected image."));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to process the selected image."));
    image.src = dataUrl;
  });
}

async function buildManagedAvatarImageDataUrl(file) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error("Select a valid image file.");
  }

  if (file.size > 4 * 1024 * 1024) {
    throw new Error("Use an image smaller than 4 MB.");
  }

  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImageElement(sourceDataUrl);
  const size = 240;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to process the selected image.");
  }

  context.fillStyle = "#162334";
  context.fillRect(0, 0, size, size);

  const scale = Math.max(size / image.width, size / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const x = (size - width) / 2;
  const y = (size - height) / 2;
  context.drawImage(image, x, y, width, height);

  return canvas.toDataURL("image/jpeg", 0.86);
}

async function handleManagedUserAvatarSelection(event) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;

  const file = input.files?.[0] || null;
  if (!file) return;

  const account = await getManagedAccountByUsername(state.managedUserSelection);
  if (!account) {
    input.value = "";
    await showWarningCard("Account missing", "Select a SmartDuck user first before uploading a profile picture.");
    return;
  }

  if (app.userDetailAvatarButton) {
    app.userDetailAvatarButton.disabled = true;
  }

  try {
    const avatarImage = await buildManagedAvatarImageDataUrl(file);
    await updateAccountRecord(account.username, { avatarImage });
    await renderUsersTable();
    showToast("Profile photo updated", `${getManagedAccountName(account)} now has a profile picture.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to upload the profile picture.";
    await showWarningCard("Upload failed", message, app.userDetailAvatarButton || null);
  } finally {
    input.value = "";
    if (app.userDetailAvatarButton) {
      app.userDetailAvatarButton.disabled = false;
    }
  }
}

function getManagedPasswordResetOtpInputs() {
  return Array.from(document.querySelectorAll("[data-user-password-reset-otp-input]"));
}

function readManagedPasswordResetOtpValue() {
  return getManagedPasswordResetOtpInputs()
    .map((input) => input.value.trim())
    .join("");
}

function clearManagedPasswordResetOtpInputs() {
  getManagedPasswordResetOtpInputs().forEach((input) => {
    input.value = "";
  });
}

function fillManagedPasswordResetOtpInputs(code) {
  const digits = String(code || "").replace(/\D/g, "").slice(0, 6).split("");
  getManagedPasswordResetOtpInputs().forEach((input, index) => {
    input.value = digits[index] || "";
  });
}

function hideManagedPasswordResetOtpAlert() {
  if (!app.userPasswordResetOtpAlert) return;
  app.userPasswordResetOtpAlert.hidden = true;
}

function showManagedPasswordResetOtpAlert(title, message) {
  if (!app.userPasswordResetOtpAlert) return;
  const titleNode = app.userPasswordResetOtpAlert.querySelector(".user-setup-alert__title");
  const copyNode = app.userPasswordResetOtpAlert.querySelector(".user-setup-alert__copy");
  if (titleNode) titleNode.textContent = title;
  if (copyNode) copyNode.textContent = message;
  app.userPasswordResetOtpAlert.hidden = false;
}

function hideManagedPasswordResetOtpStatus() {
  if (!app.userPasswordResetOtpStatus) return;
  app.userPasswordResetOtpStatus.hidden = true;
}

function showManagedPasswordResetOtpStatus(title, body) {
  if (!app.userPasswordResetOtpStatus) return;
  const titleNode = app.userPasswordResetOtpStatus.querySelector(".user-setup-status__title");
  const copyNode = app.userPasswordResetOtpStatus.querySelector(".user-setup-status__copy");
  if (titleNode) titleNode.textContent = title;
  if (copyNode) copyNode.textContent = body;
  app.userPasswordResetOtpStatus.hidden = false;
}

function hideManagedPasswordResetDevOtp() {
  if (app.userPasswordResetDevOtp) {
    app.userPasswordResetDevOtp.hidden = true;
  }
  if (app.userPasswordResetDevOtpCode) {
    app.userPasswordResetDevOtpCode.textContent = "";
  }
  state.userPasswordReset.delivery = null;
}

function showManagedPasswordResetDevOtp(code) {
  if (!app.userPasswordResetDevOtp || !app.userPasswordResetDevOtpCode) return;
  app.userPasswordResetDevOtpCode.textContent = code;
  app.userPasswordResetDevOtp.hidden = false;
}

function getManagedPasswordResetOtpSubmitButton() {
  return app.userPasswordResetOtpForm?.querySelector('button[type="submit"]') || null;
}

function setManagedPasswordResetOtpRequestState(isSending) {
  state.userPasswordReset.isSendingOtp = Boolean(isSending);
  if (app.userPasswordResetResendButton) {
    app.userPasswordResetResendButton.disabled = Boolean(isSending);
    app.userPasswordResetResendButton.textContent = isSending ? "Sending OTP..." : "Resend OTP";
  }

  const submitButton = getManagedPasswordResetOtpSubmitButton();
  if (submitButton) {
    submitButton.disabled = Boolean(isSending);
    submitButton.textContent = isSending ? "Sending..." : "Update Password";
  }
}

function applyManagedPasswordResetOtpDelivery(payload, email) {
  state.userPasswordReset.delivery = payload;
  hideManagedPasswordResetOtpStatus();

  if (payload?.deliveryMode === "development" && payload.developmentCode) {
    showManagedPasswordResetDevOtp(payload.developmentCode);
    fillManagedPasswordResetOtpInputs(payload.developmentCode);
    showToast("Development OTP", `Local preview code for ${email}: ${payload.developmentCode}`);
    return;
  }

  hideManagedPasswordResetDevOtp();
  showToast("OTP sent", `Check ${email} for the SmartDuck password reset code.`);
}

function setManagedPasswordResetStep(step) {
  state.userPasswordReset.step = step;
  document.querySelectorAll("[data-user-password-reset-card]").forEach((card) => {
    card.classList.toggle("is-active", Number(card.dataset.userPasswordResetCard) === step);
  });
  document.querySelectorAll("[data-user-password-reset-step]").forEach((panel) => {
    panel.hidden = Number(panel.dataset.userPasswordResetStep) !== step;
  });

  const accountLabel = state.userPasswordReset.account?.name || state.userPasswordReset.account?.username || "this user";
  const maskedEmail = maskEmail(state.userPasswordReset.email || "your Gmail address");

  if (app.userPasswordResetCopy) {
    app.userPasswordResetCopy.textContent = step === 1
      ? `Verify the current password for ${accountLabel}, then confirm the OTP code sent to ${maskedEmail}.`
      : `Enter the 6-digit OTP code sent to ${maskedEmail} to finish updating the password.`;
  }

  if (app.userPasswordResetCardCopy) {
    app.userPasswordResetCardCopy.textContent = `Enter the old password for ${accountLabel}, then create and confirm a new password.`;
  }

  if (app.userPasswordResetOtpCopy) {
    app.userPasswordResetOtpCopy.textContent = `We sent a 6-digit SmartDuck OTP code to ${maskedEmail}.`;
  }
}

function resetManagedPasswordResetFlow() {
  state.userPasswordReset.step = 1;
  state.userPasswordReset.account = null;
  state.userPasswordReset.email = "";
  state.userPasswordReset.currentPassword = "";
  state.userPasswordReset.pendingPassword = "";
  state.userPasswordReset.delivery = null;
  state.userPasswordReset.isSendingOtp = false;
  app.userPasswordResetDetailsForm?.reset();
  app.userPasswordResetOtpForm?.reset();
  clearFormInvalidState(app.userPasswordResetDetailsForm);
  clearFormInvalidState(app.userPasswordResetOtpForm);
  clearManagedPasswordResetOtpInputs();
  resetPasswordVisibility(app.userPasswordResetDetailsForm || document);
  hideManagedPasswordResetOtpAlert();
  hideManagedPasswordResetOtpStatus();
  hideManagedPasswordResetDevOtp();
  setManagedPasswordResetOtpRequestState(false);
  setManagedPasswordResetStep(1);
  bindCredentialSecurityGuides(app.userPasswordResetDetailsForm || document);
}

async function openManagedPasswordResetPanel() {
  if (!app.userPasswordResetPanel) return;
  const account = await getManagedAccountByUsername(state.managedUserSelection);

  if (!account) {
    await showWarningCard("Account missing", "Select a SmartDuck user first before resetting the password.");
    return;
  }

  if (!isValidGmailAddress(account.email || "")) {
    await showWarningCard("Gmail required", "A valid Gmail address is required before this user can receive an OTP code.");
    return;
  }

  resetManagedPasswordResetFlow();
  state.userPasswordReset.account = {
    username: account.username,
    name: getManagedAccountName(account),
    email: account.email,
  };
  state.userPasswordReset.email = account.email;
  setManagedPasswordResetStep(1);
  app.userPasswordResetPanel.hidden = false;
  app.userPasswordResetPanel.setAttribute("aria-hidden", "false");
  window.setTimeout(() => app.userPasswordResetOldInput?.focus(), 0);
}

function closeManagedPasswordResetPanel({ restoreFocus = true } = {}) {
  if (!app.userPasswordResetPanel) return;
  app.userPasswordResetPanel.hidden = true;
  app.userPasswordResetPanel.setAttribute("aria-hidden", "true");
  resetManagedPasswordResetFlow();
  if (restoreFocus) {
    window.setTimeout(() => app.userDetailResetPasswordButton?.focus(), 0);
  }
}

function openManagedUserDetailModal() {
  if (!app.userDetailModal || !state.managedUserSelection) return;
  app.userDetailModal.hidden = false;
  app.userDetailModal.setAttribute("aria-hidden", "false");
  // This card's icons live in the page markup and nothing else hydrates them,
  // so they stayed as empty spans every time the dialog opened. Draw them here;
  // hydrateIcons skips anything already drawn, so reopening costs nothing.
  hydrateIcons(app.userDetailModal);
  syncModalOpenState();
  window.setTimeout(() => app.userDetailCloseButton?.focus(), 0);
}

function closeManagedUserDetailModal({ clearSelection = true } = {}) {
  if (!app.userDetailModal) return;
  closeManagedPasswordResetPanel({ restoreFocus: false });
  app.userDetailModal.hidden = true;
  app.userDetailModal.setAttribute("aria-hidden", "true");
  if (clearSelection) {
    state.managedUserSelection = "";
    syncManagedUserSelection();
  }
  syncModalOpenState();
}

// The three tabs above the users table are a filter: the counts stay whole
// while the rows below follow whichever tab is selected.
const MANAGED_USER_STATUS_FILTERS = ["all", "active", "inactive"];

const MANAGED_USER_EMPTY_MESSAGES = {
  all: "No SmartDuck accounts yet.",
  active: "No active SmartDuck accounts.",
  inactive: "No inactive SmartDuck accounts.",
};

function getManagedUsersStatusFilter() {
  return MANAGED_USER_STATUS_FILTERS.includes(state.managedUsersStatusFilter)
    ? state.managedUsersStatusFilter
    : "all";
}

function filterManagedAccountsByStatus(accounts, statusFilter) {
  if (statusFilter === "active") return accounts.filter((account) => account.active !== false);
  if (statusFilter === "inactive") return accounts.filter((account) => account.active === false);
  return accounts;
}

function syncManagedUserStatusTabs() {
  const statusFilter = getManagedUsersStatusFilter();
  document.querySelectorAll("[data-users-status-filter]").forEach((tab) => {
    const isSelected = (tab.dataset.usersStatusFilter || "all") === statusFilter;
    tab.classList.toggle("is-active", isSelected);
    tab.setAttribute("aria-selected", isSelected ? "true" : "false");
  });
}

function bindManagedUserStatusTabs() {
  document.querySelectorAll("[data-users-status-filter]").forEach((tab) => {
    if (tab.dataset.usersStatusTabBound === "true") return;
    tab.dataset.usersStatusTabBound = "true";
    tab.addEventListener("click", async () => {
      const nextFilter = tab.dataset.usersStatusFilter || "all";
      if (nextFilter === getManagedUsersStatusFilter()) return;
      state.managedUsersStatusFilter = nextFilter;
      state.managedUsersPagination.page = 1;
      syncManagedUserStatusTabs();
      await renderUsersTable();
    });
  });
}

async function renderUsersTable() {
  if (!isUsersScreen() || !app.usersTableBody) return;
  const accounts = await getAccounts();
  if (!isUsersScreen() || !app.usersTableBody) return;
  const orderedAccounts = [...accounts].sort((left, right) => {
    if (left.role === "admin" && right.role !== "admin") return -1;
    if (left.role !== "admin" && right.role === "admin") return 1;
    // Sort by what the column actually shows. Ordering by a display name the
    // table no longer renders reads as no order at all.
    return String(left.username).localeCompare(String(right.username));
  });

  if (app.usersCountBadge) {
    const count = orderedAccounts.length;
    app.usersCountBadge.textContent = `${count} ${count === 1 ? "User" : "Users"}`;
  }

  if (orderedAccounts.length === 0) {
    state.managedUserSelection = "";
    state.managedUsersPagination.page = 1;
    closeManagedUserDetailModal();
    app.usersTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">No SmartDuck accounts yet.</td>
      </tr>
    `;
    renderManagedUsersPanels([]);
    renderManagedUsersPagination(0);
    return;
  }

  if (!orderedAccounts.some((account) => account.username === state.managedUserSelection)) {
    state.managedUserSelection = "";
    closeManagedUserDetailModal();
  }

  // Counts, delete rules and the detail panel keep reading every account; only
  // the rows in the table follow the selected tab.
  const statusFilter = getManagedUsersStatusFilter();
  const visibleAccounts = filterManagedAccountsByStatus(orderedAccounts, statusFilter);

  if (visibleAccounts.length === 0) {
    state.managedUsersPagination.page = 1;
    app.usersTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">${MANAGED_USER_EMPTY_MESSAGES[statusFilter]}</td>
      </tr>
    `;
    renderManagedUsersPanels(orderedAccounts);
    renderManagedUsersPagination(0);
    return;
  }

  const pageSize = state.managedUsersPagination.pageSize;
  const totalPages = Math.max(1, Math.ceil(visibleAccounts.length / pageSize));
  state.managedUsersPagination.page = Math.min(Math.max(1, state.managedUsersPagination.page), totalPages);
  const page = state.managedUsersPagination.page;
  const startIndex = (page - 1) * pageSize;
  const pageAccounts = visibleAccounts.slice(startIndex, startIndex + pageSize);

  app.usersTableBody.innerHTML = pageAccounts
    .map((account) => {
      const roleLabel = getManagedAccountRole(account);
      const statusLabel = getManagedAccountStatus(account);
      const deleteBlockReason = getDeleteBlockReason(account, orderedAccounts);
      // The row shows the username now, so the tooltip names what the operator
      // is actually looking at rather than a display name no column carries.
      const deleteTitle = deleteBlockReason || `Delete ${account.username}`;
      const roleTone = getManagedRoleTone(roleLabel);
      const isSelected = account.username === state.managedUserSelection;
      return `
        <tr class="users-table__row${isSelected ? " is-selected" : ""}" data-managed-user-select="${escapeHtml(account.username)}">
          <td class="users-table__username">
            <span class="table-flex users-table__name">
              ${renderManagedTableAvatar(account)}
              <span class="table-strong">${escapeHtml(account.username)}</span>
            </span>
          </td>
          <td><span class="users-role-pill users-role-pill--${roleTone}">${escapeHtml(roleLabel)}</span></td>
          <td><span class="users-status users-status--${escapeHtml(statusLabel.toLowerCase())}">${escapeHtml(statusLabel)}</span></td>
          <td>${formatAccountLastLogin(account.lastLoginAt)}</td>
          <td>${formatAccountCreatedDate(account.createdAt)}</td>
          <td>
            <div class="action-row users-table__actions">
              <button
                class="icon-button icon-button--red users-table__action-button${deleteBlockReason ? " icon-button--disabled" : ""}"
                type="button"
                data-managed-user-action="delete"
                data-managed-user-username="${escapeHtml(account.username)}"
                title="${escapeHtml(deleteTitle)}"
                aria-label="${escapeHtml(deleteTitle)}"
                aria-disabled="${deleteBlockReason ? "true" : "false"}"
                ${deleteBlockReason ? "disabled" : ""}
              ><span data-icon="trash"></span></button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  hydrateIcons(app.usersTableBody);
  bindManagedUserActions();
  bindManagedUserSelection(orderedAccounts);
  renderManagedUsersPanels(orderedAccounts);
  renderManagedUsersPagination(visibleAccounts.length);
}

function setManagedUserPanelContent(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function renderManagedUsersPanels(accounts) {
  const totalUsers = accounts.length;
  const activeUsers = accounts.filter((account) => account.active !== false).length;
  const inactiveUsers = totalUsers - activeUsers;
  const uniqueRoles = new Set(accounts.map((account) => getManagedAccountRole(account))).size;

  setManagedUserPanelContent("users-metric-total", `${totalUsers}`);
  setManagedUserPanelContent("users-metric-active", `${activeUsers}`);
  setManagedUserPanelContent("users-metric-inactive", `${inactiveUsers}`);
  setManagedUserPanelContent("users-metric-roles", `${uniqueRoles}`);
  setManagedUserPanelContent("users-metric-permissions", "--");
  setManagedUserPanelContent("users-tab-all", `All Users (${totalUsers})`);
  setManagedUserPanelContent("users-tab-active", `Active (${activeUsers})`);
  setManagedUserPanelContent("users-tab-inactive", `Inactive (${inactiveUsers})`);
  syncManagedUserStatusTabs();

  const selectedAccount = accounts.find((account) => account.username === state.managedUserSelection) || null;
  if (!selectedAccount && !app.userDetailModal?.hidden) {
    closeManagedUserDetailModal({ clearSelection: false });
  }

  renderManagedUserDetail(selectedAccount, accounts);
  renderManagedUserRoleSummary(accounts);
  renderManagedUserActivity(accounts);
  syncManagedUserSelection();
}

function renderManagedUsersPagination(totalUsers) {
  const pagination = document.querySelector(".users-management-pagination");
  const footnote = document.getElementById("users-table-footnote");
  if (!pagination || !footnote) return;

  const pageSize = state.managedUsersPagination.pageSize;
  const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize));
  state.managedUsersPagination.page = Math.min(Math.max(1, state.managedUsersPagination.page), totalPages);
  const page = state.managedUsersPagination.page;
  const start = totalUsers ? (page - 1) * pageSize + 1 : 0;
  const end = totalUsers ? Math.min(totalUsers, page * pageSize) : 0;

  footnote.textContent = totalUsers ? `Showing ${start} to ${end} of ${totalUsers} users` : "No users available";

  const shouldPaginate = totalUsers > pageSize;
  pagination.hidden = !shouldPaginate;
  if (!shouldPaginate) {
    pagination.innerHTML = "";
    return;
  }

  const pageButtons = Array.from({ length: totalPages }, (_, index) => {
    const pageNumber = index + 1;
    return `
      <button
        type="button"
        class="users-management-pagination__button${pageNumber === page ? " is-active" : ""}"
        data-users-page="${pageNumber}"
        ${pageNumber === page ? 'aria-current="page"' : ""}
      >${pageNumber}</button>
    `;
  }).join("");

  pagination.innerHTML = `
    <button type="button" class="users-management-pagination__button" data-users-page="${page - 1}" aria-label="Previous page" ${page <= 1 ? "disabled" : ""}>
      <span data-icon="chevron-right" class="is-rotated"></span>
    </button>
    ${pageButtons}
    <button type="button" class="users-management-pagination__button" data-users-page="${page + 1}" aria-label="Next page" ${page >= totalPages ? "disabled" : ""}>
      <span data-icon="chevron-right"></span>
    </button>
  `;

  hydrateIcons(pagination);
  pagination.querySelectorAll("[data-users-page]").forEach((button) => {
    if (button.dataset.usersPaginationBound === "true") return;
    button.dataset.usersPaginationBound = "true";
    button.addEventListener("click", async () => {
      const nextPage = Number(button.dataset.usersPage || "1");
      if (!Number.isFinite(nextPage) || nextPage === state.managedUsersPagination.page) return;
      state.managedUsersPagination.page = Math.min(Math.max(1, nextPage), totalPages);
      await renderUsersTable();
    });
  });
}

function renderManagedUserDetail(account, accounts = []) {
  const permissionsContainer = document.getElementById("user-detail-permissions");
  if (!account) {
    if (app.userDetailAvatar) {
      app.userDetailAvatar.classList.remove("has-image");
      app.userDetailAvatar.textContent = "--";
    }
    setManagedUserPanelContent("user-detail-name", "No user selected");
    setManagedUserPanelContent("user-detail-role-copy", "--");
    setManagedUserPanelContent("user-detail-username-card", "--");
    setManagedUserPanelContent("user-detail-status", "Unavailable");
    setManagedUserPanelContent("user-detail-role", "--");
    setManagedUserPanelContent("user-detail-email", "--");
    setManagedUserPanelContent("user-detail-created", "--");
    setManagedUserPanelContent("user-detail-last-login", "--");
    if (app.userDetailResetPasswordButton) {
      app.userDetailResetPasswordButton.disabled = true;
    }
    if (app.userDetailDeactivateButton) {
      app.userDetailDeactivateButton.disabled = true;
      app.userDetailDeactivateButton.title = "Select a SmartDuck user first.";
      app.userDetailDeactivateButton.setAttribute("aria-disabled", "true");
    }
    if (app.userDetailAvatarButton) {
      app.userDetailAvatarButton.disabled = true;
    }
    if (permissionsContainer) permissionsContainer.innerHTML = "";
    return;
  }

  const roleLabel = getManagedAccountRole(account);
  const statusLabel = getManagedAccountStatus(account);
  const deactivateBlockReason = getDeactivateBlockReason(account, accounts);

  renderManagedDetailAvatar(account);
  setManagedUserPanelContent("user-detail-name", getManagedAccountName(account));
  setManagedUserPanelContent("user-detail-role-copy", roleLabel);
  setManagedUserPanelContent("user-detail-username-card", account.username);
  setManagedUserPanelContent("user-detail-status", statusLabel);
  setManagedUserPanelContent("user-detail-role", roleLabel);
  setManagedUserPanelContent("user-detail-email", account.email || "Not set");
  setManagedUserPanelContent("user-detail-created", formatAccountDateDisplay(account.createdAt, { includeTime: true, fallback: "Not available" }));
  setManagedUserPanelContent("user-detail-last-login", formatAccountLastLogin(account.lastLoginAt));
  if (app.userDetailResetPasswordButton) {
    app.userDetailResetPasswordButton.disabled = false;
  }
  if (app.userDetailDeactivateButton) {
    app.userDetailDeactivateButton.disabled = Boolean(deactivateBlockReason);
    app.userDetailDeactivateButton.title = deactivateBlockReason || `Deactivate ${getManagedAccountName(account)}`;
    app.userDetailDeactivateButton.setAttribute("aria-disabled", deactivateBlockReason ? "true" : "false");
  }
  if (app.userDetailAvatarButton) {
    app.userDetailAvatarButton.disabled = false;
  }

  const statusNode = document.getElementById("user-detail-status");
  if (statusNode) {
    statusNode.classList.toggle("is-inactive", statusLabel === "Inactive");
  }

  if (permissionsContainer) {
    permissionsContainer.innerHTML = getManagedUserPermissions(account)
      .map(
        (permission) => `
          <li class="users-detail-permission">
            <span class="users-detail-permission__icon">${renderIcon("check-circle")}</span>
            <span>${escapeHtml(permission)}</span>
          </li>
        `,
      )
      .join("");
    hydrateIcons(permissionsContainer);
  }
}

function renderManagedUserRoleSummary(accounts) {
  const container = document.getElementById("users-role-summary-grid");
  if (!container) return;

  const roleOrder = ["Administrator", "Supervisor", "Operator"];
  const totalUsers = Math.max(accounts.length, 1);
  container.innerHTML = roleOrder
    .map((roleLabel) => {
      const count = accounts.filter((account) => getManagedAccountRole(account) === roleLabel).length;
      const percentage = accounts.length ? ((count / totalUsers) * 100).toFixed(1) : "0.0";
      const tone = getManagedRoleTone(roleLabel);
      return `
        <article class="users-role-card">
          <span class="users-role-card__icon users-role-card__icon--${tone}">${renderIcon(
            roleLabel === "Administrator" ? "shield" : roleLabel === "Supervisor" ? "users" : "user",
          )}</span>
          <div>
            <p class="users-role-card__label">${escapeHtml(roleLabel)}</p>
            <p class="users-role-card__value">${count}</p>
            <p class="users-role-card__meta">${percentage}%</p>
          </div>
        </article>
      `;
    })
    .join("");
  hydrateIcons(container);
}

function renderManagedUserActivity(accounts) {
  const container = document.getElementById("users-activity-list");
  if (!container) return;

  const items = [...accounts]
    .map((account) => {
      const createdAt = account.createdAt ? new Date(account.createdAt).getTime() : 0;
      const lastLoginAt = account.lastLoginAt ? new Date(account.lastLoginAt).getTime() : 0;
      const latestAt = Math.max(createdAt, lastLoginAt);
      let action = "New user registered";
      let icon = "plus";
      let tone = "green";
      if (account.active === false) {
        action = "Account deactivated";
        icon = "power";
        tone = "red";
      } else if (lastLoginAt >= createdAt && lastLoginAt > 0) {
        action = "Last login recorded";
        icon = "history";
        tone = "blue";
      }
      return {
        name: getManagedAccountName(account),
        action,
        icon,
        tone,
        timestamp: latestAt,
        displayTime: formatAccountDateDisplay(latestAt || account.createdAt, { includeTime: true, fallback: "No activity" }),
      };
    })
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, 4);

  container.innerHTML = items.length
    ? items
      .map(
        (item) => `
          <article class="users-activity-item">
            <span class="users-activity-item__icon users-activity-item__icon--${item.tone}">${renderIcon(item.icon)}</span>
            <div class="users-activity-item__content">
              <p class="users-activity-item__name">${escapeHtml(item.name)}</p>
              <p class="users-activity-item__action">${escapeHtml(item.action)}</p>
            </div>
            <span class="users-activity-item__time">${escapeHtml(item.displayTime)}</span>
          </article>
        `,
      )
      .join("")
    : '<p class="users-activity-empty">No recent user activity available.</p>';
  hydrateIcons(container);
}

function syncManagedUserSelection() {
  app.usersTableBody?.querySelectorAll("[data-managed-user-select]").forEach((row) => {
    row.classList.toggle("is-selected", row.dataset.managedUserSelect === state.managedUserSelection);
  });
}

function bindManagedUserSelection(accounts) {
  app.usersTableBody?.querySelectorAll("[data-managed-user-select]").forEach((row) => {
    if (row.dataset.userSelectionBound === "true") return;
    row.dataset.userSelectionBound = "true";
    row.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-managed-user-action]")) return;
      state.managedUserSelection = row.dataset.managedUserSelect || "";
      renderManagedUsersPanels(accounts);
      openManagedUserDetailModal();
    });
  });
}

async function handleManagedUserAction(button) {
  const username = button.dataset.managedUserUsername || "";
  const action = button.dataset.managedUserAction || "";
  if (!username || !action) return;

  const accounts = await getAccounts();
  const account = accounts.find(
    (entry) => String(entry.username || "").trim().toLowerCase() === username.trim().toLowerCase(),
  ) || null;
  if (!account) {
    await showWarningCard("Account missing", "The selected SmartDuck account could not be found.");
    await renderUsersTable();
    return;
  }

  if (action === "delete") {
    const deleteBlockReason = getDeleteBlockReason(account, accounts);
    if (deleteBlockReason) {
      await showWarningCard("Protected account", deleteBlockReason);
      return;
    }

    const result = await openActionDialog({
      eyebrow: "SmartDuck User Delete",
      title: "Delete account",
      body: `Delete ${getManagedAccountName(account)} from SmartDuck?`,
      confirmLabel: "Delete",
      cancelLabel: "Keep",
    });
    if (!result.confirmed) return;

    await removeAccountByUsername(account.username);
    await renderUsersTable();
    showToast("Account deleted", `${account.username} has been removed.`);
    return;
  }

  if (action === "edit") {
    if (getManagedAccountRole(account) === "Administrator") {
      await showWarningCard("Protected account", "Administrator access is fixed in this screen.");
      return;
    }

    const result = await openActionDialog({
      eyebrow: "SmartDuck Role Update",
      title: "Edit account role",
      body: `Type Supervisor or Operator for ${account.username}.`,
      confirmLabel: "Save",
      cancelLabel: "Cancel",
      mode: "prompt",
      initialValue: getManagedAccountRole(account),
      placeholder: "Supervisor or Operator",
    });
    if (!result.confirmed) return;

    const nextRole = normalizeManagedRole(result.value);
    if (!nextRole) {
      await showWarningCard("Invalid role", "Use only Supervisor or Operator.");
      return;
    }

    await updateAccountRecord(account.username, {
      accountRole: nextRole,
      role: mapManagedRoleToSystemRole(nextRole),
    });
    await renderUsersTable();
    showToast("Account updated", `${account.username} is now set as ${nextRole}.`);
  }
}

function bindManagedUserActions() {
  app.usersTableBody?.querySelectorAll("[data-managed-user-action]").forEach((button) => {
    if (button.dataset.userBound === "true") return;
    button.dataset.userBound = "true";
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled || button.getAttribute("aria-disabled") === "true") {
        return;
      }
      await handleManagedUserAction(button);
    });
  });
}

async function handleManagedUserDeactivate() {
  const account = await getManagedAccountByUsername(state.managedUserSelection);
  if (!account) {
    await showWarningCard("Account missing", "The selected SmartDuck account could not be found.");
    return;
  }

  const accounts = await getAccounts();
  const deactivateBlockReason = getDeactivateBlockReason(account, accounts);
  if (deactivateBlockReason) {
    await showWarningCard("Protected account", deactivateBlockReason);
    return;
  }

  const result = await openActionDialog({
    eyebrow: "SmartDuck User Status",
    title: "Deactivate account",
    body: `Deactivate ${getManagedAccountName(account)} and prevent this user from signing in?`,
    confirmLabel: "Deactivate",
    cancelLabel: "Keep Active",
  });
  if (!result.confirmed) return;

  await updateAccountRecord(account.username, { active: false });
  await renderUsersTable();
  showToast("Account deactivated", `${account.username} has been set to inactive.`);
}

async function handleManagedPasswordResetDetailsSubmit(event) {
  event.preventDefault();
  if (!app.userPasswordResetDetailsForm) return;

  const account = state.userPasswordReset.account || await getManagedAccountByUsername(state.managedUserSelection);
  const currentPassword = app.userPasswordResetOldInput?.value || "";
  const nextPassword = app.userPasswordResetNewInput?.value || "";
  const confirmPassword = app.userPasswordResetConfirmInput?.value || "";
  const submitButton = app.userPasswordResetDetailsForm.querySelector('button[type="submit"]');

  clearFormInvalidState(app.userPasswordResetDetailsForm);

  if (!account) {
    closeManagedPasswordResetPanel({ restoreFocus: false });
    await showWarningCard("Account missing", "The selected SmartDuck account could not be found.");
    return;
  }

  if (!currentPassword) {
    setInputInvalid(app.userPasswordResetOldInput, true);
    await showWarningCard("Old password required", "Enter the current password before requesting an OTP code.", app.userPasswordResetOldInput);
    return;
  }

  if (!nextPassword) {
    setInputInvalid(app.userPasswordResetNewInput, true);
    await showWarningCard("New password required", "Create the new password for this SmartDuck account.", app.userPasswordResetNewInput);
    return;
  }

  const passwordPolicy = evaluatePasswordPolicy(nextPassword, {
    username: account.username,
    email: account.email,
  });
  if (!passwordPolicy.valid) {
    setInputInvalid(app.userPasswordResetNewInput, true);
    await showWarningCard("Password is not secure yet", firstCredentialPolicyError(passwordPolicy), app.userPasswordResetNewInput);
    return;
  }

  if (!confirmPassword) {
    setInputInvalid(app.userPasswordResetConfirmInput, true);
    await showWarningCard("Confirm your password", "Re-enter the new password in the confirm password field.", app.userPasswordResetConfirmInput);
    return;
  }

  if (nextPassword !== confirmPassword) {
    setInputInvalid(app.userPasswordResetNewInput, true);
    setInputInvalid(app.userPasswordResetConfirmInput, true);
    await showWarningCard("Passwords do not match", "The new password and confirm password must be the same.", app.userPasswordResetNewInput);
    return;
  }

  if (currentPassword === nextPassword) {
    setInputInvalid(app.userPasswordResetNewInput, true);
    await showWarningCard("Choose a different password", "The new password must be different from the old password.", app.userPasswordResetNewInput);
    return;
  }

  if (submitButton) submitButton.disabled = true;

  state.userPasswordReset.account = account;
  state.userPasswordReset.email = account.email;
  state.userPasswordReset.currentPassword = currentPassword;
  state.userPasswordReset.pendingPassword = nextPassword;
  hideManagedPasswordResetOtpAlert();
  hideManagedPasswordResetDevOtp();
  clearManagedPasswordResetOtpInputs();
  state.userPasswordReset.isSendingOtp = true;
  if (submitButton) submitButton.textContent = "Sending OTP...";

  try {
    const payload = await requestOtpDelivery(account.email, OTP_PURPOSE_PASSWORD_RESET);
    setManagedPasswordResetStep(2);
    setManagedPasswordResetOtpRequestState(false);
    applyManagedPasswordResetOtpDelivery(payload, account.email);
    getManagedPasswordResetOtpInputs()[0]?.focus();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send OTP code.";
    await showWarningCard("OTP send failed", message, app.userPasswordResetNewInput);
  } finally {
    state.userPasswordReset.isSendingOtp = false;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Next";
    }
  }
}

async function handleManagedPasswordResetOtpSubmit(event) {
  event.preventDefault();
  if (!app.userPasswordResetOtpForm || !state.userPasswordReset.account) return;

  if (state.userPasswordReset.isSendingOtp) {
    showManagedPasswordResetOtpAlert("OTP still sending", "Wait for the current OTP request to finish before verifying.");
    return;
  }

  const otpCode = readManagedPasswordResetOtpValue();
  const submitButton = app.userPasswordResetOtpForm.querySelector('button[type="submit"]');
  hideManagedPasswordResetOtpAlert();

  if (otpCode.length !== 6) {
    showManagedPasswordResetOtpAlert("OTP required", "Enter the full 6-digit OTP code before updating the password.");
    getManagedPasswordResetOtpInputs()[0]?.focus();
    return;
  }

  if (submitButton) submitButton.disabled = true;

  try {
    const otpResult = await verifyOtpCode(state.userPasswordReset.email, otpCode);
    if (!otpResult.success) {
      showManagedPasswordResetOtpAlert("Incorrect OTP code", "Please try again using the latest 6-digit code.");
      getManagedPasswordResetOtpInputs()[0]?.focus();
      return;
    }

    const accountLabel = state.userPasswordReset.account.name || state.userPasswordReset.account.username;
    await updateAccountPassword(
      state.userPasswordReset.account.username,
      state.userPasswordReset.pendingPassword,
      state.userPasswordReset.currentPassword,
    );
    await renderUsersTable();
    closeManagedPasswordResetPanel({ restoreFocus: false });
    showToast("Password updated", `${accountLabel} can now sign in using the new password.`);
    window.setTimeout(() => app.userDetailCloseButton?.focus(), 0);
  } catch (error) {
    if (error instanceof Error && error.status === 401) {
      setManagedPasswordResetStep(1);
      setInputInvalid(app.userPasswordResetOldInput, true);
      await showWarningCard("Incorrect old password", error.message, app.userPasswordResetOldInput);
      return;
    }
    const message = error instanceof Error ? error.message : "Unable to update the password.";
    await showWarningCard("Password reset failed", message, getManagedPasswordResetOtpInputs()[0] || null);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function bindManagedPasswordResetOtpInputs() {
  getManagedPasswordResetOtpInputs().forEach((input, index, inputs) => {
    if (input.dataset.userPasswordResetOtpBound === "true") return;
    input.dataset.userPasswordResetOtpBound = "true";

    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 1);
      hideManagedPasswordResetOtpAlert();
      if (input.value && index < inputs.length - 1) {
        inputs[index + 1].focus();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        inputs[index - 1].focus();
      }
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        inputs[index - 1].focus();
      }
      if (event.key === "ArrowRight" && index < inputs.length - 1) {
        event.preventDefault();
        inputs[index + 1].focus();
      }
    });
  });
}

async function handleUserSetupDetailsSubmit(event) {
  event.preventDefault();
  if (!app.userSetupDetailsForm) return;

  const username = app.userSetupUsernameInput?.value.trim() || "";
  const email = (app.userSetupEmailInput?.value || "").trim().toLowerCase();
  const roleLabel = normalizeManagedRole(app.userSetupRoleInput?.value || "");
  const password = app.userSetupPasswordInput?.value || "";
  const confirmPassword = app.userSetupPasswordConfirmInput?.value || "";
  const submitButton = app.userSetupDetailsForm.querySelector('button[type="submit"]');

  clearFormInvalidState(app.userSetupDetailsForm);

  if (!username) {
    setInputInvalid(app.userSetupUsernameInput, true);
    await showWarningCard("Username required", "Enter a username for the new SmartDuck account.", app.userSetupUsernameInput);
    return;
  }

  const usernamePolicy = evaluateUsernamePolicy(username);
  if (!usernamePolicy.valid) {
    setInputInvalid(app.userSetupUsernameInput, true);
    await showWarningCard("Username is not secure yet", firstCredentialPolicyError(usernamePolicy), app.userSetupUsernameInput);
    return;
  }

  if (!email) {
    setInputInvalid(app.userSetupEmailInput, true);
    await showWarningCard("Gmail required", "Enter the Gmail address for the new SmartDuck account.", app.userSetupEmailInput);
    return;
  }

  if (!isValidGmailAddress(email)) {
    setInputInvalid(app.userSetupEmailInput, true);
    await showWarningCard("Invalid Gmail", "Use a valid Gmail address ending in @gmail.com.", app.userSetupEmailInput);
    return;
  }

  if (!roleLabel) {
    setInputInvalid(app.userSetupRoleInput, true);
    await showWarningCard("Role required", "Choose either Supervisor or Operator.", app.userSetupRoleInput);
    return;
  }

  if (!password) {
    setInputInvalid(app.userSetupPasswordInput, true);
    await showWarningCard("Password required", "Create a password for the new SmartDuck account.", app.userSetupPasswordInput);
    return;
  }

  const passwordPolicy = evaluatePasswordPolicy(password, { username, email });
  if (!passwordPolicy.valid) {
    setInputInvalid(app.userSetupPasswordInput, true);
    await showWarningCard("Password is not secure yet", firstCredentialPolicyError(passwordPolicy), app.userSetupPasswordInput);
    return;
  }

  if (!confirmPassword) {
    setInputInvalid(app.userSetupPasswordConfirmInput, true);
    await showWarningCard("Confirm your password", "Re-enter the password in the confirm password field.", app.userSetupPasswordConfirmInput);
    return;
  }

  if (password !== confirmPassword) {
    setInputInvalid(app.userSetupPasswordInput, true);
    setInputInvalid(app.userSetupPasswordConfirmInput, true);
    await showWarningCard("Passwords do not match", "The password and confirm password must be the same.", app.userSetupPasswordInput);
    return;
  }

  if (await findAccountByUsername(username)) {
    setInputInvalid(app.userSetupUsernameInput, true);
    await showWarningCard("Username already used", "Choose a different username for this SmartDuck account.", app.userSetupUsernameInput);
    return;
  }

  if (await findAccountByEmail(email)) {
    setInputInvalid(app.userSetupEmailInput, true);
    await showWarningCard("Email already used", "That Gmail address is already linked to another SmartDuck account.", app.userSetupEmailInput);
    return;
  }

  if (submitButton) submitButton.disabled = true;

  // A new account starts without a contact number; the owner adds one from
  // their profile if they want it.
  state.userSetup.pendingAccount = {
    username,
    name: username,
    email,
    password,
    role: mapManagedRoleToSystemRole(roleLabel),
    accountRole: roleLabel,
    active: true,
    createdAt: new Date().toISOString(),
    lastLoginAt: "",
  };
  state.userSetup.email = email;
  hideUserSetupOtpAlert();
  hideUserSetupDevOtp();
  clearUserSetupOtpInputs();
  state.userSetup.isSendingOtp = true;
  if (submitButton) submitButton.textContent = "Sending OTP...";

  try {
    const payload = await requestOtpDelivery(email, OTP_PURPOSE_ACCOUNT_VERIFICATION);
    setUserSetupStep(2);
    setUserSetupOtpRequestState(false);
    applyUserSetupOtpDelivery(payload, email);
    getUserSetupOtpInputs()[0]?.focus();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send OTP code.";
    await showWarningCard("OTP send failed", message, app.userSetupEmailInput);
  } finally {
    state.userSetup.isSendingOtp = false;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Next";
    }
  }
}

async function handleUserSetupOtpSubmit(event) {
  event.preventDefault();
  if (!app.userSetupOtpForm || !state.userSetup.pendingAccount) return;

  if (state.userSetup.isSendingOtp) {
    showUserSetupOtpAlert("OTP still sending", "Wait for the current OTP request to finish before verifying.");
    return;
  }

  const otpCode = readUserSetupOtpValue();
  const submitButton = app.userSetupOtpForm.querySelector('button[type="submit"]');
  hideUserSetupOtpAlert();

  if (otpCode.length !== 6) {
    showUserSetupOtpAlert("OTP required", "Enter the full 6-digit OTP code before creating the account.");
    getUserSetupOtpInputs()[0]?.focus();
    return;
  }

  if (submitButton) submitButton.disabled = true;

  try {
    const otpResult = await verifyOtpCode(
      state.userSetup.email,
      otpCode,
      OTP_PURPOSE_ACCOUNT_VERIFICATION,
    );
    if (!otpResult.success) {
      showUserSetupOtpAlert("Incorrect OTP code", "Please try again using the latest 6-digit code.");
      getUserSetupOtpInputs()[0]?.focus();
      return;
    }

    if (await findAccountByUsername(state.userSetup.pendingAccount.username)) {
      await showWarningCard("Username already used", "The username was taken while waiting for OTP. Use another one.");
      setUserSetupStep(1);
      return;
    }

    if (await findAccountByEmail(state.userSetup.pendingAccount.email)) {
      await showWarningCard("Email already used", "The Gmail address is already linked to another SmartDuck account.");
      setUserSetupStep(1);
      return;
    }

    const createdAccount = await createAccount(state.userSetup.pendingAccount);
    closeUserSetupModal();
    await renderUsersTable();
    showToast("Account created", `${createdAccount?.username || state.userSetup.pendingAccount.username} is ready to sign in.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to verify OTP code.";
    await showWarningCard("OTP verification failed", message, getUserSetupOtpInputs()[0] || null);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function bindUserSetupOtpInputs() {
  getUserSetupOtpInputs().forEach((input, index, inputs) => {
    if (input.dataset.userOtpBound === "true") return;
    input.dataset.userOtpBound = "true";

    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 1);
      hideUserSetupOtpAlert();
      if (input.value && index < inputs.length - 1) {
        inputs[index + 1].focus();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        inputs[index - 1].focus();
      }
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        inputs[index - 1].focus();
      }
      if (event.key === "ArrowRight" && index < inputs.length - 1) {
        event.preventDefault();
        inputs[index + 1].focus();
      }
    });
  });
}

function initializeUserManagement() {
  if (!isUsersScreen()) return;

  initializePasswordToggles();
  bindManagedUserStatusTabs();
  bindUserSetupOtpInputs();
  bindManagedPasswordResetOtpInputs();
  bindCredentialSecurityGuides(app.userSetupModal || document);
  bindCredentialSecurityGuides(app.userPasswordResetPanel || document);

  [app.userSetupUsernameInput, app.userSetupEmailInput, app.userSetupRoleInput, app.userSetupPasswordInput, app.userSetupPasswordConfirmInput].forEach((input) => {
    input?.addEventListener("input", () => setInputInvalid(input, false));
    input?.addEventListener("change", () => setInputInvalid(input, false));
  });

  [app.userPasswordResetOldInput, app.userPasswordResetNewInput, app.userPasswordResetConfirmInput].forEach((input) => {
    input?.addEventListener("input", () => setInputInvalid(input, false));
    input?.addEventListener("change", () => setInputInvalid(input, false));
  });

  app.openUserSetupButton?.addEventListener("click", openUserSetupModal);
  app.userDetailBackdrop?.addEventListener("click", () => closeManagedUserDetailModal());
  app.userDetailCloseButton?.addEventListener("click", () => closeManagedUserDetailModal());
  app.userDetailAvatarButton?.addEventListener("click", () => {
    app.userDetailAvatarInput?.click();
  });
  app.userDetailAvatarInput?.addEventListener("change", (event) => {
    void handleManagedUserAvatarSelection(event);
  });
  app.userDetailResetPasswordButton?.addEventListener("click", () => {
    void openManagedPasswordResetPanel();
  });
  app.userDetailDeactivateButton?.addEventListener("click", () => {
    void handleManagedUserDeactivate();
  });
  app.userPasswordResetBackdrop?.addEventListener("click", () => closeManagedPasswordResetPanel());
  app.userPasswordResetCloseButton?.addEventListener("click", () => closeManagedPasswordResetPanel());
  app.userPasswordResetCancelButton?.addEventListener("click", () => closeManagedPasswordResetPanel());
  app.userPasswordResetStepTwoCancelButton?.addEventListener("click", () => closeManagedPasswordResetPanel());
  app.userSetupBackdrop?.addEventListener("click", closeUserSetupModal);
  app.userSetupCloseButton?.addEventListener("click", closeUserSetupModal);
  app.userSetupCancelButton?.addEventListener("click", closeUserSetupModal);
  app.userSetupBackButton?.addEventListener("click", () => {
    hideUserSetupOtpAlert();
    hideUserSetupOtpStatus();
    setUserSetupStep(1);
    app.userSetupPasswordInput?.focus();
  });
  app.userPasswordResetDetailsForm?.addEventListener("submit", handleManagedPasswordResetDetailsSubmit);
  app.userPasswordResetOtpForm?.addEventListener("submit", handleManagedPasswordResetOtpSubmit);
  app.userPasswordResetResendButton?.addEventListener("click", async () => {
    if (!state.userPasswordReset.email) return;
    hideManagedPasswordResetOtpAlert();
    hideManagedPasswordResetDevOtp();
    clearManagedPasswordResetOtpInputs();
    showManagedPasswordResetOtpStatus("Sending OTP", `Preparing a fresh verification code for ${state.userPasswordReset.email}.`);
    setManagedPasswordResetOtpRequestState(true);
    try {
      const payload = await requestOtpDelivery(state.userPasswordReset.email, OTP_PURPOSE_PASSWORD_RESET);
      applyManagedPasswordResetOtpDelivery(payload, state.userPasswordReset.email);
      if (payload?.deliveryMode !== "development") {
        showToast("OTP resent", `A new OTP was sent to ${state.userPasswordReset.email}.`);
      }
      getManagedPasswordResetOtpInputs()[0]?.focus();
    } catch (error) {
      hideManagedPasswordResetOtpStatus();
      const message = error instanceof Error ? error.message : "Unable to resend OTP code.";
      showManagedPasswordResetOtpAlert("OTP resend failed", message);
      getManagedPasswordResetOtpInputs()[0]?.focus();
    } finally {
      setManagedPasswordResetOtpRequestState(false);
    }
  });
  app.userSetupDetailsForm?.addEventListener("submit", handleUserSetupDetailsSubmit);
  app.userSetupOtpForm?.addEventListener("submit", handleUserSetupOtpSubmit);
  app.userSetupResendButton?.addEventListener("click", async () => {
    if (!state.userSetup.email) return;
    hideUserSetupOtpAlert();
    hideUserSetupDevOtp();
    clearUserSetupOtpInputs();
    showUserSetupOtpStatus("Sending OTP", `Preparing a fresh verification code for ${state.userSetup.email}.`);
    setUserSetupOtpRequestState(true);
    try {
      const payload = await requestOtpDelivery(state.userSetup.email, OTP_PURPOSE_ACCOUNT_VERIFICATION);
      applyUserSetupOtpDelivery(payload, state.userSetup.email);
      if (payload?.deliveryMode !== "development") {
        showToast("OTP resent", `A new OTP was sent to ${state.userSetup.email}.`);
      }
      getUserSetupOtpInputs()[0]?.focus();
    } catch (error) {
      hideUserSetupOtpStatus();
      const message = error instanceof Error ? error.message : "Unable to resend OTP code.";
      showUserSetupOtpAlert("OTP resend failed", message);
      getUserSetupOtpInputs()[0]?.focus();
    } finally {
      setUserSetupOtpRequestState(false);
    }
  });

  if (!state.userManagementGlobalEventsBound) {
    state.userManagementGlobalEventsBound = true;
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && app.userPasswordResetPanel && !app.userPasswordResetPanel.hidden) {
        closeManagedPasswordResetPanel();
        return;
      }
      if (event.key === "Escape" && app.userSetupModal && !app.userSetupModal.hidden) {
        closeUserSetupModal();
        return;
      }
      if (event.key === "Escape" && app.userDetailModal && !app.userDetailModal.hidden) {
        closeManagedUserDetailModal();
      }
    });
  }

  void renderUsersTable();
}

// ============================================================
// END AUTHENTICATION SYSTEM
// ============================================================

const MENU_ITEMS = {
  admin: [
    { id: "dashboard", label: "Dashboard", icon: "layout-dashboard", file: "dashboard" },
    { id: "monitoring", label: "Monitoring", icon: "activity", file: "monitoring" },
    { id: "batch", label: "Reports", icon: "file-text", file: "batch" },
    { id: "history", label: "History", icon: "history", file: "history" },
    { id: "users", label: "User Management", icon: "users", file: "users" },
    { id: "settings", label: "Settings", icon: "settings", file: "settings" },
  ],
  user: [
    { id: "dashboard", label: "Dashboard", icon: "layout-dashboard", file: "dashboard" },
    { id: "monitoring", label: "Monitoring", icon: "activity", file: "monitoring" },
    { id: "batch", label: "Batch Management", icon: "package-open", file: "batch" },
    { id: "candling", label: "Schedules", icon: "calendar", file: "candling" },
    { id: "reports", label: "Reports", icon: "file-text", file: "reports" },
    { id: "history", label: "History", icon: "history", file: "history" },
    { id: "settings", label: "Settings", icon: "settings", file: "settings" },
    { id: "profile", label: "Profile", icon: "user", file: "profile", hiddenFromSidebar: true },
  ],
};

const pageTemplateCache = new Map();
let navigationRequestId = 0;
let pressedInteractiveElement = null;
let immediateInteractionFeedbackBound = false;

function formatChartDate(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatChartTime(date) {
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatChartMonth(date) {
  return date.toLocaleDateString("en-US", { month: "short" });
}

function labelRecentDailyData(entries) {
  return entries.map((entry, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - (entries.length - index - 1));
    return { ...entry, date: formatChartDate(date) };
  });
}

function labelRecentHourlyData(entries, stepHours = 2) {
  return entries.map((entry, index) => {
    const date = new Date();
    date.setMinutes(0, 0, 0);
    date.setHours(date.getHours() - stepHours * (entries.length - index - 1));
    return { ...entry, time: formatChartTime(date) };
  });
}

function labelRecentMonthlyData(entries) {
  return entries.map((entry, index) => {
    const date = new Date();
    date.setDate(1);
    date.setHours(12, 0, 0, 0);
    date.setMonth(date.getMonth() - (entries.length - index - 1));
    return { ...entry, month: formatChartMonth(date) };
  });
}

function labelRecentQuarterlyData(entries) {
  return entries.map((entry, index) => {
    const date = new Date();
    date.setDate(1);
    date.setHours(12, 0, 0, 0);
    date.setMonth(date.getMonth() - 3 * (entries.length - index - 1));
    const quarter = Math.floor(date.getMonth() / 3) + 1;
    return { ...entry, quarter: `Q${quarter} ${date.getFullYear()}` };
  });
}

const temperatureData = [];

function readSensorHistoryCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(SENSOR_HISTORY_CACHE_KEY) || "[]");
    const cutoff = Date.now() - SENSOR_HISTORY_HOURS * 60 * 60 * 1000;
    return normalizeSensorReadings(cached).filter((reading) => reading.timestamp >= cutoff);
  } catch {
    return [];
  }
}

function writeSensorHistoryCache(readings) {
  try {
    localStorage.setItem(SENSOR_HISTORY_CACHE_KEY, JSON.stringify(readings.slice(-SENSOR_HISTORY_LIMIT)));
  } catch {
    // A full or disabled localStorage must not stop live monitoring.
  }
}

function mergeSensorHistoryCache(readings) {
  const mergedByKey = new Map();
  [...readSensorHistoryCache(), ...readings].forEach((reading) => {
    const key = reading.id || reading.recordedAt;
    if (key) mergedByKey.set(key, reading);
  });
  const cutoff = Date.now() - SENSOR_HISTORY_HOURS * 60 * 60 * 1000;
  const merged = Array.from(mergedByKey.values())
    .filter((reading) => reading.timestamp >= cutoff)
    .sort((left, right) => left.timestamp - right.timestamp);
  writeSensorHistoryCache(merged);
}

function isLiveSensorReading(reading) {
  if (!reading || state.deviceOnline === false) return false;
  return Number.isFinite(reading.timestamp) && Date.now() - reading.timestamp <= SENSOR_LIVE_FRESHNESS_MS;
}

function getLiveSensorReading() {
  const stored = temperatureData[temperatureData.length - 1] || null;
  // Between history uploads the live poll's sample is the newer one. It is
  // shown on the cards only; the charts keep plotting stored readings.
  const live = state.liveSensorReading || null;
  const reading = live && (!stored || live.timestamp > stored.timestamp) ? live : stored;
  return isLiveSensorReading(reading) ? reading : null;
}

function getRealtimeSensorReadings(readings = temperatureData) {
  // Keep one continuous trace across a temporary DHT/Wi-Fi interruption. The
  // line connects the last valid reading to the next valid reading without
  // inventing zeroes or synthetic samples for the missing interval.
  const latest = readings[readings.length - 1];
  if (!latest) return [];
  // Keep a five-minute window as telemetry moves from 10 s to fresh 2 s
  // samples. Never pad, clamp or smooth a real measurement.
  return readings.filter((reading) => reading.timestamp >= latest.timestamp - 5 * 60 * 1000);
}

function formatSensorReadingTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--:--:--"
    : date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatSensorChartTick(entry, readings = []) {
  const date = new Date(entry?.recordedAt || "");
  if (Number.isNaN(date.getTime())) return entry?.time || "--:--";
  const first = new Date(readings[0]?.recordedAt || "").getTime();
  const last = new Date(readings[readings.length - 1]?.recordedAt || "").getTime();
  const span = Number.isFinite(first) && Number.isFinite(last) ? Math.abs(last - first) : 0;
  if (span > 48 * 60 * 60 * 1000) {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: span <= 2 * 60 * 60 * 1000 ? "2-digit" : undefined,
    hour12: false,
  });
}

function inferSensorDomain(values, minimumSpan, bounds) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return bounds;
  const minValue = Math.min(...finite);
  const maxValue = Math.max(...finite);
  const recordedSpan = maxValue - minValue;
  const paddedSpan = Math.max(recordedSpan * 1.2, minimumSpan);
  const padding = (paddedSpan - recordedSpan) / 2;
  const step = niceStep(paddedSpan / 4);
  let lower = Math.floor((minValue - padding) / step) * step;
  let upper = lower + step * 4;

  // Keep all recorded values plus breathing room inside the four chart
  // intervals. The old center-based rounding could produce [-10, 30] for a
  // 0..34 series, clipping every valid point above 30 into broken fragments.
  if (upper < maxValue + padding) {
    upper = Math.ceil((maxValue + padding) / step) * step;
    lower = upper - step * 4;
  }

  if (lower < bounds[0]) {
    lower = Math.ceil(bounds[0] / step) * step;
    upper = lower + step * 4;
  }
  if (upper > bounds[1]) {
    upper = Math.floor(bounds[1] / step) * step;
    lower = upper - step * 4;
  }

  return [Number(lower.toFixed(6)), Number(upper.toFixed(6))];
}

function normalizeSensorReadings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((reading) => {
      const rawTemp = reading?.temperatureC ?? reading?.temperature ?? reading?.temp;
      const rawHumidity = reading?.humidityPercent ?? reading?.humidity;
      if (rawTemp === null || rawTemp === undefined || rawHumidity === null || rawHumidity === undefined) return null;
      if (String(rawTemp).trim() === "" || String(rawHumidity).trim() === "") return null;
      const temp = Number(rawTemp);
      const humidity = Number(rawHumidity);
      const recordedAt = String(reading?.recordedAt || "").trim();
      const timestamp = new Date(recordedAt).getTime();
      // ESP/DHT failure sentinels from older records were stored as numeric
      // zeroes. They are not usable environmental samples and create the
      // straight drop to 0 seen in historical charts.
      if (!Number.isFinite(temp) || Math.abs(temp) < 1 || temp < -40 || temp > 80
        || !Number.isFinite(humidity) || humidity < 1 || humidity > 100
        || !Number.isFinite(timestamp)) return null;
      return {
        id: String(reading?.id || "").trim(),
        time: formatSensorReadingTime(recordedAt),
        temp,
        humidity,
        recordedAt,
        timestamp,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function getRequestedSensorHistoryHours() {
  const values = Array.from(app.pageRoot?.querySelectorAll('[data-chart-range="sensor-hours"]') || [])
    .map((control) => String(control.value || control.dataset.chartRangeValue || ""))
    .map((value) => (value === "realtime" || value === "current" ? 1 : Number(value)))
    .filter(Number.isFinite);
  // Both charts share the response, so request the widest selected range.
  // Realtime (or no controls yet) still opens on the cheap one-hour window.
  return Math.min(SENSOR_HISTORY_HOURS, Math.max(1, ...values));
}

async function loadSharedSensorReadings(limit = 0, overrideHours = 0) {
  // overrideHours is the recovery path below asking for a wider window than the
  // range controls select; it must not change what the controls report.
  const requestedHours = overrideHours || getRequestedSensorHistoryHours();
  if (state.sensorReadingsRequest) {
    await state.sensorReadingsRequest;
    return state.sensorReadingsHours === requestedHours
      ? temperatureData
      : loadSharedSensorReadings(limit, overrideHours);
  }
  if (!temperatureData.length && !state.sensorCacheHydrated) {
    const cachedReadings = readSensorHistoryCache();
    if (cachedReadings.length) {
      temperatureData.splice(0, temperatureData.length, ...cachedReadings);
      state.sensorReadingsChanged = true;
      // Cache-only points are unconfirmed until the server echoes them back.
      state.sensorReadingsServerConfirmed = false;
    }
  }
  state.sensorCacheHydrated = true;
  const safeLimit = Math.max(120, Math.min(SENSOR_HISTORY_LIMIT, Number(limit) || SENSOR_HISTORY_LIMIT));
  const separator = SENSOR_READINGS_ENDPOINT.includes("?") ? "&" : "?";
  // No cache-busting parameter: requestBackendJsonConditional revalidates with
  // the server on every call, and a stable URL is what lets the ETag match.
  const requestUrl = `${SENSOR_READINGS_ENDPOINT}${separator}hours=${requestedHours}&limit=${safeLimit}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  state.sensorReadingsRequest = requestBackendJsonConditional(requestUrl, requestUrl, controller.signal)
    .then((payload) => {
      if (!Array.isArray(payload.readings)) throw new Error("Invalid sensor history response.");
      const backendReadings = normalizeSensorReadings(payload.readings);
      // An empty window is not an empty database. Once the ESP32 has been
      // offline longer than the requested range the backend correctly returns
      // no rows, but readings this session already received from the server
      // are real measurements and must stay on the cards and the chart rather
      // than being wiped to "--". Only server-confirmed points survive: an
      // unconfirmed localStorage cache is still cleared by an empty response,
      // so stale cached history can never resurrect over server truth.
      const keepLastKnown = backendReadings.length === 0
        && state.sensorReadingsServerConfirmed === true
        && temperatureData.length > 0;
      const readings = backendReadings.length ? backendReadings : (keepLastKnown ? temperatureData.slice() : []);
      // Whole-window statistics from every stored reading. The series above is
      // thinned for drawing, so it cannot produce an honest average itself.
      const summaries = payload.summaries && typeof payload.summaries === "object" && !Array.isArray(payload.summaries)
        ? payload.summaries
        : {};
      state.sensorReadingSummaries = summaries;
      if (backendReadings.length) {
        state.sensorReadingsServerConfirmed = true;
        state.sensorHistoryWidened = false;
      }
      const fingerprint = (reading) => [reading.id, reading.recordedAt, reading.temp, reading.humidity].join(":");
      const previousSignature = temperatureData.map(fingerprint).join("|");
      const nextSignature = readings.map(fingerprint).join("|");
      const readingsDiffer = previousSignature !== nextSignature;
      // Do not clear a pending flag that the localStorage hydration above just
      // raised. When the cache already held exactly what the server returns,
      // the signatures match and this used to reset the flag to false, so the
      // first paint never re-rendered and the dashboard graph stayed empty
      // until a route swap rebuilt it.
      state.sensorReadingsChanged = state.sensorReadingsChanged || readingsDiffer;
      if (readingsDiffer) {
        temperatureData.splice(0, temperatureData.length, ...readings);
        mergeSensorHistoryCache(readings);
      }
      state.sensorReadingsHours = requestedHours;
      state.sensorHistoryEmptyWindow = backendReadings.length === 0;
      return readings;
    })
    .finally(() => {
      clearTimeout(timeout);
      state.sensorReadingsRequest = null;
    });
  const settled = await state.sensorReadingsRequest;
  // A reload after the ESP32 has been offline longer than the default window
  // starts with nothing in memory, so the retention above has nothing to hold
  // and the cards fall back to "--" even though the readings are still stored.
  // Widen the request once to recover the last real measurements. Only the
  // narrow default window is retried, and only while the wider window has not
  // already been tried, so this cannot loop or slow the normal first paint.
  if (state.sensorHistoryEmptyWindow
      && !state.sensorHistoryWidened
      && requestedHours < SENSOR_HISTORY_HOURS) {
    state.sensorHistoryWidened = true;
    return loadSharedSensorReadings(limit, SENSOR_HISTORY_HOURS);
  }
  return settled;
}

const userEggDistribution = [];

const dashboardEggStatusProjections = {
  18: {
    label: "18 Days",
    harvestDate: "--",
    days: 18,
    data: [],
  },
  21: {
    label: "21 Days",
    harvestDate: "--",
    days: 21,
    data: [],
  },
  28: {
    label: "28 Days",
    harvestDate: "--",
    days: 28,
    data: [],
  },
};

const batchProgressData = [];
const successRateData = [];
const userBatchDistribution = [];
const userBatchPerformance = Array.from({ length: 12 }, (_, month) => ({
  month: new Date(2000, month, 1).toLocaleString("en-US", { month: "short" }),
  completed: 0,
  inProgress: 0,
}));

const historyBatchDetails = {};

const adminProductionMonthlyData = [];
const adminProductionWeeklyData = [];
const candlingResults = [];
const weeklyTrend = [];
const distributionData = [];

const icons = {
  "layout-dashboard": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="2"></rect>
      <rect x="13" y="3" width="8" height="5" rx="2"></rect>
      <rect x="13" y="10" width="8" height="11" rx="2"></rect>
      <rect x="3" y="13" width="8" height="8" rx="2"></rect>
    </svg>
  `,
  activity: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <polyline points="22 12 18 12 15 20 9 4 6 12 2 12"></polyline>
    </svg>
  `,
  "package-open": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M12 22V12"></path>
      <path d="M21 8l-9-5-9 5"></path>
      <path d="M3 8v8l9 5 9-5V8"></path>
      <path d="M17 5.5 8 10.5"></path>
    </svg>
  `,
  "clipboard-list": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <rect x="8" y="2" width="8" height="4" rx="1"></rect>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
      <path d="M8 11h8"></path>
      <path d="M8 15h8"></path>
      <path d="M8 19h5"></path>
    </svg>
  `,
  "scan-eye": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M3 7V3h4"></path>
      <path d="M21 7V3h-4"></path>
      <path d="M3 17v4h4"></path>
      <path d="M21 17v4h-4"></path>
      <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"></path>
      <circle cx="12" cy="12" r="2.5"></circle>
    </svg>
  `,
  users: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </svg>
  `,
  user: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M20 21a8 8 0 0 0-16 0"></path>
      <circle cx="12" cy="8" r="4"></circle>
    </svg>
  `,
  "user-plus": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <line x1="19" y1="8" x2="19" y2="14"></line>
      <line x1="16" y1="11" x2="22" y2="11"></line>
    </svg>
  `,
  bell: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M10.27 21a2 2 0 0 0 3.46 0"></path>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path>
    </svg>
  `,
  mail: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2"></rect>
      <path d="m4 7 8 6 8-6"></path>
    </svg>
  `,
  "map-pin": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M12 21s-6-4.35-6-10a6 6 0 1 1 12 0c0 5.65-6 10-6 10z"></path>
      <circle cx="12" cy="11" r="2.5"></circle>
    </svg>
  `,
  egg: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M12 2c-4 0-7 6.27-7 11a7 7 0 0 0 14 0c0-4.73-3-11-7-11z"></path>
    </svg>
  `,
  download: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M12 3v12"></path>
      <path d="m7 10 5 5 5-5"></path>
      <path d="M5 21h14"></path>
    </svg>
  `,
  thermometer: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0z"></path>
    </svg>
  `,
  droplets: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M12 2.69 7.05 7.64a7 7 0 1 0 9.9 0L12 2.69z"></path>
    </svg>
  `,
  "sensor-square": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <rect x="7" y="5" width="10" height="12" rx="2"></rect>
      <path d="M10 9h4"></path>
      <path d="M10 13h4"></path>
      <path d="M12 17v3"></path>
      <path d="M9 20h6"></path>
    </svg>
  `,
  "rotate-cw": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M21 2v6h-6"></path>
      <path d="M20.49 15A9 9 0 1 1 17 5.13L21 8"></path>
    </svg>
  `,
  fan: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M12 11.5c-1.8-1.8-2.2-4.7-.8-7 1.1-1.8 3.5-2.3 5.2-1.1 1.8 1.3 1.9 3.9.3 5.4-1.2 1.2-3 2.1-4.7 2.7Z"></path>
      <path d="M12.5 12c1.8-1.8 4.7-2.2 7-.8 1.8 1.1 2.3 3.5 1.1 5.2-1.3 1.8-3.9 1.9-5.4.3-1.2-1.2-2.1-3-2.7-4.7Z"></path>
      <path d="M12 12.5c1.8 1.8 2.2 4.7.8 7-1.1 1.8-3.5 2.3-5.2 1.1-1.8-1.3-1.9-3.9-.3-5.4 1.2-1.2 3-2.1 4.7-2.7Z"></path>
      <circle cx="12" cy="12" r="1.4"></circle>
    </svg>
  `,
  "refresh-cw": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M21 2v6h-6"></path>
      <path d="M20.49 15A9 9 0 1 1 17.64 6.36L21 8"></path>
    </svg>
  `,
  flag: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M5 22V4"></path>
      <path d="M5 4h11l-1 4 1 4H5"></path>
    </svg>
  `,
  lightbulb: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M9 18h6"></path>
      <path d="M10 22h4"></path>
      <path d="M12 2a7 7 0 0 0-4 12.74c.54.37 1 1.07 1 1.76V18h6v-1.5c0-.69.46-1.39 1-1.76A7 7 0 0 0 12 2z"></path>
    </svg>
  `,
  shield: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z"></path>
      <path d="m9.5 12 1.8 1.8 3.2-3.4"></path>
    </svg>
  `,
  wifi: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
      <path d="M8.5 16a6 6 0 0 1 7 0"></path>
      <path d="M12 20h.01"></path>
      <path d="M2 9.1a16 16 0 0 1 20 0"></path>
    </svg>
  `,
  cpu: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2"></rect>
      <path d="M10 2v3"></path>
      <path d="M14 2v3"></path>
      <path d="M10 19v3"></path>
      <path d="M14 19v3"></path>
      <path d="M19 10h3"></path>
      <path d="M19 14h3"></path>
      <path d="M2 10h3"></path>
      <path d="M2 14h3"></path>
    </svg>
  `,
  globe: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M3 12h18"></path>
      <path d="M12 3a15 15 0 0 1 0 18"></path>
      <path d="M12 3a15 15 0 0 0 0 18"></path>
    </svg>
  `,
  camera: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
      <circle cx="12" cy="13" r="4"></circle>
    </svg>
  `,
  lock: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2"></rect>
      <path d="M8 11V7a4 4 0 1 1 8 0v4"></path>
    </svg>
  `,
  monitor: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2"></rect>
      <path d="M8 20h8"></path>
      <path d="M12 16v4"></path>
    </svg>
  `,
  palette: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M12 3a9 9 0 0 0 0 18h1.2a2.3 2.3 0 0 0 0-4.6H12a2 2 0 0 1 0-4h2a4 4 0 0 0 0-8h-2z"></path>
      <circle cx="6.5" cy="11.5" r="1"></circle>
      <circle cx="8.5" cy="7.5" r="1"></circle>
      <circle cx="12.5" cy="6.5" r="1"></circle>
      <circle cx="16.5" cy="8.5" r="1"></circle>
    </svg>
  `,
  "file-text": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <path d="M14 2v6h6"></path>
      <path d="M16 13H8"></path>
      <path d="M16 17H8"></path>
      <path d="M10 9H8"></path>
    </svg>
  `,
  "trending-up": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline>
      <polyline points="16 7 22 7 22 13"></polyline>
    </svg>
  `,
  power: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M12 2v10"></path>
      <path d="M18.36 6.64a9 9 0 1 1-12.72 0"></path>
    </svg>
  `,
  "alert-triangle": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
      <line x1="12" y1="9" x2="12" y2="13"></line>
      <line x1="12" y1="17" x2="12.01" y2="17"></line>
    </svg>
  `,
  "alert-circle": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="12"></line>
      <line x1="12" y1="16" x2="12.01" y2="16"></line>
    </svg>
  `,
  info: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="16" x2="12" y2="12"></line>
      <line x1="12" y1="8" x2="12.01" y2="8"></line>
    </svg>
  `,
  "check-circle": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
      <polyline points="22 4 12 14.01 9 11.01"></polyline>
    </svg>
  `,
  "x-circle": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <path d="m9 9 6 6"></path>
      <path d="m15 9-6 6"></path>
    </svg>
  `,
  calendar: `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2"></rect>
      <line x1="16" y1="2" x2="16" y2="6"></line>
      <line x1="8" y1="2" x2="8" y2="6"></line>
      <line x1="3" y1="10" x2="21" y2="10"></line>
    </svg>
  `,
  plus: `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <path d="M12 5v14"></path>
      <path d="M5 12h14"></path>
    </svg>
  `,
  "chevron-down": `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <path d="m6 9 6 6 6-6"></path>
    </svg>
  `,
  "chevron-right": `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <path d="m9 6 6 6-6 6"></path>
    </svg>
  `,
  "sliders-horizontal": `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <line x1="21" y1="4" x2="14" y2="4"></line>
      <line x1="10" y1="4" x2="3" y2="4"></line>
      <line x1="21" y1="12" x2="12" y2="12"></line>
      <line x1="8" y1="12" x2="3" y2="12"></line>
      <line x1="21" y1="20" x2="16" y2="20"></line>
      <line x1="12" y1="20" x2="3" y2="20"></line>
      <line x1="14" y1="2" x2="14" y2="6"></line>
      <line x1="8" y1="10" x2="8" y2="14"></line>
      <line x1="16" y1="18" x2="16" y2="22"></line>
    </svg>
  `,
  "arrow-left": `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <path d="M19 12H5"></path>
      <path d="m12 19-7-7 7-7"></path>
    </svg>
  `,
  eye: `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"></path>
      <circle cx="12" cy="12" r="2.8"></circle>
    </svg>
  `,
  "eye-off": `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <path d="M3 3l18 18"></path>
      <path d="M10.6 6.2A10.8 10.8 0 0 1 12 6c6.4 0 10 6 10 6a17.8 17.8 0 0 1-2.1 2.8"></path>
      <path d="M6.6 6.6C3.7 8.4 2 12 2 12s3.6 6 10 6c1.8 0 3.4-.5 4.7-1.2"></path>
      <path d="M10.1 10.1a2.8 2.8 0 0 0 3.8 3.8"></path>
    </svg>
  `,
  settings: `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1-.33 1.65 1.65 0 0 0-1 .33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1-.33H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9c.07-.36.07-.74 0-1.1a1.65 1.65 0 0 0-.43-.72l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6c.36-.07.74-.07 1.1 0A1.65 1.65 0 0 0 11 4V3.91a2 2 0 1 1 4 0V4a1.65 1.65 0 0 0 .9.6c.36.07.74.07 1.1 0a1.65 1.65 0 0 0 .72-.43l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c-.07.36-.07.74 0 1.1.11.28.31.53.57.72.3.2.65.31 1.01.31H21a2 2 0 1 1 0 4h-.09c-.36 0-.71.11-1.01.31-.26.19-.46.44-.57.72z"></path>
    </svg>
  `,
  ellipsis: `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"></circle>
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"></circle>
      <circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"></circle>
    </svg>
  `,
  "clock-3": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M12 7v6l4 2"></path>
    </svg>
  `,
  history: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.71"></path>
      <path d="M3 4v5h5"></path>
      <path d="M12 7v5l3 2"></path>
    </svg>
  `,
  edit: `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
    </svg>
  `,
  trash: `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6 18.11 19.34A2 2 0 0 1 16.12 21H7.88a2 2 0 0 1-1.99-1.66L5 6"></path>
      <path d="M10 11v6"></path>
      <path d="M14 11v6"></path>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
    </svg>
  `,
  "trash-2": `
    <svg viewBox="0 0 24 24" class="icon icon--sm" aria-hidden="true">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6 18.11 19.34A2 2 0 0 1 16.12 21H7.88a2 2 0 0 1-1.99-1.66L5 6"></path>
      <path d="M10 11v6"></path>
      <path d="M14 11v6"></path>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
    </svg>
  `,
  "book-open": `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <path d="M12 7v14"></path>
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"></path>
    </svg>
  `,
  code: `
    <svg viewBox="0 0 24 24" class="icon" aria-hidden="true">
      <polyline points="16 18 22 12 16 6"></polyline>
      <polyline points="8 6 2 12 8 18"></polyline>
    </svg>
  `,
};

const app = {
  dashboardContainer: document.getElementById("dashboard-container"),
  sidebar: document.getElementById("app-sidebar"),
  sidebarContent: document.getElementById("sidebar-content"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  pageRoot: document.getElementById("page-root"),
  menuButton: document.getElementById("mobile-menu-button"),
  mobilePageLabel: document.getElementById("mobile-page-label"),
  toastRegion: document.getElementById("toast-region"),
  tooltip: document.getElementById("chart-tooltip"),
  forgotPasswordButton: document.getElementById("forgot-password-button"),
  recoveryModal: document.getElementById("recovery-modal"),
  recoveryBackdrop: document.getElementById("recovery-backdrop"),
  recoveryCloseButton: document.getElementById("recovery-close-button"),
  recoveryTitle: document.getElementById("recovery-title"),
  recoveryDescription: document.getElementById("recovery-description"),
  recoveryEmailForm: document.getElementById("recovery-email-form"),
  recoveryOtpForm: document.getElementById("recovery-otp-form"),
  recoveryPasswordForm: document.getElementById("recovery-password-form"),
  recoveryEmailInput: document.getElementById("recovery-email"),
  recoveryPasswordInput: document.getElementById("recovery-password"),
  recoveryPasswordConfirmInput: document.getElementById("recovery-password-confirm"),
  recoveryResendButton: document.getElementById("recovery-resend-button"),
  recoveryBackToEmailButton: document.getElementById("recovery-back-to-email"),
  recoveryBackToOtpButton: document.getElementById("recovery-back-to-otp"),
  recoveryOtpAlert: document.getElementById("recovery-otp-alert"),
  usersTableBody: document.getElementById("users-table-body"),
  usersCountBadge: document.getElementById("users-count-badge"),
  openUserSetupButton: document.getElementById("open-user-setup-button"),
  userDetailModal: document.getElementById("user-detail-modal"),
  userDetailBackdrop: document.getElementById("user-detail-backdrop"),
  userDetailCloseButton: document.getElementById("user-detail-close-button"),
  userDetailAvatar: document.getElementById("user-detail-avatar"),
  userDetailAvatarButton: document.getElementById("user-detail-avatar-button"),
  userDetailAvatarInput: document.getElementById("user-detail-avatar-input"),
  userDetailResetPasswordButton: document.getElementById("user-detail-reset-password-button"),
  userDetailDeactivateButton: document.getElementById("user-detail-deactivate-button"),
  userPasswordResetPanel: document.getElementById("user-password-reset-panel"),
  userPasswordResetBackdrop: document.getElementById("user-password-reset-backdrop"),
  userPasswordResetCloseButton: document.getElementById("user-password-reset-close-button"),
  userPasswordResetTitle: document.getElementById("user-password-reset-title"),
  userPasswordResetCopy: document.getElementById("user-password-reset-copy"),
  userPasswordResetCardCopy: document.getElementById("user-password-reset-card-copy"),
  userPasswordResetOtpCopy: document.getElementById("user-password-reset-otp-copy"),
  userPasswordResetDetailsForm: document.getElementById("user-password-reset-details-form"),
  userPasswordResetOtpForm: document.getElementById("user-password-reset-otp-form"),
  userPasswordResetOldInput: document.getElementById("user-password-reset-old"),
  userPasswordResetNewInput: document.getElementById("user-password-reset-new"),
  userPasswordResetConfirmInput: document.getElementById("user-password-reset-confirm"),
  userPasswordResetCancelButton: document.getElementById("user-password-reset-cancel-button"),
  userPasswordResetStepTwoCancelButton: document.getElementById("user-password-reset-step-two-cancel-button"),
  userPasswordResetResendButton: document.getElementById("user-password-reset-resend-button"),
  userPasswordResetOtpAlert: document.getElementById("user-password-reset-otp-alert"),
  userPasswordResetOtpStatus: document.getElementById("user-password-reset-otp-status"),
  userPasswordResetDevOtp: document.getElementById("user-password-reset-dev-otp"),
  userPasswordResetDevOtpCode: document.getElementById("user-password-reset-dev-otp-code"),
  userSetupModal: document.getElementById("user-setup-modal"),
  userSetupBackdrop: document.getElementById("user-setup-backdrop"),
  userSetupCloseButton: document.getElementById("user-setup-close-button"),
  userSetupCopy: document.getElementById("user-setup-copy"),
  userSetupOtpCopy: document.getElementById("user-setup-otp-copy"),
  userSetupDetailsForm: document.getElementById("user-setup-details-form"),
  userSetupOtpForm: document.getElementById("user-setup-otp-form"),
  userSetupUsernameInput: document.getElementById("user-setup-username"),
  userSetupEmailInput: document.getElementById("user-setup-email"),
  userSetupRoleInput: document.getElementById("user-setup-role"),
  userSetupPasswordInput: document.getElementById("user-setup-password"),
  userSetupPasswordConfirmInput: document.getElementById("user-setup-password-confirm"),
  userSetupCancelButton: document.getElementById("user-setup-cancel-button"),
  userSetupBackButton: document.getElementById("user-setup-back-button"),
  userSetupResendButton: document.getElementById("user-setup-resend-button"),
  userSetupOtpAlert: document.getElementById("user-setup-otp-alert"),
  userSetupOtpStatus: document.getElementById("user-setup-otp-status"),
  userSetupDevOtp: document.getElementById("user-setup-dev-otp"),
  userSetupDevOtpCode: document.getElementById("user-setup-dev-otp-code"),
  actionDialog: null,
  actionDialogBackdrop: null,
  actionDialogEyebrow: null,
  actionDialogTitle: null,
  actionDialogBody: null,
  actionDialogInput: null,
  actionDialogActions: null,
  actionDialogCancel: null,
  actionDialogConfirm: null,
  batchEntryModal: null,
  batchEntryForm: null,
  historyDetailModal: null,
  notificationModal: null,
  scheduleFullModal: null,
};

const DASHBOARD_APP_REFERENCE_IDS = {
  dashboardContainer: "dashboard-container",
  sidebar: "app-sidebar",
  sidebarContent: "sidebar-content",
  sidebarBackdrop: "sidebar-backdrop",
  pageRoot: "page-root",
  menuButton: "mobile-menu-button",
  mobilePageLabel: "mobile-page-label",
  toastRegion: "toast-region",
  tooltip: "chart-tooltip",
  usersTableBody: "users-table-body",
  usersCountBadge: "users-count-badge",
  openUserSetupButton: "open-user-setup-button",
  userDetailModal: "user-detail-modal",
  userDetailBackdrop: "user-detail-backdrop",
  userDetailCloseButton: "user-detail-close-button",
  userDetailAvatar: "user-detail-avatar",
  userDetailAvatarButton: "user-detail-avatar-button",
  userDetailAvatarInput: "user-detail-avatar-input",
  userDetailResetPasswordButton: "user-detail-reset-password-button",
  userDetailDeactivateButton: "user-detail-deactivate-button",
  userPasswordResetPanel: "user-password-reset-panel",
  userPasswordResetBackdrop: "user-password-reset-backdrop",
  userPasswordResetCloseButton: "user-password-reset-close-button",
  userPasswordResetTitle: "user-password-reset-title",
  userPasswordResetCopy: "user-password-reset-copy",
  userPasswordResetCardCopy: "user-password-reset-card-copy",
  userPasswordResetOtpCopy: "user-password-reset-otp-copy",
  userPasswordResetDetailsForm: "user-password-reset-details-form",
  userPasswordResetOtpForm: "user-password-reset-otp-form",
  userPasswordResetOldInput: "user-password-reset-old",
  userPasswordResetNewInput: "user-password-reset-new",
  userPasswordResetConfirmInput: "user-password-reset-confirm",
  userPasswordResetCancelButton: "user-password-reset-cancel-button",
  userPasswordResetStepTwoCancelButton: "user-password-reset-step-two-cancel-button",
  userPasswordResetResendButton: "user-password-reset-resend-button",
  userPasswordResetOtpAlert: "user-password-reset-otp-alert",
  userPasswordResetOtpStatus: "user-password-reset-otp-status",
  userPasswordResetDevOtp: "user-password-reset-dev-otp",
  userPasswordResetDevOtpCode: "user-password-reset-dev-otp-code",
  userSetupModal: "user-setup-modal",
  userSetupBackdrop: "user-setup-backdrop",
  userSetupCloseButton: "user-setup-close-button",
  userSetupCopy: "user-setup-copy",
  userSetupOtpCopy: "user-setup-otp-copy",
  userSetupDetailsForm: "user-setup-details-form",
  userSetupOtpForm: "user-setup-otp-form",
  userSetupUsernameInput: "user-setup-username",
  userSetupEmailInput: "user-setup-email",
  userSetupRoleInput: "user-setup-role",
  userSetupPasswordInput: "user-setup-password",
  userSetupPasswordConfirmInput: "user-setup-password-confirm",
  userSetupCancelButton: "user-setup-cancel-button",
  userSetupBackButton: "user-setup-back-button",
  userSetupResendButton: "user-setup-resend-button",
  userSetupOtpAlert: "user-setup-otp-alert",
  userSetupOtpStatus: "user-setup-otp-status",
  userSetupDevOtp: "user-setup-dev-otp",
  userSetupDevOtpCode: "user-setup-dev-otp-code",
};

function refreshDashboardAppReferences() {
  Object.entries(DASHBOARD_APP_REFERENCE_IDS).forEach(([key, id]) => {
    app[key] = document.getElementById(id);
  });
}

const state = {
  currentPage: getCurrentPage(),
  sidebarOpen: false,
  managedUserSelection: "",
  userManagementGlobalEventsBound: false,
  trayControls: {
    candling: { switch: false },
    eggRoller: false,
  },
  recovery: {
    step: 1,
    account: null,
    email: "",
    otpCode: "",
  },
  userSetup: {
    step: 1,
    pendingAccount: null,
    email: "",
    delivery: null,
    isSendingOtp: false,
  },
  userPasswordReset: {
    step: 1,
    account: null,
    email: "",
    currentPassword: "",
    pendingPassword: "",
    delivery: null,
    isSendingOtp: false,
  },
  profileQuick: {
    fields: null,
    password: {
      account: null,
      email: "",
      delivery: null,
      isSendingOtp: false,
    },
  },
  actionDialog: {
    resolve: null,
    onKeydown: null,
  },
  historyPagination: {
    page: 1,
    pageSize: 4,
  },
  managedUsersPagination: {
    page: 1,
    pageSize: 10,
  },
  managedUsersStatusFilter: "all",
  chartRanges: {},
  adminMonitoringLiveTimer: null,
  sensorReadingsTimer: null,
  sensorReadingsRequest: null,
  sensorRefreshRequest: null,
  sensorStatusRefreshRequest: null,
  sensorWasLive: null,
  sensorCacheHydrated: false,
  sensorReadingsChanged: false,
  devicePresenceChanged: false,
  sensorReadingsHours: 0,
  deviceOnline: null,
  deviceLastSeenAt: "",
  deviceStaleAfterSeconds: 45,
  viewportWidth: Math.round(document.documentElement.clientWidth || window.innerWidth || 0),
  batchSyncTimer: null,
  batchSyncRequest: null,
  batchSyncFingerprint: "",
  liveBatches: [],
  liveBatchesLoaded: false,
  monitoringBatchId: "__all",
  scheduleCalendarMonthOffset: 0,
  scheduleSelectedBatchId: "",
  scheduleAutoOpenedDates: new Set(),
  userSchedule: {
    startDate: "",
    candlingOneDate: "",
    candlingTwoDate: "",
    harvestDate: "",
    currentDay: 0,
    targetDays: 0,
    eggCount: 0,
    saved: false,
  },
};

const SETTINGS_STORAGE_KEY = "smartduck_admin_settings";
const DEFAULT_ADMIN_SETTINGS = {
  systemName: "SmartDuck Incubation System",
  timezone: "Asia/Manila",
  dateFormat: "long",
  timeFormat: "12h",
  itemsPerPage: "10",
  refreshInterval: "30",
  sessionTimeout: "30",
  language: "en",
  temperatureUnit: "celsius",
  startPage: "dashboard",
  smsNotifications: false,
  smsNumber: "",
  inAppNotifications: true,
  criticalAlerts: true,
  warningAlerts: true,
  resolvedAlerts: false,
  alertDelivery: "all",
  notificationSound: "smartduck",
  componentModes: {
    dht: "on",
    actuator: "auto",
    eggRolling: "off",
    fan: "off",
    heaterLight: "off",
    candlingLight: "off",
  },
};
const adminSettingsState = {
  cache: null,
  readyPromise: null,
  lastSaveMeta: null,
};

function readAdminSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}");
    const source = parsed && typeof parsed === "object" ? parsed : {};
    return Object.fromEntries(
      Object.entries(DEFAULT_ADMIN_SETTINGS).map(([key, fallback]) => [
        key,
        source[key] === undefined ? fallback : source[key],
      ]),
    );
  } catch {
    return { ...DEFAULT_ADMIN_SETTINGS };
  }
}

function writeAdminSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const normalized = Object.fromEntries(
    Object.entries(DEFAULT_ADMIN_SETTINGS).map(([key, fallback]) => [
      key,
      source[key] === undefined ? fallback : source[key],
    ]),
  );
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  adminSettingsState.cache = normalized;
  return normalized;
}

async function loadAdminSettingsFromBackend(forceRefresh = false) {
  if (!forceRefresh && adminSettingsState.cache) return { ...adminSettingsState.cache };
  if (!forceRefresh && adminSettingsState.readyPromise) return adminSettingsState.readyPromise;

  adminSettingsState.readyPromise = (async () => {
    const payload = await requestBackendJson(SETTINGS_ENDPOINT);
    const settings = writeAdminSettings(payload.settings || {});
    adminSettingsState.readyPromise = null;
    return { ...settings };
  })().catch((error) => {
    adminSettingsState.readyPromise = null;
    throw error;
  });
  return adminSettingsState.readyPromise;
}

async function saveAdminSettingsToBackend(settings, group) {
  const payload = await requestBackendJson(SETTINGS_ENDPOINT, {
    method: "POST",
    body: {
      username: getAuthenticatedUsername(),
      group,
      settings,
    },
  });
  adminSettingsState.lastSaveMeta = payload.sms || null;
  return writeAdminSettings(payload.settings || settings);
}

const COMPONENT_CONTROL_DEFS = [
  {
    key: "dht",
    label: "Temperature and Humidity",
    icon: "sensor-square",
    modes: ["off", "on"],
    copyByMode: {
      off: "OFF: temperature and humidity reading is stopped",
      on: "ON: temperature and humidity are shown continuously",
    },
  },
  {
    key: "actuator",
    label: "Actuator",
    icon: "settings",
    modes: ["off", "on", "auto"],
    copyByMode: {
      off: "OFF: stops when received by the device; ON resumes only the unfinished part of the cycle",
      on: "ON: L29 down/up cycle, up to 5s each way with a 1s pause before restarting; repeats until OFF or AUTO",
      auto: "AUTO: returns along this cycle's elapsed travel, then runs one 10-minute candling cycle on batch Day 7 and Day 14",
    },
  },
  {
    key: "eggRolling",
    label: "Egg Rolling",
    icon: "rotate-cw",
    modes: ["off", "on", "auto"],
    copyByMode: {
      off: "OFF: relay output is disabled immediately",
      on: "ON: egg-turning relay stays on until OFF or AUTO, regardless of actuator position",
      auto: "AUTO: one calibrated rotation every 4 active-batch hours, regardless of actuator position",
    },
  },
  {
    key: "fan",
    label: "Cooling Fan",
    icon: "fan",
    modes: ["off", "on", "auto"],
    copyByMode: {
      off: "OFF: GPIO 13 fan relay is disabled immediately",
      on: "ON: GPIO 13 fan relay stays on until another mode is selected",
      auto: "AUTO: during an active batch, the fan cools whenever the temperature rises above the 37.7-37.3 C target range",
    },
  },
  {
    key: "heaterLight",
    label: "Heater & Light",
    icon: "thermometer",
    modes: ["off", "on", "auto"],
    copyByMode: {
      off: "OFF: GPIO 23 relay is disabled immediately",
      on: "ON: GPIO 23 heater and incubator light stay on until another mode is selected",
      auto: "AUTO: during an active batch, the heater warms whenever the temperature falls below the 37.3-37.7 C target range",
    },
  },
  {
    key: "candlingLight",
    label: "Candling Light",
    icon: "lightbulb",
    modes: ["off", "on", "auto"],
    copyByMode: {
      off: "OFF: GPIO 22 relay is disabled immediately",
      on: "ON: GPIO 22 candling light stays on until another mode is selected",
      auto: "AUTO: during an active batch on Day 7, lights while the actuator lowers and turns off when it raises",
    },
  },
];
const componentControlSavingKeys = new Set();
const componentCommandStates = new Map();
let componentVersions = {};
let componentCommandWriteQueue = Promise.resolve();
const COMPONENT_STATUS_IDS = {
  dht: "COMP-DHT22",
  actuator: "COMP-ACTUATOR",
  eggRolling: "COMP-ROLLING",
  fan: "COMP-FAN",
  heaterLight: "COMP-HEATER-LIGHT",
  candlingLight: "COMP-CANDLING-LIGHT",
};
let componentDeviceStatuses = {};

function applyDevicePresencePayload(payload) {
  if (!payload || typeof payload !== "object") return;
  const previousOnline = state.deviceOnline;
  if (typeof payload.deviceOnline === "boolean") state.deviceOnline = payload.deviceOnline;
  state.devicePresenceChanged = previousOnline !== state.deviceOnline;
  state.deviceLastSeenAt = String(payload.deviceLastSeenAt || state.deviceLastSeenAt || "");
  const staleAfterSeconds = Number(payload.deviceStaleAfterSeconds);
  if (Number.isFinite(staleAfterSeconds) && staleAfterSeconds > 0) {
    state.deviceStaleAfterSeconds = staleAfterSeconds;
  }
  renderSharedSystemHealth(payload);
}

function renderSharedSystemHealth(payload) {
  const components = Array.isArray(payload?.components) ? payload.components : [];
  const activeComponents = components.filter((component) => component.status === "Active").length;
  const warningComponents = components.filter((component) => component.status === "Warning").length;
  const isOnline = payload?.deviceOnline === true;
  const isOffline = payload?.deviceOnline === false;
  const connectionLabel = isOnline ? "Online" : isOffline ? "Offline" : "Unknown";
  const healthLabel = isOnline && warningComponents > 0 ? "Warning" : connectionLabel;
  const lastSeen = payload?.deviceLastSeenAt
    ? getSensorReadingUpdateLabel({ recordedAt: payload.deviceLastSeenAt })
    : "not yet detected";
  const note = isOffline
    ? `ESP32 last seen: ${lastSeen}`
    : isOnline
      ? (warningComponents ? `${warningComponents} component warning(s)` : `${activeComponents} of ${components.length} components active`)
      : "Waiting for device status";
  for (const prefix of ["admin-dashboard", "monitoring"]) {
    setTextContentById(`${prefix}-system-health`, healthLabel);
    setTextContentById(`${prefix}-system-health-note`, note);
  }
  setTextContentById("monitoring-connection-status", connectionLabel);
  setTextContentById("monitoring-connection-note", isOnline ? "ESP32 connected" : note);
}
let componentStatusRequest = null;
let componentStatusTimer = null;
let componentConfirmationTimer = null;
let componentConfirmationPending = false;
let componentModeIntentSequence = 0;

function getComponentModes() {
  const settings = readAdminSettings();
  const modes = settings.componentModes && typeof settings.componentModes === "object" ? settings.componentModes : {};
  return Object.fromEntries(
    COMPONENT_CONTROL_DEFS.map(({ key, modes: allowed }) => {
      const fallback = DEFAULT_ADMIN_SETTINGS.componentModes[key] || (allowed.includes("auto") ? "auto" : "on");
      return [key, allowed.includes(modes[key]) ? modes[key] : fallback];
    }),
  );
}

function writeLocalComponentMode(key, mode) {
  const settings = readAdminSettings();
  const modes = { ...getComponentModes(), [key]: mode };
  settings.componentModes = modes;
  writeAdminSettings(settings);
  return mode;
}

async function postComponentCommand(key, mode) {
  const sessionId = sessionStorage.getItem(SESSION_ID_KEY);
  const command = {
    username: getAuthenticatedUsername(),
    component: key,
    mode,
  };
  const queuedRequest = componentCommandWriteQueue
    .catch(() => {})
    .then(async () => {
      if (!isAuthenticated() || sessionStorage.getItem(SESSION_ID_KEY) !== sessionId) throw new Error("Sign in to continue.");
      const payload = await requestBackendJson(COMPONENT_COMMAND_ENDPOINT, {
        method: "POST",
        body: { ...command, expectedVersion: componentVersions[key] || "" },
      });
      componentVersions[key] = payload.commandVersion || "";
      return payload;
    });

  // Component commands update a shared settings document. Keep writes from one
  // browser in order so clicking several rows together cannot create a burst of
  // competing saves or transient authentication failures.
  componentCommandWriteQueue = queuedRequest;
  return queuedRequest;
}

function queueComponentModeCommand(key, mode, isEditable) {
  let state = componentCommandStates.get(key);
  if (!state) {
    state = {
      confirmedMode: getComponentModes()[key],
      desiredMode: mode,
      running: false,
    };
    componentCommandStates.set(key, state);
  }

  state.desiredMode = mode;
  // Never coalesce away an explicit OFF during an in-flight command.
  if (mode === "off") state.stopRequested = true;
  state.awaitingDevice = true;
  state.deviceTimedOut = false;
  state.statusAtCommand = componentDeviceStatuses[key]?.updatedAt || "";
  state.commandRequestedAt = Date.now();
  writeLocalComponentMode(key, mode);
  componentControlSavingKeys.add(key);
  renderComponentControlRows(isEditable);
  if (state.running) return;

  state.running = true;
  void (async () => {
    while (true) {
      const requestedMode = state.stopRequested ? "off" : state.desiredMode;
      if (requestedMode === "off") state.stopRequested = false;
      try {
        const payload = await postComponentCommand(key, requestedMode);
        state.commandVersion = payload.commandVersion || "";
        state.confirmedMode = payload.mode || requestedMode;
        void refreshComponentDeviceStatuses(false);
        if (getAuthenticatedRole() === "admin" && ["on", "off"].includes(requestedMode)) {
          notificationState.cache = null;
          void refreshNotificationBadgesFromBackend({ forceRefresh: true, announce: true });
        }
        if (state.desiredMode === requestedMode && !state.stopRequested) {
          writeLocalComponentMode(key, state.confirmedMode);
          break;
        }
      } catch (error) {
        if ([401, 409, 423].includes(error.status) || state.desiredMode === requestedMode || requestedMode === "off") {
          state.awaitingDevice = false;
          state.stopRequested = false;
          state.desiredMode = state.confirmedMode;
          writeLocalComponentMode(key, state.confirmedMode);
          if ([409, 423].includes(error.status)) {
            void showWarningCard(error.status === 423 ? "Controls are in use" : "Control change paused", error.message);
            void refreshComponentDeviceStatuses(true);
          } else if (error.status !== 401) {
            showToast("Control not synchronized", error.message || "The command did not reach the backend, so the last confirmed mode was restored.");
          }
          break;
        }
      }
    }
    state.running = false;
    componentControlSavingKeys.delete(key);
    renderComponentControlRows(isEditable);
  })();
}

async function refreshComponentDeviceStatuses(renderAfter = true) {
  if (componentStatusRequest) return componentStatusRequest;
  componentStatusRequest = requestBackendJsonConditional(
    liveStatusIsWatched() ? COMPONENT_STATUS_WATCH_ENDPOINT : COMPONENT_STATUS_ENDPOINT
  )
    .then((payload) => {
      applyDevicePresencePayload(payload);
      applyLiveStatusPayload(payload);
      for (const [key, version] of Object.entries(payload.componentVersions || {})) {
        if (!componentVersions[key] || String(version) > componentVersions[key]) componentVersions[key] = String(version);
      }
      const backendModes = payload.componentModes && typeof payload.componentModes === "object"
        ? payload.componentModes
        : null;
      if (backendModes) {
        const settings = readAdminSettings();
        const modes = getComponentModes();
        let modesChanged = false;
        COMPONENT_CONTROL_DEFS.forEach(({ key, modes: allowedModes }) => {
          const mode = String(backendModes[key] || "").toLowerCase();
          const commandState = componentCommandStates.get(key);
          const staleSnapshot = componentVersions[key]
            && String(payload.componentVersions?.[key] || "") < componentVersions[key];
          if (staleSnapshot || !allowedModes.includes(mode) || commandState?.running || modes[key] === mode) return;
          modes[key] = mode;
          modesChanged = true;
          if (commandState) {
            commandState.confirmedMode = mode;
            commandState.desiredMode = mode;
          }
        });
        if (modesChanged) {
          settings.componentModes = modes;
          writeAdminSettings(settings);
        }
      }
      const components = Array.isArray(payload.components) ? payload.components : [];
      Object.entries(COMPONENT_STATUS_IDS).forEach(([key, componentId]) => {
        const component = components.find((candidate) => candidate.id === componentId);
        if (!component) return;
        componentDeviceStatuses[key] = {
          status: String(component.status || "Off").toLowerCase(),
          updatedAt: String(component.updatedAt || ""),
          output: String(component.output || "").toLowerCase(),
          position: String(component.position || "").toLowerCase(),
          positionSource: String(component.positionSource || "").toLowerCase(),
          feedback: String(component.feedback || "").toLowerCase(),
          referenceRequired: component.referenceRequired === true,
          motionFault: component.motionFault === true,
          appliedMode: String(component.appliedMode || ""),
          appliedCommandVersion: String(component.appliedCommandVersion || ""),
          referenceToken: String(component.referenceToken || ""),
          referenceResult: String(component.referenceResult || ""),
        };
        const commandState = componentCommandStates.get(key);
        if (commandState?.awaitingDevice) {
          const statusChanged = componentDeviceStatuses[key].updatedAt
            && componentDeviceStatuses[key].updatedAt !== commandState.statusAtCommand;
          const timedOut = Date.now() - commandState.commandRequestedAt > 8000;
          const applied = componentDeviceStatuses[key].appliedMode === commandState.desiredMode
            && (!commandState.commandVersion || componentDeviceStatuses[key].appliedCommandVersion >= commandState.commandVersion);
          if (statusChanged && applied) {
            commandState.awaitingDevice = false;
            commandState.deviceTimedOut = false;
          } else if (timedOut) {
            commandState.awaitingDevice = false;
            commandState.deviceTimedOut = true;
          }
        }
        if (commandState?.deviceTimedOut
            && componentDeviceStatuses[key].appliedMode === commandState.desiredMode
            && (!commandState.commandVersion || componentDeviceStatuses[key].appliedCommandVersion >= commandState.commandVersion)) {
          commandState.deviceTimedOut = false;
        }
      });
      if (renderAfter && app.componentControlModal && !app.componentControlModal.hidden) {
        renderComponentControlRows(getAuthenticatedRole() === "admin");
      }
      scheduleCommandConfirmationPoll();
      return componentDeviceStatuses;
    })
    .catch(() => {
      renderSharedSystemHealth(null);
      return componentDeviceStatuses;
    })
    .finally(() => {
      componentStatusRequest = null;
    });
  return componentStatusRequest;
}

function startComponentStatusPolling() {
  if (componentStatusTimer) clearTimeout(componentStatusTimer);
  // Never from a hidden tab: each poll is a function invocation and a
  // Firebase read whether or not anyone is looking, and a hidden tab lets the
  // ESP32 drop back to its slow idle poll. The pace is chosen per tick, so a
  // page change or the control modal takes effect on the next one.
  const scheduleNext = () => {
    componentStatusTimer = setTimeout(async () => {
      if (!document.hidden) {
        await refreshComponentDeviceStatuses();
        // The monitoring page's component card reads the same statuses.
        if (state.currentPage === "monitoring") renderComponentStatusList();
      }
      scheduleNext();
    }, liveStatusIsWatched() ? COMPONENT_STATUS_POLL_INTERVAL_MS : COMPONENT_STATUS_IDLE_POLL_INTERVAL_MS);
  };
  scheduleNext();
  if (!document.hidden) void refreshComponentDeviceStatuses(false);
}

// Pages with live readings, and the open control modal, are where a viewer is
// actually watching the incubator or could press a control.
function liveStatusIsWatched() {
  return isSensorReadingPage()
    || Boolean(app.componentControlModal && !app.componentControlModal.hidden);
}

// Ends on its own once nothing is pending; each pending press already times
// out of its awaiting state after eight seconds.
function scheduleCommandConfirmationPoll() {
  if (componentConfirmationTimer) return;
  const pending = Array.from(componentCommandStates.values())
    .some((commandState) => commandState.awaitingDevice);
  if (!pending) return;
  componentConfirmationTimer = setTimeout(() => {
    componentConfirmationTimer = null;
    void refreshComponentDeviceStatuses();
  }, COMMAND_CONFIRMATION_POLL_INTERVAL_MS);
}

// The live poll's extras. Each list is refetched only when its change marker
// moves, so a quiet dashboard costs one small poll every few seconds instead
// of one per list. The first payload only records the markers.
function applyLiveStatusPayload(payload) {
  if (!payload || typeof payload !== "object") return;
  const previousLive = state.liveSensorReading || null;
  const liveReading = normalizeSensorReadings(payload.liveReading ? [payload.liveReading] : [])[0] || null;
  state.liveSensorReading = liveReading;
  const liveChanged = liveReading?.timestamp !== previousLive?.timestamp
    || liveReading?.temp !== previousLive?.temp
    || liveReading?.humidity !== previousLive?.humidity;
  if (liveChanged && isSensorReadingPage()) updateSensorReadingPage();

  if (payload.sensorHistoryAt !== undefined && payload.sensorHistoryAt !== null) {
    const historyMoved = state.sensorHistoryAt !== undefined && state.sensorHistoryAt !== payload.sensorHistoryAt;
    state.sensorHistoryAt = payload.sensorHistoryAt;
    if (historyMoved && isSensorReadingPage()) void refreshSharedSensorReadings({ rerenderCharts: true });
  }

  const revisions = payload.revisions && typeof payload.revisions === "object" ? payload.revisions : null;
  if (!revisions) return;
  const previous = state.liveRevisions;
  state.liveRevisions = { ...revisions };
  if (!previous) return;
  if (revisions.batches !== previous.batches) void syncLiveBatchUpdates();
  if (revisions.notifications !== previous.notifications
    || revisions.notification_reads !== previous.notification_reads) {
    void refreshNotificationBadgesFromBackend({ forceRefresh: true, announce: true });
  }
}

async function confirmActiveBatchComponentOverride(key, mode) {
  if (!['on', 'off'].includes(mode)) return true;
  // The background batch sync runs every few seconds, so refresh before
  // deciding: a batch that started or ended since then must pick the dialog.
  try {
    if (state.liveBatchesLoaded) {
      await syncLiveBatchUpdates();
    } else {
      renderAdminBatchState(await loadAllBatchesFromBackend());
    }
  } catch {
    // The command endpoint remains authoritative if batch lookup is unavailable.
  }
  const activeBatch = state.liveBatches.find((batch) => (
    normalizeBatchStatus(batch.status) === "in-progress"
    && Number(batch.eggCount || 0) > 0
    && batch.automationEnabled !== false
  ));
  if (!activeBatch) return true;

  const switchingOn = mode === "on";
  const isEggRolling = key === "eggRolling";
  const isFan = key === "fan";
  const isHeaterLight = key === "heaterLight";
  const isCandlingLight = key === "candlingLight";
  const result = await openActionDialog({
    eyebrow: "Active Batch Warning",
    title: isHeaterLight
      ? (switchingOn ? "Override heater automation?" : "Stop automatic heating?")
      : isCandlingLight
      ? (switchingOn ? "Override candling light automation?" : "Stop the automatic candling light?")
      : isFan
      ? (switchingOn ? "Override fan automation?" : "Stop the automatic fan?")
      : isEggRolling
      ? (switchingOn ? "Override egg rolling automation?" : "Stop automated egg rolling?")
      : (switchingOn ? "Override actuator automation?" : "Stop the automated actuator?"),
    body: isHeaterLight
      ? (switchingOn
          ? `Batch ${activeBatch.id} is using automatic temperature control. Switching to ON will keep the heater and light running until another mode is selected. Continue?`
          : `Batch ${activeBatch.id} is using automatic temperature control. Switching to OFF will pause heating until AUTO is selected again. Continue?`)
      : isCandlingLight
      ? (switchingOn
          ? `Batch ${activeBatch.id} is using the automatic Day-7 candling light. Switching to ON will keep the light running until another mode is selected. Continue?`
          : `Batch ${activeBatch.id} is using the automatic Day-7 candling light. Switching to OFF will keep it dark during the scheduled lowering until AUTO is selected again. Continue?`)
      : isFan
      ? (switchingOn
          ? `Batch ${activeBatch.id} is using automatic temperature control. Switching to ON will keep the fan running until another mode is selected. Continue?`
          : `Batch ${activeBatch.id} is using automatic temperature control. Switching to OFF will pause fan cooling until AUTO is selected again. Continue?`)
      : isEggRolling
      ? (switchingOn
          ? `Batch ${activeBatch.id} is using automatic egg rolling. Switching to ON will keep the relay and egg-turning motor running until another mode is selected. Continue?`
          : `Batch ${activeBatch.id} is using automatic egg rolling. Switching to OFF will stop the motor and pause its 4-hour rolling schedule until AUTO is selected again. Continue?`)
      : (switchingOn
          ? `Batch ${activeBatch.id} is using automatic actuator scheduling. Switching to ON will override AUTO and continuously cycle the actuator until another mode is selected. Continue?`
          : `Batch ${activeBatch.id} is using automatic actuator scheduling. Switching to OFF will stop the actuator and pause its scheduled candling movement until AUTO is selected again. Continue?`),
    confirmLabel: "Yes, Continue",
    cancelLabel: "No, Cancel",
    tone: "danger",
  });
  return result.confirmed;
}

function ensureComponentControlModal() {
  if (app.componentControlModal) return app.componentControlModal;

  const wrapper = document.createElement("div");
  wrapper.id = "component-control-modal";
  wrapper.className = "settings-info-modal component-control-modal";
  wrapper.hidden = true;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = `
    <button class="settings-info-modal__backdrop" type="button" tabindex="-1" aria-label="Close component controls"></button>
    <section class="settings-info-modal__card" role="dialog" aria-modal="true" aria-labelledby="component-control-title">
      <div class="settings-info-modal__topbar">
        <div>
          <h2 id="component-control-title" class="settings-info-modal__title">Components</h2>
          <p class="settings-info-modal__copy" data-component-control-copy></p>
        </div>
        <button class="settings-info-modal__close" type="button" aria-label="Close component controls">${renderIcon("x-circle")}</button>
      </div>
      <div class="component-control-list" data-component-control-list></div>
    </section>
  `;

  document.body.appendChild(wrapper);
  app.componentControlModal = wrapper;
  wrapper.querySelector(".settings-info-modal__backdrop")?.addEventListener("click", closeComponentControlModal);
  wrapper.querySelector(".settings-info-modal__close")?.addEventListener("click", closeComponentControlModal);
  wrapper.querySelector("[data-component-control-list]")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-component-mode]");
    if (!button || button.disabled || getAuthenticatedRole() !== "admin") return;
    const row = button.closest("[data-component-key]");
    const key = row?.dataset.componentKey;
    const mode = button.dataset.componentMode;
    if (!key || !mode) return;
    event.preventDefault();
    if (key === "actuator" && mode === "off") {
      ++componentModeIntentSequence;
      queueComponentModeCommand(key, mode, true);
      return;
    }
    if (componentConfirmationPending) return;
    const intent = ++componentModeIntentSequence;
    if (getComponentModes()[key] === mode) return;
    if (["eggRolling", "fan", "heaterLight", "candlingLight"].includes(key) && ["on", "off"].includes(mode)) {
      componentConfirmationPending = true;
      let confirmed = false;
      try {
        confirmed = await confirmActiveBatchComponentOverride(key, mode);
      } finally {
        componentConfirmationPending = false;
      }
      if (!confirmed || intent !== componentModeIntentSequence) return;
    }
    queueComponentModeCommand(key, mode, true);
  });
  return wrapper;
}

function renderComponentControlRows(isEditable) {
  const modal = ensureComponentControlModal();
  const copy = modal.querySelector("[data-component-control-copy]");
  if (copy) {
    copy.textContent = isEditable
      ? "Choose OFF, ON, or AUTO. Actuator ON repeats the L29 down/up cycle with a pause before each restart; OFF stops when received by the device."
      : "Current component mode. Contact an administrator to change these settings.";
  }

  const list = modal.querySelector("[data-component-control-list]");
  if (!list) return;
  const modes = getComponentModes();

  list.innerHTML = COMPONENT_CONTROL_DEFS.map(({ key, label, copyByMode, icon, modes: allowedModes }) => {
    const isSaving = componentControlSavingKeys.has(key);
    const commandState = componentCommandStates.get(key);
    const isSynchronizing = isSaving || commandState?.awaitingDevice;
    const deviceStatus = componentDeviceStatuses[key]?.status || "unknown";
    const deviceOutput = componentDeviceStatuses[key]?.output || "";
    const devicePosition = componentDeviceStatuses[key]?.position || "";
    const positionSource = componentDeviceStatuses[key]?.positionSource || "";
    const statusLabel = isSynchronizing
      ? "SYNCING"
      : commandState?.deviceTimedOut ? "NOT CONFIRMED"
      : deviceStatus === "active"
        ? (key === "actuator" ? "RUNNING" : (["eggRolling", "fan", "heaterLight", "candlingLight"].includes(key) ? "ON" : "ACTIVE"))
        : deviceStatus === "warning"
          ? "WARNING"
          : deviceStatus === "off"
            ? (key === "actuator" ? "IDLE" : "OFF")
            : "WAITING";
    const deviceDetail = key === "actuator"
      ? `OUTPUT: ${(deviceOutput || "unknown").toUpperCase()} | ${positionSource === "timed-cycle" ? "CYCLE PHASE" : "POSITION"}: ${(devicePosition || "unknown").toUpperCase()}${positionSource === "timed-cycle" ? " (TIMED)" : positionSource === "estimated" ? " (ESTIMATED)" : ""}`
      : key === "eggRolling"
        ? `RELAY OUTPUT: ${(deviceOutput || "unknown").toUpperCase()}${componentDeviceStatuses[key]?.feedback === "gpio-readback" ? " (GPIO READBACK)" : ""}`
        : key === "fan"
          ? `GPIO 13 RELAY: ${(deviceOutput || "unknown").toUpperCase()}${componentDeviceStatuses[key]?.feedback === "gpio-readback" ? " (GPIO READBACK)" : ""}`
        : key === "heaterLight"
          ? `GPIO 23 RELAY IN1: ${(deviceOutput || "unknown").toUpperCase()}${componentDeviceStatuses[key]?.feedback === "gpio-readback" ? " (GPIO READBACK)" : ""}`
        : key === "candlingLight"
          ? `GPIO 22 RELAY IN2: ${(deviceOutput || "unknown").toUpperCase()}${componentDeviceStatuses[key]?.feedback === "gpio-readback" ? " (GPIO READBACK)" : ""}`
        : "";
    const actuatorMotionFault = key === "actuator" && componentDeviceStatuses[key]?.motionFault;
    const legacyFirmwareLocked = key === "actuator" && componentDeviceStatuses[key]?.referenceRequired;
    const rowCopy = actuatorMotionFault
      ? "The driver or cutoff reported a fault. Stop motor power and check the controller before restarting."
      : legacyFirmwareLocked
        ? "This ESP32 still has the older calibration-lock firmware. Upload the latest L29 firmware to enable direct ON/OFF/AUTO control."
        : (copyByMode[modes[key]] || "");
    return `
    <div class="component-control-row ${isSynchronizing ? "is-saving" : ""}" data-component-key="${key}" aria-busy="${isSynchronizing}">
      <span class="component-control-row__icon" data-icon="${icon}"></span>
      <span class="component-control-row__text">
        <span class="component-control-row__label">${escapeHtml(label)}</span>
        <span class="component-control-row__copy" data-component-mode-copy>${escapeHtml(rowCopy)}</span>
        <span class="component-control-row__device-status component-control-row__device-status--${escapeHtml(statusLabel.toLowerCase())}" data-component-device-status>
          <span class="component-control-row__device-dot" aria-hidden="true"></span>
          DEVICE: ${escapeHtml(!isSynchronizing && actuatorMotionFault ? "SAFETY STOP" : !isSynchronizing && legacyFirmwareLocked ? "FIRMWARE UPDATE REQUIRED" : statusLabel)}
        </span>
        ${deviceDetail ? `<span class="component-control-row__device-detail">${escapeHtml(deviceDetail)}</span>` : ""}
      </span>
      <div class="component-control-toggle ${isEditable ? "" : "is-readonly"}" style="--component-mode-count:${allowedModes.length}" role="group" aria-label="${escapeHtml(label)} mode">
        ${allowedModes.map((mode) => `
          <button
            type="button"
            class="component-control-toggle__option ${modes[key] === mode ? "is-active" : ""}"
            data-component-mode="${mode}"
            ${isEditable && !(actuatorMotionFault && mode !== "off") ? "" : "disabled"}
          >${mode.toUpperCase()}</button>
        `).join("")}
      </div>
    </div>
  `;
  }).join("");

  hydrateIcons(list);
}

function closeComponentControlModal() {
  const modal = app.componentControlModal;
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  // The live status poll keeps running for the rest of the page.
}

async function openComponentControlModal() {
  const modal = ensureComponentControlModal();
  try {
    await Promise.all([
      loadAdminSettingsFromBackend(true),
      refreshComponentDeviceStatuses(false),
    ]);
  } catch {
    // Fall back to the locally cached component modes.
  }
  const confirmedModes = getComponentModes();
  COMPONENT_CONTROL_DEFS.forEach(({ key }) => {
    const state = componentCommandStates.get(key);
    if (state && !state.running) {
      state.confirmedMode = confirmedModes[key];
      state.desiredMode = confirmedModes[key];
    }
  });
  renderComponentControlRows(getAuthenticatedRole() === "admin");
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  startComponentStatusPolling();
}

const SETTINGS_INFO_CONTENT = {
  guide: {
    admin: {
      title: "Guide",
      steps: [
        ["Dashboard", "Check live temperature, humidity, and production stats at a glance."],
        ["Monitoring", "Track sensor readings and component status in real time."],
        ["Components", "Switch DHT ON/OFF and control actuator or egg rolling ON, OFF, or AUTO."],
        ["Reports", "Review batch performance and hatch success rates."],
        ["History", "Look back at past readings, alerts, and activity."],
        ["User Management", "Create and manage operator accounts."],
      ],
    },
    user: {
      title: "Guide",
      steps: [
        ["Dashboard", "Check live temperature, humidity, and production stats at a glance."],
        ["Monitoring", "Track sensor readings and component status in real time."],
        ["Batch Management", "Log and follow your egg batches through incubation."],
        ["Schedules", "See candling days and the egg turning schedule."],
        ["Reports", "Review your incubation history and results."],
        ["History", "Look back at past readings, alerts, and activity."],
      ],
    },
  },
  developer: {
    title: "Developer",
    team: [
      {
        name: "Mac Dave Biago",
        role: "Leader",
        isLeader: true,
        image: "../assets/Mac_Dave_Biago.jpg",
        description: "Team leader. Built the app and developed the IoT device.",
      },
      {
        name: "Sophia Bianca Bihasa",
        role: "Design",
        image: "../assets/Sophia_Bianca_Bihasa.jpg",
        description: "Worked on the dashboard design.",
      },
      {
        name: "Baby April Lavarro",
        role: "Documentation",
        image: "../assets/Baby_April_Lavarro.jpg",
        description: "Worked on the project documentation.",
      },
      {
        name: "Chenie Polloso",
        role: "Documentation",
        image: "../assets/Chenie_Polloso.jpg",
        description: "Worked on the project documentation.",
      },
    ],
  },
};

function ensureSettingsInfoModal() {
  if (app.settingsInfoModal) return app.settingsInfoModal;

  const wrapper = document.createElement("div");
  wrapper.id = "settings-info-modal";
  wrapper.className = "settings-info-modal";
  wrapper.hidden = true;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = `
    <button class="settings-info-modal__backdrop" type="button" tabindex="-1" aria-label="Close"></button>
    <section class="settings-info-modal__card" role="dialog" aria-modal="true" aria-labelledby="settings-info-title">
      <div class="settings-info-modal__topbar">
        <div>
          <p class="settings-info-modal__eyebrow">Settings</p>
          <h2 id="settings-info-title" class="settings-info-modal__title" data-settings-info-title></h2>
        </div>
        <button class="settings-info-modal__close" type="button" aria-label="Close">${renderIcon("x-circle")}</button>
      </div>
      <div class="settings-info-list" data-settings-info-list></div>
    </section>
  `;

  document.body.appendChild(wrapper);
  app.settingsInfoModal = wrapper;
  wrapper.querySelector(".settings-info-modal__backdrop")?.addEventListener("click", closeSettingsInfoModal);
  wrapper.querySelector(".settings-info-modal__close")?.addEventListener("click", closeSettingsInfoModal);
  return wrapper;
}

function closeSettingsInfoModal() {
  const modal = app.settingsInfoModal;
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
}

function renderDeveloperTeamMarkup(team) {
  return `
    <div class="dev-team-intro">
      <h3 class="dev-team-intro__title">Meet the Team</h3>
      <p class="dev-team-intro__copy">The people behind SmartDuck</p>
    </div>
    <div class="dev-team-grid">
      ${team.map((member) => `
        <div class="dev-team-card ${member.isLeader ? "dev-team-card--leader" : ""}">
          ${member.isLeader ? '<span class="dev-team-card__badge">Leader</span>' : ""}
          <span class="dev-team-avatar">
            <img src="${escapeHtml(member.image)}" alt="${escapeHtml(member.name)}" loading="lazy" />
          </span>
          <p class="dev-team-card__name">${escapeHtml(member.name)}</p>
          <p class="dev-team-card__role">${escapeHtml(member.role)}</p>
          <p class="dev-team-card__copy">${escapeHtml(member.description)}</p>
        </div>
      `).join("")}
    </div>
  `;
}

function openSettingsInfoModal(kind) {
  const modal = ensureSettingsInfoModal();
  modal.classList.toggle("settings-info-modal--developer", kind === "developer");

  if (kind === "developer") {
    const content = SETTINGS_INFO_CONTENT.developer;
    modal.querySelector("[data-settings-info-title]").textContent = content.title;
    modal.querySelector("[data-settings-info-list]").innerHTML = renderDeveloperTeamMarkup(content.team);
  } else {
    const content = kind === "guide"
      ? SETTINGS_INFO_CONTENT.guide[getAuthenticatedRole() === "admin" ? "admin" : "user"]
      : null;
    if (!content) return;
    modal.querySelector("[data-settings-info-title]").textContent = content.title;
    modal.querySelector("[data-settings-info-list]").innerHTML = content.steps.map(([label, copy]) => `
      <div class="settings-info-row">
        <span class="settings-info-row__label">${escapeHtml(label)}</span>
        <span class="settings-info-row__copy">${escapeHtml(copy)}</span>
      </div>
    `).join("");
  }

  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
}

function initializeSettingsPage() {
  if (state.currentPage !== "settings" || !app.pageRoot) return;

  app.pageRoot.querySelectorAll("[data-settings-menu]").forEach((button) => {
    if (button.dataset.settingsBound === "true") return;
    button.dataset.settingsBound = "true";
    button.dataset.uiBound = "true";
    button.addEventListener("click", () => {
      const menu = button.dataset.settingsMenu;
      if (menu === "components") {
        void openComponentControlModal();
      } else if (menu === "guide" || menu === "developer") {
        openSettingsInfoModal(menu);
      } else if (menu === "logout") {
        void requestLogout();
      }
    });
  });
}

let chartVisibilityObserver = null;
let chartPlotClipSequence = 0;

function createEnvironmentSensorChartConfig(metric, height) {
  const isTemperature = metric === "temperature";
  const key = isTemperature ? "temp" : "humidity";
  const unit = isTemperature ? "\u00B0C" : "%";
  return {
    data: temperatureData,
    rangeKind: "sensor-hours",
    xKey: "time",
    xTimeKey: "recordedAt",
    height,
    marginLeft: 54,
    xAxis: { formatTick: formatSensorChartTick },
    leftAxis: {
      domain: (values) => inferSensorDomain(values, isTemperature ? 1 : 5, isTemperature ? [-40, 80] : [0, 100]),
      formatTick: (value) => value.toFixed(1),
    },
    series: [{
      key,
      label: isTemperature ? "Temperature" : "Humidity",
      color: isTemperature ? "#f59e0b" : "#3b82f6",
      style: "line",
      interpolation: "linear",
      showDots: false,
      formatter: (value) => `${value.toFixed(1)}${isTemperature ? ` ${unit}` : unit}`,
    }],
  };
}

const chartRegistry = {
  dashboard: [
    { id: "chart-admin-dashboard-temperature", type: "xy", config: createEnvironmentSensorChartConfig("temperature", 300) },
    { id: "chart-admin-dashboard-humidity", type: "xy", config: createEnvironmentSensorChartConfig("humidity", 300) },
    { id: "chart-admin-dashboard-production", type: "bar", config: { data: adminProductionMonthlyData, categoryKey: "week", height: 280, domain: [0, 1500], maxBarWidth: 48, rangeData: { month: { data: adminProductionMonthlyData, categoryKey: "week", domain: [0, 1500] }, week: { data: adminProductionWeeklyData, categoryKey: "day", domain: [0, 300], maxBarWidth: 34 } }, series: [{ key: "eggs", label: "Eggs", color: "#3b82f6", formatter: (value) => `${value}` }, { key: "pendy", label: "Pendy", color: "#22c55e", formatter: (value) => `${value}` }] } },
  ],
  userDashboard: [
    { id: "chart-dashboard-temperature", type: "xy", config: createEnvironmentSensorChartConfig("temperature", 286) },
    { id: "chart-dashboard-humidity", type: "xy", config: createEnvironmentSensorChartConfig("humidity", 286) },
    { id: "chart-dashboard-egg-distribution", type: "pie", config: { data: userEggDistribution, height: 272, donut: true, radiusScale: 0.33, innerRadiusRatio: 0.62, centerFill: "#f8fafc", centerLabel: ["Total", "60", "Eggs"], showLabels: false } },
  ],
  monitoring: [
    { id: "chart-monitoring-temperature", type: "xy", config: createEnvironmentSensorChartConfig("temperature", 250) },
    { id: "chart-monitoring-humidity", type: "xy", config: createEnvironmentSensorChartConfig("humidity", 250) },
  ],
  userMonitoring: [
    { id: "chart-monitoring-temperature", type: "xy", config: createEnvironmentSensorChartConfig("temperature", 286) },
    { id: "chart-monitoring-humidity", type: "xy", config: createEnvironmentSensorChartConfig("humidity", 286) },
  ],
  batch: [
    { id: "chart-batch-progress", type: "bar", config: { data: batchProgressData, categoryKey: "batch", height: 300, domain: [0, 24], series: [{ key: "day", label: "Current Day", color: "#3b82f6", formatter: (value) => `Day ${value}` }, { key: "target", label: "Target Day", color: "#e5e7eb", formatter: (value) => `Day ${value}` }] } },
    { id: "chart-batch-success", type: "bar", config: { data: successRateData, categoryKey: "batch", height: 300, domain: [0, 100], stacked: true, series: [{ key: "balut", label: "Balut (%)", color: "#22c55e", formatter: (value) => `${value}%` }, { key: "penoy", label: "Penoy (%)", color: "#f97316", formatter: (value) => `${value}%` }] } },
  ],
  userBatch: [
    { id: "chart-batch-temperature", type: "xy", config: createEnvironmentSensorChartConfig("temperature", 240) },
    { id: "chart-batch-humidity", type: "xy", config: createEnvironmentSensorChartConfig("humidity", 240) },
    { id: "chart-batch-distribution", type: "pie", config: { data: userBatchDistribution, height: 292, donut: true, radiusScale: 0.37, innerRadiusRatio: 0.62, centerFill: "#f8fafc", centerLabel: ["Total", "0", "Eggs"], showLabels: false } },
    { id: "chart-batch-performance", type: "bar", config: { data: userBatchPerformance, categoryKey: "month", height: 250, domain: [0, 100], stacked: true, series: [{ key: "completed", label: "Completed", color: "#f59e0b", formatter: (value) => `${value}%` }, { key: "inProgress", label: "In Progress", color: "#fbbf24", formatter: (value) => `${value}%` }] } },
  ],
  userHistory: [
    { id: "chart-history-temperature", type: "xy", config: createEnvironmentSensorChartConfig("temperature", 250) },
    { id: "chart-history-humidity", type: "xy", config: createEnvironmentSensorChartConfig("humidity", 250) },
  ],
  userNotifications: [],
  userSchedule: [],
  candling: [
    { id: "chart-candling-results", type: "bar", config: { data: candlingResults, categoryKey: "batch", height: 350, domain: [0, 60], series: [{ key: "balut", label: "Balut", color: "#22c55e", formatter: (value) => `${value}` }, { key: "penoy", label: "Penoy", color: "#f97316", formatter: (value) => `${value}` }] } },
    { id: "chart-candling-weekly", type: "xy", config: { data: weeklyTrend, xKey: "week", height: 350, leftAxis: { domain: [70, 95] }, series: [{ key: "balutRate", label: "Success Rate (%)", color: "#22c55e", style: "line", formatter: (value) => `${value}%` }] } },
    { id: "chart-candling-distribution", type: "pie", config: { data: distributionData, height: 300 } },
  ],
};

function isLoginScreen() {
  return document.body.dataset.page === "login";
}

function getMenuItems(role = getAuthenticatedRole()) {
  return MENU_ITEMS[normalizeRole(role)] || MENU_ITEMS.admin;
}

function getSidebarMenuItems(role = getAuthenticatedRole()) {
  return getMenuItems(role).filter((item) => item.hiddenFromSidebar !== true);
}

function getDefaultPageId(role = getAuthenticatedRole()) {
  return getMenuItems(role)[0].id;
}

function isPageAllowed(pageId, role = getAuthenticatedRole()) {
  return getMenuItems(role).some((item) => item.id === pageId);
}

function getMenuItem(pageId, role = getAuthenticatedRole()) {
  return getMenuItems(role).find((item) => item.id === pageId) || getMenuItems(role)[0];
}

function getCurrentPage() {
  const pageId = document.body.dataset.page || "";
  return isPageAllowed(pageId) ? pageId : getDefaultPageId();
}

function getPageBasePath(targetRole = getAuthenticatedRole()) {
  const normalizedTargetRole = normalizeRole(targetRole);
  const targetDirectory = normalizedTargetRole;
  const currentRolePath = getPathRole();

  if (!currentRolePath) {
    return `./${targetDirectory}/`;
  }

  if (currentRolePath === normalizedTargetRole) {
    return "./";
  }

  return `../${targetDirectory}/`;
}

function getPageUrl(pageId, role = getAuthenticatedRole()) {
  return `${getPageBasePath(role)}${getMenuItem(pageId, role).file}`;
}

function getAssetPath(fileName) {
  return `${getPathRole() ? ".." : "."}/assets/${fileName}`;
}

function canUseSoftNavigation(role = getAuthenticatedRole()) {
  const normalizedRole = normalizeRole(role);
  return Boolean(
    document.getElementById("dashboard-container")
    && !isLoginScreen()
    && normalizedRole === getAuthenticatedRole()
    && normalizedRole === getPathRole(),
  );
}

function redirectToPage(pageId, role = getAuthenticatedRole(), { replaceHistory = false } = {}) {
  if (!replaceHistory && canUseSoftNavigation(role) && isPageAllowed(pageId, role)) {
    void navigateToPage(pageId, role);
    return;
  }
  const pageUrl = getPageUrl(pageId, role);
  if (replaceHistory) {
    window.location.replace(pageUrl);
  } else {
    window.location.assign(pageUrl);
  }
}

function redirectToLogin({ replaceHistory = true } = {}) {
  const loginUrl = getPathRole() ? "../" : "./";
  if (replaceHistory) {
    window.location.replace(loginUrl);
  } else {
    window.location.assign(loginUrl);
  }
}

function getPageTemplateCacheKey(pageId, role = getAuthenticatedRole()) {
  return `${normalizeRole(role)}:${pageId}`;
}

function getAbsolutePageUrl(pageId, role = getAuthenticatedRole()) {
  return new URL(getPageUrl(pageId, role), window.location.href).href;
}

function parsePageTemplate(sourceDocument, url, pageId) {
  const dashboardContainer = sourceDocument.getElementById("dashboard-container");
  if (!dashboardContainer) {
    throw new Error(`Dashboard shell missing for ${pageId}.`);
  }

  return {
    url,
    title: sourceDocument.title,
    bodyClass: sourceDocument.body.className,
    containerHtml: dashboardContainer.innerHTML,
  };
}

function cacheCurrentPageTemplate(role = getAuthenticatedRole()) {
  const dashboardContainer = document.getElementById("dashboard-container");
  if (!dashboardContainer) return;

  pageTemplateCache.set(
    getPageTemplateCacheKey(state.currentPage, role),
    parsePageTemplate(document, window.location.href, state.currentPage),
  );
}

async function loadPageTemplate(pageId, role = getAuthenticatedRole()) {
  const cacheKey = getPageTemplateCacheKey(pageId, role);
  const cachedTemplate = pageTemplateCache.get(cacheKey);
  if (cachedTemplate) return cachedTemplate;

  const url = getAbsolutePageUrl(pageId, role);
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Unable to open ${pageId}.`);
  }

  const sourceDocument = new DOMParser().parseFromString(await response.text(), "text/html");
  const template = parsePageTemplate(sourceDocument, url, pageId);
  pageTemplateCache.set(cacheKey, template);
  return template;
}

function preloadRolePages(role = getAuthenticatedRole()) {
  getMenuItems(role).forEach((item) => {
    void loadPageTemplate(item.id, role).catch(() => {});
  });
}

function getPageIdFromLocation(role = getAuthenticatedRole()) {
  const fileName = window.location.pathname.split("/").pop()?.toLowerCase() || "";
  return getMenuItems(role).find((item) => item.file.toLowerCase() === fileName)?.id || getDefaultPageId(role);
}

function updatePageHistory(pageId, url, historyMode) {
  if (historyMode === "none") return;
  const method = historyMode === "replace" ? "replaceState" : "pushState";
  window.history[method]({ smartduckPage: pageId, smartduckProtectedEntry: true }, "", url);
}

function syncElementAttributes(target, source) {
  Array.from(target.attributes).forEach((attribute) => {
    if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
  });
  Array.from(source.attributes).forEach((attribute) => {
    target.setAttribute(attribute.name, attribute.value);
  });
}

function syncSidebarNavigationState() {
  if (!app.sidebarContent) return;

  app.sidebarContent.querySelectorAll("[data-page]").forEach((item) => {
    const isActive = item.dataset.page === state.currentPage;
    item.classList.toggle("is-active", isActive);
    item.classList.remove("is-navigation-pending");
    if (isActive) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  });

  app.sidebarContent.querySelectorAll("[data-settings-toggle]").forEach((item) => {
    const isActive = state.currentPage === "settings";
    item.classList.toggle("is-active", isActive);
    item.classList.remove("is-navigation-pending");
    if (isActive) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  });
}

function buildIncomingDashboardContainer(containerHtml) {
  const container = document.createElement("div");
  container.innerHTML = containerHtml;
  return container;
}

function replacePersistentPageContent(incomingContainer) {
  const currentPageRoot = app.pageRoot;
  const incomingPageRoot = incomingContainer.querySelector("#page-root");
  if (!currentPageRoot || !incomingPageRoot) {
    throw new Error("Page content missing from the requested route.");
  }

  const currentHeader = currentPageRoot.querySelector(":scope > .page-header--dashboard");
  const incomingHeader = incomingPageRoot.querySelector(":scope > .page-header--dashboard");

  if (currentHeader && incomingHeader) {
    syncElementAttributes(currentHeader, incomingHeader);
    currentHeader.replaceChildren(...Array.from(incomingHeader.childNodes));
    incomingHeader.replaceWith(currentHeader);
  }

  syncElementAttributes(currentPageRoot, incomingPageRoot);
  currentPageRoot.replaceChildren(...Array.from(incomingPageRoot.childNodes));
}

function replaceRouteAuxiliaryElements(incomingContainer) {
  if (!app.dashboardContainer) return;

  const isPersistentShellNode = (node) => node.matches?.(
    ".mobile-topbar, .app-shell, #toast-region, #chart-tooltip, #sd-bottom-nav",
  );

  Array.from(app.dashboardContainer.children).forEach((node) => {
    if (!isPersistentShellNode(node)) node.remove();
  });

  Array.from(incomingContainer.children).forEach((node) => {
    if (!isPersistentShellNode(node)) app.dashboardContainer.appendChild(node);
  });
}

function animateEnteringRouteContent() {
  const enteringContent = Array.from(app.pageRoot?.children || [])
    .filter((node) => !node.matches(".page-header--dashboard"));

  enteringContent.forEach((node) => {
    node.classList.add("route-content--enter");
    node.addEventListener("animationend", () => {
      node.classList.remove("route-content--enter");
    }, { once: true });
  });
}

function initializeProtectedHistory() {
  if (window.history.state?.smartduckProtectedEntry === true) return;
  window.history.replaceState({ smartduckAuthBoundary: true }, "", window.location.href);
  window.history.pushState(
    { smartduckPage: state.currentPage, smartduckProtectedEntry: true },
    "",
    window.location.href,
  );
}

function applyPageTemplate(template, pageId, role, historyMode) {
  if (app.actionDialog && !app.actionDialog.hidden) {
    closeActionDialog({ confirmed: false, value: "" });
  }
  closeNotificationModal({ restoreFocus: false });

  disconnectChartVisibilityObserver();
  clearTooltip();
  closeSidebar();
  document.dispatchEvent(new CustomEvent("smartduck:before-route-swap"));
  updatePageHistory(pageId, template.url, historyMode);

  document.title = template.title;
  document.body.className = template.bodyClass;
  document.body.dataset.page = pageId;
  const incomingContainer = buildIncomingDashboardContainer(template.containerHtml);
  replacePersistentPageContent(incomingContainer);
  replaceRouteAuxiliaryElements(incomingContainer);
  state.currentPage = pageId;
  state.managedUserSelection = "";

  refreshDashboardAppReferences();
  syncSidebarNavigationState();
  renderCurrentPage();
  initializeUserManagement();
  bindShellElementEvents();
  syncModalOpenState();

  animateEnteringRouteContent();
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  document.querySelector(".main-content")?.scrollTo({ top: 0, left: 0, behavior: "instant" });
  document.dispatchEvent(new CustomEvent("smartduck:route-changed", {
    detail: { pageId, role },
  }));
  preloadRolePages(role);
}

async function navigateToPage(pageId, role = getAuthenticatedRole(), { historyMode = "push" } = {}) {
  const normalizedRole = normalizeRole(role);
  if (!isPageAllowed(pageId, normalizedRole)) return;
  if (!canUseSoftNavigation(normalizedRole)) {
    window.location.href = getPageUrl(pageId, normalizedRole);
    return;
  }
  if (pageId === state.currentPage) {
    closeSidebar();
    return;
  }

  const requestId = ++navigationRequestId;
  try {
    const template = await loadPageTemplate(pageId, normalizedRole);
    if (requestId !== navigationRequestId) return;
    applyPageTemplate(template, pageId, normalizedRole, historyMode);
  } catch {
    window.location.href = getPageUrl(pageId, normalizedRole);
  }
}

function pageLabel(pageId) {
  return getMenuItem(pageId).label;
}

function renderIcon(name, extraClass = "") {
  const base = icons[name] || "";
  if (!extraClass) return base;
  return base.replace('class="icon', `class="icon ${extraClass}`);
}

function initials(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function summaryCard(iconName, label, value, gradient, meta) {
  return `
    <article class="summary-card">
      <div class="summary-card__icon" style="background:${gradient};">
        ${renderIcon(iconName)}
      </div>
      <div>
        <p class="summary-card__label">${label}</p>
        <p class="summary-card__value">${value}</p>
        <p class="summary-card__meta">${meta}</p>
      </div>
    </article>
  `;
}

function renderEggGrid() {
  return Array.from({ length: 60 }, (_, index) => {
    const type = index < 48 ? "balut" : "penoy";
    return `<div class="egg-cell egg-cell--${type}" title="Egg ${index + 1} - ${type === "balut" ? "Balut" : "Penoy"}"></div>`;
  }).join("");
}

function renderSidebarMenuRow(item, navClass, role) {
  const isActive = item.id === state.currentPage;
  if (item.id === "settings") {
    return `
      <div class="sidebar-settings-anchor">
        <button type="button" class="${navClass} ${isActive ? "is-active" : ""}" data-settings-toggle aria-haspopup="true" aria-expanded="false">
          <span class="${navClass}__icon">${renderIcon(item.icon)}</span>
          <span class="${navClass}__label">${item.label}</span>
        </button>
      </div>
    `;
  }

  const badge = item.id === "notifications" ? `<span class="${navClass}__badge" hidden aria-hidden="true">0</span>` : "";
  return `
    <a class="${navClass} ${isActive ? "is-active" : ""}" href="${getPageUrl(item.id, role)}" data-page="${item.id}" ${isActive ? 'aria-current="page"' : ""}>
      <span class="${navClass}__icon">${renderIcon(item.icon)}</span>
      <span class="${navClass}__label">${item.label}</span>
      ${badge}
    </a>
  `;
}

function buildSettingsFlyoutRows(role) {
  const rows = [];
  if (role === "admin") rows.push(["components", "cpu", "components", "Components"]);
  rows.push(["guide", "book-open", "guide", "Guide"]);
  rows.push(["developer", "code", "developer", "Developer"]);
  rows.push(["logout", "power", "logout", "Logout"]);

  return rows.map(([menu, icon, variant, label]) => `
    <button type="button" class="settings-menu-row settings-flyout__row ${menu === "logout" ? "settings-menu-row--danger" : ""}" data-settings-menu="${menu}" role="menuitem">
      <span class="settings-menu-row__icon settings-menu-row__icon--${variant}" data-icon="${icon}"></span>
      <span class="settings-menu-row__text">
        <span class="settings-menu-row__label">${escapeHtml(label)}</span>
      </span>
    </button>
  `).join("");
}

function ensureSettingsFlyout() {
  if (app.settingsFlyout) return app.settingsFlyout;
  const flyout = document.createElement("div");
  flyout.className = "settings-flyout";
  flyout.hidden = true;
  flyout.setAttribute("role", "menu");
  document.body.appendChild(flyout);
  app.settingsFlyout = flyout;
  return flyout;
}

function positionSettingsFlyout(trigger, flyout) {
  const margin = 12;
  const rect = trigger.getBoundingClientRect();
  const flyoutRect = flyout.getBoundingClientRect();

  let top = rect.top;
  top = Math.min(top, window.innerHeight - flyoutRect.height - margin);
  top = Math.max(top, margin);

  let left = rect.right + 10;
  if (left + flyoutRect.width > window.innerWidth - margin) {
    left = rect.left - flyoutRect.width - 10;
  }
  left = Math.max(left, margin);

  flyout.style.top = `${Math.round(top)}px`;
  flyout.style.left = `${Math.round(left)}px`;
}

function closeSettingsFlyout() {
  const flyout = app.settingsFlyout;
  if (flyout) {
    flyout.hidden = true;
    flyout.classList.remove("is-open");
  }
  app.settingsFlyoutTrigger?.setAttribute("aria-expanded", "false");
  app.settingsFlyoutTrigger?.classList.remove("is-open");
  app.settingsFlyoutTrigger = null;
}

function toggleSettingsFlyout(trigger) {
  const flyout = ensureSettingsFlyout();
  const willOpen = flyout.hidden || app.settingsFlyoutTrigger !== trigger;
  closeSettingsFlyout();
  if (!willOpen) return;

  flyout.innerHTML = buildSettingsFlyoutRows(getAuthenticatedRole());
  hydrateIcons(flyout);
  flyout.querySelectorAll("[data-settings-menu]").forEach((button) => {
    button.addEventListener("click", () => {
      const menu = button.dataset.settingsMenu;
      closeSettingsFlyout();
      if (menu === "components") void openComponentControlModal();
      else if (menu === "guide" || menu === "developer") openSettingsInfoModal(menu);
      else if (menu === "logout") void requestLogout();
    });
  });

  flyout.style.visibility = "hidden";
  flyout.hidden = false;
  positionSettingsFlyout(trigger, flyout);
  flyout.style.visibility = "";
  flyout.classList.add("is-open");
  trigger.setAttribute("aria-expanded", "true");
  trigger.classList.add("is-open");
  app.settingsFlyoutTrigger = trigger;
  bindSettingsFlyoutDismissal();
}

function bindSettingsFlyoutDismissal() {
  if (document.documentElement.dataset.settingsFlyoutDismissalBound === "true") return;
  document.documentElement.dataset.settingsFlyoutDismissalBound = "true";

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".settings-flyout, [data-settings-toggle]")) return;
    closeSettingsFlyout();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSettingsFlyout();
  });

  window.addEventListener("resize", closeSettingsFlyout);
  window.addEventListener("scroll", closeSettingsFlyout, true);
}

function renderSidebar() {
  if (!app.sidebarContent || !app.sidebar) return;

  closeSettingsFlyout();
  const role = getAuthenticatedRole();
  const userName = getAuthenticatedUser();
  const userInitials = initials(userName);
  const userRole = getRoleLabel();
  const isUserRole = role === "user";

  app.sidebar.classList.toggle("sidebar--user", isUserRole);
  app.sidebar.classList.toggle("sidebar--admin", role === "admin");

  if (isUserRole) {
    app.sidebarContent.innerHTML = `
      <div class="user-sidebar">
        <div class="user-sidebar__header">
          <div class="user-sidebar__brand">
            <img class="user-sidebar__logo" src="${getAssetPath("logo-transparent.png")}" alt="SmartDuck logo" />
            <div>
              <h1 class="user-sidebar__title">SmartDuck</h1>
              <p class="user-sidebar__copy">IoT Egg Incubation System</p>
            </div>
          </div>
        </div>

        <nav class="user-sidebar__nav" aria-label="User navigation">
          ${getSidebarMenuItems(role)
            .map((item) => renderSidebarMenuRow(item, "user-nav-button", role))
            .join("")}
        </nav>

        <div class="user-sidebar__spacer"></div>
      </div>
    `;
  } else {
    app.sidebarContent.innerHTML = `
      <div class="admin-sidebar">
        <div class="admin-sidebar__header">
          <div class="admin-sidebar__brand">
            <img class="admin-sidebar__logo" src="${getAssetPath("logo-transparent.png")}" alt="SmartDuck logo" />
            <div>
              <h1 class="admin-sidebar__title">SmartDuck</h1>
              <p class="admin-sidebar__copy">IoT Egg Incubation System</p>
            </div>
          </div>
        </div>

        <nav class="admin-sidebar__nav" aria-label="Admin navigation">
          ${getSidebarMenuItems(role)
            .map((item) => renderSidebarMenuRow(item, "admin-nav-button", role))
            .join("")}
        </nav>

        <div class="admin-sidebar__spacer"></div>
      </div>
    `;
  }

  app.sidebarContent.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      markNavigationIntent(button);
      closeSidebar();
      void navigateToPage(button.dataset.page || getDefaultPageId(), role);
    });
  });

  app.sidebarContent.querySelectorAll("[data-settings-toggle]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleSettingsFlyout(button);
    });
  });
}

// Callers pass the result of a querySelector, which is null when the container
// belongs to another role's page -- the admin dashboard has no
// .dashboard-quick-grid. A default parameter only fills in for undefined, so
// null used to throw here and abort the caller mid-render.
function hydrateIcons(root = document) {
  if (!root) return;
  root.querySelectorAll("[data-icon]").forEach((element) => {
    const name = element.dataset.icon || "";
    const extraClass = element.dataset.iconClass || "";
    // Re-parsing the same SVG throws away a live subtree and makes the browser
    // build, lay out and paint an identical one. The polls on the monitoring and
    // dashboard screens re-hydrate the same icons every tick, so this ran
    // constantly for no visible change. Remember what each element was given and
    // only rewrite it when the icon actually differs -- the markup produced is
    // exactly the same, so nothing about the rendered page changes.
    // Trust the cache only while the glyph is actually still there. An element
    // whose contents were cleared elsewhere must be drawn again, or a stale
    // signature would leave a blank square on screen forever.
    const signature = `${name}|${extraClass}`;
    if (element.dataset.iconRendered === signature && element.firstElementChild) return;
    element.innerHTML = renderIcon(name, extraClass);
    element.dataset.iconRendered = signature;
  });
}

function setDashboardStatus(id, isOn) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = isOn ? "ON" : "OFF";
  node.classList.toggle("is-on", isOn);
  node.classList.toggle("is-off", !isOn);
}

function findChartEntry(chartKey, chartId) {
  return chartRegistry[chartKey]?.find((entry) => entry.id === chartId) || null;
}

function formatWholeNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US");
}

function formatPercentValue(value, total) {
  if (!total) return "0%";
  return `${((Number(value) || 0) / total * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

function getDashboardEggProjection(value = "18") {
  return dashboardEggStatusProjections[String(value)] || dashboardEggStatusProjections["18"];
}

function updateDashboardEggStatusProjection(value = "18", { rerender = false } = {}) {
  const projection = getDashboardEggProjection(value);
  const activeBatch = getScheduleSnapshot();
  const totalEggs = getStoredUserBatches().reduce((sum, batch) => sum + Number(batch.eggCount || 0), 0) || Number(activeBatch.eggCount || 0);
  const data = [{ name: "Incubating", value: totalEggs, color: "#7c3aed" }];
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const chartEntry = findChartEntry("userDashboard", "chart-dashboard-egg-distribution");

  if (chartEntry) {
    chartEntry.config.data = data;
    chartEntry.config.centerLabel = ["Total", formatWholeNumber(total), "Eggs"];
    chartEntry.config.height = 252;
  }

  data.forEach((item) => {
    const node = document.querySelector(`[data-dashboard-egg-status="${item.name}"]`);
    if (!node) return;
    node.textContent = `${formatWholeNumber(item.value)} (${formatPercentValue(item.value, total)})`;
  });

  const totalNode = document.querySelector("[data-dashboard-egg-total]");
  if (totalNode) totalNode.textContent = `${formatWholeNumber(total)} (100%)`;

  const note = document.getElementById("dashboard-harvest-note");
  if (note) {
    const harvestDate = activeBatch.hatchDateLabel && activeBatch.hatchDateLabel !== "--" ? activeBatch.hatchDateLabel : projection.harvestDate;
    note.textContent = total > 0
      ? `All eggs are currently incubating. Please wait for candling schedule on Day 7 and Day 14. Harvest on ${harvestDate}.`
      : "No eggs are currently assigned to an active batch.";
  }

  if (rerender) renderChartById("chart-dashboard-egg-distribution");
}

function bindDashboardEggStatusProjection() {
  const select = document.getElementById("dashboard-harvest-select");
  if (!select) return;

  updateDashboardEggStatusProjection(select.value || "18", { rerender: true });
  if (select.dataset.dashboardHarvestBound === "true") return;

  select.dataset.dashboardHarvestBound = "true";
  select.addEventListener("change", () => {
    updateDashboardEggStatusProjection(select.value || "18", { rerender: true });
  });
}

function renderUserDashboardQuickViews(historyData = null) {
  const activeBatches = getScheduleActiveBatches();
  const batchList = document.getElementById("dashboard-active-batches-list");
  if (batchList) {
    batchList.innerHTML = activeBatches.length ? activeBatches.map((batch) => {
      const snapshot = getScheduleSnapshot(batch);
      return `<article class="dashboard-quick-item"><span class="dashboard-quick-item__icon">${renderIcon("package-open")}</span><div><strong>${escapeHtml(batch.id)}</strong><small>Day ${snapshot.currentDay} · ${formatWholeNumber(batch.eggCount)} eggs</small></div></article>`;
    }).join("") : '<p class="table-empty">No active batches.</p>';
  }

  const nextEvent = getUncompletedScheduleMilestones(activeBatches)
    .filter((milestone) => [7, 14, 18].includes(milestone.day))
    .sort((a, b) => a.dateValue.localeCompare(b.dateValue) || a.day - b.day)[0];
  const eventNode = document.getElementById("dashboard-next-event");
  if (eventNode) {
    const label = nextEvent?.day === 7 ? "1st Candling" : nextEvent?.day === 14 ? "2nd Candling" : "Final Harvest";
    eventNode.innerHTML = nextEvent
      ? `<article class="dashboard-quick-item dashboard-quick-item--event"><span class="dashboard-quick-item__icon">${renderIcon("calendar")}</span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(nextEvent.batchId)} · ${escapeHtml(formatBatchDate(nextEvent.dateValue))} · ${escapeHtml(describeScheduleDateDistance(nextEvent.dateValue))}</small></div></article>`
      : '<p class="table-empty">No upcoming schedule.</p>';
  }

  const historyNode = document.getElementById("dashboard-latest-history");
  if (historyNode && historyData) {
    const records = mergeCompletedBatchHistory(
      mergeNotificationHistory(normalizeAccounts(historyData.activity).map(normalizeHistoryActivityRecord), normalizeAccounts(historyData.notifications)),
      normalizeAccounts(historyData.batches),
    );
    const latest = records[0];
    if (latest) {
      const presentation = getHistoryActivityPresentation(latest);
      historyNode.innerHTML = `<article class="dashboard-quick-item"><span class="dashboard-quick-item__icon">${renderIcon(presentation.icon)}</span><div><strong>${escapeHtml(presentation.title)}</strong><small>${escapeHtml(presentation.description)} · ${escapeHtml(formatNotificationTime(latest.createdAt))}</small></div></article>`;
    } else {
      historyNode.innerHTML = '<p class="table-empty">No history recorded yet.</p>';
    }
  }
  hydrateIcons(document.querySelector(".dashboard-quick-grid"));
}

function setUserDashboardMetricValue(id, value, compactValue = value) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = String(value ?? "--");
  node.dataset.mobileValue = String(compactValue ?? value ?? "--");
  node.title = String(value ?? "--");
}

function getCompactDashboardBatchId(value) {
  const label = String(value || "").trim();
  if (!label || /^no active batch$/i.test(label)) return "None";
  return label.replace(/^batch[-_\s]*/i, "") || label;
}

async function hydrateDashboardOverview() {
  if (state.currentPage !== "dashboard") return;

  try {
    await Promise.all([
      loadUserBatchesFromBackend(),
      loadSharedSensorReadings(),
      refreshComponentDeviceStatuses(false),
    ]);
  } catch {
    // Keep the current caches if the shared backend is temporarily unavailable.
  }

  const userName = getAuthenticatedUser();
  const userRole = getRoleLabel();
  const firstName = userName.split(" ").filter(Boolean)[0] || userName;
  const currentHour = new Date().getHours();
  const greeting = currentHour < 12 ? "Good morning" : currentHour < 18 ? "Good afternoon" : "Good evening";
  const latestReading = getLiveSensorReading();
  const activeBatch = getScheduleSnapshot();
  // "Current Load" is what is in the incubator right now, so only in-progress
  // batches count. Summing every stored batch left a completed one reporting
  // "34 Eggs / In Incubation" right beside the "No active batch" card.
  const totalBatchEggs = getScheduleActiveBatches().reduce((sum, batch) => sum + Number(batch.eggCount || 0), 0);

  const totalEggCount = formatWholeNumber(totalBatchEggs || activeBatch.eggCount);
  const textMap = [
    ["dashboard-user-name", userName],
    ["dashboard-user-role", userRole],
    ["dashboard-greeting-label", `${greeting}, ${firstName}!`],
  ];

  textMap.forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  });

  setUserDashboardMetricValue(
    "dashboard-metric-temp",
    latestReading ? `${latestReading.temp.toFixed(1)} \u00B0C` : "--",
    latestReading ? `${latestReading.temp.toFixed(1)}\u00B0` : "--",
  );
  setUserDashboardMetricValue(
    "dashboard-metric-humidity",
    latestReading ? `${latestReading.humidity.toFixed(1)} %` : "--",
    latestReading ? `${latestReading.humidity.toFixed(1)}%` : "--",
  );
  setUserDashboardMetricValue(
    "dashboard-metric-day",
    `Day ${activeBatch.currentDay} of ${activeBatch.targetDays}`,
    `${activeBatch.currentDay}/${activeBatch.targetDays}`,
  );
  setUserDashboardMetricValue("dashboard-metric-eggs", `${totalEggCount} Eggs`, totalEggCount);
  setUserDashboardMetricValue(
    "dashboard-metric-batch",
    activeBatch.id,
    getCompactDashboardBatchId(activeBatch.id),
  );

  const eggsStatus = document.getElementById("dashboard-metric-eggs")?.closest(".dashboard-metric-card")?.querySelector(".dashboard-metric-card__status");
  // With no in-progress batch the placeholder status read "Upcoming", which
  // implies something is scheduled. Say what is actually true.
  if (eggsStatus) eggsStatus.textContent = totalBatchEggs > 0 ? "In Incubation" : "No active batch";

  setDashboardStatus("dashboard-status-turner", state.trayControls.eggRoller);
  bindDashboardEggStatusProjection();
  renderUserDashboardQuickViews();
  try {
    const historyData = await loadUnifiedHistoryData({ forceRefresh: true });
    renderUserDashboardQuickViews(historyData);
  } catch {
    const cached = readUnifiedHistoryCache();
    if (cached?.data) renderUserDashboardQuickViews(cached.data);
  }
}

function hydrateAdminDashboardOverview() {
  if (getAuthenticatedRole() !== "admin") return;

  const userName = getAuthenticatedUser();
  const userRole = getRoleLabel();
  const userInitials = initials(userName);
  const firstName = userName.split(" ").filter(Boolean)[0] || "Admin";
  const textMap = [
    ["admin-shell-user-name", userName],
    ["admin-shell-user-role", userRole],
    ["admin-shell-user-avatar", userInitials],
  ];

  textMap.forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  });

  if (state.currentPage === "dashboard") {
    const greetingNode = document.getElementById("admin-dashboard-greeting");
    if (greetingNode) greetingNode.textContent = `Welcome back, ${firstName}!`;
  }
}

function isAdminMonitoringPage() {
  return state.currentPage === "monitoring" && document.body.classList.contains("admin-monitoring-page");
}

function setTextContentById(id, value) {
  const node = document.getElementById(id);
  if (!node) return;
  // Assigning textContent replaces the text node even when the string is
  // identical, which dirties the element for layout and paint. The live screens
  // rewrite these stat chips on every poll and most ticks carry the same value,
  // so compare first. Callers pass numbers as well as strings, and textContent
  // always reads back a string, so compare the string form. The text that ends
  // up on screen is unchanged either way.
  const next = value === null || value === undefined ? "" : String(value);
  if (node.textContent !== next) node.textContent = next;
}

function isActiveIncubationBatch(batch) {
  return normalizeBatchStatus(batch?.status || "in-progress") === "in-progress"
    && Number(batch?.eggCount || 0) > 0;
}

function getActiveIncubatorEggCount() {
  return getStoredUserBatches()
    .filter(isActiveIncubationBatch)
    .reduce((sum, batch) => sum + Math.max(0, Number(batch.eggCount || 0)), 0);
}

function getAvailableIncubatorCapacity() {
  return Math.max(0, INCUBATOR_EGG_CAPACITY - getActiveIncubatorEggCount());
}

function getMonitoringBatchRecords() {
  const records = getStoredUserBatches()
    .filter(isActiveIncubationBatch)
    .sort((a, b) => {
      const startCompare = String(a.startDate || "").localeCompare(String(b.startDate || ""));
      if (startCompare !== 0) return startCompare;
      return getBatchRecordTime(a.createdAt) - getBatchRecordTime(b.createdAt);
    })
    .map((batch) => {
      const statusMeta = getBatchStatusMeta(batch.status);
      const isPenoy = batch.isPenoyBatch || /penoy/i.test(`${batch.eggType} ${batch.notes}`);
      const isReplacement = !isPenoy && (batch.parentBatchId || /replacement|after candling|panibago/i.test(`${batch.eggType} ${batch.notes}`));
      return {
        id: batch.id,
        label: batch.id,
        color: isPenoy ? "orange" : getSafeBatchColor(batch.farmerColor),
        count: Number(batch.eggCount || 0),
        status: isPenoy ? "Penoy" : isReplacement ? "Replacement" : statusMeta.label,
        note: batch.parentBatchId
          ? `From ${batch.parentBatchId}`
          : batch.notes || (isReplacement ? "Replacement eggs after candling" : "Active incubation batch"),
        isPenoy,
        isReplacement,
      };
    });

  return records;
}

function getMonitoringSelectedBatchRecords(records) {
  if (!records.length) return [];
  const selectedId = records.some((record) => record.id === state.monitoringBatchId) ? state.monitoringBatchId : "__all";
  state.monitoringBatchId = selectedId;
  return selectedId === "__all" ? records : records.filter((record) => record.id === selectedId);
}

function syncMonitoringBatchSelector(records) {
  const header = app.pageRoot?.querySelector(".monitoring-batch-card__header");
  if (!header) return;

  let control = header.querySelector("[data-monitoring-batch-control]");
  if (!control) {
    control = document.createElement("label");
    control.className = "monitoring-batch-select";
    control.dataset.monitoringBatchControl = "true";
    control.innerHTML = `
      <span>Batch</span>
      <select data-monitoring-batch-select aria-label="Select batch for visual eggs"></select>
    `;
    const button = header.querySelector(".monitoring-batch-button");
    if (button) {
      let actions = header.querySelector(".monitoring-batch-actions");
      if (!actions) {
        actions = document.createElement("div");
        actions.className = "monitoring-batch-actions";
        button.replaceWith(actions);
        actions.appendChild(button);
      }
      actions.prepend(control);
    } else {
      header.appendChild(control);
    }
  }

  const select = control.querySelector("[data-monitoring-batch-select]");
  if (!select) return;

  const selectedId = records.some((record) => record.id === state.monitoringBatchId) ? state.monitoringBatchId : "__all";
  const options = [
    { id: "__all", label: `All active batches (${records.reduce((sum, record) => sum + record.count, 0)} eggs)` },
    ...records.map((record) => ({ id: record.id, label: `${record.label} (${record.count} eggs)` })),
  ];
  select.innerHTML = options.map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`).join("");
  select.value = selectedId;
  state.monitoringBatchId = selectedId;

  if (select.dataset.monitoringBatchSelectBound === "true") return;
  select.dataset.monitoringBatchSelectBound = "true";
  select.addEventListener("change", () => {
    state.monitoringBatchId = select.value || "__all";
    renderMonitoringBatchOverview();
  });
}

function renderMonitoringBatchOverview() {
  if (state.currentPage !== "batch" || !document.body.classList.contains("user-batch-page")) return;
  const records = getMonitoringBatchRecords();
  const selectedRecords = getMonitoringSelectedBatchRecords(records);
  const totalEggs = records.reduce((sum, record) => sum + record.count, 0);
  const selectedEggs = selectedRecords.reduce((sum, record) => sum + record.count, 0);
  const availableSlots = Math.max(0, INCUBATOR_EGG_CAPACITY - totalEggs);
  const overflowEggs = Math.max(0, totalEggs - INCUBATOR_EGG_CAPACITY);
  const tray = app.pageRoot?.querySelector("[data-monitoring-egg-tray]");
  const legend = app.pageRoot?.querySelector("[data-monitoring-batch-legend]");
  syncMonitoringBatchSelector(records);

  const totalNode = app.pageRoot?.querySelector("[data-monitoring-total-eggs]");
  if (totalNode) {
    const focusCopy = state.monitoringBatchId === "__all" ? "" : `Selected: ${selectedEggs} eggs · `;
    totalNode.textContent = overflowEggs > 0
      ? `${focusCopy}${totalEggs} eggs recorded · ${overflowEggs} over the ${INCUBATOR_EGG_CAPACITY}-slot limit`
      : `${focusCopy}${totalEggs} / ${INCUBATOR_EGG_CAPACITY} occupied · ${availableSlots} available`;
    totalNode.classList.toggle("is-over-capacity", overflowEggs > 0);
  }

  if (tray) {
    const occupiedSlots = records
      .flatMap((record) => Array.from({ length: record.count }, (_, index) => ({ ...record, index })))
      .slice(0, INCUBATOR_EGG_CAPACITY);
    const slots = Array.from({ length: INCUBATOR_EGG_CAPACITY }, (_, index) => occupiedSlots[index] || null);
    tray.classList.toggle("is-over-capacity", overflowEggs > 0);
    tray.setAttribute(
      "aria-label",
      overflowEggs > 0
        ? `${totalEggs} active eggs recorded. The incubator has ${INCUBATOR_EGG_CAPACITY} slots and is over capacity by ${overflowEggs}.`
        : `${totalEggs} of ${INCUBATOR_EGG_CAPACITY} incubator slots occupied; ${availableSlots} available.`,
    );
    tray.innerHTML = slots.map((egg, index) => {
      if (!egg) {
        return `
          <span
            class="monitoring-egg monitoring-egg--empty"
            title="Slot ${index + 1} - Available"
            aria-label="Slot ${index + 1}, available"
          ></span>
        `;
      }
      const isDimmed = state.monitoringBatchId !== "__all" && egg.id !== state.monitoringBatchId;
      return `
        <span
          class="monitoring-egg monitoring-egg--batch-${escapeHtml(egg.color)}${isDimmed ? " is-dimmed" : ""}"
          title="Slot ${index + 1} - Egg ${egg.index + 1} - ${escapeHtml(egg.label)} (${escapeHtml(egg.status)})"
          aria-label="Slot ${index + 1}, ${escapeHtml(egg.label)}, ${escapeHtml(egg.status)}${isDimmed ? ", not selected" : ""}"
        ></span>
      `;
    }).join("");
  }

  if (legend) {
    const batchItems = records.map((record) => {
      const percent = Math.round((record.count / INCUBATOR_EGG_CAPACITY) * 100);
      const isDimmed = state.monitoringBatchId !== "__all" && record.id !== state.monitoringBatchId;
      return `
        <div class="monitoring-batch-legend__item${isDimmed ? " is-dimmed" : ""}">
          <span class="monitoring-batch-legend__dot monitoring-batch-legend__dot--batch-${escapeHtml(record.color)}"></span>
          <span>${escapeHtml(record.label)} (${escapeHtml(record.status)}) - ${formatWholeNumber(record.count)} eggs</span>
          <small>${percent}% of incubator capacity${record.note ? ` - ${escapeHtml(record.note)}` : ""}</small>
        </div>
      `;
    }).join("");
    const capacityItem = overflowEggs > 0
      ? `
        <div class="monitoring-batch-legend__item is-over-capacity">
          <span class="monitoring-batch-legend__dot monitoring-batch-legend__dot--warning"></span>
          <span>Capacity exceeded by ${formatWholeNumber(overflowEggs)} eggs</span>
          <small>Remove eggs before creating another batch.</small>
        </div>
      `
      : `
        <div class="monitoring-batch-legend__item is-available">
          <span class="monitoring-batch-legend__dot monitoring-batch-legend__dot--empty"></span>
          <span>Available capacity - ${formatWholeNumber(availableSlots)} slots</span>
          <small>${totalEggs} of ${INCUBATOR_EGG_CAPACITY} slots are occupied.</small>
        </div>
      `;
    legend.innerHTML = `${batchItems}${capacityItem}`;
  }
}

function renderDashboardEggOverview() {
  if (state.currentPage !== "dashboard") return;
  const batches = getStoredUserBatches().filter((batch) => Number(batch.eggCount) > 0);
  const totalEggs = batches.reduce((sum, batch) => sum + Number(batch.eggCount || 0), 0);
  const tray = app.pageRoot?.querySelector("[data-dashboard-egg-tray]");
  const legend = app.pageRoot?.querySelector("[data-dashboard-batch-legend]");
  const totalNode = app.pageRoot?.querySelector("[data-dashboard-total-eggs]");

  if (totalNode) totalNode.textContent = `Total Eggs: ${formatWholeNumber(totalEggs)}`;

  if (tray) {
    tray.innerHTML = batches
      .flatMap((batch) => Array.from({ length: Number(batch.eggCount || 0) }, () => batch))
      .map((batch, index) => {
        const color = getSafeBatchColor(batch.farmerColor);
        return `
          <span
            class="monitoring-egg monitoring-egg--batch-${escapeHtml(color)}"
            title="Egg ${index + 1} - ${escapeHtml(batch.id)}"
            aria-label="Egg ${index + 1}, ${escapeHtml(batch.id)}"
          ></span>
        `;
      })
      .join("");
  }

  if (legend) {
    legend.innerHTML = batches.length
      ? batches.map((batch) => {
          const count = Number(batch.eggCount || 0);
          const percent = totalEggs > 0 ? Math.round((count / totalEggs) * 100) : 0;
          const color = getSafeBatchColor(batch.farmerColor);
          return `
            <div class="monitoring-batch-legend__item">
              <span class="monitoring-batch-legend__dot monitoring-batch-legend__dot--batch-${escapeHtml(color)}"></span>
              <span>${escapeHtml(batch.id)} - ${formatWholeNumber(count)} eggs</span>
              <small>${percent}% of current tray</small>
            </div>
          `;
        }).join("")
      : `<div class="monitoring-batch-legend__item is-standby"><span>No batch eggs recorded yet.</span></div>`;
  }
}

function getMonitoringStatus(value, min, max) {
  return value >= min && value <= max ? "Normal" : "Check";
}

function getSensorChartReadings(chartId) {
  const entry = getChartEntryById(chartId);
  if (!entry || entry.config.rangeKind !== "sensor-hours") return temperatureData;
  return getChartRenderConfig(entry).data;
}

// Average/min/max for the range a sensor chart is showing. An hour range
// comes from the backend summary of every stored reading in that window: the
// chart itself only receives recent raw points plus bucket means of older
// history, and averaging those equally let the last few minutes outweigh the
// rest of the window. Realtime shows raw readings only, so the chart points
// are the exact samples and are summarised directly.
function getSensorRangeStats(chartId, metric) {
  const key = metric === "temperature" ? "temp" : "humidity";
  const selectedRange = String(state.chartRanges[chartId] ?? "");
  const isRealtime = selectedRange === "realtime" || selectedRange === "current";
  const entry = getChartEntryById(chartId);
  if (entry?.config.rangeKind === "sensor-hours" && !isRealtime) {
    const hours = Math.max(1, Math.min(168, Number(selectedRange) || 24));
    const summary = state.sensorReadingSummaries?.[String(hours)]?.[metric];
    const average = Number(summary?.average);
    const min = Number(summary?.min);
    const max = Number(summary?.max);
    if (Number.isFinite(average) && Number.isFinite(min) && Number.isFinite(max)) {
      return { average, min, max };
    }
    // Right after a range change the wider window is still on its way. The
    // points on hand are thinned, and averaging them is the very mismatch this
    // replaces, so wait for the summary instead of showing a wrong number.
    return null;
  }
  const values = getSensorChartReadings(chartId)
    .map((entry) => entry[key])
    .filter(Number.isFinite);
  if (!values.length) return null;
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

// One decimal, rounded once from the exact value. Summing 0.1-step readings
// leaves binary noise (37.25 arrives as 37.2499999), which toFixed alone would
// round down; trimming to six places first removes the noise, not real data.
function formatSensorStat(value) {
  return Number(value.toFixed(6)).toFixed(1);
}

// Per-component icon tint, keyed by the same component key the control modal
// uses so both surfaces stay visually consistent.
const COMPONENT_STATUS_ICON_CLASSES = {
  dht: "dht",
  actuator: "actuator",
  eggRolling: "rolling",
  fan: "fan",
  heaterLight: "heater",
  candlingLight: "light",
};

// The mode the operator selected is the contract the firmware follows, so the
// list reports that (OFF/ON/AUTO) rather than the momentary relay output: an
// AUTO fan that is resting between cycles is still in AUTO, and showing "OFF"
// there would misreport the configured behaviour. An unreachable board reports
// no mode at all.
function getComponentStatusRowState(key) {
  if (state.deviceOnline === false) return { label: "Offline", stateClass: "is-offline" };
  const device = componentDeviceStatuses[key];
  if (!device || !device.status || device.status === "unknown") {
    return { label: "--", stateClass: "is-offline" };
  }
  const mode = String(device.appliedMode || getComponentModes()[key] || "").toLowerCase();
  if (mode === "auto") return { label: "AUTO", stateClass: "is-auto" };
  if (mode === "on") return { label: "ON", stateClass: "is-on" };
  if (mode === "off") return { label: "OFF", stateClass: "is-off" };
  return { label: "--", stateClass: "is-offline" };
}

// Both roles render the same card; the user page and the admin page each carry
// one [data-component-status-list] container.
function renderComponentStatusList() {
  const list = app.pageRoot?.querySelector("[data-component-status-list]");
  if (!list) return;

  const buildMarkup = () => COMPONENT_CONTROL_DEFS.map(({ key, label, icon }) => {
    const { label: stateLabel, stateClass } = getComponentStatusRowState(key);
    const iconClass = COMPONENT_STATUS_ICON_CLASSES[key] || "actuator";
    return `
      <div class="monitoring-list__item" data-component-key="${escapeHtml(key)}">
        <div class="monitoring-list__label">
          <span class="monitoring-component-icon monitoring-component-icon--${iconClass}" data-icon="${icon}"></span>
          <span>${escapeHtml(label)}</span>
        </div>
        <strong class="monitoring-list__state ${stateClass}">${escapeHtml(stateLabel)}</strong>
      </div>
    `;
  }).join("");

  // This runs on every status poll. Rewriting innerHTML threw away every row and
  // its icon and rebuilt them from scratch twice a second, which is parse,
  // layout and paint for rows whose text usually had not moved. Build the rows
  // once, then update only the state text and its class in place; the markup and
  // classes produced are identical, so the page looks exactly the same.
  const rows = [...list.querySelectorAll(".monitoring-list__item")];
  // Reuse only when the rows already on screen are exactly the ones we render,
  // in the same order. Anything else (a first paint, a page swap, a changed
  // component set) falls back to building the markup, so the two paths can never
  // disagree about what is shown.
  const matches = rows.length === COMPONENT_CONTROL_DEFS.length
    && COMPONENT_CONTROL_DEFS.every(({ key }, index) => rows[index]?.dataset.componentKey === key);
  if (!matches) {
    list.innerHTML = buildMarkup();
    hydrateIcons(list);
    return;
  }

  COMPONENT_CONTROL_DEFS.forEach(({ key }, index) => {
    const row = rows[index];
    const stateNode = row?.querySelector(".monitoring-list__state");
    if (!stateNode) return;
    const { label: stateLabel, stateClass } = getComponentStatusRowState(key);
    if (stateNode.textContent !== stateLabel) stateNode.textContent = stateLabel;
    const nextClass = `monitoring-list__state ${stateClass}`.trim();
    if (stateNode.className !== nextClass) stateNode.className = nextClass;
  });

  // Reusing the rows means nothing repaints their icons, so an icon left empty
  // for any reason would stay empty. Re-hydrate only the ones actually missing
  // their glyph: hydrateIcons skips anything already drawn, so this costs
  // nothing on a healthy list and cannot leave a blank square on screen.
  const emptyIcons = rows.filter((row) => {
    const icon = row.querySelector(".monitoring-component-icon");
    return icon && !icon.querySelector("svg");
  });
  emptyIcons.forEach((row) => hydrateIcons(row));
}

async function loadComponentStatusList() {
  if (state.currentPage !== "monitoring") return [];
  // The shared poller already fetches this endpoint conditionally, applies the
  // device-presence payload and normalises appliedMode the way the control
  // modal expects, and it dedupes concurrent callers. Fetching here as well
  // would double every poll for the same bytes.
  await refreshComponentDeviceStatuses(false);
  renderComponentStatusList();
  return Object.keys(componentDeviceStatuses);
}

// The value beside each monitoring graph is the sensor's current reading, the
// same one the temperature/humidity cards show and the graph's last point
// draws. An average over the graph window always trailed the live value, which
// read as the number lagging the sensor, so both roles show the reading itself.
// The element ids keep their old "average" names so nothing else has to move.
function getCurrentSensorDisplayReading() {
  return getLiveSensorReading() || temperatureData[temperatureData.length - 1] || null;
}

function updateMonitoringAverageLabels() {
  const reading = getCurrentSensorDisplayReading();
  setTextContentById("monitoring-average-temp", reading ? `Average: ${reading.temp.toFixed(1)} °C` : "Average: --");
  setTextContentById("monitoring-average-humidity", reading ? `Average: ${reading.humidity.toFixed(1)} %` : "Average: --");
}

function updateAdminMonitoringLiveStats({ rerenderCharts = false } = {}) {
  if (!isAdminMonitoringPage()) return;

  const reading = getCurrentSensorDisplayReading();
  setTextContentById("admin-monitoring-temp-average", reading ? `${reading.temp.toFixed(1)} °C` : "--");
  setTextContentById("admin-monitoring-humidity-average", reading ? `${reading.humidity.toFixed(1)} %` : "--");

  const temperatureStats = getSensorRangeStats("chart-monitoring-temperature", "temperature");
  const humidityStats = getSensorRangeStats("chart-monitoring-humidity", "humidity");
  if (temperatureStats) {
    setTextContentById("admin-monitoring-temp-min", `${formatSensorStat(temperatureStats.min)} °C`);
    setTextContentById("admin-monitoring-temp-max", `${formatSensorStat(temperatureStats.max)} °C`);
  } else {
    ["admin-monitoring-temp-min", "admin-monitoring-temp-max"].forEach((id) => setTextContentById(id, "--"));
  }
  if (humidityStats) {
    setTextContentById("admin-monitoring-humidity-min", `${formatSensorStat(humidityStats.min)} %`);
    setTextContentById("admin-monitoring-humidity-max", `${formatSensorStat(humidityStats.max)} %`);
  } else {
    ["admin-monitoring-humidity-min", "admin-monitoring-humidity-max"].forEach((id) => setTextContentById(id, "--"));
  }

  if (rerenderCharts) {
    renderChartById("chart-monitoring-temperature");
    renderChartById("chart-monitoring-humidity");
  }
}

function syncAdminMonitoringLiveUpdates() {
  if (state.currentPage !== "monitoring") {
    if (state.adminMonitoringLiveTimer) {
      clearInterval(state.adminMonitoringLiveTimer);
      state.adminMonitoringLiveTimer = null;
    }
    return;
  }

  // The live status poll re-renders the component card on this page, so a
  // second timer for the same endpoint would only add invocations.
}

function isSensorReadingPage() {
  return ["dashboard", "monitoring", "batch", "history"].includes(state.currentPage);
}

function getSensorReadingUpdateLabel(reading) {
  const date = new Date(reading?.recordedAt || "");
  if (Number.isNaN(date.getTime())) return "Waiting for a sensor timestamp";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function updateSensorReadingPage({ rerenderCharts = false } = {}) {
  const latestReading = getLiveSensorReading();
  const lastStoredReading = temperatureData[temperatureData.length - 1] || null;
  const displayReading = latestReading || lastStoredReading;

  setTextContentById("dashboard-metric-temp", displayReading ? `${displayReading.temp.toFixed(1)} \u00B0C` : "--");
  setTextContentById("dashboard-metric-humidity", displayReading ? `${displayReading.humidity.toFixed(1)} %` : "--");
  setTextContentById("monitoring-metric-temp", displayReading ? `${displayReading.temp.toFixed(1)} \u00B0C` : "--");
  setTextContentById("monitoring-metric-humidity", displayReading ? `${displayReading.humidity.toFixed(1)} %` : "--");
  updateMonitoringAverageLabels();
  // A stale value must never read as a live one. When the ESP32 stops
  // reporting, the last real measurement stays on the card but the label
  // carries the time it was taken, so a frozen number is legible as frozen.
  const dashboardSensorStatus = latestReading
    ? "Live sensor data"
    : (lastStoredReading
      ? `Last known · ${getSensorReadingUpdateLabel(lastStoredReading)}`
      : "Waiting for sensor data");
  ["dashboard-metric-temp", "dashboard-metric-humidity"].forEach((id) => {
    const status = document.getElementById(id)?.closest(".dashboard-metric-card")?.querySelector(".dashboard-metric-card__status");
    if (status) status.textContent = dashboardSensorStatus;
  });
  // The admin dashboard shows the same two readings beside its batch tiles.
  setTextContentById("admin-dashboard-temperature", displayReading ? `${displayReading.temp.toFixed(1)} \u00B0C` : "--");
  setTextContentById("admin-dashboard-humidity", displayReading ? `${displayReading.humidity.toFixed(1)} %` : "--");
  setTextContentById("admin-dashboard-temperature-note", dashboardSensorStatus);
  setTextContentById("admin-dashboard-humidity-note", dashboardSensorStatus);
  setTextContentById(
    "monitoring-last-updated",
    latestReading
      ? getSensorReadingUpdateLabel(latestReading)
      : (lastStoredReading ? `Realtime unavailable · Last stored ${getSensorReadingUpdateLabel(lastStoredReading)}` : "Waiting for sensor data")
  );
  const unavailableLabel = state.deviceOnline === false ? "Offline" : "No live data";
  const temperatureStatus = latestReading ? getMonitoringStatus(latestReading.temp, 37.3, 37.7) : unavailableLabel;
  // Matches the backend's alert band exactly: 50 and 70 read Normal, and only
  // a reading outside them reads Check, so the tile never disagrees with the
  // alert the server raised for the same sample.
  const humidityStatus = latestReading ? getMonitoringStatus(latestReading.humidity, 50, 70) : unavailableLabel;
  for (const id of ["monitoring-temperature-status", "admin-monitoring-temp-status"]) setTextContentById(id, temperatureStatus);
  for (const id of ["monitoring-humidity-status", "admin-monitoring-humidity-status"]) setTextContentById(id, humidityStatus);
  updateAdminMonitoringLiveStats({ rerenderCharts });
  // The components card reports mode and reachability, both of which change
  // with the same payload that carries these readings.
  if (state.currentPage === "monitoring") renderComponentStatusList();

  if (!rerenderCharts) return;
  if (state.currentPage === "dashboard") {
    renderChartById("chart-dashboard-temperature");
    renderChartById("chart-dashboard-humidity");
    renderChartById("chart-admin-dashboard-temperature");
    renderChartById("chart-admin-dashboard-humidity");
  }
  if (state.currentPage === "monitoring") {
    renderChartById("chart-monitoring-temperature");
    renderChartById("chart-monitoring-humidity");
  }
  if (state.currentPage === "batch") {
    renderChartById("chart-batch-temperature");
    renderChartById("chart-batch-humidity");
  }
  if (state.currentPage === "history") {
    renderChartById("chart-history-temperature");
    renderChartById("chart-history-humidity");
  }
}

async function refreshSharedSensorReadings({ rerenderCharts = false } = {}) {
  // One refresh owns the changed flags; network stalls cannot pile up polls.
  if (state.sensorRefreshRequest) return state.sensorRefreshRequest;
  state.sensorReadingsFetchedAt = Date.now();
  // A sensor chart still showing the "no data" placeholder while readings exist
  // in memory has to be repainted no matter what the change flags say. The
  // flags describe whether the data moved, not whether the page managed to draw
  // it, and a below-the-fold chart takes its first paint before the first
  // payload arrives.
  const hasUnpaintedSensorChart = () => {
    if (!temperatureData.length) return false;
    const chartIds = {
      dashboard: [
        "chart-dashboard-temperature",
        "chart-dashboard-humidity",
        "chart-admin-dashboard-temperature",
        "chart-admin-dashboard-humidity",
      ],
      monitoring: ["chart-monitoring-temperature", "chart-monitoring-humidity"],
      batch: ["chart-batch-temperature", "chart-batch-humidity"],
      history: ["chart-history-temperature", "chart-history-humidity"],
    }[state.currentPage] || [];
    return chartIds.some((chartId) => {
      const element = document.getElementById(chartId);
      if (!element) return false;
      return element.dataset.chartRendered !== "true"
        || element.querySelector(".chart-empty-state") !== null;
    });
  };
  const renderReadings = () => {
    const live = Boolean(getLiveSensorReading());
    const freshnessChanged = state.sensorWasLive !== live;
    state.sensorWasLive = live;
    updateSensorReadingPage({
      rerenderCharts: rerenderCharts
        && (state.sensorReadingsChanged
          || state.devicePresenceChanged
          || freshnessChanged
          || hasUnpaintedSensorChart()),
    });
    state.sensorReadingsChanged = false;
    state.devicePresenceChanged = false;
  };
  state.sensorRefreshRequest = (async () => {
    try {
      await loadSharedSensorReadings();
    } catch {
      // Keep real last-known readings, but expire the live label/pulse.
    }
    renderReadings();
  })().finally(() => { state.sensorRefreshRequest = null; });
  // Health is independent, and only one status callback waits at a time.
  if (!state.sensorStatusRefreshRequest) {
    state.sensorStatusRefreshRequest = refreshComponentDeviceStatuses(false).then(() => {
      if (state.devicePresenceChanged) renderReadings();
    }).catch(() => {}).finally(() => { state.sensorStatusRefreshRequest = null; });
  }
  return state.sensorRefreshRequest;
}

function syncSharedSensorReadings() {
  if (!isSensorReadingPage()) {
    if (state.sensorReadingsTimer) {
      clearInterval(state.sensorReadingsTimer);
      state.sensorReadingsTimer = null;
    }
    return;
  }

  void refreshSharedSensorReadings({ rerenderCharts: true });
  if (state.sensorReadingsTimer) return;
  // Once the live poll sends its history marker, the marker triggers the
  // refetch as soon as an upload lands and this timer is only a backstop.
  // Unchanged data returns 304, and the refresh guard prevents overlapping
  // work when the connection takes longer than a poll.
  state.sensorReadingsTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (state.sensorHistoryAt !== undefined
      && Date.now() - (state.sensorReadingsFetchedAt || 0) < CHANGE_MARKER_FALLBACK_MS) return;
    void refreshSharedSensorReadings({ rerenderCharts: true });
  }, SENSOR_READINGS_POLL_INTERVAL_MS);
}

function hydrateMonitoringOverview() {
  if (state.currentPage !== "monitoring") return;

  const userName = getAuthenticatedUser();
  const userRole = getRoleLabel();
  const userInitials = initials(userName);
  const latestReading = getLiveSensorReading();
  const formattedUpdate = getSensorReadingUpdateLabel(latestReading);

  const textMap = [
    ["monitoring-user-name", userName],
    ["monitoring-user-role", userRole],
    ["monitoring-user-avatar", userInitials],
    ["monitoring-metric-temp", latestReading ? `${latestReading.temp.toFixed(1)} \u00B0C` : "--"],
    ["monitoring-metric-humidity", latestReading ? `${latestReading.humidity.toFixed(1)} %` : "--"],
    ["monitoring-last-updated", latestReading ? formattedUpdate : "Waiting for sensor data"],
  ];

  textMap.forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  });

  updateMonitoringAverageLabels();
  updateAdminMonitoringLiveStats();
  void loadComponentStatusList().catch(() => {});
  syncAdminMonitoringLiveUpdates();
}

async function hydrateBatchOverview() {
  if (state.currentPage !== "batch") return;

  const userName = getAuthenticatedUser();
  const userRole = getRoleLabel();
  const userInitials = initials(userName);
  const textMap = [
    ["batch-user-name", userName],
    ["batch-user-role", userRole],
    ["batch-user-avatar", userInitials],
  ];

  textMap.forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  });

  try {
    await loadUserBatchesFromBackend();
  } catch {
    // Keep the last local cache if the backend is temporarily unavailable.
  }
  renderStoredUserBatchRows();
  syncBatchMetricsFromRows();
  renderMonitoringBatchOverview();
  setupBatchFilters();
  bindBatchRowActions(app.pageRoot);
  updateUserBatchAnalytics();
}

const BATCH_FILTER_LABELS = {
  all: "All Batches",
  "in-progress": "In Progress",
  completed: "Completed",
  upcoming: "Upcoming",
};

const DEFAULT_ACTIVE_BATCH = {
  id: "No active batch",
  startDate: "",
  expectedHatchDate: "",
  eggCount: 0,
  status: "upcoming",
  currentDay: 0,
  targetDays: 0,
  createdAt: 0,
};
const INCUBATION_TARGET_DAYS = 18;
const SCHEDULE_MILESTONES = Object.freeze([
  { key: "start", day: 1, offset: 0, type: "start", title: "Start of Incubation", shortTitle: "Start" },
  { key: "candling-one", day: 7, offset: 6, type: "candling", title: "1st Candling / Penoy Harvest", shortTitle: "1st Candling" },
  { key: "candling-two", day: 14, offset: 13, type: "candling", title: "2nd Candling / Balut Check", shortTitle: "2nd Candling" },
  { key: "harvest", day: 18, offset: 17, type: "harvest", title: "Harvest Day", shortTitle: "Harvest" },
]);
const userBatchState = {
  cache: null,
  readyPromise: null,
  mutationCount: 0,
};

const ALERT_FILTER_LABELS = {
  all: "All",
  critical: "Critical",
  warning: "Warning",
  normal: "Normal",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};

function normalizeTableFilter(value, labels) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
  return Object.prototype.hasOwnProperty.call(labels, normalized) ? normalized : "all";
}

function normalizeBatchStatus(value) {
  return normalizeTableFilter(value, BATCH_FILTER_LABELS) === "all" ? "in-progress" : normalizeTableFilter(value, BATCH_FILTER_LABELS);
}

function getSafeBatchColor(color) {
  const normalized = String(color || "").trim().toLowerCase();
  return ["blue", "yellow", "orange", "red", "green", "purple"].includes(normalized) ? normalized : "blue";
}

function getBatchRecordTime(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function normalizeCompletedScheduleDays(value) {
  let candidates = value;
  if (typeof candidates === "string") {
    try {
      candidates = JSON.parse(candidates);
    } catch {
      candidates = candidates.split(",");
    }
  }
  if (candidates && !Array.isArray(candidates) && typeof candidates === "object") {
    candidates = Object.entries(candidates)
      .filter(([, completed]) => Boolean(completed))
      .map(([day]) => day);
  }
  if (!Array.isArray(candidates)) return [];
  return Array.from(new Set(
    candidates
      .map((day) => Number.parseInt(day, 10))
      .filter((day) => [1, 7, 14, 18].includes(day)),
  )).sort((a, b) => a - b);
}

function normalizeUserBatchRecord(batch) {
  const parsedEggCount = Number.parseInt(batch?.eggCount, 10);
  const parsedInitialEggCount = Number.parseInt(batch?.initialEggCount, 10);
  const normalized = {
    id: String(batch?.id || "").trim(),
    startDate: String(batch?.startDate || "").trim(),
    endDate: String(batch?.endDate || "").trim(),
    expectedHatchDate: String(batch?.expectedHatchDate || "").trim(),
    eggCount: parsedEggCount,
    initialEggCount: Number.isFinite(parsedInitialEggCount) ? parsedInitialEggCount : parsedEggCount,
    status: normalizeBatchStatus(batch?.status || "in-progress"),
    farmerColor: String(batch?.farmerColor || batch?.color || "blue").trim().toLowerCase(),
    eggType: String(batch?.eggType || "").trim(),
    isPenoyBatch: batch?.isPenoyBatch === true || String(batch?.isPenoyBatch || "").toLowerCase() === "true",
    parentBatchId: String(batch?.parentBatchId || "").trim(),
    notes: String(batch?.notes || batch?.note || "").trim(),
    automationEnabled: batch?.automationEnabled === true || String(batch?.automationEnabled || "").toLowerCase() === "true",
    completedScheduleDays: normalizeCompletedScheduleDays(batch?.completedScheduleDays),
    completedAt: String(batch?.completedAt || "").trim(),
    createdByUsername: String(batch?.createdByUsername || batch?.accountUsername || "").trim(),
    createdAt: batch?.createdAt || 0,
  };

  if (Number.isFinite(Number(batch?.currentDay))) normalized.currentDay = Number(batch.currentDay);
  if (Number.isFinite(Number(batch?.targetDays))) normalized.targetDays = Number(batch.targetDays);
  if (!Number.isFinite(normalized.eggCount) || normalized.eggCount < 0) normalized.eggCount = 0;
  if (!Number.isFinite(normalized.initialEggCount) || normalized.initialEggCount < normalized.eggCount) {
    normalized.initialEggCount = normalized.eggCount;
  }
  return normalized.id ? normalized : null;
}

function getScopedBatchStorageKey(baseKey) {
  const username = getAuthenticatedUsername().trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "anonymous";
  return `${baseKey}.${username}`;
}

function getStoredUserBatches() {
  if (Array.isArray(userBatchState.cache)) {
    return userBatchState.cache.map((batch) => ({ ...batch }));
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(getScopedBatchStorageKey(USER_BATCHES_KEY)) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeUserBatchRecord)
      .filter(Boolean)
      .sort((a, b) => getBatchRecordTime(b.createdAt) - getBatchRecordTime(a.createdAt));
  } catch {
    return [];
  }
}

function writeStoredUserBatches(batches) {
  const normalized = batches.map((batch) => ({ ...batch }));
  userBatchState.cache = normalized;
  localStorage.setItem(getScopedBatchStorageKey(USER_BATCHES_KEY), JSON.stringify(normalized));
}

async function loadUserBatchesFromBackend(forceRefresh = false) {
  if (!forceRefresh && Array.isArray(userBatchState.cache)) return getStoredUserBatches();
  if (!forceRefresh && userBatchState.readyPromise) return userBatchState.readyPromise;

  userBatchState.readyPromise = (async () => {
    const payload = await requestBackendJsonConditional(`${BATCHES_ENDPOINT}&username=${encodeURIComponent(getAuthenticatedUsername())}`);
    const batches = normalizeAccounts(payload.batches)
      .map(normalizeUserBatchRecord)
      .filter(Boolean)
      .sort((a, b) => getBatchRecordTime(b.createdAt) - getBatchRecordTime(a.createdAt));
    writeStoredUserBatches(batches);
    userBatchState.readyPromise = null;
    return getStoredUserBatches();
  })().catch((error) => {
    userBatchState.readyPromise = null;
    throw error;
  });
  return userBatchState.readyPromise;
}

async function loadAllBatchesFromBackend() {
  // Stable URL so the ETag can match; the helper revalidates on every call.
  const payload = await requestBackendJsonConditional(BATCHES_ENDPOINT);
  return normalizeAccounts(payload.batches)
    .map(normalizeUserBatchRecord)
    .filter(Boolean)
    .sort((a, b) => getBatchRecordTime(b.createdAt) - getBatchRecordTime(a.createdAt));
}

function getBatchSyncFingerprint(batches) {
  return JSON.stringify(normalizeAccounts(batches).map((batch) => [
    String(batch?.id || ""),
    String(batch?.updatedAt || batch?.createdAt || ""),
    String(batch?.status || ""),
    Number(batch?.eggCount || 0),
    String(batch?.startDate || ""),
  ]));
}

function publishBatchMutation(action, id) {
  try {
    localStorage.setItem(BATCH_SYNC_STORAGE_KEY, JSON.stringify({ action, id, at: Date.now() }));
  } catch {
    // The one-second backend poll remains the cross-tab fallback.
  }
}

function refreshUserBatchUiFromCache() {
  if (state.currentPage === "batch") {
    renderStoredUserBatchRows();
    refreshBatchPageAfterChange();
    setupBatchFilters();
    bindBatchRowActions(app.pageRoot);
    return;
  }
  if (state.currentPage === "dashboard") {
    const activeBatch = getScheduleSnapshot();
    // Same in-progress-only rule as hydrateDashboardOverview; this path repaints
    // the card after a live batch sync.
    const totalEggs = getScheduleActiveBatches().reduce((sum, batch) => sum + Number(batch.eggCount || 0), 0);
    const totalEggCount = formatWholeNumber(totalEggs || activeBatch.eggCount);
    setUserDashboardMetricValue(
      "dashboard-metric-day",
      `Day ${activeBatch.currentDay} of ${activeBatch.targetDays}`,
      `${activeBatch.currentDay}/${activeBatch.targetDays}`,
    );
    setUserDashboardMetricValue("dashboard-metric-eggs", `${totalEggCount} Eggs`, totalEggCount);
    setUserDashboardMetricValue(
      "dashboard-metric-batch",
      activeBatch.id,
      getCompactDashboardBatchId(activeBatch.id),
    );
    const eggsStatus = document.getElementById("dashboard-metric-eggs")?.closest(".dashboard-metric-card")?.querySelector(".dashboard-metric-card__status");
    if (eggsStatus) eggsStatus.textContent = totalEggs > 0 ? "In Incubation" : "No active batch";
    renderUserDashboardQuickViews(readUnifiedHistoryCache()?.data || null);
    const projectionSelect = document.getElementById("dashboard-harvest-select");
    updateDashboardEggStatusProjection(projectionSelect?.value || "18", { rerender: true });
    return;
  }
  if (state.currentPage === "candling") {
    void hydrateScheduleOverview();
    return;
  }
  if (state.currentPage === "history") {
    invalidateUnifiedHistoryCaches();
    void hydrateHistoryOverview();
  }
}

function renderAdminBatchState(batches) {
  state.liveBatches = normalizeAccounts(batches).map(normalizeUserBatchRecord).filter(Boolean);
  state.liveBatchesLoaded = true;
  batches = state.liveBatches;
  const completed = batches.filter((batch) => normalizeBatchStatus(batch.status) === "completed");
  const active = batches.filter((batch) => normalizeBatchStatus(batch.status) === "in-progress");
  // "Total Eggs" mirrors the user dashboard's "Current Load": only what sits in
  // the incubator right now. Summing every stored batch left a completed one
  // reporting 34 eggs beside the "0 Active Batches" tile.
  const totalEggs = active.reduce((sum, batch) => sum + Number(batch.eggCount || 0), 0);
  // The tile is badged "This Month" but counted every completed batch ever, so
  // the number never dropped when a month rolled over.
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const completedThisMonth = completed.filter((batch) => (
    getCompletedBatchEndDate(batch).slice(0, 7) === monthPrefix
  ));
  setTextContentById("admin-dashboard-completed-batches", String(completedThisMonth.length));
  setTextContentById("admin-dashboard-active-batches", String(active.length));
  setTextContentById("admin-dashboard-total-eggs", formatWholeNumber(totalEggs));
  renderAdminDashboardHistory(batches);
  batchProgressData.splice(0, batchProgressData.length, ...batches.map((batch) => ({
    batch: batch.id,
    day: Number(batch.currentDay || 0),
    target: Number(batch.targetDays || INCUBATION_TARGET_DAYS),
  })));
  renderChartById("chart-batch-progress");
}

async function syncLiveBatchUpdates() {
  if (state.batchSyncRequest || userBatchState.mutationCount > 0) return state.batchSyncRequest;
  state.batchSyncedAt = Date.now();
  state.batchSyncRequest = (async () => {
    const isAdmin = getAuthenticatedRole() === "admin";
    const previousFingerprint = isAdmin
      ? state.batchSyncFingerprint
      : getBatchSyncFingerprint(getStoredUserBatches());
    const batches = isAdmin
      ? await loadAllBatchesFromBackend()
      : await loadUserBatchesFromBackend(true);
    const nextFingerprint = getBatchSyncFingerprint(batches);
    const changed = previousFingerprint !== nextFingerprint;
    state.batchSyncFingerprint = nextFingerprint;
    if (!changed) return batches;

    invalidateUnifiedHistoryCaches();
    invalidateReportsCache();
    if (isReportsScreen()) void refreshReportsPage();
    if (isAdmin) {
      renderAdminBatchState(batches);
      if (state.currentPage === "history") {
        void hydrateHistoryOverview();
      }
    } else {
      refreshUserBatchUiFromCache();
    }
    return batches;
  })().catch(() => null).finally(() => {
    state.batchSyncRequest = null;
  });
  return state.batchSyncRequest;
}

function startLiveBatchSync() {
  if (!state.batchSyncTimer) {
    // Once the live poll sends revisions, a change to the batches revision
    // triggers the sync and this timer is only a backstop. A hidden tab skips
    // its turn.
    state.batchSyncTimer = window.setInterval(() => {
      if (document.hidden) return;
      if (state.liveRevisions
        && Date.now() - (state.batchSyncedAt || 0) < CHANGE_MARKER_FALLBACK_MS) return;
      void syncLiveBatchUpdates();
    }, BATCH_SYNC_INTERVAL_MS);
  }
}

window.addEventListener("storage", (event) => {
  if (event.key === BATCH_SYNC_STORAGE_KEY) void syncLiveBatchUpdates();
});
// A tab shown again polls at once: its change markers catch up anything that
// moved while it was hidden, and the device returns to its fast poll.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && isAuthenticated()) void refreshComponentDeviceStatuses();
});

async function hydrateAdminOperationalOverview() {
  if (getAuthenticatedRole() !== "admin" || !["dashboard", "batch"].includes(state.currentPage)) return;
  try {
    const [batches, componentPayload] = await Promise.all([
      loadAllBatchesFromBackend(),
      requestBackendJson(COMPONENT_STATUS_ENDPOINT),
      loadSharedSensorReadings(),
    ]);
    applyDevicePresencePayload(componentPayload);
    renderAdminBatchState(batches);
    updateSensorReadingPage({ rerenderCharts: true });
  } catch {
    // Honest empty states remain visible if the shared backend is unavailable.
  }
}

function getDeletedUserBatchIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(getScopedBatchStorageKey(USER_BATCH_DELETED_KEY)) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map((id) => String(id).toLowerCase()) : []);
  } catch {
    return new Set();
  }
}

function writeDeletedUserBatchIds(ids) {
  localStorage.setItem(getScopedBatchStorageKey(USER_BATCH_DELETED_KEY), JSON.stringify(Array.from(ids)));
}

function markUserBatchDeleted(id) {
  const deletedIds = getDeletedUserBatchIds();
  const normalizedId = String(id || "").toLowerCase();
  if (!normalizedId) return;
  deletedIds.add(normalizedId);
  writeDeletedUserBatchIds(deletedIds);
}

function unmarkUserBatchDeleted(id) {
  const deletedIds = getDeletedUserBatchIds();
  const normalizedId = String(id || "").toLowerCase();
  if (!normalizedId || !deletedIds.has(normalizedId)) return;
  deletedIds.delete(normalizedId);
  writeDeletedUserBatchIds(deletedIds);
}

function applyDeletedUserBatchRows() {
  const deletedIds = getDeletedUserBatchIds();
  if (!deletedIds.size) return;
  getBatchRows().forEach((row) => {
    const details = getBatchRowData(row);
    if (details?.id && deletedIds.has(details.id.toLowerCase())) row.remove();
  });
}

async function saveUserBatchRecord(batch, { allowUpdate = false } = {}) {
  const normalized = normalizeUserBatchRecord(batch);
  if (!normalized) return [];
  userBatchState.mutationCount += 1;
  let payload;
  try {
    payload = await requestBackendJson(BATCH_ENDPOINT, {
      method: "POST",
      body: {
        ...normalized,
        username: getAuthenticatedUsername(),
        allowUpdate,
      },
    });
  } finally {
    userBatchState.mutationCount = Math.max(0, userBatchState.mutationCount - 1);
  }
  const saved = normalizeUserBatchRecord(payload.batch || normalized) || normalized;
  notificationState.cache = null;
  void refreshNotificationBadgesFromBackend({ forceRefresh: true, announce: true });
  const automaticModes = payload.automaticModes && typeof payload.automaticModes === "object"
    ? payload.automaticModes
    : (payload.actuatorMode === "auto" ? { actuator: "auto" } : {});
  if (Object.keys(automaticModes).length > 0) {
    const settings = readAdminSettings();
    settings.componentModes = {
      ...(settings.componentModes && typeof settings.componentModes === "object" ? settings.componentModes : {}),
      ...automaticModes,
    };
    writeAdminSettings(settings);
  }
  unmarkUserBatchDeleted(normalized.id);
  const withoutDuplicate = getStoredUserBatches().filter((item) => item.id.toLowerCase() !== saved.id.toLowerCase());
  const nextBatches = [saved, ...withoutDuplicate];
  writeStoredUserBatches(nextBatches);
  invalidateUnifiedHistoryCaches();
  invalidateReportsCache();
  publishBatchMutation(allowUpdate ? "update" : "create", saved.id);
  return nextBatches;
}

function getActiveBatch() {
  return getScheduleActiveBatches()[0] || { ...DEFAULT_ACTIVE_BATCH };
}

function getScheduleActiveBatches() {
  return getStoredUserBatches()
    .filter((batch) => (
      normalizeBatchStatus(batch.status) === "in-progress"
      && Number(batch.eggCount || 0) > 0
      && Boolean(parseDateInputValue(batch.startDate))
    ))
    .sort((a, b) => {
      const startCompare = String(a.startDate || "").localeCompare(String(b.startDate || ""));
      if (startCompare !== 0) return startCompare;
      return getBatchRecordTime(a.createdAt) - getBatchRecordTime(b.createdAt);
    });
}

function getSelectedScheduleBatch(batches = getScheduleActiveBatches()) {
  if (!batches.length) return { ...DEFAULT_ACTIVE_BATCH };
  const selected = batches.find((batch) => batch.id === state.scheduleSelectedBatchId) || batches[0];
  state.scheduleSelectedBatchId = selected.id;
  return selected;
}

function getDaysBetweenDates(startValue, endValue) {
  const startDate = parseDateInputValue(startValue);
  const endDate = parseDateInputValue(endValue);
  if (!startDate || !endDate || endDate < startDate) return null;
  return Math.max(1, Math.round((endDate - startDate) / (24 * 60 * 60 * 1000)) + 1);
}

function addDaysToDate(value, days) {
  const date = parseDateInputValue(value);
  if (!date) return null;
  date.setDate(date.getDate() + Number(days || 0));
  return date;
}

function formatBatchShortDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatScheduleTableDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });
}

function getBatchTargetDays(batch) {
  return parseDateInputValue(batch?.startDate) ? INCUBATION_TARGET_DAYS : 0;
}

function getBatchCurrentDay(batch) {
  const targetDays = getBatchTargetDays(batch);
  if (targetDays <= 0) return 0;
  if (batch?.status === "completed") return targetDays;
  if (batch?.status === "upcoming") return 0;

  const startDate = parseDateInputValue(batch?.startDate);
  if (!startDate) return 0;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const day = Math.round((today - startDate) / (24 * 60 * 60 * 1000)) + 1;
  return Math.min(Math.max(day, 0), targetDays);
}

function getBatchDashboardSnapshot(batch = getActiveBatch()) {
  const normalized = normalizeUserBatchRecord(batch) || { ...DEFAULT_ACTIVE_BATCH };
  const targetDays = getBatchTargetDays(normalized);
  const currentDay = getBatchCurrentDay(normalized);
  const statusMeta = getBatchStatusMeta(normalized.status);
  const progress = targetDays <= 0
    ? 0
    : normalized.status === "completed"
    ? 100
    : normalized.status === "upcoming"
      ? 0
      : Math.min(99, Math.max(1, Math.round((currentDay / targetDays) * 100)));

  return {
    ...normalized,
    currentDay,
    targetDays,
    progress,
    statusLabel: statusMeta.label,
    startDateLabel: formatBatchDate(normalized.startDate),
    hatchDateLabel: formatBatchDate(normalized.expectedHatchDate),
  };
}

function getNextEggTurningInfo() {
  const now = new Date();
  const turnHours = [10, 15, 20];
  const next = new Date(now);
  const nextHour = turnHours.find((hour) => {
    const candidate = new Date(now);
    candidate.setHours(hour, 0, 0, 0);
    return candidate > now;
  });

  if (nextHour === undefined) {
    next.setDate(next.getDate() + 1);
    next.setHours(turnHours[0], 0, 0, 0);
  } else {
    next.setHours(nextHour, 0, 0, 0);
  }

  const minutes = Math.max(0, Math.round((next - now) / 60000));
  const hoursRemaining = Math.floor(minutes / 60);
  const minutesRemaining = minutes % 60;
  const dayLabel = next.toDateString() === now.toDateString() ? "Today" : "Tomorrow";
  const timeLabel = next.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return {
    title: `${dayLabel}, ${timeLabel}`,
    meta: hoursRemaining > 0 ? `In ${hoursRemaining}h ${minutesRemaining}m` : `In ${minutesRemaining}m`,
  };
}

function getNextCandlingInfo(batch) {
  const snapshot = getScheduleSnapshot(batch);
  const completedDays = getBatchCompletedScheduleDays(snapshot);
  const nextDay = [7, 14, 18].find((day) => !completedDays.has(day)) || 18;
  const date = addDaysToDate(snapshot.startDate, Math.max(0, nextDay - 1));
  return {
    day: nextDay,
    title: `${formatBatchShortDate(date)} (Day ${nextDay})`,
  };
}

function getScheduleSnapshot(batch = getActiveBatch()) {
  const snapshot = getBatchDashboardSnapshot(batch);
  const targetDays = snapshot.startDate ? INCUBATION_TARGET_DAYS : 0;
  const currentDay = targetDays > 0 ? Math.min(Math.max(snapshot.currentDay || 0, 0), targetDays) : 0;
  const harvestDate = addDaysToDate(snapshot.startDate, INCUBATION_TARGET_DAYS - 1);

  return {
    ...snapshot,
    currentDay,
    targetDays,
    expectedHatchDate: toDateInputValue(harvestDate),
    harvestDate,
  };
}

function toDateInputValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getBatchCompletedScheduleDays(batch) {
  return new Set(normalizeCompletedScheduleDays(batch?.completedScheduleDays));
}

function buildBatchScheduleMilestones(batch, { includeCompleted = true } = {}) {
  const startDate = parseDateInputValue(batch?.startDate);
  if (!startDate) return [];
  const completedDays = getBatchCompletedScheduleDays(batch);
  return SCHEDULE_MILESTONES
    .map((milestone) => {
      const date = addDaysToDate(batch.startDate, milestone.offset);
      return {
        ...milestone,
        batchId: batch.id,
        batch,
        date,
        dateValue: toDateInputValue(date),
        completed: completedDays.has(milestone.day),
      };
    })
    .filter((milestone) => includeCompleted || !milestone.completed);
}

function getScheduleMilestones(batches = getScheduleActiveBatches(), options = {}) {
  return batches.flatMap((batch) => buildBatchScheduleMilestones(batch, options));
}

function getUncompletedScheduleMilestones(batches = getScheduleActiveBatches()) {
  return getScheduleMilestones(batches, { includeCompleted: false });
}

function getScheduleMilestone(day) {
  return SCHEDULE_MILESTONES.find((milestone) => milestone.day === Number(day)) || SCHEDULE_MILESTONES[0];
}

function getScheduleMilestonesForDate(dateValue, batches = getScheduleActiveBatches()) {
  return getUncompletedScheduleMilestones(batches)
    .filter((milestone) => milestone.dateValue === dateValue)
    .sort((a, b) => a.day - b.day || a.batchId.localeCompare(b.batchId));
}

function isScheduleMilestoneDue(milestone, dateValue = toDateInputValue(new Date())) {
  return Boolean(milestone?.dateValue && milestone.dateValue <= dateValue);
}

function getScheduleDayStatus(day, currentDay) {
  if (currentDay <= 0) return "upcoming";
  if (day < currentDay) return "completed";
  if (day === currentDay) return "current";
  return "upcoming";
}

function getScheduleStatusMeta(status) {
  if (status === "completed") return { label: "Completed", className: "schedule-status-pill--done" };
  if (status === "current") return { label: "Current", className: "schedule-status-pill--current" };
  return { label: "Upcoming", className: "schedule-status-pill--upcoming" };
}

function buildScheduleDayEntries(batch = getActiveBatch()) {
  const snapshot = getScheduleSnapshot(batch);
  const candlingDays = new Set([7, 14].filter((day) => day <= snapshot.targetDays));
  const completedDays = getBatchCompletedScheduleDays(snapshot);
  return Array.from({ length: snapshot.targetDays }, (_, index) => {
    const day = index + 1;
    const date = addDaysToDate(snapshot.startDate, index);
    const isMilestone = [1, 7, 14, 18].includes(day);
    const status = isMilestone
      ? completedDays.has(day)
        ? "completed"
        : day === snapshot.currentDay
          ? "current"
          : "upcoming"
      : getScheduleDayStatus(day, snapshot.currentDay);
    const activities = [];

    if (day === 1) {
      activities.push({ time: "07:00 AM", title: "Start Incubation", details: "Incubation started" });
    }
    if (candlingDays.has(day)) {
      activities.push({ time: "07:00 AM", title: `${day === 7 ? "1st" : "2nd"} Candling`, details: "Check egg development and record activity" });
    }
    activities.push({ time: "10:00 AM", title: "Egg Turning", details: "Turn eggs at least 3 times a day" });
    if (day === INCUBATION_TARGET_DAYS) {
      activities.push({ time: "07:00 AM", title: "Harvest Day", details: "Expected day to harvest" });
    }

    return {
      day,
      date,
      status,
      isCandlingDay: candlingDays.has(day),
      isHarvestDay: day === INCUBATION_TARGET_DAYS,
      activities,
    };
  });
}

function renderScheduleAgenda(batch = getActiveBatch()) {
  const root = app.pageRoot?.querySelector(".schedule-agenda");
  if (!root) return;

  const snapshot = getScheduleSnapshot(batch);
  const day = Math.max(1, snapshot.currentDay || 1);
  const todayEntry = buildScheduleDayEntries(batch).find((entry) => entry.day === day);
  const items = [
    ...(todayEntry?.isCandlingDay ? [{ time: "07:00 AM", title: `Candling Day ${day}`, details: "Check egg development", status: "completed" }] : []),
    { time: "10:00 AM", title: "Egg Turning", details: "Turn eggs to ensure proper development", status: "completed" },
    { time: "03:00 PM", title: "Egg Turning", details: "Turn eggs to ensure proper development", status: "upcoming" },
    { time: "08:00 PM", title: snapshot.currentDay >= snapshot.targetDays ? "Harvest Check" : "System Check", details: "Check temperature, humidity and devices", status: "upcoming" },
  ];

  root.innerHTML = items.map((item) => {
    const statusMeta = getScheduleStatusMeta(item.status);
    return `
      <article class="schedule-agenda__item">
        <div class="schedule-agenda__icon"><span data-icon="clock-3"></span></div>
        <div class="schedule-agenda__time">${escapeHtml(item.time)}</div>
        <div class="schedule-agenda__content">
          <h4 class="schedule-agenda__title">${escapeHtml(item.title)}</h4>
          <p class="schedule-agenda__copy">${escapeHtml(item.details)}</p>
        </div>
        <span class="schedule-status-pill ${statusMeta.className}">${statusMeta.label}</span>
      </article>
    `;
  }).join("");
  hydrateIcons(root);
}

function renderScheduleCalendar(batches = getScheduleActiveBatches()) {
  const root = app.pageRoot?.querySelector(".schedule-calendar");
  if (!root) return;
  const activeBatches = Array.isArray(batches)
    ? batches.filter((batch) => batch?.id && batch?.startDate && Number(batch?.eggCount || 0) > 0)
    : getScheduleActiveBatches();
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const todayValue = toDateInputValue(today);
  const displayDate = new Date(today);
  displayDate.setDate(1);
  displayDate.setMonth(displayDate.getMonth() + Number(state.scheduleCalendarMonthOffset || 0));
  const monthStart = new Date(displayDate.getFullYear(), displayDate.getMonth(), 1);
  const calendarStart = new Date(monthStart);
  calendarStart.setDate(calendarStart.getDate() - calendarStart.getDay());
  const milestonesByDate = getUncompletedScheduleMilestones(activeBatches).reduce((map, milestone) => {
    if (!map.has(milestone.dateValue)) map.set(milestone.dateValue, []);
    map.get(milestone.dateValue).push(milestone);
    return map;
  }, new Map());

  const monthNode = root.querySelector(".schedule-calendar__month");
  if (monthNode) {
    monthNode.textContent = displayDate.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  }

  const grid = root.querySelector(".schedule-calendar__grid");
  if (!grid) return;
  grid.innerHTML = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(calendarStart);
    date.setDate(calendarStart.getDate() + index);
    const dateValue = toDateInputValue(date);
    const milestones = (milestonesByDate.get(dateValue) || [])
      .sort((a, b) => a.day - b.day || a.batchId.localeCompare(b.batchId));
    const classes = [];
    if (date.getMonth() !== displayDate.getMonth()) classes.push("is-muted");
    if (dateValue === todayValue && milestones.length) classes.push("is-today");
    if (milestones.length) {
      classes.push("has-schedule-events");
      const types = new Set(milestones.map((milestone) => milestone.type));
      types.forEach((type) => classes.push(`is-${type}`));
      if (types.size > 1) classes.push("is-mixed");
    }
    const visibleMilestones = milestones.slice(0, 3);
    const hiddenCount = Math.max(0, milestones.length - visibleMilestones.length);
    const eventLabels = visibleMilestones.map((milestone) => `
      <small class="schedule-calendar__event schedule-calendar__event--${milestone.type}" title="${escapeHtml(`${milestone.batchId}: ${milestone.title}`)}">
        <span>${escapeHtml(milestone.batchId)}</span>
        <b>Day ${milestone.day}</b>
      </small>
    `).join("");
    const overflowLabel = hiddenCount
      ? `<small class="schedule-calendar__event-more">+${hiddenCount} more</small>`
      : "";
    const ariaLabel = milestones.length
      ? `${date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}: ${milestones.map((milestone) => `${milestone.batchId} ${milestone.title}`).join(", ")}`
      : date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    return `
      <button
        type="button"
        class="${classes.join(" ")}"
        data-schedule-date="${dateValue}"
        aria-label="${escapeHtml(ariaLabel)}"
        ${milestones.length ? "" : "aria-disabled=\"true\""}
      >
        <strong>${date.getDate()}</strong>
        ${milestones.length ? `<span class="schedule-calendar__events">${eventLabels}${overflowLabel}</span>` : ""}
      </button>
    `;
  }).join("");
  bindSchedulePageInteractions();
}

function getScheduleEventForDay(day) {
  const snapshot = getScheduleSnapshot();
  const numberDay = Number(day || snapshot.currentDay || 1);
  if (numberDay === 1) {
    return {
      icon: "check-circle",
      title: "Start of Incubation",
      badge: "Setup",
      purpose: "Begin incubation cycle and record starting egg count.",
      details: "Incubation cycle starts today.",
    };
  }
  if (numberDay === 7 || numberDay === 14) {
    return {
      icon: "clock-3",
      title: numberDay === 7 ? "1st Candling / Penoy Harvest" : "2nd Candling / Balut Check",
      badge: "Candling",
      purpose: "Check egg development and remove non-viable eggs.",
      details: "Inspect eggs with proper candling light.",
    };
  }
  if (numberDay === INCUBATION_TARGET_DAYS) {
    return {
      icon: "flag",
      title: "Harvest Day",
      badge: "Harvest",
      purpose: "Complete the incubation cycle and record harvest results.",
      details: "Expected day to harvest.",
    };
  }
  return {
    icon: "refresh-cw",
    title: "Egg Turning",
    badge: "Routine",
    purpose: "Ensure proper development and prevent sticking.",
    details: "Turn eggs at least 3 times a day (morning, afternoon, evening).",
  };
}

function closeScheduleModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  syncModalOpenState();
}

function ensureScheduleDayModal() {
  let modal = document.getElementById("schedule-day-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "schedule-day-modal";
  modal.className = "schedule-detail-modal";
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `<button class="schedule-detail-modal__backdrop" type="button" tabindex="-1" aria-label="Close day details"></button><section class="schedule-detail-modal__card" role="dialog" aria-modal="true"></section>`;
  document.body.appendChild(modal);
  modal.querySelector(".schedule-detail-modal__backdrop")?.addEventListener("click", () => closeScheduleModal("schedule-day-modal"));
  return modal;
}

function getScheduleActionIcon(day) {
  if (Number(day) === 1) return "check-circle";
  if (Number(day) === 18) return "flag";
  return "clock-3";
}

function updateCachedBatchAfterScheduleCompletion(payload, milestone, removedCount) {
  const records = getStoredUserBatches();
  const current = records.find((batch) => batch.id.toLowerCase() === milestone.batchId.toLowerCase());
  const payloadBatch = payload?.batch || payload?.updatedBatch || null;
  const normalizedPayloadBatch = normalizeUserBatchRecord(payloadBatch);
  const completedScheduleDays = normalizeCompletedScheduleDays([
    ...(normalizedPayloadBatch?.completedScheduleDays || current?.completedScheduleDays || []),
    milestone.day,
  ]);
  const fallbackEggCount = Math.max(0, Number(current?.eggCount || 0) - removedCount);
  const nextEggCount = normalizedPayloadBatch
    ? Number(normalizedPayloadBatch.eggCount || 0)
    : fallbackEggCount;
  const updated = normalizeUserBatchRecord({
    ...(current || milestone.batch),
    ...(normalizedPayloadBatch || {}),
    eggCount: nextEggCount,
    initialEggCount: normalizedPayloadBatch?.initialEggCount || current?.initialEggCount || current?.eggCount || milestone.batch?.eggCount || 0,
    completedScheduleDays,
    status: nextEggCount === 0 ? "completed" : normalizedPayloadBatch?.status || current?.status || "in-progress",
    endDate: nextEggCount === 0
      ? normalizedPayloadBatch?.endDate || toDateInputValue(new Date())
      : normalizedPayloadBatch?.endDate || current?.endDate || "",
  });
  if (!updated) return;
  const nextRecords = records.map((batch) => (
    batch.id.toLowerCase() === updated.id.toLowerCase() ? updated : batch
  ));
  writeStoredUserBatches(nextRecords);
}

async function submitScheduleCompletion(event, milestone) {
  event.preventDefault();
  const form = event.currentTarget;
  const removedInput = form.elements.removedCount;
  const isStart = milestone.day === 1;
  const removedCount = isStart ? 0 : Number.parseInt(removedInput?.value || "0", 10);
  const checkedTypes = Array.from(form.querySelectorAll('input[name="eggType"]:checked')).map((input) => input.value);
  const submitButton = form.querySelector("[data-schedule-complete-submit]");

  form.querySelectorAll(".is-invalid").forEach((field) => field.classList.remove("is-invalid"));
  if (!Number.isInteger(removedCount) || removedCount < 0 || removedCount > Number(milestone.batch.eggCount || 0)) {
    removedInput?.classList.add("is-invalid");
    removedInput?.focus();
    await showWarningCard(
      "Invalid removed egg count",
      `Enter a whole number from 0 to ${milestone.batch.eggCount}.`,
      removedInput,
    );
    return;
  }
  if (removedCount > 0 && checkedTypes.length !== 1) {
    const firstCheckbox = form.querySelector('input[name="eggType"]');
    firstCheckbox?.closest("label")?.classList.add("is-invalid");
    firstCheckbox?.focus();
    await showWarningCard("Egg type required", "Choose exactly one egg type: Balut or Penoy.", firstCheckbox);
    return;
  }

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Saving...";
  }
  try {
    const payload = await requestBackendJson(COMPLETE_SCHEDULE_ENDPOINT, {
      method: "POST",
      body: {
        username: getAuthenticatedUsername(),
        batchId: milestone.batchId,
        eventDay: milestone.day,
        removedCount,
        eggType: removedCount > 0 ? checkedTypes[0] : "",
      },
    });
    updateCachedBatchAfterScheduleCompletion(payload, milestone, removedCount);
    invalidateReportsCache();
    closeScheduleModal("schedule-day-modal");
    const remaining = Math.max(0, Number(milestone.batch.eggCount || 0) - removedCount);
    showToast(
      milestone.day === 1 ? "Incubation started" : "Schedule completed",
      remaining === 0
        ? `${milestone.batchId} has no eggs remaining and was moved to Batch History.`
        : `${milestone.title} was completed for ${milestone.batchId}.`,
    );
    await hydrateScheduleOverview();
  } catch (error) {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = milestone.day === 1 ? "Mark Start Complete" : "Complete Schedule";
    }
    await showWarningCard(
      "Schedule was not completed",
      error.message || "The backend could not save this schedule action.",
      submitButton,
    );
  }
}

function renderScheduleActionModal(modal, dateValue, milestones, selectedBatchId = "") {
  const card = modal.querySelector(".schedule-detail-modal__card");
  if (!card || !milestones.length) return;
  const milestone = milestones.find((item) => item.batchId === selectedBatchId) || milestones[0];
  const event = getScheduleEventForDay(milestone.day);
  const due = isScheduleMilestoneDue(milestone);
  const isStart = milestone.day === 1;
  const progress = Math.round((milestone.day / INCUBATION_TARGET_DAYS) * 1000) / 10;
  const formattedDate = milestone.date?.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }) || formatBatchDate(dateValue);
  const batchOptions = milestones.map((item) => `
    <option value="${escapeHtml(item.batchId)}" ${item.batchId === milestone.batchId ? "selected" : ""}>
      ${escapeHtml(`${item.batchId} - ${item.shortTitle} (${item.batch.eggCount} eggs)`)}
    </option>
  `).join("");

  card.innerHTML = `
    <button type="button" class="schedule-detail-modal__close" aria-label="Close schedule action">&times;</button>
    <div class="schedule-day-modal__title schedule-day-modal__title--${milestone.type}">
      <span class="schedule-day-modal__icon" data-icon="${getScheduleActionIcon(milestone.day)}"></span>
      <div>
        <h3>${escapeHtml(milestone.title)} <span>Day ${milestone.day}</span></h3>
        <p>${escapeHtml(formattedDate)}</p>
      </div>
    </div>
    <form class="schedule-action-form" novalidate>
      <label class="schedule-action-field">
        <span>Active Batch</span>
        <select name="batchId" class="schedule-action-input" aria-label="Select active batch">
          ${batchOptions}
        </select>
      </label>
      <div class="schedule-action-overview">
        <article><small>Current Egg Count</small><strong>${milestone.batch.eggCount} Eggs</strong></article>
        <article><small>Schedule</small><strong>Day ${milestone.day} of ${INCUBATION_TARGET_DAYS}</strong></article>
        <article><small>Status</small><strong>${due ? "Ready to complete" : "Upcoming"}</strong></article>
      </div>
      <section class="schedule-day-modal__progress">
        <p><span data-icon="calendar"></span><strong>Incubation Progress</strong></p>
        <div><span style="width:${progress}%;"></span></div>
        <small>Day ${milestone.day} of ${INCUBATION_TARGET_DAYS} (${progress}%)</small>
      </section>
      ${isStart ? `
        <p class="schedule-action-note"><span data-icon="info"></span>Confirm that this batch has started incubation. No eggs will be removed.</p>
      ` : `
        <label class="schedule-action-field">
          <span>Eggs Removed</span>
          <input
            class="schedule-action-input"
            name="removedCount"
            type="number"
            min="0"
            max="${milestone.batch.eggCount}"
            step="1"
            value="0"
            inputmode="numeric"
          />
          <small>Enter 0 when no eggs were removed during this schedule.</small>
        </label>
        <fieldset class="schedule-action-field schedule-action-types">
          <legend>Removed Egg Type</legend>
          <label><input type="checkbox" name="eggType" value="balut" /><span>Balut</span></label>
          <label><input type="checkbox" name="eggType" value="penoy" /><span>Penoy</span></label>
          <small>Choose exactly one type when the removed count is greater than 0.</small>
        </fieldset>
      `}
      ${due ? "" : `<p class="schedule-action-note is-upcoming"><span data-icon="clock-3"></span>This action becomes available on ${escapeHtml(formatBatchDate(dateValue))}.</p>`}
      <div class="schedule-action-buttons">
        <button type="button" class="schedule-action-cancel">Close</button>
        <button type="submit" class="schedule-action-submit" data-schedule-complete-submit ${due ? "" : "disabled"}>
          ${isStart ? "Mark Start Complete" : "Complete Schedule"}
        </button>
      </div>
    </form>
  `;

  hydrateIcons(card);
  card.querySelector(".schedule-detail-modal__close")?.addEventListener("click", () => closeScheduleModal("schedule-day-modal"));
  card.querySelector(".schedule-action-cancel")?.addEventListener("click", () => closeScheduleModal("schedule-day-modal"));
  card.querySelector("select[name='batchId']")?.addEventListener("change", (selectEvent) => {
    state.scheduleSelectedBatchId = selectEvent.target.value;
    renderScheduleActionModal(modal, dateValue, milestones, selectEvent.target.value);
  });
  card.querySelectorAll('input[name="eggType"]').forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (!checkbox.checked) return;
      card.querySelectorAll('input[name="eggType"]').forEach((other) => {
        if (other !== checkbox) other.checked = false;
      });
    });
  });
  card.querySelector(".schedule-action-form")?.addEventListener("submit", (submitEvent) => {
    void submitScheduleCompletion(submitEvent, milestone);
  });
}

function openScheduleDateModal(dateValue, { selectedBatchId = "" } = {}) {
  const milestones = getScheduleMilestonesForDate(dateValue);
  if (!milestones.length) {
    showToast("No pending schedule", "All key schedules on this date are complete.");
    return;
  }
  const modal = ensureScheduleDayModal();
  renderScheduleActionModal(modal, dateValue, milestones, selectedBatchId);
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  syncModalOpenState();
  window.setTimeout(() => modal.querySelector("select, input, button")?.focus(), 0);
}

function openScheduleDayModal(dayValue) {
  const batch = getSelectedScheduleBatch();
  const milestone = buildBatchScheduleMilestones(batch, { includeCompleted: false })
    .find((item) => item.day === Number(dayValue));
  if (!milestone) {
    showToast("No pending schedule", "This schedule is already complete or no active batch is available.");
    return;
  }
  openScheduleDateModal(milestone.dateValue, { selectedBatchId: batch.id });
}

function ensureScheduleLogModal() {
  let modal = document.getElementById("schedule-log-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "schedule-log-modal";
  modal.className = "schedule-detail-modal schedule-log-modal";
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `<button class="schedule-detail-modal__backdrop" type="button" tabindex="-1" aria-label="Close incubation log"></button><section class="schedule-detail-modal__card schedule-log-modal__card" role="dialog" aria-modal="true"></section>`;
  document.body.appendChild(modal);
  modal.querySelector(".schedule-detail-modal__backdrop")?.addEventListener("click", () => closeScheduleModal("schedule-log-modal"));
  return modal;
}

function openScheduleLogModal() {
  const snapshot = getScheduleSnapshot();
  const completedDays = getBatchCompletedScheduleDays(snapshot);
  const modal = ensureScheduleLogModal();
  const card = modal.querySelector(".schedule-log-modal__card");
  if (!card) return;
  const hasSchedule = Boolean(snapshot.startDate && snapshot.targetDays > 0 && snapshot.eggCount > 0);
  const rows = hasSchedule
    ? buildScheduleDayEntries(snapshot)
      .filter((entry) => entry.day === 1 || entry.isCandlingDay || entry.isHarvestDay)
      .flatMap((entry) => entry.activities
        .filter((activity) => /Start Incubation|Candling|Harvest Day/i.test(activity.title))
        .map((activity) => [
          `${formatScheduleTableDate(entry.date)} ${activity.time}`,
          activity.title,
          activity.details,
          completedDays.has(entry.day) ? getAuthenticatedUser() : "Pending",
          entry.day === 1 ? "check-circle" : entry.isHarvestDay ? "flag" : "clock-3",
        ]))
    : [];
  card.innerHTML = `
    <button type="button" class="schedule-detail-modal__close" aria-label="Close incubation log">&times;</button>
    <div class="schedule-log-header"><span data-icon="calendar"></span><div><h3>Incubation Log</h3><p>View all key activities and changes made during this incubation cycle.</p></div></div>
    <div class="schedule-log-meta">
      <div><small>Batch / Cycle</small><strong>${escapeHtml(hasSchedule ? snapshot.id : "No active batch")}</strong></div>
      <div><small>Start Date</small><strong>${escapeHtml(hasSchedule ? formatBatchDate(snapshot.startDate) : "--")}</strong></div>
      <div><small>Expected Harvest Date</small><strong>${escapeHtml(hasSchedule ? formatBatchDate(snapshot.harvestDate && toDateInputValue(snapshot.harvestDate)) : "--")}</strong></div>
      <div><small>Total Eggs</small><strong>${hasSchedule ? snapshot.eggCount : 0} Eggs</strong></div>
    </div>
    <div class="schedule-log-list">
      ${rows.length ? rows.map(([time, eventTitle, details, by, icon]) => `
        <article>
          <time>${escapeHtml(time)}</time>
          <span data-icon="${icon}"></span>
          <strong>${escapeHtml(eventTitle)}</strong>
          <p>${escapeHtml(details)}</p>
          <em>${escapeHtml(by)}</em>
        </article>
      `).join("") : `<p class="table-empty">No incubation log is available until a batch is created.</p>`}
    </div>
    <button type="button" class="schedule-detail-modal__done">Exit</button>
  `;
  hydrateIcons(card);
  card.querySelector(".schedule-detail-modal__close")?.addEventListener("click", () => closeScheduleModal("schedule-log-modal"));
  card.querySelector(".schedule-detail-modal__done")?.addEventListener("click", () => closeScheduleModal("schedule-log-modal"));
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  syncModalOpenState();
}

function bindSchedulePageInteractions() {
  if (state.currentPage !== "candling" || !app.pageRoot) return;
  app.pageRoot.querySelectorAll(".schedule-calendar__nav").forEach((button) => {
    if (button.dataset.scheduleNavBound === "true") return;
    button.dataset.scheduleNavBound = "true";
    button.addEventListener("click", () => {
      const direction = /previous/i.test(button.getAttribute("aria-label") || "") ? -1 : 1;
      state.scheduleCalendarMonthOffset += direction;
      renderScheduleCalendar(getScheduleActiveBatches());
    });
  });
  app.pageRoot.querySelectorAll("[data-schedule-date]").forEach((button) => {
    if (
      button.dataset.scheduleBound === "true"
      || button.getAttribute("aria-disabled") === "true"
      || !button.dataset.scheduleDate
    ) return;
    button.dataset.scheduleBound = "true";
    button.addEventListener("click", () => openScheduleDateModal(button.dataset.scheduleDate));
  });
  const today = app.pageRoot.querySelector("[data-schedule-today]");
  if (today && today.dataset.scheduleBound !== "true") {
    today.dataset.scheduleBound = "true";
    today.addEventListener("click", () => {
      state.scheduleCalendarMonthOffset = 0;
      renderScheduleCalendar(getScheduleActiveBatches());
      const todayValue = toDateInputValue(new Date());
      if (getScheduleMilestonesForDate(todayValue).length) {
        openScheduleDateModal(todayValue);
      }
    });
  }
  const log = app.pageRoot.querySelector("[data-schedule-log]");
  if (log && log.dataset.scheduleBound !== "true") {
    log.dataset.scheduleBound = "true";
    log.addEventListener("click", openScheduleLogModal);
  }
}

function ensureScheduleFullModal() {
  if (app.scheduleFullModal) return app.scheduleFullModal;

  const wrapper = document.createElement("div");
  wrapper.id = "schedule-full-modal";
  wrapper.className = "schedule-full-modal";
  wrapper.hidden = true;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = `
    <button class="schedule-full-modal__backdrop" type="button" tabindex="-1" aria-label="Close full schedule"></button>
    <section class="schedule-full-modal__card" role="dialog" aria-modal="true" aria-labelledby="schedule-full-title">
      <div class="schedule-full-modal__topbar">
        <div>
          <p class="schedule-full-modal__eyebrow">Full Incubation Schedule</p>
          <h2 id="schedule-full-title" class="schedule-full-modal__title">No active batch</h2>
        </div>
        <div class="schedule-full-modal__actions">
          <span class="schedule-full-modal__badge" data-schedule-full-day>Day 1 of 18</span>
          <button class="schedule-full-modal__close" type="button" aria-label="Close full schedule">${renderIcon("x-circle")}</button>
        </div>
      </div>
      <div class="schedule-full-table-wrap">
        <table class="schedule-full-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Date</th>
              <th>Activity</th>
              <th>Details</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody data-schedule-full-body></tbody>
        </table>
      </div>
      <div class="schedule-full-modal__footer">
        <div>
          <span>Current Day</span>
          <strong data-schedule-full-current>Day 1 of 18</strong>
        </div>
        <div>
          <span>Next Activity</span>
          <strong data-schedule-full-next>Egg Turning</strong>
        </div>
        <button class="schedule-full-modal__done" type="button">Close</button>
      </div>
    </section>
  `;

  document.body.appendChild(wrapper);
  app.scheduleFullModal = wrapper;
  wrapper.querySelector(".schedule-full-modal__backdrop")?.addEventListener("click", closeScheduleFullModal);
  wrapper.querySelector(".schedule-full-modal__close")?.addEventListener("click", closeScheduleFullModal);
  wrapper.querySelector(".schedule-full-modal__done")?.addEventListener("click", closeScheduleFullModal);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app.scheduleFullModal && !app.scheduleFullModal.hidden) {
      event.preventDefault();
      closeScheduleFullModal();
    }
  });
  return wrapper;
}

function closeScheduleFullModal() {
  if (!app.scheduleFullModal) return;
  app.scheduleFullModal.hidden = true;
  app.scheduleFullModal.setAttribute("aria-hidden", "true");
  syncModalOpenState();
}

function openScheduleFullModal() {
  const modal = ensureScheduleFullModal();
  const snapshot = getScheduleSnapshot();
  const entries = buildScheduleDayEntries();
  const title = modal.querySelector("#schedule-full-title");
  const badge = modal.querySelector("[data-schedule-full-day]");
  const current = modal.querySelector("[data-schedule-full-current]");
  const next = modal.querySelector("[data-schedule-full-next]");
  const body = modal.querySelector("[data-schedule-full-body]");

  if (title) title.textContent = snapshot.id;
  if (badge) badge.textContent = `Day ${snapshot.currentDay || 1} of ${snapshot.targetDays}`;
  if (current) current.textContent = `Day ${snapshot.currentDay || 1} of ${snapshot.targetDays}`;
  if (next) {
    const currentEntry = entries.find((entry) => entry.day >= Math.max(1, snapshot.currentDay || 1));
    next.textContent = currentEntry?.activities[0]?.title || "Egg Turning";
  }
  if (body) {
    body.innerHTML = entries.flatMap((entry) => {
      const statusMeta = getScheduleStatusMeta(entry.status);
      return entry.activities.map((activity, activityIndex) => `
        <tr class="${entry.status === "current" ? "is-current" : ""} ${entry.isCandlingDay ? "is-candling" : ""} ${entry.isHarvestDay ? "is-harvest" : ""}">
          <td>${activityIndex === 0 ? `<strong>Day ${entry.day}</strong>` : ""}</td>
          <td>${activityIndex === 0 ? escapeHtml(formatScheduleTableDate(entry.date)) : ""}</td>
          <td><span class="schedule-full-activity">${escapeHtml(activity.title)}</span></td>
          <td>${escapeHtml(activity.details)}</td>
          <td><span class="schedule-status-pill ${statusMeta.className}">${statusMeta.label}</span></td>
        </tr>
      `);
    }).join("");
  }

  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  syncModalOpenState();
  modal.querySelector(".schedule-full-modal__close")?.focus();
}

function closeSmartduckFilterMenus(exceptMenu = null) {
  app.pageRoot?.querySelectorAll(".smartduck-filter-menu").forEach((menu) => {
    if (menu === exceptMenu) return;
    menu.hidden = true;
  });
  app.pageRoot?.querySelectorAll("[data-smartduck-filter-toggle]").forEach((button) => {
    if (exceptMenu && button.getAttribute("aria-controls") === exceptMenu.id) return;
    button.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
  });
}

function bindSmartduckFilterMenuDismissal() {
  if (document.documentElement.dataset.smartduckFilterDismissalBound === "true") return;
  document.documentElement.dataset.smartduckFilterDismissalBound = "true";

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-smartduck-filter-toggle], .smartduck-filter-menu")) return;
    closeSmartduckFilterMenus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSmartduckFilterMenus();
  });
}

function buildSmartduckFilterMenu({ id, container, options, activeValue, onSelect }) {
  if (!container) return null;
  let menu = container.querySelector(`#${id}`);
  if (!menu) {
    menu = document.createElement("div");
    menu.id = id;
    menu.className = "smartduck-filter-menu";
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    container.appendChild(menu);
  }

  menu.innerHTML = options
    .map(
      (option) => `
        <button type="button" class="smartduck-filter-menu__option${option.value === activeValue ? " is-active" : ""}" data-filter-value="${option.value}" role="menuitemradio" aria-checked="${option.value === activeValue ? "true" : "false"}">
          <span>${escapeHtml(option.label)}</span>
          <strong>${option.count}</strong>
        </button>
      `,
    )
    .join("");

  menu.querySelectorAll("[data-filter-value]").forEach((button) => {
    button.dataset.uiBound = "true";
    button.addEventListener("click", () => {
      onSelect(button.dataset.filterValue || "all");
      closeSmartduckFilterMenus();
    });
  });

  return menu;
}

function toggleSmartduckFilterMenu(button) {
  const menuId = button.getAttribute("aria-controls");
  const menu = menuId ? document.getElementById(menuId) : null;
  if (!menu) return;

  const willOpen = menu.hidden;
  closeSmartduckFilterMenus(menu);
  menu.hidden = !willOpen;
  button.classList.toggle("is-open", willOpen);
  button.setAttribute("aria-expanded", String(willOpen));
}

function ensureTableEmptyState(container, className, message) {
  if (!container) return null;
  let emptyState = container.querySelector(`.${className}`);
  if (!emptyState) {
    emptyState = document.createElement("div");
    emptyState.className = `table-empty-state ${className}`;
    emptyState.hidden = true;
    container.appendChild(emptyState);
  }
  // Reassign every time: the node is reused across renders, so a caller that
  // changed its wording would otherwise keep showing the original message.
  if (emptyState.textContent !== message) emptyState.textContent = message;
  return emptyState;
}

function getBatchTableRoot() {
  return app.pageRoot?.querySelector(".batch-table-card") || null;
}

function getBatchRows(root = getBatchTableRoot()) {
  return Array.from(root?.querySelectorAll(".batch-table tbody tr") || []);
}

function getBatchRowStatus(row) {
  const text = row.querySelector(".batch-status-pill")?.textContent.trim().toLowerCase() || "";
  if (text.includes("progress")) return "in-progress";
  if (text.includes("complete")) return "completed";
  if (text.includes("upcoming")) return "upcoming";
  return "all";
}

function renderStoredUserBatchRows() {
  const tableBody = getBatchTableRoot()?.querySelector(".batch-table tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";
  getStoredUserBatches()
    .filter((batch) => normalizeBatchStatus(batch.status) !== "completed")
    .forEach((batch) => {
    addBatchRow(batch, { placement: "append" });
  });
}

function syncBatchMetricsFromRows() {
  const counts = getBatchFilterCounts();
  const totalEggs = readBatchAnalyticsRows()
    .filter((row) => row.status === "in-progress")
    .reduce((sum, row) => sum + row.eggCount, 0);
  setBatchMetricValue("batch-metric-total", counts.all);
  setBatchMetricValue("batch-metric-progress", counts["in-progress"]);
  setBatchMetricValue("batch-metric-eggs", totalEggs);
  setBatchMetricValue("batch-metric-completed", counts.completed);
  setBatchMetricValue("batch-metric-upcoming", counts.upcoming);
}

function getBatchFilterCounts(root = getBatchTableRoot()) {
  const counts = { all: 0, "in-progress": 0, completed: 0, upcoming: 0 };
  getBatchRows(root).forEach((row) => {
    const status = getBatchRowStatus(row);
    counts.all += 1;
    counts[status] = (counts[status] || 0) + 1;
  });
  return counts;
}

function updateBatchFilterMenu(root = getBatchTableRoot()) {
  if (!root) return;
  const actions = root.querySelector(".batch-table-card__actions");
  const activeFilter = normalizeTableFilter(root.dataset.batchFilter || "all", BATCH_FILTER_LABELS);
  const counts = getBatchFilterCounts(root);
  const options = Object.entries(BATCH_FILTER_LABELS).map(([value, label]) => ({
    value,
    label,
    count: counts[value] || 0,
  }));

  buildSmartduckFilterMenu({
    id: "batch-status-filter-menu",
    container: actions,
    options,
    activeValue: activeFilter,
    onSelect: (filter) => applyBatchFilter(filter, { announce: true }),
  });
}

function applyBatchFilter(filter, { announce = false } = {}) {
  const root = getBatchTableRoot();
  if (!root) return;
  const activeFilter = normalizeTableFilter(filter, BATCH_FILTER_LABELS);
  root.dataset.batchFilter = activeFilter;

  let visibleCount = 0;
  getBatchRows(root).forEach((row) => {
    const isVisible = activeFilter === "all" || getBatchRowStatus(row) === activeFilter;
    row.hidden = !isVisible;
    if (isVisible) visibleCount += 1;
  });

  const tableWrap = root.querySelector(".batch-table-wrap");
  const emptyState = ensureTableEmptyState(tableWrap, "batch-filter-empty-state", "No batches match this filter.");
  if (emptyState) emptyState.hidden = visibleCount > 0;

  const button = root.querySelector("[data-smartduck-filter-toggle='batch-status']");
  if (button) {
    const labelNode = button.querySelector("[data-filter-label]");
    if (labelNode) labelNode.textContent = activeFilter === "all" ? "Filter" : `Filter: ${BATCH_FILTER_LABELS[activeFilter]}`;
  }

  updateBatchFilterMenu(root);
  if (announce) showToast("Filter applied", `${BATCH_FILTER_LABELS[activeFilter]} shown.`);
}

function setupBatchFilters() {
  const root = getBatchTableRoot();
  const button = root?.querySelector('[data-ui-action="Filter batches"]');
  if (!root || !button) return;

  button.dataset.uiBound = "true";
  button.dataset.smartduckFilterToggle = "batch-status";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "batch-status-filter-menu");
  const textNode = button.querySelector("span:nth-of-type(2)");
  if (textNode && !textNode.dataset.filterLabel) textNode.dataset.filterLabel = "true";

  if (button.dataset.batchFilterBound !== "true") {
    button.dataset.batchFilterBound = "true";
    button.addEventListener("click", () => toggleSmartduckFilterMenu(button));
  }

  bindSmartduckFilterMenuDismissal();
  applyBatchFilter(root.dataset.batchFilter || "all");
}

function readBatchAnalyticsRows() {
  return getBatchRows()
    .map((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      const startDateText = row.dataset.batchStartDate || cells[1]?.textContent.trim() || "";
      const startDate = parseDateInputValue(startDateText) || new Date(startDateText);
      const eggCount = Number.parseInt(row.dataset.batchEggCount || cells[2]?.textContent.replace(/,/g, "") || "0", 10);
      const progress = Number.parseInt(row.querySelector(".batch-progress-cell span")?.textContent || "0", 10);
      return {
        status: getBatchRowStatus(row),
        startDate,
        eggCount: Number.isFinite(eggCount) ? eggCount : 0,
        progress: Number.isFinite(progress) ? progress : 0,
      };
    })
    .filter((row) => row.eggCount > 0);
}

function buildUserBatchDistributionData(rows = readBatchAnalyticsRows()) {
  const categories = [
    { name: "In Progress", status: "in-progress", color: "#f59e0b" },
    { name: "Completed", status: "completed", color: "#22c55e" },
    { name: "Upcoming", status: "upcoming", color: "#3b82f6" },
  ];
  return categories.map((category) => ({
    name: category.name,
    color: category.color,
    value: rows
      .filter((row) => row.status === category.status)
      .reduce((sum, row) => sum + row.eggCount, 0),
  }));
}

function buildUserBatchPerformanceData(rows = readBatchAnalyticsRows()) {
  const months = userBatchPerformance.map((entry) => ({
    month: entry.month,
    completedValues: [],
    inProgressValues: [],
  }));

  rows.forEach((row) => {
    if (!(row.startDate instanceof Date) || Number.isNaN(row.startDate.getTime())) return;
    const bucket = months[row.startDate.getMonth()];
    if (!bucket) return;

    if (row.status === "completed") {
      bucket.completedValues.push(100);
    } else if (row.status === "in-progress") {
      bucket.inProgressValues.push(Math.min(99, Math.max(1, row.progress || 1)));
    }
  });

  return months.map((bucket) => {
    const average = (values) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    return {
      month: bucket.month,
      completed: bucket.completedValues.length ? average(bucket.completedValues) : 0,
      inProgress: bucket.inProgressValues.length ? average(bucket.inProgressValues) : 0,
    };
  });
}

function updateBatchDistributionLegend(data) {
  const legend = app.pageRoot?.querySelector(".batch-distribution__legend");
  if (!legend) return;

  const total = data.reduce((sum, item) => sum + item.value, 0);
  legend.innerHTML = data.map((item) => `
    <div class="batch-distribution__legend-item">
      <span class="batch-distribution__legend-dot" style="background:${item.color}"></span>
      <span>${escapeHtml(item.name)}</span>
      <strong>${formatPercentValue(item.value, total)} (${formatWholeNumber(item.value)})</strong>
    </div>
  `).join("");
}

function updateUserBatchAnalytics({ rerender = false } = {}) {
  if (state.currentPage !== "batch") return;

  const rows = readBatchAnalyticsRows();
  const distributionData = buildUserBatchDistributionData(rows);
  const performanceData = buildUserBatchPerformanceData(rows);
  const distributionTotal = distributionData.reduce((sum, item) => sum + item.value, 0);
  const distributionEntry = findChartEntry("userBatch", "chart-batch-distribution");
  const performanceEntry = findChartEntry("userBatch", "chart-batch-performance");

  if (distributionEntry) {
    distributionEntry.config.data = distributionData;
    distributionEntry.config.centerLabel = ["Total", formatWholeNumber(distributionTotal), "Eggs"];
  }

  if (performanceEntry) {
    performanceEntry.config.data = performanceData;
  }

  updateBatchDistributionLegend(distributionData);

  if (rerender) {
    renderChartById("chart-batch-distribution");
    renderChartById("chart-batch-performance");
  }
}

function parseDateInputValue(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  date.setHours(12, 0, 0, 0);
  return date;
}

function formatBatchDate(value) {
  const date = parseDateInputValue(value);
  if (!date) return "--";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// The batch table only renders what the current filter/page shows, so reading
// ids from the DOM alone re-issued BATCH-2026-01 once the first batch was
// completed and filtered out of view. Combine the stored records, the admin's
// live cache, and the rendered rows so numbering never repeats an existing id.
// A new batch is always recorded in the year it is created, so the picker is
// pinned to the current calendar year. Back-dating to 2019 or forward-dating to
// 2031 produced records the incubation schedule could never match.
function applyBatchStartDateYearBounds(input) {
  if (!input) return;
  const year = new Date().getFullYear();
  input.min = `${year}-01-01`;
  input.max = `${year}-12-31`;
}

function getKnownBatchIds() {
  const ids = new Set();
  const add = (value) => {
    const id = String(value || "").trim().toLowerCase();
    if (id) ids.add(id);
  };
  getStoredUserBatches().forEach((batch) => add(batch.id));
  normalizeReportList(state.liveBatches).forEach((batch) => add(batch?.id));
  getBatchRows().forEach((row) => add(row.querySelector(".batch-table__strong")?.textContent));
  return ids;
}

function getNextBatchId() {
  const year = new Date().getFullYear();
  let nextNumber = 1;
  getKnownBatchIds().forEach((id) => {
    const match = id.match(/^batch-(\d{4})-(\d+)$/);
    if (!match || Number(match[1]) !== year) return;
    nextNumber = Math.max(nextNumber, Number(match[2]) + 1);
  });
  return `BATCH-${year}-${String(nextNumber).padStart(2, "0")}`;
}

function getBatchStatusMeta(status) {
  const normalized = normalizeTableFilter(status, BATCH_FILTER_LABELS);
  if (normalized === "completed") {
    return { label: "Completed", className: "batch-status-pill--complete", progress: 100, day: "28" };
  }
  if (normalized === "upcoming") {
    return { label: "Upcoming", className: "batch-status-pill--upcoming", progress: 0, day: "-" };
  }
  return { label: "In Progress", className: "batch-status-pill--progress", progress: 4, day: "1" };
}

function deriveBatchProgress(status, startValue, hatchValue) {
  const meta = getBatchStatusMeta(status);
  if (status !== "in-progress") return meta;

  const startDate = parseDateInputValue(startValue);
  const hatchDate = parseDateInputValue(hatchValue);
  if (!startDate || !hatchDate || hatchDate <= startDate) return meta;

  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const oneDayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.max(1, Math.round((hatchDate - startDate) / oneDayMs) + 1);
  const elapsedDays = Math.round((now - startDate) / oneDayMs) + 1;
  const day = Math.min(Math.max(elapsedDays, 1), totalDays);
  const progress = Math.min(99, Math.max(1, Math.round((day / totalDays) * 100)));

  return { ...meta, progress, day: String(day) };
}

function setBatchMetricValue(id, value) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = String(value);
  const card = node.closest(".batch-metric-card");
  const label = card?.querySelector(".dashboard-metric-card__label");
  if (!label || id === "batch-metric-total" || id === "batch-metric-eggs") return;
  label.textContent = value === 1 ? "Batch" : "Batches";
}

function incrementBatchMetric(id) {
  const node = document.getElementById(id);
  if (!node) return;
  const nextValue = Number.parseInt(node.textContent, 10) + 1;
  setBatchMetricValue(id, Number.isFinite(nextValue) ? nextValue : 1);
}

function addBatchRow(batch, { placement = "prepend" } = {}) {
  const tableBody = getBatchTableRoot()?.querySelector(".batch-table tbody");
  if (!tableBody) return null;

  const statusMeta = deriveBatchProgress(batch.status, batch.startDate, batch.expectedHatchDate);
  const row = document.createElement("tr");
  row.dataset.batchId = batch.id;
  row.dataset.batchStartDate = batch.startDate || "";
  row.dataset.batchExpectedHatchDate = batch.expectedHatchDate || "";
  row.dataset.batchStatus = batch.status || "in-progress";
  row.dataset.batchEggCount = String(batch.eggCount || 0);
  row.dataset.batchColor = batch.farmerColor || "blue";
  row.dataset.batchNote = batch.notes || "";
  row.innerHTML = `
    <td class="batch-table__strong"><span>${escapeHtml(batch.id)}</span></td>
    <td>${escapeHtml(formatBatchDate(batch.startDate))}</td>
    <td>${escapeHtml(String(batch.eggCount))}</td>
    <td>${escapeHtml(statusMeta.day)}</td>
    <td><span class="batch-status-pill ${statusMeta.className}">${statusMeta.label}</span></td>
    <td>
      <div class="batch-progress-cell">
        <span>${statusMeta.progress}</span>
        <div class="batch-progress-bar"><span style="width:${statusMeta.progress}%;"></span></div>
      </div>
    </td>
    <td>
      <div class="batch-action-row">
        <button type="button" class="batch-icon-button" data-batch-action="view" aria-label="View batch details">${renderIcon("eye")}</button>
        <button type="button" class="batch-icon-button" data-batch-action="edit" aria-label="Edit initial incubation date">${renderIcon("edit")}</button>
        <button type="button" class="batch-icon-button batch-icon-button--danger" data-batch-action="delete" aria-label="Delete batch">${renderIcon("trash-2")}</button>
      </div>
    </td>
  `;

  if (placement === "append") {
    tableBody.appendChild(row);
  } else {
    tableBody.prepend(row);
  }
  bindBatchRowActions(row);
  return row;
}

function getBatchRowData(row) {
  if (!row) return null;
  const cells = Array.from(row.querySelectorAll("td"));
  const id = row.dataset.batchId || cells[0]?.querySelector("span:nth-of-type(2)")?.textContent.trim() || cells[0]?.textContent.trim() || "Batch";
  const startDate = row.dataset.batchStartDate || "";
  const expectedHatchDate = row.dataset.batchExpectedHatchDate || "";
  const eggCount = Number.parseInt(row.dataset.batchEggCount || cells[2]?.textContent.replace(/,/g, "") || "0", 10);
  const progress = Number.parseInt(row.querySelector(".batch-progress-cell > span")?.textContent || "0", 10);
  const currentDay = cells[3]?.textContent.trim() || "-";
  const statusLabel = row.querySelector(".batch-status-pill")?.textContent.trim() || "In Progress";
  const statusKey = getBatchRowStatus(row);
  const color = row.dataset.batchColor || "blue";
  const note = row.dataset.batchNote || cells[0]?.querySelector("small")?.textContent.trim() || "";
  return {
    row,
    id,
    startDate,
    expectedHatchDate,
    eggCount: Number.isFinite(eggCount) ? eggCount : 0,
    progress: Number.isFinite(progress) ? progress : 0,
    currentDay,
    statusLabel,
    statusKey,
    color,
    note,
  };
}

function closeBatchFloatingPanels(kind = "") {
  const selector = kind ? `.batch-floating-panel--${kind}` : ".batch-floating-panel";
  document.querySelectorAll(selector).forEach((panel) => panel.remove());
}

function createBatchFloatingPanel(kind, title, bodyHtml) {
  closeBatchFloatingPanels(kind);
  const panel = document.createElement("aside");
  panel.className = `batch-floating-panel batch-floating-panel--${kind}`;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.innerHTML = `
    <div class="batch-floating-panel__header">
      <div>
        <h3>${escapeHtml(title)}</h3>
      </div>
      <button type="button" class="batch-floating-panel__close" aria-label="Close panel">${renderIcon("x-circle")}</button>
    </div>
    ${bodyHtml}
  `;
  document.body.appendChild(panel);
  hydrateIcons(panel);
  panel.querySelector(".batch-floating-panel__close")?.addEventListener("click", () => panel.remove());
  return panel;
}

function openBatchDetailsPanel(row) {
  const details = getBatchRowData(row);
  if (!details) return;
  const progressWidth = Math.max(0, Math.min(100, details.progress));
  const panel = createBatchFloatingPanel("details", "Batch Details", `
    <div class="batch-detail-panel">
      <div class="batch-detail-panel__title-row">
        <div>
          <strong>${escapeHtml(details.id)}</strong>
          <small>${escapeHtml(details.note || "Batch record")}</small>
        </div>
        <span class="batch-status-pill ${details.statusKey === "completed" ? "batch-status-pill--complete" : details.statusKey === "upcoming" ? "batch-status-pill--upcoming" : "batch-status-pill--progress"}">${escapeHtml(details.statusLabel)}</span>
      </div>
      <div class="batch-detail-grid">
        <div><small>Start Date</small><strong>${escapeHtml(formatBatchDate(details.startDate))}</strong></div>
        <div><small>Expected Harvest Date</small><strong>${escapeHtml(formatBatchDate(details.expectedHatchDate))}</strong></div>
        <div><small>Egg Count</small><strong>${escapeHtml(String(details.eggCount))}</strong></div>
        <div><small>Current Day</small><strong>${escapeHtml(details.currentDay)}</strong></div>
        <div><small>Progress (Good Eggs)</small><strong>${escapeHtml(String(details.progress))}%</strong><div class="batch-progress-bar"><span style="width:${progressWidth}%;"></span></div></div>
      </div>
      <div class="batch-detail-notes">
        <small>Notes</small>
        <p>${escapeHtml(details.note || "No notes added.")}</p>
      </div>
      <button type="button" class="batch-entry-button batch-entry-button--secondary" data-batch-panel-close>Close</button>
    </div>
  `);
  panel.querySelector("[data-batch-panel-close]")?.addEventListener("click", () => closeBatchFloatingPanels("details"));
}

function openBatchEditPanel(row) {
  const details = getBatchRowData(row);
  if (!details) return;
  const storedBatch = getStoredUserBatches().find((batch) => batch.id.toLowerCase() === details.id.toLowerCase());
  if (!storedBatch) return;
  const panel = createBatchFloatingPanel("edit", "Edit Batch", `
    <form class="batch-entry-form batch-edit-form" data-batch-edit-form>
      <p class="batch-edit-form__copy">Changing the initial incubation date automatically moves the 1st candling, 2nd candling, and final harvest dates.</p>
      <label class="batch-entry-field">
        <span>Batch ID</span>
        <input type="text" value="${escapeHtml(storedBatch.id)}" disabled />
      </label>
      <label class="batch-entry-field">
        <span>Initial Incubation Date</span>
        <input type="date" name="startDate" value="${escapeHtml(storedBatch.startDate)}" required />
      </label>
      <div class="batch-edit-schedule" data-batch-edit-schedule></div>
      <div class="batch-entry-form__actions">
        <button type="button" class="batch-entry-button batch-entry-button--secondary" data-batch-panel-close>Cancel</button>
        <button type="submit" class="batch-entry-button">Save Changes</button>
      </div>
    </form>
  `);
  const form = panel.querySelector("[data-batch-edit-form]");
  const input = form?.elements.startDate;
  const preview = form?.querySelector("[data-batch-edit-schedule]");
  const updatePreview = () => {
    const milestones = buildBatchScheduleMilestones({ ...storedBatch, startDate: input?.value || "" });
    if (preview) preview.innerHTML = milestones.slice(1).map((milestone) => `<div><small>${escapeHtml(milestone.shortTitle)}</small><strong>${escapeHtml(formatBatchDate(milestone.dateValue))}</strong></div>`).join("");
  };
  input?.addEventListener("change", updatePreview);
  updatePreview();
  panel.querySelector("[data-batch-panel-close]")?.addEventListener("click", () => panel.remove());
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const startDate = input?.value || "";
    if (!parseDateInputValue(startDate)) {
      input?.focus();
      return;
    }
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    const expectedHatchDate = toDateInputValue(addDaysToDate(startDate, INCUBATION_TARGET_DAYS - 1));
    try {
      await saveUserBatchRecord({ ...storedBatch, startDate, expectedHatchDate }, { allowUpdate: true });
      renderStoredUserBatchRows();
      refreshBatchPageAfterChange();
      panel.remove();
      showToast("Batch updated", `${storedBatch.id}'s incubation schedule has been recalculated.`);
    } catch (error) {
      submitButton.disabled = false;
      showToast("Update failed", error.message || "The batch could not be updated.");
    }
  });
  window.setTimeout(() => input?.focus(), 0);
}

async function removeStoredUserBatchRecord(id) {
  userBatchState.mutationCount += 1;
  try {
    await requestBackendJson(DELETE_BATCH_ENDPOINT, {
      method: "POST",
      body: {
        username: getAuthenticatedUsername(),
        id,
      },
    });
    notificationState.cache = null;
    invalidateReportsCache();
    void refreshNotificationBadgesFromBackend({ forceRefresh: true, announce: true });
  } finally {
    userBatchState.mutationCount = Math.max(0, userBatchState.mutationCount - 1);
  }
  const nextBatches = getStoredUserBatches().filter((batch) => batch.id.toLowerCase() !== String(id || "").toLowerCase());
  writeStoredUserBatches(nextBatches);
  invalidateUnifiedHistoryCaches();
  publishBatchMutation("delete", id);
}

function refreshBatchPageAfterChange() {
  syncBatchMetricsFromRows();
  renderMonitoringBatchOverview();
  updateUserBatchAnalytics({ rerender: true });
  const root = getBatchTableRoot();
  applyBatchFilter(root?.dataset.batchFilter || "all");
}

function openBatchDeletePanel(row) {
  const details = getBatchRowData(row);
  if (!details) return;
  const panel = createBatchFloatingPanel("delete", "Delete Batch", `
    <div class="batch-delete-panel">
      <p>You are about to delete <strong>${escapeHtml(details.id)}</strong>.</p>
      <p>This action cannot be undone.</p>
      <div class="batch-delete-panel__list">
        <span>This will delete:</span>
        <ul>
          <li>Batch information</li>
          <li>All batch data and progress</li>
          <li>Candling results and records</li>
        </ul>
      </div>
      <div class="batch-delete-panel__actions">
        <button type="button" class="batch-entry-button batch-entry-button--secondary" data-batch-panel-close>Cancel</button>
        <button type="button" class="batch-entry-button batch-entry-button--danger" data-batch-delete-confirm>Delete</button>
      </div>
    </div>
  `);
  panel.querySelector("[data-batch-panel-close]")?.addEventListener("click", () => closeBatchFloatingPanels("delete"));
  panel.querySelector("[data-batch-delete-confirm]")?.addEventListener("click", async () => {
    try {
      await removeStoredUserBatchRecord(details.id);
    } catch (error) {
      showToast("Delete failed", error.message || "Backend was not reachable.");
      return;
    }
    details.row.remove();
    closeBatchFloatingPanels("delete");
    refreshBatchPageAfterChange();
    showToast("Batch deleted", `${details.id} has been removed.`);
  });
}

function bindBatchRowActions(root = app.pageRoot) {
  root?.querySelectorAll("[data-batch-action]").forEach((button) => {
    if (button.dataset.batchActionBound === "true") return;
    button.dataset.batchActionBound = "true";
    button.dataset.uiBound = "true";
    button.addEventListener("click", () => {
      const row = button.closest("tr");
      if (button.dataset.batchAction === "delete") {
        openBatchDeletePanel(row);
        return;
      }
      if (button.dataset.batchAction === "edit") {
        openBatchEditPanel(row);
        return;
      }
      openBatchDetailsPanel(row);
    });
  });
}

function updateBatchMetricsAfterCreate(status) {
  incrementBatchMetric("batch-metric-total");
  if (status === "completed") {
    incrementBatchMetric("batch-metric-completed");
  } else if (status === "upcoming") {
    incrementBatchMetric("batch-metric-upcoming");
  } else {
    incrementBatchMetric("batch-metric-progress");
  }
}

function closeBatchEntryModal() {
  if (!app.batchEntryModal) return;
  app.batchEntryModal.hidden = true;
  app.batchEntryModal.setAttribute("aria-hidden", "true");
  app.batchEntryForm?.reset();
  app.batchEntryForm?.querySelectorAll(".is-invalid").forEach((field) => field.classList.remove("is-invalid"));
  syncModalOpenState();
}

function syncBatchEntryCapacity(form = app.batchEntryForm) {
  if (!form) return getAvailableIncubatorCapacity();
  const occupiedEggs = getActiveIncubatorEggCount();
  const availableSlots = Math.max(0, INCUBATOR_EGG_CAPACITY - occupiedEggs);
  const eggCountInput = form.elements.eggCount;
  const capacityNode = form.querySelector("[data-batch-entry-capacity]");

  if (eggCountInput) {
    eggCountInput.max = String(availableSlots);
    eggCountInput.placeholder = availableSlots > 0 ? `Enter 1-${availableSlots}` : "Incubator is full";
  }
  if (capacityNode) {
    capacityNode.textContent = occupiedEggs > INCUBATOR_EGG_CAPACITY
      ? `${occupiedEggs} eggs are recorded. Capacity is exceeded by ${occupiedEggs - INCUBATOR_EGG_CAPACITY}.`
      : `${occupiedEggs} / ${INCUBATOR_EGG_CAPACITY} slots occupied · ${availableSlots} available`;
    capacityNode.classList.toggle("is-full", availableSlots <= 0);
  }
  return availableSlots;
}

function syncBatchHarvestDate(form = app.batchEntryForm) {
  if (!form) return;
  const startValue = form.elements.startDate?.value || "";
  const expectedHatchInput = form.elements.expectedHatchDate;
  if (!expectedHatchInput) return;
  const harvestDate = startValue ? addDaysToDate(startValue, 17) : null;
  expectedHatchInput.value = harvestDate ? toDateInputValue(harvestDate) : "";
}

function ensureBatchEntryModal() {
  if (app.batchEntryModal) return app.batchEntryModal;

  const wrapper = document.createElement("div");
  wrapper.id = "batch-entry-modal";
  wrapper.className = "batch-entry-modal";
  wrapper.hidden = true;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = `
    <button class="batch-entry-modal__backdrop" type="button" tabindex="-1" aria-label="Close new batch form"></button>
    <section class="batch-entry-modal__card" role="dialog" aria-modal="true" aria-labelledby="batch-entry-title">
      <div class="batch-entry-modal__topbar">
        <div>
          <h2 id="batch-entry-title" class="batch-entry-modal__title">New Batch</h2>
          <p class="batch-entry-modal__copy">Enter the details to create a new batch record.</p>
        </div>
        <button class="batch-entry-modal__close" type="button" aria-label="Close new batch form">${renderIcon("x-circle")}</button>
      </div>
      <form class="batch-entry-form" novalidate>
        <label class="batch-entry-field">
          <span>Batch ID <strong>*</strong></span>
          <input class="batch-entry-input" name="batchId" type="text" placeholder="Enter batch ID" required />
        </label>
        <label class="batch-entry-field">
          <span>Start Date <strong>*</strong></span>
          <input class="batch-entry-input" name="startDate" type="date" required />
        </label>
        <label class="batch-entry-field">
          <span>Egg Count <strong>*</strong></span>
          <input class="batch-entry-input" name="eggCount" type="number" min="1" max="${INCUBATOR_EGG_CAPACITY}" step="1" placeholder="Enter egg count" aria-describedby="batch-entry-capacity" required />
          <small id="batch-entry-capacity" class="batch-entry-capacity" data-batch-entry-capacity></small>
        </label>
        <label class="batch-entry-field">
          <span>Expected Harvest Date (Day 18) <strong>*</strong></span>
          <input class="batch-entry-input" name="expectedHatchDate" type="date" readonly aria-readonly="true" required />
        </label>
        <fieldset class="batch-entry-field batch-entry-field--colors">
          <legend>Farmer (Batch Color)</legend>
          <label><input type="checkbox" name="farmerColor" value="blue" checked /><span class="batch-color-dot batch-color-dot--blue"></span>Blue</label>
          <label><input type="checkbox" name="farmerColor" value="yellow" /><span class="batch-color-dot batch-color-dot--yellow"></span>Yellow</label>
          <label><input type="checkbox" name="farmerColor" value="orange" /><span class="batch-color-dot batch-color-dot--orange"></span>Orange</label>
          <label><input type="checkbox" name="farmerColor" value="red" /><span class="batch-color-dot batch-color-dot--red"></span>Red</label>
        </fieldset>
        <label class="batch-entry-field batch-entry-field--wide">
          <span>Notes (Optional)</span>
          <textarea class="batch-entry-input batch-entry-textarea" name="notes" placeholder="Enter any additional notes"></textarea>
        </label>
        <div class="batch-entry-form__actions">
          <button class="batch-entry-button batch-entry-button--secondary" type="button" data-batch-entry-cancel>Cancel</button>
          <button class="batch-entry-button batch-entry-button--primary" type="submit">
            ${renderIcon("check-circle", "icon--sm")}
            <span>Save Batch</span>
          </button>
        </div>
      </form>
    </section>
  `;

  document.body.appendChild(wrapper);
  app.batchEntryModal = wrapper;
  app.batchEntryForm = wrapper.querySelector(".batch-entry-form");

  wrapper.querySelector(".batch-entry-modal__backdrop")?.addEventListener("click", closeBatchEntryModal);
  wrapper.querySelector(".batch-entry-modal__close")?.addEventListener("click", closeBatchEntryModal);
  wrapper.querySelector("[data-batch-entry-cancel]")?.addEventListener("click", closeBatchEntryModal);
  app.batchEntryForm?.addEventListener("submit", handleBatchEntrySubmit);
  app.batchEntryForm?.elements.startDate?.addEventListener("change", () => syncBatchHarvestDate(app.batchEntryForm));
  app.batchEntryForm?.elements.eggCount?.addEventListener("input", (event) => {
    const availableSlots = syncBatchEntryCapacity(app.batchEntryForm);
    const maximum = Math.min(INCUBATOR_EGG_CAPACITY, availableSlots);
    let value = Number.parseInt(event.currentTarget.value || "", 10);
    if (Number.isFinite(value) && value > maximum) {
      event.currentTarget.value = String(maximum);
      value = maximum;
    }
    if (Number.isFinite(value) && value > 0 && value <= availableSlots) {
      event.currentTarget.classList.remove("is-invalid");
    }
  });
  const farmerColorCheckboxes = [...(app.batchEntryForm?.querySelectorAll('input[type="checkbox"][name="farmerColor"]') || [])];
  farmerColorCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (!checkbox.checked) {
        checkbox.checked = true;
        return;
      }
      farmerColorCheckboxes.forEach((otherCheckbox) => {
        if (otherCheckbox !== checkbox) otherCheckbox.checked = false;
      });
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app.batchEntryModal && !app.batchEntryModal.hidden) {
      event.preventDefault();
      closeBatchEntryModal();
    }
  });

  return wrapper;
}

function openBatchEntryModal() {
  const modal = ensureBatchEntryModal();
  const form = app.batchEntryForm;
  if (!form) return;

  form.reset();
  form.querySelectorAll(".is-invalid").forEach((field) => field.classList.remove("is-invalid"));
  syncBatchHarvestDate(form);
  const availableSlots = syncBatchEntryCapacity(form);
  if (availableSlots <= 0) {
    const occupiedEggs = getActiveIncubatorEggCount();
    const message = occupiedEggs > INCUBATOR_EGG_CAPACITY
      ? `${occupiedEggs} eggs are currently recorded, which is ${occupiedEggs - INCUBATOR_EGG_CAPACITY} over the ${INCUBATOR_EGG_CAPACITY}-slot limit. Remove eggs before creating another batch.`
      : `All ${INCUBATOR_EGG_CAPACITY} incubator slots are occupied. Remove eggs before creating another batch.`;
    void showWarningCard("Incubator full", message);
    return;
  }
  const batchIdInput = form.elements.batchId;
  if (batchIdInput) batchIdInput.value = getNextBatchId();
  applyBatchStartDateYearBounds(form.elements.startDate);

  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  syncModalOpenState();
  window.setTimeout(() => batchIdInput?.focus(), 0);
}

async function handleBatchEntrySubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  syncBatchHarvestDate(form);
  const fields = {
    id: form.elements.batchId?.value.trim() || "",
    startDate: form.elements.startDate?.value || "",
    eggCount: Number.parseInt(form.elements.eggCount?.value || "", 10),
    expectedHatchDate: form.elements.expectedHatchDate?.value || "",
    status: "in-progress",
    farmerColor: form.querySelector('input[name="farmerColor"]:checked')?.value || "blue",
    notes: form.elements.notes?.value.trim() || "",
  };

  form.querySelectorAll(".is-invalid").forEach((field) => field.classList.remove("is-invalid"));
  const requiredFields = [
    ["batchId", fields.id],
    ["startDate", fields.startDate],
    ["eggCount", Number.isFinite(fields.eggCount) && fields.eggCount > 0],
    ["expectedHatchDate", fields.expectedHatchDate],
  ];
  const missingField = requiredFields.find(([, value]) => !value);
  if (missingField) {
    const input = form.elements[missingField[0]];
    input?.classList.add("is-invalid");
    input?.focus();
    await showWarningCard("Batch details required", "Complete all required fields before saving the new batch.", input);
    return;
  }

  const availableSlots = syncBatchEntryCapacity(form);
  if (availableSlots <= 0 || fields.eggCount > INCUBATOR_EGG_CAPACITY || fields.eggCount > availableSlots) {
    const input = form.elements.eggCount;
    input?.classList.add("is-invalid");
    input?.focus();
    const message = availableSlots <= 0
      ? `All ${INCUBATOR_EGG_CAPACITY} incubator slots are occupied. Remove eggs before creating another batch.`
      : `Only ${availableSlots} incubator slot${availableSlots === 1 ? " is" : "s are"} available. Reduce the egg count to ${availableSlots} or fewer.`;
    await showWarningCard("Incubator capacity exceeded", message, input);
    return;
  }

  const existingId = getKnownBatchIds().has(fields.id.toLowerCase());
  if (existingId) {
    const input = form.elements.batchId;
    input?.classList.add("is-invalid");
    input?.focus();
    await showWarningCard("Batch ID already exists", "Use a unique Batch ID for this new batch record.", input);
    return;
  }

  const startDate = parseDateInputValue(fields.startDate);
  const hatchDate = parseDateInputValue(fields.expectedHatchDate);
  if (!startDate || !hatchDate || hatchDate <= startDate) {
    const input = form.elements.expectedHatchDate;
    input?.classList.add("is-invalid");
    input?.focus();
    await showWarningCard("Invalid hatch date", "Expected hatch date must be later than the start date.", input);
    return;
  }

  // min/max on the picker is advisory only while the form is novalidate, so the
  // typed value is re-checked here before the record is stored.
  const currentYear = new Date().getFullYear();
  if (startDate.getFullYear() !== currentYear) {
    const input = form.elements.startDate;
    input?.classList.add("is-invalid");
    input?.focus();
    await showWarningCard("Start date out of range", `New batches must start within ${currentYear}. Choose a start date between January 1 and December 31, ${currentYear}.`, input);
    return;
  }

  let savedBatch = { ...fields, createdAt: Date.now() };
  try {
    await saveUserBatchRecord(savedBatch);
    savedBatch = getStoredUserBatches().find((batch) => batch.id.toLowerCase() === fields.id.toLowerCase()) || savedBatch;
  } catch (error) {
    await showWarningCard("Batch was not saved", error.message || "The backend could not record this batch.");
    return;
  }
  const row = addBatchRow(savedBatch);
  if (!row) return;
  syncBatchMetricsFromRows();
  updateUserBatchAnalytics({ rerender: true });
  const root = getBatchTableRoot();
  applyBatchFilter(root?.dataset.batchFilter || "all");
  closeBatchEntryModal();
  showToast("Batch created", `${fields.id} has been added to the batch list.`);
}

function renderEmptyScheduleOverview(userName, userRole, userInitials) {
  state.userSchedule.startDate = "";
  state.userSchedule.candlingOneDate = "";
  state.userSchedule.candlingTwoDate = "";
  state.userSchedule.harvestDate = "";
  state.userSchedule.currentDay = 0;
  state.userSchedule.targetDays = 0;
  state.userSchedule.eggCount = 0;
  state.userSchedule.saved = false;

  const textMap = [
    ["schedule-user-name", userName],
    ["schedule-user-role", userRole],
    ["schedule-user-avatar", userInitials],
    ["schedule-current-batch", "No active batch"],
    ["schedule-current-status", "No schedule"],
    ["schedule-incubation-day", "0"],
    ["schedule-incubation-day-label", "Active batches"],
    ["schedule-eggs-count", "0"],
    ["schedule-next-turning", "--"],
    ["schedule-next-turning-label", "--"],
    ["schedule-timeline-title", "Incubation Schedules"],
    ["schedule-candling-agenda-title", "No Candling Scheduled"],
    ["schedule-next-candling", "--"],
    ["schedule-next-cleaning", "--"],
    ["schedule-progress-title", "Day 0 of 0"],
    ["schedule-progress-date", "--"],
    ["schedule-progress-remaining", "--"],
    ["schedule-next-important", "--"],
    ["schedule-next-important-meta", "--"],
  ];

  textMap.forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  });

  renderScheduleCalendar([]);
  const range = app.pageRoot?.querySelector("[data-schedule-date-range]");
  if (range) {
    range.textContent = "";
    range.hidden = true;
  }
  const success = app.pageRoot?.querySelector("[data-schedule-success]");
  if (success) success.hidden = true;
  const progressFill = document.getElementById("schedule-progress-fill");
  if (progressFill) progressFill.style.width = "0%";
  app.pageRoot?.querySelectorAll("[data-schedule-summary-day]").forEach((item) => {
    item.classList.remove("is-complete");
    const small = item.querySelector("small");
    const stateNode = item.querySelector(".schedule-summary__state");
    if (small) small.textContent = "--";
    if (stateNode) stateNode.innerHTML = "";
  });
  hydrateIcons(app.pageRoot);
  bindSchedulePageInteractions();
}

function describeScheduleDateDistance(dateValue) {
  const date = parseDateInputValue(dateValue);
  if (!date) return "--";
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Math.round((date - today) / (24 * 60 * 60 * 1000));
  if (days === 0) return "Due today";
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`;
  return `In ${days} day${days === 1 ? "" : "s"}`;
}

function autoOpenDueScheduleAction(batches) {
  const todayValue = toDateInputValue(new Date());
  const dueMilestones = getScheduleMilestonesForDate(todayValue, batches)
    .filter((milestone) => [7, 14, 18].includes(milestone.day));
  if (!dueMilestones.length || state.scheduleAutoOpenedDates.has(todayValue)) return;
  state.scheduleAutoOpenedDates.add(todayValue);
  window.setTimeout(() => {
    const modal = document.getElementById("schedule-day-modal");
    if (modal && !modal.hidden) return;
    openScheduleDateModal(todayValue, { selectedBatchId: dueMilestones[0].batchId });
  }, 0);
}

async function hydrateScheduleOverview() {
  if (state.currentPage !== "candling") return;

  try {
    await loadUserBatchesFromBackend();
  } catch {
    // Keep the current local batch cache if the backend is temporarily unavailable.
  }

  const userName = getAuthenticatedUser();
  const userRole = getRoleLabel();
  const userInitials = initials(userName);
  const activeBatches = getScheduleActiveBatches();
  if (!activeBatches.length) {
    renderEmptyScheduleOverview(userName, userRole, userInitials);
    return;
  }
  const selectedBatch = getSelectedScheduleBatch(activeBatches);
  const activeBatch = getScheduleSnapshot(selectedBatch);
  const currentDate = activeBatch.currentDay > 0
    ? addDaysToDate(activeBatch.startDate, activeBatch.currentDay - 1)
    : parseDateInputValue(activeBatch.startDate);
  const progress = Math.round((activeBatch.currentDay / INCUBATION_TARGET_DAYS) * 1000) / 10;
  const daysRemaining = Math.max(INCUBATION_TARGET_DAYS - activeBatch.currentDay, 0);
  const totalEggs = activeBatches.reduce((sum, batch) => sum + Number(batch.eggCount || 0), 0);
  const pendingMilestones = getUncompletedScheduleMilestones(activeBatches)
    .sort((a, b) => a.dateValue.localeCompare(b.dateValue) || a.day - b.day || a.batchId.localeCompare(b.batchId));
  const nextMilestone = pendingMilestones[0] || null;
  const textMap = [
    ["schedule-user-name", userName],
    ["schedule-user-role", userRole],
    ["schedule-user-avatar", userInitials],
    ["schedule-current-batch", activeBatch.id],
    ["schedule-current-status", activeBatch.statusLabel],
    ["schedule-incubation-day", String(activeBatches.length)],
    ["schedule-incubation-day-label", activeBatches.length === 1 ? "Active batch" : "Active batches"],
    ["schedule-eggs-count", String(totalEggs)],
    ["schedule-next-turning", nextMilestone ? formatBatchDate(nextMilestone.dateValue) : "--"],
    ["schedule-next-turning-label", nextMilestone ? `${nextMilestone.shortTitle} · ${nextMilestone.batchId}` : "All schedules complete"],
    ["schedule-timeline-title", "Incubation Schedules"],
    ["schedule-candling-agenda-title", `Candling Day ${activeBatch.currentDay}`],
    ["schedule-next-candling", nextMilestone ? `${nextMilestone.batchId} · Day ${nextMilestone.day}` : "--"],
    ["schedule-next-cleaning", `After Day ${INCUBATION_TARGET_DAYS}`],
    ["schedule-progress-title", `${activeBatch.id} · Day ${activeBatch.currentDay} of ${INCUBATION_TARGET_DAYS}`],
    ["schedule-progress-date", `${formatBatchDate(toDateInputValue(currentDate))} ${currentDate ? `(${currentDate.toLocaleDateString("en-US", { weekday: "long" })})` : ""}`],
    ["schedule-progress-remaining", `${daysRemaining} days remaining`],
    ["schedule-next-important", nextMilestone ? `${nextMilestone.title} · ${nextMilestone.batchId}` : "All key schedules complete"],
    ["schedule-next-important-meta", nextMilestone ? `${describeScheduleDateDistance(nextMilestone.dateValue)} · ${formatBatchDate(nextMilestone.dateValue)}` : "--"],
  ];

  textMap.forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  });

  renderScheduleCalendar(activeBatches);
  renderScheduleAgenda(activeBatch);
  const range = app.pageRoot?.querySelector("[data-schedule-date-range]");
  if (range) {
    range.textContent = "";
    range.hidden = true;
  }
  const success = app.pageRoot?.querySelector("[data-schedule-success]");
  if (success) success.hidden = true;
  const progressFill = document.getElementById("schedule-progress-fill");
  if (progressFill) progressFill.style.width = `${progress}%`;
  const selectedMilestones = buildBatchScheduleMilestones(activeBatch);
  const completedDays = getBatchCompletedScheduleDays(activeBatch);
  app.pageRoot?.querySelectorAll("[data-schedule-summary-day]").forEach((item) => {
    const day = Number(item.dataset.scheduleSummaryDay || "0");
    const stateNode = item.querySelector(".schedule-summary__state");
    const small = item.querySelector("small");
    const summaryMilestone = selectedMilestones.find((milestone) => milestone.day === day);
    if (small && summaryMilestone) {
      small.textContent = `${activeBatch.id} · ${formatBatchDate(summaryMilestone.dateValue)} · ${completedDays.has(day) ? "Completed" : describeScheduleDateDistance(summaryMilestone.dateValue)}`;
    }
    const isDone = completedDays.has(day);
    item.classList.toggle("is-complete", isDone);
    if (stateNode) {
      stateNode.innerHTML = isDone ? renderIcon("check-circle") : "";
    }
  });
  hydrateIcons(app.pageRoot);
  bindSchedulePageInteractions();
  autoOpenDueScheduleAction(activeBatches);
}

function hydrateNotificationsOverview() {
  if (state.currentPage !== "notifications") return;

  const userName = getAuthenticatedUser();
  const userRole = getRoleLabel();
  const userInitials = initials(userName);
  const textMap = [
    ["notifications-user-name", userName],
    ["notifications-user-role", userRole],
    ["notifications-user-avatar", userInitials],
  ];

  textMap.forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  });

  setupNotificationsPanel();
  setupAdminAlertsFilters();
}

const NOTIFICATION_FILTER_LABELS = {
  all: "All",
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};
const NOTIFICATION_READ_STORAGE_KEY = "smartduck.notificationReadIds.v1";
const notificationState = {
  cache: null,
  readyPromise: null,
  trigger: null,
  pollTimer: null,
  knownIds: null,
};

function closeNotificationModal({ restoreFocus = true } = {}) {
  if (!app.notificationModal || app.notificationModal.hidden) return;
  app.notificationModal.hidden = true;
  app.notificationModal.setAttribute("aria-hidden", "true");
  closeNotificationsFilterMenu(app.notificationModal.querySelector(".notifications-feed-card"));
  syncModalOpenState();
  if (restoreFocus && notificationState.trigger instanceof HTMLElement) {
    notificationState.trigger.focus();
  }
  notificationState.trigger = null;
}

function ensureNotificationModal() {
  if (app.notificationModal) return app.notificationModal;

  const wrapper = document.createElement("div");
  wrapper.id = "notification-center-modal";
  wrapper.className = "notification-center-modal";
  wrapper.hidden = true;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = `
    <button class="notification-center-modal__backdrop" type="button" tabindex="-1" aria-label="Close notifications"></button>
    <section class="notification-center-modal__card" role="dialog" aria-modal="true" aria-labelledby="notification-center-title">
      <header class="notification-center-modal__header">
        <div class="notification-center-modal__heading">
          <span class="notification-center-modal__icon">${renderIcon("bell")}</span>
          <div>
            <p class="notification-center-modal__eyebrow">SmartDuck Center</p>
            <h2 id="notification-center-title" class="notification-center-modal__title">Notifications</h2>
          </div>
        </div>
        <div class="notification-center-modal__header-actions">
          <span class="notification-center-modal__count" aria-live="polite">0 unread</span>
          <button class="notification-center-modal__close" type="button" aria-label="Close notifications">${renderIcon("x-circle")}</button>
        </div>
      </header>
      <section class="notifications-feed-card notification-center-modal__feed" data-notification-filter="all">
        <div class="notifications-feed__toolbar">
          <div class="notifications-filter-chips" role="group" aria-label="Notification filters">
            <button type="button" class="notifications-chip is-active" data-notification-filter="all" data-ui-action="Filter all notifications" aria-pressed="true"><span>All</span><strong>0</strong></button>
            <button type="button" class="notifications-chip notifications-chip--critical" data-notification-filter="critical" data-ui-action="Filter critical notifications" aria-pressed="false"><span>Critical</span><strong>0</strong></button>
            <button type="button" class="notifications-chip notifications-chip--warning" data-notification-filter="warning" data-ui-action="Filter warning notifications" aria-pressed="false"><span>Warning</span><strong>0</strong></button>
            <button type="button" class="notifications-chip notifications-chip--info" data-notification-filter="info" data-ui-action="Filter info notifications" aria-pressed="false"><span>Info</span><strong>0</strong></button>
          </div>
          <div class="notifications-feed__actions">
            <button type="button" class="notifications-action-button" data-notifications-mark-read data-ui-action="Mark all notifications as read">
              <span data-icon="check-circle"></span>
              <span>Mark all read</span>
            </button>
            <button type="button" class="notifications-action-button notifications-action-button--delete" data-notifications-delete-all data-ui-action="Delete all notifications">
              <span data-icon="trash"></span>
              <span>Delete All</span>
            </button>
          </div>
        </div>
        <div class="notifications-feed-list"></div>
        <div class="notifications-empty-state" hidden>No notifications match this filter.</div>
      </section>
    </section>
  `;
  document.body.appendChild(wrapper);
  app.notificationModal = wrapper;
  hydrateIcons(wrapper);

  wrapper.querySelector(".notification-center-modal__backdrop")?.addEventListener("click", () => closeNotificationModal());
  wrapper.querySelector(".notification-center-modal__close")?.addEventListener("click", () => closeNotificationModal());
  wrapper.querySelector(".notification-center-modal__card")?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-ui-action]") : null;
    if (!button) return;
    handleNotificationsAction(button, button.dataset.uiAction || "");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app.notificationModal && !app.notificationModal.hidden) {
      event.preventDefault();
      closeNotificationModal();
    }
  });
  return wrapper;
}

async function openNotificationModal(trigger = document.activeElement) {
  const modal = ensureNotificationModal();
  notificationState.trigger = trigger instanceof HTMLElement ? trigger : null;
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  syncModalOpenState();
  modal.querySelector(".notification-center-modal__close")?.focus();
  await setupNotificationsPanel({ forceRefresh: true });
}

function normalizeNotificationFilter(filter) {
  const value = String(filter || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_FILTER_LABELS, value) ? value : "all";
}

function getNotificationReadStorageKey() {
  const username = getAuthenticatedUsername().trim().toLowerCase() || "anonymous";
  return `${NOTIFICATION_READ_STORAGE_KEY}.${username}`;
}

function getNotificationsFeedRoot() {
  const modalRoot = app.notificationModal?.querySelector(".notifications-feed-card");
  return modalRoot || app.pageRoot?.querySelector(".notifications-feed-card") || null;
}

function getNotificationItems(root = getNotificationsFeedRoot()) {
  return Array.from(root?.querySelectorAll(".notifications-feed-item") || []);
}

function getNotificationType(item) {
  if (item.classList.contains("notifications-feed-item--critical")) return "critical";
  if (item.classList.contains("notifications-feed-item--warning")) return "warning";
  if (item.classList.contains("notifications-feed-item--info")) return "info";
  return "info";
}

function getNotificationTitle(item) {
  return item.querySelector(".notifications-feed-item__title")?.textContent.replace(/\s+/g, " ").trim() || "Notification";
}

function getNotificationId(item) {
  if (item.dataset.notificationId) return item.dataset.notificationId;
  return getNotificationTitle(item)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getStoredReadNotificationIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(getNotificationReadStorageKey()) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function saveStoredReadNotificationIds(readIds) {
  try {
    localStorage.setItem(getNotificationReadStorageKey(), JSON.stringify(Array.from(readIds)));
  } catch {
    // Local storage can be unavailable in restricted browser contexts; UI state still updates in memory.
  }
}

async function loadNotificationsFromBackend(forceRefresh = false) {
  if (!forceRefresh && Array.isArray(notificationState.cache)) return notificationState.cache.map((item) => ({ ...item }));
  if (!forceRefresh && notificationState.readyPromise) return notificationState.readyPromise;

  notificationState.readyPromise = (async () => {
    const payload = await requestBackendJson(`${NOTIFICATIONS_ENDPOINT}&username=${encodeURIComponent(getAuthenticatedUsername())}`);
    const notifications = normalizeAccounts(payload.notifications).map((notification) => ({ ...notification }));
    notificationState.cache = notifications;
    notificationState.readyPromise = null;
    return notifications.map((item) => ({ ...item }));
  })().catch((error) => {
    notificationState.readyPromise = null;
    throw error;
  });
  return notificationState.readyPromise;
}

function getNotificationIconName(notification) {
  const text = `${notification?.title || ""} ${notification?.component || ""}`.toLowerCase();
  if (text.includes("humidity")) return "droplets";
  if (text.includes("turner") || text.includes("rotate")) return "rotate-cw";
  if (text.includes("power") || text.includes("bulb")) return "lightbulb";
  return notification?.severity === "critical" ? "alert-triangle" : "bell";
}

function formatNotificationTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderNotificationsFromRecords(notifications, root = getNotificationsFeedRoot()) {
  const list = root?.querySelector(".notifications-feed-list");
  if (!list) return;
  list.innerHTML = notifications.map((notification) => {
    const severity = normalizeNotificationFilter(notification.severity || "info");
    const title = notification.title || "SmartDuck notification";
    const message = notification.message || "";
    const id = notification.id || title;
    return `
      <article class="notifications-feed-item notifications-feed-item--${escapeHtml(severity)}" data-notification-id="${escapeHtml(id)}" data-notification-read="${notification.read ? "true" : "false"}">
        <div class="notifications-feed-item__icon"><span data-icon="${escapeHtml(getNotificationIconName(notification))}" data-icon-class="icon--lg"></span></div>
        <div class="notifications-feed-item__content">
          <div class="notifications-feed-item__row">
            <h4 class="notifications-feed-item__title"><span class="notifications-feed-item__dot"></span>${escapeHtml(title)}</h4>
            <span class="notifications-feed-item__time">${escapeHtml(formatNotificationTime(notification.createdAt))}</span>
          </div>
          <p class="notifications-feed-item__copy">${escapeHtml(message)}</p>
        </div>
        <div class="notifications-feed-item__actions">
          <button type="button" class="notifications-feed-item__delete" data-notifications-delete data-ui-action="Delete notification" aria-label="Delete ${escapeHtml(title)}"><span data-icon="trash"></span></button>
        </div>
      </article>
    `;
  }).join("");
  hydrateIcons(list);
}

async function persistNotificationReadIds(ids) {
  const normalizedIds = Array.from(ids).filter(Boolean);
  if (!normalizedIds.length) return;
  await requestBackendJson(NOTIFICATION_READ_ENDPOINT, {
    method: "POST",
    body: {
      username: getAuthenticatedUsername(),
      ids: normalizedIds,
    },
  });
}

function isNotificationRead(item) {
  const title = item.querySelector(".notifications-feed-item__title");
  const dot = item.querySelector(".notifications-feed-item__dot");
  return (
    item.dataset.notificationRead === "true" ||
    item.classList.contains("is-read") ||
    title?.classList.contains("notifications-feed-item__title--muted") ||
    dot?.classList.contains("notifications-feed-item__dot--muted")
  );
}

function setNotificationReadState(item, read) {
  const isRead = Boolean(read);
  const title = item.querySelector(".notifications-feed-item__title");
  const dot = item.querySelector(".notifications-feed-item__dot");

  item.dataset.notificationRead = isRead ? "true" : "false";
  item.classList.toggle("is-read", isRead);
  title?.classList.toggle("notifications-feed-item__title--muted", isRead);
  dot?.classList.toggle("notifications-feed-item__dot--muted", isRead);
  item.setAttribute("aria-label", `${getNotificationTitle(item)} ${isRead ? "read" : "unread"}`);
}

function getNotificationCounts(root = getNotificationsFeedRoot()) {
  const counts = { all: 0, critical: 0, warning: 0, info: 0, unread: 0 };
  getNotificationItems(root).forEach((item) => {
    const type = getNotificationType(item);
    counts.all += 1;
    counts[type] = (counts[type] || 0) + 1;
    if (!isNotificationRead(item)) counts.unread += 1;
  });
  return counts;
}

function updateNotificationBadges(unreadCount) {
  const badges = [
    // Mobile moves the same alert button into .mobile-topbar__actions, outside
    // app.pageRoot. Search the live document so its badge keeps updating.
    ...Array.from(document.querySelectorAll(".dashboard-alert-button__badge")),
    ...Array.from(app.sidebar?.querySelectorAll(".user-nav-button__badge, .admin-nav-button__badge") || []),
  ];

  badges.forEach((badge) => {
    if (unreadCount > 0) {
      badge.hidden = false;
      badge.textContent = String(unreadCount);
      badge.setAttribute("aria-hidden", "false");
    } else {
      badge.textContent = "";
      badge.hidden = true;
      badge.setAttribute("aria-hidden", "true");
    }
  });
  const modalCount = app.notificationModal?.querySelector(".notification-center-modal__count");
  if (modalCount) modalCount.textContent = `${unreadCount} unread`;
}

async function refreshNotificationBadgesFromBackend({ forceRefresh = false, announce = false } = {}) {
  if (!isAuthenticated()) {
    updateNotificationBadges(0);
    return;
  }

  try {
    const notifications = await loadNotificationsFromBackend(forceRefresh);
    const unreadCount = notifications.filter((notification) => notification.read !== true).length;
    updateNotificationBadges(unreadCount);
    const nextIds = new Set(notifications.map((notification) => String(notification.id || "")).filter(Boolean));
    if (announce && notificationState.knownIds instanceof Set) {
      const latest = notifications.find((notification) => (
        notification.read !== true
        && notification.id
        && !notificationState.knownIds.has(String(notification.id))
      ));
      if (latest) {
        showToast(latest.title || "SmartDuck update", latest.message || "A new hardware event was recorded.");
      }
    }
    notificationState.knownIds = nextIds;
  } catch {
    // Keep the last known badge count during a temporary device/backend outage.
  }
}

function syncNotificationUpdates() {
  if (!isAuthenticated()) {
    if (notificationState.pollTimer) window.clearInterval(notificationState.pollTimer);
    notificationState.pollTimer = null;
    notificationState.knownIds = null;
    return;
  }

  void refreshNotificationBadgesFromBackend({ forceRefresh: true, announce: false });
  if (notificationState.pollTimer) return;
  notificationState.pollTimer = window.setInterval(() => {
    if (!document.hidden) void refreshNotificationBadgesFromBackend({ forceRefresh: true, announce: true });
  }, NOTIFICATION_POLL_INTERVAL_MS);
}

function updateNotificationCounts(root = getNotificationsFeedRoot()) {
  if (!root) return { all: 0, critical: 0, warning: 0, info: 0, unread: 0 };
  const counts = getNotificationCounts(root);

  root.querySelectorAll("[data-notification-filter]").forEach((button) => {
    const filter = normalizeNotificationFilter(button.dataset.notificationFilter);
    const countNode = button.querySelector("strong");
    if (countNode) countNode.textContent = String(counts[filter] || 0);
  });

  const markAllButton = root.querySelector("[data-notifications-mark-read]");
  if (markAllButton) {
    const hasUnread = counts.unread > 0;
    markAllButton.disabled = !hasUnread;
    markAllButton.setAttribute("aria-disabled", String(!hasUnread));
  }

  const deleteAllButton = root.querySelector("[data-notifications-delete-all]");
  if (deleteAllButton) {
    const hasNotifications = counts.all > 0;
    deleteAllButton.disabled = !hasNotifications;
    deleteAllButton.setAttribute("aria-disabled", String(!hasNotifications));
  }

  updateNotificationBadges(counts.unread);
  return counts;
}

function setNotificationFilter(filter, root = getNotificationsFeedRoot()) {
  if (!root) return;
  const activeFilter = normalizeNotificationFilter(filter);
  let visibleCount = 0;

  root.dataset.notificationFilter = activeFilter;
  getNotificationItems(root).forEach((item) => {
    const isVisible = activeFilter === "all" || getNotificationType(item) === activeFilter;
    item.hidden = !isVisible;
    item.classList.toggle("is-filter-hidden", !isVisible);
    item.setAttribute("aria-hidden", String(!isVisible));
    if (isVisible) visibleCount += 1;
  });

  root.querySelectorAll("[data-notification-filter]").forEach((button) => {
    const isActive = normalizeNotificationFilter(button.dataset.notificationFilter) === activeFilter;
    button.classList.toggle("is-active", isActive);
    if (button.closest(".notifications-filter-chips")) button.setAttribute("aria-pressed", String(isActive));
    if (button.closest(".notifications-filter-menu")) button.setAttribute("aria-checked", String(isActive));
  });

  const emptyState = root.querySelector(".notifications-empty-state");
  if (emptyState) emptyState.hidden = visibleCount > 0;

  const filterLabel = root.querySelector(".notifications-filter-label");
  if (filterLabel) {
    filterLabel.textContent = activeFilter === "all" ? "Filter" : `Filter: ${NOTIFICATION_FILTER_LABELS[activeFilter]}`;
  }

  updateNotificationCounts(root);
}

function closeNotificationsFilterMenu(root = getNotificationsFeedRoot()) {
  const menu = root?.querySelector(".notifications-filter-menu");
  const toggleButton = root?.querySelector("[data-notifications-filter-toggle]");
  if (!menu || !toggleButton) return;

  menu.hidden = true;
  toggleButton.classList.remove("is-open");
  toggleButton.setAttribute("aria-expanded", "false");
}

function toggleNotificationsFilterMenu(button) {
  const root = button.closest(".notifications-feed-card") || getNotificationsFeedRoot();
  const menu = root?.querySelector(".notifications-filter-menu");
  if (!root || !menu) return;

  const willOpen = menu.hidden;
  menu.hidden = !willOpen;
  button.classList.toggle("is-open", willOpen);
  button.setAttribute("aria-expanded", String(willOpen));
}

function bindNotificationsFilterMenuDismissal() {
  if (document.documentElement.dataset.notificationsFilterDismissalBound === "true") return;
  document.documentElement.dataset.notificationsFilterDismissalBound = "true";

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-notifications-filter-toggle], .notifications-filter-menu")) return;
    closeNotificationsFilterMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeNotificationsFilterMenu();
  });
}

async function setupNotificationsPanel({ forceRefresh = false } = {}) {
  const root = getNotificationsFeedRoot();
  if (!root) return;

  try {
    renderNotificationsFromRecords(await loadNotificationsFromBackend(forceRefresh), root);
  } catch {
    renderNotificationsFromRecords([], root);
  }

  const readIds = getStoredReadNotificationIds();
  getNotificationItems(root).forEach((item) => {
    setNotificationReadState(item, readIds.has(getNotificationId(item)) || isNotificationRead(item));
  });

  bindNotificationsFilterMenuDismissal();
  setNotificationFilter(root.dataset.notificationFilter || "all", root);
}

function markAllNotificationsAsRead(root = getNotificationsFeedRoot()) {
  if (!root) return;

  const items = getNotificationItems(root);
  const unreadCount = items.filter((item) => !isNotificationRead(item)).length;
  const readIds = getStoredReadNotificationIds();

  items.forEach((item) => {
    setNotificationReadState(item, true);
    readIds.add(getNotificationId(item));
  });

  saveStoredReadNotificationIds(readIds);
  persistNotificationReadIds(readIds).catch(() => {});
  setNotificationFilter(root.dataset.notificationFilter || "all", root);
  showToast(
    "Notifications updated",
    unreadCount > 0 ? `${unreadCount} notifications marked as read.` : "All notifications are already read.",
  );
}

function removeStoredNotificationIds(ids) {
  const deletedIds = new Set(Array.from(ids).map((id) => String(id).toLowerCase()));
  const readIds = getStoredReadNotificationIds();
  Array.from(readIds).forEach((id) => {
    if (deletedIds.has(String(id).toLowerCase())) readIds.delete(id);
  });
  saveStoredReadNotificationIds(readIds);
}

async function refreshAfterNotificationDeletion(root) {
  notificationState.cache = null;
  notificationState.readyPromise = null;
  invalidateUnifiedHistoryCaches();
  await setupNotificationsPanel({ forceRefresh: true });
  if (state.currentPage === "history") {
    await hydrateHistoryOverview();
  } else {
    await refreshNotificationBadgesFromBackend();
  }
  setNotificationFilter(root?.dataset.notificationFilter || "all", root);
}

async function deleteNotificationRecord(item, root) {
  if (!item || !root) return;
  const id = getNotificationId(item);
  const title = getNotificationTitle(item);
  const result = await openActionDialog({
    eyebrow: "SmartDuck Notification",
    title: "Delete this notification?",
    body: `This will permanently remove “${title}” from every SmartDuck notification center and from History. This action cannot be undone.`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!result.confirmed) return;

  const button = item.querySelector("[data-notifications-delete]");
  if (button) button.disabled = true;
  try {
    const payload = await requestBackendJson(DELETE_NOTIFICATIONS_ENDPOINT, {
      method: "POST",
      body: { username: getAuthenticatedUsername(), id },
    });
    removeStoredNotificationIds(payload.deletedIds || [id]);
    await refreshAfterNotificationDeletion(root);
    showToast("Notification deleted", `${title} was removed from Notifications and History.`);
  } catch (error) {
    if (button) button.disabled = false;
    await showWarningCard("Unable to delete notification", error.message || "The notification could not be deleted from the database.");
  }
}

async function deleteAllNotificationRecords(root) {
  if (!root || getNotificationItems(root).length === 0) return;
  const result = await openActionDialog({
    eyebrow: "SmartDuck Notification Center",
    title: "Delete all notifications?",
    body: "This will permanently remove every shared notification from all SmartDuck accounts and from History. This action cannot be undone.",
    confirmLabel: "Delete All",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!result.confirmed) return;

  const button = root.querySelector("[data-notifications-delete-all]");
  if (button) button.disabled = true;
  try {
    const payload = await requestBackendJson(DELETE_NOTIFICATIONS_ENDPOINT, {
      method: "POST",
      body: { username: getAuthenticatedUsername(), all: true },
    });
    removeStoredNotificationIds(payload.deletedIds || []);
    await refreshAfterNotificationDeletion(root);
    showToast("Notifications deleted", `${Number(payload.deletedCount) || 0} notifications were removed from the shared database and History.`);
  } catch (error) {
    if (button) button.disabled = false;
    await showWarningCard("Unable to delete notifications", error.message || "Notifications could not be deleted from the database.");
  }
}

function getNotificationFilterFromAction(button, actionLabel) {
  if (button.dataset.notificationFilter) return normalizeNotificationFilter(button.dataset.notificationFilter);
  const lower = actionLabel.toLowerCase();
  if (!lower.startsWith("filter ")) return "";
  if (lower.includes("critical")) return "critical";
  if (lower.includes("warning")) return "warning";
  if (lower.includes("info")) return "info";
  if (lower.includes("all")) return "all";
  return "";
}

function handleNotificationsAction(button, actionLabel) {
  const root = button.closest(".notifications-feed-card") || getNotificationsFeedRoot();
  if (!root) return false;
  const lower = actionLabel.toLowerCase();

  if (button.matches("[data-notifications-delete-all]")) {
    void deleteAllNotificationRecords(root);
    return true;
  }

  if (button.matches("[data-notifications-delete]")) {
    void deleteNotificationRecord(button.closest(".notifications-feed-item"), root);
    return true;
  }

  if (button.matches("[data-notifications-mark-read]") || lower === "mark all notifications as read") {
    markAllNotificationsAsRead(root);
    return true;
  }

  if (button.matches("[data-notifications-filter-toggle]") || lower === "filter notifications") {
    toggleNotificationsFilterMenu(button);
    return true;
  }

  const filter = getNotificationFilterFromAction(button, actionLabel);
  if (filter) {
    setNotificationFilter(filter, root);
    if (button.closest(".notifications-filter-menu")) closeNotificationsFilterMenu(root);
    return true;
  }

  return false;
}

function getAdminAlertsRoot() {
  return app.pageRoot?.querySelector(".alerts-table-card") || null;
}

function getAdminAlertRows(root = getAdminAlertsRoot()) {
  return Array.from(root?.querySelectorAll(".alerts-table tbody tr") || []);
}

function renderAdminAlertsFromRecords(notifications) {
  const root = getAdminAlertsRoot();
  const tbody = root?.querySelector(".alerts-table tbody");
  if (!root || !tbody) return;

  tbody.innerHTML = notifications.map((notification) => {
    const severity = normalizeTableFilter(notification.severity || "normal", ALERT_FILTER_LABELS);
    const isCritical = severity === "critical";
    const isWarning = severity === "warning";
    const icon = isCritical ? "alert-triangle" : isWarning ? "alert-circle" : "info";
    const color = isCritical ? "red" : isWarning ? "amber" : "green";
    const label = ALERT_FILTER_LABELS[severity] || "Normal";
    const title = notification.title || "SmartDuck alert";
    return `
      <tr>
        <td class="alerts-table__alert">
          <span class="alerts-table__alert-icon alerts-table__alert-icon--${color}" data-icon="${icon}"></span>
          <span>${escapeHtml(title)}</span>
        </td>
        <td><span class="alerts-type-text alerts-type-text--${color}">${escapeHtml(label)}</span></td>
        <td>${escapeHtml(formatNotificationTime(notification.createdAt))}</td>
        <td>
          <div class="alerts-action-row" aria-label="Alert actions">
            <button type="button" class="alerts-icon-button alerts-icon-button--ok" aria-label="Mark ${escapeHtml(title)} as okay" data-ui-action="Mark alert as okay">
              <span data-icon="check-circle"></span>
            </button>
            <button type="button" class="alerts-icon-button alerts-icon-button--delete" aria-label="Delete ${escapeHtml(title)} alert" data-ui-action="Delete alert">
              <span data-icon="trash"></span>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
  hydrateIcons(root);
}

function getAdminAlertType(row) {
  const text = row.querySelector(".alerts-type-text")?.textContent.trim().toLowerCase() || "";
  if (text.includes("critical")) return "critical";
  if (text.includes("warning")) return "warning";
  if (text.includes("normal")) return "normal";
  return "normal";
}

function getAdminAlertStatus(row) {
  const text = row.querySelector(".alerts-status-pill")?.textContent.trim().toLowerCase() || "";
  if (text.includes("acknowledged")) return "acknowledged";
  if (text.includes("resolved")) return "resolved";
  return "new";
}

function getAdminAlertFilterForRow(row) {
  return [getAdminAlertType(row), getAdminAlertStatus(row)];
}

function getAdminAlertCounts(root = getAdminAlertsRoot()) {
  const counts = { all: 0, critical: 0, warning: 0, normal: 0, acknowledged: 0, resolved: 0 };
  getAdminAlertRows(root).forEach((row) => {
    const type = getAdminAlertType(row);
    const status = getAdminAlertStatus(row);
    counts.all += 1;
    counts[type] = (counts[type] || 0) + 1;
    if (status === "acknowledged" || status === "resolved") {
      counts[status] = (counts[status] || 0) + 1;
    }
  });
  return counts;
}

function updateAdminAlertTabs(root = getAdminAlertsRoot()) {
  if (!root) return;
  const activeFilter = normalizeTableFilter(root.dataset.alertsFilter || "all", ALERT_FILTER_LABELS);
  const counts = getAdminAlertCounts(root);

  root.querySelectorAll(".alerts-tab").forEach((tab) => {
    const rawLabel = tab.dataset.alertFilter || tab.textContent.replace(/\(.*/, "").trim();
    const filter = normalizeTableFilter(rawLabel, ALERT_FILTER_LABELS);
    tab.dataset.alertFilter = filter;
    tab.textContent = `${ALERT_FILTER_LABELS[filter]} (${counts[filter] || 0})`;
    tab.classList.toggle("is-active", filter === activeFilter);
    tab.setAttribute("aria-selected", String(filter === activeFilter));
  });
}

function updateAdminAlertSummaryCards(root = getAdminAlertsRoot()) {
  if (!root) return;
  const counts = getAdminAlertCounts(root);
  const summaryCards = Array.from(app.pageRoot?.querySelectorAll(".alerts-summary-card") || []);
  const cardKeys = ["all", "critical", "warning", "normal"];
  cardKeys.forEach((key, index) => {
    const card = summaryCards[index];
    if (!card) return;
    const value = card.querySelector(".alerts-summary-card__value");
    const meta = card.querySelector(".alerts-summary-card__meta");
    const count = counts[key] || 0;
    if (value) value.textContent = String(count);
    if (meta) {
      const percent = counts.all > 0 ? `${((count / counts.all) * 100).toFixed(1).replace(/\.0$/, "")}%` : "0%";
      meta.textContent = key === "all" ? `${percent} of total` : `${percent} of total`;
    }
  });
}

function updateAdminAlertsFilterMenu(root = getAdminAlertsRoot()) {
  if (!root) return;
  const actions = root.querySelector(".alerts-table-card__actions");
  const activeFilter = normalizeTableFilter(root.dataset.alertsFilter || "all", ALERT_FILTER_LABELS);
  const counts = getAdminAlertCounts(root);
  const options = Object.entries(ALERT_FILTER_LABELS).map(([value, label]) => ({
    value,
    label,
    count: counts[value] || 0,
  }));

  buildSmartduckFilterMenu({
    id: "admin-alerts-filter-menu",
    container: actions,
    options,
    activeValue: activeFilter,
    onSelect: (filter) => applyAdminAlertsFilter(filter, { announce: true }),
  });
}

function applyAdminAlertsFilter(filter, { announce = false } = {}) {
  const root = getAdminAlertsRoot();
  if (!root) return;
  const activeFilter = normalizeTableFilter(filter, ALERT_FILTER_LABELS);
  const searchTerm = root.querySelector(".alerts-search input")?.value.trim().toLowerCase() || "";
  root.dataset.alertsFilter = activeFilter;

  let visibleCount = 0;
  const rows = getAdminAlertRows(root);
  rows.forEach((row) => {
    const rowFilters = getAdminAlertFilterForRow(row);
    const matchesFilter = activeFilter === "all" || rowFilters.includes(activeFilter);
    const matchesSearch = !searchTerm || row.textContent.toLowerCase().includes(searchTerm);
    const isVisible = matchesFilter && matchesSearch;
    row.hidden = !isVisible;
    if (isVisible) visibleCount += 1;
  });

  const tableWrap = root.querySelector(".alerts-table-wrap");
  const emptyState = ensureTableEmptyState(tableWrap, "alerts-filter-empty-state", "No alerts match this filter.");
  if (emptyState) emptyState.hidden = visibleCount > 0;

  const button = root.querySelector("[data-smartduck-filter-toggle='admin-alerts']");
  if (button) {
    const labelNode = button.querySelector("[data-filter-label]");
    if (labelNode) labelNode.textContent = activeFilter === "all" ? "Filters" : `Filter: ${ALERT_FILTER_LABELS[activeFilter]}`;
  }

  const footnote = root.querySelector(".alerts-table-card__footnote");
  if (footnote) {
    const total = rows.length;
    const termCopy = searchTerm ? ` matching "${searchTerm}"` : "";
    footnote.textContent = visibleCount > 0
      ? `Showing 1 to ${visibleCount} of ${total} alerts${termCopy}`
      : `Showing 0 of ${total} alerts${termCopy}`;
  }

  updateAdminAlertTabs(root);
  updateAdminAlertSummaryCards(root);
  updateAdminAlertsFilterMenu(root);
  if (announce) showToast("Filter applied", `${ALERT_FILTER_LABELS[activeFilter]} alerts shown.`);
}

function setupAdminAlertsFilters() {
  const root = getAdminAlertsRoot();
  if (!root) return;

  void loadNotificationsFromBackend()
    .then((notifications) => {
      renderAdminAlertsFromRecords(notifications);
      applyAdminAlertsFilter(root.dataset.alertsFilter || "all");
    })
    .catch(() => {
      renderAdminAlertsFromRecords([]);
      applyAdminAlertsFilter(root.dataset.alertsFilter || "all");
    });

  const filterButton = root.querySelector(".alerts-filter-button");
  if (filterButton) {
    filterButton.dataset.uiBound = "true";
    filterButton.dataset.smartduckFilterToggle = "admin-alerts";
    filterButton.setAttribute("aria-haspopup", "menu");
    filterButton.setAttribute("aria-expanded", "false");
    filterButton.setAttribute("aria-controls", "admin-alerts-filter-menu");
    const textNode = filterButton.querySelector("span:nth-of-type(2)");
    if (textNode && !textNode.dataset.filterLabel) textNode.dataset.filterLabel = "true";
    if (filterButton.dataset.alertsFilterBound !== "true") {
      filterButton.dataset.alertsFilterBound = "true";
      filterButton.addEventListener("click", () => toggleSmartduckFilterMenu(filterButton));
    }
  }

  root.querySelectorAll(".alerts-tab").forEach((tab) => {
    tab.dataset.uiBound = "true";
    if (tab.dataset.alertFilterBound === "true") return;
    tab.dataset.alertFilterBound = "true";
    tab.addEventListener("click", () => {
      const filter = normalizeTableFilter(tab.dataset.alertFilter || tab.textContent.replace(/\(.*/, "").trim(), ALERT_FILTER_LABELS);
      applyAdminAlertsFilter(filter, { announce: true });
    });
  });

  const searchInput = root.querySelector(".alerts-search input");
  if (searchInput && searchInput.dataset.alertSearchBound !== "true") {
    searchInput.dataset.alertSearchBound = "true";
    searchInput.addEventListener(
      "input",
      debounce(() => applyAdminAlertsFilter(root.dataset.alertsFilter || "all"), 80),
    );
  }

  bindSmartduckFilterMenuDismissal();
  applyAdminAlertsFilter(root.dataset.alertsFilter || "all");
}

function parseHistoryTableDate(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "-") return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(12, 0, 0, 0);
  return date;
}

function formatHistoryDetailDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getHistoryRowDetails(row) {
  const cells = Array.from(row?.cells || []);
  const id = cells[0]?.textContent.trim() || "";
  const detail = historyBatchDetails[id] || {};
  const eggCount = Number.parseInt(cells[3]?.textContent.replace(/,/g, ""), 10) || 0;
  const hatched = Number.isFinite(Number(detail.hatched)) ? Number(detail.hatched) : Math.round(eggCount * 0.8);
  const unhatched = Number.isFinite(Number(detail.unhatched)) ? Number(detail.unhatched) : Math.max(0, eggCount - hatched);
  const hatchRate = eggCount > 0 ? `${((hatched / eggCount) * 100).toFixed(1)}%` : "-";
  const statusLabel = row?.querySelector(".batch-status-pill")?.textContent.trim() || "In Progress";
  const statusKey = getBatchRowStatus(row);
  const targetDays = Number(detail.targetDays || 18);
  const currentDay = Number(detail.currentDay ?? (statusKey === "completed" ? targetDays : statusKey === "upcoming" ? 0 : Math.min(12, targetDays)));

  return {
    id,
    startDate: cells[1]?.textContent.trim() || "-",
    endDate: cells[2]?.textContent.trim() || "-",
    eggCount,
    hatched,
    unhatched,
    hatchRate,
    statusLabel,
    statusKey,
    currentDay,
    targetDays,
  };
}

function buildHistoryTimeline(details) {
  const startDate = parseHistoryTableDate(details.startDate) || new Date(2025, 4, 6, 12);
  const targetDays = Math.max(1, Number(details.targetDays || 18));
  const currentDay = Math.min(Math.max(0, Number(details.currentDay || 0)), targetDays);
  return Array.from({ length: targetDays }, (_, index) => {
    const day = index + 1;
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + index);
    const isCandlingDay = [7, 14].includes(day);
    const isHarvestDay = day === targetDays;
    const isCompleted = (
      details.statusKey === "completed"
        ? day <= currentDay
        : details.statusKey === "in-progress" && day < currentDay
    );
    const isCurrent = details.statusKey === "in-progress" && day === currentDay;
    const status = isCompleted ? "Completed" : isCurrent ? "Current" : "Upcoming";
    const activity = day === 1
      ? "Start Incubation"
      : isHarvestDay
        ? "Harvest / Hatch Day"
        : isCandlingDay
          ? "Candling + Egg Turning"
          : "Egg Turning";
    const rowClass = isCurrent ? "is-current" : isHarvestDay ? "is-harvest" : isCandlingDay ? "is-candling" : "";
    const detailsText = day === 1
      ? "Incubation started"
      : isHarvestDay
        ? "Last turning before hatch"
        : isCandlingDay
          ? "Check egg development and turn eggs"
          : "Turn eggs to ensure proper development";

    return {
      day,
      date,
      activity,
      detailsText,
      status,
      rowClass,
    };
  });
}

function closeHistoryDetailModal() {
  if (!app.historyDetailModal) return;
  app.historyDetailModal.hidden = true;
  app.historyDetailModal.setAttribute("aria-hidden", "true");
  syncModalOpenState();
}

function ensureHistoryDetailModal() {
  if (app.historyDetailModal) return app.historyDetailModal;

  const wrapper = document.createElement("div");
  wrapper.id = "history-detail-modal";
  wrapper.className = "history-detail-modal";
  wrapper.hidden = true;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = `
    <button class="history-detail-modal__backdrop" type="button" tabindex="-1" aria-label="Close batch details"></button>
    <section class="history-detail-modal__card" role="dialog" aria-modal="true" aria-labelledby="history-detail-title"></section>
  `;
  document.body.appendChild(wrapper);
  app.historyDetailModal = wrapper;
  wrapper.querySelector(".history-detail-modal__backdrop")?.addEventListener("click", closeHistoryDetailModal);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app.historyDetailModal && !app.historyDetailModal.hidden) {
      event.preventDefault();
      closeHistoryDetailModal();
    }
  });
  return wrapper;
}

function renderHistoryDetailModal(details) {
  const modal = ensureHistoryDetailModal();
  const card = modal.querySelector(".history-detail-modal__card");
  if (!card) return;

  const timeline = buildHistoryTimeline(details);
  const currentDay = Math.max(1, Math.min(details.currentDay || 1, details.targetDays || 18));
  const currentTimelineRow = timeline[currentDay - 1] || timeline[0];
  const nextTimelineRow = timeline.find((entry) => entry.day > currentDay && entry.status === "Upcoming") || timeline[timeline.length - 1];
  const statusClass = details.statusKey === "completed"
    ? "batch-status-pill--complete"
    : details.statusKey === "upcoming"
      ? "batch-status-pill--upcoming"
      : "batch-status-pill--progress";

  card.innerHTML = `
    <div class="history-detail-modal__topbar">
      <div class="history-detail-modal__title-wrap">
        <span class="history-detail-modal__icon">${renderIcon("calendar", "icon--sm")}</span>
        <div>
          <h2 id="history-detail-title" class="history-detail-modal__title">Batch Details</h2>
          <p class="history-detail-modal__batch">${escapeHtml(details.id)}</p>
        </div>
      </div>
      <div class="history-detail-modal__top-actions">
        <span class="batch-status-pill ${statusClass}">${escapeHtml(details.statusLabel)}</span>
        <button class="history-detail-modal__close" type="button" aria-label="Close batch details">${renderIcon("x-circle")}</button>
      </div>
    </div>

    <div class="history-detail-summary">
      <article class="history-detail-summary__item">
        <span>${renderIcon("calendar", "icon--sm")}</span>
        <div><small>Start Date</small><strong>${escapeHtml(details.startDate)}</strong></div>
      </article>
      <article class="history-detail-summary__item">
        <span>${renderIcon("calendar", "icon--sm")}</span>
        <div><small>End Date</small><strong>${escapeHtml(details.endDate)}</strong></div>
      </article>
      <article class="history-detail-summary__item">
        <span>${renderIcon("egg", "icon--sm")}</span>
        <div><small>Egg Count</small><strong>${details.eggCount} Eggs</strong></div>
      </article>
      <article class="history-detail-summary__item">
        <span>${renderIcon("activity", "icon--sm")}</span>
        <div><small>Status</small><strong>${escapeHtml(details.statusLabel)}</strong></div>
      </article>
    </div>

    <div class="history-detail-section-title">
      <h3>Incubation Timeline</h3>
      <div class="history-detail-legend">
        <span><i class="history-detail-dot history-detail-dot--today"></i>Today</span>
        <span><i class="history-detail-dot history-detail-dot--candling"></i>Candling Day</span>
        <span><i class="history-detail-dot history-detail-dot--harvest"></i>Harvest Day</span>
      </div>
    </div>

    <div class="history-detail-table-wrap">
      <table class="history-detail-table">
        <thead>
          <tr>
            <th>Day</th>
            <th>Date</th>
            <th>Activity</th>
            <th>Details</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${timeline.map((entry) => `
            <tr class="${entry.rowClass}">
              <td>Day ${entry.day}</td>
              <td>${escapeHtml(formatHistoryDetailDate(entry.date))}</td>
              <td><span class="history-detail-activity">${renderIcon(entry.activity.includes("Candling") ? "eye" : "clock-3", "icon--sm")}${escapeHtml(entry.activity)}</span></td>
              <td>${escapeHtml(entry.detailsText)}</td>
              <td><span class="history-detail-status history-detail-status--${entry.status.toLowerCase()}">${escapeHtml(entry.status)}</span></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>

    <div class="history-detail-footer">
      <article>
        <span>${renderIcon("calendar", "icon--sm")}</span>
        <div><small>Current Day</small><strong>Day ${currentDay} of ${details.targetDays}</strong><em>${escapeHtml(formatHistoryDetailDate(currentTimelineRow.date))}</em></div>
      </article>
      <article>
        <span>${renderIcon("clock-3", "icon--sm")}</span>
        <div><small>Next Activity</small><strong>${escapeHtml(nextTimelineRow.activity)}</strong><em>${escapeHtml(formatHistoryDetailDate(nextTimelineRow.date))}</em></div>
      </article>
      <button class="history-detail-modal__close-button" type="button">Close</button>
    </div>
  `;

  card.querySelector(".history-detail-modal__close")?.addEventListener("click", closeHistoryDetailModal);
  card.querySelector(".history-detail-modal__close-button")?.addEventListener("click", closeHistoryDetailModal);
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  syncModalOpenState();
}

function openHistoryDetailsForRow(row) {
  if (!row) return;
  renderHistoryDetailModal(getHistoryRowDetails(row));
}

function getCompletedBatchEndDate(batch) {
  const completedAtDate = String(batch?.completedAt || "").slice(0, 10);
  if (parseDateInputValue(batch?.endDate)) return batch.endDate;
  if (parseDateInputValue(completedAtDate)) return completedAtDate;
  return toDateInputValue(addDaysToDate(batch?.startDate, INCUBATION_TARGET_DAYS - 1));
}

function normalizeHistoryActivityRecord(record) {
  const details = record?.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? { ...record.details }
    : {};
  return {
    id: String(record?.id || "").trim(),
    actorUsername: String(record?.actorUsername || "System").trim() || "System",
    entityType: String(record?.entityType || "system").trim().toLowerCase() || "system",
    entityId: String(record?.entityId || "").trim(),
    action: String(record?.action || "record").trim().toLowerCase() || "record",
    details,
    createdAt: String(record?.createdAt || "").trim(),
  };
}

const HISTORY_CACHE_PREFIX = "smartduck.history.v2";
const HISTORY_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const historyDataState = {
  memory: new Map(),
  requests: new Map(),
};

function getHistoryCacheKey() {
  const role = getAuthenticatedRole();
  const username = getAuthenticatedUsername().trim().toLowerCase() || "anonymous";
  return `${role}.${username}`;
}

function historyActivityIsVisibleToViewer(record) {
  if (getAuthenticatedRole() === "admin") return true;
  return !(record.entityType === "account" && record.action === "login");
}

function normalizeUnifiedHistoryData(payload = {}) {
  return {
    batches: normalizeAccounts(payload.batches).map(normalizeUserBatchRecord).filter(Boolean),
    activity: normalizeAccounts(payload.activity)
      .map(normalizeHistoryActivityRecord)
      .filter(historyActivityIsVisibleToViewer),
    notifications: normalizeAccounts(payload.notifications).map((notification) => ({ ...notification })),
    notificationUnreadCount: Math.max(0, Number(payload.notificationUnreadCount) || 0),
  };
}

function readUnifiedHistoryCache() {
  const key = getHistoryCacheKey();
  if (historyDataState.memory.has(key)) return historyDataState.memory.get(key);
  try {
    const stored = JSON.parse(localStorage.getItem(`${HISTORY_CACHE_PREFIX}.${key}`) || "null");
    if (!stored || typeof stored !== "object" || !stored.data) return null;
    const cached = {
      savedAt: Number(stored.savedAt || 0),
      data: normalizeUnifiedHistoryData(stored.data),
    };
    historyDataState.memory.set(key, cached);
    return cached;
  } catch {
    return null;
  }
}

function saveUnifiedHistoryCache(data) {
  const key = getHistoryCacheKey();
  const cached = { savedAt: Date.now(), data: normalizeUnifiedHistoryData(data) };
  historyDataState.memory.set(key, cached);
  try {
    localStorage.setItem(`${HISTORY_CACHE_PREFIX}.${key}`, JSON.stringify(cached));
  } catch {
    // In-memory history still keeps navigation instant when storage is unavailable.
  }
  return cached.data;
}

function invalidateUnifiedHistoryCaches() {
  historyDataState.memory.clear();
  historyDataState.requests.clear();
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(`${HISTORY_CACHE_PREFIX}.`))
      .forEach((key) => localStorage.removeItem(key));
  } catch {
    // A fresh backend request still keeps deletion state correct when storage is unavailable.
  }
}

async function requestUnifiedHistoryData() {
  const isAdmin = getAuthenticatedRole() === "admin";
  const username = getAuthenticatedUsername();
  const scope = isAdmin ? "all" : "user";
  try {
    const payload = await requestBackendJson(
      `${HISTORY_ENDPOINT}&username=${encodeURIComponent(username)}&scope=${scope}&_=${Date.now()}`,
    );
    return normalizeUnifiedHistoryData(payload);
  } catch (error) {
    if (Number(error?.status) !== 404) throw error;
    const [batches, activity, notifications] = await Promise.all([
      isAdmin ? loadAllBatchesFromBackend() : loadUserBatchesFromBackend(),
      loadHistoryActivityFromBackend(),
      loadNotificationsFromBackend(true),
    ]);
    return normalizeUnifiedHistoryData({ batches, activity, notifications });
  }
}

async function loadUnifiedHistoryData({ forceRefresh = false } = {}) {
  const key = getHistoryCacheKey();
  const cached = readUnifiedHistoryCache();
  if (!forceRefresh && cached && Date.now() - cached.savedAt < HISTORY_CACHE_MAX_AGE_MS) {
    return cached.data;
  }
  if (historyDataState.requests.has(key)) return historyDataState.requests.get(key);

  const request = requestUnifiedHistoryData()
    .then((data) => {
      historyDataState.requests.delete(key);
      if (getAuthenticatedRole() !== "admin") writeStoredUserBatches(data.batches);
      return saveUnifiedHistoryCache(data);
    })
    .catch((error) => {
      historyDataState.requests.delete(key);
      throw error;
    });
  historyDataState.requests.set(key, request);
  return request;
}

function prefetchUnifiedHistoryData() {
  if (sessionStorage.getItem(AUTH_KEY) !== "true") return;
  void loadUnifiedHistoryData()
    .then((data) => updateNotificationBadges(data.notificationUnreadCount))
    .catch(() => {
      // The History page can retry while preserving any cached snapshot.
    });
}

async function loadHistoryActivityFromBackend() {
  const username = getAuthenticatedUsername();
  const userQuery = getAuthenticatedRole() === "admin" ? "" : `username=${encodeURIComponent(username)}&`;
  const payload = await requestBackendJson(`${ACTIVITY_ENDPOINT}&${userQuery}limit=500&_=${Date.now()}`);
  const records = normalizeAccounts(payload.activity).map(normalizeHistoryActivityRecord);
  if (getAuthenticatedRole() === "admin") return records;
  const normalizedUsername = username.trim().toLowerCase();
  return records.filter((record) => record.actorUsername.toLowerCase() === normalizedUsername);
}

function mergeNotificationHistory(activityRecords = [], notifications = []) {
  const notificationCreateIds = new Set(
    activityRecords
      .filter((record) => record.entityType === "notification" && record.action === "create")
      .map((record) => record.entityId.toLowerCase()),
  );
  const notificationRecords = normalizeAccounts(notifications)
    .filter((notification) => !notificationCreateIds.has(String(notification.id || "").toLowerCase()))
    .map((notification) => normalizeHistoryActivityRecord({
      id: `notification-history-${notification.id || Date.now()}`,
      actorUsername: notification.createdByUsername || notification.accountUsername || "SmartDuck",
      entityType: "notification",
      entityId: notification.id || notification.component || "Notification",
      action: "recorded",
      details: {
        title: notification.title || "SmartDuck notification",
        message: notification.message || "A notification was recorded.",
        severity: notification.severity || "info",
      },
      createdAt: notification.createdAt || notification.recordedAt || "",
    }));

  return [...activityRecords, ...notificationRecords].sort((a, b) => {
    return getBatchRecordTime(b.createdAt) - getBatchRecordTime(a.createdAt);
  });
}

function mergeCompletedBatchHistory(activityRecords = [], batches = []) {
  const completedBatches = getCompletedBatches(batches);
  const batchById = new Map(completedBatches.map((batch) => [String(batch.id || "").toLowerCase(), batch]));
  const representedBatchIds = new Set();
  const enrichedActivity = activityRecords.map((record) => {
    const batchId = String(record.entityId || "").toLowerCase();
    const batch = record.entityType === "batch" ? batchById.get(batchId) : null;
    const isCompletion = batch && (record.action === "completed" || normalizeBatchStatus(record.details?.status) === "completed");
    if (!isCompletion) return record;
    representedBatchIds.add(batchId);
    return {
      ...record,
      action: "completed",
      details: { ...record.details, status: "completed", batchRecord: batch },
    };
  });
  const completedBatchActivity = completedBatches
    .filter((batch) => !representedBatchIds.has(String(batch.id || "").toLowerCase()))
    .map((batch) => normalizeHistoryActivityRecord({
      id: `completed-batch-${batch.id}`,
      actorUsername: batch.createdByUsername || "SmartDuck user",
      entityType: "batch",
      entityId: batch.id,
      action: "completed",
      details: {
        status: "completed",
        eggCount: batch.initialEggCount || batch.eggCount || 0,
        batchRecord: batch,
      },
      createdAt: batch.completedAt || `${getCompletedBatchEndDate(batch)}T23:59:59+08:00`,
    }));
  return [...enrichedActivity, ...completedBatchActivity].sort((a, b) => {
    return getBatchRecordTime(b.createdAt) - getBatchRecordTime(a.createdAt);
  });
}

function getCompletedBatchHistoryDetails(batch) {
  const initialEggCount = Math.max(Number(batch?.initialEggCount || 0), Number(batch?.eggCount || 0));
  const completedDays = normalizeCompletedScheduleDays(batch?.completedScheduleDays);
  return {
    id: String(batch?.id || "Batch"),
    startDate: formatBatchDate(batch?.startDate),
    endDate: formatBatchDate(getCompletedBatchEndDate(batch)),
    eggCount: initialEggCount,
    hatched: Number(batch?.eggCount || 0),
    unhatched: Math.max(0, initialEggCount - Number(batch?.eggCount || 0)),
    statusLabel: "Completed",
    statusKey: "completed",
    currentDay: Math.max(...completedDays, 1),
    targetDays: Number(batch?.targetDays || INCUBATION_TARGET_DAYS),
  };
}

function getHistoryActivityPresentation(record) {
  const type = record.entityType;
  const action = record.action;
  const details = record.details || {};
  const categoryMap = {
    account: { label: "Account", icon: "user", tone: "teal" },
    batch: { label: "Batch", icon: "package-open", tone: "green" },
    schedule: { label: "Schedule", icon: "calendar", tone: "purple" },
    notification: { label: "Notification", icon: "bell", tone: "orange" },
    component: { label: "Component", icon: "settings", tone: "blue" },
    settings: { label: "Settings", icon: "settings", tone: "blue" },
    sms: { label: "SMS", icon: "bell", tone: "orange" },
  };
  const category = categoryMap[type] || { label: "System", icon: "activity", tone: "blue" };
  let title = `${action.replace(/-/g, " ")} ${type}`;
  let description = "SmartDuck activity recorded.";

  if (type === "account") {
    const targetUsername = String(details.targetUsername || record.entityId || "account");
    if (action === "login") {
      title = "Signed in to SmartDuck";
      description = "Successful account login.";
    } else if (action === "create") {
      title = `Created account ${targetUsername}`;
      description = `${String(details.accountRole || "SmartDuck")} access was created in User Management.`;
    } else if (action === "update") {
      title = `Updated account ${targetUsername}`;
      const changedFields = Array.isArray(details.changedFields) ? details.changedFields : [];
      description = changedFields.length
        ? `Updated ${changedFields.map((field) => String(field).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()).join(", ")}.`
        : "Account details were updated in User Management.";
    } else if (action === "delete") {
      title = `Deleted account ${targetUsername}`;
      description = "The account was removed from User Management.";
    }
  } else if (type === "batch") {
    const actionLabel = action === "create" ? "Created" : action === "update" ? "Updated" : action === "delete" ? "Deleted" : action === "completed" ? "Completed" : "Changed";
    title = `${actionLabel} batch ${record.entityId || "record"}`;
    const eggCount = Number(details.eggCount);
    description = Number.isFinite(eggCount)
      ? `${formatWholeNumber(eggCount)} eggs · ${String(details.status || "status recorded").replace(/-/g, " ")}`
      : "Batch record updated in the shared database.";
  } else if (type === "schedule" && action === "complete") {
    title = `Completed schedule${details.eventDay ? ` day ${details.eventDay}` : ""}`;
    description = `${details.batchId || record.entityId || "Batch"}${Number(details.removedCount) > 0 ? ` · ${formatWholeNumber(details.removedCount)} egg(s) removed` : " · No eggs removed"}`;
  } else if (type === "notification") {
    title = String(details.title || (action === "mark-read" ? "Notifications marked as read" : "SmartDuck notification"));
    description = String(details.message || (action === "mark-read" ? "Notification read status was synchronized." : `${details.severity || "Info"} notification recorded.`));
  } else if (type === "settings") {
    title = "Updated SmartDuck settings";
    description = `${String(details.group || "System")} settings were synchronized.`;
  } else if (type === "component") {
    const eventType = String(details.eventType || action || "").toLowerCase();
    const candlingDay = Number(details.candlingDay) === 14 ? 14 : 7;
    const eventPresentation = {
      "candling-started": ["Candling started", `The Day ${candlingDay} actuator cycle started.`],
      "candling-returning": ["Candling tray returning", "The 10-minute candling window ended and the tray began returning."],
      "candling-completed": ["Candling completed", "The actuator returned the tray to its normal position."],
      "egg-turning-started": ["Egg turning started", "The scheduled one-rotation egg turn started."],
      "egg-turning-completed": ["Egg turning completed", "The relay stopped after one calibrated full rotation."],
    }[eventType];
    title = eventPresentation?.[0] || `Updated component ${record.entityId || "status"}`;
    description = eventPresentation?.[1]
      ? `${eventPresentation[1]}${details.batchId ? ` Batch ${details.batchId}.` : ""}`
      : `Status changed to ${String(details.status || "recorded").replace(/-/g, " ")}.`;
  } else if (type === "sms") {
    title = "Confirmed SMS notification number";
    description = "Alert delivery settings were synchronized.";
  }

  return { ...category, title, description };
}

function renderActivityHistoryRows(records = []) {
  const tableBody = app.pageRoot?.querySelector(".activity-history-table tbody");
  if (!tableBody) return [];
  tableBody.innerHTML = records.map((record) => {
    const presentation = getHistoryActivityPresentation(record);
    const completedBatch = record.details?.batchRecord || null;
    return `
      <tr data-activity-id="${escapeHtml(record.id)}">
        <td><time class="activity-history-time">${escapeHtml(formatNotificationTime(record.createdAt) || "Date unavailable")}</time></td>
        <td><span class="activity-history-type activity-history-type--${escapeHtml(presentation.tone)}">${renderIcon(presentation.icon, "icon--sm")}<span>${escapeHtml(presentation.label)}</span></span></td>
        <td><strong class="activity-history-title">${escapeHtml(presentation.title)}</strong><small class="activity-history-description">${escapeHtml(presentation.description)}</small></td>
        <td class="activity-history-reference">${escapeHtml(record.entityId || "--")}</td>
        <td class="batch-table__strong">${escapeHtml(record.actorUsername || "System")}</td>
        <td class="activity-history-actions">
          <span class="activity-history-actions__row">
            ${completedBatch ? `
              <button type="button" class="history-view-button" data-activity-batch-view="${escapeHtml(record.id)}">
                ${renderIcon("eye", "icon--sm")}
                <span>View Details</span>
              </button>
            ` : ""}
            <button
              type="button"
              class="icon-button icon-button--red activity-history-delete"
              data-history-entry-delete="${escapeHtml(record.id)}"
              title="Delete this history entry"
              aria-label="Delete this history entry"
            >${renderIcon("trash", "icon--sm")}</button>
          </span>
        </td>
      </tr>
    `;
  }).join("");
  const recordById = new Map(records.map((record) => [record.id, record]));
  tableBody.querySelectorAll("[data-history-entry-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      const record = recordById.get(button.dataset.historyEntryDelete || "");
      if (record) void deleteHistoryEntry(record, button);
    });
  });
  tableBody.querySelectorAll("[data-activity-batch-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const record = recordById.get(button.dataset.activityBatchView || "");
      const batch = record?.details?.batchRecord;
      if (batch) renderHistoryDetailModal(getCompletedBatchHistoryDetails(batch));
    });
  });
  hydrateIcons(tableBody);
  return Array.from(tableBody.querySelectorAll("tr"));
}

/*
 * The timeline scrolls in place instead of paging, so every activity is
 * reachable in one gesture. The footer keeps a plain total; there are no page
 * buttons left to build.
 */
function renderActivityHistorySummary() {
  if (state.currentPage !== "history" || !app.pageRoot) return;
  const rows = Array.from(app.pageRoot.querySelectorAll(".activity-history-table tbody tr"));
  const summary = app.pageRoot.querySelector(".activity-history-footer__copy");
  if (!summary) return;
  // Rows were hidden by the old pager; a stale `hidden` would survive a
  // re-render of the same nodes, so clear it before counting.
  rows.forEach((row) => { row.hidden = false; });
  const totalEntries = rows.length;
  summary.textContent = totalEntries
    ? `Showing all ${formatWholeNumber(totalEntries)} ${totalEntries === 1 ? "activity" : "activities"}`
    : "No activity recorded yet";
}

function getCompletedBatches(batches = []) {
  return normalizeAccounts(batches)
    .filter((batch) => normalizeBatchStatus(batch.status) === "completed")
    .sort((a, b) => {
      const endCompare = getCompletedBatchEndDate(b).localeCompare(getCompletedBatchEndDate(a));
      return endCompare || getBatchRecordTime(b.createdAt) - getBatchRecordTime(a.createdAt);
    });
}

function renderAdminDashboardHistory(batches = []) {
  const list = document.getElementById("admin-dashboard-history-list");
  if (!list) return;
  const completedBatches = getCompletedBatches(batches).slice(0, 1);
  if (!completedBatches.length) {
    list.innerHTML = '<p class="table-empty">No completed batch history yet.</p>';
    return;
  }
  list.innerHTML = completedBatches.map((batch) => `
    <article class="admin-dashboard-list__item">
      <span class="admin-dashboard-list__icon admin-dashboard-list__icon--green">${renderIcon("history")}</span>
      <div>
        <p class="admin-dashboard-list__title">${escapeHtml(batch.id || "Batch")}</p>
        <p class="admin-dashboard-list__meta">${escapeHtml(formatWholeNumber(batch.initialEggCount || batch.eggCount || 0))} eggs · ${escapeHtml(batch.createdByUsername || "SmartDuck user")}</p>
      </div>
      <span class="admin-dashboard-list__badge admin-dashboard-list__badge--normal">Completed</span>
      <time class="admin-dashboard-list__time">${escapeHtml(formatBatchDate(getCompletedBatchEndDate(batch)))}</time>
    </article>
  `).join("");
}

function renderCompletedBatchHistoryRows(batches = getStoredUserBatches()) {
  const tableBody = app.pageRoot?.querySelector(".batch-history-table tbody");
  if (!tableBody) return [];
  const completedBatches = getCompletedBatches(batches);
  const includeOwner = getAuthenticatedRole() === "admin";

  tableBody.innerHTML = completedBatches.map((batch) => {
    const initialEggCount = Math.max(Number(batch.initialEggCount || 0), Number(batch.eggCount || 0));
    const endDate = getCompletedBatchEndDate(batch);
    historyBatchDetails[batch.id] = {
      currentDay: Math.max(...normalizeCompletedScheduleDays(batch.completedScheduleDays), 1),
      targetDays: INCUBATION_TARGET_DAYS,
      initialEggCount,
      remainingEggCount: Number(batch.eggCount || 0),
      completedScheduleDays: normalizeCompletedScheduleDays(batch.completedScheduleDays),
    };
    return `
      <tr data-history-batch-id="${escapeHtml(batch.id)}">
        <td class="batch-table__strong">${escapeHtml(batch.id)}</td>
        <td>${escapeHtml(formatBatchDate(batch.startDate))}</td>
        <td>${escapeHtml(formatBatchDate(endDate))}</td>
        <td>${escapeHtml(formatWholeNumber(initialEggCount))}</td>
        <td><span class="batch-status-pill batch-status-pill--complete">Completed</span></td>
        ${includeOwner ? `<td class="batch-table__strong">${escapeHtml(batch.createdByUsername || "Unknown user")}</td>` : ""}
        <td>
          <button type="button" class="history-view-button" data-history-view>
            ${renderIcon("eye", "icon--sm")}
            <span>View Details</span>
          </button>
        </td>
      </tr>
    `;
  }).join("");

  tableBody.querySelectorAll("[data-history-view]").forEach((button) => {
    button.addEventListener("click", () => openHistoryDetailsForRow(button.closest("tr")));
  });
  hydrateIcons(tableBody);
  return Array.from(tableBody.querySelectorAll("tr"));
}

function renderUnifiedHistoryData(data) {
  if (state.currentPage !== "history" || !data) return;
  const historyBatches = normalizeAccounts(data.batches);
  const activityRecords = normalizeAccounts(data.activity).map(normalizeHistoryActivityRecord);
  const notifications = normalizeAccounts(data.notifications);
  updateNotificationBadges(Math.max(0, Number(data.notificationUnreadCount) || 0));
  const allActivity = mergeCompletedBatchHistory(
    mergeNotificationHistory(activityRecords, notifications),
    historyBatches,
  );

  renderActivityHistoryRows(allActivity);
  setTextContentById("history-total-activity", formatWholeNumber(allActivity.length));
  setTextContentById("history-batch-events", formatWholeNumber(allActivity.filter((record) => record.entityType === "batch").length));
  setTextContentById("history-schedule-events", formatWholeNumber(allActivity.filter((record) => record.entityType === "schedule").length));
  setTextContentById("history-notification-events", formatWholeNumber(allActivity.filter((record) => record.entityType === "notification").length));
  setTextContentById("history-login-events", formatWholeNumber(allActivity.filter((record) => record.entityType === "account" && record.action === "login").length));
  renderActivityHistorySummary();
}

async function hydrateHistoryOverview() {
  if (state.currentPage !== "history") return;

  const userName = getAuthenticatedUser();
  const textMap = [
    ["history-user-name", userName],
    ["history-user-role", getRoleLabel()],
    ["history-user-avatar", initials(userName)],
  ];

  textMap.forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  });

  const cached = readUnifiedHistoryCache();
  if (cached?.data) renderUnifiedHistoryData(cached.data);

  try {
    const freshData = await loadUnifiedHistoryData({ forceRefresh: true });
    renderUnifiedHistoryData(freshData);
  } catch {
    if (!cached?.data) {
      const fallbackBatches = getAuthenticatedRole() === "admin" ? [] : getStoredUserBatches();
      renderUnifiedHistoryData({ batches: fallbackBatches, activity: [], notifications: [] });
    }
  }
}

// A timeline row is either a real activity log or a projection of live data. An
// activity log is the history itself, so it goes for good; a notification or a
// completed batch is only shown here, so the row leaves this account's timeline
// and the underlying record stays where it is.
function getHistoryEntryTarget(record) {
  const id = String(record?.id || "");
  if (id.startsWith("completed-batch-")) {
    return { entryType: "batch", entryId: id.slice("completed-batch-".length) };
  }
  if (id.startsWith("notification-history-")) {
    return { entryType: "notification", entryId: id.slice("notification-history-".length) };
  }
  return { entryType: "activity", entryId: id };
}

async function deleteHistoryEntry(record, button) {
  const target = getHistoryEntryTarget(record);
  if (!target.entryId) return;

  const presentation = getHistoryActivityPresentation(record);
  const result = await openActionDialog({
    eyebrow: "SmartDuck History",
    title: "Delete this history entry?",
    body: target.entryType === "activity"
      ? `"${presentation.title}" will be removed from the history for every account. This action cannot be undone.`
      : `"${presentation.title}" will be removed from your history timeline. The ${target.entryType === "batch" ? "batch record" : "notification"} itself stays in SmartDuck.`,
    confirmLabel: "Delete Entry",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!result.confirmed) return;

  button.disabled = true;
  try {
    await requestBackendJson(DELETE_HISTORY_ENDPOINT, {
      method: "POST",
      body: {
        username: getAuthenticatedUsername(),
        entryType: target.entryType,
        entryId: target.entryId,
      },
    });
    invalidateUnifiedHistoryCaches();
    const data = await loadUnifiedHistoryData({ forceRefresh: true });
    renderUnifiedHistoryData(data);
    showToast("History entry deleted", `"${presentation.title}" was removed from the timeline.`);
  } catch (error) {
    // The row is still on screen, so the button has to come back with it.
    button.disabled = false;
    await showWarningCard("Unable to delete entry", error.message || "That history entry could not be deleted.");
  }
}

async function deleteAllHistoryRecords(button) {
  const isAdmin = getAuthenticatedRole() === "admin";
  const result = await openActionDialog({
    eyebrow: "SmartDuck History",
    title: "Delete all history?",
    body: isAdmin
      ? "This will permanently clear the activity history for every SmartDuck account. Existing incubator and batch data will remain available. This action cannot be undone."
      : "This will permanently clear your SmartDuck activity history from the shared database. Existing incubator and batch data will remain available. This action cannot be undone.",
    confirmLabel: "Delete All",
    cancelLabel: "Cancel",
    tone: "danger",
  });
  if (!result.confirmed) return;

  button.disabled = true;
  try {
    await requestBackendJson(DELETE_HISTORY_ENDPOINT, {
      method: "POST",
      body: { username: getAuthenticatedUsername() },
    });
    invalidateUnifiedHistoryCaches();
    const data = await loadUnifiedHistoryData({ forceRefresh: true });
    renderUnifiedHistoryData(data);
    showToast(
      "History deleted",
      isAdmin ? "All SmartDuck activity history was cleared." : "Your SmartDuck activity history was cleared.",
    );
  } catch (error) {
    await showWarningCard("Unable to delete history", error.message || "History could not be deleted from the database.");
  } finally {
    button.disabled = false;
  }
}

function renderHistoryPagination() {
  if (state.currentPage !== "history" || !app.pageRoot) return;

  const rows = Array.from(app.pageRoot.querySelectorAll(".batch-history-table tbody tr"));
  const summary = app.pageRoot.querySelector(".batch-history-footer__copy");
  const pagination = app.pageRoot.querySelector(".batch-history-pagination");
  if (!summary || !pagination) return;
  if (!rows.length) {
    summary.textContent = "No completed batch records yet";
    pagination.innerHTML = "";
    return;
  }

  const totalEntries = rows.length;
  const pageSize = state.historyPagination.pageSize;
  const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));
  const currentPage = Math.min(Math.max(1, state.historyPagination.page), totalPages);
  state.historyPagination.page = currentPage;

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalEntries);

  rows.forEach((row, index) => {
    row.hidden = index < startIndex || index >= endIndex;
  });

  summary.textContent = `Showing ${startIndex + 1} to ${endIndex} of ${totalEntries} entries`;

  pagination.innerHTML = "";
  const buttons = [];

  const buildButton = ({ label, text, disabled = false, active = false, page = null }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `history-pagination__button${active ? " is-active" : ""}`;
    button.textContent = text;
    button.disabled = disabled;
    button.dataset.uiBound = "true";
    button.setAttribute("aria-label", label);
    if (page !== null) {
      button.dataset.historyPage = String(page);
    }
    if (active) {
      button.setAttribute("aria-current", "page");
    }
    button.addEventListener("click", () => {
      if (disabled || page === null || page === state.historyPagination.page) return;
      state.historyPagination.page = page;
      renderHistoryPagination();
    });
    return button;
  };

  buttons.push(
    buildButton({
      label: "Previous history page",
      text: "\u2039",
      disabled: currentPage === 1,
      page: currentPage - 1,
    }),
  );

  for (let page = 1; page <= totalPages; page += 1) {
    buttons.push(
      buildButton({
        label: `Go to history page ${page}`,
        text: String(page),
        active: page === currentPage,
        page,
      }),
    );
  }

  buttons.push(
    buildButton({
      label: "Next history page",
      text: "\u203A",
      disabled: currentPage === totalPages,
      page: currentPage + 1,
    }),
  );

  pagination.append(...buttons);
}

function getFallbackProfileFields() {
  const userName = getAuthenticatedUser();
  const userRole = getRoleLabel();
  const username = getAuthenticatedUsername() || userName.toLowerCase().replace(/\s+/g, "");
  return {
    name: userName,
    username,
    email: "",
    role: userRole,
    address: "",
    language: "English",
    timezone: "(GMT+08:00) Asia/Manila",
    memberSince: "Not available",
    lastConnected: "Never",
    avatarImage: "",
  };
}

function normalizeProfileFields(account, fallbackFields = getFallbackProfileFields()) {
  if (!account) return { ...fallbackFields };

  return {
    ...fallbackFields,
    name: getManagedAccountName(account),
    username: account.username || fallbackFields.username,
    email: account.email || fallbackFields.email,
    role: getManagedAccountRole(account),
    avatarImage: getManagedAccountAvatarImage(account),
  };
}

function getProfileDisplayUsername(fields) {
  return String(fields?.username || fields?.name || getAuthenticatedUsername() || getAuthenticatedUser()).trim() || "SmartDuck User";
}

function isValidProfileUsername(username) {
  return evaluateUsernamePolicy(username).valid;
}

function renderProfileAvatarNode(node, name, avatarImage, imageClass = "profile-quick-card__avatar-image") {
  if (!node) return;

  const displayName = String(name || "SmartDuck User").trim() || "SmartDuck User";
  const imageSrc = String(avatarImage || "").trim();
  node.classList.toggle("has-image", Boolean(imageSrc));

  if (imageSrc) {
    node.innerHTML = `<img class="${escapeHtml(imageClass)}" src="${escapeHtml(imageSrc)}" alt="${escapeHtml(displayName)}" />`;
    return;
  }

  node.innerHTML = "";
  node.textContent = initials(displayName);
}

function applyProfilePageFields(fields) {
  const textMap = [
    ["profile-user-name", fields.name],
    ["profile-user-role", fields.role],
    ["profile-card-name", fields.name],
    ["profile-card-role", fields.role],
    ["profile-card-email", fields.email],
    ["profile-card-address", fields.address],
    ["profile-card-member-since", fields.memberSince],
    ["profile-info-full-name", fields.name],
    ["profile-info-username", fields.username],
    ["profile-info-email", fields.email],
    ["profile-info-address", fields.address],
    ["profile-info-role", fields.role],
    ["profile-info-language", fields.language],
    ["profile-info-timezone", fields.timezone],
    ["profile-incubator-last-connected", fields.lastConnected],
  ];

  textMap.forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  });

  renderProfileAvatarNode(document.getElementById("profile-user-avatar"), fields.name, fields.avatarImage, "dashboard-userbox__avatar-image");
  renderProfileAvatarNode(document.getElementById("profile-card-avatar"), fields.name, fields.avatarImage, "profile-identity__avatar-image");
}

function applyHeaderProfileFields(fields) {
  document.querySelectorAll("#page-root .dashboard-userbox, .mobile-topbar__actions .dashboard-userbox").forEach((box) => {
    box.classList.add("dashboard-userbox--profile-trigger");

    const avatarNode = box.querySelector(".dashboard-userbox__avatar");
    const nameNode = box.querySelector(".dashboard-userbox__name");
    const roleNode = box.querySelector(".dashboard-userbox__role");
    const displayUsername = getProfileDisplayUsername(fields);

    renderProfileAvatarNode(avatarNode, displayUsername, fields.avatarImage, "dashboard-userbox__avatar-image");
    if (nameNode) nameNode.textContent = displayUsername;
    if (roleNode) roleNode.textContent = fields.role;
  });
}

function hydrateProfileOverview() {
  if (state.currentPage !== "profile") return;

  const fallbackFields = getFallbackProfileFields();
  applyProfilePageFields(fallbackFields);

  findAccountByUsername(fallbackFields.username)
    .then((account) => {
      if (!account || state.currentPage !== "profile") return;
      applyProfilePageFields(normalizeProfileFields(account, fallbackFields));
    })
    .catch(() => {});
}

function hydrateTopProfilePanel() {
  if (!app.pageRoot) return;

  const fallbackFields = getFallbackProfileFields();
  state.profileQuick.fields = fallbackFields;
  applyHeaderProfileFields(fallbackFields);
  renderProfileQuickCard(fallbackFields);

  if (!fallbackFields.username) return;

  findAccountByUsername(fallbackFields.username)
    .then((account) => {
      if (!account) return;
      const fields = normalizeProfileFields(account, fallbackFields);
      state.profileQuick.fields = fields;
      applyHeaderProfileFields(fields);
      applyProfilePageFields(fields);
      renderProfileQuickCard(fields);
    })
    .catch(() => {});
}

function getProfileTrigger() {
  return app.pageRoot?.querySelector(".dashboard-userbox")
    || document.querySelector(".mobile-topbar__actions .dashboard-userbox")
    || null;
}

function getProfileCardHost() {
  // The mobile shell relocates the live trigger into its compact top bar, but
  // the profile panels remain in their original page toolbar. Reuse that host
  // after relocation instead of treating the control as missing.
  const existingPanel = document.getElementById("profile-quick-card")
    || document.getElementById("profile-password-card");
  if (existingPanel?.parentElement) return existingPanel.parentElement;

  const trigger = getProfileTrigger();
  if (!trigger) return null;
  const host = trigger.closest(".dashboard-toolbar, .settings-topbar") || trigger.parentElement;
  if (host instanceof HTMLElement) host.classList.add("profile-card-host");
  return host;
}

function getProfileQuickCard() {
  return getProfileCardHost()?.querySelector("#profile-quick-card") || null;
}

function getProfilePasswordCard() {
  return getProfileCardHost()?.querySelector("#profile-password-card") || null;
}

function setProfileTriggerExpanded(isExpanded) {
  const trigger = getProfileTrigger();
  if (!trigger) return;
  trigger.classList.toggle("is-open", Boolean(isExpanded));
  trigger.setAttribute("aria-expanded", String(Boolean(isExpanded)));
}

function closeProfileQuickCard() {
  const panel = getProfileQuickCard();
  const passwordPanel = getProfilePasswordCard();

  if (panel) {
    resetProfileQuickUsernameDraft(panel);
    panel.hidden = true;
    panel.classList.remove("is-open");
  }
  if (passwordPanel) {
    passwordPanel.hidden = true;
    passwordPanel.classList.remove("is-open");
  }
  setProfileTriggerExpanded(false);
}

function toggleProfileQuickCard() {
  let panel = getProfileQuickCard();
  const passwordPanel = getProfilePasswordCard();
  if (!panel) {
    renderProfileQuickCard(state.profileQuick.fields || getFallbackProfileFields());
    panel = getProfileQuickCard();
  }
  if (!panel) return false;

  const willOpen = panel.hidden && (!passwordPanel || passwordPanel.hidden);
  if (passwordPanel) {
    passwordPanel.hidden = true;
    passwordPanel.classList.remove("is-open");
  }
  if (!willOpen) resetProfileQuickUsernameDraft(panel);
  panel.hidden = !willOpen;
  panel.classList.toggle("is-open", willOpen);
  setProfileTriggerExpanded(willOpen);
  if (willOpen) {
    window.setTimeout(() => panel.querySelector("[data-profile-username-input]")?.focus(), 0);
  }
  return true;
}

function bindProfileQuickCardDismissal() {
  if (document.documentElement.dataset.profileQuickDismissalBound === "true") return;
  document.documentElement.dataset.profileQuickDismissalBound = "true";

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".dashboard-userbox, .profile-quick-card, .profile-password-card")) return;
    closeProfileQuickCard();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeProfileQuickCard();
  });
}

function setProfileInlineStatus(panel, title, message, tone = "info") {
  const status = panel?.querySelector("[data-profile-status]");
  if (!status) return;
  const titleNode = status.querySelector("[data-profile-status-title]");
  const messageNode = status.querySelector("[data-profile-status-message]");
  if (titleNode) titleNode.textContent = title;
  if (messageNode) messageNode.textContent = message;
  status.dataset.tone = tone;
  status.hidden = false;
}

function hideProfileInlineStatus(panel) {
  const status = panel?.querySelector("[data-profile-status]");
  if (status) status.hidden = true;
}

function resetProfileQuickUsernameDraft(panel = getProfileQuickCard()) {
  const usernameInput = panel?.querySelector("[data-profile-username-input]");
  if (!(usernameInput instanceof HTMLInputElement)) return;

  usernameInput.value = getProfileDisplayUsername(state.profileQuick.fields || getFallbackProfileFields());
  setInputInvalid(usernameInput, false);
  hideProfileInlineStatus(panel);
  renderCredentialSecurityGuide(usernameInput);
}

function isProfilePasswordAllowed(role = getAuthenticatedRole()) {
  return role === "admin";
}

function renderProfileAvatarMarkup(fields, imageClass = "profile-quick-card__avatar-image") {
  const name = getProfileDisplayUsername(fields);
  if (fields.avatarImage) {
    return `<img class="${escapeHtml(imageClass)}" src="${escapeHtml(fields.avatarImage)}" alt="${escapeHtml(name)}" />`;
  }
  return escapeHtml(initials(name));
}

async function resolveAuthenticatedAccount() {
  const username = state.profileQuick.fields?.username || getAuthenticatedUsername();
  if (!username) return null;
  return findAccountByUsername(username);
}

async function handleProfileQuickSave(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const panel = form.closest(".profile-quick-card");
  const usernameInput = form.querySelector("[data-profile-username-input]");
  const saveButton = form.querySelector("[data-profile-save]");
  const nextUsername = String(usernameInput?.value || "").trim();
  const currentUsername = String(state.profileQuick.fields?.username || getAuthenticatedUsername() || "").trim();
  const usernameChanged = nextUsername !== currentUsername;

  hideProfileInlineStatus(panel);
  setInputInvalid(usernameInput, false);

  if (!nextUsername) {
    setInputInvalid(usernameInput, true);
    setProfileInlineStatus(panel, "Username required", "Enter the username before saving.", "danger");
    usernameInput?.focus();
    return;
  }

  if (usernameChanged && !isValidProfileUsername(nextUsername)) {
    setInputInvalid(usernameInput, true);
    setProfileInlineStatus(panel, "Username is not secure yet", firstCredentialPolicyError(evaluateUsernamePolicy(nextUsername)), "danger");
    usernameInput?.focus();
    return;
  }

  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
  }

  try {
    const account = await resolveAuthenticatedAccount();
    const updatedAccount = account
      ? await updateAccountRecord(account.username, { username: nextUsername })
      : null;
    const fields = updatedAccount
      ? normalizeProfileFields(updatedAccount)
      : { ...getFallbackProfileFields(), ...state.profileQuick.fields, username: nextUsername };

    // The backend has moved the live session and re-signed the auth cookie onto
    // the new username. This tab must follow in the same breath, or the session
    // watcher sees a mismatch and announces a spurious account switch.
    sessionStorage.setItem(USERNAME_KEY, fields.username);
    if (updatedAccount?.name) sessionStorage.setItem(USER_KEY, updatedAccount.name);
    state.profileQuick.fields = fields;
    applyHeaderProfileFields(fields);
    applyProfilePageFields(fields);
    renderProfileQuickCard(fields);
    showToast("Username updated", "Your SmartDuck username has been saved.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update the profile.";
    setProfileInlineStatus(panel, "Update failed", message, "danger");
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = "Save Profile";
    }
  }
}

async function handleProfileAvatarSelection(event) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;

  const panel = input.closest(".profile-quick-card");
  const file = input.files?.[0] || null;
  if (!file) return;

  hideProfileInlineStatus(panel);

  const avatarButton = panel?.querySelector("[data-profile-avatar-button]");
  if (avatarButton) avatarButton.disabled = true;

  try {
    const account = await resolveAuthenticatedAccount();
    if (!account) {
      throw new Error("No saved account was found for this session.");
    }

    const avatarImage = await buildManagedAvatarImageDataUrl(file);
    const updatedAccount = await updateAccountRecord(account.username, { avatarImage });
    const fields = normalizeProfileFields(updatedAccount || { ...account, avatarImage });

    state.profileQuick.fields = fields;
    applyHeaderProfileFields(fields);
    applyProfilePageFields(fields);
    renderProfileQuickCard(fields);
    showToast("Profile photo updated", "Your new profile picture has been saved.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to upload the profile picture.";
    setProfileInlineStatus(panel, "Upload failed", message, "danger");
  } finally {
    input.value = "";
    if (avatarButton) avatarButton.disabled = false;
  }
}

function bindProfileQuickCardControls(panel) {
  const closeButton = panel.querySelector("[data-profile-quick-close]");
  if (closeButton) {
    closeButton.dataset.uiBound = "true";
    closeButton.onclick = closeProfileQuickCard;
  }

  const form = panel.querySelector("[data-profile-quick-form]");
  if (form) {
    form.onsubmit = (event) => {
      void handleProfileQuickSave(event);
    };
  }

  const usernameInput = panel.querySelector("[data-profile-username-input]");
  usernameInput?.addEventListener("input", () => {
    setInputInvalid(usernameInput, false);
    hideProfileInlineStatus(panel);
  });

  const avatarButton = panel.querySelector("[data-profile-avatar-button]");
  const avatarInput = panel.querySelector("[data-profile-avatar-input]");
  avatarButton?.addEventListener("click", () => avatarInput?.click());
  avatarInput?.addEventListener("change", (event) => {
    void handleProfileAvatarSelection(event);
  });

  const passwordButton = panel.querySelector("[data-profile-password-open]");
  passwordButton?.addEventListener("click", () => {
    void openProfilePasswordCard();
  });
}

function setProfilePasswordBusy(panel, isBusy) {
  state.profileQuick.password.isSendingOtp = Boolean(isBusy);
  const nextButton = panel?.querySelector("[data-profile-password-next]");
  const resendButton = panel?.querySelector("[data-profile-password-resend]");
  const submitButton = panel?.querySelector("[data-profile-password-submit]");
  if (nextButton) {
    nextButton.disabled = Boolean(isBusy);
    nextButton.textContent = isBusy ? "Sending OTP..." : "Next";
  }
  if (resendButton) {
    resendButton.disabled = Boolean(isBusy);
    resendButton.textContent = isBusy ? "Sending OTP..." : "Resend OTP";
  }
  if (submitButton) {
    submitButton.disabled = Boolean(isBusy);
  }
}

function showProfilePasswordDevOtp(panel, code) {
  const devOtp = panel?.querySelector("[data-profile-password-dev-otp]");
  const codeNode = panel?.querySelector("[data-profile-password-dev-code]");
  if (!devOtp || !codeNode) return;
  codeNode.textContent = code;
  devOtp.hidden = false;
}

function hideProfilePasswordDevOtp(panel) {
  const devOtp = panel?.querySelector("[data-profile-password-dev-otp]");
  const codeNode = panel?.querySelector("[data-profile-password-dev-code]");
  if (devOtp) devOtp.hidden = true;
  if (codeNode) codeNode.textContent = "";
}

function getProfilePasswordOtpInputs(panel = getProfilePasswordCard()) {
  return Array.from(panel?.querySelectorAll("[data-profile-password-otp-input]") || []);
}

function readProfilePasswordOtpValue(panel = getProfilePasswordCard()) {
  return getProfilePasswordOtpInputs(panel).map((input) => input.value.trim()).join("");
}

function setProfilePasswordOtpInvalid(panel, isInvalid) {
  getProfilePasswordOtpInputs(panel).forEach((input) => setInputInvalid(input, isInvalid));
}

function fillProfilePasswordOtpInputs(panel, code) {
  const digits = String(code || "").replace(/\D/g, "").slice(0, 6).split("");
  getProfilePasswordOtpInputs(panel).forEach((input, index) => {
    input.value = digits[index] || "";
  });
}

function focusProfilePasswordOtpInput(panel, index = 0) {
  const inputs = getProfilePasswordOtpInputs(panel);
  const target = inputs[Math.max(0, Math.min(index, inputs.length - 1))];
  target?.focus();
  target?.select?.();
}

function renderProfilePasswordOtpBoxes(value = "") {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 6).split("");
  return Array.from({ length: 6 }, (_, index) => `
    <input
      class="profile-password-otp-box"
      type="text"
      inputmode="numeric"
      maxlength="1"
      autocomplete="${index === 0 ? "one-time-code" : "off"}"
      aria-label="OTP digit ${index + 1}"
      value="${escapeHtml(digits[index] || "")}"
      data-profile-password-otp-input
    />
  `).join("");
}

function applyProfilePasswordOtpDelivery(panel, payload, email = state.profileQuick.password.email) {
  hideProfilePasswordDevOtp(panel);
  setProfilePasswordOtpInvalid(panel, false);

  if (payload?.deliveryMode === "development" && payload.developmentCode) {
    showProfilePasswordDevOtp(panel, payload.developmentCode);
    fillProfilePasswordOtpInputs(panel, payload.developmentCode);
    setProfileInlineStatus(panel, "OTP ready", "Use the OTP shown below before updating the password.", "success");
  } else {
    fillProfilePasswordOtpInputs(panel, "");
    setProfileInlineStatus(panel, "OTP sent", `Check ${maskEmail(email)} for the 6-digit code.`, "success");
  }

  window.setTimeout(() => focusProfilePasswordOtpInput(panel, 0), 0);
}

async function requestProfilePasswordOtp(panel) {
  const email = state.profileQuick.password.email;
  if (!email) {
    setProfileInlineStatus(panel, "Gmail required", "A valid Gmail address is required before sending an OTP code.", "danger");
    return null;
  }

  hideProfileInlineStatus(panel);
  hideProfilePasswordDevOtp(panel);
  setProfilePasswordBusy(panel, true);
  setProfileInlineStatus(panel, "Sending OTP", `Preparing the verification code for ${maskEmail(email)}.`, "info");

  try {
    const payload = await requestOtpDelivery(email, OTP_PURPOSE_PASSWORD_RESET);
    state.profileQuick.password.delivery = payload;
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send OTP code.";
    setProfileInlineStatus(panel, "OTP send failed", message, "danger");
    return null;
  } finally {
    setProfilePasswordBusy(panel, false);
  }
}

async function handleProfilePasswordNext(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const panel = form.closest(".profile-password-card");
  const account = state.profileQuick.password.account;
  const passwordInput = form.querySelector("[data-profile-password-new]");
  const confirmInput = form.querySelector("[data-profile-password-confirm]");
  const nextPassword = String(passwordInput?.value || "");
  const confirmPassword = String(confirmInput?.value || "");

  hideProfileInlineStatus(panel);
  hideProfilePasswordDevOtp(panel);
  [passwordInput, confirmInput].forEach((input) => setInputInvalid(input, false));

  if (!account) {
    setProfileInlineStatus(panel, "Account missing", "Open the profile card again before changing the password.", "danger");
    return;
  }

  const passwordPolicy = evaluatePasswordPolicy(nextPassword, {
    username: account.username,
    email: account.email,
  });
  if (!nextPassword || !passwordPolicy.valid) {
    setInputInvalid(passwordInput, true);
    setProfileInlineStatus(panel, "Password is not secure yet", firstCredentialPolicyError(passwordPolicy), "danger");
    passwordInput?.focus();
    return;
  }

  if (nextPassword !== confirmPassword) {
    setInputInvalid(passwordInput, true);
    setInputInvalid(confirmInput, true);
    setProfileInlineStatus(panel, "Passwords do not match", "The new password and confirm password must be the same.", "danger");
    confirmInput?.focus();
    return;
  }

  if (!isValidGmailAddress(account.email || "")) {
    setProfileInlineStatus(panel, "Gmail required", "A valid Gmail address is required before sending an OTP code.", "danger");
    return;
  }

  state.profileQuick.password.pendingPassword = nextPassword;
  state.profileQuick.password.email = account.email;

  const payload = await requestProfilePasswordOtp(panel);
  if (!payload) return;

  state.profileQuick.password.step = "otp";
  const otpPanel = renderProfilePasswordCard(state.profileQuick.fields || getFallbackProfileFields(), "otp");
  if (!otpPanel) return;
  otpPanel.hidden = false;
  otpPanel.classList.add("is-open");
  setProfileTriggerExpanded(true);
  applyProfilePasswordOtpDelivery(otpPanel, payload, account.email);
}

async function handleProfilePasswordSubmit(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const panel = form.closest(".profile-password-card");
  const account = state.profileQuick.password.account;
  const submitButton = form.querySelector("[data-profile-password-submit]");
  const otpCode = readProfilePasswordOtpValue(panel).replace(/\D/g, "").slice(0, 6);
  const nextPassword = String(state.profileQuick.password.pendingPassword || "");

  hideProfileInlineStatus(panel);
  setProfilePasswordOtpInvalid(panel, false);

  if (!account) {
    setProfileInlineStatus(panel, "Account missing", "Open the profile card again before changing the password.", "danger");
    return;
  }

  if (state.profileQuick.password.isSendingOtp) {
    setProfileInlineStatus(panel, "OTP still sending", "Wait for the OTP request to finish before verifying.", "danger");
    return;
  }

  if (otpCode.length !== 6) {
    setProfilePasswordOtpInvalid(panel, true);
    setProfileInlineStatus(panel, "OTP required", "Enter the full 6-digit OTP code.", "danger");
    focusProfilePasswordOtpInput(panel, 0);
    return;
  }

  const passwordPolicy = evaluatePasswordPolicy(nextPassword, {
    username: account.username,
    email: account.email,
  });
  if (!nextPassword || !passwordPolicy.valid) {
    state.profileQuick.password.step = "details";
    const detailsPanel = renderProfilePasswordCard(state.profileQuick.fields || getFallbackProfileFields(), "details");
    if (detailsPanel) {
      detailsPanel.hidden = false;
      detailsPanel.classList.add("is-open");
      setProfileInlineStatus(detailsPanel, "Password is not secure yet", firstCredentialPolicyError(passwordPolicy), "danger");
    }
    return;
  }

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Verifying...";
  }

  try {
    const otpResult = await verifyOtpCode(state.profileQuick.password.email, otpCode);
    if (!otpResult.success) {
      setProfilePasswordOtpInvalid(panel, true);
      setProfileInlineStatus(panel, "Incorrect OTP", "Use the latest OTP code before saving the new password.", "danger");
      focusProfilePasswordOtpInput(panel, 0);
      return;
    }

    if (submitButton) submitButton.textContent = "Saving...";
    await updateAccountPassword(account.username, nextPassword);
    closeProfileQuickCard();
    showToast("Password changed", "Your SmartDuck password has been updated.");
    await showSuccessCard("Password changed", "Your new password was saved after OTP verification.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update the password.";
    setProfileInlineStatus(panel, "Password update failed", message, "danger");
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Update Password";
    }
  }
}

function bindProfilePasswordCardControls(panel) {
  panel.querySelector("[data-profile-password-close]")?.addEventListener("click", closeProfileQuickCard);
  panel.querySelector("[data-profile-password-cancel]")?.addEventListener("click", closeProfileQuickCard);
  panel.querySelector("[data-profile-password-back]")?.addEventListener("click", () => {
    if (state.profileQuick.password.step === "otp") {
      state.profileQuick.password.step = "details";
      const detailsPanel = renderProfilePasswordCard(state.profileQuick.fields || getFallbackProfileFields(), "details");
      if (detailsPanel) {
        detailsPanel.hidden = false;
        detailsPanel.classList.add("is-open");
        window.setTimeout(() => detailsPanel.querySelector("[data-profile-password-new]")?.focus(), 0);
      }
    } else {
      panel.hidden = true;
      panel.classList.remove("is-open");
      const quickPanel = getProfileQuickCard();
      if (quickPanel) {
        quickPanel.hidden = false;
        quickPanel.classList.add("is-open");
      }
    }
    setProfileTriggerExpanded(true);
  });
  panel.querySelector("[data-profile-password-resend]")?.addEventListener("click", () => {
    void requestProfilePasswordOtp(panel).then((payload) => {
      if (payload) applyProfilePasswordOtpDelivery(panel, payload);
    });
  });
  panel.querySelector("[data-profile-password-details-form]")?.addEventListener("submit", (event) => {
    void handleProfilePasswordNext(event);
  });
  panel.querySelector("[data-profile-password-otp-form]")?.addEventListener("submit", (event) => {
    void handleProfilePasswordSubmit(event);
  });
  panel.querySelectorAll("[data-profile-password-new], [data-profile-password-confirm]").forEach((input) => {
    input.addEventListener("input", () => {
      setInputInvalid(input, false);
      hideProfileInlineStatus(panel);
    });
  });
  panel.querySelectorAll("[data-profile-password-visibility]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const input = button.closest(".profile-password-input-wrap")?.querySelector("input");
      if (!input) return;
      const shouldShow = input.type === "password";
      input.type = shouldShow ? "text" : "password";
      button.setAttribute("aria-pressed", String(shouldShow));
      button.setAttribute("aria-label", `${shouldShow ? "Hide" : "Show"} ${button.dataset.profilePasswordVisibility || "password"}`);
      button.innerHTML = renderIcon(shouldShow ? "eye-off" : "eye");
    });
  });
  const otpInputs = getProfilePasswordOtpInputs(panel);
  otpInputs.forEach((input, index) => {
    input.addEventListener("input", () => {
      const digits = input.value.replace(/\D/g, "").slice(0, 6);
      if (digits.length > 1) {
        digits.split("").forEach((digit, offset) => {
          const target = otpInputs[index + offset];
          if (target) target.value = digit;
        });
        focusProfilePasswordOtpInput(panel, Math.min(index + digits.length, otpInputs.length - 1));
      } else {
        input.value = digits;
        if (digits && index < otpInputs.length - 1) {
          focusProfilePasswordOtpInput(panel, index + 1);
        }
      }
      setProfilePasswordOtpInvalid(panel, false);
      hideProfileInlineStatus(panel);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        focusProfilePasswordOtpInput(panel, index - 1);
        return;
      }
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        focusProfilePasswordOtpInput(panel, index - 1);
        return;
      }
      if (event.key === "ArrowRight" && index < otpInputs.length - 1) {
        event.preventDefault();
        focusProfilePasswordOtpInput(panel, index + 1);
      }
    });

    input.addEventListener("paste", (event) => {
      event.preventDefault();
      const code = event.clipboardData?.getData("text") || "";
      fillProfilePasswordOtpInputs(panel, code);
      const length = Math.min(code.replace(/\D/g, "").length, otpInputs.length);
      focusProfilePasswordOtpInput(panel, Math.max(length - 1, 0));
      setProfilePasswordOtpInvalid(panel, false);
      hideProfileInlineStatus(panel);
    });
  });
}

function renderProfilePasswordCard(fields, step = state.profileQuick.password.step || "details") {
  const host = getProfileCardHost();
  if (!host) return null;

  let panel = host.querySelector("#profile-password-card");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "profile-password-card";
    panel.className = "profile-password-card";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Change password");
    host.appendChild(panel);
  }

  const isOtpStep = step === "otp";
  const maskedEmail = maskEmail(state.profileQuick.password.email || "your Gmail address");
  const pendingPassword = state.profileQuick.password.pendingPassword || "";
  const detailsMarkup = `
    <form class="profile-password-form" data-profile-password-details-form novalidate>
      <div class="profile-quick-field-control">
        <label for="profile-password-new">New Password</label>
        <div class="profile-password-input-wrap">
          <input id="profile-password-new" class="profile-quick-input" type="password" autocomplete="new-password" minlength="8" maxlength="64" value="${escapeHtml(pendingPassword)}" data-profile-password-new data-credential-security="password" />
          <button type="button" class="profile-password-visibility" data-profile-password-visibility="new password" aria-controls="profile-password-new" aria-label="Show new password" aria-pressed="false">${renderIcon("eye")}</button>
        </div>
      </div>

      <div class="profile-quick-field-control">
        <label for="profile-password-confirm">Confirm Password</label>
        <div class="profile-password-input-wrap">
          <input id="profile-password-confirm" class="profile-quick-input" type="password" autocomplete="new-password" minlength="8" maxlength="64" value="${escapeHtml(pendingPassword)}" data-profile-password-confirm />
          <button type="button" class="profile-password-visibility" data-profile-password-visibility="confirm password" aria-controls="profile-password-confirm" aria-label="Show confirm password" aria-pressed="false">${renderIcon("eye")}</button>
        </div>
      </div>

      <div class="profile-password-card__actions profile-password-card__actions--details">
        <button type="button" class="profile-quick-action profile-quick-action--secondary" data-profile-password-cancel>Cancel</button>
        <button type="submit" class="profile-quick-action" data-profile-password-next>Next</button>
      </div>
    </form>
  `;
  const otpMarkup = `
    <div class="profile-password-dev-otp" data-profile-password-dev-otp hidden>
      <span>OTP</span>
      <strong data-profile-password-dev-code></strong>
    </div>

    <form class="profile-password-form" data-profile-password-otp-form novalidate>
      <div class="profile-password-otp-grid" role="group" aria-label="6-digit OTP code">
        ${renderProfilePasswordOtpBoxes()}
      </div>

      <div class="profile-password-card__actions profile-password-card__actions--otp">
        <button type="button" class="profile-quick-action profile-quick-action--secondary" data-profile-password-cancel>Cancel</button>
        <button type="button" class="profile-quick-action profile-quick-action--secondary" data-profile-password-resend>Resend OTP</button>
        <button type="submit" class="profile-quick-action" data-profile-password-submit>Update Password</button>
      </div>
    </form>
  `;

  panel.innerHTML = `
    <div class="profile-password-card__top">
      <button type="button" class="profile-password-card__back" data-profile-password-back aria-label="Back to profile">
        ${renderIcon("chevron-right")}
        <span>Back</span>
      </button>
      <button type="button" class="profile-quick-card__close" data-profile-password-close aria-label="Close password card">
        ${renderIcon("x-circle")}
      </button>
    </div>

    <div class="profile-password-card__heading">
      <div class="profile-password-card__icon">${renderIcon("lock")}</div>
      <div>
        <p class="profile-quick-card__eyebrow">Security</p>
        <h3 class="profile-quick-card__name">${isOtpStep ? "Enter OTP Code" : "Change Password"}</h3>
        <p class="profile-password-card__copy">${isOtpStep ? `Type the 6-digit code sent to ${escapeHtml(maskedEmail)}.` : "Enter the new password first. The OTP is sent only after Next."}</p>
      </div>
    </div>

    <div class="profile-inline-status" data-profile-status hidden>
      <strong data-profile-status-title></strong>
      <span data-profile-status-message></span>
    </div>

    ${isOtpStep ? otpMarkup : detailsMarkup}
  `;

  state.profileQuick.password.step = isOtpStep ? "otp" : "details";
  bindProfilePasswordCardControls(panel);
  bindCredentialSecurityGuides(panel);
  hydrateIcons(panel);
  return panel;
}

async function openProfilePasswordCard() {
  if (!isProfilePasswordAllowed()) return;

  const account = await resolveAuthenticatedAccount();
  if (!account) {
    await showWarningCard("Account missing", "Your SmartDuck account could not be found for password update.");
    return;
  }

  const fields = normalizeProfileFields(account);
  state.profileQuick.fields = fields;
  state.profileQuick.password = {
    account: {
      username: account.username,
      name: getManagedAccountName(account),
      email: account.email,
    },
    email: account.email,
    delivery: null,
    isSendingOtp: false,
    pendingPassword: "",
    step: "details",
  };

  const quickPanel = getProfileQuickCard();
  if (quickPanel) {
    quickPanel.hidden = true;
    quickPanel.classList.remove("is-open");
  }

  const panel = renderProfilePasswordCard(fields);
  if (!panel) return;

  panel.hidden = false;
  panel.classList.add("is-open");
  setProfileTriggerExpanded(true);
  window.setTimeout(() => panel.querySelector("[data-profile-password-new]")?.focus(), 0);
}

function renderProfileQuickCard(fields) {
  if (!app.pageRoot) return;
  const toolbar = getProfileCardHost();
  const trigger = getProfileTrigger();
  if (!toolbar || !trigger) return;

  let panel = toolbar.querySelector("#profile-quick-card");
  const shouldStayOpen = Boolean(panel && !panel.hidden);
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "profile-quick-card";
    panel.className = "profile-quick-card";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Profile details");
    toolbar.appendChild(panel);
  }

  const name = getProfileDisplayUsername(fields);
  const role = fields.role || getRoleLabel();
  const canChangePassword = isProfilePasswordAllowed();

  panel.innerHTML = `
    <div class="profile-quick-card__top">
      <button type="button" class="profile-quick-card__avatar-button" data-profile-avatar-button aria-label="Upload profile picture">
        <span class="profile-quick-card__avatar${fields.avatarImage ? " has-image" : ""}">${renderProfileAvatarMarkup(fields)}</span>
        <span class="profile-quick-card__camera">${renderIcon("camera")}</span>
      </button>
      <input class="profile-quick-card__file" type="file" accept="image/*" data-profile-avatar-input hidden />
      <div class="profile-quick-card__identity">
        <p class="profile-quick-card__eyebrow">Profile</p>
        <h3 class="profile-quick-card__name">${escapeHtml(name)}</h3>
        <span class="profile-quick-card__role">${escapeHtml(role)}</span>
      </div>
      <button type="button" class="profile-quick-card__close" data-profile-quick-close aria-label="Close profile details">
        ${renderIcon("x-circle")}
      </button>
    </div>

    <div class="profile-inline-status" data-profile-status hidden>
      <strong data-profile-status-title></strong>
      <span data-profile-status-message></span>
    </div>

    <form class="profile-quick-form" data-profile-quick-form novalidate>
      <label class="profile-quick-field-control" for="profile-quick-username">
        <span>Username</span>
        <input id="profile-quick-username" class="profile-quick-input" type="text" value="${escapeHtml(getProfileDisplayUsername(fields))}" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="2" maxlength="30" data-profile-username-input data-credential-security="username" />
      </label>
      <button type="submit" class="profile-quick-action" data-profile-save>
        ${renderIcon("edit")}
        <span>Save Profile</span>
      </button>
    </form>

    ${canChangePassword ? `
      <button type="button" class="profile-quick-action profile-quick-action--wide" data-profile-password-open>
        ${renderIcon("lock")}
        <span>Change Password</span>
      </button>
    ` : ""}
  `;

  panel.hidden = !shouldStayOpen;
  panel.classList.toggle("is-open", shouldStayOpen);
  trigger.setAttribute("aria-controls", "profile-quick-card");
  trigger.setAttribute("aria-expanded", String(shouldStayOpen));
  bindProfileQuickCardControls(panel);
  bindProfileQuickCardDismissal();
  bindCredentialSecurityGuides(panel);
  hydrateIcons(panel);
}

function isReportsScreen() {
  return (state.currentPage === "batch" && document.body.classList.contains("admin-reports-page"))
    || (state.currentPage === "reports" && document.body.classList.contains("user-reports-page"));
}

function normalizeReportKind(value = "") {
  const lower = String(value).toLowerCase();
  if (lower.includes("production")) return "production";
  if (lower.includes("alert")) return "alert";
  return "batch";
}

/* Report datasets contain arrays of primitive cell values. The account
   normalizer clones every array item with object spread, which turns strings
   into character-keyed objects and ultimately exports "[object Object]".
   Keep report arrays intact and only normalize their container shape here. */
function normalizeReportList(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined);
  if (value && typeof value === "object") return Object.values(value).filter((item) => item !== null && item !== undefined);
  return [];
}

function normalizeReportDatasetForExport(dataset = {}, kind = "batch", reportId = "") {
  const source = dataset && typeof dataset === "object" ? dataset : {};
  let headers = normalizeReportList(source.headers).map((value) => normalizeReportExportValue(value));
  let rows = normalizeReportList(source.rows).map((row) => (
    normalizeReportList(row).map((value) => formatReportCellValue(value))
  ));
  const timeline = normalizeReportList(source.timeline).map((row) => (
    normalizeReportList(row).map((value) => formatReportCellValue(value))
  ));
  const summary = normalizeReportList(source.summary).map((item) => ({
    label: normalizeReportExportValue(item?.label),
    value: formatReportCellValue(item?.value),
  })).filter((item) => item.label);

  if (!rows.length && timeline.length) rows = timeline.map((row) => [...row]);
  if (!rows.length && summary.length) {
    headers = ["Metric", "Value"];
    rows = summary.map((item) => [item.label, item.value]);
  }
  if (!rows.length) {
    headers = ["Report ID", "Status"];
    rows = [[normalizeReportExportValue(source.reportId || reportId || "SmartDuck"), "No detailed records available"]];
  }
  if (!headers.length && rows.length) {
    headers = Array.from({ length: Math.max(...rows.map((row) => row.length), 1) }, (_, index) => `Column ${index + 1}`);
  }
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 1);
  if (!headers.length) headers = ["Report Details"];
  while (headers.length < columnCount) headers.push(`Column ${headers.length + 1}`);
  rows = rows.map((row) => Array.from({ length: headers.length }, (_, index) => row[index] ?? ""));

  return {
    ...source,
    title: normalizeReportExportValue(source.title || getReportTypeLabel(kind)),
    subtitle: normalizeReportExportValue(source.subtitle || "Verified SmartDuck database records."),
    reportId: normalizeReportExportValue(source.reportId || reportId),
    headers,
    rows,
    summary,
    timeline,
    monitoring: normalizeReportMonitoring(source.monitoring),
    alerts: normalizeReportAlerts(source.alerts),
    production: normalizeReportProduction(source.production),
    sources: normalizeReportList(source.sources).map((value) => normalizeReportExportValue(value)),
  };
}

/* Alert reports carry their own aggregate block: the KPI counts, the per-day
   series behind the chart and the type split behind the distribution ring. It
   is built once in the backend so the cards, the chart and the history table
   in an export can never disagree with each other. */
function normalizeReportAlerts(value) {
  const source = value && typeof value === "object" ? value : {};
  const count = (candidate) => Math.max(0, Number.parseInt(candidate || "0", 10) || 0);
  return {
    total: count(source.total),
    temperature: count(source.temperature),
    humidity: count(source.humidity),
    system: count(source.system),
    active: count(source.active),
    resolved: count(source.resolved),
    perDay: normalizeReportList(source.perDay).map((entry) => ({
      label: normalizeReportExportValue(entry?.label),
      day: count(entry?.day),
      total: count(entry?.total),
      temperature: count(entry?.temperature),
      humidity: count(entry?.humidity),
      system: count(entry?.system),
    })).filter((entry) => entry.label),
  };
}

/* The production report's aggregate block: one entry per batch plus the totals
   behind the KPI band. Built in the backend so the cards, the per-batch chart
   and the all-batches table always agree. */
function normalizeReportProduction(value) {
  const source = value && typeof value === "object" ? value : {};
  const count = (candidate) => Math.max(0, Number.parseInt(candidate || "0", 10) || 0);
  const rate = (candidate) => (Number.isFinite(Number(candidate)) ? Number(candidate) : 0);
  return {
    totalBatches: count(source.totalBatches),
    totalEggsSet: count(source.totalEggsSet),
    totalHarvested: count(source.totalHarvested),
    totalRejected: count(source.totalRejected),
    averageHarvestRate: rate(source.averageHarvestRate),
    incubatorCapacity: count(source.incubatorCapacity),
    periodStart: normalizeReportExportValue(source.periodStart),
    periodEnd: normalizeReportExportValue(source.periodEnd),
    batches: normalizeReportList(source.batches).map((entry) => ({
      index: count(entry?.index),
      batchId: normalizeReportExportValue(entry?.batchId),
      status: normalizeReportExportValue(entry?.status),
      startDate: normalizeReportExportValue(entry?.startDate),
      endDate: normalizeReportExportValue(entry?.endDate),
      eggsSet: count(entry?.eggsSet),
      harvested: count(entry?.harvested),
      rejected: count(entry?.rejected),
      harvestRate: rate(entry?.harvestRate),
    })).filter((entry) => entry.batchId),
    chart: normalizeReportList(source.chart).map((entry) => ({
      label: normalizeReportExportValue(entry?.label),
      harvested: count(entry?.harvested),
      rejected: count(entry?.rejected),
      harvestRate: rate(entry?.harvestRate),
    })).filter((entry) => entry.label),
  };
}

function normalizeReportMonitoring(value) {
  const source = value && typeof value === "object" ? value : {};
  const normalizeMetric = (metric) => {
    const input = metric && typeof metric === "object" ? metric : {};
    const numberOrNull = (candidate) => candidate !== null && candidate !== undefined && candidate !== "" && Number.isFinite(Number(candidate))
      ? Number(candidate)
      : null;
    return {
      average: numberOrNull(input.average),
      minimum: numberOrNull(input.minimum),
      maximum: numberOrNull(input.maximum),
      targetMinimum: numberOrNull(input.targetMinimum),
      targetMaximum: numberOrNull(input.targetMaximum),
    };
  };
  return {
    readingCount: Math.max(0, Number.parseInt(source.readingCount || "0", 10) || 0),
    temperature: normalizeMetric(source.temperature),
    humidity: normalizeMetric(source.humidity),
    points: normalizeReportList(source.points).map((point) => ({
      date: normalizeReportExportValue(point?.date),
      label: normalizeReportExportValue(point?.label),
      temperatureC: Number.isFinite(Number(point?.temperatureC)) ? Number(point.temperatureC) : null,
      humidityPercent: Number.isFinite(Number(point?.humidityPercent)) ? Number(point.humidityPercent) : null,
      readingCount: Math.max(0, Number.parseInt(point?.readingCount || "0", 10) || 0),
    })).filter((point) => point.temperatureC !== null && point.humidityPercent !== null),
    deviceOnline: source.deviceOnline === true,
    deviceLastSeenAt: normalizeReportExportValue(source.deviceLastSeenAt),
    components: normalizeReportList(source.components).map((component) => ({
      name: normalizeReportExportValue(component?.name || "Component"),
      status: normalizeReportExportValue(component?.status || "Offline"),
    })),
  };
}

const reportState = {
  cache: null,
  summaries: null,
  events: null,
  readyPromise: null,
  refreshTimer: null,
  refreshRequest: null,
};

function invalidateReportsCache() {
  reportState.cache = null;
  reportState.summaries = null;
  reportState.events = null;
  reportState.readyPromise = null;
}

/* One roll-up per category, behind the three cards. The dataset already covers
   every batch / every alert, so the card download is the whole tally rather
   than whichever single batch happened to sort first. */
function normalizeReportSummary(summary) {
  const kind = normalizeReportKind(summary?.kind || "");
  return {
    kind,
    id: String(summary?.id || `RPT-SUMMARY-${kind.toUpperCase()}`),
    title: String(summary?.title || `${getReportTypeLabel(kind)}s Summary`),
    // recordCount is what the downloadable report covers (one row per batch,
    // per completed run, per alert); eventCount is the log lines behind those
    // rows. The cards show the former so a card and the report it opens agree.
    recordCount: Math.max(0, Number.parseInt(summary?.recordCount ?? "0", 10) || 0),
    eventCount: Math.max(0, Number.parseInt(summary?.eventCount ?? "0", 10) || 0),
    dateRange: String(summary?.dateRange || "").trim(),
    generatedOn: String(summary?.generatedAt || summary?.generatedOn || "").trim(),
    status: String(summary?.status || "ready").trim(),
    dataset: normalizeReportDataset(summary?.dataset, kind),
  };
}

/* A row in the reports table is one thing that happened -- an alert firing, a
   milestone being ticked off, a batch opening or closing. These are log lines,
   so they carry no dataset and nothing about them is downloadable. */
function normalizeReportEvent(event) {
  const id = String(event?.id || "").trim();
  if (!id) return null;
  return {
    id,
    kind: normalizeReportKind(event?.kind || ""),
    recordedAt: String(event?.recordedAt || "").trim(),
    batchId: String(event?.batchId || "").trim(),
    day: String(event?.day || "--").trim(),
    event: String(event?.event || "Event").trim(),
    details: String(event?.details || "").trim(),
    recordedBy: String(event?.recordedBy || "System").trim(),
  };
}

/* Shared by both the per-batch records and the category roll-ups. Nested
   arrays are mapped element by element rather than spread, so a row's strings
   stay strings instead of becoming character-keyed objects. */
function normalizeReportDataset(dataset, kind, fallbackTitle = "") {
  if (!dataset || typeof dataset !== "object") return null;
  return {
    title: String(dataset.title || fallbackTitle || getReportTypeLabel(kind)),
    subtitle: String(dataset.subtitle || "Verified SmartDuck database records."),
    headers: normalizeReportList(dataset.headers).map((value) => String(value)),
    rows: normalizeReportList(dataset.rows).map((row) => normalizeReportList(row).map((value) => String(value ?? ""))),
    summary: normalizeReportList(dataset.summary).map((item) => ({
      label: String(item?.label || ""),
      value: String(item?.value ?? ""),
    })).filter((item) => item.label),
    timeline: normalizeReportList(dataset.timeline).map((row) => normalizeReportList(row).map((value) => String(value ?? ""))),
    timelineHeaders: normalizeReportList(dataset.timelineHeaders).map((value) => String(value)),
    monitoring: normalizeReportMonitoring(dataset.monitoring),
    alerts: normalizeReportAlerts(dataset.alerts),
    production: normalizeReportProduction(dataset.production),
    sources: normalizeReportList(dataset.sources).map((value) => String(value)),
  };
}

function getReportSummary(kind) {
  return reportState.summaries?.find((summary) => summary.kind === kind) || null;
}

function formatReportEventTimestamp(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return value || "--";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getReportEventCategoryLabel(kind) {
  if (kind === "production") return "Production";
  if (kind === "alert") return "Alert";
  return "Batch";
}

function normalizeReportRecord(report) {
  const kind = normalizeReportKind(report?.kind || report?.type || "");
  const id = String(report?.id || "").trim();
  if (!id) return null;
  return {
    id,
    kind,
    type: getReportTypeLabel(kind),
    dateRange: String(report?.dateRange || "").trim(),
    generatedOn: String(report?.generatedAt || report?.generatedOn || "").trim(),
    generatedBy: String(report?.generatedByUsername || report?.generatedBy || "").trim(),
    status: String(report?.status || "ready").trim(),
    batchId: String(report?.batchId || "").trim(),
    title: String(report?.title || "").trim(),
    dataset: normalizeReportDataset(report?.dataset, kind, report?.title),
  };
}

async function loadReportsFromBackend(forceRefresh = false) {
  if (!forceRefresh && Array.isArray(reportState.cache)) return reportState.cache.map((report) => ({ ...report }));
  if (reportState.readyPromise) return reportState.readyPromise;

  reportState.readyPromise = (async () => {
    const separator = REPORTS_ENDPOINT.includes("?") ? "&" : "?";
    const payload = await requestBackendJson(`${REPORTS_ENDPOINT}${separator}_=${Date.now()}`);
    const reports = normalizeAccounts(payload.reports)
      .map(normalizeReportRecord)
      .filter(Boolean)
      .sort((a, b) => String(b.generatedOn || "").localeCompare(String(a.generatedOn || "")) || a.id.localeCompare(b.id));
    reportState.cache = reports;
    // Deliberately not normalizeAccounts: it clones every array item with
    // object spread, which turns a dataset row's strings into character-keyed
    // objects. The report normalizers keep the nested arrays intact.
    reportState.summaries = normalizeReportList(payload.summaries).map(normalizeReportSummary);
    reportState.events = normalizeReportList(payload.events)
      .map(normalizeReportEvent)
      .filter(Boolean);
    reportState.readyPromise = null;
    return reports.map((report) => ({ ...report }));
  })().catch((error) => {
    reportState.readyPromise = null;
    throw error;
  });
  return reportState.readyPromise;
}

function formatReportTableDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return value || "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* The table is a running log now, so it renders the event feed rather than the
   report index. The three cards above it keep the per-category totals, which
   are counts of these same entries -- card and table can never disagree. */
function renderReportRowsFromRecords(events) {
  const tableCard = app.pageRoot?.querySelector(".reports-table-card");
  const tableWrap = tableCard?.querySelector(".reports-table-wrap");
  const tbody = tableCard?.querySelector(".reports-table tbody");
  if (!tableCard || !tableWrap || !tbody) return;

  // A card states what its report covers, so opening it confirms the number
  // rather than contradicting it: three batches read "3", and the report that
  // opens says "Total Batches 3". Counting the log lines instead put 13 on a
  // card whose own report reported three.
  const RECORD_LABELS = {
    batch: ["Batch on record", "Batches on record"],
    production: ["Batch in production", "Batches in production"],
    alert: ["Alert on record", "Alerts on record"],
  };
  app.pageRoot?.querySelectorAll("[data-report-view]").forEach((button) => {
    const kind = button.dataset.reportView || "batch";
    const card = button.closest(".reports-category-card");
    const value = card?.querySelector(".reports-category-card__value");
    const meta = card?.querySelector(".reports-category-card__meta");
    const summary = getReportSummary(kind);
    const count = summary ? summary.recordCount : 0;
    if (value) value.textContent = String(count);
    const [singular, plural] = RECORD_LABELS[kind] || RECORD_LABELS.batch;
    if (meta) meta.textContent = count === 1 ? singular : plural;
    button.title = count === 1
      ? `Download the report covering this 1 record`
      : `Download one report covering all ${count} records`;
  });

  // Every entry is rendered; the table body scrolls instead of paging. Hiding
  // the newest activity behind a pager is the opposite of what a log is for.
  tbody.innerHTML = events.map((entry) => `
      <tr data-report-kind="${escapeHtml(entry.kind)}" title="${escapeHtml(entry.details || entry.event)}">
        <td class="reports-table__strong"><span class="reports-cell">${escapeHtml(formatReportEventTimestamp(entry.recordedAt))}</span></td>
        <td><span class="reports-status-pill reports-status-pill--${escapeHtml(entry.kind)}">${escapeHtml(getReportEventCategoryLabel(entry.kind))}</span></td>
        <td><span class="reports-cell">${escapeHtml(entry.batchId || "--")}</span></td>
        <td><span class="reports-cell">${escapeHtml(entry.day || "--")}</span></td>
        <td class="reports-table__strong"><span class="reports-cell">${escapeHtml(entry.event)}</span></td>
        <td><span class="reports-cell">${escapeHtml(entry.details || "--")}</span></td>
        <td><span class="reports-cell">${escapeHtml(entry.recordedBy || "System")}</span></td>
      </tr>
    `).join("");

  const emptyState = ensureTableEmptyState(tableWrap, "reports-empty-state", "Nothing has been recorded yet. Entries appear here as batches run and alerts come in.");
  if (emptyState) emptyState.hidden = events.length > 0;
  const footnote = tableCard.querySelector(".reports-table-card__footnote");
  if (footnote) {
    footnote.textContent = events.length
      ? `${events.length} ${events.length === 1 ? "entry" : "entries"}`
      : "Nothing recorded yet";
  }
  // The pager is gone; the table scrolls. The node stays in the markup so an
  // older cached page keeps a valid layout, but it never renders controls.
  const pagination = tableCard.querySelector(".reports-pagination");
  if (pagination) {
    pagination.hidden = true;
    pagination.innerHTML = "";
  }
  hydrateIcons(tableCard);
}

function getReportDataset(kind, reportId = "") {
  const report = reportId
    ? reportState.cache?.find((candidate) => candidate.id === reportId && candidate.kind === kind)
    : reportState.cache?.find((candidate) => candidate.kind === kind);
  // Carry the record's provenance onto whichever dataset we end up returning;
  // the table fallback below used to drop it and the export then stamped the
  // file with today's date and the signed-in viewer.
  const meta = report
    ? {
        reportId: report.id,
        batchId: report.batchId,
        generatedOn: report.generatedOn,
        generatedBy: report.generatedBy,
      }
    : { reportId };
  if (report?.dataset?.headers?.length) {
    return {
      ...report.dataset,
      ...meta,
      exportLabel: "Download Report",
      exportFormat: "pdf",
    };
  }
  // Fall back to the category roll-up rather than scraping the table. The
  // table holds activity entries now, so reading cells out of it would export
  // a log under a report's headers.
  const summary = getReportSummary(kind);
  if (summary?.dataset?.headers?.length) {
    return {
      ...summary.dataset,
      ...meta,
      reportId: meta.reportId || summary.id,
      generatedOn: meta.generatedOn || summary.generatedOn,
      exportLabel: "Download Report",
      exportFormat: "pdf",
    };
  }
  return {
    title: `${getReportTypeLabel(kind)}s`,
    subtitle: "No records available yet.",
    exportLabel: "Download Report",
    exportFormat: "pdf",
    headers: [],
    rows: [],
    summary: [],
    timeline: [],
    sources: ["SmartDuck database records"],
    ...meta,
  };
}
function makeReportFilename(kind, format, reportId = "") {
  const suffix = reportId ? `-${reportId.toLowerCase()}` : "";
  return `smartduck-${kind}-report${suffix}.${format === "excel" ? "xlsx" : "pdf"}`;
}

function normalizeReportExportValue(value) {
  return String(value ?? "")
    .replace(/\u00c2\u00b0/g, "\u00b0")
    .replace(/\s+/g, " ")
    .trim();
}

// Backend timestamps arrive as raw ISO strings, so a "Date / Time" column
// printed "2026-08-17T18:31:54+00:00" in both the PDF and the workbook. Only
// full timestamps are rewritten; a plain "2026-07-23" is already readable and
// would gain a misleading midnight time.
const REPORT_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function formatReportCellValue(value) {
  const text = normalizeReportExportValue(value);
  return REPORT_ISO_TIMESTAMP_PATTERN.test(text) ? formatReportTableDate(text) : text;
}

// Helvetica / Helvetica-Bold advance widths (1/1000 em) for printable ASCII.
// Assuming a flat 4.7pt per character clipped "Component" to "Compone." and
// "notification" to "notificati." while leaving number columns half empty, so
// the exporter measures with the real font metrics instead.
const PDF_FONT_WIDTHS = {
  F1: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  F2: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};

function toPdfRenderableText(value) {
  return normalizeReportExportValue(value)
    .replace(/\u00b0/g, " deg")
    .replace(/[^\x20-\x7e]/g, "");
}

function escapePdfText(value) {
  return toPdfRenderableText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function measurePdfText(value, size, font = "F1") {
  const widths = PDF_FONT_WIDTHS[font] || PDF_FONT_WIDTHS.F1;
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    total += (code >= 32 && code <= 126 ? widths[code - 32] : 556);
  }
  return (total * size) / 1000;
}

// Summary cards hold single facts such as a batch id, so shrinking the type a
// step or two keeps the value whole where a fixed 11pt cut "BATCH-REPORT-SMOKE"
// down to "BATCH-REPORT-SMO.".
function fitPdfTextSize(value, maxWidth, sizes, font = "F1") {
  const text = toPdfRenderableText(value);
  const size = sizes.find((candidate) => measurePdfText(text, candidate, font) <= maxWidth)
    ?? sizes[sizes.length - 1];
  return { text: fitPdfText(text, maxWidth, size, font), size };
}

function fitPdfText(value, maxWidth, size = 7, font = "F1") {
  const text = toPdfRenderableText(value);
  if (maxWidth <= 0) return "";
  if (measurePdfText(text, size, font) <= maxWidth) return text;
  const dotWidth = measurePdfText(".", size, font);
  let fitted = "";
  let width = 0;
  for (let index = 0; index < text.length; index += 1) {
    const charWidth = measurePdfText(text[index], size, font);
    if (width + charWidth + dotWidth > maxWidth) break;
    fitted += text[index];
    width += charWidth;
  }
  return `${fitted.trimEnd()}.`;
}

function pdfText(value, x, y, size = 8, color = "0.08 0.12 0.18", font = "F1") {
  return `BT\n${color} rg\n/${font} ${size} Tf\n1 0 0 1 ${x} ${y} Tm\n(${escapePdfText(value)}) Tj\nET`;
}

function pdfTextRight(value, rightX, y, size = 8, color = "0.08 0.12 0.18", font = "F1") {
  const text = toPdfRenderableText(value);
  return pdfText(text, rightX - measurePdfText(text, size, font), y, size, color, font);
}

function pdfRect(x, y, width, height, color) {
  return `${color} rg\n${x} ${y} ${width} ${height} re f`;
}

function pdfStrokeRect(x, y, width, height, color = "0.82 0.87 0.92", lineWidth = 0.45) {
  return `${color} RG\n${lineWidth} w\n${x} ${y} ${width} ${height} re S`;
}

function pdfLine(x1, y1, x2, y2, color = "0.82 0.87 0.92", lineWidth = 0.6) {
  return `${color} RG\n${lineWidth} w\n${x1} ${y1} m\n${x2} ${y2} l S`;
}

function pdfPolyline(points, color, lineWidth = 1.5) {
  if (!points.length) return "";
  const [first, ...rest] = points;
  return `${color} RG\n${lineWidth} w\n${first[0]} ${first[1]} m\n${rest.map(([x, y]) => `${x} ${y} l`).join("\n")} S`;
}

/* PDF has no arc operator, so a circular arc is approximated with cubic beziers
   — one segment per quarter turn or less, which keeps the error invisible at
   report scale. Returns the path without a paint operator so callers decide
   whether to fill or stroke it. */
function pdfArcPath(centerX, centerY, radius, startAngle, endAngle, moveToStart = true) {
  const sweep = endAngle - startAngle;
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / segments;
  // Control-point offset for a bezier approximation of a circular arc.
  const handle = (4 / 3) * Math.tan(step / 4);
  const pointAt = (angle) => [centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)];
  const parts = [];
  let [currentX, currentY] = pointAt(startAngle);
  if (moveToStart) parts.push(`${currentX.toFixed(2)} ${currentY.toFixed(2)} m`);
  for (let index = 0; index < segments; index += 1) {
    const from = startAngle + step * index;
    const to = from + step;
    const [endX, endY] = pointAt(to);
    const control1X = currentX - handle * radius * Math.sin(from);
    const control1Y = currentY + handle * radius * Math.cos(from);
    const control2X = endX + handle * radius * Math.sin(to);
    const control2Y = endY - handle * radius * Math.cos(to);
    parts.push(`${control1X.toFixed(2)} ${control1Y.toFixed(2)} ${control2X.toFixed(2)} ${control2Y.toFixed(2)} ${endX.toFixed(2)} ${endY.toFixed(2)} c`);
    currentX = endX;
    currentY = endY;
  }
  return parts.join("\n");
}

/* One filled slice of a donut: out along the outer arc, back along the inner
   one. Drawn as a closed path so adjacent slices meet without seams. */
function pdfDonutSlice(centerX, centerY, outerRadius, innerRadius, startAngle, endAngle, color) {
  const innerStart = [centerX + innerRadius * Math.cos(endAngle), centerY + innerRadius * Math.sin(endAngle)];
  return [
    `${color} rg`,
    pdfArcPath(centerX, centerY, outerRadius, startAngle, endAngle),
    `${innerStart[0].toFixed(2)} ${innerStart[1].toFixed(2)} l`,
    pdfArcPath(centerX, centerY, innerRadius, endAngle, startAngle, false),
    "h f",
  ].join("\n");
}

/* SmartDuck palette, matching the dashboard and the batch report: red #EF4444
   for temperature, blue #2563EB for humidity and the brand amber #D97706 for
   everything else. */
const ALERT_SERIES = [
  { key: "temperature", label: "Temperature Alerts", color: "0.94 0.27 0.27" },
  { key: "humidity", label: "Humidity Alerts", color: "0.15 0.39 0.92" },
  { key: "system", label: "System / Other Alerts", color: "0.85 0.47 0.02" },
];

/* The mockup's per-day panel: temperature and humidity plotted against their
   own axes (C on the left, % on the right) with the alert count for each day
   as a bar behind them, so a spike lines up with the day it was raised. Only
   days that actually recorded readings or alerts are drawn. */
function appendPdfAlertsPerDayChart(content, { x, y, width, height, perDay, points, temperature, humidity }) {
  content.push(pdfRect(x, y, width, height, "1 1 1"));
  content.push(pdfStrokeRect(x, y, width, height, "0.84 0.88 0.94"));
  content.push(pdfText("Alerts Per Day", x + 12, y + height - 18, 9, "0.08 0.14 0.22", "F2"));

  const rangeParts = [];
  if (temperature?.targetMinimum !== null && temperature?.targetMaximum !== null) {
    rangeParts.push(`Temperature range: ${temperature.targetMinimum} C - ${temperature.targetMaximum} C`);
  }
  if (humidity?.targetMinimum !== null && humidity?.targetMaximum !== null) {
    rangeParts.push(`Humidity range: ${humidity.targetMinimum} % - ${humidity.targetMaximum} %`);
  }
  if (rangeParts.length) {
    content.push(pdfTextRight(fitPdfText(rangeParts.join("   |   "), width - 150, 6), x + width - 12, y + height - 18, 6, "0.39 0.46 0.56", "F1"));
  }

  const legend = [
    { label: "Temperature (C)", color: "0.94 0.27 0.27" },
    { label: "Humidity (%)", color: "0.15 0.39 0.92" },
    { label: "Alerts", color: "0.85 0.47 0.02" },
  ];
  let legendX = x + 12;
  legend.forEach((item) => {
    content.push(pdfRect(legendX, y + height - 34, 6, 6, item.color));
    content.push(pdfText(item.label, legendX + 9, y + height - 33, 6, "0.32 0.40 0.50", "F1"));
    legendX += measurePdfText(item.label, 6) + 24;
  });

  // Merge the reading days and the alert days onto one day axis so the bars
  // and the lines share x positions.
  const dayOf = (label) => {
    const match = /(\d+)/.exec(String(label || ""));
    return match ? Number(match[1]) : 0;
  };
  const byDay = new Map();
  points.forEach((point) => {
    const day = dayOf(point.label || point.date);
    if (!day) return;
    byDay.set(day, { ...(byDay.get(day) || {}), day, label: point.label || `Day ${day}`, temperatureC: point.temperatureC, humidityPercent: point.humidityPercent });
  });
  perDay.forEach((entry) => {
    const day = entry.day || dayOf(entry.label);
    if (!day) return;
    byDay.set(day, { ...(byDay.get(day) || { day, label: entry.label }), alerts: entry.total });
  });
  const axis = [...byDay.values()].sort((left, right) => left.day - right.day);

  if (!axis.length) {
    content.push(pdfText("No readings or alerts recorded for this batch.", x + 12, y + height / 2, 7, "0.50 0.56 0.64", "F1"));
    return;
  }

  const chartLeft = x + 30;
  const chartBottom = y + 26;
  const chartWidth = width - 66;
  const chartHeight = height - 74;

  const temperatures = axis.map((entry) => entry.temperatureC).filter(Number.isFinite);
  const humidities = axis.map((entry) => entry.humidityPercent).filter(Number.isFinite);
  const maxAlerts = Math.max(...axis.map((entry) => entry.alerts || 0), 1);

  // Pad each axis around its own data so the lines never touch the frame.
  const scaleFor = (values, fallbackMin, fallbackMax, padding) => {
    if (!values.length) return { min: fallbackMin, max: fallbackMax };
    const min = Math.min(...values) - padding;
    const max = Math.max(...values) + padding;
    return { min, max: max === min ? min + 1 : max };
  };
  const temperatureScale = scaleFor(temperatures, 35, 39, 0.4);
  const humidityScale = scaleFor(humidities, 0, 100, 4);

  for (let index = 0; index <= 4; index += 1) {
    const gridY = chartBottom + (index / 4) * chartHeight;
    content.push(pdfLine(chartLeft, gridY, chartLeft + chartWidth, gridY, "0.89 0.92 0.96", 0.35));
    const temperatureTick = temperatureScale.min + (index / 4) * (temperatureScale.max - temperatureScale.min);
    content.push(pdfTextRight(temperatureTick.toFixed(1), chartLeft - 4, gridY - 2, 5.5, "0.86 0.31 0.31", "F1"));
    const humidityTick = humidityScale.min + (index / 4) * (humidityScale.max - humidityScale.min);
    content.push(pdfText(String(Math.round(humidityTick)), chartLeft + chartWidth + 4, gridY - 2, 5.5, "0.15 0.39 0.92", "F1"));
  }

  const slot = chartWidth / axis.length;
  const positionFor = (index) => chartLeft + slot * (index + 0.5);

  // Alert bars sit behind the lines.
  axis.forEach((entry, index) => {
    const count = entry.alerts || 0;
    if (count <= 0) return;
    const barHeight = (count / maxAlerts) * chartHeight * 0.55;
    const barWidth = Math.max(3, Math.min(14, slot * 0.45));
    content.push(pdfRect(positionFor(index) - barWidth / 2, chartBottom, barWidth, barHeight, "0.98 0.85 0.62"));
  });

  const plot = (key, scale, color) => {
    const plotted = [];
    axis.forEach((entry, index) => {
      const value = entry[key];
      if (!Number.isFinite(value)) return;
      const pointY = chartBottom + ((value - scale.min) / (scale.max - scale.min || 1)) * chartHeight;
      plotted.push([positionFor(index), pointY]);
    });
    if (plotted.length > 1) content.push(pdfPolyline(plotted, color, 1.2));
    plotted.forEach(([pointX, pointY]) => {
      content.push(pdfRect(pointX - 1.5, pointY - 1.5, 3, 3, color));
    });
  };
  plot("temperatureC", temperatureScale, "0.94 0.27 0.27");
  plot("humidityPercent", humidityScale, "0.15 0.39 0.92");

  axis.forEach((entry, index) => {
    // Crowded axes drop ticks rather than overprinting the labels.
    const stride = axis.length <= 18 ? 1 : Math.ceil(axis.length / 18);
    if (index % stride !== 0) return;
    const label = fitPdfText(String(entry.day), slot + 4, 5.5);
    content.push(pdfText(label, positionFor(index) - measurePdfText(label, 5.5) / 2, y + 14, 5.5, "0.39 0.46 0.56", "F1"));
  });
  const axisTitle = "Incubation Day";
  content.push(pdfText(axisTitle, chartLeft + chartWidth / 2 - measurePdfText(axisTitle, 6) / 2, y + 5, 6, "0.39 0.46 0.56", "F1"));
}

/* The mockup's distribution ring: a real donut with the total in the hole and
   a legend listing each type's count and share. */
function appendPdfAlertDistribution(content, { x, y, width, height, alerts }) {
  content.push(pdfRect(x, y, width, height, "1 1 1"));
  content.push(pdfStrokeRect(x, y, width, height, "0.84 0.88 0.94"));
  content.push(pdfText("Alerts Distribution", x + 12, y + height - 18, 9, "0.08 0.14 0.22", "F2"));

  if (!alerts.total) {
    content.push(pdfText("No alerts recorded.", x + 12, y + height / 2, 7, "0.50 0.56 0.64", "F1"));
    return;
  }

  const outerRadius = Math.min(34, (height - 46) / 2);
  const innerRadius = outerRadius * 0.58;
  const centerX = x + 16 + outerRadius;
  const centerY = y + (height - 26) / 2;

  // Start at 12 o'clock and sweep clockwise, like the mockup.
  let angle = Math.PI / 2;
  ALERT_SERIES.forEach((series) => {
    const value = alerts[series.key];
    if (value <= 0) return;
    const sweep = (value / alerts.total) * Math.PI * 2;
    content.push(pdfDonutSlice(centerX, centerY, outerRadius, innerRadius, angle, angle - sweep, series.color));
    angle -= sweep;
  });

  const totalText = String(alerts.total);
  content.push(pdfText(totalText, centerX - measurePdfText(totalText, 13, "F2") / 2, centerY - 1, 13, "0.08 0.12 0.18", "F2"));
  const totalLabel = "Total";
  content.push(pdfText(totalLabel, centerX - measurePdfText(totalLabel, 5.5) / 2, centerY - 11, 5.5, "0.39 0.46 0.56", "F1"));

  const legendX = centerX + outerRadius + 14;
  const legendRight = x + width - 10;
  ALERT_SERIES.forEach((series, index) => {
    const value = alerts[series.key];
    const share = Math.round((value / alerts.total) * 100);
    const rowY = centerY + outerRadius - 12 - index * 17;
    content.push(pdfRect(legendX, rowY - 1, 5, 5, series.color));
    content.push(pdfText(fitPdfText(series.label, legendRight - legendX - 46, 6), legendX + 9, rowY, 6, "0.13 0.18 0.27", "F1"));
    content.push(pdfTextRight(`${value} (${share}%)`, legendRight, rowY, 6, "0.32 0.40 0.50", "F2"));
  });
}
/* Harvested vs rejected for every batch, drawn as paired columns so the two
   outcomes for a run sit side by side and the totals are readable at a glance. */
function appendPdfProductionBatchChart(content, { x, y, width, height, batches }) {
  content.push(pdfRect(x, y, width, height, "1 1 1"));
  content.push(pdfStrokeRect(x, y, width, height, "0.84 0.88 0.94"));
  content.push(pdfText("Total Eggs Set vs Harvested / Rejected per Batch", x + 12, y + height - 18, 8.5, "0.08 0.14 0.22", "F2"));

  const legend = [
    { label: "Harvested (Balut)", color: "0.13 0.65 0.31" },
    { label: "Rejected / Penoy", color: "0.94 0.27 0.27" },
  ];
  let legendX = x + 12;
  legend.forEach((item) => {
    content.push(pdfRect(legendX, y + height - 33, 6, 6, item.color));
    content.push(pdfText(item.label, legendX + 9, y + height - 32, 6, "0.32 0.40 0.50", "F1"));
    legendX += measurePdfText(item.label, 6) + 24;
  });

  if (!batches.length) {
    content.push(pdfText("No batches recorded yet.", x + 12, y + height / 2, 7, "0.50 0.56 0.64", "F1"));
    return;
  }

  const chartLeft = x + 30;
  const chartBottom = y + 28;
  const chartWidth = width - 44;
  const chartHeight = height - 74;
  const maximum = Math.max(...batches.map((entry) => Math.max(entry.harvested, entry.rejected)), 1);

  for (let index = 0; index <= 4; index += 1) {
    const value = Math.round((index / 4) * maximum);
    const gridY = chartBottom + (index / 4) * chartHeight;
    content.push(pdfLine(chartLeft, gridY, chartLeft + chartWidth, gridY, "0.89 0.92 0.96", 0.35));
    content.push(pdfTextRight(String(value), chartLeft - 4, gridY - 2, 5.5, "0.50 0.56 0.64", "F1"));
  }

  const slot = chartWidth / batches.length;
  const barWidth = Math.max(3, Math.min(15, slot * 0.32));
  batches.forEach((entry, index) => {
    const centerX = chartLeft + slot * (index + 0.5);
    const pairs = [
      { value: entry.harvested, color: "0.13 0.65 0.31", offset: -barWidth * 0.55 },
      { value: entry.rejected, color: "0.94 0.27 0.27", offset: barWidth * 0.55 },
    ];
    pairs.forEach((pair) => {
      const barHeight = (pair.value / maximum) * chartHeight;
      const barX = centerX + pair.offset - barWidth / 2;
      if (pair.value > 0) content.push(pdfRect(barX, chartBottom, barWidth, barHeight, pair.color));
      if (pair.value > 0 && slot > 26) {
        const label = String(pair.value);
        content.push(pdfText(label, barX + barWidth / 2 - measurePdfText(label, 5) / 2, chartBottom + barHeight + 2, 5, "0.32 0.40 0.50", "F2"));
      }
    });
    const stride = batches.length <= 10 ? 1 : Math.ceil(batches.length / 10);
    if (index % stride === 0) {
      const label = fitPdfText(entry.label, slot + 6, 5.5);
      content.push(pdfText(label, centerX - measurePdfText(label, 5.5) / 2, y + 14, 5.5, "0.39 0.46 0.56", "F1"));
    }
  });
}

/* Harvest rate across the batches in run order, so a downward trend is visible
   without reading the table. */
function appendPdfHarvestRateChart(content, { x, y, width, height, batches }) {
  content.push(pdfRect(x, y, width, height, "1 1 1"));
  content.push(pdfStrokeRect(x, y, width, height, "0.84 0.88 0.94"));
  content.push(pdfText("Harvest Rate (%) Over Time", x + 12, y + height - 18, 8.5, "0.08 0.14 0.22", "F2"));

  if (!batches.length) {
    content.push(pdfText("No batches recorded yet.", x + 12, y + height / 2, 7, "0.50 0.56 0.64", "F1"));
    return;
  }

  const chartLeft = x + 32;
  const chartBottom = y + 28;
  const chartWidth = width - 46;
  const chartHeight = height - 60;

  for (let index = 0; index <= 4; index += 1) {
    const value = Math.round((index / 4) * 100);
    const gridY = chartBottom + (index / 4) * chartHeight;
    content.push(pdfLine(chartLeft, gridY, chartLeft + chartWidth, gridY, "0.89 0.92 0.96", 0.35));
    content.push(pdfTextRight(`${value}%`, chartLeft - 4, gridY - 2, 5.5, "0.50 0.56 0.64", "F1"));
  }

  const slot = chartWidth / batches.length;
  const plotted = batches.map((entry, index) => [
    chartLeft + (batches.length === 1 ? chartWidth / 2 : slot * (index + 0.5)),
    chartBottom + (Math.min(100, Math.max(0, entry.harvestRate)) / 100) * chartHeight,
  ]);
  if (plotted.length > 1) content.push(pdfPolyline(plotted, "0.55 0.36 0.96", 1.3));
  plotted.forEach(([pointX, pointY], index) => {
    content.push(pdfRect(pointX - 1.6, pointY - 1.6, 3.2, 3.2, "0.55 0.36 0.96"));
    const stride = batches.length <= 8 ? 1 : Math.ceil(batches.length / 8);
    if (index % stride !== 0) return;
    const value = `${batches[index].harvestRate.toFixed(1)}%`;
    content.push(pdfText(value, pointX - measurePdfText(value, 5) / 2, pointY + 5, 5, "0.42 0.28 0.75", "F2"));
    const label = fitPdfText(batches[index].label, slot + 6, 5.5);
    content.push(pdfText(label, pointX - measurePdfText(label, 5.5) / 2, y + 14, 5.5, "0.39 0.46 0.56", "F1"));
  });
}

/* The mockup's left-hand batch list: one numbered row per run with its status
   and the harvested / rejected split. */
function appendPdfBatchSummaryList(content, { x, y, width, height, batches }) {
  content.push(pdfRect(x, y, width, height, "1 1 1"));
  content.push(pdfStrokeRect(x, y, width, height, "0.84 0.88 0.94"));
  content.push(pdfText("Batch Summary", x + 12, y + height - 18, 8.5, "0.08 0.14 0.22", "F2"));

  if (!batches.length) {
    content.push(pdfText("No batches recorded yet.", x + 12, y + height / 2, 7, "0.50 0.56 0.64", "F1"));
    return;
  }

  const rowHeight = 26;
  const visible = batches.slice(0, Math.max(0, Math.floor((height - 34) / rowHeight)));
  visible.forEach((entry, index) => {
    const rowY = y + height - 34 - (index + 1) * rowHeight + 8;
    content.push(pdfRect(x + 8, rowY - 4, width - 16, rowHeight - 4, index % 2 === 0 ? "0.98 0.99 1.00" : "1 1 1"));
    const badge = String(entry.index || index + 1);
    content.push(pdfText(badge, x + 14, rowY + 7, 6.5, "0.39 0.46 0.56", "F2"));
    content.push(pdfText(fitPdfText(entry.batchId, width - 96, 6.5, "F2"), x + 26, rowY + 7, 6.5, "0.08 0.12 0.18", "F2"));
    const statusColor = /completed/i.test(entry.status) ? "0.06 0.46 0.26" : "0.82 0.42 0.04";
    content.push(pdfTextRight(fitPdfText(entry.status, 54, 5.5, "F2"), x + width - 12, rowY + 7, 5.5, statusColor, "F2"));
    const detail = `Set ${entry.eggsSet}   Harvested ${entry.harvested} (${entry.harvestRate.toFixed(1)}%)   Rejected ${entry.rejected}`;
    content.push(pdfText(fitPdfText(detail, width - 26, 5.5), x + 26, rowY - 1, 5.5, "0.39 0.46 0.56", "F1"));
  });
  if (batches.length > visible.length) {
    content.push(pdfText(`+${batches.length - visible.length} more in the table below`, x + 12, y + 8, 5.5, "0.50 0.56 0.64", "F1"));
  }
}

function appendPdfMonitoringChart(content, { x, y, width, height, title, unit, metric, points, valueKey, color, targetLabel = "" }) {
  content.push(pdfRect(x, y, width, height, "1 1 1"));
  content.push(pdfStrokeRect(x, y, width, height, "0.84 0.88 0.94"));
  content.push(pdfText(title, x + 12, y + height - 18, 9, color, "F2"));
  const metricText = metric.average === null
    ? "No readings"
    : `Avg ${metric.average}${unit}  Min ${metric.minimum}${unit}  Max ${metric.maximum}${unit}`;
  content.push(pdfText(fitPdfText(metricText, width - 24, 7), x + 12, y + height - 34, 7, "0.32 0.40 0.50", "F1"));
  if (targetLabel) {
    content.push(pdfText(fitPdfText(targetLabel, width - 24, 6.5), x + 12, y + height - 47, 6.5, "0.39 0.46 0.56", "F1"));
  }
  if (!points.length) {
    // The averages above come from real readings even when this report carries
    // no per-day points (the all-batches roll-up), so only say nothing was
    // recorded when the metric itself is empty.
    content.push(pdfText(
      metric.average === null
        ? "No sensor readings recorded for this batch."
        : "Daily breakdown is available in each batch's own report.",
      x + 12,
      y + 42,
      7,
      "0.50 0.56 0.64",
      "F1",
    ));
    return;
  }
  const chartLeft = x + 22;
  const chartBottom = y + 24;
  const chartWidth = width - 38;
  const chartHeight = 54;
  for (let index = 0; index < 4; index += 1) {
    const gridY = chartBottom + (index / 3) * chartHeight;
    content.push(pdfLine(chartLeft, gridY, chartLeft + chartWidth, gridY, "0.89 0.92 0.96", 0.35));
  }
  const values = points.map((point) => Number(point[valueKey])).filter(Number.isFinite);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding = Math.max((maximum - minimum) * 0.15, valueKey === "temperatureC" ? 0.2 : 2);
  const domainMinimum = minimum - padding;
  const domainMaximum = maximum + padding;
  const plotted = points.map((point, index) => {
    const pointX = chartLeft + (points.length === 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth);
    const pointY = chartBottom + ((Number(point[valueKey]) - domainMinimum) / (domainMaximum - domainMinimum || 1)) * chartHeight;
    return [pointX, pointY];
  });
  content.push(pdfPolyline(plotted, color));
  plotted.forEach(([pointX, pointY], index) => {
    content.push(pdfRect(pointX - 1.7, pointY - 1.7, 3.4, 3.4, color));
    const label = fitPdfText(points[index].label || points[index].date || "", 42, 6);
    content.push(pdfText(label, pointX - measurePdfText(label, 6) / 2, y + 10, 6, "0.39 0.46 0.56", "F1"));
  });
}

// Column counts outside the old 6/9/10 presets fell back to equal widths, which
// truncated long cells ("1st Candling / Penoy Check" became "1st Candling / P.")
// while number columns sat mostly empty. Weight each column by its widest cell
// instead, clamped so one free-text column cannot starve the rest.
function getPdfColumnWidths(headers, rows = []) {
  const tableWidth = 770;
  const weights = headers.map((header, index) => {
    const widest = rows.reduce(
      (max, row) => Math.max(max, measurePdfText(toPdfRenderableText(row[index] ?? ""), 7)),
      measurePdfText(toPdfRenderableText(header ?? ""), 7, "F2"),
    );
    // Clamped in points so one free-text column cannot starve the rest, while
    // narrow columns still keep enough room for their own header.
    return Math.min(168, Math.max(40, widest + 14));
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  return weights.map((weight) => (weight / total) * tableWidth);
}

function buildReportPdf(dataset, kind) {
  dataset = normalizeReportDatasetForExport(dataset, kind, dataset?.reportId || "");
  const headers = dataset.headers.map(normalizeReportExportValue);
  const rows = dataset.rows.map((row) => row.map(normalizeReportExportValue));
  const pageWidth = 842;
  const pageHeight = 595;
  const margin = 36;
  const tableWidth = pageWidth - margin * 2;
  const columnWidths = getPdfColumnWidths(headers, rows);
  const isBatchReport = kind === "batch";
  const isAlertReport = kind === "alert";
  const isProductionReport = kind === "production";
  const production = normalizeReportProduction(dataset.production);
  const alerts = normalizeReportAlerts(dataset.alerts);
  // Batch and alert reports both open on a dashboard page, so they share the
  // compact header and give the same vertical band to their charts.
  const hasOverviewPage = isBatchReport || isAlertReport || isProductionReport;
  const rowHeight = hasOverviewPage ? 20 : 24;
  const headerHeight = 26;
  const generatedAt = dataset.generatedOn ? formatReportTableDate(dataset.generatedOn) : new Date().toLocaleString("en-US");
  const firstPageCapacity = hasOverviewPage ? 8 : 9;
  const otherPageCapacity = 14;
  const pageRows = [];
  pageRows.push(rows.slice(0, firstPageCapacity));
  for (let offset = firstPageCapacity; offset < rows.length; offset += otherPageCapacity) {
    pageRows.push(rows.slice(offset, offset + otherPageCapacity));
  }
  if (!pageRows.length) pageRows.push([]);
  const pageCount = pageRows.length;

  const streams = pageRows.map((currentRows, pageIndex) => {
    const content = [];
    const firstPage = pageIndex === 0;
    const batchOverviewPage = firstPage && isBatchReport;
    const alertOverviewPage = firstPage && isAlertReport;
    const productionOverviewPage = firstPage && isProductionReport;
    const overviewPage = batchOverviewPage || alertOverviewPage || productionOverviewPage;
    const tableTop = overviewPage ? 282 : (firstPage ? 370 : 430);
    if (overviewPage) {
      content.push(pdfRect(margin, pageHeight - 12, tableWidth, 3, "0.96 0.62 0.08"));
    } else {
      content.push(pdfRect(0, pageHeight - 72, pageWidth, 72, "0.05 0.10 0.16"));
      content.push(pdfRect(0, pageHeight - 76, pageWidth, 4, "0.96 0.62 0.08"));
      content.push(pdfText("SmartDuck", margin, pageHeight - 30, 18, "1 1 1", "F2"));
      content.push(pdfText("IoT Egg Incubation System", margin, pageHeight - 49, 9, "0.80 0.87 0.95"));
    }
    // The meta column used to start at a hardcoded x=610, so a long report id
    // such as "rpt-alert-notification-sensor-threshold-20260817183154-95bcf5"
    // ran straight off the right edge of the page. Right-align it instead and
    // reserve the remaining width for the title.
    const metaRight = pageWidth - margin;
    const metaWidth = 268;
    const headingWidth = metaRight - metaWidth - margin - 16;
    const titleY = overviewPage ? pageHeight - 35 : pageHeight - 98;
    content.push(pdfText(fitPdfText(dataset.title, headingWidth, 20, "F2"), margin, titleY, 20, "0.08 0.12 0.18", "F2"));
    content.push(pdfText(fitPdfText(dataset.subtitle, headingWidth, 8), margin, titleY - 18, 8, "0.39 0.46 0.56"));
    content.push(pdfTextRight(fitPdfText(`Report ID: ${dataset.reportId || "SmartDuck"}`, metaWidth, 8), metaRight, titleY + 6, 8, "0.39 0.46 0.56"));
    content.push(pdfTextRight(fitPdfText(`Generated: ${generatedAt}`, metaWidth, 8), metaRight, titleY - 10, 8, "0.39 0.46 0.56"));
    content.push(pdfTextRight(`Records: ${rows.length}`, metaRight, titleY - 26, 8, "0.39 0.46 0.56"));

    if (firstPage) {
      // A batch summary carries six fields; capping at four silently dropped
      // "Removed Eggs" from every batch report.
      const summary = normalizeReportList(dataset.summary).slice(0, 6);
      const cards = summary.length ? summary : [{ label: "Total Records", value: rows.length }];
      const gap = 10;
      const cardWidth = (tableWidth - gap * (cards.length - 1)) / cards.length;
      cards.forEach((item, index) => {
        const x = margin + index * (cardWidth + gap);
        const summaryBottom = overviewPage ? pageHeight - 102 : pageHeight - 178;
        content.push(pdfRect(x, summaryBottom, cardWidth, 40, "0.96 0.98 1.00"));
        content.push(pdfStrokeRect(x, summaryBottom, cardWidth, 40, "0.84 0.88 0.94"));
        const cardValue = fitPdfTextSize(item.value ?? "-", cardWidth - 20, [11, 10, 9, 8, 7], "F2");
        content.push(pdfText(fitPdfText(item.label || "Metric", cardWidth - 20, 7), x + 10, summaryBottom + 25, 7, "0.39 0.46 0.56"));
        content.push(pdfText(cardValue.text, x + 10, summaryBottom + 7, cardValue.size, "0.08 0.12 0.18", "F2"));
      });
    }

    if (batchOverviewPage) {
      const monitoring = normalizeReportMonitoring(dataset.monitoring);
      const chartGap = 10;
      const chartWidth = 250;
      const statusWidth = tableWidth - chartWidth * 2 - chartGap * 2;
      const cardBottom = 316;
      const cardHeight = 130;
      content.push(pdfText("Monitoring Overview", margin, 464, 10, "0.08 0.14 0.22", "F2"));
      content.push(pdfText("Real batch readings and current incubator status", margin, 451, 7, "0.39 0.46 0.56", "F1"));
      appendPdfMonitoringChart(content, {
        x: margin,
        y: cardBottom,
        width: chartWidth,
        height: cardHeight,
        title: "Temperature (C)",
        unit: " C",
        metric: monitoring.temperature,
        points: monitoring.points,
        valueKey: "temperatureC",
        color: "0.06 0.62 0.28",
        targetLabel: "Target: 37.3 C - 37.7 C",
      });
      appendPdfMonitoringChart(content, {
        x: margin + chartWidth + chartGap,
        y: cardBottom,
        width: chartWidth,
        height: cardHeight,
        title: "Humidity (%)",
        unit: "%",
        metric: monitoring.humidity,
        points: monitoring.points,
        valueKey: "humidityPercent",
        color: "0.06 0.38 0.92",
      });
      const statusX = margin + (chartWidth + chartGap) * 2;
      content.push(pdfRect(statusX, cardBottom, statusWidth, cardHeight, "1 1 1"));
      content.push(pdfStrokeRect(statusX, cardBottom, statusWidth, cardHeight, "0.84 0.88 0.94"));
      content.push(pdfText("System Status", statusX + 12, cardBottom + cardHeight - 18, 9, "0.06 0.38 0.92", "F2"));
      content.push(pdfText(monitoring.deviceOnline ? "Device online" : "Device offline", statusX + 12, cardBottom + cardHeight - 34, 7, monitoring.deviceOnline ? "0.06 0.46 0.26" : "0.73 0.11 0.11", "F2"));
      monitoring.components.slice(0, 6).forEach((component, index) => {
        const itemY = cardBottom + cardHeight - 52 - index * 13;
        const statusColor = /active|online|on/i.test(component.status) ? "0.06 0.46 0.26" : /warning|fault/i.test(component.status) ? "0.82 0.42 0.04" : "0.50 0.56 0.64";
        content.push(pdfText(fitPdfText(component.name, statusWidth - 72, 6.5), statusX + 12, itemY, 6.5, "0.13 0.18 0.27", "F1"));
        content.push(pdfTextRight(fitPdfText(component.status, 50, 6.5, "F2"), statusX + statusWidth - 12, itemY, 6.5, statusColor, "F2"));
      });
      if (!monitoring.components.length) {
        content.push(pdfText("No component status recorded.", statusX + 12, cardBottom + 42, 7, "0.50 0.56 0.64", "F1"));
      }
    }

    if (alertOverviewPage) {
      const chartGap = 10;
      // The charts stop short of the table so the "Alert History" caption has a
      // clear band; the batch page has no caption there and can sit lower.
      const cardBottom = 330;
      const cardHeight = 118;
      const distributionWidth = 232;
      const perDayWidth = tableWidth - distributionWidth - chartGap;
      content.push(pdfText("Alert Overview", margin, 464, 10, "0.08 0.14 0.22", "F2"));
      content.push(pdfText(
        `Alerts recorded during this incubation period${dataset.dateRange ? ` (${dataset.dateRange})` : ""}`,
        margin,
        451,
        7,
        "0.39 0.46 0.56",
        "F1",
      ));
      const alertMonitoring = normalizeReportMonitoring(dataset.monitoring);
      appendPdfAlertsPerDayChart(content, {
        x: margin,
        y: cardBottom,
        width: perDayWidth,
        height: cardHeight,
        perDay: alerts.perDay,
        points: alertMonitoring.points,
        temperature: alertMonitoring.temperature,
        humidity: alertMonitoring.humidity,
      });
      appendPdfAlertDistribution(content, {
        x: margin + perDayWidth + chartGap,
        y: cardBottom,
        width: distributionWidth,
        height: cardHeight,
        alerts,
      });
      content.push(pdfText("Alert History", margin, tableTop + headerHeight + 8, 9, "0.08 0.14 0.22", "F2"));
    }

    if (productionOverviewPage) {
      const gap = 10;
      const cardBottom = 330;
      const cardHeight = 118;
      const listWidth = 196;
      const chartWidth = (tableWidth - listWidth - gap * 2) / 2;
      const periodLabel = production.periodStart && production.periodEnd
        ? `${production.periodStart} to ${production.periodEnd}`
        : (dataset.dateRange || "");
      content.push(pdfText("Complete Summary of All Batches", margin, 464, 10, "0.08 0.14 0.22", "F2"));
      content.push(pdfText(
        periodLabel ? `Period covered: ${periodLabel}` : "Every batch recorded by SmartDuck",
        margin,
        451,
        7,
        "0.39 0.46 0.56",
        "F1",
      ));
      appendPdfBatchSummaryList(content, {
        x: margin,
        y: cardBottom,
        width: listWidth,
        height: cardHeight,
        batches: production.batches,
      });
      appendPdfProductionBatchChart(content, {
        x: margin + listWidth + gap,
        y: cardBottom,
        width: chartWidth,
        height: cardHeight,
        batches: production.chart,
      });
      appendPdfHarvestRateChart(content, {
        x: margin + listWidth + chartWidth + gap * 2,
        y: cardBottom,
        width: chartWidth,
        height: cardHeight,
        batches: production.chart,
      });
      content.push(pdfText("Production of All Batches", margin, tableTop + headerHeight + 8, 9, "0.08 0.14 0.22", "F2"));
    }

    content.push(pdfRect(margin, tableTop, tableWidth, headerHeight, "0.08 0.14 0.22"));
    content.push(pdfStrokeRect(margin, tableTop - currentRows.length * rowHeight, tableWidth, headerHeight + currentRows.length * rowHeight, "0.82 0.87 0.92"));
    let currentX = margin;
    headers.forEach((header, index) => {
      content.push(pdfText(fitPdfText(header, columnWidths[index] - 14, 7, "F2"), currentX + 7, tableTop + 9, 7, "1 1 1", "F2"));
      currentX += columnWidths[index];
    });
    currentRows.forEach((row, rowIndex) => {
      const y = tableTop - (rowIndex + 1) * rowHeight;
      content.push(pdfRect(margin, y, tableWidth, rowHeight, rowIndex % 2 === 0 ? "1 1 1" : "0.96 0.98 1.00"));
      content.push(pdfStrokeRect(margin, y, tableWidth, rowHeight, "0.88 0.91 0.95", 0.3));
      currentX = margin;
      headers.forEach((header, cellIndex) => {
        const cell = row[cellIndex] ?? "";
        const isStatus = /status/i.test(header);
        const color = isStatus && /critical|fault/i.test(cell) ? "0.73 0.11 0.11" : isStatus && /completed|resolved/i.test(cell) ? "0.06 0.46 0.26" : isStatus && /in progress/i.test(cell) ? "0.82 0.42 0.04" : "0.13 0.18 0.27";
        content.push(pdfText(fitPdfText(cell, columnWidths[cellIndex] - 14, 7, isStatus ? "F2" : "F1"), currentX + 7, y + 9, 7, color, isStatus ? "F2" : "F1"));
        currentX += columnWidths[cellIndex];
      });
    });
    content.push(pdfRect(0, 0, pageWidth, 32, "0.96 0.98 1.00"));
    content.push(pdfText(
      isAlertReport
        ? "Generated from verified SmartDuck alert and monitoring records"
        : isProductionReport
          ? "All data is collected in real time from the SmartDuck IoT incubator"
          : "Generated from verified SmartDuck batch records",
      margin,
      13,
      8,
      "0.39 0.46 0.56",
    ));
    content.push(pdfText(`Page ${pageIndex + 1} of ${pageCount}`, pageWidth - 92, 13, 8, "0.39 0.46 0.56"));
    return content.join("\n");
  });

  const firstFontObjectId = 3 + pageCount * 2;
  const secondFontObjectId = firstFontObjectId + 1;
  const pageObjectIds = streams.map((_, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  ];
  streams.forEach((stream, index) => {
    const contentObjectId = 4 + index * 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${firstFontObjectId} 0 R /F2 ${secondFontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}

function escapeXml(value) {
  // Control characters and unpaired surrogates are illegal in XML 1.0 and make
  // Excel reject the whole workbook, so drop them before escaping.
  return String(value ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, (match) => (match.length === 2 ? match : ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getXlsxColumnName(index) {
  let column = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - remainder) / 26);
  }
  return column;
}

function createXlsxCell(value, rowNumber, columnIndex, styleIndex = 0, type = "text") {
  const reference = `${getXlsxColumnName(columnIndex)}${rowNumber}`;
  const style = styleIndex ? ` s="${styleIndex}"` : "";
  if (type === "number" && Number.isFinite(Number(value))) {
    return `<c r="${reference}"${style}><v>${Number(value)}</v></c>`;
  }
  return `<c r="${reference}" t="inlineStr"${style}><is><t>${escapeXml(value)}</t></is></c>`;
}

function createXlsxRow(values, rowNumber, styleIndex = 0, height = 22) {
  const cells = values.map((value, index) => createXlsxCell(value, rowNumber, index, styleIndex)).join("");
  return `<row r="${rowNumber}" ht="${height}" customHeight="1">${cells}</row>`;
}

function createXlsxStructuredRow(cells, rowNumber, height = 22, hidden = false) {
  const cellXml = cells
    .filter((cell) => Number.isInteger(cell?.column) && cell.column >= 0)
    .sort((left, right) => left.column - right.column)
    .map((cell) => createXlsxCell(cell.value, rowNumber, cell.column, cell.style || 0, cell.type || "text"))
    .join("");
  return `<row r="${rowNumber}" ht="${height}" customHeight="1"${hidden ? ' hidden="1"' : ""}>${cellXml}</row>`;
}

function encodeUtf8(value) {
  return new TextEncoder().encode(value);
}

const zipCrcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function getZipCrc32(bytes) {
  let crc = 0xffffffff;
  bytes.forEach((byte) => {
    crc = zipCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  });
  return (crc ^ 0xffffffff) >>> 0;
}

function pushZipUint16(target, value) {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function pushZipUint32(target, value) {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function concatZipParts(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}

function getZipDosTimestamp() {
  const date = new Date();
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function createZipArchive(files) {
  const parts = [];
  const centralDirectory = [];
  const timestamp = getZipDosTimestamp();
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encodeUtf8(file.name);
    const dataBytes = file.data instanceof Uint8Array ? file.data : encodeUtf8(file.data);
    const crc = getZipCrc32(dataBytes);
    const localHeader = [];

    pushZipUint32(localHeader, 0x04034b50);
    pushZipUint16(localHeader, 20);
    pushZipUint16(localHeader, 0x0800);
    pushZipUint16(localHeader, 0);
    pushZipUint16(localHeader, timestamp.time);
    pushZipUint16(localHeader, timestamp.date);
    pushZipUint32(localHeader, crc);
    pushZipUint32(localHeader, dataBytes.length);
    pushZipUint32(localHeader, dataBytes.length);
    pushZipUint16(localHeader, nameBytes.length);
    pushZipUint16(localHeader, 0);

    const localHeaderBytes = new Uint8Array(localHeader);
    parts.push(localHeaderBytes, nameBytes, dataBytes);

    const centralHeader = [];
    pushZipUint32(centralHeader, 0x02014b50);
    pushZipUint16(centralHeader, 20);
    pushZipUint16(centralHeader, 20);
    pushZipUint16(centralHeader, 0x0800);
    pushZipUint16(centralHeader, 0);
    pushZipUint16(centralHeader, timestamp.time);
    pushZipUint16(centralHeader, timestamp.date);
    pushZipUint32(centralHeader, crc);
    pushZipUint32(centralHeader, dataBytes.length);
    pushZipUint32(centralHeader, dataBytes.length);
    pushZipUint16(centralHeader, nameBytes.length);
    pushZipUint16(centralHeader, 0);
    pushZipUint16(centralHeader, 0);
    pushZipUint16(centralHeader, 0);
    pushZipUint16(centralHeader, 0);
    pushZipUint32(centralHeader, 0);
    pushZipUint32(centralHeader, offset);
    centralDirectory.push(new Uint8Array(centralHeader), nameBytes);

    offset += localHeaderBytes.length + nameBytes.length + dataBytes.length;
  });

  const centralDirectoryBytes = concatZipParts(centralDirectory);
  parts.push(centralDirectoryBytes);

  const endRecord = [];
  pushZipUint32(endRecord, 0x06054b50);
  pushZipUint16(endRecord, 0);
  pushZipUint16(endRecord, 0);
  pushZipUint16(endRecord, files.length);
  pushZipUint16(endRecord, files.length);
  pushZipUint32(endRecord, centralDirectoryBytes.length);
  pushZipUint32(endRecord, offset);
  pushZipUint16(endRecord, 0);
  parts.push(new Uint8Array(endRecord));

  return concatZipParts(parts);
}

// Widths are in characters, not pixels. The old per-header minimums ignored the
// actual cells, so a "Removed" column holding single digits was forced to 16
// characters and every date column to 30, which stretched the sheet far past
// the screen. Measure the content instead and only clamp the extremes.
function getReportExcelColumnWidth(samples) {
  const longest = samples.reduce((max, value) => Math.max(max, String(value ?? "").length), 0);
  return Math.min(46, Math.max(10, longest + 3));
}

/* A chart reference carries both the formula and a cached copy of the values it
   resolved to. Excel draws the cache first and only recalculates the formula on
   demand, so a chart written without one opens blank until the user forces a
   refresh. These build the <c:strCache>/<c:numCache> that go with <c:f>. */
function buildXlsxStringCache(values) {
  const points = normalizeReportList(values).map((value, index) => (
    `<c:pt idx="${index}"><c:v>${escapeXml(normalizeReportExportValue(value))}</c:v></c:pt>`
  )).join("");
  return `<c:strCache><c:ptCount val="${normalizeReportList(values).length}"/>${points}</c:strCache>`;
}

function buildXlsxNumberCache(values, formatCode = "General") {
  const list = normalizeReportList(values);
  const points = list.map((value, index) => {
    const numeric = Number(value);
    return `<c:pt idx="${index}"><c:v>${Number.isFinite(numeric) ? numeric : 0}</c:v></c:pt>`;
  }).join("");
  return `<c:numCache><c:formatCode>${escapeXml(formatCode)}</c:formatCode><c:ptCount val="${list.length}"/>${points}</c:numCache>`;
}

function buildXlsxLineChartXml({ sheetName, categoryRange, valueRange, seriesName, color, axisSeed, categories = [], values = [], numberFormat = "0.0" }) {
  const categoryAxisId = axisSeed;
  const valueAxisId = axisSeed + 1;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:autoTitleDeleted val="1"/>
    <c:plotArea>
      <c:layout/>
      <c:lineChart>
        <c:grouping val="standard"/>
        <c:varyColors val="0"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:v>${escapeXml(seriesName)}</c:v></c:tx>
          <c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>
          <c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr></c:marker>
          <c:cat><c:strRef><c:f>'${escapeXml(sheetName)}'!${categoryRange}</c:f>${buildXlsxStringCache(categories)}</c:strRef></c:cat>
          <c:val><c:numRef><c:f>'${escapeXml(sheetName)}'!${valueRange}</c:f>${buildXlsxNumberCache(values, numberFormat)}</c:numRef></c:val>
          <c:smooth val="0"/>
        </c:ser>
        <c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>
        <c:axId val="${categoryAxisId}"/><c:axId val="${valueAxisId}"/>
      </c:lineChart>
      <c:catAx>
        <c:axId val="${categoryAxisId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>
        <c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${valueAxisId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="${valueAxisId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>
        <c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>
        <c:numFmt formatCode="0.0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${categoryAxisId}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/>
      </c:valAx>
    </c:plotArea>
    <!-- plotVisOnly must stay 0: the series read the hidden helper columns, and
         Excel plots nothing from a hidden cell once it recalculates the chart. -->
    <c:plotVisOnly val="0"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/>
  </c:chart>
  <c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings>
</c:chartSpace>`;
}

function createReportXlsxArchive(dataset, worksheetXml, stylesXml, options = {}) {
  const additionalFiles = normalizeReportList(options.additionalFiles);
  const contentTypeOverrides = normalizeReportExportValue(options.contentTypeOverrides || "");
  const workbookExtras = String(options.workbookExtras || "");
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  ${contentTypeOverrides}
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    },
    {
      name: "docProps/app.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>SmartDuck</Application></Properties>`,
    },
    {
      name: "docProps/core.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>SmartDuck</dc:creator><dc:title>${escapeXml(dataset.title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="SmartDuck Report" sheetId="1" r:id="rId1"/></sheets>${workbookExtras}
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: "xl/styles.xml", data: stylesXml },
    { name: "xl/worksheets/sheet1.xml", data: worksheetXml },
    ...additionalFiles,
  ];
  return createZipArchive(files);
}

function getBatchExcelStatusStyle(value) {
  const status = normalizeReportExportValue(value).toLowerCase();
  if (/completed|active|online|on$/.test(status)) return 17;
  if (/scheduled|in progress|warning|auto/.test(status)) return 18;
  if (/critical|fault|offline/.test(status)) return 19;
  return 16;
}

// Both the batch and the alert workbook render the same card/table styling,
// so the style sheet is shared rather than duplicated per report kind.
function getReportExcelStylesXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="10">
    <font><sz val="10"/><color rgb="FF17212F"/><name val="Aptos"/></font>
    <font><b/><sz val="20"/><color rgb="FF10233E"/><name val="Aptos Display"/></font>
    <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>
    <font><b/><sz val="9"/><color rgb="FF64748B"/><name val="Aptos"/></font>
    <font><b/><sz val="12"/><color rgb="FF10233E"/><name val="Aptos"/></font>
    <font><b/><sz val="10"/><color rgb="FF15803D"/><name val="Aptos"/></font>
    <font><b/><sz val="10"/><color rgb="FF2563EB"/><name val="Aptos"/></font>
    <font><b/><sz val="10"/><color rgb="FF15803D"/><name val="Aptos"/></font>
    <font><b/><sz val="10"/><color rgb="FFB45309"/><name val="Aptos"/></font>
    <font><b/><sz val="10"/><color rgb="FFB91C1C"/><name val="Aptos"/></font>
  </fonts>
  <fills count="11">
    <fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF10233E"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF5F8FC"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF59E0B"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF0FDF4"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFECFDF3"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF7E6"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF2F2"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></patternFill></fill>
  </fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD9E2EC"/></left><right style="thin"><color rgb="FFD9E2EC"/></right><top style="thin"><color rgb="FFD9E2EC"/></top><bottom style="thin"><color rgb="FFD9E2EC"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="21">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>
    <xf numFmtId="0" fontId="1" fillId="10" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="10" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="10" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="10" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="10" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="10" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="5" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="6" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="6" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="10" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="10" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="7" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="8" fillId="8" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="9" fillId="9" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function buildBatchReportExcelWorkbook(dataset) {
  const headers = dataset.headers.map(normalizeReportExportValue);
  const rows = dataset.rows.map((row) => row.map(normalizeReportExportValue));
  const monitoring = normalizeReportMonitoring(dataset.monitoring);
  const generatedAt = dataset.generatedOn ? formatReportTableDate(dataset.generatedOn) : new Date().toLocaleString("en-US");
  const summaryByLabel = new Map(normalizeReportList(dataset.summary).map((item) => [
    normalizeReportExportValue(item?.label).toLowerCase(),
    normalizeReportExportValue(item?.value),
  ]));
  // The six KPI cells across the top. A single-batch report names its own
  // fields; the all-batches roll-up has different ones, so take whichever six
  // the dataset actually supplied rather than printing "--" six times.
  const preferredSummaryLabels = ["Batch ID", "Status", "Initial Eggs", "Remaining Eggs", "Removed Eggs", "Current Day"];
  const summaryLabels = preferredSummaryLabels.every((label) => summaryByLabel.has(label.toLowerCase()))
    ? preferredSummaryLabels
    : normalizeReportList(dataset.summary)
        .map((item) => normalizeReportExportValue(item?.label))
        .filter(Boolean)
        .slice(0, 6);
  const visibleRows = new Map();
  const merges = [];
  const setRow = (rowNumber, height, cells = []) => visibleRows.set(rowNumber, { height, cells });
  const merge = (fromColumn, rowNumber, toColumn) => merges.push(`${getXlsxColumnName(fromColumn)}${rowNumber}:${getXlsxColumnName(toColumn)}${rowNumber}`);
  const mergedCell = (cells, rowNumber, fromColumn, toColumn, value, style) => {
    cells.push({ column: fromColumn, value, style });
    if (toColumn > fromColumn) merge(fromColumn, rowNumber, toColumn);
  };

  setRow(1, 5, [{ column: 0, value: "", style: 1 }]);
  merge(0, 1, 11);
  const titleCells = [];
  mergedCell(titleCells, 2, 0, 7, dataset.title, 2);
  mergedCell(titleCells, 2, 8, 11, `Report ID: ${dataset.reportId || "SmartDuck"}`, 4);
  setRow(2, 30, titleCells);
  const subtitleCells = [];
  mergedCell(subtitleCells, 3, 0, 7, dataset.subtitle, 3);
  mergedCell(subtitleCells, 3, 8, 11, `Generated: ${generatedAt}`, 4);
  setRow(3, 22, subtitleCells);
  const metaCells = [];
  mergedCell(metaCells, 4, 0, 7, `Generated by: ${dataset.generatedBy || getAuthenticatedUser()}`, 3);
  mergedCell(metaCells, 4, 8, 11, `Records: ${rows.length}`, 4);
  setRow(4, 20, metaCells);
  setRow(5, 8, []);

  const summaryLabelCells = [];
  const summaryValueCells = [];
  summaryLabels.forEach((label, index) => {
    const fromColumn = index * 2;
    const toColumn = fromColumn + 1;
    mergedCell(summaryLabelCells, 6, fromColumn, toColumn, label, 6);
    mergedCell(summaryValueCells, 7, fromColumn, toColumn, summaryByLabel.get(label.toLowerCase()) || "--", 7);
  });
  setRow(6, 20, summaryLabelCells);
  setRow(7, 26, summaryValueCells);
  setRow(8, 10, []);
  const overviewCells = [];
  mergedCell(overviewCells, 9, 0, 11, "Monitoring Overview", 8);
  setRow(9, 24, overviewCells);
  const overviewLeadCells = [];
  mergedCell(overviewLeadCells, 10, 0, 11, "Real batch readings and current incubator status", 3);
  setRow(10, 19, overviewLeadCells);

  const panelTitleCells = [];
  mergedCell(panelTitleCells, 11, 0, 3, "Temperature (C)", 9);
  mergedCell(panelTitleCells, 11, 4, 7, "Humidity (%)", 10);
  mergedCell(panelTitleCells, 11, 8, 11, "System Status", 11);
  setRow(11, 24, panelTitleCells);
  const panelMetaCells = [];
  mergedCell(panelMetaCells, 12, 0, 3, monitoring.temperature.average === null
    ? "No readings recorded"
    : `Avg ${monitoring.temperature.average} C | Min ${monitoring.temperature.minimum} C | Max ${monitoring.temperature.maximum} C`, 12);
  mergedCell(panelMetaCells, 12, 4, 7, monitoring.humidity.average === null
    ? "No readings recorded"
    : `Avg ${monitoring.humidity.average}% | Min ${monitoring.humidity.minimum}% | Max ${monitoring.humidity.maximum}%`, 13);
  mergedCell(panelMetaCells, 12, 8, 11, monitoring.deviceOnline ? "ESP32 DEVICE: ONLINE" : "ESP32 DEVICE: OFFLINE", monitoring.deviceOnline ? 17 : 19);
  setRow(12, 24, panelMetaCells);
  const targetCells = [];
  mergedCell(targetCells, 13, 0, 3, "Target: 37.3 C - 37.7 C", 12);
  mergedCell(targetCells, 13, 4, 7, `Recorded sensor samples: ${monitoring.readingCount}`, 13);
  mergedCell(targetCells, 13, 8, 11, monitoring.deviceLastSeenAt
    ? `Last seen: ${formatReportCellValue(monitoring.deviceLastSeenAt)}`
    : "No device heartbeat recorded", 14);
  setRow(13, 22, targetCells);

  // "No sensor readings" has to follow the readings, not the daily chart points.
  // The all-batches roll-up reports a real reading count and real averages but
  // carries no per-day points, so keying off points printed that line directly
  // under "Avg 34.4 C" and "Recorded sensor samples: 71331" -- the sheet
  // contradicted itself. Say it only when nothing was actually recorded.
  const hasReadings = monitoring.readingCount > 0
    || monitoring.temperature.average !== null
    || monitoring.humidity.average !== null;
  for (let rowNumber = 14; rowNumber <= 22; rowNumber += 1) {
    const component = monitoring.components[rowNumber - 14];
    const cells = [];
    if (!hasReadings && rowNumber === 16) {
      mergedCell(cells, rowNumber, 0, 3, "No sensor readings recorded for this batch.", 12);
      mergedCell(cells, rowNumber, 4, 7, "No sensor readings recorded for this batch.", 13);
    }
    if (component) {
      mergedCell(cells, rowNumber, 8, 9, component.name, 14);
      mergedCell(cells, rowNumber, 10, 11, component.status, getBatchExcelStatusStyle(component.status));
    } else if (!monitoring.components.length && rowNumber === 14) {
      mergedCell(cells, rowNumber, 8, 11, "No component status recorded.", 14);
    }
    setRow(rowNumber, 20, cells);
  }

  const tableHeaderRow = 24;
  setRow(23, 10, []);
  const tableHeaderCells = [];
  // The milestone table is nine columns wide and spreads across the sheet's
  // twelve. A wider dataset (the all-batches roll-up is twelve) gets one
  // column each instead, so nothing overlaps or spills past column L.
  const useWideLayout = headers.length > 9;
  const tableColumnStarts = useWideLayout
    ? headers.map((_, index) => Math.min(index, 11))
    : [0, 1, 2, 4, 5, 6, 7, 8, 9];
  const tableColumnEnds = useWideLayout
    ? headers.map((_, index) => Math.min(index, 11))
    : [0, 1, 3, 4, 5, 6, 7, 8, 11];
  headers.forEach((header, index) => mergedCell(
    tableHeaderCells,
    tableHeaderRow,
    tableColumnStarts[index] ?? Math.min(index, 11),
    tableColumnEnds[index] ?? Math.min(index, 11),
    header,
    15,
  ));
  setRow(tableHeaderRow, 28, tableHeaderCells);
  rows.forEach((row, rowIndex) => {
    const rowNumber = tableHeaderRow + rowIndex + 1;
    const cells = [];
    row.forEach((value, index) => {
      const style = /status/i.test(headers[index] || "") ? getBatchExcelStatusStyle(value) : 16;
      mergedCell(cells, rowNumber, tableColumnStarts[index] ?? Math.min(index, 11), tableColumnEnds[index] ?? Math.min(index, 11), value, style);
    });
    setRow(rowNumber, 26, cells);
  });
  const footerRow = tableHeaderRow + rows.length + 2;
  const footerCells = [];
  mergedCell(footerCells, footerRow, 0, 11, "All monitoring data is collected from verified SmartDuck batch and IoT records.", 20);
  setRow(footerRow, 24, footerCells);

  monitoring.points.slice(0, 8).forEach((point, index) => {
    const rowNumber = index + 2;
    const row = visibleRows.get(rowNumber) || { height: 20, cells: [] };
    row.cells.push(
      { column: 13, value: point.label || point.date, style: 0 },
      { column: 14, value: point.temperatureC, style: 0, type: "number" },
      { column: 15, value: point.humidityPercent, style: 0, type: "number" },
    );
    visibleRows.set(rowNumber, row);
  });

  const rowXml = Array.from({ length: footerRow }, (_, index) => {
    const rowNumber = index + 1;
    const row = visibleRows.get(rowNumber) || { height: 20, cells: [] };
    return createXlsxStructuredRow(row.cells, rowNumber, row.height);
  }).join("");
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((reference) => `<mergeCell ref="${reference}"/>`).join("")}</mergeCells>`
    : "";
  const hasCharts = monitoring.points.length > 0;
  const drawingXml = hasCharts ? `<drawing r:id="rId1"/>` : "";
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:P${footerRow}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="85" zoomScaleNormal="85"/></sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  <cols>
    <col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="14" customWidth="1"/>
    <col min="3" max="4" width="13" customWidth="1"/><col min="5" max="5" width="14" customWidth="1"/>
    <col min="6" max="6" width="13" customWidth="1"/><col min="7" max="8" width="11" customWidth="1"/>
    <col min="9" max="9" width="17" customWidth="1"/><col min="10" max="12" width="14" customWidth="1"/>
    <col min="14" max="16" width="12" hidden="1" customWidth="1"/>
  </cols>
  <sheetData>${rowXml}</sheetData>
  ${mergeXml}
  <printOptions horizontalCentered="1"/>
  <pageMargins left="0.25" right="0.25" top="0.35" bottom="0.35" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="1" paperSize="9"/>
  ${drawingXml}
</worksheet>`;

  const stylesXml = getReportExcelStylesXml();

  const additionalFiles = [];
  let contentTypeOverrides = "";
  if (hasCharts) {
    const pointCount = Math.min(8, monitoring.points.length);
    const endRow = pointCount + 1;
    // The same eight points that were written into the hidden N:P helper
    // columns above, so the cached series matches the cells the formula names.
    const chartPoints = monitoring.points.slice(0, pointCount);
    additionalFiles.push(
      {
        name: "xl/worksheets/_rels/sheet1.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
      },
      {
        name: "xl/drawings/drawing1.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>13</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Temperature Trend"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
  <xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>13</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Humidity Trend"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId2"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
</xdr:wsDr>`,
      },
      {
        name: "xl/drawings/_rels/drawing1.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/></Relationships>`,
      },
      {
        name: "xl/charts/chart1.xml",
        data: buildXlsxLineChartXml({
          sheetName: "SmartDuck Report",
          categoryRange: `$N$2:$N$${endRow}`,
          valueRange: `$O$2:$O$${endRow}`,
          seriesName: "Temperature (C)",
          color: "16A34A",
          axisSeed: 510001,
          categories: chartPoints.map((point) => point.label || point.date),
          values: chartPoints.map((point) => point.temperatureC),
        }),
      },
      {
        name: "xl/charts/chart2.xml",
        data: buildXlsxLineChartXml({
          sheetName: "SmartDuck Report",
          categoryRange: `$N$2:$N$${endRow}`,
          valueRange: `$P$2:$P$${endRow}`,
          seriesName: "Humidity (%)",
          color: "2563EB",
          axisSeed: 520001,
          categories: chartPoints.map((point) => point.label || point.date),
          values: chartPoints.map((point) => point.humidityPercent),
        }),
      },
    );
    contentTypeOverrides = '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/charts/chart2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>';
  }
  const workbookExtras = `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'SmartDuck Report'!$A$1:$L$${footerRow}</definedName></definedNames>`;
  return createReportXlsxArchive(dataset, worksheetXml, stylesXml, { additionalFiles, contentTypeOverrides, workbookExtras });
}

// Alerts per day is a count, so it is drawn as a stacked column chart rather
// than the line chart the sensor trends use. One series per alert type keeps
// the segment colours matching the PDF and the dashboard.
function buildXlsxAlertColumnChartXml({ sheetName, categoryRange, series, axisSeed, grouping = "stacked", categories = [] }) {
  const categoryAxisId = axisSeed;
  const valueAxisId = axisSeed + 1;
  const categoryCache = buildXlsxStringCache(categories);
  const seriesXml = series.map((entry, index) => `
        <c:ser>
          <c:idx val="${index}"/><c:order val="${index}"/>
          <c:tx><c:v>${escapeXml(entry.name)}</c:v></c:tx>
          <c:spPr><a:solidFill><a:srgbClr val="${entry.color}"/></a:solidFill></c:spPr>
          <c:cat><c:strRef><c:f>'${escapeXml(sheetName)}'!${categoryRange}</c:f>${categoryCache}</c:strRef></c:cat>
          <c:val><c:numRef><c:f>'${escapeXml(sheetName)}'!${entry.valueRange}</c:f>${buildXlsxNumberCache(entry.values, "0")}</c:numRef></c:val>
        </c:ser>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:autoTitleDeleted val="1"/>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="${grouping}"/>
        <c:varyColors val="0"/>${seriesXml}
        <c:gapWidth val="60"/>
        <c:overlap val="${grouping === "stacked" ? 100 : -10}"/>
        <c:axId val="${categoryAxisId}"/><c:axId val="${valueAxisId}"/>
      </c:barChart>
      <c:catAx>
        <c:axId val="${categoryAxisId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>
        <c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${valueAxisId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="${valueAxisId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>
        <c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>
        <c:numFmt formatCode="0" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${categoryAxisId}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/>
      </c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>
    <!-- plotVisOnly must stay 0: the series read the hidden helper columns, and
         Excel plots nothing from a hidden cell once it recalculates the chart. -->
    <c:plotVisOnly val="0"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/>
  </c:chart>
  <c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings>
</c:chartSpace>`;
}

// The alert workbook mirrors the alert PDF: KPI cards, the per-day chart, the
// type distribution, then the full alert history table.
function buildAlertReportExcelWorkbook(dataset) {
  const headers = dataset.headers.map(normalizeReportExportValue);
  const rows = dataset.rows.map((row) => row.map(normalizeReportExportValue));
  const alerts = normalizeReportAlerts(dataset.alerts);
  const generatedAt = dataset.generatedOn ? formatReportTableDate(dataset.generatedOn) : new Date().toLocaleString("en-US");
  const visibleRows = new Map();
  const merges = [];
  const setRow = (rowNumber, height, cells = []) => visibleRows.set(rowNumber, { height, cells });
  const merge = (fromColumn, rowNumber, toColumn) => merges.push(`${getXlsxColumnName(fromColumn)}${rowNumber}:${getXlsxColumnName(toColumn)}${rowNumber}`);
  const mergedCell = (cells, rowNumber, fromColumn, toColumn, value, style) => {
    cells.push({ column: fromColumn, value, style });
    if (toColumn > fromColumn) merge(fromColumn, rowNumber, toColumn);
  };

  setRow(1, 5, [{ column: 0, value: "", style: 1 }]);
  merge(0, 1, 11);
  const titleCells = [];
  mergedCell(titleCells, 2, 0, 7, dataset.title, 2);
  mergedCell(titleCells, 2, 8, 11, `Report ID: ${dataset.reportId || "SmartDuck"}`, 4);
  setRow(2, 30, titleCells);
  const subtitleCells = [];
  mergedCell(subtitleCells, 3, 0, 7, dataset.subtitle, 3);
  mergedCell(subtitleCells, 3, 8, 11, `Generated: ${generatedAt}`, 4);
  setRow(3, 22, subtitleCells);
  const metaCells = [];
  mergedCell(metaCells, 4, 0, 7, `Generated by: ${dataset.generatedBy || getAuthenticatedUser()}`, 3);
  mergedCell(metaCells, 4, 8, 11, `Records: ${rows.length}`, 4);
  setRow(4, 20, metaCells);
  setRow(5, 8, []);

  const kpis = [
    ["Total Alerts", alerts.total],
    ["Temperature Alerts", alerts.temperature],
    ["Humidity Alerts", alerts.humidity],
    ["System / Other Alerts", alerts.system],
    ["Active", alerts.active],
    ["Resolved", alerts.resolved],
  ];
  const kpiLabelCells = [];
  const kpiValueCells = [];
  kpis.forEach(([label, value], index) => {
    const fromColumn = index * 2;
    mergedCell(kpiLabelCells, 6, fromColumn, fromColumn + 1, label, 6);
    mergedCell(kpiValueCells, 7, fromColumn, fromColumn + 1, String(value), 7);
  });
  setRow(6, 20, kpiLabelCells);
  setRow(7, 26, kpiValueCells);
  setRow(8, 10, []);

  const overviewCells = [];
  mergedCell(overviewCells, 9, 0, 11, "Alert Overview", 8);
  setRow(9, 24, overviewCells);
  const leadCells = [];
  mergedCell(leadCells, 10, 0, 11, dataset.dateRange
    ? `Alerts recorded during this incubation period (${dataset.dateRange})`
    : "Alerts recorded during this incubation period", 3);
  setRow(10, 19, leadCells);

  // Style 8 is the bold navy section heading. The green/blue panel styles the
  // batch sheet uses are tied to its temperature and humidity cards, so they
  // would miscolour these two panels.
  const panelTitleCells = [];
  mergedCell(panelTitleCells, 11, 0, 7, "Alerts Per Day", 8);
  mergedCell(panelTitleCells, 11, 8, 11, "Alerts Distribution", 8);
  setRow(11, 24, panelTitleCells);

  // The distribution shares the chart's rows: the chart is anchored over the
  // left columns while the split is listed down the right-hand panel.
  const distribution = [
    ["Temperature Alerts", alerts.temperature],
    ["Humidity Alerts", alerts.humidity],
    ["System / Other Alerts", alerts.system],
  ];
  for (let rowNumber = 12; rowNumber <= 22; rowNumber += 1) {
    const cells = [];
    if (!alerts.perDay.length && rowNumber === 16) {
      mergedCell(cells, rowNumber, 0, 7, "No alerts recorded for this batch.", 12);
    }
    const entry = distribution[rowNumber - 12];
    if (entry) {
      const share = alerts.total > 0 ? Math.round((entry[1] / alerts.total) * 100) : 0;
      mergedCell(cells, rowNumber, 8, 9, entry[0], 14);
      mergedCell(cells, rowNumber, 10, 11, `${entry[1]} (${share}%)`, 16);
    } else if (rowNumber === 15) {
      mergedCell(cells, rowNumber, 8, 11, `Total alerts: ${alerts.total}`, 14);
    }
    setRow(rowNumber, 20, cells);
  }

  const tableHeaderRow = 24;
  setRow(23, 10, []);
  // Eight history columns spread across the same twelve-column grid the header
  // band uses, so the table lines up with the cards above it.
  const tableColumnStarts = [0, 2, 3, 5, 6, 7, 9, 11];
  const tableColumnEnds = [1, 2, 4, 5, 6, 8, 10, 11];
  const tableHeaderCells = [];
  headers.forEach((header, index) => mergedCell(
    tableHeaderCells,
    tableHeaderRow,
    tableColumnStarts[index] ?? Math.min(index, 11),
    tableColumnEnds[index] ?? Math.min(index, 11),
    header,
    15,
  ));
  setRow(tableHeaderRow, 28, tableHeaderCells);
  rows.forEach((row, rowIndex) => {
    const rowNumber = tableHeaderRow + rowIndex + 1;
    const cells = [];
    row.forEach((value, index) => {
      const header = headers[index] || "";
      const style = /status|severity/i.test(header) ? getBatchExcelStatusStyle(value) : 16;
      mergedCell(
        cells,
        rowNumber,
        tableColumnStarts[index] ?? Math.min(index, 11),
        tableColumnEnds[index] ?? Math.min(index, 11),
        value,
        style,
      );
    });
    setRow(rowNumber, 26, cells);
  });
  if (!rows.length) {
    const emptyCells = [];
    mergedCell(emptyCells, tableHeaderRow + 1, 0, 11, "No alerts recorded for this batch.", 16);
    setRow(tableHeaderRow + 1, 26, emptyCells);
  }
  const footerRow = tableHeaderRow + Math.max(rows.length, 1) + 2;
  const footerCells = [];
  mergedCell(footerCells, footerRow, 0, 11, "All alert data is collected from verified SmartDuck notification and IoT records.", 20);
  setRow(footerRow, 24, footerCells);

  // Hidden helper columns feed the chart its categories and stacked series.
  const chartPoints = alerts.perDay.slice(0, 18);
  chartPoints.forEach((entry, index) => {
    const rowNumber = index + 2;
    const row = visibleRows.get(rowNumber) || { height: 20, cells: [] };
    row.cells.push(
      { column: 13, value: entry.label, style: 0 },
      { column: 14, value: entry.temperature, style: 0, type: "number" },
      { column: 15, value: entry.humidity, style: 0, type: "number" },
      { column: 16, value: entry.system, style: 0, type: "number" },
    );
    visibleRows.set(rowNumber, row);
  });

  const rowXml = Array.from({ length: footerRow }, (_, index) => {
    const rowNumber = index + 1;
    const row = visibleRows.get(rowNumber) || { height: 20, cells: [] };
    return createXlsxStructuredRow(row.cells, rowNumber, row.height);
  }).join("");
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((reference) => `<mergeCell ref="${reference}"/>`).join("")}</mergeCells>`
    : "";
  const hasChart = chartPoints.length > 0;
  const drawingXml = hasChart ? `<drawing r:id="rId1"/>` : "";
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:Q${footerRow}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="85" zoomScaleNormal="85"/></sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  <cols>
    <col min="1" max="2" width="13" customWidth="1"/><col min="3" max="3" width="10" customWidth="1"/>
    <col min="4" max="5" width="14" customWidth="1"/><col min="6" max="6" width="12" customWidth="1"/>
    <col min="7" max="8" width="13" customWidth="1"/><col min="9" max="9" width="14" customWidth="1"/>
    <col min="10" max="12" width="13" customWidth="1"/>
    <col min="14" max="17" width="12" hidden="1" customWidth="1"/>
  </cols>
  <sheetData>${rowXml}</sheetData>
  ${mergeXml}
  <printOptions horizontalCentered="1"/>
  <pageMargins left="0.25" right="0.25" top="0.35" bottom="0.35" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="1" paperSize="9"/>
  ${drawingXml}
</worksheet>`;

  const additionalFiles = [];
  let contentTypeOverrides = "";
  if (hasChart) {
    const endRow = chartPoints.length + 1;
    additionalFiles.push(
      {
        name: "xl/worksheets/_rels/sheet1.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
      },
      {
        name: "xl/drawings/drawing1.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Alerts Per Day"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
</xdr:wsDr>`,
      },
      {
        name: "xl/drawings/_rels/drawing1.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`,
      },
      {
        name: "xl/charts/chart1.xml",
        data: buildXlsxAlertColumnChartXml({
          sheetName: "SmartDuck Report",
          categoryRange: `$N$2:$N$${endRow}`,
          axisSeed: 530001,
          categories: chartPoints.map((entry) => entry.label),
          series: [
            { name: "Temperature Alerts", valueRange: `$O$2:$O$${endRow}`, color: "EF4444", values: chartPoints.map((entry) => entry.temperature) },
            { name: "Humidity Alerts", valueRange: `$P$2:$P$${endRow}`, color: "2563EB", values: chartPoints.map((entry) => entry.humidity) },
            { name: "System / Other Alerts", valueRange: `$Q$2:$Q$${endRow}`, color: "D97706", values: chartPoints.map((entry) => entry.system) },
          ],
        }),
      },
    );
    contentTypeOverrides = '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>';
  }
  const workbookExtras = `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'SmartDuck Report'!$A$1:$L$${footerRow}</definedName></definedNames>`;
  return createReportXlsxArchive(dataset, worksheetXml, getReportExcelStylesXml(), { additionalFiles, contentTypeOverrides, workbookExtras });
}

// The production workbook mirrors the production PDF: the KPI band, the
// harvested/rejected columns and harvest-rate line as native Excel charts,
// then the all-batches table.
function buildProductionReportExcelWorkbook(dataset) {
  const headers = dataset.headers.map(normalizeReportExportValue);
  const rows = dataset.rows.map((row) => row.map(normalizeReportExportValue));
  const production = normalizeReportProduction(dataset.production);
  const generatedAt = dataset.generatedOn ? formatReportTableDate(dataset.generatedOn) : new Date().toLocaleString("en-US");
  const visibleRows = new Map();
  const merges = [];
  const setRow = (rowNumber, height, cells = []) => visibleRows.set(rowNumber, { height, cells });
  const merge = (fromColumn, rowNumber, toColumn) => merges.push(`${getXlsxColumnName(fromColumn)}${rowNumber}:${getXlsxColumnName(toColumn)}${rowNumber}`);
  const mergedCell = (cells, rowNumber, fromColumn, toColumn, value, style) => {
    cells.push({ column: fromColumn, value, style });
    if (toColumn > fromColumn) merge(fromColumn, rowNumber, toColumn);
  };

  setRow(1, 5, [{ column: 0, value: "", style: 1 }]);
  merge(0, 1, 11);
  const titleCells = [];
  mergedCell(titleCells, 2, 0, 7, dataset.title, 2);
  mergedCell(titleCells, 2, 8, 11, `Report ID: ${dataset.reportId || "SmartDuck"}`, 4);
  setRow(2, 30, titleCells);
  const periodLabel = production.periodStart && production.periodEnd
    ? `${production.periodStart} to ${production.periodEnd}`
    : (dataset.dateRange || "");
  const subtitleCells = [];
  mergedCell(subtitleCells, 3, 0, 7, dataset.subtitle, 3);
  mergedCell(subtitleCells, 3, 8, 11, `Generated: ${generatedAt}`, 4);
  setRow(3, 22, subtitleCells);
  const metaCells = [];
  mergedCell(metaCells, 4, 0, 7, periodLabel ? `Period covered: ${periodLabel}` : `Generated by: ${dataset.generatedBy || getAuthenticatedUser()}`, 3);
  mergedCell(metaCells, 4, 8, 11, `Batches: ${production.totalBatches}`, 4);
  setRow(4, 20, metaCells);
  setRow(5, 8, []);

  const kpis = [
    ["Total Batches", String(production.totalBatches)],
    ["Total Eggs Set", String(production.totalEggsSet)],
    ["Total Harvested", String(production.totalHarvested)],
    ["Total Rejected", String(production.totalRejected)],
    ["Overall Harvest Rate", `${production.averageHarvestRate.toFixed(1)}%`],
    ["Incubator Capacity", production.incubatorCapacity ? `${production.incubatorCapacity} eggs` : "--"],
  ];
  const kpiLabelCells = [];
  const kpiValueCells = [];
  kpis.forEach(([label, value], index) => {
    const fromColumn = index * 2;
    mergedCell(kpiLabelCells, 6, fromColumn, fromColumn + 1, label, 6);
    mergedCell(kpiValueCells, 7, fromColumn, fromColumn + 1, value, 7);
  });
  setRow(6, 20, kpiLabelCells);
  setRow(7, 26, kpiValueCells);
  setRow(8, 10, []);

  const overviewCells = [];
  mergedCell(overviewCells, 9, 0, 11, "Production Overview", 8);
  setRow(9, 24, overviewCells);
  const leadCells = [];
  mergedCell(leadCells, 10, 0, 11, "Harvested and rejected counts per batch, with the harvest rate over time.", 3);
  setRow(10, 19, leadCells);

  const panelTitleCells = [];
  mergedCell(panelTitleCells, 11, 0, 5, "Total Eggs Set vs Harvested / Rejected per Batch", 8);
  mergedCell(panelTitleCells, 11, 6, 11, "Harvest Rate (%) Over Time", 8);
  setRow(11, 24, panelTitleCells);
  for (let rowNumber = 12; rowNumber <= 22; rowNumber += 1) {
    const cells = [];
    if (!production.chart.length && rowNumber === 16) {
      mergedCell(cells, rowNumber, 0, 11, "No batches recorded yet.", 16);
    }
    setRow(rowNumber, 20, cells);
  }

  const tableHeaderRow = 24;
  setRow(23, 10, []);
  // Eight columns spread across the twelve-column grid the header band uses.
  const tableColumnStarts = [0, 2, 3, 5, 6, 8, 9, 11];
  const tableColumnEnds = [1, 2, 4, 5, 7, 8, 10, 11];
  const tableHeaderCells = [];
  headers.forEach((header, index) => mergedCell(
    tableHeaderCells,
    tableHeaderRow,
    tableColumnStarts[index] ?? Math.min(index, 11),
    tableColumnEnds[index] ?? Math.min(index, 11),
    header,
    15,
  ));
  setRow(tableHeaderRow, 28, tableHeaderCells);
  rows.forEach((row, rowIndex) => {
    const rowNumber = tableHeaderRow + rowIndex + 1;
    const cells = [];
    row.forEach((value, index) => {
      const style = /status/i.test(headers[index] || "") ? getBatchExcelStatusStyle(value) : 16;
      mergedCell(
        cells,
        rowNumber,
        tableColumnStarts[index] ?? Math.min(index, 11),
        tableColumnEnds[index] ?? Math.min(index, 11),
        value,
        style,
      );
    });
    setRow(rowNumber, 26, cells);
  });
  if (!rows.length) {
    const emptyCells = [];
    mergedCell(emptyCells, tableHeaderRow + 1, 0, 11, "No batches recorded yet.", 16);
    setRow(tableHeaderRow + 1, 26, emptyCells);
  }
  // Totals row, so the sheet reconciles with the KPI band above it.
  const totalsRow = tableHeaderRow + Math.max(rows.length, 1) + 1;
  if (rows.length) {
    const totalsCells = [];
    mergedCell(totalsCells, totalsRow, 0, 4, "TOTAL", 15);
    mergedCell(totalsCells, totalsRow, 5, 5, String(production.totalEggsSet), 15);
    mergedCell(totalsCells, totalsRow, 6, 7, String(production.totalHarvested), 15);
    mergedCell(totalsCells, totalsRow, 8, 8, String(production.totalRejected), 15);
    mergedCell(totalsCells, totalsRow, 9, 11, `${production.averageHarvestRate.toFixed(1)}%`, 15);
    setRow(totalsRow, 26, totalsCells);
  }
  const footerRow = totalsRow + 2;
  const footerCells = [];
  mergedCell(footerCells, footerRow, 0, 11, "All data is collected in real time from the SmartDuck IoT incubator.", 20);
  setRow(footerRow, 24, footerCells);

  // Hidden helper columns feed the two charts.
  const chartPoints = production.chart.slice(0, 24);
  chartPoints.forEach((entry, index) => {
    const rowNumber = index + 2;
    const row = visibleRows.get(rowNumber) || { height: 20, cells: [] };
    row.cells.push(
      { column: 13, value: entry.label, style: 0 },
      { column: 14, value: entry.harvested, style: 0, type: "number" },
      { column: 15, value: entry.rejected, style: 0, type: "number" },
      { column: 16, value: entry.harvestRate, style: 0, type: "number" },
    );
    visibleRows.set(rowNumber, row);
  });

  const rowXml = Array.from({ length: footerRow }, (_, index) => {
    const rowNumber = index + 1;
    const row = visibleRows.get(rowNumber) || { height: 20, cells: [] };
    return createXlsxStructuredRow(row.cells, rowNumber, row.height);
  }).join("");
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map((reference) => `<mergeCell ref="${reference}"/>`).join("")}</mergeCells>`
    : "";
  const hasCharts = chartPoints.length > 0;
  const drawingXml = hasCharts ? `<drawing r:id="rId1"/>` : "";
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:Q${footerRow}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="85" zoomScaleNormal="85"/></sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  <cols>
    <col min="1" max="2" width="13" customWidth="1"/><col min="3" max="3" width="12" customWidth="1"/>
    <col min="4" max="5" width="13" customWidth="1"/><col min="6" max="6" width="12" customWidth="1"/>
    <col min="7" max="9" width="13" customWidth="1"/><col min="10" max="12" width="13" customWidth="1"/>
    <col min="14" max="17" width="12" hidden="1" customWidth="1"/>
  </cols>
  <sheetData>${rowXml}</sheetData>
  ${mergeXml}
  <printOptions horizontalCentered="1"/>
  <pageMargins left="0.25" right="0.25" top="0.35" bottom="0.35" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="1" paperSize="9"/>
  ${drawingXml}
</worksheet>`;

  const additionalFiles = [];
  let contentTypeOverrides = "";
  if (hasCharts) {
    const endRow = chartPoints.length + 1;
    additionalFiles.push(
      {
        name: "xl/worksheets/_rels/sheet1.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
      },
      {
        name: "xl/drawings/drawing1.xml",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Harvested vs Rejected"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
  <xdr:twoCellAnchor><xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Harvest Rate"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId2"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
</xdr:wsDr>`,
      },
      {
        name: "xl/drawings/_rels/drawing1.xml.rels",
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/></Relationships>`,
      },
      {
        name: "xl/charts/chart1.xml",
        data: buildXlsxAlertColumnChartXml({
          sheetName: "SmartDuck Report",
          categoryRange: `$N$2:$N$${endRow}`,
          axisSeed: 540001,
          grouping: "clustered",
          categories: chartPoints.map((entry) => entry.label),
          series: [
            { name: "Harvested (Balut)", valueRange: `$O$2:$O$${endRow}`, color: "16A34A", values: chartPoints.map((entry) => entry.harvested) },
            { name: "Rejected / Penoy", valueRange: `$P$2:$P$${endRow}`, color: "EF4444", values: chartPoints.map((entry) => entry.rejected) },
          ],
        }),
      },
      {
        name: "xl/charts/chart2.xml",
        data: buildXlsxLineChartXml({
          sheetName: "SmartDuck Report",
          categoryRange: `$N$2:$N$${endRow}`,
          valueRange: `$Q$2:$Q$${endRow}`,
          seriesName: "Harvest Rate (%)",
          color: "8B5CF6",
          axisSeed: 550001,
          categories: chartPoints.map((entry) => entry.label),
          values: chartPoints.map((entry) => entry.harvestRate),
        }),
      },
    );
    contentTypeOverrides = '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/charts/chart2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>';
  }
  const workbookExtras = `<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">'SmartDuck Report'!$A$1:$L$${footerRow}</definedName></definedNames>`;
  return createReportXlsxArchive(dataset, worksheetXml, getReportExcelStylesXml(), { additionalFiles, contentTypeOverrides, workbookExtras });
}

function buildReportExcelWorkbook(dataset, kind) {
  dataset = normalizeReportDatasetForExport(dataset, kind, dataset?.reportId || "");
  if (kind === "batch") return buildBatchReportExcelWorkbook(dataset);
  if (kind === "alert") return buildAlertReportExcelWorkbook(dataset);
  if (kind === "production") return buildProductionReportExcelWorkbook(dataset);
  const headers = dataset.headers.map(normalizeReportExportValue);
  const rows = dataset.rows.map((row) => row.map(normalizeReportExportValue));
  const generatedAt = dataset.generatedOn ? formatReportTableDate(dataset.generatedOn) : new Date().toLocaleString("en-US");
  const reportType = getReportTypeLabel(kind);
  const metaRows = [
    ["Report ID", dataset.reportId || "SmartDuck"],
    ["Batch ID", dataset.batchId || "System"],
    ["Report Type", reportType],
    ["Generated", generatedAt],
    ["Generated By", dataset.generatedBy || getAuthenticatedUser()],
    ["Total Records", String(rows.length)],
  ];
  // The batch summary repeats fields the meta block already states (Batch ID
  // most of all), which listed them twice in the sheet.
  const metaLabels = new Set(metaRows.map(([label]) => label.toLowerCase()));
  const summaryRows = normalizeReportList(dataset.summary)
    .map((item) => [normalizeReportExportValue(item?.label), normalizeReportExportValue(item?.value)])
    .filter(([label]) => label && !metaLabels.has(label.toLowerCase()))
    .map((values) => ({ values, style: 3, height: 22 }));
  const monitoring = normalizeReportMonitoring(dataset.monitoring);
  const monitoringRows = kind === "batch" ? [
    { values: [], height: 8 },
    { values: ["Monitoring Overview"], style: 2, height: 26, spans: true },
    {
      values: [
        "Temperature Average", monitoring.temperature.average === null ? "No readings" : `${monitoring.temperature.average} C`,
        "Temperature Min / Max", monitoring.temperature.minimum === null ? "--" : `${monitoring.temperature.minimum} / ${monitoring.temperature.maximum} C`,
        "Target", "37.3 - 37.7 C",
      ],
      style: 3,
      height: 24,
    },
    {
      values: [
        "Humidity Average", monitoring.humidity.average === null ? "No readings" : `${monitoring.humidity.average}%`,
        "Humidity Min / Max", monitoring.humidity.minimum === null ? "--" : `${monitoring.humidity.minimum} / ${monitoring.humidity.maximum}%`,
        "Sensor Readings", String(monitoring.readingCount),
      ],
      style: 3,
      height: 24,
    },
    // A daily breakdown when there is one. A roll-up has real readings but no
    // per-day points, so it gets neither the table nor the "nothing recorded"
    // line -- claiming nothing was recorded under its own averages is wrong.
    ...(monitoring.points.length ? [
      { values: ["Reading Day", "Date", "Temperature Average (C)", "Humidity Average (%)", "Samples"], style: 2, height: 24 },
      ...monitoring.points.map((point) => ({
        values: [point.label, point.date, String(point.temperatureC), String(point.humidityPercent), String(point.readingCount)],
        style: 0,
        height: 22,
      })),
    ] : (monitoring.readingCount > 0 || monitoring.temperature.average !== null
      ? []
      : [{ values: ["No sensor readings recorded for this batch."], style: 5, height: 24, spans: true }])),
    { values: [], height: 8 },
    { values: ["System Status"], style: 2, height: 26, spans: true },
    {
      values: [
        "ESP32 Device", monitoring.deviceOnline ? "Online" : "Offline",
        "Last Seen", monitoring.deviceLastSeenAt ? formatReportCellValue(monitoring.deviceLastSeenAt) : "No heartbeat recorded",
      ],
      style: 3,
      height: 24,
    },
    ...(monitoring.components.length
      ? monitoring.components.map((component) => ({ values: [component.name, component.status], style: 0, height: 22 }))
      : [{ values: ["No component status recorded."], style: 5, height: 24, spans: true }]),
  ] : [];
  const preambleRows = [
    { values: [dataset.title], style: 1, height: 30, spans: true },
    { values: [dataset.subtitle], style: 5, height: 32, spans: true },
    { values: [], height: 8 },
    ...metaRows.map((values) => ({ values, style: 3, height: 22 })),
    ...summaryRows,
    ...monitoringRows,
    { values: [], height: 8 },
  ];
  const headerRowNumber = preambleRows.length + 1;
  const sheetRows = [
    ...preambleRows,
    { values: headers, style: 2, height: 28 },
    ...rows.map((row) => ({ values: row, style: 0, height: 24 })),
    { values: [], height: 8 },
    { values: ["Generated by SmartDuck Reports"], style: 5, height: 22, spans: true },
  ];
  const maxColumns = Math.max(1, headers.length, ...sheetRows.map((row) => row.values.length));
  const lastColumn = getXlsxColumnName(maxColumns - 1);
  const lastDataRowNumber = headerRowNumber + Math.max(0, rows.length);
  const footerRowNumber = sheetRows.length;
  // Rows flagged `spans` are merged across the sheet, so their text must not
  // drag a single column wide.
  const measuredRows = sheetRows.filter((row) => !row.spans);
  const columnXml = Array.from({ length: maxColumns }, (_, index) => {
    const width = getReportExcelColumnWidth(measuredRows.map((row) => row.values[index]));
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  const rowXml = sheetRows.map((row, index) => createXlsxRow(row.values, index + 1, row.style || 0, row.height || 22)).join("");
  const mergedRows = maxColumns > 1
    ? sheetRows.map((row, index) => row.spans ? `A${index + 1}:${lastColumn}${index + 1}` : "").filter(Boolean)
    : [];
  const mergeXml = mergedRows.length
    ? `<mergeCells count="${mergedRows.length}">${mergedRows.map((reference) => `<mergeCell ref="${reference}"/>`).join("")}</mergeCells>`
    : "";
  const autoFilterXml = rows.length ? `<autoFilter ref="A${headerRowNumber}:${lastColumn}${lastDataRowNumber}"/>` : "";
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastColumn}${sheetRows.length}"/>
  <!-- No frozen pane: the split can only sit below the whole preamble, which
       pinned ~15 rows and left barely any scrollable grid. -->
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="22"/>
  <cols>${columnXml}</cols>
  <sheetData>${rowXml}</sheetData>
  ${autoFilterXml}
  ${mergeXml}
  <pageMargins left="0.35" right="0.35" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
</worksheet>`;

  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    },
    {
      name: "docProps/app.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>SmartDuck</Application>
</Properties>`,
    },
    {
      name: "docProps/core.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>SmartDuck</dc:creator>
  <dc:title>${escapeXml(dataset.title)}</dc:title>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="SmartDuck Report" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="11"/><color rgb="FF17212F"/><name val="Aptos"/></font>
    <font><b/><sz val="20"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FF17212F"/><name val="Aptos"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF172636"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAF1F8"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD7DEE8"/></left><right style="thin"><color rgb="FFD7DEE8"/></right><top style="thin"><color rgb="FFD7DEE8"/></top><bottom style="thin"><color rgb="FFD7DEE8"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: worksheetXml,
    },
  ];

  return createZipArchive(files);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Mobile browsers may not start consuming a larger XLSX/PDF immediately.
  // Keep the object URL alive long enough to avoid a blank or truncated file.
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// The preview modal keeps the dataset it opened with, but the Reports page
// reloads every 15 seconds. Device presence is the one part of a report that
// describes "now", so the download takes it from the newest copy of the same
// report instead of printing whatever the ESP32 was doing when the modal opened.
function getLatestReportDevicePresence(kind, reportId) {
  if (!reportId) return null;
  const record = reportState.summaries?.find((summary) => summary.kind === kind && summary.id === reportId)
    || reportState.cache?.find((report) => report.kind === kind && report.id === reportId);
  const monitoring = record?.dataset?.monitoring;
  if (!monitoring || typeof monitoring !== "object") return null;
  const latest = normalizeReportMonitoring(monitoring);
  return {
    deviceOnline: latest.deviceOnline,
    deviceLastSeenAt: latest.deviceLastSeenAt,
    components: latest.components,
  };
}

function exportReportFile(kind, format, reportId = "", datasetOverride = null) {
  const dataset = normalizeReportDatasetForExport(
    datasetOverride?.headers?.length ? datasetOverride : getReportDataset(kind, reportId),
    kind,
    reportId,
  );
  const latestPresence = kind === "batch" ? getLatestReportDevicePresence(kind, reportId) : null;
  if (latestPresence) dataset.monitoring = { ...dataset.monitoring, ...latestPresence };
  const filename = makeReportFilename(kind, format, reportId);
  if (format === "excel") {
    const workbook = buildReportExcelWorkbook(dataset, kind);
    downloadBlob(new Blob([workbook], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
  } else {
    downloadBlob(new Blob([buildReportPdf(dataset, kind)], { type: "application/pdf" }), filename);
  }
  showToast("Report generated", `${filename} has been downloaded.`);
}

function getReportTypeLabel(kind) {
  if (kind === "production") return "Production Report";
  if (kind === "alert") return "Alert Report";
  return "Batch Report";
}

function getDefaultReportId(kind) {
  return `RPT-${Date.now()}`;
}

function getReportPreviewContext(kind, reportId = "", format = "pdf", rowData = {}, isSummary = false) {
  const typeLabel = getReportTypeLabel(kind);
  const id = reportId || rowData.id || getDefaultReportId(kind);
  const dateRange = rowData.dateRange || "Not set";
  const generatedOn = rowData.generatedOn || new Date().toLocaleString("en-US");
  const generatedBy = rowData.generatedBy || getAuthenticatedUser();
  const extension = format === "excel" ? "xlsx" : "pdf";
  const safeId = id.replace(/[^a-z0-9._-]+/gi, "_");
  // report.dataset only carries the table itself -- the identity and provenance
  // fields live on the report record. Without merging them back in, the export
  // stamped "System" as the batch, today's clock as the generated time, and the
  // signed-in viewer as the author, even though the preview above showed the
  // real values.
  const dataset = normalizeReportDatasetForExport(
    rowData.dataset?.headers?.length
      ? {
          ...rowData.dataset,
          reportId: id,
          batchId: rowData.batchId || rowData.dataset.batchId || "",
          generatedOn: rowData.generatedOn || rowData.dataset.generatedOn || "",
          generatedBy: rowData.generatedBy || rowData.dataset.generatedBy || "",
        }
      : getReportDataset(kind, id),
    kind,
    id,
  );
  // Alert summaries are counts by alert type, so they get their own icon set
  // instead of the batch report's egg/candling sequence.
  const summaryIcons = kind === "alert"
    ? ["alert-triangle", "thermometer", "droplets", "settings", "bell", "check-circle"]
    : kind === "production"
      ? ["package-open", "egg", "check-circle", "alert-circle", "activity", "calendar"]
      : ["package-open", "activity", "egg", "egg", "minus-circle", "calendar", "rotate-cw", "search", "thermometer", "droplets"];
  // A roll-up counts across every batch on record, so calling each figure a
  // "Live batch record" would be wrong there.
  const statMeta = isSummary ? "Across all records" : "Live batch record";
  const stats = normalizeReportList(dataset.summary).slice(0, 12).map((item, index) => [
    summaryIcons[index % summaryIcons.length],
    String(item?.label || "Metric"),
    String(item?.value ?? "-"),
    statMeta,
  ]);
  // The roll-up's milestone rows lead with the batch id, so the preview reads
  // "BATCH-2026-03 - Day 7" instead of dropping which run each row came from.
  const timeline = normalizeReportList(dataset.timeline).map((row) => {
    const values = normalizeReportList(row).map((value) => String(value ?? ""));
    if (isSummary && kind === "batch") {
      return [values[1] || "-", `${values[0] || ""} ${values[2] || ""}`.trim(), `${values[3] || "Event"} - ${values[4] || ""}`];
    }
    return [values[0] || "-", values[1] || "", `${values[2] || "Event"} - ${values[3] || ""}`];
  });
  const sources = normalizeReportList(dataset.sources).length
    ? normalizeReportList(dataset.sources).map((source) => String(source))
    : ["SmartDuck database records"];
  const commonInfo = [
    ["file-text", "Report Type", isSummary ? `${typeLabel}s - All Records` : typeLabel],
    ["file-text", "Report ID", id],
    ["calendar", "Date Range", dateRange],
    ["clock-3", isSummary ? "Last Updated" : "Generated On", generatedOn],
  ];
  if (!isSummary) {
    commonInfo.push(["user", "Generated By", generatedBy]);
  }
  if (!isSummary && (rowData.batchId || dataset.batchId)) {
    commonInfo.splice(2, 0, ["package-open", "Batch ID", rowData.batchId || dataset.batchId]);
  }
  const formatLabel = format === "excel" ? "Excel" : "PDF";
  const rowCount = normalizeReportList(dataset.rows).length;

  if (kind === "production") {
    return {
      title: isSummary ? "All Production Records" : "Production Report",
      lead: isSummary
        ? "Here is every batch that has been produced so far. Check it over, then download the whole set."
        : `Check the details below, then download this report as ${formatLabel}.`,
      primaryAction: "Download Report",
      fileName: `Production_Report_${safeId}.${extension}`,
      note: isSummary
        ? `Covers all ${rowCount} ${rowCount === 1 ? "batch" : "batches"} on record - eggs set, harvested, rejected, and the harvest rate for each.`
        : `The ${formatLabel} file carries the production figures for this period.`,
      accent: "purple",
      includeTitle: "What is in the file",
      info: commonInfo,
      stats,
      includes: sources,
      dataset,
    };
  }

  if (kind === "alert") {
    return {
      title: isSummary ? "All Alert Records" : "Alert Report",
      lead: isSummary
        ? "Every alert the incubator has raised, across all batches. Give it a look before downloading."
        : `Check the details below, then download this report as ${formatLabel}.`,
      primaryAction: "Download Report",
      fileName: `Alert_Report_${safeId}.${extension}`,
      note: isSummary
        ? `Covers all ${rowCount} ${rowCount === 1 ? "alert" : "alerts"} on record, with the reading that tripped each one and how it was resolved.`
        : `The ${formatLabel} file carries every alert recorded for this batch.`,
      accent: "amber",
      includeTitle: "What is in the file",
      info: commonInfo,
      stats,
      includes: sources,
      dataset,
    };
  }

  return {
    title: isSummary ? "All Batch Records" : "Batch Report",
    lead: isSummary
      ? "Every incubation batch on record, with its counts and milestones. Review it, then download the lot."
      : `Check the summary below, then download this report as ${formatLabel}.`,
    primaryAction: "Download Report",
    fileName: `Batch_Report_${safeId}.${extension}`,
    note: isSummary
      ? `Covers all ${rowCount} ${rowCount === 1 ? "batch" : "batches"} on record, plus the milestone log for each run.`
      : `The ${formatLabel} file carries the full milestone log for this batch.`,
    accent: "blue",
    includeTitle: "What is in the file",
    info: commonInfo,
    stats,
    includes: sources,
    timeline,
    dataset,
  };
}

function renderReportPreviewInfo(items) {
  return items.map(([icon, label, value]) => `
    <div class="report-preview-info__item">
      <span class="report-preview-info__icon" data-icon="${icon}"></span>
      <span class="report-preview-info__label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

/* The heading used to be picked by counting stats, which labelled a six-metric
   alert roll-up "Production Summary". It follows the report kind now. */
function renderReportPreviewStats(items, kind = "batch", isSummary = false) {
  if (!items.length) return "";
  const kindLabel = kind === "alert" ? "Alert" : kind === "production" ? "Production" : "Batch";
  return `
    <section class="report-preview-section">
      <h4>${isSummary ? `Totals Across All ${kindLabel} Records` : `${kindLabel} Summary`}</h4>
      <div class="report-preview-stats">
        ${items.map(([icon, label, value, meta]) => `
          <div class="report-preview-stat">
            <span class="report-preview-stat__icon" data-icon="${icon}"></span>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(meta)}</small>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderReportPreviewIncludes(items, title = "Report Includes") {
  return `
    <section class="report-preview-section">
      <h4>${escapeHtml(title)}</h4>
      <div class="report-preview-includes">
        ${items.map((item) => `<span><span data-icon="check-circle"></span>${escapeHtml(item)}</span>`).join("")}
      </div>
    </section>
  `;
}

function renderReportPreviewTimeline(items = [], isSummary = false) {
  if (!items.length) return "";
  return `
    <section class="report-preview-section">
      <h4>${isSummary ? "Milestones Across All Batches" : "Incubation Timeline"}</h4>
      <div class="report-preview-timeline">
        ${items.map(([date, day, label]) => `
          <div class="report-preview-timeline__item">
            <span></span>
            <strong>${escapeHtml(date)}</strong>
            <small>${escapeHtml(day)}</small>
            <small>${escapeHtml(label)}</small>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function closeReportModal() {
  const modal = document.getElementById("report-detail-modal");
  if (!modal) return;
  closeReportPreviewFormatMenu();
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  syncModalOpenState();
}

function ensureReportModal() {
  let modal = document.getElementById("report-detail-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "report-detail-modal";
  modal.className = "report-detail-modal";
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `<button class="report-detail-modal__backdrop" type="button" tabindex="-1" aria-label="Close report"></button><section class="report-detail-modal__card" role="dialog" aria-modal="true" aria-labelledby="report-detail-title"></section>`;
  document.body.appendChild(modal);
  modal.querySelector(".report-detail-modal__backdrop")?.addEventListener("click", closeReportModal);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeReportModal();
  });
  return modal;
}

function closeReportPreviewFormatMenu(card) {
  document.querySelectorAll(".report-preview-format-menu").forEach((menu) => menu.remove());
  const scope = card || document;
  scope.querySelectorAll("[data-report-preview-format-trigger]").forEach((trigger) => {
    trigger.setAttribute("aria-expanded", "false");
  });
}

function positionReportPreviewFormatMenu(trigger, menu) {
  const rect = trigger.getBoundingClientRect();
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  const gap = 8;
  const margin = 12;
  const left = Math.min(window.innerWidth - menuWidth - margin, Math.max(margin, rect.right - menuWidth));
  const preferredTop = rect.bottom + gap;
  const fallbackTop = rect.top - menuHeight - gap;
  const top = preferredTop + menuHeight <= window.innerHeight - margin ? preferredTop : Math.max(margin, fallbackTop);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openReportModal(kind = "batch", reportId = "", options = {}) {
  const format = options.format === "excel" ? "excel" : "pdf";
  const isSummary = options.summary === true;
  const context = getReportPreviewContext(kind, reportId, format, options.rowData || {}, isSummary);
  const modal = ensureReportModal();
  const card = modal.querySelector(".report-detail-modal__card");
  if (!card) return;
  const iconName = kind === "alert" ? "alert-triangle" : kind === "production" ? "egg" : "file-text";
  card.innerHTML = `
    <div class="report-detail-modal__header">
      <div class="report-detail-modal__title-wrap">
        <span class="report-detail-modal__icon report-detail-modal__icon--${context.accent}" data-icon="${iconName}"></span>
        <div><h3 id="report-detail-title">${escapeHtml(context.title)}</h3><p>${escapeHtml(context.lead)}</p></div>
      </div>
      <button type="button" class="report-detail-modal__close" aria-label="Close report">&times;</button>
    </div>
    <div class="report-preview-body">
      <section class="report-preview-section">
        <h4>Report Details</h4>
        <div class="report-preview-info">${renderReportPreviewInfo(context.info)}</div>
      </section>
      ${renderReportPreviewStats(context.stats, kind, isSummary)}
      ${renderReportPreviewTimeline(context.timeline, isSummary)}
      ${renderReportPreviewIncludes(context.includes, context.includeTitle)}
      <section class="report-preview-section">
        <h4>Saves As</h4>
        <div class="report-preview-file">
          <span>${escapeHtml(context.fileName)}</span>
          <span data-icon="${format === "excel" ? "file-text" : "file-text"}"></span>
        </div>
      </section>
      <p class="report-preview-note"><span data-icon="info"></span><span>${escapeHtml(context.note)}</span></p>
    </div>
    <div class="report-detail-modal__footer report-preview-footer">
      <button type="button" class="report-detail-modal__secondary">Cancel</button>
      <div class="report-preview-actions">
        <button type="button" class="report-detail-modal__export" data-report-preview-download data-report-export="${format}" data-report-kind="${kind}">
          <span data-icon="${format === "excel" ? "file-text" : "download"}"></span>
          <span>${escapeHtml(context.primaryAction)}</span>
        </button>
        <button type="button" class="report-preview-actions__chevron" data-report-preview-format-trigger aria-label="Choose report format" aria-expanded="false">
          <span data-icon="chevron-down"></span>
        </button>
      </div>
    </div>
  `;
  hydrateIcons(card);
  card.querySelector(".report-detail-modal__close")?.addEventListener("click", closeReportModal);
  card.querySelector(".report-detail-modal__secondary")?.addEventListener("click", closeReportModal);
  card.querySelector("[data-report-preview-download]")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    exportReportFile(button.dataset.reportKind || kind, button.dataset.reportExport || format, reportId || getDefaultReportId(kind), context.dataset);
    closeReportModal();
  });
  card.querySelector("[data-report-preview-format-trigger]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const trigger = event.currentTarget;
    const hadMenu = Boolean(document.querySelector(".report-preview-format-menu"));
    closeReportPreviewFormatMenu(card);
    if (hadMenu) return;
    const menu = document.createElement("div");
    menu.className = "report-preview-format-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML = `
      <button type="button" data-report-preview-format="pdf" role="menuitem"><span class="report-preview-format-menu__icon report-preview-format-menu__icon--pdf" data-icon="file-text"></span><span>PDF (.pdf)</span><small>For printing or passing along</small></button>
      <button type="button" data-report-preview-format="excel" role="menuitem"><span class="report-preview-format-menu__icon report-preview-format-menu__icon--excel" data-icon="file-text"></span><span>Excel (.xlsx)</span><small>For working with the numbers</small></button>
    `;
    trigger.setAttribute("aria-expanded", "true");
    document.body.appendChild(menu);
    hydrateIcons(menu);
    positionReportPreviewFormatMenu(trigger, menu);
    menu.addEventListener("click", (menuEvent) => menuEvent.stopPropagation());
    menu.querySelectorAll("[data-report-preview-format]").forEach((option) => {
      option.addEventListener("click", () => {
        const selectedFormat = option.dataset.reportPreviewFormat || "pdf";
        closeReportPreviewFormatMenu(card);
        exportReportFile(kind, selectedFormat, reportId || getDefaultReportId(kind), context.dataset);
        closeReportModal();
      });
    });
    window.setTimeout(() => {
      document.addEventListener("click", () => closeReportPreviewFormatMenu(card), { once: true });
    }, 0);
  });
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  syncModalOpenState();
}

async function refreshReportsPage() {
  if (!isReportsScreen() || !app.pageRoot) return;
  if (reportState.refreshRequest) return reportState.refreshRequest;
  reportState.refreshRequest = loadReportsFromBackend(true).then(() => {
    if (!isReportsScreen()) return;
    renderReportRowsFromRecords(reportState.events || []);
    bindReportControls();
  }).catch(() => {
    if (!isReportsScreen()) return;
    const footnote = app.pageRoot?.querySelector(".reports-table-card__footnote");
    if (footnote) footnote.textContent = reportState.events
      ? "Could not refresh. Showing the last entries loaded."
      : "Could not load the report entries. Trying again shortly.";
  }).finally(() => { reportState.refreshRequest = null; });
  return reportState.refreshRequest;
}

function setupReportsPage() {
  if (!isReportsScreen() || !app.pageRoot) {
    clearInterval(reportState.refreshTimer);
    reportState.refreshTimer = null;
    return;
  }
  if (document.body.classList.contains("user-reports-page")) {
    const userName = getAuthenticatedUser();
    const userRole = getRoleLabel();
    const textMap = [
      ["reports-user-name", userName],
      ["reports-user-role", userRole],
      ["reports-user-avatar", initials(userName)],
    ];
    textMap.forEach(([id, value]) => {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    });
  }
  void refreshReportsPage();
  // Alerts, telemetry, and other operators' batches can change without changing
  // this viewer's batch fingerprint. Refresh both roles on the same schedule.
  if (!reportState.refreshTimer) {
    reportState.refreshTimer = window.setInterval(() => {
      if (!document.hidden) void refreshReportsPage();
    }, 60000);
  }
  bindReportControls();
}

function bindReportControls() {
  if (!isReportsScreen() || !app.pageRoot) return;
  app.pageRoot.querySelectorAll("[data-report-view]").forEach((button) => {
    if (button.dataset.reportBound === "true") return;
    button.dataset.reportBound = "true";
    button.dataset.uiBound = "true";
    button.addEventListener("click", () => {
      const kind = button.dataset.reportView || "batch";
      // A card opens the roll-up for its whole category, never one batch. The
      // summary is built server-side over every record, so it is available
      // even before anything has been recorded -- it just reports zero.
      const summary = getReportSummary(kind);
      if (!summary) {
        showToast("Still loading", "The report summary has not finished loading yet. Try again in a moment.");
        return;
      }
      openReportModal(kind, summary.id, { rowData: summary, summary: true });
    });
  });
}

function renderCurrentPage() {
  hydrateIcons(app.pageRoot || document);
  hydrateDashboardOverview();
  hydrateAdminDashboardOverview();
  void hydrateAdminOperationalOverview();
  hydrateMonitoringOverview();
  syncAdminMonitoringLiveUpdates();
  syncSharedSensorReadings();
  hydrateBatchOverview();
  hydrateScheduleOverview();
  hydrateNotificationsOverview();
  if (["dashboard", "history"].includes(state.currentPage)) {
    prefetchUnifiedHistoryData();
  }
  syncNotificationUpdates();
  startLiveBatchSync();
  void hydrateHistoryOverview();
  hydrateProfileOverview();
  hydrateTopProfilePanel();
  bindUiActions();
  setupReportsPage();
  initializeSettingsPage();
  bindImplicitActionButtons();
  bindHeaderShortcuts();
  bindChartRangeControls();
  renderChartsForPage();
  if (app.mobilePageLabel) {
    app.mobilePageLabel.textContent = pageLabel(state.currentPage);
  }
}

function openSidebar() {
  state.sidebarOpen = true;
  app.sidebar?.classList.add("is-open");
  app.sidebarBackdrop?.classList.add("is-open");
  app.menuButton?.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  state.sidebarOpen = false;
  app.sidebar?.classList.remove("is-open");
  app.sidebarBackdrop?.classList.remove("is-open");
  app.menuButton?.setAttribute("aria-expanded", "false");
}

function updateActionLabels(row, previousLabel, nextLabel) {
  const firstCell = row?.cells?.[0];
  if (firstCell) {
    const strong = firstCell.querySelector(".table-strong");
    if (strong && strong.textContent.trim() === previousLabel) {
      strong.textContent = nextLabel;
    } else if (firstCell.textContent.trim() === previousLabel) {
      firstCell.textContent = nextLabel;
    }
  }

  const secondCell = row?.cells?.[1];
  if (secondCell && secondCell.textContent.trim() === previousLabel) {
    secondCell.textContent = nextLabel;
  }

  row?.querySelectorAll("[data-ui-action]").forEach((button) => {
    const currentAction = button.dataset.uiAction || "";
    const nextAction = currentAction.replace(previousLabel, nextLabel);
    if (button.dataset.uiAction !== undefined) button.dataset.uiAction = nextAction;
    button.setAttribute("title", nextAction);
    button.setAttribute("aria-label", nextAction);
  });
}

function updateSelectionGroupState(button, label) {
  const selectionGroup = button.closest(
    ".settings-tabs, .notifications-filter-chips, .reports-pagination, .history-pagination, .analytics-toolbar, .monitoring-toolbar"
  );
  if (!selectionGroup) return;
  const lower = label.toLowerCase();
  if (lower.includes("previous") || lower.includes("next")) return;
  selectionGroup.querySelectorAll(".is-active").forEach((item) => item.classList.remove("is-active"));
  button.classList.add("is-active");
}

async function handleUiAction(button) {
  const actionLabel = button.dataset.uiAction || "";
  if (!actionLabel) return;
  const [verb, ...rest] = actionLabel.split(" ");
  const targetLabel = rest.join(" ").trim() || "item";
  const row = button.closest("tr");

  if (actionLabel === "Create new batch") {
    openBatchEntryModal();
    return;
  }

  if (actionLabel === "Open batch management" || actionLabel === "Go to Batch Management") {
    redirectToPage("batch");
    return;
  }

  if (actionLabel === "Open history" || actionLabel === "View history") {
    redirectToPage("history");
    return;
  }

  if (actionLabel === "Open schedules" || actionLabel === "View schedule") {
    redirectToPage("candling");
    return;
  }

  if (actionLabel === "Delete all history") {
    await deleteAllHistoryRecords(button);
    return;
  }

  if (actionLabel === "Go back") {
    if (window.history.length > 1) {
      window.history.back();
    } else if (isPageAllowed("dashboard", getAuthenticatedRole())) {
      redirectToPage("dashboard");
    }
    return;
  }

  if (actionLabel.toLowerCase().startsWith("view details for ")) {
    openHistoryDetailsForRow(row);
    return;
  }

  if (actionLabel === "View full schedule") {
    openScheduleFullModal();
    return;
  }

  if (actionLabel === "Open notifications" || actionLabel === "Open alerts") {
    await openNotificationModal(button);
    return;
  }

  if (handleNotificationsAction(button, actionLabel)) return;

  updateSelectionGroupState(button, actionLabel);

  if (verb === "Delete") {
    const result = await openActionDialog({
      title: "Delete record",
      body: `Delete ${targetLabel} from the current view?`,
      confirmLabel: "Delete",
      cancelLabel: "Keep",
    });
    if (!result.confirmed) return;
    row?.remove();
    showToast("Deleted", `${targetLabel} has been removed from this view.`);
    return;
  }

  if (verb === "Edit") {
    const result = await openActionDialog({
      title: "Update record",
      body: `Change the label for ${targetLabel}.`,
      confirmLabel: "Save",
      cancelLabel: "Cancel",
      mode: "prompt",
      initialValue: targetLabel,
      placeholder: "Enter a new label",
    });
    if (!result.confirmed) return;
    const normalized = result.value.trim();
    if (!normalized) {
      await showWarningCard("Label required", "Enter a name before saving the updated record.");
      return;
    }
    updateActionLabels(row, targetLabel, normalized);
    showToast("Updated", `${targetLabel} is now ${normalized}.`);
    return;
  }

  return;
}

function bindUiActions() {
  if (!app.pageRoot) return;
  app.pageRoot.querySelectorAll("[data-ui-action]").forEach((button) => {
    if (button.dataset.uiBound === "true") return;
    button.dataset.uiBound = "true";
    button.addEventListener("click", async () => {
      await handleUiAction(button);
    });
  });
}

function bindImplicitActionButtons() {
  if (!app.pageRoot) return;
  app.pageRoot.querySelectorAll('button:not([data-ui-action]), [role="button"]:not([data-ui-action])').forEach((button) => {
    if (button.dataset.uiBound === "true") return;
    if (button.id === "mobile-menu-button" || button.id === "sidebar-backdrop") return;
    if (button.closest(".action-dialog__card")) return;
    if (button.closest(".chart-range-menu")) return;
    if (button.hasAttribute("disabled")) return;

    const label =
      button.getAttribute("aria-label") ||
      button.textContent.replace(/\s+/g, " ").trim() ||
      "Action";

    button.dataset.uiBound = "true";
    button.addEventListener("click", () => {
      updateSelectionGroupState(button, label);

      const lower = label.toLowerCase();
      if (lower.includes("refresh")) {
        showToast("Data refreshed", "The latest incubator data is now displayed.");
        return;
      }
      if (lower.includes("logout")) {
        showToast("Signing out", "Ending the current session.");
        return;
      }
      return;
    });
  });
}

function bindHeaderShortcuts() {
  if (!app.pageRoot) return;
  const profileShortcut = getProfileTrigger();
  if (!profileShortcut || profileShortcut.dataset.profileShortcutBound === "true") return;

  profileShortcut.dataset.profileShortcutBound = "true";
  profileShortcut.setAttribute("role", "button");
  profileShortcut.setAttribute("tabindex", "0");
  profileShortcut.setAttribute("aria-label", "Open profile card");
  profileShortcut.setAttribute("aria-haspopup", "dialog");

  const openProfile = () => {
    toggleProfileQuickCard();
  };

  profileShortcut.addEventListener("click", openProfile);
  profileShortcut.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openProfile();
  });
}

function markNavigationIntent(button) {
  const pageId = button?.dataset?.page || "";
  if (!pageId || pageId === state.currentPage) return;

  const navigation = button.closest("nav");
  navigation?.querySelectorAll("[data-page]").forEach((item) => {
    item.classList.toggle("is-active", item === button);
    item.classList.toggle("is-navigation-pending", item === button);
    if (item === button) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  });
}

function getImmediateFeedbackTarget(target) {
  if (!(target instanceof Element)) return null;
  const element = target.closest("button, a[href], [role='button']");
  if (!element) return null;
  if (element.matches("[disabled], [aria-disabled='true'], [class*='backdrop']")) return null;
  return element;
}

function clearPressedInteractiveElement() {
  if (!pressedInteractiveElement) return;
  pressedInteractiveElement.classList.remove("is-pressing");
  pressedInteractiveElement = null;
}

function setPressedInteractiveElement(element) {
  if (pressedInteractiveElement === element) return;
  clearPressedInteractiveElement();
  pressedInteractiveElement = element;
  element.classList.add("is-pressing");
}

function bindImmediateInteractionFeedback() {
  if (immediateInteractionFeedbackBound) return;
  immediateInteractionFeedbackBound = true;

  document.addEventListener("pointerdown", (event) => {
    const target = getImmediateFeedbackTarget(event.target);
    if (!target) return;
    setPressedInteractiveElement(target);
  }, { passive: true });

  document.addEventListener("pointerup", clearPressedInteractiveElement, { passive: true });
  document.addEventListener("pointercancel", clearPressedInteractiveElement, { passive: true });
  document.addEventListener("dragstart", clearPressedInteractiveElement, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearPressedInteractiveElement();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = getImmediateFeedbackTarget(event.target);
    if (!target) return;
    setPressedInteractiveElement(target);
  });

  document.addEventListener("keyup", clearPressedInteractiveElement);
  document.addEventListener("blur", clearPressedInteractiveElement, true);
}

function showToast(title, body) {
  if (!app.toastRegion) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<p class="toast__title">${title}</p><p class="toast__body">${body}</p>`;
  app.toastRegion.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add("toast--out");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  }, 2200);
}

function clearTooltip() {
  if (!app.tooltip) return;
  app.tooltip.hidden = true;
  app.tooltip.innerHTML = "";
}

function showTooltip(event, title, rows) {
  if (!app.tooltip) return;
  app.tooltip.innerHTML = `
    <div class="chart-tooltip__title">${title}</div>
    ${rows
      .map(
        (row) => `
          <div class="chart-tooltip__row">
            <span class="chart-tooltip__swatch" style="background:${row.color};"></span>
            <span>${row.label}</span>
            <span class="chart-tooltip__value">${row.value}</span>
          </div>
        `,
      )
      .join("")}
  `;
  app.tooltip.hidden = false;
  positionTooltip(event);
}

function positionTooltip(event) {
  if (!app.tooltip) return;
  const offset = 16;
  const maxX = window.innerWidth - app.tooltip.offsetWidth - 8;
  const maxY = window.innerHeight - app.tooltip.offsetHeight - 8;
  const left = Math.min(event.clientX + offset, Math.max(8, maxX));
  const top = Math.min(event.clientY + offset, Math.max(8, maxY));
  app.tooltip.style.left = `${left}px`;
  app.tooltip.style.top = `${top}px`;
}

function svgEl(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([key, value]) => {
    node.setAttribute(key, String(value));
  });
  return node;
}

function svgText(parent, attrs, text) {
  const node = svgEl("text", attrs);
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function createSvg(width, height) {
  return svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "chart-svg",
    role: "img",
    "aria-hidden": "true",
  });
}

function getChartMotionDelay(index, step = 42, max = 520) {
  return Math.min(Math.max(0, index) * step, max);
}

function prepareChartMotion(node, classNames, delay = 0) {
  classNames.split(" ").filter(Boolean).forEach((className) => node.classList.add(className));
  node.style.setProperty("--chart-delay", `${Math.round(delay)}ms`);
  return node;
}

function prepareChartPathMotion(path, classNames, delay = 0) {
  prepareChartMotion(path, classNames, delay);
  try {
    const pathLength = Math.max(1, path.getTotalLength());
    path.style.setProperty("--chart-path-length", `${Math.ceil(pathLength)}`);
  } catch {
    path.style.setProperty("--chart-path-length", "1");
  }
  return path;
}

function prepareChartSliceMotion(node, centerX, centerY, delay = 0) {
  prepareChartMotion(node, "chart-pie-slice", delay);
  node.style.setProperty("--chart-center-x", `${centerX}px`);
  node.style.setProperty("--chart-center-y", `${centerY}px`);
  return node;
}

function niceStep(rawStep) {
  const safe = rawStep || 1;
  const power = 10 ** Math.floor(Math.log10(safe));
  const normalized = safe / power;
  if (normalized <= 1) return power;
  if (normalized <= 2) return 2 * power;
  if (normalized <= 5) return 5 * power;
  return 10 * power;
}

function buildTicks(domain, count = 5) {
  const [min, max] = domain;
  if (min === max) return [min];
  const step = niceStep((max - min) / Math.max(1, count - 1));
  const start = Math.ceil(min / step) * step;
  const ticks = [Number(min.toFixed(6))];
  for (let value = start; value < max; value += step) {
    const rounded = Number(value.toFixed(6));
    if (rounded > min && rounded < max) {
      ticks.push(rounded);
    }
  }
  ticks.push(Number(max.toFixed(6)));
  return [...new Set(ticks)].sort((left, right) => left - right);
}

function inferDomain(values, startAtZero = true, paddingRatio = 0.12) {
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const lower = startAtZero ? Math.min(0, minValue) : minValue;
  const span = maxValue - lower || 1;
  return [lower, maxValue + span * paddingRatio];
}

function formatTick(value) {
  if (Math.abs(value) >= 10 || Number.isInteger(value)) return String(Math.round(value));
  return value.toFixed(1);
}

function colorWithAlpha(hex, alpha) {
  const sanitized = hex.replace("#", "");
  const full = sanitized.length === 3
    ? sanitized.split("").map((char) => char + char).join("")
    : sanitized;
  const number = Number.parseInt(full, 16);
  const r = (number >> 16) & 255;
  const g = (number >> 8) & 255;
  const b = number & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Monotone cubic interpolation (Fritsch-Carlson tangents). The previous
// Catmull-Rom spline derived each control point from the span between a point's
// two neighbours, so an unevenly sampled series -- one stale reading days back
// followed by a tight burst of live ones -- threw the handles past the next
// point. The curve then doubled back on itself and drew a loop, and overshot
// well outside the recorded values. Monotone tangents keep every segment
// travelling forwards and inside the data.
function buildSmoothPath(points) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  const deltaX = [];
  const slopes = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const run = points[index + 1].x - points[index].x;
    deltaX[index] = run;
    slopes[index] = run === 0 ? 0 : (points[index + 1].y - points[index].y) / run;
  }

  const tangents = new Array(points.length);
  tangents[0] = slopes[0];
  tangents[points.length - 1] = slopes[points.length - 2];
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = slopes[index - 1];
    const after = slopes[index];
    if (before * after <= 0) {
      // A turning point (or a flat/duplicate sample): level the tangent so the
      // curve cannot bulge past the reading.
      tangents[index] = 0;
      continue;
    }
    const weightBefore = 2 * deltaX[index] + deltaX[index - 1];
    const weightAfter = deltaX[index] + 2 * deltaX[index - 1];
    tangents[index] = (weightBefore + weightAfter) / (weightBefore / before + weightAfter / after);
  }

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const handle = deltaX[index] / 3;
    path += ` C ${start.x + handle} ${start.y + tangents[index] * handle},`
      + ` ${end.x - handle} ${end.y - tangents[index + 1] * handle},`
      + ` ${end.x} ${end.y}`;
  }
  return path;
}

function buildLinearPath(points) {
  if (points.length === 0) return "";
  return points.reduce(
    (path, point, index) => `${path}${index === 0 ? "M" : " L"} ${point.x} ${point.y}`,
    "",
  );
}

function buildStepPath(points) {
  if (points.length === 0) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    path += ` H ${point.x} V ${point.y}`;
  }
  return path;
}

function buildAreaPath(points, baseY, stepped = false) {
  if (points.length === 0) return "";
  const last = points[points.length - 1];
  const first = points[0];
  const line = stepped ? buildStepPath(points) : buildSmoothPath(points);
  return `${line} L ${last.x} ${baseY} L ${first.x} ${baseY} Z`;
}

function addLegend(container, items) {
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML = items
    .map(
      (item) => `
        <div class="chart-legend__item">
          <span class="chart-legend__swatch" style="background:${item.color};"></span>
          <span>${item.label}</span>
        </div>
      `,
    )
    .join("");
  container.appendChild(legend);
}

function renderEmptyChart(container, message = "No recorded data yet") {
  container.innerHTML = `<div class="chart-empty-state">${escapeHtml(message)}</div>`;
}

function renderXYChart(container, config) {
  if (!Array.isArray(config.data) || config.data.length === 0) {
    renderEmptyChart(container);
    return;
  }
  const width = Math.max(container.clientWidth, 320);
  const height = config.height || Number(container.dataset.chartHeight) || 320;
  const margin = {
    top: 22,
    right: config.rightAxis ? 70 : 28,
    bottom: 54,
    left: Number(config.marginLeft) || 62,
  };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const svg = createSvg(width, height);
  const plotClipId = `chart-plot-clip-${++chartPlotClipSequence}`;
  const defs = svgEl("defs");
  const plotClip = svgEl("clipPath", { id: plotClipId });
  plotClip.appendChild(svgEl("rect", {
    x: margin.left,
    y: margin.top,
    width: innerWidth,
    height: innerHeight,
  }));
  defs.appendChild(plotClip);
  svg.appendChild(defs);
  const leftSeries = config.series.filter((series) => (series.axis || "left") === "left");
  const rightSeries = config.series.filter((series) => series.axis === "right");
  const leftValues = leftSeries.flatMap((series) => config.data.map((entry) => entry[series.key]));
  const rightValues = rightSeries.flatMap((series) => config.data.map((entry) => entry[series.key]));
  const leftDomain = typeof config.leftAxis?.domain === "function"
    ? config.leftAxis.domain(leftValues)
    : config.leftAxis?.domain || inferDomain(leftValues, false);
  const rightDomain = config.rightAxis
    ? (typeof config.rightAxis.domain === "function" ? config.rightAxis.domain(rightValues) : config.rightAxis.domain || inferDomain(rightValues, false))
    : null;
  const leftTicks = buildTicks(leftDomain);
  const rightTicks = rightDomain ? buildTicks(rightDomain) : [];

  const timeValues = config.xTimeKey
    ? config.data.map((entry) => new Date(entry[config.xTimeKey]).getTime())
    : [];
  const requestedTimeDomain = Array.isArray(config.xAxis?.timeDomain)
    ? config.xAxis.timeDomain.map(Number)
    : [];
  const hasRequestedTimeDomain = requestedTimeDomain.length === 2
    && requestedTimeDomain.every(Number.isFinite)
    && requestedTimeDomain[1] > requestedTimeDomain[0];
  const hasTimeScale = config.xAxis?.spacing !== "even"
    && timeValues.every(Number.isFinite)
    && (hasRequestedTimeDomain || (timeValues.length > 1 && Math.max(...timeValues) > Math.min(...timeValues)));
  const firstTime = hasTimeScale
    ? (hasRequestedTimeDomain ? requestedTimeDomain[0] : Math.min(...timeValues))
    : 0;
  const lastTime = hasTimeScale
    ? (hasRequestedTimeDomain ? requestedTimeDomain[1] : Math.max(...timeValues))
    : 0;
  const timeSpan = hasTimeScale ? lastTime - firstTime : 0;
  const xPositions = config.data.map((_, index) => {
    const ratio = hasTimeScale
      ? (timeValues[index] - firstTime) / timeSpan
      : (config.data.length === 1 ? 0.5 : index / (config.data.length - 1));
    return margin.left + ratio * innerWidth;
  });

  const yScale = (value, axis = "left") => {
    const [min, max] = axis === "right" ? rightDomain : leftDomain;
    const ratio = max === min ? 0 : (value - min) / (max - min);
    return margin.top + innerHeight - ratio * innerHeight;
  };

  leftTicks.forEach((tick) => {
    const y = yScale(tick, "left");
    svg.appendChild(svgEl("line", { x1: margin.left, y1: y, x2: width - margin.right, y2: y, class: "chart-grid-line" }));
    svgText(svg, { x: margin.left - 10, y: y + 4, class: "chart-tick-label", "text-anchor": "end" }, config.leftAxis?.formatTick ? config.leftAxis.formatTick(tick) : formatTick(tick));
  });

  if (config.xAxis?.showLabels !== false) {
    if (hasRequestedTimeDomain) {
      const maxTicks = Math.max(2, Math.floor(innerWidth / 82));
      const tickCount = Math.min(6, maxTicks);
      const tickEntries = Array.from({ length: tickCount }, (_, index) => ({
        recordedAt: new Date(firstTime + (timeSpan * index) / Math.max(1, tickCount - 1)).toISOString(),
      }));
      for (let index = 0; index < tickCount; index += 1) {
        const ratio = index / Math.max(1, tickCount - 1);
        const label = config.xAxis?.formatTick
          ? config.xAxis.formatTick(tickEntries[index], tickEntries, index)
          : tickEntries[index].recordedAt;
        const anchor = index === 0 ? "start" : index === tickCount - 1 ? "end" : "middle";
        svgText(svg, { x: margin.left + ratio * innerWidth, y: height - 18, class: "chart-tick-label", "text-anchor": anchor }, label);
      }
    } else {
      const xTickIndexes = new Set();
      const explicitTickEvery = Number(config.xAxis?.tickEvery || 0);
      if (explicitTickEvery > 0) {
        xPositions.forEach((_, index) => {
          if (index === 0 || index === xPositions.length - 1 || index % explicitTickEvery === 0) xTickIndexes.add(index);
        });
      } else {
        const maxTicks = Math.max(2, Math.floor(innerWidth / 82));
        const tickCount = Math.min(xPositions.length, maxTicks);
        for (let index = 0; index < tickCount; index += 1) {
          xTickIndexes.add(Math.round((index * (xPositions.length - 1)) / Math.max(1, tickCount - 1)));
        }
      }

      // Ticks are picked by index but placed by timestamp, so an uneven series
      // drops several of them onto the same few pixels and the dates print on top
      // of each other. Keep only labels that clear the previous one, and always
      // keep the newest reading's label.
      const lastIndex = xPositions.length - 1;
      const minimumLabelGap = 86;
      const shownIndexes = [];
      Array.from(xTickIndexes).sort((left, right) => left - right).forEach((index) => {
        while (shownIndexes.length
          && xPositions[index] - xPositions[shownIndexes[shownIndexes.length - 1]] < minimumLabelGap) {
          if (index !== lastIndex) return;
          shownIndexes.pop();
        }
        shownIndexes.push(index);
      });

      shownIndexes.forEach((index) => {
        const label = config.xAxis?.formatTick
          ? config.xAxis.formatTick(config.data[index], config.data, index)
          : String(config.data[index][config.xKey]);
        // Anchor the outermost labels inwards so they cannot spill past the plot.
        const anchor = index === 0 ? "start" : index === lastIndex ? "end" : "middle";
        svgText(svg, { x: xPositions[index], y: height - 18, class: "chart-tick-label", "text-anchor": anchor }, label);
      });
    }
  }

  if (config.leftAxis?.label) {
    const labelNode = svgText(svg, { x: 18, y: margin.top + innerHeight / 2, class: "chart-axis-title", "text-anchor": "middle", transform: `rotate(-90 18 ${margin.top + innerHeight / 2})` }, config.leftAxis.label);
    labelNode.setAttribute("dominant-baseline", "middle");
  }

  if (config.rightAxis?.label) {
    const x = width - 18;
    const labelNode = svgText(svg, { x, y: margin.top + innerHeight / 2, class: "chart-axis-title", "text-anchor": "middle", transform: `rotate(90 ${x} ${margin.top + innerHeight / 2})` }, config.rightAxis.label);
    labelNode.setAttribute("dominant-baseline", "middle");
    rightTicks.forEach((tick) => {
      const y = yScale(tick, "right");
      svgText(svg, { x: width - margin.right + 10, y: y + 4, class: "chart-tick-label", "text-anchor": "start" }, config.rightAxis.formatTick ? config.rightAxis.formatTick(tick) : formatTick(tick));
    });
  }

  const fillLayer = svgEl("g");
  const lineLayer = svgEl("g");
  const introPointLayer = svgEl("g");
  const livePointLayer = svgEl("g");
  [fillLayer, lineLayer, introPointLayer, livePointLayer].forEach((layer) => {
    layer.setAttribute("clip-path", `url(#${plotClipId})`);
  });
  svg.appendChild(fillLayer);
  svg.appendChild(lineLayer);
  svg.appendChild(introPointLayer);
  svg.appendChild(livePointLayer);

  config.series.forEach((series, seriesIndex) => {
    const points = config.data.map((entry, index) => ({
      x: xPositions[index],
      y: yScale(entry[series.key], series.axis || "left"),
      raw: entry[series.key],
    }));
    const stepped = series.style === "area-step" || series.style === "line-step";
    const area = series.style === "area" || series.style === "area-step";
    const linePath = stepped
      ? buildStepPath(points)
      : (series.interpolation === "linear" ? buildLinearPath(points) : buildSmoothPath(points));
    const introDotBaseDelay = 120 + seriesIndex * 120;
    const introDotStep = 52;
    const lineDelay = series.showDots === false
      ? 0
      : introDotBaseDelay + Math.min(points.length * introDotStep, 560) + 180;

    if (area) {
      fillLayer.appendChild(prepareChartMotion(
        svgEl("path", {
          d: `${linePath} L ${points[points.length - 1].x} ${margin.top + innerHeight}`
            + ` L ${points[0].x} ${margin.top + innerHeight} Z`,
          fill: colorWithAlpha(series.color, 0.18),
          stroke: "none",
        }),
        "chart-series-area",
        lineDelay + 120,
      ));
    }

    if (series.showDots !== false) {
      points.forEach((point, pointIndex) => {
        introPointLayer.appendChild(prepareChartMotion(
          svgEl("circle", { cx: point.x, cy: point.y, r: 4.8, fill: series.color, stroke: "#ffffff", "stroke-width": 2 }),
          "chart-intro-dot",
          introDotBaseDelay + pointIndex * introDotStep,
        ));
      });
    }

    lineLayer.appendChild(prepareChartPathMotion(
      svgEl("path", { d: linePath, fill: "none", stroke: series.color, "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }),
      "chart-series-line",
      lineDelay,
    ));

    if (series.showLivePulse && points.length > 1) {
      const latestPoint = points[points.length - 1];
      livePointLayer.appendChild(svgEl("circle", {
        cx: latestPoint.x,
        cy: latestPoint.y,
        r: 7,
        fill: "none",
        stroke: series.color,
        "stroke-width": 2,
        class: "chart-live-pulse",
      }));
      livePointLayer.appendChild(svgEl("circle", {
        cx: latestPoint.x,
        cy: latestPoint.y,
        r: 3.5,
        fill: series.color,
        stroke: "#ffffff",
        "stroke-width": 1.5,
        class: "chart-live-endpoint",
      }));
    }
  });

  const hoverLine = svgEl("line", { class: "chart-hover-line", x1: 0, y1: margin.top, x2: 0, y2: margin.top + innerHeight, visibility: "hidden" });
  svg.appendChild(hoverLine);
  const hoverDots = config.series.map((series) => {
    const dot = svgEl("circle", { class: "chart-hover-dot", r: 5, fill: series.color, visibility: "hidden" });
    svg.appendChild(dot);
    return dot;
  });

  config.data.forEach((entry, index) => {
    const currentX = xPositions[index];
    const previousX = index === 0 ? margin.left : (xPositions[index - 1] + currentX) / 2;
    const nextX = index === xPositions.length - 1 ? width - margin.right : (currentX + xPositions[index + 1]) / 2;
    const overlay = svgEl("rect", {
      x: previousX,
      y: margin.top,
      width: nextX - previousX,
      height: innerHeight,
      class: "chart-overlay-rect",
    });

    const rows = config.series.map((series) => ({
      label: series.label,
      color: series.color,
      value: (series.formatter || ((value) => String(value)))(entry[series.key]),
    }));

    const activate = (event) => {
      hoverLine.setAttribute("x1", String(currentX));
      hoverLine.setAttribute("x2", String(currentX));
      hoverLine.setAttribute("visibility", "visible");
      config.series.forEach((series, seriesIndex) => {
        const dot = hoverDots[seriesIndex];
        dot.setAttribute("cx", String(currentX));
        dot.setAttribute("cy", String(yScale(entry[series.key], series.axis || "left")));
        dot.setAttribute("visibility", "visible");
      });
      showTooltip(event, String(entry[config.xKey]), rows);
    };

    overlay.addEventListener("mouseenter", activate);
    overlay.addEventListener("mousemove", (event) => {
      activate(event);
      positionTooltip(event);
    });
    overlay.addEventListener("mouseleave", () => {
      hoverLine.setAttribute("visibility", "hidden");
      hoverDots.forEach((dot) => dot.setAttribute("visibility", "hidden"));
      clearTooltip();
    });
    svg.appendChild(overlay);
  });

  container.innerHTML = "";
  container.appendChild(svg);
  if (config.showLegend !== false) addLegend(container, config.series);
}

function renderBarChart(container, config) {
  if (!Array.isArray(config.data) || config.data.length === 0) {
    renderEmptyChart(container);
    return;
  }
  const width = Math.max(container.clientWidth, 320);
  const height = config.height || Number(container.dataset.chartHeight) || 320;
  const horizontal = Boolean(config.horizontal);
  const margin = horizontal
    ? { top: 18, right: 28, bottom: 48, left: 110 }
    : { top: 18, right: 28, bottom: 52, left: 56 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const svg = createSvg(width, height);
  const maxValue = config.stacked
    ? Math.max(...config.data.map((entry) => config.series.reduce((sum, series) => sum + Number(entry[series.key] || 0), 0)))
    : Math.max(...config.data.flatMap((entry) => config.series.map((series) => Number(entry[series.key] || 0))));
  const domain = config.domain || inferDomain([0, maxValue], true, 0.1);
  const ticks = buildTicks(domain);

  const scale = (value) => {
    const [min, max] = domain;
    const ratio = max === min ? 0 : (value - min) / (max - min);
    return horizontal
      ? margin.left + ratio * innerWidth
      : margin.top + innerHeight - ratio * innerHeight;
  };

  ticks.forEach((tick) => {
    if (horizontal) {
      const x = scale(tick);
      svg.appendChild(svgEl("line", { x1: x, y1: margin.top, x2: x, y2: height - margin.bottom, class: "chart-grid-line" }));
      svgText(svg, { x, y: height - 16, class: "chart-tick-label", "text-anchor": "middle" }, formatTick(tick));
    } else {
      const y = scale(tick);
      svg.appendChild(svgEl("line", { x1: margin.left, y1: y, x2: width - margin.right, y2: y, class: "chart-grid-line" }));
      svgText(svg, { x: margin.left - 10, y: y + 4, class: "chart-tick-label", "text-anchor": "end" }, formatTick(tick));
    }
  });

  if (horizontal) {
    const band = innerHeight / config.data.length;
    const barHeight = Math.min(28, band * 0.62);
    config.data.forEach((entry, index) => {
      const centerY = margin.top + band * index + band / 2;
      const top = centerY - barHeight / 2;
      const value = Number(entry[config.series[0].key] || 0);
      const x2 = scale(value);
      const rect = prepareChartMotion(
        svgEl("rect", {
          x: margin.left,
          y: top,
          width: Math.max(0, x2 - margin.left),
          height: barHeight,
          rx: 8,
          fill: config.series[0].color,
        }),
        "chart-bar-segment chart-bar-segment--horizontal",
        getChartMotionDelay(index),
      );
      rect.addEventListener("mouseenter", (event) => {
        showTooltip(event, String(entry[config.categoryKey]), [
          {
            label: config.series[0].label,
            color: config.series[0].color,
            value: config.series[0].formatter ? config.series[0].formatter(value) : String(value),
          },
        ]);
      });
      rect.addEventListener("mousemove", positionTooltip);
      rect.addEventListener("mouseleave", clearTooltip);
      svg.appendChild(rect);
      svgText(svg, { x: margin.left - 10, y: centerY + 4, class: "chart-tick-label", "text-anchor": "end" }, String(entry[config.categoryKey]));
    });
  } else {
    const band = innerWidth / config.data.length;
    const groupWidth = band * 0.72;
    const groupOffset = (band - groupWidth) / 2;
    const barGap = Number.isFinite(config.barGap) ? config.barGap : 6;
    const maxBarWidth = Number.isFinite(config.maxBarWidth) ? config.maxBarWidth : Infinity;
    const barWidth = config.stacked ? groupWidth : Math.min(maxBarWidth, Math.max(10, groupWidth / config.series.length - barGap));
    const barsWidth = config.stacked ? groupWidth : config.series.length * barWidth + (config.series.length - 1) * barGap;

    config.data.forEach((entry, index) => {
      const startX = margin.left + band * index + groupOffset;
      const barsStartX = startX + Math.max(0, (groupWidth - barsWidth) / 2);
      const tooltipRows = config.series.map((series) => ({
        label: series.label,
        color: series.color,
        value: series.formatter ? series.formatter(entry[series.key]) : String(entry[series.key]),
      }));

      if (config.stacked) {
        let stack = 0;
        config.series.forEach((series, seriesIndex) => {
          const value = Number(entry[series.key] || 0);
          const topY = scale(stack + value);
          const bottomY = scale(stack);
          const rect = prepareChartMotion(
            svgEl("rect", {
              x: startX,
              y: topY,
              width: groupWidth,
              height: Math.max(0, bottomY - topY),
              rx: 8,
              fill: series.color,
            }),
            "chart-bar-segment",
            getChartMotionDelay(index * config.series.length + seriesIndex),
          );
          rect.addEventListener("mouseenter", (event) => showTooltip(event, String(entry[config.categoryKey]), tooltipRows));
          rect.addEventListener("mousemove", positionTooltip);
          rect.addEventListener("mouseleave", clearTooltip);
          svg.appendChild(rect);
          stack += value;
        });
      } else {
        config.series.forEach((series, seriesIndex) => {
          const value = Number(entry[series.key] || 0);
          const x = barsStartX + seriesIndex * (barWidth + barGap);
          const topY = scale(value);
          const rect = prepareChartMotion(
            svgEl("rect", {
              x,
              y: topY,
              width: barWidth,
              height: Math.max(0, margin.top + innerHeight - topY),
              rx: 8,
              fill: series.color,
            }),
            "chart-bar-segment",
            getChartMotionDelay(index * config.series.length + seriesIndex),
          );
          rect.addEventListener("mouseenter", (event) => showTooltip(event, String(entry[config.categoryKey]), tooltipRows));
          rect.addEventListener("mousemove", positionTooltip);
          rect.addEventListener("mouseleave", clearTooltip);
          svg.appendChild(rect);
        });
      }

      if (config.xAxis?.showLabels !== false) {
        svgText(svg, { x: margin.left + band * index + band / 2, y: height - 18, class: "chart-tick-label", "text-anchor": "middle" }, String(entry[config.categoryKey]));
      }
    });
  }

  container.innerHTML = "";
  container.appendChild(svg);
  if (config.showLegend !== false) addLegend(container, config.series);
}

function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
  const angle = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: centerX + radius * Math.cos(angle),
    y: centerY + radius * Math.sin(angle),
  };
}

function describeArc(centerX, centerY, radius, startAngle, endAngle) {
  const start = polarToCartesian(centerX, centerY, radius, endAngle);
  const end = polarToCartesian(centerX, centerY, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${centerX} ${centerY} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y} Z`;
}

function describeDonutArc(centerX, centerY, outerRadius, innerRadius, startAngle, endAngle) {
  const outerStart = polarToCartesian(centerX, centerY, outerRadius, endAngle);
  const outerEnd = polarToCartesian(centerX, centerY, outerRadius, startAngle);
  const innerStart = polarToCartesian(centerX, centerY, innerRadius, startAngle);
  const innerEnd = polarToCartesian(centerX, centerY, innerRadius, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${outerStart.x} ${outerStart.y} A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 0 ${outerEnd.x} ${outerEnd.y} L ${innerStart.x} ${innerStart.y} A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 1 ${innerEnd.x} ${innerEnd.y} Z`;
}

function renderPieChart(container, config) {
  if (!Array.isArray(config.data) || config.data.length === 0) {
    renderEmptyChart(container);
    return;
  }
  const width = Math.max(container.clientWidth, 320);
  const height = config.height || Number(container.dataset.chartHeight) || 320;
  const svg = createSvg(width, height);
  const radius = Math.min(width, height) * (config.radiusScale || 0.28);
  const innerRadius = config.donut ? radius * (config.innerRadiusRatio || 0.58) : 0;
  const centerX = width / 2;
  const centerY = height / 2 + 10;
  const total = config.data.reduce((sum, item) => sum + item.value, 0);

  if (total <= 0) {
    renderEmptyChart(container);
    return;
  }

  let currentAngle = 0;

  config.data.forEach((item, itemIndex) => {
    if (item.value <= 0) {
      return;
    }

    const sliceAngle = (item.value / total) * 360;
    const startAngle = currentAngle;
    const endAngle = currentAngle + sliceAngle;
    const percent = (item.value / total) * 100;

    if (sliceAngle >= 359.999) {
      const fullCircle = prepareChartSliceMotion(config.donut
        ? svgEl("circle", {
            cx: centerX,
            cy: centerY,
            r: (radius + innerRadius) / 2,
            fill: "none",
            stroke: item.color,
            "stroke-width": radius - innerRadius,
          })
        : svgEl("circle", {
            cx: centerX,
            cy: centerY,
            r: radius,
            fill: item.color,
            stroke: config.sliceStroke || "#ffffff",
            "stroke-width": config.sliceStrokeWidth || 4,
          }), centerX, centerY, getChartMotionDelay(itemIndex, 70));
      fullCircle.addEventListener("mouseenter", (event) => {
        showTooltip(event, item.name, [{ label: "Value", color: item.color, value: `${item.value}` }]);
      });
      fullCircle.addEventListener("mousemove", positionTooltip);
      fullCircle.addEventListener("mouseleave", clearTooltip);
      svg.appendChild(fullCircle);
      currentAngle = endAngle;
      return;
    }

    const path = prepareChartSliceMotion(
      svgEl("path", {
        d: config.donut
          ? describeDonutArc(centerX, centerY, radius, innerRadius, startAngle, endAngle)
          : describeArc(centerX, centerY, radius, startAngle, endAngle),
        fill: item.color,
        stroke: config.sliceStroke || "#ffffff",
        "stroke-width": config.sliceStrokeWidth || 4,
      }),
      centerX,
      centerY,
      getChartMotionDelay(itemIndex, 70),
    );
    path.addEventListener("mouseenter", (event) => {
      showTooltip(event, item.name, [{ label: "Value", color: item.color, value: `${item.value}` }]);
    });
    path.addEventListener("mousemove", positionTooltip);
    path.addEventListener("mouseleave", clearTooltip);
    svg.appendChild(path);

    if (config.showLabels !== false) {
      const mid = startAngle + sliceAngle / 2;
      const lineStart = polarToCartesian(centerX, centerY, radius, mid);
      const lineMid = polarToCartesian(centerX, centerY, radius + 16, mid);
      const lineEnd = {
        x: lineMid.x + (mid > 180 ? -18 : 18),
        y: lineMid.y,
      };
      svg.appendChild(prepareChartPathMotion(
        svgEl("path", { d: `M ${lineStart.x} ${lineStart.y} L ${lineMid.x} ${lineMid.y} L ${lineEnd.x} ${lineEnd.y}`, fill: "none", stroke: item.color, "stroke-width": 1.5 }),
        "chart-pie-label-line",
        260 + getChartMotionDelay(itemIndex, 48),
      ));
      svgText(svg, { x: lineEnd.x + (mid > 180 ? -6 : 6), y: lineEnd.y + 4, class: "chart-tick-label chart-pie-label", "text-anchor": mid > 180 ? "end" : "start", style: `--chart-delay:${260 + getChartMotionDelay(itemIndex, 48)}ms` }, `${item.name} ${Math.round(percent)}%`);
    }
    currentAngle = endAngle;
  });

  if (config.donut) {
    svg.appendChild(prepareChartMotion(
      svgEl("circle", {
        cx: centerX,
        cy: centerY,
        r: Math.max(0, innerRadius - 2),
        fill: config.centerFill || "#ffffff",
      }),
      "chart-center-disc",
      360,
    ));

    if (Array.isArray(config.centerLabel)) {
      const offsets = Array.isArray(config.centerOffsets) ? config.centerOffsets : [-18, 6, 30];
      config.centerLabel.forEach((line, index) => {
        svgText(
          svg,
          {
            x: centerX,
            y: centerY + offsets[index],
            class: `${index === 1 ? "chart-center-value" : "chart-center-copy"} chart-center-label`,
            "text-anchor": "middle",
            style: `--chart-delay:${420 + index * 70}ms`,
          },
          line,
        );
      });
    }
  }

  container.innerHTML = "";
  container.appendChild(svg);
}

function renderSparkline(container, config) {
  if (!container) return;
  const width = Math.max(container.clientWidth, 220);
  const height = config.height || 44;
  const svg = createSvg(width, height);
  const values = config.data.map((entry) => entry[config.key]);
  const domain = inferDomain(values, false, 0.08);
  const xPositions = config.data.map((_, index) => {
    const ratio = config.data.length === 1 ? 0.5 : index / (config.data.length - 1);
    return 6 + ratio * (width - 12);
  });
  const yScale = (value) => {
    const [min, max] = domain;
    const ratio = max === min ? 0 : (value - min) / (max - min);
    return 4 + (1 - ratio) * (height - 10);
  };
  const points = config.data.map((entry, index) => ({ x: xPositions[index], y: yScale(entry[config.key]) }));
  svg.appendChild(prepareChartMotion(
    svgEl("path", { d: buildAreaPath(points, height - 4), fill: colorWithAlpha(config.color, 0.18), stroke: "none" }),
    "chart-series-area",
    0,
  ));
  svg.appendChild(prepareChartPathMotion(
    svgEl("path", { d: buildSmoothPath(points), fill: "none", stroke: config.color, "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }),
    "chart-series-line",
    80,
  ));
  container.innerHTML = "";
  container.appendChild(svg);
}

function disconnectChartVisibilityObserver() {
  if (!chartVisibilityObserver) return;
  chartVisibilityObserver.disconnect();
  chartVisibilityObserver = null;
}

function getChartKeyForCurrentPage() {
  let chartKey = state.currentPage;
  if (getAuthenticatedRole() === "user") {
    if (state.currentPage === "dashboard") chartKey = "userDashboard";
    if (state.currentPage === "monitoring") chartKey = "userMonitoring";
    if (state.currentPage === "batch") chartKey = "userBatch";
    if (state.currentPage === "candling") chartKey = "userSchedule";
    if (state.currentPage === "notifications") chartKey = "userNotifications";
    if (state.currentPage === "history") chartKey = "userHistory";
  }
  return chartKey;
}

function getChartEntryById(chartId) {
  return (chartRegistry[getChartKeyForCurrentPage()] || []).find((entry) => entry.id === chartId) || null;
}

function getChartRenderConfig(entry) {
  const selectedRange = state.chartRanges[entry.id];
  const selectedRangeKey = selectedRange === undefined ? "" : String(selectedRange);

  if (entry.config.rangeKind === "sensor-hours") {
    const data = entry.config.data;
    const isRealtime = selectedRangeKey === "realtime" || selectedRangeKey === "current";
    const hours = Math.max(1, Math.min(168, Number(selectedRangeKey) || 24));
    const rangeEnd = Date.now();
    const cutoff = rangeEnd - hours * 60 * 60 * 1000;
    const rangedData = isRealtime
      ? getRealtimeSensorReadings(data)
      : data.filter((reading) => Number(reading.timestamp) >= cutoff);
    return {
      ...entry.config,
      data: rangedData,
      xAxis: {
        ...entry.config.xAxis,
        // Use real capture times. Equal spacing concealed network gaps and
        // made a restored historical point look like a current temperature dip.
        spacing: "time",
        timeDomain: null,
      },
      series: entry.config.series.map((series) => ({
        ...series,
        // Environment charts use one marker only while a line cannot yet be
        // drawn. As soon as a second reading arrives, render a clean trace.
        showDots: series.showDots === false ? rangedData.length === 1 : rangedData.length <= 30,
        showLivePulse: isRealtime && isLiveSensorReading(rangedData[rangedData.length - 1]),
      })),
    };
  }

  const rangeConfig = entry.config.rangeData?.[selectedRangeKey];
  if (rangeConfig) {
    return {
      ...entry.config,
      ...rangeConfig,
      data: rangeConfig.data || entry.config.data,
    };
  }

  const pointCount = Number(selectedRange || entry.config.data.length);
  if (!entry.config.rangeKind || pointCount >= entry.config.data.length) {
    return entry.config;
  }

  return {
    ...entry.config,
    data: entry.config.data.slice(-Math.max(1, pointCount)),
  };
}

function renderChartById(chartId) {
  const entry = getChartEntryById(chartId);
  const element = document.getElementById(chartId);
  if (!entry || !element) return;
  // A chart below the fold is still parked on the visibility observer when the
  // first sensor payload lands. Painting it here without releasing that
  // observation left the deferred callback free to redraw the element later,
  // which is why the dashboard graph only appeared after visiting Monitoring
  // and coming back. Claim the element now so this render is the final one.
  chartVisibilityObserver?.unobserve(element);
  renderChartEntry(entry, element);
}

function closeChartRangeMenus(exceptControl = null) {
  app.pageRoot?.querySelectorAll(".chart-range-menu").forEach((control) => {
    if (control === exceptControl) return;
    control.classList.remove("is-open");
    control.querySelector("[data-chart-range-menu]")?.setAttribute("hidden", "");
    control.querySelector("[data-chart-range-trigger]")?.setAttribute("aria-expanded", "false");
  });
}

function bindChartRangeMenuDismissal() {
  if (document.documentElement.dataset.chartRangeDismissalBound === "true") return;
  document.documentElement.dataset.chartRangeDismissalBound = "true";

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".chart-range-menu")) return;
    closeChartRangeMenus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeChartRangeMenus();
  });
}

function updateChartRangeTitle(chartId, label) {
  app.pageRoot?.querySelectorAll("[data-chart-range-title]").forEach((title) => {
    if (title.dataset.chartRangeTitle !== chartId) return;
    const valueNode = title.querySelector("[data-chart-range-title-value]");
    if (valueNode) valueNode.textContent = label;
  });
}

function setChartRangeMenuValue(control, value, { announce = false, render = false } = {}) {
  const chartId = control.dataset.chartId || "";
  const option = control.querySelector(`[data-chart-range-option][data-chart-range-value="${value}"]`);
  if (!chartId || !option) return;

  const label = option.textContent.trim();
  state.chartRanges[chartId] = value;
  control.dataset.chartRangeValue = value;

  const labelNode = control.querySelector("[data-chart-range-label]");
  if (labelNode) labelNode.textContent = label;

  control.querySelectorAll("[data-chart-range-option]").forEach((item) => {
    const isActive = item === option;
    item.classList.toggle("is-active", isActive);
    item.setAttribute("aria-checked", String(isActive));
  });

  updateChartRangeTitle(chartId, label);

  if (render) {
    clearTooltip();
    renderChartById(chartId);
    if (control.dataset.chartRange === "sensor-hours") {
      updateSensorReadingPage();
      if (getRequestedSensorHistoryHours() !== state.sensorReadingsHours) {
        void refreshSharedSensorReadings({ rerenderCharts: true });
      }
    }
  }
  if (announce) {
    showToast("Chart range updated", `${label} is now displayed.`);
  }
}

function bindChartRangeMenuControl(control) {
  const chartId = control.dataset.chartId || "";
  const trigger = control.querySelector("[data-chart-range-trigger]");
  const menu = control.querySelector("[data-chart-range-menu]");
  const options = Array.from(control.querySelectorAll("[data-chart-range-option]"));
  const initialValue = String(state.chartRanges[chartId] || control.dataset.chartRangeValue || options[0]?.dataset.chartRangeValue || "");
  if (!chartId || !trigger || !menu || !initialValue) return;

  setChartRangeMenuValue(control, initialValue);

  if (control.dataset.chartRangeBound === "true") return;
  control.dataset.chartRangeBound = "true";

  trigger.addEventListener("click", () => {
    const willOpen = menu.hidden;
    closeChartRangeMenus(control);
    menu.hidden = !willOpen;
    control.classList.toggle("is-open", willOpen);
    trigger.setAttribute("aria-expanded", String(willOpen));
  });

  options.forEach((option) => {
    option.addEventListener("click", () => {
      const nextValue = option.dataset.chartRangeValue || "";
      if (!nextValue) return;
      setChartRangeMenuValue(control, nextValue, { announce: true, render: true });
      closeChartRangeMenus();
    });
  });
}

function bindChartRangeControls() {
  if (!app.pageRoot) return;
  bindChartRangeMenuDismissal();
  app.pageRoot.querySelectorAll("[data-chart-range][data-chart-id]").forEach((select) => {
    if (select.classList.contains("chart-range-menu")) {
      bindChartRangeMenuControl(select);
      return;
    }

    const chartId = select.dataset.chartId || "";
    const selectedValue = String(select.value || "");
    if (!chartId || !selectedValue) return;

    if (!state.chartRanges[chartId]) {
      state.chartRanges[chartId] = selectedValue;
    }
    select.value = String(state.chartRanges[chartId]);

    if (select.dataset.chartRangeBound === "true") return;
    select.dataset.chartRangeBound = "true";
    select.addEventListener("change", () => {
      const nextValue = String(select.value);
      state.chartRanges[chartId] = nextValue;
      renderChartById(chartId);
      if (select.dataset.chartRange === "sensor-hours") {
        updateSensorReadingPage();
        if (getRequestedSensorHistoryHours() !== state.sensorReadingsHours) {
          void refreshSharedSensorReadings({ rerenderCharts: true });
        }
      }
      clearTooltip();
      showToast("Chart range updated", `${select.options[select.selectedIndex].text} is now displayed.`);
    });
  });
}

function renderChartEntry(entry, element) {
  if (!element) return;
  // Live sensor refreshes replace the SVG in one DOM operation. Only the first
  // render should play the draw-in animations; replaying them every few seconds
  // looked like a flashing graph, especially on mobile screens.
  const isRefresh = element.dataset.chartRendered === "true";
  const isEnvironmentSensorChart = entry.config.rangeKind === "sensor-hours";
  // Sensor lines represent a live state, so paint their complete path
  // immediately even on first load. A draw-in animation can briefly look like
  // a broken trace when readings resume after a DHT interruption.
  element.classList.toggle("chart-render--steady", isRefresh || isEnvironmentSensorChart);
  const baseConfig = getChartRenderConfig(entry);
  const isPhone = window.matchMedia("(max-width: 640px)").matches;
  const isMonitoringChart = entry.id === "chart-monitoring-temperature"
    || entry.id === "chart-monitoring-humidity";
  const isDashboardEnvironmentChart = [
    "chart-admin-dashboard-temperature",
    "chart-admin-dashboard-humidity",
    "chart-dashboard-temperature",
    "chart-dashboard-humidity",
  ].includes(entry.id);
  const config = isPhone && isMonitoringChart
    ? { ...baseConfig, height: 150 }
    : (isPhone && isDashboardEnvironmentChart ? { ...baseConfig, height: 180 } : baseConfig);
  if (entry.type === "xy") renderXYChart(element, config);
  if (entry.type === "bar") renderBarChart(element, config);
  if (entry.type === "pie") renderPieChart(element, config);
  element.dataset.chartRendered = "true";
}

function renderChartsForPage() {
  disconnectChartVisibilityObserver();

  const entries = chartRegistry[getChartKeyForCurrentPage()] || [];
  if (!entries.length) return;

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const preloadOffset = 240;
  const supportsIntersectionObserver = "IntersectionObserver" in window;

  if (supportsIntersectionObserver) {
    const observer = new IntersectionObserver(
      (observerEntries) => {
        observerEntries.forEach((observerEntry) => {
          if (!observerEntry.isIntersecting) return;
          const chartIndex = Number(observerEntry.target.dataset.chartIndex || "-1");
          const chartEntry = entries[chartIndex];
          if (!chartEntry) return;
          renderChartEntry(chartEntry, observerEntry.target);
          observer.unobserve(observerEntry.target);
        });
      },
      {
        root: null,
        rootMargin: `${preloadOffset}px 0px`,
        threshold: 0.01,
      },
    );
    chartVisibilityObserver = observer;
  }

  entries.forEach((entry, index) => {
    const element = document.getElementById(entry.id);
    if (!element) return;

    element.dataset.chartIndex = String(index);
    const rect = element.getBoundingClientRect();
    const isNearViewport = rect.top <= viewportHeight + preloadOffset && rect.bottom >= -preloadOffset;

    if (!supportsIntersectionObserver || isNearViewport) {
      renderChartEntry(entry, element);
      return;
    }

    // Blanking the slot also retires the "already drawn" marker. Leaving it set
    // made the next paint take the refresh path and skip the draw-in, and it
    // hid the fact that the element currently shows nothing at all.
    element.innerHTML = "";
    delete element.dataset.chartRendered;
    chartVisibilityObserver?.observe(element);
  });
}

function debounce(callback, wait) {
  let timeoutId = 0;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), wait);
  };
}

function bindShellElementEvents() {
  if (app.menuButton && app.menuButton.dataset.shellBound !== "true") {
    app.menuButton.dataset.shellBound = "true";
    app.menuButton.addEventListener("click", () => {
      if (state.sidebarOpen) {
        closeSidebar();
      } else {
        openSidebar();
      }
    });
  }

  if (app.sidebarBackdrop && app.sidebarBackdrop.dataset.shellBound !== "true") {
    app.sidebarBackdrop.dataset.shellBound = "true";
    app.sidebarBackdrop.addEventListener("click", closeSidebar);
  }
}

function bindGlobalEvents() {
  bindShellElementEvents();
  window.addEventListener(
    "resize",
    debounce(() => {
      const nextViewportWidth = Math.round(document.documentElement.clientWidth || window.innerWidth || 0);
      if (nextViewportWidth === state.viewportWidth) return;
      const crossedPhoneBreakpoint = (state.viewportWidth <= 640) !== (nextViewportWidth <= 640);
      state.viewportWidth = nextViewportWidth;
      renderSidebar();
      // Mobile address bars constantly change viewport height while scrolling.
      // Width-aware rendering keeps that from rehydrating the whole page and
      // recreating every chart. Redraw only when the responsive chart layout
      // itself crosses the phone breakpoint; SVG viewBox scaling handles the
      // remaining width changes without destructive rerenders.
      if (crossedPhoneBreakpoint) renderChartsForPage();
    }, 120),
  );
  window.addEventListener("scroll", clearTooltip, { passive: true });
  window.addEventListener("popstate", (event) => {
    if (event.state?.smartduckAuthBoundary === true) {
      clearAuthenticationSession();
      redirectToLogin({ replaceHistory: true });
      return;
    }
    if (!isAuthenticated()) {
      redirectToLogin({ replaceHistory: true });
      return;
    }
    void navigateToPage(getPageIdFromLocation(), getAuthenticatedRole(), { historyMode: "none" });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSidebar();
  });
}

function enforceAuthenticationBoundary() {
  if (isLoginScreen()) {
    if (isAuthenticated()) {
      redirectToPage(getDefaultPageId(), getAuthenticatedRole(), { replaceHistory: true });
    }
    return;
  }

  if (!isAuthenticated()) {
    const protectedShell = document.getElementById("dashboard-container");
    if (protectedShell) protectedShell.hidden = true;
    redirectToLogin({ replaceHistory: true });
    return;
  }

  const role = getAuthenticatedRole();
  const pathRole = getPathRole();
  const currentPage = document.body.dataset.page || getDefaultPageId(role);
  if (pathRole !== role || !isPageAllowed(currentPage, role)) {
    redirectToPage(getDefaultPageId(role), role, { replaceHistory: true });
  }
}

// Each account now has its own auth cookie and every request carries this tab's
// session id, so the backend answers for the account THIS tab signed in as --
// an operator here and an administrator in the next tab stay side by side.
// This check therefore only reconciles the account's own details (a rename, a
// role change) and reports a genuinely ended session. It must never adopt a
// different account: doing that was what made a second sign-in hijack this tab.
async function syncSessionIdentityWithBackend() {
  if (isLoginScreen() || !isAuthenticated()) return;

  let payload;
  try {
    payload = await requestBackendJson(SESSION_ENDPOINT, { allowUnauthenticated: true });
  } catch {
    // A transient failure must never eject a signed-in user.
    return;
  }

  const account = payload?.authenticated === true && payload.account ? payload.account : null;
  if (payload?.authenticated === false) {
    if (payload.reason === "session_replaced") handleExpiredSession("session_replaced");
    else if (await checkBackendSessionAuthentication() === false) handleExpiredSession();
    return;
  }
  const backendUsername = String(account?.username || "").trim();
  if (backendUsername === "") return;
  if (backendUsername.toLowerCase() === String(getAuthenticatedUsername() || "").trim().toLowerCase()) {
    // Same account: keep the display name and role in step with the backend so a
    // rename or a role change lands without a reload.
    const shellRole = getAccountShellRole(account);
    if (account.name) sessionStorage.setItem(USER_KEY, account.name);
    sessionStorage.setItem(DISPLAY_ROLE_KEY, getManagedAccountRole(account));
    if (shellRole !== getAuthenticatedRole()) {
      sessionStorage.setItem(ROLE_KEY, shellRole);
      accountState.cache = [];
      accountState.readyPromise = null;
      redirectToPage(getDefaultPageId(shellRole), shellRole, { replaceHistory: true });
    }
    return;
  }

  // A different account answered for this tab. That means this tab's own session
  // is gone (its cookie expired or was cleared) and another account's cookie was
  // used instead, so end this tab rather than silently becoming someone else.
  handleExpiredSession("session_replaced");
}

function initializeApp() {
  if (isLoginScreen()) return;
  cacheCurrentPageTemplate();
  initializeProtectedHistory();
  renderSidebar();
  renderCurrentPage();
  initializeUserManagement();
  bindGlobalEvents();
  preloadRolePages();
  // The live poll runs on every signed-in page: on live pages it is also what
  // tells the ESP32 that someone could press a control, so it polls fast.
  startComponentStatusPolling();
}

bindImmediateInteractionFeedback();
initializePasswordRecovery();
initializeAuth();
window.addEventListener("pageshow", enforceAuthenticationBoundary);
if (!isLoginScreen() && isAuthenticated()) {
  initializeApp();
  void syncSessionIdentityWithBackend();
  let sessionPollRunning = false;
  const checkSession = async () => {
    if (sessionPollRunning || !isAuthenticated() || document.hidden) return;
    sessionPollRunning = true;
    try { await syncSessionIdentityWithBackend(); } finally { sessionPollRunning = false; }
  };
  // Focus and visibility changes check at once. The live status poll already
  // sends this tab's session and signs it out on session_replaced, so this
  // timer is only a slow backstop; each check is a billed invocation.
  window.setInterval(checkSession, 300000);
  window.addEventListener("focus", checkSession);
  document.addEventListener("visibilitychange", checkSession);
} else if (isLoginScreen() && sessionStorage.getItem(SESSION_NOTICE_KEY) === "session_replaced") {
  sessionStorage.removeItem(SESSION_NOTICE_KEY);
  void showWarningCard("Your account was signed in elsewhere", "Another browser or device signed in to this SmartDuck account. This session has been signed out. Sign in again if you need to continue.");
}

