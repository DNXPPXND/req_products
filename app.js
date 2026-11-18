
"use strict";

// ======================================================
// ENGINEERING INVENTORY DASHBOARD
// File: app.js
// ======================================================

const API_URL =
  "https://script.google.com/macros/s/AKfycbxlAHXfVsZRoX8YDbaVMUaoaPbh3WCsAw-tV3Jam98Vd3Qz2g2sRdJUC_wlNLbW_AtodA/exec";
  

const state = {
  inventory: [],
  departments: [],
  requisitions: [],
  surveys: [],
  adminToken: null,
  adminExpiresAt: 0,
  apiVersion: "",
  apiCapabilities: {}
};

let requisitionTrendChart = null;
let categoryOverviewChart = null;
let adminSessionTimer = null;
let inventoryPage = 1;
const INVENTORY_PAGE_SIZE = 30;

const PAGE_TITLES = {
  dashboard: "ภาพรวมระบบ",
  inventory: "คลังวัสดุ",
  requisition: "เบิกวัสดุ",
  survey: "สำรวจวัสดุรายเดือน"
};

const $ = (id) => document.getElementById(id);

// ======================================================
// 1. HELPERS
// ======================================================

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function numberValue(value) {
  if (typeof value === "string") {
    value = value.replace(/,/g, "").trim();
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatNumber(value) {
  return numberValue(value).toLocaleString("th-TH", {
    maximumFractionDigits: 2
  });
}

function formatDate(value) {
  if (!value) return "-";

  // Google Sheets อาจส่งวันที่มาเป็นข้อความหรือ ISO date
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleDateString("th-TH", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok"
  });
}

function showMessage(message, type = "info") {
  const element = $("message");
  const titles = {
    success: "สำเร็จ",
    error: "ดำเนินการไม่สำเร็จ",
    warning: "โปรดตรวจสอบ",
    info: "แจ้งให้ทราบ"
  };
  const title = titles[type] || titles.info;

  if (window.Swal) {
    const isToast = type === "success" || type === "info";
    window.Swal.fire({
      toast: isToast,
      position: isToast ? "top-end" : "center",
      icon: titles[type] ? type : "info",
      title,
      text: message,
      showConfirmButton: !isToast,
      timer: isToast ? 5000 : undefined,
      timerProgressBar: isToast,
      confirmButtonText: "เข้าใจแล้ว",
      buttonsStyling: true
    });
    return;
  }

  if (!element) return;

  element.textContent = `${title}: ${message}`;
  element.className = `message ${type}`;

  clearTimeout(showMessage.timeout);

  showMessage.timeout = setTimeout(() => {
    element.classList.add("hidden");
  }, type === "error" || type === "warning" ? 10000 : 6000);
}

function setLoading(button, loading, loadingText = "กำลังบันทึก...") {
  if (!button) return;

  if (loading) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }

    button.textContent = loadingText;
    button.disabled = true;
  } else {
    button.textContent =
      button.dataset.originalText || button.textContent;

    button.disabled = false;
  }
}

function emptyRow(colspan, message = "ไม่มีข้อมูล") {
  return `
    <tr>
      <td colspan="${colspan}" class="empty-cell">
        ${escapeHTML(message)}
      </td>
    </tr>
  `;
}

function makeOption(value, label) {
  return `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`;
}

// ======================================================
// 2. NORMALIZE GOOGLE SHEETS DATA
// รองรับทั้ง Array of Objects และ Array of Arrays
// ======================================================

function normalizeKey(key) {
  return String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function normalizeObject(row, headers) {
  const source = {};

  Object.keys(row).forEach((key) => {
    source[normalizeKey(key)] = row[key];
  });

  const result = {};

  headers.forEach((header) => {
    const key = normalizeKey(header);

    result[header] =
      source[key] ??
      source[key.replace(/_/g, "")] ??
      "";
  });

  return result;
}

function normalizeRows(rows, headers) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      if (Array.isArray(row)) {
        // กรณี API ส่งข้อมูลเป็น Array
        // ["MAT001", "สายไฟ", "Electrical", "ม้วน", 10, 2]
        const result = {};

        headers.forEach((header, index) => {
          result[header] = row[index] ?? "";
        });

        return result;
      }

      if (row && typeof row === "object") {
        // กรณี API ส่งข้อมูลเป็น Object
        return normalizeObject(row, headers);
      }

      return null;
    })
    .filter(Boolean)
    .filter((row) =>
      Object.values(row).some(
        (value) => value !== "" && value !== null
      )
    );
}

// ======================================================
// 3. API
// ======================================================

async function apiGet(action = "getData") {
  const url = new URL(API_URL);

  url.searchParams.set("action", action);
  url.searchParams.set("_", String(Date.now()));

  const response = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`เชื่อมต่อ API ไม่สำเร็จ (${response.status})`);
  }

  const result = await response.json();

  if (result.success === false) {
    throw new Error(result.message || "โหลดข้อมูลไม่สำเร็จ");
  }

  return result;
}

async function apiPost(payload) {
  const response = await fetch(API_URL, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`บันทึกข้อมูลไม่สำเร็จ (${response.status})`);
  }

  const result = await response.json();

  if (result.success === false || result.status === "error") {
    throw new Error(result.message || "บันทึกข้อมูลไม่สำเร็จ");
  }

  return result;
}

// ======================================================
// 4. NAVIGATION
// ======================================================

function showPage(page) {
  if (!PAGE_TITLES[page]) return;

  document.querySelectorAll(".page").forEach((element) => {
    element.classList.toggle(
      "hidden",
      element.id !== `page-${page}`
    );
  });

  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.page === page
    );
    if (button.dataset.page === page) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  if ($("page-title")) {
    $("page-title").textContent = PAGE_TITLES[page];
  }
}

function setupNavigation() {
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.addEventListener("click", () => {
      showPage(button.dataset.page);
    });
  });

  document.querySelectorAll("[data-go]").forEach((button) => {
    button.addEventListener("click", () => {
      showPage(button.dataset.go);
    });
  });
}

// ======================================================
// 5. LOAD ALL DATA
// ======================================================

