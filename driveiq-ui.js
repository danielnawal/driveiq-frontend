/* ==========================================================
   DriveIQ UI Global — DEFINITIVO FINAL
   ========================================================== */

(function () {

  const BRAND = "DriveIQ";
  const SLOGAN = "Driving Intelligence & Performance Analytics";
  const THEME_KEY = "driveiq_theme";

  const IS_DASHBOARD =
    location.pathname === "/" ||
    location.pathname.endsWith("/dashboard.html");

  /* ================= THEME ================= */
  function getTheme() {
    return localStorage.getItem(THEME_KEY) || "light";
  }

  function applyTheme(theme) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.body.classList.toggle("dark", theme === "dark");
  }

  function setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  }

  applyTheme(getTheme());

  /* ================= HEADER ================= */
  function createHeader() {
    const header = document.createElement("header");
    header.id = "driveiq-header";

    header.innerHTML = `
      <div class="diq-left">
        <div class="diq-brand">
          <span class="diq-name">${BRAND}</span>
          ${IS_DASHBOARD ? `<span class="diq-slogan">${SLOGAN}</span>` : ""}
        </div>
      </div>

      <div class="diq-right">
        <nav class="diq-nav">
          <a href="/dashboard.html">Dashboard</a>
          <a href="/ranking.html">Ranking</a>
          <a href="/reportes.html">Reportes</a>
        </nav>

        <button id="diqThemeBtn" class="diq-theme" title="Cambiar tema">
          <span class="sun">☀️</span>
          <span class="moon">🌙</span>
        </button>
      </div>
    `;

    document.body.prepend(header);

    const btn = document.getElementById("diqThemeBtn");
    btn.onclick = () => {
      const next = getTheme() === "dark" ? "light" : "dark";
      setTheme(next);
      updateThemeIcon();
    };

    updateThemeIcon();
  }

  function updateThemeIcon() {
    const btn = document.getElementById("diqThemeBtn");
    if (!btn) return;
    btn.classList.toggle("dark", getTheme() === "dark");
  }

  /* ================= ESTILOS GLOBALES ================= */
  function injectStyles() {
    const style = document.createElement("style");
    style.innerHTML = `
      :root {
        --diq-bg:#ffffff;
        --diq-text:#111827;
        --diq-muted:#6b7280;
        --diq-border:#e5e7eb;
      }
      .dark {
        --diq-bg:#0b1020;
        --diq-text:#e8eeff;
        --diq-muted:#9aa7d6;
        --diq-border:#243156;
      }

      /* HEADER */
      #driveiq-header {
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding:6px 18px;
        background:var(--diq-bg);
        border-bottom:1px solid var(--diq-border);
        position:relative;   /* CLAVE: ya NO sticky */
        z-index:1000;
      }

      .diq-brand {
        display:flex;
        flex-direction:column;
        gap:1px;
      }

      .diq-name {
        font-size:20px;
        font-weight:800;
        color:var(--diq-text);
        letter-spacing:.2px;
      }

      .diq-slogan {
        font-size:13px;
        color:var(--diq-muted);
        letter-spacing:.3px;
      }

      .diq-right {
        display:flex;
        align-items:center;
        gap:14px;
      }

      .diq-nav a {
        margin:0 6px;
        font-size:13px;
        text-decoration:none;
        color:var(--diq-muted);
        font-weight:500;
      }

      .diq-nav a:hover {
        color:var(--diq-text);
      }

      .diq-theme {
        background:none;
        border:1px solid var(--diq-border);
        border-radius:999px;
        padding:6px 10px;
        cursor:pointer;
        font-size:14px;
      }

      .diq-theme .sun { display:inline; }
      .diq-theme .moon { display:none; }

      .diq-theme.dark .sun { display:none; }
      .diq-theme.dark .moon { display:inline; }

      /* 🔥 ELIMINAR CUALQUIER ESPACIO SUPERIOR */
      body {
        padding-top:0 !important;
        margin-top:0 !important;
      }

      /* 🔒 CAPITALIZACIÓN GLOBAL */
      table td:nth-child(2),
      table td:nth-child(3) {
        text-transform: capitalize;
      }
    `;
    document.head.appendChild(style);
  }

  /* ================= INIT ================= */
  injectStyles();
  createHeader();

})();
