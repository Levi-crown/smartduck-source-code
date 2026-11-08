/* ==========================================================================
   SmartDuck - Mobile shell
   --------------------------------------------------------------------------
   Adds the mobile-only shell behaviour that SmartDuck's desktop layout does
   not provide:

     1. A fixed bottom navigation bar mirroring the sidebar's destinations.
     2. Data tables that can stack into row-cards on a phone.
     3. A compact top bar that owns the notification and profile controls.

   Both are driven entirely off the DOM that script.js already renders, via
   MutationObserver. script.js is not modified and not imported, so if this
   file fails to load the app behaves exactly as it did before.

   IMPORTANT: soft navigation (applyPageTemplate) reassigns
   #dashboard-container.innerHTML, which detaches the bottom nav and every
   node we observe. So #dashboard-container -- the one element that survives
   a route change -- is the anchor: we watch it and re-mount after each swap.
   mount() is idempotent, so the mutation our own re-append causes settles on
   the next cycle without looping.

   Paired with mobile.css, which is where all of the visual work lives. Header
   controls are relocated (not cloned) on small screens so existing listeners,
   live badges and profile data stay intact, then restored on desktop resize.
   ========================================================================== */

(function initSmartDuckMobileShell() {
  "use strict";

  if (window.__smartDuckMobileShell) return;
  window.__smartDuckMobileShell = true;

  /* Short labels for the bottom bar, keyed on the sidebar's own label text so
     that role differences (admin calls "batch" -> "Reports") come out right
     without duplicating MENU_ITEMS here. */
  const SHORT_LABELS = {
    Dashboard: "Dashboard",
    Monitoring: "Monitoring",
    "Batch Management": "Batch",
    Schedules: "Sched",
    "User Management": "Users",
    Notifications: "Alerts",
  };

  /* Column headers whose cells carry controls rather than a value; these get
     a blank label so the stacked card does not show an empty label gutter. */
  const UNLABELLED_COLUMNS = new Set(["actions", "action", ""]);

  let container = null;
  let nav = null;

  // Nodes we are currently observing, so a re-mount can tell "same node,
  // already wired" from "replaced, needs rewiring".
  let observedSidebarContent = null;
  let observedSidebar = null;
  const observedTables = new WeakSet();

  let sidebarContentObserver = null;
  let sidebarObserver = null;
  const mobileViewport = window.matchMedia("(max-width: 980px)");
  const relocatedTopbarNodes = new Map();

  ready(() => {
    container = document.getElementById("dashboard-container");

    // Login page and the redirect stubs have no shell; nothing to do there.
    if (!container) return;

    nav = buildNav();

    // #dashboard-container itself survives soft navigation; its children do
    // not. Re-mount whenever they are swapped out.
    new MutationObserver(() => mount()).observe(container, { childList: true });

    const handleViewportChange = () => mount();
    if (typeof mobileViewport.addEventListener === "function") {
      mobileViewport.addEventListener("change", handleViewportChange);
    } else {
      mobileViewport.addListener(handleViewportChange);
    }

    document.addEventListener("smartduck:before-route-swap", restoreRelocatedTopbarNodes);
    document.addEventListener("smartduck:route-changed", mount);

    mount();
  });

  /* ----------------------------------------------------------------- mount */

  function mount() {
    if (!container) return;

    // Re-append the same node rather than rebuilding it, so its click
    // listener (bound once in buildNav) survives the innerHTML wipe.
    if (nav && nav.parentNode !== container) {
      container.appendChild(nav);
    }

    wireMobileTopbar();
    wireSidebarContent();
    wireDrawerLock();
    wireTables();
    syncNav();
  }

  /* --------------------------------------------------------- compact header */

  function wireMobileTopbar() {
    // Drop entries left behind by a soft-navigation DOM replacement.
    relocatedTopbarNodes.forEach((origin, node) => {
      if (!node.isConnected && !origin.parent?.isConnected) relocatedTopbarNodes.delete(node);
    });

    if (!mobileViewport.matches) {
      relocatedTopbarNodes.forEach((origin, node) => {
        if (!node.isConnected || !origin.parent?.isConnected) return;
        const anchor = origin.nextSibling?.parentNode === origin.parent ? origin.nextSibling : null;
        origin.parent.insertBefore(node, anchor);
      });
      relocatedTopbarNodes.clear();
      document.querySelectorAll(".sd-mobile-header-condensed").forEach((header) => {
        header.classList.remove("sd-mobile-header-condensed", "sd-mobile-header-empty");
      });
      document.querySelectorAll(".mobile-topbar__actions").forEach((actions) => actions.remove());
      return;
    }

    const topbar = container.querySelector(".mobile-topbar");
    const pageHeader = container.querySelector(".page-header--dashboard");
    if (!topbar || !pageHeader) return;

    let actions = topbar.querySelector(".mobile-topbar__actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "mobile-topbar__actions";
      actions.setAttribute("aria-label", "Account actions");
      topbar.appendChild(actions);
    }

    const controls = [
      pageHeader.querySelector(".dashboard-alert-button"),
      pageHeader.querySelector(".dashboard-userbox"),
    ].filter((node, index, nodes) => node && nodes.indexOf(node) === index);

    controls.forEach((node) => {
      if (!relocatedTopbarNodes.has(node)) {
        relocatedTopbarNodes.set(node, {
          parent: node.parentNode,
          nextSibling: node.nextSibling,
        });
      }
      actions.appendChild(node);
    });

    pageHeader.classList.add("sd-mobile-header-condensed");
    const hasRemainingActions = Array.from(pageHeader.children)
      .slice(1)
      .some((section) => section.children.length > 0);
    pageHeader.classList.toggle("sd-mobile-header-empty", !hasRemainingActions);
    actions.hidden = actions.children.length === 0;
  }

  function restoreRelocatedTopbarNodes() {
    relocatedTopbarNodes.forEach((origin, node) => {
      if (!node.isConnected || !origin.parent?.isConnected) return;
      const anchor = origin.nextSibling?.parentNode === origin.parent ? origin.nextSibling : null;
      origin.parent.insertBefore(node, anchor);
    });
    relocatedTopbarNodes.clear();
    document.querySelectorAll(".mobile-topbar__actions").forEach((actions) => actions.remove());
    document.querySelectorAll(".sd-mobile-header-condensed").forEach((header) => {
      header.classList.remove("sd-mobile-header-condensed", "sd-mobile-header-empty");
    });
  }

  function wireSidebarContent() {
    const sidebarContent = document.getElementById("sidebar-content");
    if (!sidebarContent || sidebarContent === observedSidebarContent) return;

    sidebarContentObserver?.disconnect();
    sidebarContentObserver = new MutationObserver(syncNav);
    sidebarContentObserver.observe(sidebarContent, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-current"],
    });
    observedSidebarContent = sidebarContent;
  }

  function wireDrawerLock() {
    const sidebar = document.getElementById("app-sidebar");
    if (!sidebar || sidebar === observedSidebar) return;

    // script.js owns the .is-open class (openSidebar/closeSidebar); we only
    // mirror it onto <body> so the page behind the drawer stops scrolling.
    const sync = () => {
      document.body.classList.toggle("sd-drawer-open", sidebar.classList.contains("is-open"));
    };

    sidebarObserver?.disconnect();
    sidebarObserver = new MutationObserver(sync);
    sidebarObserver.observe(sidebar, { attributes: true, attributeFilter: ["class"] });
    observedSidebar = sidebar;
    sync();
  }

  /* ------------------------------------------------------------ bottom nav */

  function buildNav() {
    const element = document.createElement("nav");
    element.className = "sd-bottom-nav";
    element.id = "sd-bottom-nav";
    element.setAttribute("aria-label", "Mobile navigation");
    element.hidden = true;

    element.addEventListener("click", (event) => {
      const button = event.target.closest("[data-page]");
      if (!button) return;

      event.preventDefault();
      // Re-query rather than caching: renderSidebar() replaces the sidebar's
      // markup on every navigation, so a held anchor goes stale and its
      // click listener dies with it.
      const anchor = document.querySelector(
        `#sidebar-content a[data-page="${cssEscape(button.dataset.page)}"]`,
      );

      if (anchor) {
        // Let script.js's own handler run so soft navigation, the active
        // state and closeSidebar() all behave exactly as they do from the
        // drawer. If that handler has not attached yet, the anchor's href
        // still performs a normal page load.
        anchor.click();
        return;
      }

      setActive(button.dataset.page);
    });

    return element;
  }

  function syncNav() {
    if (!nav) return;

    const links = Array.from(document.querySelectorAll("#sidebar-content a[data-page]"));

    // The settings row is a flyout toggle with no data-page, so it stays in
    // the drawer only -- which is what we want; a flyout anchored to a bottom
    // bar button would open off-screen.
    const items = links.map((link) => {
      const label = text(link.querySelector('[class$="__label"]')) || text(link);
      return {
        page: link.dataset.page || "",
        icon: link.querySelector('[class$="__icon"]')?.innerHTML || "",
        label: SHORT_LABELS[label] || label.split(" ")[0] || label,
        active: link.classList.contains("is-active"),
      };
    });

    nav.hidden = items.length === 0;
    if (items.length === 0) return;

    nav.style.setProperty("--sd-nav-columns", String(items.length));

    const existing = Array.from(nav.children);
    const sameShape =
      existing.length === items.length
      && existing.every((el, i) => el.dataset.page === items[i].page);

    // Patch in place when the destinations have not changed. Rebuilding via
    // replaceChildren mid-tap swaps the node out from under the press and
    // drops the active-state transition.
    if (sameShape) {
      existing.forEach((el, i) => {
        applyActive(el, items[i].active);

        const icon = el.querySelector(".sd-bottom-nav__icon");
        if (icon && icon.innerHTML !== items[i].icon) icon.innerHTML = items[i].icon;

        const label = el.querySelector(".sd-bottom-nav__label");
        if (label && label.textContent !== items[i].label) label.textContent = items[i].label;
      });
      return;
    }

    nav.replaceChildren(
      ...items.map((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sd-bottom-nav__button";
        button.dataset.page = item.page;
        applyActive(button, item.active);

        const icon = document.createElement("span");
        icon.className = "sd-bottom-nav__icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = item.icon;

        const label = document.createElement("span");
        label.className = "sd-bottom-nav__label";
        label.textContent = item.label;

        button.append(icon, label);
        return button;
      }),
    );
  }

  function setActive(page) {
    nav?.querySelectorAll("[data-page]").forEach((button) => {
      applyActive(button, button.dataset.page === page);
    });
  }

  function applyActive(element, isActive) {
    element.classList.toggle("is-active", isActive);
    if (isActive) {
      element.setAttribute("aria-current", "page");
    } else {
      element.removeAttribute("aria-current");
    }
  }

  /* --------------------------------------------------------- table labels */

  function wireTables() {
    // Wrapper classes vary per page (batch-, reports-, monitoring-,
    // users-management-, ...), so match the shared "*table-wrap" suffix
    // rather than enumerating them.
    document.querySelectorAll('[class*="table-wrap"] table').forEach((table) => {
      const body = table.tBodies[0];
      if (!body || observedTables.has(body)) return;
      observedTables.add(body);

      const label = () => labelTable(table, body);

      // Rows are rendered (and re-rendered on filter/pagination) by script.js
      // long after the page is parsed, so labels have to be reapplied.
      new MutationObserver(label).observe(body, { childList: true });
      label();
    });
  }

  function labelTable(table, body) {
    const headers = Array.from(table.tHead?.rows?.[0]?.cells || []).map((cell) => text(cell));
    if (headers.length === 0) return;

    Array.from(body.rows).forEach((row) => {
      const cells = Array.from(row.cells);

      // Empty-state and spanning rows have no per-column meaning.
      if (cells.some((cell) => cell.colSpan > 1)) {
        cells.forEach((cell) => cell.removeAttribute("data-mobile-label"));
        return;
      }

      cells.forEach((cell, index) => {
        const header = headers[index] || "";
        const value = UNLABELLED_COLUMNS.has(header.toLowerCase()) ? "" : header;
        if (cell.getAttribute("data-mobile-label") !== value) {
          cell.setAttribute("data-mobile-label", value);
        }
      });
    });
  }

  /* ---------------------------------------------------------------- utils */

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
      return;
    }
    fn();
  }

  function text(node) {
    return (node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function cssEscape(value) {
    const raw = String(value ?? "");
    return window.CSS?.escape ? window.CSS.escape(raw) : raw.replace(/["\\]/g, "\\$&");
  }
})();