async function loadData(showNotice = false, notifyFailure = true) {
  const refreshButton = $("refresh-btn");

  try {
    if (refreshButton) refreshButton.disabled = true;

    const data = await apiGet("getData");
    state.apiVersion = String(data.api_version || "");
    state.apiCapabilities = data.capabilities &&
      typeof data.capabilities === "object"
      ? data.capabilities
      : {};

    state.inventory = normalizeRows(data.inventory, [
      "item_id",
      "item_name",
      "category",
      "unit",
      "current_stock",
      "min_threshold"
    ]);

    state.departments = normalizeRows(data.departments, [
      "dept_name",
      "dept_category"
    ]);

    state.requisitions = normalizeRows(data.requisitions, [
      "requisition_no",
      "request_date",
      "department",
      "requester_name",
      "item_id",
      "item_name",
      "quantity",
      "remark",
      "created_at"
    ]);

    state.surveys = normalizeRows(data.surveys, [
      "survey_id",
      "survey_month",
      "department",
      "item_name",
      "expected_qty",
      "reason",
      "created_at"
    ]);

    renderAll();

    if (showNotice) {
      showMessage("โหลดข้อมูลล่าสุดเรียบร้อยแล้ว", "success");
    }
    return true;
  } catch (error) {
    console.error("loadData:", error);

    if (notifyFailure) {
      showMessage(
        "โหลดข้อมูลไม่สำเร็จ: " + error.message,
        "error"
      );
    }
    return false;
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
}

function renderAll() {
  renderDashboardDepartmentOptions();
  renderDashboard();
  renderInventory();
  renderDepartments();
  renderItemOptions();
  renderRequisitions();
  renderSurveys();
  document.querySelectorAll("#requisition-items .requisition-item-row")
    .forEach(updateRequisitionItemInfo);
}

// ======================================================
// 6. STOCK STATUS
// ======================================================

function stockStatus(item) {
  const current = numberValue(item.current_stock);
  const minimum = numberValue(item.min_threshold);

  if (current <= 0) {
    return '<span class="badge badge-out">หมดคลัง</span>';
  }

  if (current <= minimum) {
    return '<span class="badge badge-low">ใกล้หมด</span>';
  }

  return '<span class="badge badge-ok">ปกติ</span>';
}

// ======================================================
// 7. DASHBOARD
// ======================================================

function renderDashboard() {
  const lowStock = state.inventory
    .filter((item) =>
      numberValue(item.current_stock) <=
      numberValue(item.min_threshold)
    )
    .sort((first, second) => {
      const urgency = (item) => {
        const stock = numberValue(item.current_stock);
        const minimum = numberValue(item.min_threshold);
        return minimum > 0 ? stock / minimum : stock === 0 ? 0 : Infinity;
      };
      return urgency(first) - urgency(second);
    });

  if ($("stat-items")) {
    $("stat-items").textContent = formatNumber(state.inventory.length);
  }

  if ($("stat-low")) {
    $("stat-low").textContent = formatNumber(lowStock.length);
  }

  if ($("stat-requisitions")) {
    $("stat-requisitions").textContent = formatNumber(
      getFilteredRequisitions().length
    );
  }

  if ($("stat-surveys")) {
    $("stat-surveys").textContent =
      formatNumber(state.surveys.length);
  }

  const lowStockBody = $("low-stock-body");

  if (lowStockBody) {
    lowStockBody.innerHTML = lowStock.length
      ? lowStock.map((item) => `
          <tr>
            <td>${escapeHTML(item.item_id)}</td>
            <td>${escapeHTML(item.item_name)}</td>
            <td>${escapeHTML(item.category)}</td>
            <td>${formatNumber(item.current_stock)} ${escapeHTML(item.unit)}</td>
            <td>${formatNumber(item.min_threshold)}</td>
            <td>${stockStatus(item)}</td>
          </tr>
        `).join("")
      : emptyRow(6, "ไม่มีวัสดุที่ต่ำกว่าระดับขั้นต่ำ");
  }

  renderCategoryOverview();

  renderRequisitionAnalytics();
}

function getRequisitionMonth(item) {
  const rawDate = String(item.request_date || item.created_at || "").trim();
  const isoMonth = rawDate.match(/^(\d{4})[-/](\d{1,2})/);
  if (isoMonth) {
    return `${isoMonth[1]}-${String(isoMonth[2]).padStart(2, "0")}`;
  }

  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function renderDashboardDepartmentOptions() {
  const select = $("dashboard-department");
  if (!select) return;

  const previousValue = select.value;
  const departmentNames = new Set([
    ...state.departments.map((department) =>
      String(department.dept_name || "").trim()
    ),
    ...state.requisitions.map((item) =>
      String(item.department || "").trim()
    )
  ]);
  departmentNames.delete("");

  select.innerHTML = '<option value="">ทุกหน่วยงาน</option>' +
    [...departmentNames].sort((a, b) => a.localeCompare(b, "th"))
      .map((name) => makeOption(name, name))
      .join("");

  if (departmentNames.has(previousValue)) {
    select.value = previousValue;
  }
}

function getFilteredRequisitions() {
  const startMonth = $("dashboard-start-month")?.value || "";
  const endMonth = $("dashboard-end-month")?.value || "";
  const department = $("dashboard-department")?.value || "";

  return state.requisitions.filter((item) => {
    const month = getRequisitionMonth(item);
    if (!month || (startMonth && month < startMonth) || (endMonth && month > endMonth)) {
      return false;
    }

    return !department || String(item.department || "").trim() === department;
  });
}

function getMonthRange(startMonth, endMonth) {
  if (!startMonth || !endMonth || startMonth > endMonth) return [];

  const [startYear, startNumber] = startMonth.split("-").map(Number);
  const [endYear, endNumber] = endMonth.split("-").map(Number);
  const monthCount = (endYear - startYear) * 12 + endNumber - startNumber + 1;
  if (monthCount > 36) return [];

  return Array.from({ length: monthCount }, (_, index) => {
    const date = new Date(startYear, startNumber - 1 + index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
}

function renderRequisitionAnalytics() {
  const records = getFilteredRequisitions();
  const startMonth = $("dashboard-start-month")?.value || "";
  const endMonth = $("dashboard-end-month")?.value || "";
  const monthRange = getMonthRange(startMonth, endMonth);

  if ($("stat-requisitions")) {
    const requestCount = new Set(records.map((item, index) =>
      item.requisition_no || `row-${index}`
    )).size;
    $("stat-requisitions").textContent = formatNumber(requestCount);
  }

  const itemTotals = new Map();
  const departmentTotals = new Map();
  const monthlyTotals = new Map();
  const inventoryById = new Map(
    state.inventory.map((item) => [String(item.item_id || "").trim(), item])
  );

  records.forEach((item, index) => {
    const quantity = numberValue(item.quantity);
    const requestKey = item.requisition_no || `row-${index}`;
    const itemKey = String(item.item_id || item.item_name || "ไม่ระบุวัสดุ").trim();
    const itemName = String(item.item_name || item.item_id || "ไม่ระบุวัสดุ").trim();
    const inventoryItem = inventoryById.get(String(item.item_id || "").trim());
    const department = String(item.department || "ไม่ระบุหน่วยงาน").trim();
    const month = getRequisitionMonth(item);

    const itemTotal = itemTotals.get(itemKey) || {
      name: itemName,
      unit: String(inventoryItem?.unit || ""),
      quantity: 0,
      requestKeys: new Set()
    };
    itemTotal.quantity += quantity;
    itemTotal.requestKeys.add(requestKey);
    itemTotals.set(itemKey, itemTotal);

    const departmentTotal = departmentTotals.get(department) || { requestKeys: new Set() };
    departmentTotal.requestKeys.add(requestKey);
    departmentTotals.set(department, departmentTotal);

    if (month) {
      const monthRequests = monthlyTotals.get(month) || new Set();
      monthRequests.add(requestKey);
      monthlyTotals.set(month, monthRequests);
    }
  });

  itemTotals.forEach((item) => {
    item.requests = item.requestKeys.size;
    delete item.requestKeys;
  });
  departmentTotals.forEach((department) => {
    department.requests = department.requestKeys.size;
    delete department.requestKeys;
  });
  const monthlyRequestCounts = new Map([...monthlyTotals.entries()].map(
    ([month, requests]) => [month, requests.size]
  ));

  renderRankingTable(
    $("top-items-body"),
    [...itemTotals.values()].sort((a, b) => b.quantity - a.quantity),
    4,
    "ไม่มีรายการเบิกในช่วงที่เลือก",
    (item) => `
      <td>${escapeHTML(item.name)}</td>
      <td>${formatNumber(item.quantity)} ${escapeHTML(item.unit)}</td>
      <td>${formatNumber(item.requests)}</td>
    `
  );
  renderRankingTable(
    $("top-departments-body"),
    [...departmentTotals.entries()]
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => b.requests - a.requests),
    3,
    "ไม่มีรายการเบิกในช่วงที่เลือก",
    (item) => `
      <td>${escapeHTML(item.name)}</td>
      <td>${formatNumber(item.requests)}</td>
    `
  );

  const recentBody = $("recent-requisitions-body");
  if (recentBody) {
    const recent = [...records]
      .sort((a, b) =>
        `${getRequisitionMonth(b)}-${b.request_date || b.created_at || ""}`
          .localeCompare(`${getRequisitionMonth(a)}-${a.request_date || a.created_at || ""}`)
      )
      .slice(0, 10);

    recentBody.innerHTML = recent.length
      ? recent.map((item) => `
          <tr>
            <td>${escapeHTML(item.requisition_no || "-")}</td>
            <td>${formatDate(item.request_date || item.created_at)}</td>
            <td>${escapeHTML(item.department || "-")}</td>
            <td>${escapeHTML(item.requester_name || "-")}</td>
            <td>${escapeHTML(item.item_name || item.item_id || "-")}</td>
            <td>${formatNumber(item.quantity)}</td>
          </tr>
        `).join("")
      : emptyRow(6, "ไม่มีรายการเบิกในช่วงที่เลือก");
  }

  renderRequisitionTrend(monthRange, monthlyRequestCounts, records.length > 0);
}

function renderRankingTable(body, rows, colspan, emptyMessage, renderColumns) {
  if (!body) return;

  body.innerHTML = rows.length
    ? rows.slice(0, 5).map((item, index) => `
        <tr>
          <td><span class="rank-badge">${index + 1}</span></td>
          ${renderColumns(item)}
        </tr>
      `).join("")
    : emptyRow(colspan, emptyMessage);
}

function renderRequisitionTrend(monthRange, monthlyTotals, hasRecords) {
  const canvas = $("requisition-trend-chart");
  const emptyMessage = $("trend-empty");
  if (!canvas || !emptyMessage) return;

  const validRange = monthRange.length > 0;
  emptyMessage.textContent = "ไม่มีข้อมูลการเบิกในช่วงเวลาที่เลือก";
  canvas.classList.toggle("hidden", !validRange || !hasRecords);
  emptyMessage.classList.toggle("hidden", validRange && hasRecords);
  if (!validRange || !hasRecords) {
    requisitionTrendChart?.destroy();
    requisitionTrendChart = null;
    return;
  }

  const labels = monthRange.map((month) => {
    const [year, value] = month.split("-").map(Number);
    return new Intl.DateTimeFormat("th-TH", {
      month: "short",
      year: "2-digit"
    }).format(new Date(year, value - 1, 1));
  });
  const data = monthRange.map((month) => monthlyTotals.get(month) || 0);

  if (!window.Chart) {
    emptyMessage.textContent = "ไม่สามารถโหลดกราฟได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต";
    emptyMessage.classList.remove("hidden");
    canvas.classList.add("hidden");
    return;
  }

  const chartAccent = getThemeColor("--primary");
  const chartGrid = getThemeColor("--border");
  const chartText = getThemeColor("--muted");

  if (requisitionTrendChart) {
    requisitionTrendChart.data.labels = labels;
    requisitionTrendChart.data.datasets[0].data = data;
    requisitionTrendChart.update();
    return;
  }

  requisitionTrendChart = new window.Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "รายการเบิก",
        data,
        borderColor: chartAccent,
        backgroundColor: "rgba(145, 185, 170, 0.16)",
        pointBackgroundColor: chartAccent,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 3,
        fill: true,
        tension: 0.35
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => `${formatNumber(context.parsed.y)} รายการ`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { precision: 0, color: chartText },
          grid: { color: chartGrid }
        },
        x: {
          ticks: { color: chartText },
          grid: { display: false }
        }
      }
    }
  });
}

