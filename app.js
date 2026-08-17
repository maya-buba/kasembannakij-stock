(() => {
  "use strict";

  /* ---------------- storage ---------------- */
  const LS_BOOKS = "kbnk.books.v1";
  const LS_SALES = "kbnk.sales.v1";
  const LS_LOCATIONS = "kbnk.locations.v1";
  const LS_SETTINGS = "kbnk.settings.v1";

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const todayISO = () => new Date().toISOString().slice(0, 10);

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.error("load failed", key, e);
      return fallback;
    }
  }
  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  const DEFAULT_LOCATIONS = [
    { id: uid(), name: "Storefront", commissionPct: 0 },
    { id: uid(), name: "Online", commissionPct: 0 },
    { id: uid(), name: "Book Fair", commissionPct: 0 },
    { id: uid(), name: "Shopee", commissionPct: 4 },
    { id: uid(), name: "Lazada", commissionPct: 6 },
    { id: uid(), name: "Consignment", commissionPct: 0 },
  ];

  let books = load(LS_BOOKS, []);
  let sales = load(LS_SALES, []);
  const locationsIsFresh = localStorage.getItem(LS_LOCATIONS) === null;
  let locations = load(LS_LOCATIONS, DEFAULT_LOCATIONS);
  if (locationsIsFresh) save(LS_LOCATIONS, locations);
  let settings = load(LS_SETTINGS, { lowStockThreshold: 3 });

  // migrate old plain-string location lists to {id, name, commissionPct} objects
  if (locations.length && typeof locations[0] === "string") {
    locations = locations.map((name) => ({ id: uid(), name, commissionPct: 0 }));
    save(LS_LOCATIONS, locations);
  }
  // migrate sales recorded before wholesale/commission tracking existed
  let salesMigrated = false;
  sales.forEach((s) => {
    if (!s.saleType) { s.saleType = "retail"; salesMigrated = true; }
    if (typeof s.commissionPct !== "number") { s.commissionPct = 0; salesMigrated = true; }
    if (!s.orderId) { s.orderId = s.id; salesMigrated = true; }
    if (typeof s.customer !== "string") { s.customer = ""; salesMigrated = true; }
  });
  if (salesMigrated) save(LS_SALES, sales);

  function persistBooks() { save(LS_BOOKS, books); syncToFolder(); }
  function persistSales() { save(LS_SALES, sales); syncToFolder(); }
  function persistLocations() { save(LS_LOCATIONS, locations); syncToFolder(); }
  function persistSettings() { save(LS_SETTINGS, settings); syncToFolder(); }

  function locationByName(name) {
    const v = (name || "").trim().toLowerCase();
    return locations.find((l) => l.name.toLowerCase() === v);
  }
  function ensureLocation(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return null;
    let loc = locationByName(trimmed);
    if (!loc) {
      loc = { id: uid(), name: trimmed, commissionPct: 0 };
      locations.push(loc);
      persistLocations();
    }
    return loc;
  }

  /* seed sample data on very first run so the UI isn't empty */
  if (books.length === 0 && sales.length === 0 && !localStorage.getItem(LS_SETTINGS)) {
    books = [
      { id: uid(), title: "Sapiens", author: "Yuval Noah Harari", price: 450, wholesalePrice: 320, cost: 260, stock: 12, archived: false, createdAt: Date.now() },
      { id: uid(), title: "Norwegian Wood", author: "Haruki Murakami", price: 320, wholesalePrice: 220, cost: 180, stock: 4, archived: false, createdAt: Date.now() },
      { id: uid(), title: "The Design of Everyday Things", author: "Don Norman", price: 520, wholesalePrice: 380, cost: 300, stock: 2, archived: false, createdAt: Date.now() },
    ];
    persistBooks();
  }

  /* ---------------- currency / helpers ---------------- */
  const fmtMoney = (n) => "฿" + Math.round(n).toLocaleString("en-US");
  const fmtMoneySigned = (n) => (n < 0 ? "-" : "") + fmtMoney(Math.abs(n));
  const fmtNum = (n, d = 1) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d });
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* RFC4180-ish CSV parser: handles quoted fields, embedded commas/newlines, "" escapes */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    const clean = text.replace(/^﻿/, "");
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i], next = clean[i + 1];
      if (inQuotes) {
        if (c === '"' && next === '"') { field += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { field += c; }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && next === "\n") i++;
        row.push(field); field = "";
        if (row.some((v) => v !== "")) rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length) { row.push(field); if (row.some((v) => v !== "")) rows.push(row); }
    return rows;
  }

  function csvRowsToObjects(rows) {
    if (!rows.length) return [];
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    return rows.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (r[i] || "").trim(); });
      return obj;
    });
  }
  function pick(obj, ...keys) {
    for (const k of keys) { if (obj[k] !== undefined && obj[k] !== "") return obj[k]; }
    return "";
  }

  function activeBooks() { return books.filter((b) => !b.archived); }
  function bookById(id) { return books.find((b) => b.id === id); }

  function showToast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("is-visible"));
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      el.classList.remove("is-visible");
      setTimeout(() => { el.hidden = true; }, 200);
    }, 2200);
  }

  /* ---------------- navigation ---------------- */
  const tabs = document.querySelectorAll(".tab");
  const views = document.querySelectorAll(".view");
  function setView(name) {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === name)));
    views.forEach((v) => v.classList.toggle("is-active", v.dataset.view === name));
    if (name === "dashboard") renderDashboard();
    if (name === "inventory") renderInventory();
    if (name === "sell") renderSellForm();
    if (name === "sales") renderSalesLog();
    if (name === "settings") renderSettings();
    window.scrollTo({ top: 0 });
  }
  tabs.forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));

  /* ---------------- date range ---------------- */
  let currentPeriod = "30";
  const periodPicker = document.getElementById("period-picker");
  periodPicker.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    currentPeriod = btn.dataset.period;
    periodPicker.querySelectorAll(".chip").forEach((c) => c.classList.toggle("is-active", c === btn));
    renderDashboard();
  });

  let trendGranularity = "day";
  document.getElementById("trend-granularity").addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-btn");
    if (!btn) return;
    trendGranularity = btn.dataset.gran;
    document.getElementById("trend-granularity").querySelectorAll(".segmented-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    const { start, end } = periodRange(currentPeriod);
    renderTrendChart(start, end);
  });

  function periodRange(period) {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    let start;
    if (period === "all") {
      start = new Date(0);
    } else if (period === "month") {
      start = new Date(end.getFullYear(), end.getMonth(), 1);
    } else {
      start = new Date(end);
      start.setDate(start.getDate() - (Number(period) - 1));
      start.setHours(0, 0, 0, 0);
    }
    return { start, end };
  }
  function salesInRange(start, end) {
    return sales.filter((s) => {
      const d = new Date(s.date + "T12:00:00");
      return d >= start && d <= end;
    });
  }
  function periodDays(period, start, end) {
    if (period === "all") {
      if (sales.length === 0) return 1;
      const earliest = sales.reduce((min, s) => Math.min(min, new Date(s.date).getTime()), Date.now());
      return Math.max(1, Math.ceil((Date.now() - earliest) / 86400000));
    }
    return Math.max(1, Math.round((end - start) / 86400000) + 1);
  }

  /* ---------------- sale/book math ---------------- */
  function saleRevenue(s) { return s.qty * s.unitPrice; }
  function saleCommission(s) { return saleRevenue(s) * ((s.commissionPct || 0) / 100); }
  function saleNetRevenue(s) { return saleRevenue(s) - saleCommission(s); }
  function saleCost(s) { return s.qty * s.unitCost; }
  function saleMargin(s) { return saleNetRevenue(s) - saleCost(s); }

  function sunkCost() {
    return activeBooks().reduce((sum, b) => sum + Math.max(0, b.stock) * b.cost, 0);
  }

  function velocityFor(bookId, days = 30) {
    const cutoff = Date.now() - days * 86400000;
    const qty = sales.filter((s) => s.bookId === bookId && new Date(s.date).getTime() >= cutoff)
      .reduce((sum, s) => sum + s.qty, 0);
    return qty / days;
  }

  /* ============================================================
     DASHBOARD
  ============================================================ */
  function renderDashboard() {
    const { start, end } = periodRange(currentPeriod);
    const periodSales = salesInRange(start, end);
    const days = periodDays(currentPeriod, start, end);

    const revenue = periodSales.reduce((s, x) => s + saleRevenue(x), 0);
    const commission = periodSales.reduce((s, x) => s + saleCommission(x), 0);
    const margin = periodSales.reduce((s, x) => s + saleMargin(x), 0);
    const units = periodSales.reduce((s, x) => s + x.qty, 0);
    const wholesaleRevenue = periodSales.filter((x) => x.saleType === "wholesale").reduce((s, x) => s + saleRevenue(x), 0);
    const velocity = units / days;
    const sunk = sunkCost();
    const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0;

    const grid = document.getElementById("stat-grid");
    grid.innerHTML = `
      <div class="stat-card">
        <span class="stat-label">Revenue</span>
        <span class="stat-value">${fmtMoney(revenue)}</span>
        <span class="stat-sub">${units} unit${units === 1 ? "" : "s"} sold${wholesaleRevenue > 0 ? ` · ${fmtMoney(wholesaleRevenue)} wholesale` : ""}${commission > 0 ? ` · ${fmtMoney(commission)} in platform fees` : ""}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Margin earned</span>
        <span class="stat-value accent">${fmtMoney(margin)}</span>
        <span class="stat-sub">${fmtNum(marginPct)}% of revenue</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Sunk cost of stock</span>
        <span class="stat-value gold">${fmtMoney(sunk)}</span>
        <span class="stat-sub">tied up in ${activeBooks().reduce((s, b) => s + Math.max(0, b.stock), 0)} unsold copies</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Sell rate</span>
        <span class="stat-value">${fmtNum(velocity, 2)}<span style="font-size:.9rem;font-weight:600;color:var(--ink-muted)"> /day</span></span>
        <span class="stat-sub">over ${days} day${days === 1 ? "" : "s"}</span>
      </div>
    `;

    document.getElementById("velocity-hint").textContent =
      periodSales.length ? `${units} units · ${fmtMoney(revenue)} revenue` : "no sales in range";

    renderTrendChart(start, end);
    renderLocationChart(periodSales);
    renderMixChart(periodSales);
    renderTopSellers(periodSales);
    renderReorderWatch();
    renderPromoWatch();
  }

  function renderTrendChart(start, end) {
    const wrap = document.getElementById("trend-chart");
    let buckets = [];

    if (trendGranularity === "day") {
      const dayCount = Math.min(60, Math.max(7, Math.round((end - start) / 86400000) + 1));
      for (let i = dayCount - 1; i >= 0; i--) {
        const d = new Date(end);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const revenue = sales.filter((s) => s.date === key).reduce((sum, s) => sum + saleRevenue(s), 0);
        buckets.push({ key, revenue, label: `${d.getMonth() + 1}/${d.getDate()}` });
      }
    } else if (trendGranularity === "month") {
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const revenue = sales.filter((s) => s.date.slice(0, 7) === key).reduce((sum, s) => sum + saleRevenue(s), 0);
        buckets.push({ key, revenue, label: d.toLocaleDateString("en-US", { month: "short" }) });
      }
    } else {
      const years = [...new Set(sales.map((s) => s.date.slice(0, 4)))].sort();
      const currentYear = String(new Date().getFullYear());
      if (!years.includes(currentYear)) years.push(currentYear);
      buckets = years.map((y) => ({
        key: y, label: y,
        revenue: sales.filter((s) => s.date.slice(0, 4) === y).reduce((sum, s) => sum + saleRevenue(s), 0),
      }));
    }

    const max = Math.max(1, ...buckets.map((b) => b.revenue));
    const w = Math.max(360, buckets.length * (trendGranularity === "day" ? 16 : 56));
    const h = 130;
    const barW = (w / buckets.length) * (trendGranularity === "day" ? 0.62 : 0.5);
    const showLabel = trendGranularity !== "day" || buckets.length <= 31;
    const bars = buckets.map((b, i) => {
      const cellW = w / buckets.length;
      const x = cellW * i + (cellW - barW) / 2;
      const bh = (b.revenue / max) * (h - 34);
      const y = h - bh - 28;
      const color = b.revenue > 0 ? "var(--accent)" : "var(--border)";
      const label = trendGranularity === "day" ? "" : `<text x="${(x + barW / 2).toFixed(1)}" y="${h - 10}" text-anchor="middle" font-size="11" fill="var(--ink-muted)">${b.label}</text>`;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, bh).toFixed(1)}" rx="3" fill="${color}"><title>${b.key}: ${fmtMoney(b.revenue)}</title></rect>${label}`;
    }).join("");
    wrap.innerHTML = buckets.every((b) => b.revenue === 0)
      ? `<p class="empty-row">No sales recorded in this window yet.</p>`
      : `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="min-width:${w}px">${bars}<line x1="0" y1="${h - 28}" x2="${w}" y2="${h - 28}" stroke="var(--border)" stroke-width="1"/></svg>`;
  }

  function renderMixChart(periodSales) {
    const wrap = document.getElementById("mix-chart");
    const retail = periodSales.filter((s) => s.saleType !== "wholesale").reduce((s, x) => s + saleRevenue(x), 0);
    const wholesale = periodSales.filter((s) => s.saleType === "wholesale").reduce((s, x) => s + saleRevenue(x), 0);
    if (retail === 0 && wholesale === 0) {
      wrap.innerHTML = `<p class="empty-row">No sales recorded in this window yet.</p>`;
      return;
    }
    const max = Math.max(retail, wholesale, 1);
    wrap.innerHTML = `<div class="bar-chart">
      <div class="bar-row"><span class="label">Retail</span><span class="bar-track"><span class="bar-fill" style="width:${clamp((retail / max) * 100, retail > 0 ? 4 : 0, 100)}%"></span></span><span class="amount">${fmtMoney(retail)}</span></div>
      <div class="bar-row"><span class="label">Wholesale</span><span class="bar-track"><span class="bar-fill" style="width:${clamp((wholesale / max) * 100, wholesale > 0 ? 4 : 0, 100)}%; background:var(--gold)"></span></span><span class="amount">${fmtMoney(wholesale)}</span></div>
    </div>`;
  }

  function renderPromoWatch() {
    const wrap = document.getElementById("promo-watch");
    const candidates = activeBooks()
      .map((b) => ({ b, v: velocityFor(b.id, 60) }))
      .filter((r) => r.b.stock >= Math.max(3, settings.lowStockThreshold + 1) && r.v < 0.05)
      .map((r) => ({ ...r, tiedUp: r.b.stock * r.b.cost }))
      .sort((a, b) => b.tiedUp - a.tiedUp)
      .slice(0, 6);

    wrap.innerHTML = candidates.length ? candidates.map(({ b, v, tiedUp }) => `
      <div class="mini-row">
        <div>
          <div class="name">${escapeHtml(b.title)}</div>
          <div class="meta">${b.stock} in stock · ${v > 0 ? fmtNum(v, 2) + "/day" : "0 sold in 60 days"} — try a bundle or discount</div>
        </div>
        <div class="val">${fmtMoney(tiedUp)}</div>
      </div>`).join("")
      : `<p class="empty-row">No obvious slow movers right now — inventory is turning over.</p>`;
  }

  function renderLocationChart(periodSales) {
    const wrap = document.getElementById("location-chart");
    const byLoc = {};
    periodSales.forEach((s) => {
      byLoc[s.location] = (byLoc[s.location] || 0) + saleRevenue(s);
    });
    const entries = Object.entries(byLoc).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      wrap.innerHTML = `<p class="empty-row">No sales recorded in this window yet.</p>`;
      return;
    }
    const max = entries[0][1];
    wrap.innerHTML = `<div class="bar-chart">${entries.map(([loc, rev]) => `
      <div class="bar-row">
        <span class="label">${escapeHtml(loc)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${clamp((rev / max) * 100, 4, 100)}%"></span></span>
        <span class="amount">${fmtMoney(rev)}</span>
      </div>`).join("")}</div>`;
  }

  function renderTopSellers(periodSales) {
    const wrap = document.getElementById("top-sellers");
    const byBook = {};
    periodSales.forEach((s) => {
      if (!byBook[s.bookId]) byBook[s.bookId] = { units: 0, revenue: 0, title: s.bookTitle };
      byBook[s.bookId].units += s.qty;
      byBook[s.bookId].revenue += saleRevenue(s);
    });
    const entries = Object.values(byBook).sort((a, b) => b.units - a.units).slice(0, 6);
    wrap.innerHTML = entries.length
      ? entries.map((e) => `
        <div class="mini-row">
          <div><div class="name">${escapeHtml(e.title)}</div><div class="meta">${e.units} sold</div></div>
          <div class="val">${fmtMoney(e.revenue)}</div>
        </div>`).join("")
      : `<p class="empty-row">Nothing sold yet in this window.</p>`;
  }

  function renderReorderWatch() {
    const wrap = document.getElementById("reorder-watch");
    const threshold = settings.lowStockThreshold;
    const rows = activeBooks().map((b) => {
      const v = velocityFor(b.id, 30);
      const daysLeft = v > 0 ? b.stock / v : Infinity;
      return { b, v, daysLeft };
    }).filter((r) => r.b.stock <= threshold || r.daysLeft <= 14)
      .sort((a, b) => a.daysLeft - b.daysLeft);

    wrap.innerHTML = rows.length ? rows.slice(0, 8).map(({ b, v, daysLeft }) => {
      const badge = b.stock <= 0 ? `<span class="badge badge-critical">OUT</span>`
        : b.stock <= threshold ? `<span class="badge badge-warn">LOW</span>`
        : `<span class="badge badge-warn">${Math.round(daysLeft)}d left</span>`;
      return `<div class="mini-row">
        <div><div class="name">${escapeHtml(b.title)}</div><div class="meta">${b.stock} in stock · ${fmtNum(v, 2)}/day</div></div>
        <div class="val">${badge}</div>
      </div>`;
    }).join("") : `<p class="empty-row">Nothing urgent — stock looks healthy.</p>`;
  }

  /* ============================================================
     INVENTORY
  ============================================================ */
  let inventoryQuery = "";
  document.getElementById("inventory-search").addEventListener("input", (e) => {
    inventoryQuery = e.target.value.trim().toLowerCase();
    renderInventory();
  });

  function renderInventory() {
    const tbody = document.getElementById("inventory-tbody");
    const rows = activeBooks()
      .filter((b) => !inventoryQuery || b.title.toLowerCase().includes(inventoryQuery) || b.author.toLowerCase().includes(inventoryQuery))
      .sort((a, b) => a.title.localeCompare(b.title));

    document.getElementById("inventory-empty").hidden = books.length !== 0;

    tbody.innerHTML = rows.map((b) => {
      const v = velocityFor(b.id, 30);
      const marginUnit = b.price - b.cost;
      const stockClass = b.stock <= 0 ? "out" : b.stock <= settings.lowStockThreshold ? "low" : "";
      const velocityText = v > 0 ? `${fmtNum(v, 2)}/day · ${Math.round(b.stock / v)}d left` : "no recent sales";
      return `<tr data-id="${b.id}">
        <td class="title-cell">${escapeHtml(b.title)}</td>
        <td class="author-cell">${escapeHtml(b.author)}</td>
        <td class="num"><span class="editable-cell" data-field="price" data-id="${b.id}">${fmtMoney(b.price)}</span></td>
        <td class="num"><span class="editable-cell" data-field="wholesalePrice" data-id="${b.id}">${fmtMoney(b.wholesalePrice || 0)}</span></td>
        <td class="num"><span class="editable-cell" data-field="cost" data-id="${b.id}">${fmtMoney(b.cost)}</span></td>
        <td class="num"><span class="editable-cell stock-pill ${stockClass}" data-field="stock" data-id="${b.id}"><span class="stock-dot"></span>${b.stock}</span></td>
        <td class="num">${fmtMoney(marginUnit)}</td>
        <td><span class="velocity-text">${velocityText}</span></td>
        <td><button class="row-btn" data-action="edit-book" data-id="${b.id}">Edit</button></td>
      </tr>`;
    }).join("");
  }

  document.getElementById("inventory-tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='edit-book']");
    if (btn) { openBookModal(btn.dataset.id); return; }
    const cell = e.target.closest(".editable-cell");
    if (cell) startCellEdit(cell);
  });

  function startCellEdit(cell) {
    if (cell.querySelector("input")) return; // already editing
    const id = cell.dataset.id;
    const field = cell.dataset.field;
    const book = bookById(id);
    if (!book) return;
    const currentValue = book[field] || 0;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = field === "stock" ? "1" : "1";
    input.className = "cell-edit-input";
    input.value = currentValue;
    const originalContent = cell.innerHTML;

    function commit() {
      const raw = input.value;
      const num = Number(raw);
      if (raw === "" || Number.isNaN(num) || num < 0) {
        cell.innerHTML = originalContent;
        return;
      }
      book[field] = field === "stock" ? Math.round(num) : num;
      persistBooks();
      renderInventory();
      renderSellForm();
      showToast("Updated");
    }
    function cancel() {
      cell.innerHTML = originalContent;
    }
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      if (ev.key === "Escape") { ev.preventDefault(); input.removeEventListener("blur", onBlur); cancel(); }
    });
    function onBlur() { commit(); }
    input.addEventListener("blur", onBlur);

    cell.innerHTML = "";
    cell.appendChild(input);
    input.focus();
    input.select();
  }

  /* --- book modal --- */
  const bookModal = document.getElementById("book-modal-backdrop");
  const bookForm = document.getElementById("book-form");
  function openBookModal(id) {
    const isEdit = !!id;
    document.getElementById("book-modal-title").textContent = isEdit ? "Edit book" : "Add book";
    document.getElementById("book-archive-btn").hidden = !isEdit;
    if (isEdit) {
      const b = bookById(id);
      document.getElementById("book-id").value = b.id;
      document.getElementById("book-title").value = b.title;
      document.getElementById("book-author").value = b.author;
      document.getElementById("book-price").value = b.price;
      document.getElementById("book-wholesale").value = b.wholesalePrice || "";
      document.getElementById("book-cost").value = b.cost;
      document.getElementById("book-stock").value = b.stock;
    } else {
      bookForm.reset();
      document.getElementById("book-id").value = "";
      document.getElementById("book-stock").value = 0;
    }
    bookModal.hidden = false;
  }
  function closeBookModal() { bookModal.hidden = true; }
  document.getElementById("btn-add-book").addEventListener("click", () => openBookModal(null));
  document.getElementById("book-modal-close").addEventListener("click", closeBookModal);
  document.getElementById("book-modal-cancel").addEventListener("click", closeBookModal);
  bookModal.addEventListener("click", (e) => { if (e.target === bookModal) closeBookModal(); });

  bookForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("book-id").value;
    const payload = {
      title: document.getElementById("book-title").value.trim(),
      author: document.getElementById("book-author").value.trim(),
      price: Number(document.getElementById("book-price").value) || 0,
      wholesalePrice: Number(document.getElementById("book-wholesale").value) || 0,
      cost: Number(document.getElementById("book-cost").value) || 0,
      stock: Number(document.getElementById("book-stock").value) || 0,
    };
    if (id) {
      Object.assign(bookById(id), payload);
      showToast("Book updated");
    } else {
      books.push({ id: uid(), archived: false, createdAt: Date.now(), ...payload });
      showToast("Book added to inventory");
    }
    persistBooks();
    closeBookModal();
    renderInventory();
    renderSellForm();
  });

  document.getElementById("book-archive-btn").addEventListener("click", () => {
    const id = document.getElementById("book-id").value;
    const b = bookById(id);
    if (!b) return;
    const hasSales = sales.some((s) => s.bookId === id);
    if (!confirm(`Archive "${b.title}"? It will disappear from Inventory and Record Sale, but sales history is kept.${hasSales ? "" : " (No sales history — you could also just delete it manually later.)"}`)) return;
    b.archived = true;
    persistBooks();
    closeBookModal();
    renderInventory();
    renderSellForm();
    showToast("Book archived");
  });

  /* ============================================================
     RECORD SALE
  ============================================================ */
  const lineForm = document.getElementById("line-form");
  let currentSaleType = "retail";
  let pendingOrder = [];

  document.getElementById("sale-type-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-btn");
    if (!btn) return;
    currentSaleType = btn.dataset.type;
    document.getElementById("sale-type-toggle").querySelectorAll(".segmented-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    document.getElementById("sell-price").removeAttribute("data-touched");
    updateLinePreview();
  });

  function renderSellForm() {
    const datalist = document.getElementById("book-options");
    datalist.innerHTML = activeBooks().sort((a, b) => a.title.localeCompare(b.title))
      .map((b) => `<option value="${escapeHtml(b.title)}" data-id="${b.id}">${escapeHtml(b.author)} · stock ${b.stock}</option>`).join("");
    refreshLocationOptions();
    document.getElementById("order-date").value = todayISO();
    updateLinePreview();
    renderOrderCart();
  }

  function findBookByTitleInput(val) {
    const v = val.trim().toLowerCase();
    return activeBooks().find((b) => b.title.toLowerCase() === v);
  }

  function updateLinePreview() {
    const titleVal = document.getElementById("sell-book").value;
    const book = findBookByTitleInput(titleVal);
    const note = document.getElementById("sell-book-note");
    const locNote = document.getElementById("order-location-note");
    const loc = locationByName(document.getElementById("order-location").value);
    locNote.textContent = loc && loc.commissionPct > 0 ? (loc.name + " takes " + fmtNum(loc.commissionPct) + "% commission") : " ";

    if (!book) {
      note.textContent = titleVal ? "No matching book — pick one from the list." : " ";
      return;
    }
    const alreadyIn = pendingOrder.filter((l) => l.bookId === book.id).reduce((s, l) => s + l.qty, 0);
    const remaining = book.stock - alreadyIn;
    note.textContent = `by ${book.author} · ${remaining} left after items already in this order`;
    const priceInput = document.getElementById("sell-price");
    if (!priceInput.dataset.touched) {
      priceInput.value = currentSaleType === "wholesale" ? (book.wholesalePrice || book.price) : book.price;
    }
  }

  document.getElementById("sell-book").addEventListener("input", () => {
    document.getElementById("sell-price").removeAttribute("data-touched");
    updateLinePreview();
  });
  document.getElementById("sell-price").addEventListener("input", (e) => {
    e.target.dataset.touched = "1";
  });
  document.getElementById("order-location").addEventListener("input", updateLinePreview);
  lineForm.querySelectorAll(".stepper-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById("sell-qty");
      input.value = Math.max(1, (Number(input.value) || 1) + Number(btn.dataset.step));
    });
  });

  lineForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const book = findBookByTitleInput(document.getElementById("sell-book").value);
    if (!book) { showToast("Pick a valid book from the list"); return; }
    const qty = Number(document.getElementById("sell-qty").value);
    const unitPrice = Number(document.getElementById("sell-price").value);
    if (!qty || qty < 1) { showToast("Quantity must be at least 1"); return; }

    pendingOrder.push({
      lineId: uid(), bookId: book.id, bookTitle: book.title,
      saleType: currentSaleType, qty, unitPrice, unitCost: book.cost,
    });

    document.getElementById("sell-book").value = "";
    document.getElementById("sell-qty").value = "1";
    document.getElementById("sell-price").value = "";
    document.getElementById("sell-price").removeAttribute("data-touched");
    document.getElementById("sell-book-note").textContent = " ";
    document.getElementById("sell-book").focus();
    renderOrderCart();
  });

  function renderOrderCart() {
    const list = document.getElementById("order-cart-list");
    document.getElementById("order-cart-empty").hidden = pendingOrder.length !== 0;

    list.innerHTML = pendingOrder.map((l) => `
      <div class="order-cart-item">
        <span class="oc-title">${escapeHtml(l.bookTitle)}</span>
        <span class="oc-meta">${l.saleType === "wholesale" ? "Wholesale" : "Retail"} · ${l.qty} × ${fmtMoney(l.unitPrice)}</span>
        <span class="oc-amount">${fmtMoney(l.qty * l.unitPrice)}</span>
        <button type="button" class="oc-remove" data-line-id="${l.lineId}" aria-label="Remove">
          <svg viewBox="0 0 24 24" width="13" height="13"><line x1="5" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><line x1="19" y1="5" x2="5" y2="19" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
        </button>
      </div>`).join("");

    const loc = locationByName(document.getElementById("order-location").value);
    const commissionPct = loc ? loc.commissionPct : 0;
    const revenue = pendingOrder.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const commission = revenue * (commissionPct / 100);
    const cost = pendingOrder.reduce((s, l) => s + l.qty * l.unitCost, 0);
    const margin = revenue - commission - cost;

    document.getElementById("order-sum-revenue").textContent = fmtMoney(revenue);
    document.getElementById("order-sum-commission").textContent = fmtMoney(commission);
    document.getElementById("order-sum-cost").textContent = fmtMoney(cost);
    document.getElementById("order-sum-margin").textContent = fmtMoneySigned(margin);
  }

  document.getElementById("order-cart-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".oc-remove");
    if (!btn) return;
    pendingOrder = pendingOrder.filter((l) => l.lineId !== btn.dataset.lineId);
    renderOrderCart();
    updateLinePreview();
  });
  document.getElementById("order-location").addEventListener("input", renderOrderCart);

  document.getElementById("btn-complete-order").addEventListener("click", () => {
    if (pendingOrder.length === 0) { showToast("Add at least one book to the order"); return; }
    const date = document.getElementById("order-date").value || todayISO();
    const locationName = document.getElementById("order-location").value.trim();
    if (!locationName) { showToast("Add where this order happened"); return; }
    const customer = document.getElementById("order-customer").value.trim();
    const note = document.getElementById("order-note").value.trim();
    const loc = ensureLocation(locationName);
    const orderId = uid();

    pendingOrder.forEach((l) => {
      const book = bookById(l.bookId);
      sales.push({
        id: uid(), orderId, bookId: l.bookId, bookTitle: l.bookTitle,
        saleType: l.saleType, qty: l.qty, unitPrice: l.unitPrice, unitCost: l.unitCost,
        commissionPct: loc.commissionPct,
        date, location: loc.name, customer, note, createdAt: Date.now(),
      });
      if (book) book.stock -= l.qty;
    });
    persistSales();
    persistBooks();

    const itemCount = pendingOrder.reduce((s, l) => s + l.qty, 0);
    const total = pendingOrder.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    showToast(`Order recorded — ${itemCount} item${itemCount === 1 ? "" : "s"}, ${fmtMoney(total)}`);

    pendingOrder = [];
    document.getElementById("order-customer").value = "";
    document.getElementById("order-note").value = "";
    currentSaleType = "retail";
    document.getElementById("sale-type-toggle").querySelectorAll(".segmented-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.type === "retail"));
    renderSellForm();
    renderInventory();
  });

  /* ============================================================
     SALES LOG
  ============================================================ */
  let salesQuery = "";
  let salesSortKey = "date";
  let salesSortDir = "desc";
  const SALES_TEXT_COLS = new Set(["customer", "bookTitle", "saleType", "location"]);

  document.getElementById("sales-search").addEventListener("input", (e) => {
    salesQuery = e.target.value.trim().toLowerCase();
    renderSalesLog();
  });
  document.getElementById("sales-filter-type").addEventListener("change", renderSalesLog);
  document.getElementById("sales-filter-location").addEventListener("change", renderSalesLog);
  document.getElementById("sales-filter-from").addEventListener("change", renderSalesLog);
  document.getElementById("sales-filter-to").addEventListener("change", renderSalesLog);
  document.getElementById("btn-sales-clear-filters").addEventListener("click", () => {
    salesQuery = "";
    document.getElementById("sales-search").value = "";
    document.getElementById("sales-filter-type").value = "";
    document.getElementById("sales-filter-location").value = "";
    document.getElementById("sales-filter-from").value = "";
    document.getElementById("sales-filter-to").value = "";
    renderSalesLog();
  });
  document.querySelector("#sales-table thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const key = th.dataset.sort;
    if (salesSortKey === key) {
      salesSortDir = salesSortDir === "asc" ? "desc" : "asc";
    } else {
      salesSortKey = key;
      salesSortDir = SALES_TEXT_COLS.has(key) ? "asc" : "desc";
    }
    renderSalesLog();
  });

  function orderNumberMap() {
    const firstSeen = new Map();
    sales.forEach((s) => {
      const key = s.date + String(s.createdAt).padStart(14, "0");
      if (!firstSeen.has(s.orderId) || key < firstSeen.get(s.orderId)) firstSeen.set(s.orderId, key);
    });
    const orderedIds = [...firstSeen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id]) => id);
    const map = new Map();
    orderedIds.forEach((id, i) => map.set(id, i + 1));
    return map;
  }

  function renderSalesLog() {
    const tbody = document.getElementById("sales-tbody");
    document.getElementById("sales-empty").hidden = sales.length !== 0;

    const locSelect = document.getElementById("sales-filter-location");
    if (locSelect.dataset.optionsFor !== String(locations.length)) {
      locSelect.innerHTML = `<option value="">All locations</option>` +
        locations.map((l) => `<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)}</option>`).join("");
      locSelect.dataset.optionsFor = String(locations.length);
    }

    const typeFilter = document.getElementById("sales-filter-type").value;
    const locFilter = document.getElementById("sales-filter-location").value;
    const fromFilter = document.getElementById("sales-filter-from").value;
    const toFilter = document.getElementById("sales-filter-to").value;
    const orderNums = orderNumberMap();

    let rows = sales
      .filter((s) => !salesQuery || [s.bookTitle, s.location, s.note, s.customer].join(" ").toLowerCase().includes(salesQuery))
      .filter((s) => !typeFilter || (s.saleType || "retail") === typeFilter)
      .filter((s) => !locFilter || s.location === locFilter)
      .filter((s) => !fromFilter || s.date >= fromFilter)
      .filter((s) => !toFilter || s.date <= toFilter)
      .map((s) => ({
        s, orderNum: orderNums.get(s.orderId) || 0,
        revenue: saleRevenue(s), fee: saleCommission(s), margin: saleMargin(s),
      }));

    rows.sort((a, b) => {
      let av, bv;
      switch (salesSortKey) {
        case "orderNum": av = a.orderNum; bv = b.orderNum; break;
        case "date": av = a.s.date + a.s.createdAt; bv = b.s.date + b.s.createdAt; break;
        case "customer": av = (a.s.customer || "").toLowerCase(); bv = (b.s.customer || "").toLowerCase(); break;
        case "bookTitle": av = a.s.bookTitle.toLowerCase(); bv = b.s.bookTitle.toLowerCase(); break;
        case "saleType": av = a.s.saleType || "retail"; bv = b.s.saleType || "retail"; break;
        case "qty": av = a.s.qty; bv = b.s.qty; break;
        case "unitPrice": av = a.s.unitPrice; bv = b.s.unitPrice; break;
        case "revenue": av = a.revenue; bv = b.revenue; break;
        case "fee": av = a.fee; bv = b.fee; break;
        case "margin": av = a.margin; bv = b.margin; break;
        case "location": av = a.s.location.toLowerCase(); bv = b.s.location.toLowerCase(); break;
        default: av = a.s.date; bv = b.s.date;
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return salesSortDir === "asc" ? cmp : -cmp;
    });

    document.querySelectorAll("#sales-table th[data-sort]").forEach((th) => {
      const active = th.dataset.sort === salesSortKey;
      th.classList.toggle("is-sorted", active);
      th.innerHTML = th.textContent.replace(/\s*[▲▼]?\s*$/, "") +
        (active ? `<span class="sort-arrow">${salesSortDir === "asc" ? "▲" : "▼"}</span>` : "");
    });

    const totalRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);
    const totalMargin = rows.reduce((sum, r) => sum + r.margin, 0);
    document.getElementById("sales-log-summary").innerHTML = sales.length
      ? `<span><strong>${rows.length}</strong> row${rows.length === 1 ? "" : "s"}</span><span><strong>${fmtMoney(totalRevenue)}</strong> revenue</span><span><strong>${fmtMoneySigned(totalMargin)}</strong> margin</span>`
      : "";

    tbody.innerHTML = rows.map(({ s, orderNum, revenue, fee, margin }) => `
      <tr data-id="${s.id}">
        <td><span class="order-num-badge">#${orderNum}</span></td>
        <td>${s.date}</td>
        <td>${escapeHtml(s.customer || "Walk-in")}</td>
        <td class="title-cell">${escapeHtml(s.bookTitle)}</td>
        <td><span class="badge ${s.saleType === "wholesale" ? "badge-warn" : "badge-good"}">${s.saleType === "wholesale" ? "Wholesale" : "Retail"}</span></td>
        <td class="num">${s.qty}</td>
        <td class="num">${fmtMoney(s.unitPrice)}</td>
        <td class="num">${fmtMoney(revenue)}</td>
        <td class="num">${s.commissionPct ? fmtMoney(fee) : "—"}</td>
        <td class="num">${fmtMoneySigned(margin)}</td>
        <td>${escapeHtml(s.location)}</td>
        <td>${escapeHtml(s.note || "")}</td>
        <td><button class="row-btn" data-action="edit-sale" data-id="${s.id}">Edit</button></td>
      </tr>`).join("");
  }

  document.getElementById("sales-tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action='edit-sale']");
    if (btn) openSaleModal(btn.dataset.id);
  });

  /* --- sale edit modal --- */
  const saleModal = document.getElementById("sale-modal-backdrop");
  const saleForm = document.getElementById("sale-form");
  let editSaleType = "retail";
  document.getElementById("sale-edit-type-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-btn");
    if (!btn) return;
    editSaleType = btn.dataset.type;
    document.getElementById("sale-edit-type-toggle").querySelectorAll(".segmented-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
  });

  function openSaleModal(id) {
    const s = sales.find((x) => x.id === id);
    if (!s) return;
    document.getElementById("sale-id").value = s.id;
    document.getElementById("sale-edit-book-label").textContent = s.bookTitle;
    editSaleType = s.saleType || "retail";
    document.getElementById("sale-edit-type-toggle").querySelectorAll(".segmented-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.type === editSaleType));
    document.getElementById("sale-edit-qty").value = s.qty;
    document.getElementById("sale-edit-price").value = s.unitPrice;
    document.getElementById("sale-edit-date").value = s.date;
    document.getElementById("sale-edit-location").value = s.location;
    document.getElementById("sale-edit-customer").value = s.customer || "";
    document.getElementById("sale-edit-note").value = s.note || "";
    saleModal.hidden = false;
  }
  function closeSaleModal() { saleModal.hidden = true; }
  document.getElementById("sale-modal-close").addEventListener("click", closeSaleModal);
  document.getElementById("sale-modal-cancel").addEventListener("click", closeSaleModal);
  saleModal.addEventListener("click", (e) => { if (e.target === saleModal) closeSaleModal(); });

  saleForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("sale-id").value;
    const s = sales.find((x) => x.id === id);
    if (!s) return;
    const book = bookById(s.bookId);
    const newQty = Number(document.getElementById("sale-edit-qty").value);
    const newLocationName = document.getElementById("sale-edit-location").value.trim();
    const loc = ensureLocation(newLocationName);

    if (book) book.stock += s.qty; // reverse old qty
    s.qty = newQty;
    s.saleType = editSaleType;
    s.unitPrice = Number(document.getElementById("sale-edit-price").value);
    s.date = document.getElementById("sale-edit-date").value;
    s.location = loc ? loc.name : newLocationName;
    s.commissionPct = loc ? loc.commissionPct : 0;
    s.customer = document.getElementById("sale-edit-customer").value.trim();
    s.note = document.getElementById("sale-edit-note").value.trim();
    if (book) book.stock -= newQty; // reapply new qty

    persistSales();
    persistBooks();
    closeSaleModal();
    renderSalesLog();
    renderInventory();
    showToast("Sale updated");
  });

  document.getElementById("sale-delete-btn").addEventListener("click", () => {
    const id = document.getElementById("sale-id").value;
    const s = sales.find((x) => x.id === id);
    if (!s) return;
    if (!confirm(`Delete this sale of "${s.bookTitle}"? Stock will be restored.`)) return;
    const book = bookById(s.bookId);
    if (book) { book.stock += s.qty; persistBooks(); }
    sales = sales.filter((x) => x.id !== id);
    persistSales();
    closeSaleModal();
    renderSalesLog();
    renderInventory();
    showToast("Sale deleted, stock restored");
  });

  /* ============================================================
     SETTINGS
  ============================================================ */
  function refreshLocationOptions() {
    document.getElementById("location-options").innerHTML =
      locations.map((l) => `<option value="${escapeHtml(l.name)}"></option>`).join("");
  }

  function renderSettings() {
    const tbody = document.getElementById("platform-tbody");
    tbody.innerHTML = locations.map((loc) => `
      <tr data-loc-id="${loc.id}">
        <td class="title-cell">${escapeHtml(loc.name)}</td>
        <td class="num">
          <span class="editable-cell commission-pill" data-loc-id="${loc.id}">${fmtNum(loc.commissionPct)}%</span>
        </td>
        <td>
          <button class="icon-btn" data-action="remove-loc" data-loc-id="${loc.id}" aria-label="Remove ${escapeHtml(loc.name)}">
            <svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m4 0-.8 12.3a2 2 0 0 1-2 1.7H7.8a2 2 0 0 1-2-1.7L5 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </td>
      </tr>`).join("");
    document.getElementById("low-stock-threshold").value = settings.lowStockThreshold;
    refreshLocationOptions();
    renderFolderStatus();
  }

  document.getElementById("platform-tbody").addEventListener("click", (e) => {
    const removeBtn = e.target.closest("[data-action='remove-loc']");
    if (removeBtn) {
      const loc = locations.find((l) => l.id === removeBtn.dataset.locId);
      if (!loc) return;
      const inUse = sales.some((s) => s.location === loc.name);
      if (inUse && !confirm(`"${loc.name}" appears in past sales. Remove it from the platform list anyway? (History is unaffected.)`)) return;
      locations = locations.filter((l) => l.id !== loc.id);
      persistLocations();
      renderSettings();
      return;
    }
    const cell = e.target.closest(".editable-cell");
    if (cell) startCommissionEdit(cell);
  });

  function startCommissionEdit(cell) {
    if (cell.querySelector("input")) return;
    const loc = locations.find((l) => l.id === cell.dataset.locId);
    if (!loc) return;
    const originalContent = cell.innerHTML;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "100";
    input.step = "0.1";
    input.className = "cell-edit-input";
    input.value = loc.commissionPct;

    function commit() {
      const num = Number(input.value);
      if (input.value === "" || Number.isNaN(num) || num < 0) { cell.innerHTML = originalContent; return; }
      loc.commissionPct = Math.min(100, num);
      persistLocations();
      renderSettings();
      showToast("Commission updated");
    }
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      if (ev.key === "Escape") { ev.preventDefault(); input.removeEventListener("blur", onBlur); cell.innerHTML = originalContent; }
    });
    function onBlur() { commit(); }
    input.addEventListener("blur", onBlur);

    cell.innerHTML = "";
    cell.appendChild(input);
    input.focus();
    input.select();
  }

  document.getElementById("location-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const nameInput = document.getElementById("new-location");
    const commInput = document.getElementById("new-location-commission");
    const name = nameInput.value.trim();
    if (!name) return;
    if (!locationByName(name)) {
      locations.push({ id: uid(), name, commissionPct: Math.max(0, Number(commInput.value) || 0) });
      persistLocations();
      renderSettings();
    }
    nameInput.value = "";
    commInput.value = "";
  });

  document.getElementById("low-stock-threshold").addEventListener("change", (e) => {
    settings.lowStockThreshold = Math.max(0, Number(e.target.value) || 0);
    persistSettings();
    showToast("Threshold saved");
  });

  /* --- backup / export / import / reset --- */
  function downloadBlob(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* --- bulk import: books --- */
  document.getElementById("btn-template-books").addEventListener("click", () => {
    const csv = [
      ["Title", "Author", "Price", "Wholesale Price", "Cost", "Stock"],
      ["Sapiens", "Yuval Noah Harari", "450", "320", "260", "12"],
    ].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    downloadBlob("kasembannakij-books-template.csv", csv, "text/csv");
  });

  document.getElementById("import-books-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const resultEl = document.getElementById("import-books-result");
      try {
        const objs = csvRowsToObjects(parseCSV(reader.result));
        let added = 0, updated = 0;
        const errors = [];
        objs.forEach((row, i) => {
          const title = pick(row, "title");
          if (!title) { errors.push(`Row ${i + 2}: missing Title, skipped`); return; }
          const price = Number(pick(row, "price", "retail price")) || 0;
          const wholesalePrice = Number(pick(row, "wholesale price", "wholesale")) || 0;
          const cost = Number(pick(row, "cost", "cost per unit")) || 0;
          const stockVal = pick(row, "stock", "current stock");
          const author = pick(row, "author");
          const existing = books.find((b) => b.title.toLowerCase() === title.toLowerCase());
          if (existing) {
            existing.author = author || existing.author;
            existing.price = price || existing.price;
            existing.wholesalePrice = wholesalePrice || existing.wholesalePrice;
            existing.cost = cost || existing.cost;
            if (stockVal !== "") existing.stock = Number(stockVal) || 0;
            updated++;
          } else {
            books.push({
              id: uid(), title, author, price, wholesalePrice, cost,
              stock: stockVal !== "" ? Number(stockVal) || 0 : 0,
              archived: false, createdAt: Date.now(),
            });
            added++;
          }
        });
        persistBooks();
        renderInventory();
        renderSellForm();
        resultEl.innerHTML = `<div class="ir-ok">${added} added, ${updated} updated.</div>` +
          (errors.length ? `<ul class="ir-errors">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : "");
        showToast(`Imported ${added + updated} book${added + updated === 1 ? "" : "s"}`);
      } catch (err) {
        resultEl.innerHTML = `<div class="ir-errors">Could not read that file as CSV.</div>`;
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  /* --- bulk import: sales --- */
  document.getElementById("btn-template-sales").addEventListener("click", () => {
    const csv = [
      ["Order ID", "Date", "Customer", "Title", "Type", "Qty", "Unit Price", "Location", "Note"],
      ["", "2026-08-17", "Khun Nid", "Sapiens", "Retail", "2", "450", "Storefront", ""],
    ].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    downloadBlob("kasembannakij-sales-template.csv", csv, "text/csv");
  });

  document.getElementById("import-sales-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const deduct = document.getElementById("import-sales-deduct").checked;
    const reader = new FileReader();
    reader.onload = () => {
      const resultEl = document.getElementById("import-sales-result");
      try {
        const objs = csvRowsToObjects(parseCSV(reader.result));
        let imported = 0;
        const errors = [];
        const orderIdMap = {};
        objs.forEach((row, i) => {
          const title = pick(row, "title");
          const date = pick(row, "date") || todayISO();
          const qty = Number(pick(row, "qty", "quantity")) || 0;
          const unitPrice = Number(pick(row, "unit price", "price")) || 0;
          const locationName = pick(row, "location", "where");
          const rawOrderId = pick(row, "order id");
          const saleTypeRaw = pick(row, "type", "sale type").toLowerCase();
          const saleType = saleTypeRaw.startsWith("whole") ? "wholesale" : "retail";
          const customer = pick(row, "customer");
          const note = pick(row, "note");

          if (!title) { errors.push(`Row ${i + 2}: missing Title, skipped`); return; }
          const book = books.find((b) => b.title.toLowerCase() === title.toLowerCase());
          if (!book) { errors.push(`Row ${i + 2}: no book titled "${title}" in Inventory, skipped`); return; }
          if (!qty || qty < 1) { errors.push(`Row ${i + 2}: invalid quantity, skipped`); return; }
          if (!locationName) { errors.push(`Row ${i + 2}: missing Location, skipped`); return; }

          const loc = ensureLocation(locationName);
          let orderId;
          if (rawOrderId) {
            orderId = orderIdMap[rawOrderId] || (orderIdMap[rawOrderId] = uid());
          } else {
            orderId = uid();
          }

          sales.push({
            id: uid(), orderId, bookId: book.id, bookTitle: book.title,
            saleType, qty, unitPrice: unitPrice || book.price, unitCost: book.cost,
            commissionPct: loc.commissionPct,
            date, location: loc.name, customer, note, createdAt: Date.now(),
          });
          if (deduct) book.stock -= qty;
          imported++;
        });
        persistSales();
        if (deduct) persistBooks();
        renderSalesLog();
        renderInventory();
        renderDashboard();
        resultEl.innerHTML = `<div class="ir-ok">${imported} sale${imported === 1 ? "" : "s"} imported${deduct ? ", stock adjusted" : ""}.</div>` +
          (errors.length ? `<ul class="ir-errors">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : "");
        showToast(`Imported ${imported} sale${imported === 1 ? "" : "s"}`);
      } catch (err) {
        resultEl.innerHTML = `<div class="ir-errors">Could not read that file as CSV.</div>`;
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  document.getElementById("btn-export").addEventListener("click", () => {
    const payload = { books, sales, locations, settings, exportedAt: new Date().toISOString() };
    downloadBlob(`kasembannakij-backup-${todayISO()}.json`, JSON.stringify(payload, null, 2), "application/json");
    showToast("Backup downloaded");
  });

  document.getElementById("btn-export-csv").addEventListener("click", () => {
    const header = ["Order ID", "Date", "Customer", "Title", "Type", "Qty", "Unit Price", "Revenue", "Commission %", "Fee", "Cost", "Margin", "Location", "Note"];
    const rows = sales.map((s) => [s.orderId, s.date, s.customer || "", s.bookTitle, s.saleType || "retail", s.qty, s.unitPrice, saleRevenue(s), s.commissionPct || 0, saleCommission(s), saleCost(s), saleMargin(s), s.location, s.note || ""]);
    const csv = [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    downloadBlob(`kasembannakij-sales-${todayISO()}.csv`, csv, "text/csv");
    showToast("Sales CSV downloaded");
  });

  document.getElementById("import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.books) || !Array.isArray(data.sales)) throw new Error("bad shape");
        if (!confirm("Import will replace all current data on this device. Continue?")) return;
        books = data.books; sales = data.sales;
        locations = Array.isArray(data.locations) ? data.locations : locations;
        if (locations.length && typeof locations[0] === "string") {
          locations = locations.map((name) => ({ id: uid(), name, commissionPct: 0 }));
        }
        sales.forEach((s) => {
          if (!s.saleType) s.saleType = "retail";
          if (typeof s.commissionPct !== "number") s.commissionPct = 0;
          if (!s.orderId) s.orderId = s.id;
          if (typeof s.customer !== "string") s.customer = "";
        });
        settings = data.settings || settings;
        persistBooks(); persistSales(); persistLocations(); persistSettings();
        showToast("Backup imported");
        setView("dashboard");
      } catch (err) {
        alert("That file doesn't look like a valid Kasembannakij backup.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  document.getElementById("btn-reset").addEventListener("click", () => {
    if (!confirm("This erases every book and sale on this device. This cannot be undone. Continue?")) return;
    if (!confirm("Really erase everything? Consider exporting a backup first.")) return;
    books = []; sales = []; locations = DEFAULT_LOCATIONS.map((l) => ({ ...l, id: uid() })); settings = { lowStockThreshold: 3 };
    persistBooks(); persistSales(); persistLocations(); persistSettings();
    showToast("All data erased");
    setView("dashboard");
  });

  /* ============================================================
     STORAGE LOCATION — folder sync via File System Access API
     (point it at a folder inside iCloud Drive / Dropbox / etc. —
     the OS syncs the folder, this code only ever touches a local file)
  ============================================================ */
  const FOLDER_FILENAME = "kasembannakij-data.json";
  const FS_SUPPORTED = typeof window.showDirectoryPicker === "function";

  let folderHandle = null;
  let folderConnected = false;
  let folderNeedsReconnect = false;
  let folderLastSyncAt = 0;
  let folderSyncing = false;

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("kbnk-fs", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("handles");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDelete(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function summarizeData(data) {
    const b = (data.books || []).length, s = (data.sales || []).length;
    return `${b} book${b === 1 ? "" : "s"}, ${s} sale${s === 1 ? "" : "s"}`;
  }
  function currentSnapshot() {
    return { books, sales, locations, settings, exportedAt: new Date().toISOString() };
  }

  async function folderReadFile() {
    try {
      const fh = await folderHandle.getFileHandle(FOLDER_FILENAME, { create: false });
      const file = await fh.getFile();
      const text = await file.text();
      return text ? JSON.parse(text) : null;
    } catch (e) {
      return null; // file doesn't exist yet
    }
  }
  async function folderWriteFile(data) {
    const fh = await folderHandle.getFileHandle(FOLDER_FILENAME, { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

  function applyImportedData(data) {
    books = data.books || [];
    sales = data.sales || [];
    locations = Array.isArray(data.locations) ? data.locations : locations;
    if (locations.length && typeof locations[0] === "string") {
      locations = locations.map((name) => ({ id: uid(), name, commissionPct: 0 }));
    }
    sales.forEach((s) => {
      if (!s.saleType) s.saleType = "retail";
      if (typeof s.commissionPct !== "number") s.commissionPct = 0;
      if (!s.orderId) s.orderId = s.id;
      if (typeof s.customer !== "string") s.customer = "";
    });
    settings = data.settings || settings;
    save(LS_BOOKS, books); save(LS_SALES, sales); save(LS_LOCATIONS, locations); save(LS_SETTINGS, settings);
    renderInventory(); renderSellForm(); renderSalesLog(); renderDashboard(); renderSettings();
  }

  const conflictModal = document.getElementById("conflict-modal-backdrop");
  let conflictResolve = null;
  function askConflict(folderData, deviceData) {
    document.getElementById("conflict-folder-summary").textContent = summarizeData(folderData);
    document.getElementById("conflict-device-summary").textContent = summarizeData(deviceData);
    conflictModal.hidden = false;
    return new Promise((resolve) => { conflictResolve = resolve; });
  }
  function closeConflictModal(result) {
    conflictModal.hidden = true;
    if (conflictResolve) { conflictResolve(result); conflictResolve = null; }
  }
  document.getElementById("conflict-use-folder").addEventListener("click", () => closeConflictModal("folder"));
  document.getElementById("conflict-use-device").addEventListener("click", () => closeConflictModal("device"));
  document.getElementById("conflict-cancel").addEventListener("click", () => closeConflictModal("cancel"));

  async function connectFolder() {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (e) {
      return; // user cancelled the picker
    }
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") { showToast("Permission needed to sync this folder"); return; }

    folderHandle = handle;
    const folderData = await folderReadFile();
    const deviceData = currentSnapshot();

    if (folderData && (folderData.books || []).length + (folderData.sales || []).length > 0) {
      const choice = await askConflict(folderData, deviceData);
      if (choice === "cancel") { folderHandle = null; return; }
      if (choice === "folder") applyImportedData(folderData);
      else await folderWriteFile(currentSnapshot());
    } else {
      await folderWriteFile(deviceData);
    }

    await idbSet("dirHandle", handle);
    folderConnected = true;
    folderNeedsReconnect = false;
    folderLastSyncAt = Date.now();
    renderFolderStatus();
    showToast(`Connected to "${handle.name}"`);
  }

  async function syncToFolder() {
    if (!folderConnected || !folderHandle || folderSyncing) return;
    folderSyncing = true;
    try {
      const perm = await folderHandle.queryPermission({ mode: "readwrite" });
      if (perm !== "granted") { folderNeedsReconnect = true; renderFolderStatus(); return; }
      await folderWriteFile(currentSnapshot());
      folderLastSyncAt = Date.now();
      folderNeedsReconnect = false;
    } catch (e) {
      console.error("folder sync failed", e);
    } finally {
      folderSyncing = false;
      renderFolderStatus();
    }
  }

  async function reconnectFolder() {
    if (!folderHandle) return;
    const perm = await folderHandle.requestPermission({ mode: "readwrite" });
    if (perm === "granted") {
      folderNeedsReconnect = false;
      await syncToFolder();
      showToast("Reconnected");
    } else {
      showToast("Permission denied");
    }
    renderFolderStatus();
  }

  async function disconnectFolder() {
    if (!confirm("Disconnect this folder? It keeps its last synced copy, but new changes will stop saving there.")) return;
    folderHandle = null;
    folderConnected = false;
    folderNeedsReconnect = false;
    await idbDelete("dirHandle");
    renderFolderStatus();
    showToast("Disconnected");
  }

  function relativeTime(ts) {
    if (!ts) return "never";
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    return `${Math.round(hours / 24)} day(s) ago`;
  }

  function renderFolderStatus() {
    const note = document.getElementById("folder-status-note");
    const connectBtn = document.getElementById("btn-folder-connect");
    const reconnectBtn = document.getElementById("btn-folder-reconnect");
    const disconnectBtn = document.getElementById("btn-folder-disconnect");

    if (!FS_SUPPORTED) {
      note.textContent = "This browser can't connect a folder (only Chrome or Edge on a Mac/PC support it). Pick a folder inside iCloud Drive from one of those to sync automatically — on this browser, use Local backup below instead.";
      connectBtn.hidden = true; reconnectBtn.hidden = true; disconnectBtn.hidden = true;
      return;
    }
    if (!folderConnected) {
      note.textContent = "Not connected. Pick a folder — ideally inside iCloud Drive — and every change saves there automatically; iCloud syncs it from there.";
      connectBtn.hidden = false; reconnectBtn.hidden = true; disconnectBtn.hidden = true;
      return;
    }
    connectBtn.hidden = true; disconnectBtn.hidden = false;
    if (folderNeedsReconnect) {
      note.textContent = `Connection to "${folderHandle ? folderHandle.name : "your folder"}" needs to be reconfirmed.`;
      reconnectBtn.hidden = false;
    } else {
      note.textContent = `Connected to "${folderHandle ? folderHandle.name : "folder"}" — synced ${relativeTime(folderLastSyncAt)}.`;
      reconnectBtn.hidden = true;
    }
  }

  document.getElementById("btn-folder-connect").addEventListener("click", connectFolder);
  document.getElementById("btn-folder-reconnect").addEventListener("click", reconnectFolder);
  document.getElementById("btn-folder-disconnect").addEventListener("click", disconnectFolder);

  (async function tryRestoreFolderConnection() {
    if (!FS_SUPPORTED) { renderFolderStatus(); return; }
    const handle = await idbGet("dirHandle");
    if (!handle) { renderFolderStatus(); return; }
    folderHandle = handle;
    const perm = await handle.queryPermission({ mode: "readwrite" });
    folderConnected = true;
    folderNeedsReconnect = perm !== "granted";
    renderFolderStatus();
  })();


  /* ---------------- boot ---------------- */
  setView("dashboard");
})();
