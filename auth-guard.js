(() => {
  const authKey = "smartduck_authenticated";
  const roleKey = "smartduck_role";
  const expectedRole = document.currentScript?.dataset.role === "user" ? "user" : "admin";
  const protectedSessionKeys = [
    authKey,
    "smartduck_user",
    "smartduck_username",
    roleKey,
    "smartduck_display_role",
    "smartduck_session_id",
  ];

  let isAuthenticated = false;
  let sessionRole = "";
  try {
    isAuthenticated = sessionStorage.getItem(authKey) === "true";
    sessionRole = String(sessionStorage.getItem(roleKey) || "").trim().toLowerCase();
  } catch {
    isAuthenticated = false;
  }

  if (!isAuthenticated || !["admin", "user"].includes(sessionRole)) {
    document.documentElement.style.visibility = "hidden";
    try {
      protectedSessionKeys.forEach((key) => sessionStorage.removeItem(key));
    } catch {
      // Continue to the login page even when browser storage is unavailable.
    }
    window.location.replace("../");
    return;
  }

  if (sessionRole !== expectedRole) {
    document.documentElement.style.visibility = "hidden";
    window.location.replace(`../${sessionRole}/dashboard`);
  }
})();