function getThemeColor(variable) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(variable)
    .trim();
}

function updateDashboardChartTheme() {
  const grid = getThemeColor("--border");
  const text = getThemeColor("--muted");
  if (requisitionTrendChart) {
    const accent = getThemeColor("--primary");
    requisitionTrendChart.data.datasets[0].borderColor = accent;
    requisitionTrendChart.data.datasets[0].pointBackgroundColor = accent;
    requisitionTrendChart.data.datasets[0].backgroundColor = "rgba(145, 185, 170, 0.16)";
    requisitionTrendChart.options.scales.x.ticks.color = text;
    requisitionTrendChart.options.scales.y.ticks.color = text;
    requisitionTrendChart.options.scales.y.grid.color = grid;
    requisitionTrendChart.update();
  }

  if (categoryOverviewChart) {
    categoryOverviewChart.options.plugins.legend.labels.color = text;
    categoryOverviewChart.data.datasets[0].borderColor = getThemeColor("--surface");
    categoryOverviewChart.update();
  }
}

function applyTheme(theme, persist = true) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;

  const toggle = $("theme-toggle");
  const icon = $("theme-toggle-icon");
  const label = $("theme-toggle-label");
  const nextLabel = nextTheme === "dark" ? "โหมดสว่าง" : "โหมดมืด";

  if (toggle) {
    toggle.setAttribute(
      "aria-label",
      nextTheme === "dark" ? "เปลี่ยนเป็นธีมสว่าง" : "เปลี่ยนเป็นธีมมืด"
    );
    toggle.title = nextLabel;
  }
  if (icon) icon.textContent = nextTheme === "dark" ? "☀" : "☾";
  if (label) label.textContent = nextLabel;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.content = nextTheme === "dark" ? "#12182b" : "#f4f6fa";
  }

  if (persist) {
    try {
      localStorage.setItem("inventory-theme", nextTheme);
    } catch (error) {
      console.warn("Unable to save theme preference:", error);
    }
  }

  updateDashboardChartTheme();
}

function renderCategoryOverview() {
  const container = $("category-overview");
  const emptyMessage = $("category-empty");
  if (!container || !emptyMessage) return;

  const categoryCounts = state.inventory.reduce((counts, item) => {
    const category = String(item.category || "").trim() || "ไม่ระบุหมวดหมู่";
    counts.set(category, (counts.get(category) || 0) + 1);
    return counts;
  }, new Map());
  const categories = [...categoryCounts.entries()]
    .sort((first, second) => second[1] - first[1]);

  if (!categories.length) {
    container.classList.add("hidden");
    emptyMessage.textContent = "ยังไม่มีข้อมูลหมวดหมู่";
    emptyMessage.classList.remove("hidden");
    categoryOverviewChart?.destroy();
    categoryOverviewChart = null;
    return;
  }

  if (!window.Chart) {
    container.classList.add("hidden");
    emptyMessage.textContent = "ไม่สามารถโหลดกราฟได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต";
    emptyMessage.classList.remove("hidden");
    return;
  }

  container.classList.remove("hidden");
  emptyMessage.classList.add("hidden");
  const labels = categories.map(([category]) => category);
  const values = categories.map(([, count]) => count);
  const colors = [
    "#315fbb", "#16836f", "#7653a6", "#d06a38", "#c64848",
    "#2288a6", "#9a7415", "#475569", "#bd5794", "#59813c"
  ];

  if (categoryOverviewChart) {
    categoryOverviewChart.data.labels = labels;
    categoryOverviewChart.data.datasets[0].data = values;
    categoryOverviewChart.data.datasets[0].backgroundColor =
      labels.map((_, index) => colors[index % colors.length]);
    categoryOverviewChart.update();
    return;
  }

  categoryOverviewChart = new window.Chart(container, {
    type: "pie",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map((_, index) => colors[index % colors.length]),
        borderColor: getThemeColor("--surface"),
        borderWidth: 3,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: getThemeColor("--muted"),
            padding: 14,
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 9,
            font: { family: "Sarabun, IBM Plex Sans Thai, sans-serif", size: 11 }
          }
        },
        tooltip: {
          callbacks: {
            label: (context) => {
              const total = context.dataset.data.reduce((sum, value) => sum + value, 0);
              const percentage = total ? (context.parsed / total) * 100 : 0;
              return ` ${context.label}: ${formatNumber(context.parsed)} รายการ (${percentage.toFixed(1)}%)`;
            }
          }
        }
      }
    }
  });
}

// ======================================================
// 8. INVENTORY TABLE
// ======================================================

function renderInventory() {
  const body = $("inventory-body");
  if (!body) return;
  const isAdmin = isAdminSessionActive();
  $("inventory-action-heading")?.classList.toggle("hidden", !isAdmin);

  const keyword = ($("inventory-search")?.value || "")
    .trim()
    .toLowerCase();

  const filtered = state.inventory.filter((item) => {
    return [
      item.item_id,
      item.item_name,
      item.category,
      item.unit
    ].some((value) =>
      String(value ?? "").toLowerCase().includes(keyword)
    );
  });

  const pageCount = Math.max(1, Math.ceil(filtered.length / INVENTORY_PAGE_SIZE));
  inventoryPage = Math.min(Math.max(inventoryPage, 1), pageCount);
  const pageItems = filtered.slice(
    (inventoryPage - 1) * INVENTORY_PAGE_SIZE,
    inventoryPage * INVENTORY_PAGE_SIZE
  );

  body.innerHTML = pageItems.length
    ? pageItems.map((item) => `
        <tr>
          <td>${escapeHTML(item.item_id)}</td>
          <td>${escapeHTML(item.item_name)}</td>
          <td>${escapeHTML(item.category)}</td>
          <td>${escapeHTML(item.unit)}</td>
          <td>${formatNumber(item.current_stock)}</td>
          <td>${formatNumber(item.min_threshold)}</td>
          <td>${stockStatus(item)}</td>
          ${isAdmin ? `
            <td>
              <button
                class="btn btn-light btn-edit-stock"
                type="button"
                data-item-id="${escapeHTML(item.item_id)}"
              >
                แก้ไขยอด
              </button>
            </td>
          ` : ""}
        </tr>
      `).join("")
    : emptyRow(
        isAdmin ? 8 : 7,
        state.inventory.length
          ? "ไม่พบรายการที่ค้นหา"
          : "ไม่พบข้อมูลวัสดุ กรุณาตรวจสอบชีต Inventory"
      );

  const pagination = $("inventory-pagination");
  if (pagination) {
    pagination.innerHTML = filtered.length > INVENTORY_PAGE_SIZE
      ? `
          <span>แสดง ${(inventoryPage - 1) * INVENTORY_PAGE_SIZE + 1}–${Math.min(
            inventoryPage * INVENTORY_PAGE_SIZE,
            filtered.length
          )} จาก ${formatNumber(filtered.length)} รายการ</span>
          <div class="pagination-actions">
            <button class="btn btn-light" type="button" data-inventory-page="${inventoryPage - 1}"
              ${inventoryPage === 1 ? "disabled" : ""}>ก่อนหน้า</button>
            <span>หน้า ${inventoryPage} / ${pageCount}</span>
            <button class="btn btn-light" type="button" data-inventory-page="${inventoryPage + 1}"
              ${inventoryPage === pageCount ? "disabled" : ""}>ถัดไป</button>
          </div>
        `
      : filtered.length
        ? `<span>ทั้งหมด ${formatNumber(filtered.length)} รายการ</span>`
        : "";
  }
}

function isAdminSessionActive() {
  if (state.adminToken && Date.now() >= state.adminExpiresAt) {
    endAdminSession();
  }
  return Boolean(state.adminToken);
}

