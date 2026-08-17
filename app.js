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

  function persistBooks() { save(LS_BOOKS, books); }
  function persistSales() { save(LS_SALES, sales); }
  function persistLocations() { save(LS_LOCATIONS, locations); }
  function persistSettings() { save(LS_SETTINGS, settings); }

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
  document.getElementById("sales-search").addEventListener("input", (e) => {
    salesQuery = e.target.value.trim().toLowerCase();
    renderSalesLog();
  });

  function renderSalesLog() {
    const list = document.getElementById("order-list");
    const filtered = [...sales]
      .filter((s) => !salesQuery || [s.bookTitle, s.location, s.note, s.customer].join(" ").toLowerCase().includes(salesQuery));

    document.getElementById("sales-empty").hidden = sales.length !== 0;

    const orderMap = new Map();
    filtered.forEach((s) => {
      if (!orderMap.has(s.orderId)) orderMap.set(s.orderId, []);
      orderMap.get(s.orderId).push(s);
    });
    const orders = [...orderMap.values()].sort((a, b) => {
      const am = a[0], bm = b[0];
      return (bm.date + bm.createdAt).localeCompare(am.date + am.createdAt);
    });

    list.innerHTML = orders.map((items) => {
      const first = items[0];
      const revenue = items.reduce((s, x) => s + saleRevenue(x), 0);
      const margin = items.reduce((s, x) => s + saleMargin(x), 0);
      const totalQty = items.reduce((s, x) => s + x.qty, 0);
      return `
      <div class="order-card" data-order-id="${first.orderId}">
        <div class="order-card-head">
          <div>
            <div class="order-card-id">${first.customer ? escapeHtml(first.customer) : "Walk-in"}</div>
            <div class="order-card-sub">${first.date} · ${escapeHtml(first.location)} · ${totalQty} item${totalQty === 1 ? "" : "s"}</div>
          </div>
          <div class="order-card-spacer"></div>
          <div class="order-card-totals">
            <strong>${fmtMoney(revenue)}</strong>
            <span>${fmtMoneySigned(margin)} margin</span>
          </div>
          <button class="icon-btn" data-action="delete-order" data-order-id="${first.orderId}" aria-label="Delete order">
            <svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2m4 0-.8 12.3a2 2 0 0 1-2 1.7H7.8a2 2 0 0 1-2-1.7L5 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div class="order-card-items">
          ${items.map((s) => `
            <div class="order-line">
              <span class="ol-title">${escapeHtml(s.bookTitle)} <span class="badge ${s.saleType === "wholesale" ? "badge-warn" : "badge-good"}">${s.saleType === "wholesale" ? "Wholesale" : "Retail"}</span></span>
              <span class="ol-qty">${s.qty} × ${fmtMoney(s.unitPrice)}</span>
              <span class="ol-revenue">${fmtMoney(saleRevenue(s))}</span>
              <span class="ol-fee">${s.commissionPct ? "fee " + fmtMoney(saleCommission(s)) : ""}</span>
              <span class="ol-margin">${fmtMoneySigned(saleMargin(s))}</span>
              <button class="row-btn ol-edit" data-action="edit-sale" data-id="${s.id}">Edit</button>
            </div>`).join("")}
        </div>
        ${first.note ? `<div class="order-card-note">${escapeHtml(first.note)}</div>` : ""}
      </div>`;
    }).join("");
  }

  document.getElementById("order-list").addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-action='edit-sale']");
    if (editBtn) { openSaleModal(editBtn.dataset.id); return; }
    const delBtn = e.target.closest("[data-action='delete-order']");
    if (delBtn) {
      const orderId = delBtn.dataset.orderId;
      const items = sales.filter((s) => s.orderId === orderId);
      if (!confirm(`Delete this whole order (${items.length} item${items.length === 1 ? "" : "s"})? Stock will be restored.`)) return;
      items.forEach((s) => { const book = bookById(s.bookId); if (book) book.stock += s.qty; });
      sales = sales.filter((s) => s.orderId !== orderId);
      persistSales();
      persistBooks();
      renderSalesLog();
      renderInventory();
      showToast("Order deleted, stock restored");
    }
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

  /* ---------------- boot ---------------- */
  setView("dashboard");
})();