function updateAdminModeUI() {
  const active = Boolean(state.adminToken);
  const button = $("admin-mode-btn");
  if (button) {
    button.textContent = active ? "ออกจากโหมดผู้ดูแล" : "🔒 โหมดผู้ดูแล";
    button.classList.toggle("btn-admin-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.title = active ? "ออกจากโหมดผู้ดูแล" : "เข้าสู่โหมดผู้ดูแล";
  }
  const status = $("admin-mode-status");
  if (status) {
    status.textContent = active
      ? "โหมดผู้ดูแลเปิดใช้งานชั่วคราว · หมดอายุใน 15 นาที"
      : "โหมดผู้ใช้ทั่วไป: ดูและแก้ไขรายการเบิกได้";
    status.classList.toggle("is-admin", active);
  }
}

function endAdminSession() {
  clearTimeout(adminSessionTimer);
  adminSessionTimer = null;
  state.adminToken = null;
  state.adminExpiresAt = 0;
  updateAdminModeUI();
  renderInventory();
  renderRequisitions();
}

async function logoutAdminMode() {
  const token = state.adminToken;
  endAdminSession();
  if (!token) return;

  try {
    await apiPost({ action: "adminLogout", admin_token: token });
  } catch (error) {
    console.error("Admin logout error:", error);
  }
}

async function toggleAdminMode() {
  if (isAdminSessionActive()) {
    await logoutAdminMode();
    showMessage("ออกจากโหมดผู้ดูแลแล้ว", "success");
    return;
  }

  if (!window.Swal) {
    showMessage("ไม่สามารถโหลดหน้าต่างยืนยันได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต", "error");
    return;
  }

  const prompt = await window.Swal.fire({
    title: "เข้าสู่โหมดผู้ดูแล",
    text: "กรอกรหัสผู้ดูแลเพื่อแก้ไขยอดวัสดุในคลัง",
    input: "password",
    inputPlaceholder: "รหัสผู้ดูแล",
    inputAttributes: {
      autocomplete: "current-password",
      autocapitalize: "off",
      autocorrect: "off"
    },
    showCancelButton: true,
    confirmButtonText: "ยืนยัน",
    cancelButtonText: "ยกเลิก",
    confirmButtonColor: "#176b5b",
    inputValidator: (value) => value ? undefined : "กรุณากรอกรหัสผู้ดูแล"
  });

  if (!prompt.isConfirmed) return;

  const button = $("admin-mode-btn");
  setLoading(button, true, "กำลังตรวจสอบ...");
  try {
    const result = await apiPost({
      action: "adminLogin",
      pin: prompt.value
    });

    if (!result.data?.admin_token) {
      throw new Error("เซิร์ฟเวอร์ไม่ได้ส่งสิทธิ์ผู้ดูแลกลับมา");
    }

    state.adminToken = result.data.admin_token;
    state.adminExpiresAt = Date.now() + 15 * 60 * 1000;
    clearTimeout(adminSessionTimer);
    adminSessionTimer = setTimeout(() => {
      endAdminSession();
      showMessage("หมดเวลาสิทธิ์ผู้ดูแลแล้ว", "info");
    }, 15 * 60 * 1000);
    updateAdminModeUI();
    renderInventory();
    renderRequisitions();
    showMessage("เข้าสู่โหมดผู้ดูแลแล้ว สิทธิ์จะหมดอายุใน 15 นาที", "success");
  } catch (error) {
    console.error("Admin authentication error:", error);
    showMessage(error.message || "ตรวจสอบรหัสผู้ดูแลไม่สำเร็จ", "error");
  } finally {
    setLoading(button, false);
    updateAdminModeUI();
  }
}

async function editInventoryStock(itemId) {
  if (!isAdminSessionActive()) {
    showMessage("สิทธิ์ผู้ดูแลหมดอายุ กรุณายืนยันรหัสอีกครั้ง", "warning");
    return;
  }

  const item = state.inventory.find(
    (record) => String(record.item_id) === String(itemId)
  );
  if (!item) {
    showMessage("ไม่พบวัสดุที่ต้องการแก้ไข กรุณารีเฟรชข้อมูล", "error");
    return;
  }

  const result = await window.Swal.fire({
    title: "แก้ไขยอดคงเหลือ",
    html: `
      <div class="confirmation-details">
        <strong>${escapeHTML(item.item_name)} (${escapeHTML(item.item_id)})</strong>
        <span>ยอดปัจจุบัน ${formatNumber(item.current_stock)} ${escapeHTML(item.unit)}</span>
      </div>
      <label class="stock-edit-label" for="admin-new-stock">ยอดคงเหลือใหม่</label>
      <input id="admin-new-stock" class="swal2-input" type="number" min="0" step="any"
        value="${escapeHTML(item.current_stock)}" aria-label="ยอดคงเหลือใหม่">
      <label class="stock-edit-label" for="admin-stock-reason">เหตุผลในการปรับยอด</label>
      <input id="admin-stock-reason" class="swal2-input" type="text" maxlength="300"
        placeholder="เช่น ตรวจนับสต็อก / รับสินค้าเข้า">
    `,
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: "บันทึกยอดใหม่",
    cancelButtonText: "ยกเลิก",
    confirmButtonColor: "#176b5b",
    preConfirm: () => {
      const stock = Number($("admin-new-stock").value);
      const reason = $("admin-stock-reason").value.trim();
      if (!Number.isFinite(stock) || stock < 0) {
        window.Swal.showValidationMessage("ยอดคงเหลือต้องเป็น 0 หรือมากกว่า");
        return false;
      }
      if (!reason) {
        window.Swal.showValidationMessage("กรุณาระบุเหตุผลในการปรับยอด");
        return false;
      }
      return { stock, reason };
    }
  });

  if (!result.isConfirmed) return;

  try {
    const response = await apiPost({
      action: "updateStock",
      admin_token: state.adminToken,
      item_id: item.item_id,
      current_stock: result.value.stock,
      reason: result.value.reason
    });

    const updatedStock = Number(response.data?.current_stock);
    if (!Number.isFinite(updatedStock) || updatedStock < 0) {
      throw new Error("ปรับยอดแล้ว แต่เซิร์ฟเวอร์ส่งยอดคงเหลือกลับมาไม่ถูกต้อง กรุณารีเฟรชข้อมูล");
    }

    item.current_stock = updatedStock;
    renderAll();
    showMessage(
      response.message || "ปรับยอดวัสดุสำเร็จ",
      response.data?.audit_warning ? "warning" : "success"
    );
  } catch (error) {
    console.error("Stock update error:", error);
    if (/token|สิทธิ์ผู้ดูแล/i.test(error.message)) {
      endAdminSession();
    }
    showMessage(error.message || "ปรับยอดวัสดุไม่สำเร็จ", "error");
  }
}

// ======================================================
// 9. DEPARTMENTS
// ======================================================

function renderDepartments() {
  const names = state.departments
    .map((department) => String(department.dept_name ?? "").trim())
    .filter(Boolean);

  ["req-requester", "survey-department"].forEach((id) => {
    const select = $(id);
    if (!select) return;

    const previousValue = select.value;
    const placeholder = id === "req-requester"
      ? "เลือกชื่อผู้เบิก"
      : "เลือกแผนก";

    select.innerHTML =
      `<option value="">${placeholder}</option>` +
      names.map((name) => makeOption(name, name)).join("");

    if (names.includes(previousValue)) {
      select.value = previousValue;
    }
  });
}

// ======================================================
// 10. ITEM DROPDOWN
// ======================================================

function renderItemOptions() {
  document.querySelectorAll("#requisition-items .requisition-item-row")
    .forEach(renderRequisitionItemOptions);
}

function renderRequisitionItemOptions(row) {
  const categorySelect = row.querySelector(".requisition-item-category");
  const itemSelect = row.querySelector(".requisition-item-name");
  if (!categorySelect || !itemSelect) return;

  const previousCategory = categorySelect.value;
  const previousItem = itemSelect.value;
  const categories = [...new Set(state.inventory
    .map((item) => String(item.category ?? "").trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "th"));

  categorySelect.innerHTML =
    '<option value="">เลือกหมวดหมู่</option>' +
    categories.map((category) => makeOption(category, category)).join("");
  categorySelect.value = categories.includes(previousCategory) ? previousCategory : "";

  const categoryItems = state.inventory.filter((item) =>
    String(item.category ?? "").trim() === categorySelect.value
  );
  itemSelect.disabled = !categorySelect.value;
  itemSelect.innerHTML = !categorySelect.value
    ? '<option value="">เลือกหมวดหมู่ก่อน</option>'
    : '<option value="">เลือกวัสดุ</option>' + categoryItems.map((item) => {
        const id = String(item.item_id ?? "").trim();
        const name = String(item.item_name ?? "").trim();
        const stockNote = numberValue(item.current_stock) <= 0 ? " — หมดคลัง" : "";
        return makeOption(id, `${name} (${id})${stockNote}`);
      }).join("");
  itemSelect.value = categoryItems.some((item) =>
    String(item.item_id ?? "").trim() === previousItem
  ) ? previousItem : "";
}

function getSelectedRequisitionItem(row) {
  const category = String(row?.querySelector(".requisition-item-category")?.value || "").trim();
  const itemId = String(row?.querySelector(".requisition-item-name")?.value || "").trim();
  if (!category || !itemId) return null;

  return state.inventory.find((item) =>
    String(item.item_id ?? "").trim() === itemId &&
    String(item.category ?? "").trim() === category
  ) || null;
}

function updateRequisitionItemInfo(row) {
  const info = row.querySelector(".requisition-item-info");
  const quantityInput = row.querySelector(".requisition-quantity");
  const preview = row.querySelector(".requisition-remaining-preview");
  if (!info || !quantityInput || !preview) return;

  const item = getSelectedRequisitionItem(row);

  if (!item) {
    info.classList.add("hidden");
    info.textContent = "";
    quantityInput.removeAttribute("max");
    preview.textContent = "เลือกวัสดุเพื่อดูจำนวนคงเหลือหลังเบิก";
    preview.classList.remove("is-warning");
    return;
  }

  info.classList.remove("hidden");
  quantityInput.max = String(numberValue(item.current_stock));

  info.innerHTML = `
    <span class="item-info-label">คงเหลือในคลัง</span>
    <strong class="item-info-stock">${formatNumber(item.current_stock)}</strong>
    <span class="item-info-details">
      รหัส ${escapeHTML(item.item_id)} · ขั้นต่ำ ${formatNumber(item.min_threshold)} ${escapeHTML(item.unit)}
    </span>
  `;

  const requested = [...document.querySelectorAll("#requisition-items .requisition-item-row")]
    .filter((entry) =>
      String(getSelectedRequisitionItem(entry)?.item_id) === String(item.item_id)
    )
    .reduce((total, entry) =>
      total + numberValue(entry.querySelector(".requisition-quantity").value), 0);
  const remaining = numberValue(item.current_stock) - requested;
  const exceedsStock = requested > numberValue(item.current_stock);
  preview.textContent = exceedsStock
    ? `จำนวนรวมเกินสต็อกคงเหลือ ${formatNumber(item.current_stock)} ${item.unit}`
    : `รวมรายการนี้แล้วจะเหลือ ${formatNumber(Math.max(remaining, 0))} ${item.unit}`;
  preview.classList.toggle("is-warning", exceedsStock);
}

function addRequisitionItemRow() {
  const container = $("requisition-items");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "requisition-item-row";
  row.innerHTML = `
    <div class="requisition-item-fields">
      <label>
        หมวดหมู่
        <select class="requisition-item-category" required>
          <option value="">เลือกหมวดหมู่</option>
        </select>
      </label>
      <label>
        วัสดุที่ต้องการเบิก
        <select
          class="requisition-item-name"
          disabled
          required
        >
          <option value="">เลือกหมวดหมู่ก่อน</option>
        </select>
      </label>
      <label>
        จำนวนที่ต้องการเบิก
        <input
          class="requisition-quantity"
          type="number"
          min="0.01"
          step="any"
          placeholder="ระบุจำนวน"
          required
        >
      </label>
      <div class="item-info requisition-item-info hidden"></div>
      <small class="quantity-preview requisition-remaining-preview" aria-live="polite">
        เลือกวัสดุเพื่อดูจำนวนคงเหลือหลังเบิก
      </small>
    </div>
    <button
      class="btn btn-remove-requisition-item"
      type="button"
      aria-label="ลบรายการวัสดุ"
      title="ลบรายการ"
    >
      ลบรายการ
    </button>
  `;
  container.append(row);
  renderRequisitionItemOptions(row);
  updateRequisitionRowControls();
}

function updateRequisitionRowControls() {
  const rows = document.querySelectorAll("#requisition-items .requisition-item-row");
  rows.forEach((row) => {
    row.querySelector(".btn-remove-requisition-item").disabled = rows.length === 1;
  });
}

function resetRequisitionItemRows() {
  const container = $("requisition-items");
  if (!container) return;
  container.replaceChildren();
  addRequisitionItemRow();
}

// ======================================================
// 11. REQUISITION HISTORY
// แสดงรายการที่บันทึกไว้ใต้ฟอร์ม
// ======================================================

function renderRequisitions() {
  const body = $("requisitions-body");
  if (!body) return;

  populateRequisitionFilterOptions();
  const search = ($("requisition-search")?.value || "").trim().toLocaleLowerCase();
  const startDate = $("requisition-start-date")?.value || "";
  const endDate = $("requisition-end-date")?.value || "";
  const department = $("requisition-department-filter")?.value || "";
  const itemId = $("requisition-item-filter")?.value || "";
  const records = [...state.requisitions]
    .filter((item) => {
      const date = getRequisitionDateValue(item);
      if (startDate && (!date || date < startDate)) return false;
      if (endDate && (!date || date > endDate)) return false;
      if (department && String(item.department || "") !== department) return false;
      if (itemId && String(item.item_id || "") !== itemId) return false;
      if (!search) return true;

      return [
        item.requisition_no,
        item.department,
        item.requester_name,
        item.item_id,
        item.item_name,
        item.remark
      ].some((value) => String(value || "").toLocaleLowerCase().includes(search));
    })
    .reverse();
  const renderedActions = new Set();

  body.innerHTML = records.length
    ? records.map((item) => {
        const requisitionNo = String(item.requisition_no || "");
        const showActions = !renderedActions.has(requisitionNo);
        renderedActions.add(requisitionNo);
        return `
          <tr>
            <td>${escapeHTML(item.requisition_no || "-")}</td>
            <td>${formatDate(item.request_date)}</td>
            <td>${escapeHTML(item.department || "-")}</td>
            <td>${escapeHTML(item.requester_name || "-")}</td>
            <td>${escapeHTML(item.item_id || "-")}</td>
            <td>${escapeHTML(item.item_name || "-")}</td>
            <td>${formatNumber(item.quantity)}</td>
            <td>${escapeHTML(item.remark || "-")}</td>
            <td>
              ${showActions ? `
                <div class="requisition-row-actions">
                  <button class="btn btn-light btn-view-requisition" type="button"
                    data-requisition-no="${escapeHTML(requisitionNo)}"
                    aria-label="ดูรายละเอียด ${escapeHTML(requisitionNo)}">รายละเอียด</button>
                  <button class="btn btn-light btn-edit-requisition" type="button"
                    data-requisition-no="${escapeHTML(requisitionNo)}"
                    aria-label="แก้ไขใบเบิก ${escapeHTML(requisitionNo)}">แก้ไข</button>
                  <button class="btn btn-delete-requisition" type="button"
                    data-requisition-no="${escapeHTML(requisitionNo)}"
                    aria-label="ลบใบเบิก ${escapeHTML(requisitionNo)}">ลบทั้งใบ</button>
                </div>
              ` : ""}
            </td>
          </tr>
        `;
      }).join("")
    : emptyRow(9, state.requisitions.length ? "ไม่พบรายการตามตัวกรอง" : "ยังไม่มีรายการเบิกวัสดุ");
}

function populateRequisitionFilterOptions() {
  const departmentSelect = $("requisition-department-filter");
  const itemSelect = $("requisition-item-filter");
  const previousDepartment = departmentSelect?.value || "";
  const previousItem = itemSelect?.value || "";
  const departments = new Set([
    ...state.departments.map((entry) => String(entry.dept_name || "").trim()),
    ...state.requisitions.map((entry) => String(entry.department || "").trim())
  ]);
  departments.delete("");
  const items = new Map();
  state.inventory.forEach((item) => {
    const id = String(item.item_id || "").trim();
    if (id) items.set(id, String(item.item_name || id));
  });
  state.requisitions.forEach((item) => {
    const id = String(item.item_id || "").trim();
    if (id && !items.has(id)) items.set(id, String(item.item_name || id));
  });

  if (departmentSelect) {
    departmentSelect.innerHTML =
      '<option value="">ทุกหน่วยงาน</option>' +
      [...departments].sort((a, b) => a.localeCompare(b, "th"))
        .map((name) => makeOption(name, name)).join("");
    if (departments.has(previousDepartment)) departmentSelect.value = previousDepartment;
  }
  if (itemSelect) {
    itemSelect.innerHTML =
      '<option value="">ทุกวัสดุ</option>' +
      [...items.entries()].sort((a, b) => a[1].localeCompare(b[1], "th"))
        .map(([id, name]) => makeOption(id, `${name} (${id})`)).join("");
    if (items.has(previousItem)) itemSelect.value = previousItem;
  }
}

function getRequisitionDateValue(item) {
  const rawDate = String(item.request_date || item.created_at || "").trim();
  const isoDate = rawDate.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDate) return isoDate[1];
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getRequisitionByNumber(requisitionNo) {
  return state.requisitions.find(
    (item) => String(item.requisition_no) === String(requisitionNo)
  ) || null;
}

function getRequisitionGroup(requisitionNo) {
  return state.requisitions.filter(
    (item) => String(item.requisition_no) === String(requisitionNo)
  );
}

async function viewRequisition(requisitionNo) {
  const items = getRequisitionGroup(requisitionNo);
  if (!items.length) {
    showMessage("ไม่พบรายการเบิก กรุณารีเฟรชข้อมูล", "error");
    return;
  }
  const first = items[0];
  const detailRows = items.map((item) => `
    <tr>
      <td>${escapeHTML(item.item_id || "-")}</td>
      <td>${escapeHTML(item.item_name || "-")}</td>
      <td>${formatNumber(item.quantity)}</td>
      <td>${escapeHTML(state.inventory.find((entry) =>
        String(entry.item_id) === String(item.item_id)
      )?.unit || "")}</td>
    </tr>
  `).join("");
  const details = `
    <div class="requisition-detail">
      <p><strong>เลขที่ใบเบิก:</strong> ${escapeHTML(first.requisition_no)}</p>
      <p><strong>วันที่:</strong> ${escapeHTML(formatDate(first.request_date))}</p>
      <p><strong>ผู้เบิก:</strong> ${escapeHTML(first.requester_name || "-")}</p>
      <p><strong>หมายเหตุ:</strong> ${escapeHTML(first.remark || "-")}</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>รหัสวัสดุ</th><th>วัสดุ</th><th>จำนวน</th><th>หน่วย</th></tr></thead>
          <tbody>${detailRows}</tbody>
        </table>
      </div>
    </div>
  `;
  if (window.Swal) {
    await window.Swal.fire({
      title: "รายละเอียดใบเบิก",
      html: details,
      confirmButtonText: "ปิด",
      width: 720
    });
  } else {
    window.alert(
      `ใบเบิก ${first.requisition_no}\nวันที่ ${formatDate(first.request_date)}\n` +
      `ผู้เบิก ${first.requester_name || "-"}\n` +
      items.map((item) =>
        `${item.item_name || item.item_id} × ${formatNumber(item.quantity)}`
      ).join("\n")
    );
  }
}

async function editRequisition(requisitionNo) {
  if (!window.Swal) {
    showMessage("ไม่สามารถโหลดหน้าต่างแก้ไขได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต", "error");
    return;
  }

  const items = getRequisitionGroup(requisitionNo);
  if (!items.length) {
    showMessage("ไม่พบรายการเบิก กรุณารีเฟรชข้อมูล", "error");
    return;
  }
  const first = items[0];

  const requesterNames = new Set([
    ...state.departments.map((entry) => String(entry.dept_name || "").trim()),
    String(first.requester_name || "").trim()
  ]);
  requesterNames.delete("");
  const requesterOptions = [...requesterNames]
    .sort((a, b) => a.localeCompare(b, "th"))
    .map((name) => `<option value="${escapeHTML(name)}"${name === first.requester_name ? " selected" : ""}>${escapeHTML(name)}</option>`)
    .join("");
  const itemOptions = (selectedId) =>
    state.inventory.map((inventoryItem) => {
      const id = String(inventoryItem.item_id || "");
      const name = String(inventoryItem.item_name || "");
      const selected = id === String(selectedId) ? " selected" : "";
      return `<option value="${escapeHTML(id)}"${selected}>${escapeHTML(`${name} (${id})`)}</option>`;
    }).join("");
  const renderEditRow = (item = {}) => `
    <div class="requisition-edit-item-row">
      <select class="edit-requisition-item" aria-label="วัสดุ">
        <option value="">เลือกวัสดุ</option>${itemOptions(item.item_id)}
      </select>
      <input class="edit-requisition-quantity" type="number" min="0.01" step="any"
        aria-label="จำนวนที่เบิก" placeholder="จำนวน" value="${escapeHTML(item.quantity ?? "")}">
      <button class="btn btn-remove-requisition-item" type="button" aria-label="ลบรายการ">ลบ</button>
    </div>
  `;

  const result = await window.Swal.fire({
    title: "แก้ไขรายละเอียดใบเบิก",
    html: `
      <div class="requisition-edit-form">
        <label for="edit-requisition-date">วันที่เบิก</label>
        <input id="edit-requisition-date" class="swal2-input" type="date"
          value="${escapeHTML(getRequisitionDateValue(first))}">
        <label for="edit-requisition-requester">ชื่อผู้เบิก</label>
        <select id="edit-requisition-requester" class="swal2-select">${requesterOptions}</select>
        <label for="edit-requisition-remark">หมายเหตุ</label>
        <input id="edit-requisition-remark" class="swal2-input" type="text" maxlength="1000"
          value="${escapeHTML(first.remark || "")}">
        <div class="requisition-edit-items-toolbar">
          <strong>วัสดุในใบเบิก</strong>
          <button id="add-edit-requisition-item" class="btn btn-light" type="button">＋ เพิ่มวัสดุ</button>
        </div>
        <div id="edit-requisition-items">${items.map(renderEditRow).join("")}</div>
      </div>
    `,
    focusConfirm: false,
    showCancelButton: true,
    confirmButtonText: "บันทึกการแก้ไข",
    cancelButtonText: "ยกเลิก",
    confirmButtonColor: "#315fbb",
    didOpen: () => {
      const container = $("edit-requisition-items");
      $("add-edit-requisition-item").addEventListener("click", () => {
        container.insertAdjacentHTML("beforeend", renderEditRow());
      });
      container.addEventListener("click", (event) => {
        const removeButton = event.target.closest(".btn-remove-requisition-item");
        if (removeButton && container.querySelectorAll(".requisition-edit-item-row").length > 1) {
          removeButton.closest(".requisition-edit-item-row").remove();
        }
      });
    },
    preConfirm: () => {
      const updated = {
        request_date: $("edit-requisition-date").value,
        requester_name: $("edit-requisition-requester").value.trim(),
        remark: $("edit-requisition-remark").value.trim(),
        items: [...document.querySelectorAll("#edit-requisition-items .requisition-edit-item-row")]
          .map((row) => ({
            item_id: row.querySelector(".edit-requisition-item").value,
            quantity: Number(row.querySelector(".edit-requisition-quantity").value)
          }))
      };
      if (!updated.request_date || !updated.requester_name ||
        updated.items.some((entry) => !entry.item_id)) {
        window.Swal.showValidationMessage("กรุณากรอกวันที่ ชื่อผู้เบิก และเลือกวัสดุทุกรายการ");
        return false;
      }
      if (updated.items.some((entry) =>
        !Number.isFinite(entry.quantity) || entry.quantity <= 0
      )) {
        window.Swal.showValidationMessage("จำนวนที่เบิกทุกรายการต้องมากกว่า 0");
        return false;
      }
      return updated;
    }
  });

  if (!result.isConfirmed) return;

  const updatedItems = result.value.items;
  if (
    items.length > 1 &&
    state.apiCapabilities.grouped_requisition_edit !== true
  ) {
    showMessage(
      "แก้ไขไม่สำเร็จ: Apps Script deployment ที่เว็บกำลังใช้อยู่ยังไม่ยืนยันว่ารองรับการแก้ไขใบเบิกหลายรายการ กรุณา Deploy Code.gs เวอร์ชันล่าสุดไปยัง deployment เดิม และตรวจสอบ API version ก่อนลองใหม่ ไม่มีการเปลี่ยนแปลงข้อมูลหรือสต็อก",
      "error"
    );
    return;
  }

  const legacySingleItemFields = items.length === 1 && updatedItems.length === 1
    ? {
        item_id: updatedItems[0].item_id,
        quantity: updatedItems[0].quantity
      }
    : {};

  try {
    await apiPost({
      action: "editRequisition",
      requisition_no: first.requisition_no,
      department: first.department || "",
      ...result.value,
      ...legacySingleItemFields
    });
    showMessage("แก้ไขใบเบิกและปรับสต็อกเรียบร้อยแล้ว กำลังโหลดข้อมูลล่าสุด", "success");
    loadData(false, false).then((refreshed) => {
      if (!refreshed) {
        showMessage(
          "แก้ไขสำเร็จแล้ว แต่โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณากดรีเฟรช",
          "warning"
        );
      }
    });
  } catch (error) {
    const outdatedBackend = error.message === "กรุณาเลือกวัสดุ" ||
      error.message?.includes("พบเลขที่ใบเบิกซ้ำ");
    const message = outdatedBackend
      ? "การแก้ไขไม่สำเร็จ: Apps Script ที่เว็บเชื่อมต่อยังไม่รองรับการแก้ไขใบเบิกหลายรายการ จึงยังคืนวัสดุเดิมและปรับสต็อกให้ครบทั้งใบไม่ได้ ไม่มีการเปลี่ยนแปลงจากคำขอนี้ กรุณา Deploy Code.gs เวอร์ชันล่าสุดไปยัง deployment เดิมที่ API_URL ใช้อยู่ แล้วโหลดหน้าเว็บใหม่"
      : error.message || "แก้ไขรายการเบิกไม่สำเร็จ";
    if (outdatedBackend) {
      console.warn("Requisition edit blocked by outdated Apps Script deployment:", error.message);
    } else {
      console.error("Requisition edit error:", error);
    }
    showMessage(message, "error");
  }
}

async function deleteRequisition(requisitionNo) {
  const item = getRequisitionByNumber(requisitionNo);
  if (!item) {
    showMessage("ไม่พบรายการเบิก กรุณารีเฟรชข้อมูล", "error");
    return;
  }
  const groupedItems = state.requisitions.filter((entry) =>
    String(entry.requisition_no) === String(requisitionNo)
  );
  const itemSummary = groupedItems.map((entry) =>
    `${escapeHTML(entry.item_name || entry.item_id)} × ${formatNumber(entry.quantity)}`
  ).join("<br>");

  const confirmed = window.Swal
    ? (await window.Swal.fire({
        icon: "warning",
        title: "ยืนยันการลบรายการเบิก",
        html: `ลบใบเบิก <strong>${escapeHTML(item.requisition_no)}</strong> จำนวน ${groupedItems.length} รายการ:<br>${itemSummary}<br>แล้วคืนวัสดุเข้าคลัง`,
        showCancelButton: true,
        confirmButtonText: "ลบและคืนสต็อก",
        cancelButtonText: "ยกเลิก",
        confirmButtonColor: "#b42323",
        reverseButtons: true
      })).isConfirmed
    : window.confirm(
        `ลบใบเบิก ${item.requisition_no} จำนวน ${groupedItems.length} รายการ:\n` +
        groupedItems.map((entry) =>
          `${entry.item_name || entry.item_id} × ${formatNumber(entry.quantity)}`
        ).join("\n") +
        "\nแล้วคืนวัสดุเข้าคลัง?"
      );
  if (!confirmed) return;

  try {
    await apiPost({
      action: "deleteRequisition",
      requisition_no: item.requisition_no
    });
    showMessage("ลบใบเบิกและคืนสต็อกเรียบร้อยแล้ว กำลังโหลดข้อมูลล่าสุด", "success");
    loadData(false, false).then((refreshed) => {
      if (!refreshed) {
        showMessage(
          "ลบสำเร็จแล้ว แต่โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณากดรีเฟรช",
          "warning"
        );
      }
    });
  } catch (error) {
    console.error("Requisition delete error:", error);
    if (/token|สิทธิ์ผู้ดูแล/i.test(error.message)) endAdminSession();
    showMessage(error.message || "ลบรายการเบิกไม่สำเร็จ", "error");
  }
}

// ======================================================
// 12. SUBMIT REQUISITION
// ไม่มีการส่งอีเมลจาก app.js
// ======================================================

async function submitRequisition(event) {
  event.preventDefault();

  const button = $("submit-requisition");
  const requester = $("req-requester").value.trim();
  const remark = $("req-remark").value.trim();
  const rows = [...document.querySelectorAll("#requisition-items .requisition-item-row")];
  const items = rows.map((row) => ({
    item: getSelectedRequisitionItem(row),
    quantity: numberValue(row.querySelector(".requisition-quantity").value)
  }));

  if (!requester) {
    showMessage("กรุณาเลือกชื่อผู้เบิก", "error");
    return;
  }

  if (items.some(({ item, quantity }) => !item || quantity <= 0)) {
    showMessage("กรุณาเลือกวัสดุและระบุจำนวนให้ครบทุกแถว", "error");
    return;
  }

  const requestedByItem = new Map();
  items.forEach(({ item, quantity }) => {
    const itemId = String(item.item_id);
    requestedByItem.set(itemId, (requestedByItem.get(itemId) || 0) + quantity);
  });
  const insufficientItem = [...requestedByItem.entries()].find(([itemId, quantity]) => {
    const item = state.inventory.find((entry) => String(entry.item_id) === itemId);
    return !item || quantity > numberValue(item.current_stock);
  });
  if (insufficientItem) {
    const item = state.inventory.find(
      (entry) => String(entry.item_id) === insufficientItem[0]
    );
    showMessage(
      `${item?.item_name || "วัสดุ"} คงเหลือเพียง ${formatNumber(item?.current_stock)} ${item?.unit || ""}`,
      "error"
    );
    return;
  }

  const confirmationItems = items.map(({ item, quantity }) => `
    <div class="confirmation-details">
      <strong>${escapeHTML(item.item_name)}</strong>
      <span>จำนวนที่เบิก ${formatNumber(quantity)} ${escapeHTML(item.unit)}</span>
      <span>คงเหลือหลังเบิกทั้งใบ ${formatNumber(
        numberValue(item.current_stock) - requestedByItem.get(String(item.item_id))
      )} ${escapeHTML(item.unit)}</span>
    </div>
  `).join("");
  const confirmation = window.Swal
    ? await window.Swal.fire({
        icon: "question",
        title: `ยืนยันการเบิก ${items.length} รายการ`,
        html: confirmationItems,
        showCancelButton: true,
        confirmButtonText: "ยืนยันการเบิก",
        cancelButtonText: "ยกเลิก",
        reverseButtons: true,
        confirmButtonColor: "#176b5b"
      })
    : { isConfirmed: window.confirm(
        `ยืนยันเบิกวัสดุ ${items.length} รายการ?`
      ) };

  if (!confirmation.isConfirmed) return;

  const payload = {
    action: "requisition",
    request_date: getBangkokDateString(),
    department: "",
    requester_name: requester,
    remark,
    items: items.map(({ item, quantity }) => ({
      item_id: item.item_id,
      quantity
    }))
  };

  setLoading(button, true);
  $("add-requisition-item").disabled = true;
  document.querySelectorAll("#requisition-items input, #requisition-items select, .btn-remove-requisition-item")
    .forEach((input) => { input.disabled = true; });

  try {
    const result = await apiPost(payload);
    const saved = result.data;
    let refreshFailed = false;

    if (Array.isArray(saved?.items) && saved.items.length === items.length) {
      saved.items.forEach((savedItem, index) => {
        const selectedItem = items[index].item;
        const stock = Number(savedItem.current_stock);
        if (Number.isFinite(stock) && stock >= 0) {
          selectedItem.current_stock = stock;
        }
        state.requisitions.push({
          requisition_no: saved.requisition_no || "",
          request_date: payload.request_date,
          department: "",
          requester_name: requester,
          item_id: selectedItem.item_id,
          item_name: savedItem.item_name || selectedItem.item_name,
          quantity: items[index].quantity,
          remark
        });
      });
      renderAll();
    } else {
      refreshFailed = !(await loadData(false, false));
    }

    $("requisition-form").reset();

    showPage("requisition");

    const notification = saved?.email_notification;
    const saveMessages = [];
    if (refreshFailed) {
      saveMessages.push("บันทึกใบเบิกสำเร็จ แต่โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณากดรีเฟรช");
    } else {
      saveMessages.push(
        `บันทึกใบเบิก ${saved?.requisition_no || ""} และตัดสต็อกแล้ว`
      );
    }

    if (notification?.status === "queued") {
      saveMessages.push("จัดส่งอีเมลเรียบร้อย");
    } else if (notification?.status === "not_configured") {
      saveMessages.push("ยังไม่ได้ตั้งค่าอีเมลแจ้งเตือนใน Apps Script");
    } else if (notification?.status === "trigger_not_configured") {
      saveMessages.push(
        "ยังไม่ได้เปิดตัวส่งอีเมล กรุณารัน setupRequisitionEmailNotifications ใน Apps Script"
      );
    } else if (notification?.status === "queue_failed") {
      saveMessages.push(
        "จัดคิวอีเมลไม่สำเร็จ กรุณาตรวจสอบชีต Requisition_Email_Queue"
      );
    } else if (!notification) {
      saveMessages.push(
        "backend ไม่ได้รายงานสถานะอีเมล กรุณา Deploy Apps Script เวอร์ชันที่รองรับอีเมลแจ้งเตือน"
      );
    } else {
      saveMessages.push("backend ส่งสถานะอีเมลที่ไม่รู้จัก กรุณาตรวจสอบการตั้งค่า");
    }

    const notificationWarning = !notification ||
      ["not_configured", "trigger_not_configured", "queue_failed"]
        .includes(notification?.status);
    showMessage(
      saveMessages.join(". "),
      refreshFailed || notificationWarning ? "warning" : "success"
    );

    // เลื่อนลงไปดูรายการที่บันทึก
    $("requisition-history-panel")?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });

  } catch (error) {
    console.error("Requisition error:", error);
    const message = error.message === "กรุณาเลือกวัสดุที่ต้องการเบิก"
      ? "ระบบหลังบ้านยังเป็นเวอร์ชันเก่าที่ไม่รองรับการเบิกหลายรายการ กรุณาอัปเดตและ Deploy Google Apps Script เวอร์ชันล่าสุด แล้วลองใหม่ (รายการนี้ยังไม่ถูกบันทึก)"
      : error.message;
    showMessage(message, "error");
  } finally {
    setLoading(button, false);
    $("add-requisition-item").disabled = false;
    document.querySelectorAll("#requisition-items input, #requisition-items select").forEach((input) => {
      input.disabled = false;
    });
    updateRequisitionRowControls();
  }
}

function getBangkokDateString() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

// ======================================================
// 13. SURVEY HISTORY
// ======================================================

function renderSurveys() {
  const body = $("surveys-body");
  if (!body) return;

  const records = [...state.surveys].reverse();

  body.innerHTML = records.length
    ? records.map((item) => `
        <tr>
          <td>${escapeHTML(item.survey_id)}</td>
          <td>${escapeHTML(item.survey_month)}</td>
          <td>${escapeHTML(item.department)}</td>
          <td>${escapeHTML(item.item_name)}</td>
          <td>${formatNumber(item.expected_qty)}</td>
          <td>${escapeHTML(item.reason)}</td>
        </tr>
      `).join("")
    : emptyRow(6, "ยังไม่มีข้อมูลสำรวจ");
}

// ======================================================
// 14. SUBMIT MONTHLY SURVEY
// ======================================================

function addSurveyItemRow(values = {}) {
  const container = $("survey-items");
  if (!container) return;

  const row = document.createElement("div");
  row.className = "survey-item-row";
  row.innerHTML = `
    <div class="survey-item-fields">
      <label>
        ชื่อวัสดุ
        <input
          class="survey-item-name"
          type="text"
          maxlength="200"
          placeholder="กรอกชื่อวัสดุ"
          required
        >
      </label>
      <label>
        จำนวนที่คาดว่าจะใช้
        <input
          class="survey-quantity"
          type="number"
          min="0.01"
          step="any"
          placeholder="ระบุจำนวน"
          required
        >
      </label>
      <label>
        เหตุผล / รายละเอียด
        <input
          class="survey-reason"
          type="text"
          maxlength="500"
          placeholder="ระบุเหตุผลที่ต้องใช้"
          required
        >
      </label>
    </div>
    <button
      class="btn btn-remove-survey-item"
      type="button"
      aria-label="ลบรายการวัสดุ"
      title="ลบรายการ"
    >
      ลบรายการ
    </button>
  `;

  row.querySelector(".survey-item-name").value = values.itemName || "";
  row.querySelector(".survey-quantity").value = values.expectedQty || "";
  row.querySelector(".survey-reason").value = values.reason || "";
  container.append(row);
  updateSurveyRowControls();
}

function updateSurveyRowControls() {
  const rows = document.querySelectorAll("#survey-items .survey-item-row");
  rows.forEach((row) => {
    const removeButton = row.querySelector(".btn-remove-survey-item");
    removeButton.disabled = rows.length === 1;
  });
}

function resetSurveyItemRows(items = [{}]) {
  const container = $("survey-items");
  if (!container) return;

  container.replaceChildren();
  items.forEach((item) => addSurveyItemRow(item));
}

async function submitSurvey(event) {
  event.preventDefault();

  const button = $("submit-survey");
  const surveyMonth = $("survey-month").value;
  const department = $("survey-department").value;
  const rows = [...document.querySelectorAll("#survey-items .survey-item-row")];
  const items = rows.map((row) => ({
    row,
    itemName: row.querySelector(".survey-item-name").value.trim(),
    expectedQty: numberValue(row.querySelector(".survey-quantity").value),
    reason: row.querySelector(".survey-reason").value.trim()
  }));

  if (!surveyMonth || !department || items.some((item) =>
    !item.itemName || !item.reason || item.expectedQty <= 0
  )) {
    $("survey-form").reportValidity();
    return;
  }

  // ตรวจสอบวันที่ตามเวลาไทย
  const thaiDate = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "Asia/Bangkok"
    })
  );

  if (thaiDate.getDate() > 10) {
    showMessage(
      "การสำรวจรายเดือนบันทึกได้เฉพาะวันที่ 1–10 ของเดือน",
      "error"
    );
    return;
  }

  setLoading(button, true);
  $("add-survey-item").disabled = true;
  document.querySelectorAll("#survey-items input").forEach((input) => {
    input.disabled = true;
  });
  document.querySelectorAll(".btn-remove-survey-item").forEach((removeButton) => {
    removeButton.disabled = true;
  });

  try {
    const savedItems = [];
    const failedItems = [];

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      button.textContent = `กำลังบันทึก ${index + 1}/${items.length}...`;

      try {
        const result = await apiPost({
          action: "survey",
          survey_month: surveyMonth,
          department,
          item_name: item.itemName,
          expected_qty: item.expectedQty,
          reason: item.reason
        });

        savedItems.push(result.data || {
          survey_month: surveyMonth,
          department,
          item_name: item.itemName,
          expected_qty: item.expectedQty,
          reason: item.reason
        });
      } catch (error) {
        console.error(`Survey item ${index + 1} error:`, error);
        failedItems.push(item);
      }
    }

    state.surveys.push(...savedItems);
    renderDashboard();
    renderSurveys();

    if (failedItems.length) {
      resetSurveyItemRows(failedItems);
      showMessage(
        `บันทึกสำเร็จ ${savedItems.length} รายการ และไม่สำเร็จ ${failedItems.length} รายการ รายการที่ไม่สำเร็จยังอยู่ในฟอร์ม`,
        savedItems.length ? "warning" : "error"
      );
    } else {
      $("survey-form").reset();
      resetSurveyItemRows();
      setDefaultSurveyMonth();
      showPage("survey");
      showMessage(`บันทึกการสำรวจสำเร็จ ${savedItems.length} รายการ`, "success");
    }

  } catch (error) {
    console.error("Survey error:", error);
    showMessage(error.message, "error");
  } finally {
    setLoading(button, false);
    $("add-survey-item").disabled = false;
    document.querySelectorAll("#survey-items input").forEach((input) => {
      input.disabled = false;
    });
    updateSurveyRowControls();
  }
}

// ======================================================
// 15. INITIALIZE
// ======================================================

function setDefaultSurveyMonth() {
  const input = $("survey-month");
  if (!input) return;

  input.value = getBangkokDateString().slice(0, 7);
}

function setDashboardDate() {
  const element = $("dashboard-date");
  if (!element) return;

  element.textContent = new Intl.DateTimeFormat("th-TH", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok"
  }).format(new Date());
}

function setDefaultDashboardFilters() {
  const startInput = $("dashboard-start-month");
  const endInput = $("dashboard-end-month");
  if (!startInput || !endInput) return;

  const [year, month] = getBangkokDateString().slice(0, 7).split("-").map(Number);
  const current = new Date(year, month - 1, 1);
  const start = new Date(current.getFullYear(), current.getMonth() - 11, 1);
  const toMonthValue = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

  startInput.value = toMonthValue(start);
  endInput.value = toMonthValue(current);
}

function handleDashboardFilterChange() {
  const startMonth = $("dashboard-start-month").value;
  const endMonth = $("dashboard-end-month").value;
  const monthRange = getMonthRange(startMonth, endMonth);

  if (startMonth && endMonth && startMonth > endMonth) {
    showMessage("เดือนเริ่มต้นต้องไม่อยู่หลังเดือนสิ้นสุด", "warning");
    return;
  }

  if (startMonth && endMonth && !monthRange.length) {
    showMessage("เลือกช่วงเวลาไม่เกิน 36 เดือน", "warning");
    return;
  }

  renderDashboard();
}

function initializeApp() {
  setupNavigation();
  applyTheme(document.documentElement.dataset.theme || "light", false);
  setDefaultDashboardFilters();

  $("theme-toggle")?.addEventListener("click", () => {
    const currentTheme = document.documentElement.dataset.theme;
    applyTheme(currentTheme === "dark" ? "light" : "dark");
  });

  $("refresh-btn")?.addEventListener("click", () => {
    loadData(true);
  });

  $("refresh-requisitions")?.addEventListener("click", async () => {
    await loadData(true);
  });
  ["requisition-search", "requisition-start-date", "requisition-end-date",
    "requisition-department-filter", "requisition-item-filter"]
    .forEach((id) => {
      $(id)?.addEventListener("input", renderRequisitions);
      $(id)?.addEventListener("change", renderRequisitions);
    });
  $("reset-requisition-filters")?.addEventListener("click", () => {
    ["requisition-search", "requisition-start-date", "requisition-end-date",
      "requisition-department-filter", "requisition-item-filter"]
      .forEach((id) => {
        if ($(id)) $(id).value = "";
      });
    renderRequisitions();
  });
  $("requisitions-body")?.addEventListener("click", (event) => {
    const viewButton = event.target.closest(".btn-view-requisition");
    const editButton = event.target.closest(".btn-edit-requisition");
    const deleteButton = event.target.closest(".btn-delete-requisition");
    if (viewButton) viewRequisition(viewButton.dataset.requisitionNo);
    if (editButton) editRequisition(editButton.dataset.requisitionNo);
    if (deleteButton) deleteRequisition(deleteButton.dataset.requisitionNo);
  });

  $("inventory-search")?.addEventListener("input", () => {
    inventoryPage = 1;
    renderInventory();
  });
  $("inventory-pagination")?.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-inventory-page]");
    if (!pageButton || pageButton.disabled) return;
    inventoryPage = Number(pageButton.dataset.inventoryPage);
    renderInventory();
  });
  $("admin-mode-btn")?.addEventListener("click", toggleAdminMode);
  $("inventory-body")?.addEventListener("click", (event) => {
    const editButton = event.target.closest(".btn-edit-stock");
    if (!editButton) return;
    editInventoryStock(editButton.dataset.itemId);
  });
  ["dashboard-start-month", "dashboard-end-month", "dashboard-department"]
    .forEach((id) => {
      $(id)?.addEventListener("change", handleDashboardFilterChange);
    });
  $("reset-dashboard-filters")?.addEventListener("click", () => {
    setDefaultDashboardFilters();
    if ($("dashboard-department")) $("dashboard-department").value = "";
    renderDashboard();
  });

  $("add-requisition-item")?.addEventListener("click", () => {
    addRequisitionItemRow();
    $("requisition-items .requisition-item-row:last-child .requisition-item-category")?.focus();
  });
  $("requisition-items")?.addEventListener("input", () => {
    document.querySelectorAll("#requisition-items .requisition-item-row")
      .forEach(updateRequisitionItemInfo);
  });
  $("requisition-items")?.addEventListener("change", (event) => {
    const row = event.target.closest(".requisition-item-row");
    if (row && event.target.matches(".requisition-item-category, .requisition-item-name")) {
      renderRequisitionItemOptions(row);
    }
    document.querySelectorAll("#requisition-items .requisition-item-row")
      .forEach(updateRequisitionItemInfo);
  });
  $("requisition-items")?.addEventListener("click", (event) => {
    const removeButton = event.target.closest(".btn-remove-requisition-item");
    if (!removeButton) return;
    removeButton.closest(".requisition-item-row")?.remove();
    updateRequisitionRowControls();
    document.querySelectorAll("#requisition-items .requisition-item-row")
      .forEach(updateRequisitionItemInfo);
  });

  $("requisition-form")?.addEventListener(
    "submit",
    submitRequisition
  );
  $("requisition-form")?.addEventListener("reset", () => {
    window.setTimeout(resetRequisitionItemRows, 0);
  });

  $("survey-form")?.addEventListener("submit", submitSurvey);
  $("add-survey-item")?.addEventListener("click", () => {
    addSurveyItemRow();
    $("survey-items .survey-item-row:last-child .survey-item-name")?.focus();
  });
  $("survey-items")?.addEventListener("click", (event) => {
    const removeButton = event.target.closest(".btn-remove-survey-item");
    if (!removeButton) return;

    removeButton.closest(".survey-item-row")?.remove();
    updateSurveyRowControls();
  });
  $("survey-form")?.addEventListener("reset", () => {
    window.setTimeout(() => {
      resetSurveyItemRows();
      setDefaultSurveyMonth();
    }, 0);
  });

  setDefaultSurveyMonth();
  setDashboardDate();
  updateRequisitionRowControls();
  updateSurveyRowControls();

  loadData();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApp);
} else {
  initializeApp();
}
