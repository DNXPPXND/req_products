const CONFIG = {
  API_VERSION: "2026-11-19-performance-email-v3",
  TIME_ZONE: "Asia/Bangkok",
  SHEETS: {
    INVENTORY: "Inventory",
    REQUISITIONS: "Requisitions",
    SURVEYS: "Monthly_Survey",
    DEPARTMENTS: "Departments",
    STOCK_ADJUSTMENTS: "Stock_Adjustments",
    EMAIL_QUEUE: "Requisition_Email_Queue"
  },
  HEADERS: {
    INVENTORY: [
      "item_id",
      "item_name",
      "category",
      "unit",
      "current_stock",
      "min_threshold"
    ],
    REQUISITIONS: [
      "requisition_no",
      "request_date",
      "department",
      "requester_name",
      "item_id",
      "item_name",
      "quantity",
      "remark",
      "created_at"
    ],
    SURVEYS: [
      "survey_id",
      "survey_month",
      "department",
      "item_name",
      "expected_qty",
      "reason",
      "created_at"
    ],
    DEPARTMENTS: [
      "dept_name",
      "dept_category"
    ],
    STOCK_ADJUSTMENTS: [
      "adjustment_no",
      "adjustment_date",
      "item_id",
      "item_name",
      "previous_stock",
      "new_stock",
      "reason",
      "admin"
    ],
    EMAIL_QUEUE: [
      "notification_id",
      "created_at",
      "requisition_no",
      "recipient",
      "request_date",
      "requester_name",
      "items_json",
      "remark",
      "status",
      "attempts",
      "processing_started_at",
      "last_error",
      "sent_at"
    ]
  },
  ADMIN: {
    // PIN hash is saved in Script Properties by setAdminPin(); never put the PIN here.
    PIN_HASH_PROPERTY: "ADMIN_PIN_SHA256",
    FAILED_ATTEMPTS_CACHE_KEY: "ADMIN_PIN_FAILED_ATTEMPTS",
    MAX_FAILED_ATTEMPTS: 5,
    TOKEN_TTL_SECONDS: 900,
    LOCKOUT_SECONDS: 900
  },
  EMAIL: {
    RECIPIENT_PROPERTY: "REQUISITION_NOTIFICATION_EMAIL",
    TRIGGER_CONFIGURED_PROPERTY: "REQUISITION_EMAIL_TRIGGER_CONFIGURED",
    MAX_ATTEMPTS: 5,
    BATCH_SIZE: 10
  },
  CACHE: {
    DATA_KEY: "INVENTORY_DASHBOARD_DATA_V1",
    DATA_TTL_SECONDS: 10,
    MAX_VALUE_BYTES: 95000
  }
};


function doGet(e) {
  try {
    const action = e && e.parameter && e.parameter.action
      ? e.parameter.action
      : "getData";

    if (action !== "getData") {
      return jsonResponse({
        success: false,
        message: "ไม่พบคำสั่งที่ร้องขอ"
      });
    }

    let cache;
    try {
      cache = CacheService.getScriptCache();
      const cachedData = cache.get(CONFIG.CACHE.DATA_KEY);
      if (cachedData) return jsonResponse(JSON.parse(cachedData));
    } catch (cacheError) {
      console.warn("Dashboard data cache read failed:", cacheError);
    }

    const spreadsheet = getSpreadsheet_();
    const data = {
      success: true,
      api_version: CONFIG.API_VERSION,
      capabilities: {
        grouped_requisition_edit: true,
        queued_requisition_email: true
      },
      inventory: getSheetData_(CONFIG.SHEETS.INVENTORY, spreadsheet),
      departments: getSheetData_(CONFIG.SHEETS.DEPARTMENTS, spreadsheet),
      requisitions: getSheetData_(CONFIG.SHEETS.REQUISITIONS, spreadsheet),
      surveys: getSheetData_(CONFIG.SHEETS.SURVEYS, spreadsheet)
    };
    const serializedData = JSON.stringify(data);
    try {
      if (!cache) cache = CacheService.getScriptCache();
      if (Utilities.newBlob(serializedData).getBytes().length <=
        CONFIG.CACHE.MAX_VALUE_BYTES) {
        cache.put(
          CONFIG.CACHE.DATA_KEY,
          serializedData,
          CONFIG.CACHE.DATA_TTL_SECONDS
        );
      } else {
        cache.remove(CONFIG.CACHE.DATA_KEY);
      }
    } catch (cacheError) {
      console.warn("Dashboard data cache write failed:", cacheError);
    }
    return jsonResponse(data);
  } catch (error) {
    console.error("GET error:", error);
    return jsonResponse({ success: false, message: error.message });
  }
}


function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("ไม่พบข้อมูลที่ส่งมาจากหน้าเว็บ");
    }

    const payload = JSON.parse(e.postData.contents);
    const action = String(payload.action || "").trim();
    let result;

    if (action === "adminLogin") {
      result = handleAdminLogin_(payload);
    } else if (action === "adminLogout") {
      result = handleAdminLogout_(payload);
    } else if (action === "requisition") {
      result = withScriptLock_(() => handleRequisition_(payload));
    } else if (action === "editRequisition") {
      result = withScriptLock_(() => Array.isArray(payload.items)
        ? handleRequisitionGroupEdit_(payload)
        : handleRequisitionEdit_(payload));
    } else if (action === "deleteRequisition") {
      result = withScriptLock_(() => handleRequisitionDelete_(payload));
    } else if (action === "updateStock") {
      result = withScriptLock_(() => handleStockUpdate_(payload));
    } else if (action === "survey") {
      result = handleSurvey_(payload);
    } else if (action === "import_json") {
      result = withScriptLock_(() => handleImportInventory_(payload));
    } else {
      throw new Error("ไม่พบคำสั่ง: " + action);
    }

    if ([
      "requisition",
      "editRequisition",
      "deleteRequisition",
      "updateStock",
      "survey",
      "import_json"
    ].includes(action)) {
      invalidateDashboardDataCache_();
    }

    return jsonResponse({
      success: true,
      api_version: CONFIG.API_VERSION,
      message: result.message,
      data: result.data || null
    });
  } catch (error) {
    console.error("POST error:", error);
    return jsonResponse({ success: false, message: error.message });
  }
}


function withScriptLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}


function getSpreadsheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error(
      "ไม่พบ Google Spreadsheet กรุณาผูก Apps Script กับ Google Sheets"
    );
  }
  return spreadsheet;
}


function getSheet_(sheetName, headers) {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
    return sheet;
  }

  const currentHeaders = sheet
    .getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1))
    .getDisplayValues()[0]
    .map(value => String(value).trim());

  headers.forEach(header => {
    if (!findHeaderIndex_(currentHeaders, header)) {
      const newColumn = sheet.getLastColumn() + 1;
      sheet.getRange(1, newColumn).setValue(header).setFontWeight("bold");
      currentHeaders.push(header);
    }
  });

  sheet.setFrozenRows(1);
  return sheet;
}


function normalizeHeader_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-\/]+/g, "_");
}


function findHeaderIndex_(headers, name) {
  const target = normalizeHeader_(name);
  const index = headers.findIndex(header =>
    normalizeHeader_(header) === target
  );
  return index === -1 ? 0 : index + 1;
}


function getSheetData_(sheetName, spreadsheet) {
  const requiredHeaders = getHeadersForSheet_(sheetName);
  const sourceSpreadsheet = spreadsheet || getSpreadsheet_();
  let sheet = sourceSpreadsheet.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() === 0) {
    sheet = getSheet_(sheetName, requiredHeaders);
  }

  let lastRow = sheet.getLastRow();
  let lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) return [];

  let values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const currentHeaders = values[0].map((header) => String(header).trim());
  if (requiredHeaders.some((header) => !findHeaderIndex_(currentHeaders, header))) {
    sheet = getSheet_(sheetName, requiredHeaders);
    lastRow = sheet.getLastRow();
    lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn < 1) return [];
    values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  }
  if (lastRow < 2) return [];

  const keys = values[0].map(normalizeHeader_);

  return values.slice(1)
    .filter(row => row.some(value => value !== "" && value !== null))
    .map(row => {
      const record = {};
      keys.forEach((key, index) => {
        if (key) record[key] = serializeValue_(row[index]);
      });
      return record;
    });
}


function invalidateDashboardDataCache_() {
  try {
    CacheService.getScriptCache().remove(CONFIG.CACHE.DATA_KEY);
  } catch (error) {
    console.warn("Dashboard data cache invalidation failed:", error);
  }
}


function getHeadersForSheet_(sheetName) {
  switch (sheetName) {
    case CONFIG.SHEETS.INVENTORY:
      return CONFIG.HEADERS.INVENTORY;
    case CONFIG.SHEETS.REQUISITIONS:
      return CONFIG.HEADERS.REQUISITIONS;
    case CONFIG.SHEETS.SURVEYS:
      return CONFIG.HEADERS.SURVEYS;
    case CONFIG.SHEETS.DEPARTMENTS:
      return CONFIG.HEADERS.DEPARTMENTS;
    case CONFIG.SHEETS.STOCK_ADJUSTMENTS:
      return CONFIG.HEADERS.STOCK_ADJUSTMENTS;
    case CONFIG.SHEETS.EMAIL_QUEUE:
      return CONFIG.HEADERS.EMAIL_QUEUE;
    default:
      throw new Error("ไม่พบชื่อ Sheet: " + sheetName);
  }
}


function serializeValue_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(
      value,
      CONFIG.TIME_ZONE,
      "yyyy-MM-dd HH:mm:ss"
    );
  }
  return value;
}


function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


function findColumn_(headers, aliases) {
  const normalized = headers.map(normalizeHeader_);
  for (const alias of aliases) {
    const index = normalized.indexOf(normalizeHeader_(alias));
    if (index !== -1) return index;
  }
  return -1;
}


function getValue_(obj, aliases) {
  const keys = Object.keys(obj || {});
  for (const alias of aliases) {
    const target = normalizeHeader_(alias);
    const key = keys.find(candidate =>
      normalizeHeader_(candidate) === target
    );
    if (key !== undefined && obj[key] !== "") return obj[key];
  }
  return "";
}


function sha256Base64_(value) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, "");
}


function constantTimeEquals_(first, second) {
  const left = String(first);
  const right = String(second);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^
      (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}


function handleAdminLogin_(payload) {
  return withScriptLock_(() => {
    const cache = CacheService.getScriptCache();
    const attempts = Number(
      cache.get(CONFIG.ADMIN.FAILED_ATTEMPTS_CACHE_KEY) || 0
    );

    if (attempts >= CONFIG.ADMIN.MAX_FAILED_ATTEMPTS) {
      throw new Error("ใส่รหัสผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่");
    }

    const configuredHash = PropertiesService
      .getScriptProperties()
      .getProperty(CONFIG.ADMIN.PIN_HASH_PROPERTY);
    if (!configuredHash) {
      throw new Error(
        "ยังไม่ได้ตั้งรหัสผู้ดูแล: เปิดโปรเจกต์ Apps Script ที่ Deploy Web App นี้ " +
        "เลือกฟังก์ชัน setAdminPin แล้วกด Run เพื่อตั้งรหัส"
      );
    }

    const pin = String(payload.pin || "");
    if (!constantTimeEquals_(sha256Base64_(pin), configuredHash)) {
      cache.put(
        CONFIG.ADMIN.FAILED_ATTEMPTS_CACHE_KEY,
        String(attempts + 1),
        CONFIG.ADMIN.LOCKOUT_SECONDS
      );
      throw new Error("รหัสผู้ดูแลไม่ถูกต้อง");
    }

    cache.remove(CONFIG.ADMIN.FAILED_ATTEMPTS_CACHE_KEY);
    const token = Utilities.getUuid() + "." + Utilities.getUuid();
    cache.put(
      "ADMIN_TOKEN_" + sha256Base64_(token),
      "valid",
      CONFIG.ADMIN.TOKEN_TTL_SECONDS
    );

    return {
      message: "ยืนยันสิทธิ์ผู้ดูแลสำเร็จ",
      data: { admin_token: token }
    };
  });
}


function handleAdminLogout_(payload) {
  const token = String(payload.admin_token || "");
  if (token) {
    CacheService.getScriptCache().remove(
      "ADMIN_TOKEN_" + sha256Base64_(token)
    );
  }
  return { message: "ออกจากโหมดผู้ดูแลแล้ว" };
}


function requireAdminToken_(payload) {
  const token = String(payload.admin_token || "");
  if (!token || !CacheService.getScriptCache().get(
    "ADMIN_TOKEN_" + sha256Base64_(token)
  )) {
    throw new Error("สิทธิ์ผู้ดูแลหมดอายุหรือไม่ถูกต้อง กรุณายืนยันรหัสอีกครั้ง");
  }
}


function handleRequisition_(payload) {
  const requisitionSheet = getSheet_(
    CONFIG.SHEETS.REQUISITIONS,
    CONFIG.HEADERS.REQUISITIONS
  );
  const department = String(
    getValue_(payload, ["department", "dept_name"])
  ).trim();
  const requesterName = String(getValue_(
    payload,
    ["requester_name", "requester", "name"]
  )).trim();
  const remark = String(
    getValue_(payload, ["remark", "reason", "note"])
  ).trim();

  if (!requesterName) throw new Error("กรุณาระบุชื่อผู้เบิก");

  const requestedItems = Array.isArray(payload.items)
    ? payload.items
    : [{
        item_id: getValue_(payload, ["item_id", "itemId"]),
        quantity: getValue_(payload, ["quantity", "qty"])
      }];
  if (!requestedItems.length) throw new Error("กรุณาเพิ่มวัสดุที่ต้องการเบิก");

  const items = requestedItems.map((requestedItem) => {
    const itemId = String(getValue_(requestedItem, ["item_id", "itemId"])).trim();
    const quantity = Number(getValue_(requestedItem, ["quantity", "qty"]));
    if (!itemId) throw new Error("กรุณาเลือกวัสดุที่ต้องการเบิกทุกรายการ");
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("จำนวนที่เบิกทุกรายการต้องมากกว่า 0");
    }
    return { itemId, quantity };
  });

  const requestedById = new Map();
  items.forEach(({ itemId, quantity }) => {
    requestedById.set(itemId, (requestedById.get(itemId) || 0) + quantity);
  });
  const inventoryById = getInventoryRecords_([...requestedById.keys()]);

  requestedById.forEach((quantity, itemId) => {
    const inventory = inventoryById.get(itemId);
    if (quantity > inventory.currentStock) {
      throw new Error(
        "วัสดุ " + inventory.itemName + " ไม่เพียงพอ: คงเหลือ " +
        inventory.currentStock + " แต่ต้องการเบิกรวม " + quantity
      );
    }
  });

  const now = new Date();
  const requisitionNo = createDocumentNo_("REQ");
  const requisitionHeaders = requisitionSheet
    .getRange(1, 1, 1, requisitionSheet.getLastColumn())
    .getDisplayValues()[0];
  const requestDate = Utilities.formatDate(
    now,
    CONFIG.TIME_ZONE,
    "yyyy-MM-dd"
  );
  const records = items.map(({ itemId, quantity }) => {
    const inventory = inventoryById.get(itemId);
    const record = {
      requisition_no: requisitionNo,
      request_date: requestDate,
      department: department,
      requester_name: requesterName,
      item_id: itemId,
      item_name: inventory.itemName,
      unit: inventory.unit,
      quantity: quantity,
      remark: remark,
      created_at: now
    };
    return requisitionHeaders.map((header) => {
      const key = normalizeHeader_(header);
      return Object.prototype.hasOwnProperty.call(record, key)
        ? record[key]
        : "";
    });
  });

  const originalLastRow = requisitionSheet.getLastRow();
  const updatedInventories = [];
  try {
    requestedById.forEach((quantity, itemId) => {
      const inventory = inventoryById.get(itemId);
      inventory.sheet
        .getRange(inventory.rowNumber, inventory.stockIndex + 1)
        .setValue(inventory.currentStock - quantity);
      updatedInventories.push(inventory);
    });
    requisitionSheet
      .getRange(originalLastRow + 1, 1, records.length, requisitionHeaders.length)
      .setValues(records);
  } catch (error) {
    const appendedRows = requisitionSheet.getLastRow() - originalLastRow;
    if (appendedRows > 0) {
      try {
        requisitionSheet.deleteRows(originalLastRow + 1, appendedRows);
      } catch (rollbackError) {
        console.error("Requisition rows rollback failed:", rollbackError);
      }
    }
    updatedInventories.forEach((inventory) => {
      try {
        inventory.sheet
          .getRange(inventory.rowNumber, inventory.stockIndex + 1)
          .setValue(inventory.currentStock);
      } catch (rollbackError) {
        console.error("Requisition stock rollback failed:", rollbackError);
      }
    });
    throw error;
  }

  const responseItems = items.map(({ itemId, quantity }) => {
    const inventory = inventoryById.get(itemId);
    return {
      item_id: itemId,
      item_name: inventory.itemName,
      unit: inventory.unit,
      quantity: quantity,
      previous_stock: inventory.currentStock,
      current_stock: inventory.currentStock - requestedById.get(itemId)
    };
  });

  return {
    message: "บันทึกใบเบิกและตัดสต็อกเรียบร้อยแล้ว",
    data: {
      requisition_no: requisitionNo,
      items: responseItems,
      item_id: responseItems[0].item_id,
      item_name: responseItems[0].item_name,
      quantity: responseItems[0].quantity,
      previous_stock: responseItems[0].previous_stock,
      current_stock: responseItems[0].current_stock,
      department: department,
      requester_name: requesterName,
      email_notification: enqueueRequisitionEmail_({
        requisition_no: requisitionNo,
        request_date: requestDate,
        requester_name: requesterName,
        items: responseItems,
        remark: remark
      })
    }
  };
}


function handleRequisitionEdit_(payload) {
  const requisitionNo = String(payload.requisition_no || "").trim();
  const requestDate = String(payload.request_date || "").trim();
  const department = String(payload.department || "").trim();
  const requesterName = String(payload.requester_name || "").trim();
  const itemId = String(payload.item_id || "").trim();
  const quantity = Number(payload.quantity);
  const remark = String(payload.remark || "").trim();

  if (!requisitionNo) throw new Error("ไม่พบเลขที่ใบเบิก");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestDate)) {
    throw new Error("กรุณาระบุวันที่เบิกให้ถูกต้อง");
  }
  const dateParts = requestDate.split("-").map(Number);
  const parsedDate = new Date(Date.UTC(
    dateParts[0],
    dateParts[1] - 1,
    dateParts[2]
  ));
  if (
    parsedDate.getUTCFullYear() !== dateParts[0] ||
    parsedDate.getUTCMonth() !== dateParts[1] - 1 ||
    parsedDate.getUTCDate() !== dateParts[2]
  ) {
    throw new Error("วันที่เบิกไม่มีอยู่จริง");
  }
  if (!requesterName || requesterName.length > 150) {
    throw new Error("กรุณาระบุชื่อผู้เบิกไม่เกิน 150 ตัวอักษร");
  }
  if (remark.length > 1000) throw new Error("หมายเหตุต้องไม่เกิน 1,000 ตัวอักษร");
  if (!itemId) throw new Error("กรุณาเลือกวัสดุ");
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("จำนวนที่เบิกต้องมากกว่า 0");
  }

  const requisitionSheet = getSheet_(
    CONFIG.SHEETS.REQUISITIONS,
    CONFIG.HEADERS.REQUISITIONS
  );
  const requisitionHeaders = requisitionSheet
    .getRange(1, 1, 1, requisitionSheet.getLastColumn())
    .getDisplayValues()[0];
  const requisitionNoIndex = findColumn_(requisitionHeaders, ["requisition_no"]);
  const requestDateIndex = findColumn_(requisitionHeaders, ["request_date"]);
  const departmentIndex = findColumn_(requisitionHeaders, ["department"]);
  const requesterIndex = findColumn_(requisitionHeaders, ["requester_name"]);
  const itemIdIndex = findColumn_(requisitionHeaders, ["item_id"]);
  const itemNameIndex = findColumn_(requisitionHeaders, ["item_name"]);
  const quantityIndex = findColumn_(requisitionHeaders, ["quantity"]);
  const remarkIndex = findColumn_(requisitionHeaders, ["remark"]);
  const requiredIndexes = [
    requisitionNoIndex, requestDateIndex, departmentIndex, requesterIndex,
    itemIdIndex, itemNameIndex, quantityIndex, remarkIndex
  ];
  if (requiredIndexes.some(index => index < 0)) {
    throw new Error("Sheet Requisitions ขาดคอลัมน์ที่จำเป็นสำหรับแก้ไขรายการ");
  }

  const lastRequisitionRow = requisitionSheet.getLastRow();
  if (lastRequisitionRow < 2) throw new Error("ไม่พบรายการเบิกที่ต้องการแก้ไข");
  const requisitionValues = requisitionSheet
    .getRange(2, 1, lastRequisitionRow - 1, requisitionHeaders.length)
    .getValues();
  const matches = [];
  requisitionValues.forEach((row, index) => {
    if (String(row[requisitionNoIndex]).trim() === requisitionNo) {
      matches.push({ rowNumber: index + 2, values: row });
    }
  });
  if (!matches.length) throw new Error("ไม่พบรายการเบิกเลขที่ " + requisitionNo);
  if (matches.length > 1) throw new Error("พบเลขที่ใบเบิกซ้ำ กรุณาตรวจสอบ Sheet Requisitions");

  const record = matches[0];
  const oldItemId = String(record.values[itemIdIndex]).trim();
  const oldQuantity = Number(record.values[quantityIndex]);
  if (!oldItemId || !Number.isFinite(oldQuantity) || oldQuantity <= 0) {
    throw new Error("ข้อมูลวัสดุหรือจำนวนเดิมไม่ถูกต้อง จึงไม่สามารถปรับสต็อกได้");
  }

  const inventories = getInventoryRecords_([oldItemId, itemId]);
  const inventory = inventories.get(oldItemId);
  const newInventory = inventories.get(itemId);
  const previousStocks = new Map([
    [inventory.rowNumber, inventory.currentStock]
  ]);
  if (newInventory.rowNumber !== inventory.rowNumber) {
    previousStocks.set(newInventory.rowNumber, newInventory.currentStock);
  }

  let oldItemStock = inventory.currentStock;
  let newItemStock = newInventory.currentStock;
  if (oldItemId === itemId) {
    newItemStock = inventory.currentStock + oldQuantity - quantity;
    if (newItemStock < 0) {
      throw new Error(
        "ยอดคงเหลือไม่พอสำหรับจำนวนใหม่: มี " +
        (inventory.currentStock + oldQuantity) + " แต่ต้องการ " + quantity
      );
    }
  } else {
    oldItemStock = inventory.currentStock + oldQuantity;
    if (quantity > newInventory.currentStock) {
      throw new Error(
        "วัสดุใหม่มีไม่เพียงพอ: คงเหลือ " +
        newInventory.currentStock + " แต่ต้องการ " + quantity
      );
    }
    newItemStock = newInventory.currentStock - quantity;
  }

  const updatedValues = record.values.slice();
  updatedValues[requestDateIndex] = requestDate;
  updatedValues[departmentIndex] = department;
  updatedValues[requesterIndex] = requesterName;
  updatedValues[itemIdIndex] = itemId;
  updatedValues[itemNameIndex] = newInventory.itemName;
  updatedValues[quantityIndex] = quantity;
  updatedValues[remarkIndex] = remark;

  try {
    if (oldItemId === itemId) {
      inventory.sheet
        .getRange(inventory.rowNumber, inventory.stockIndex + 1)
        .setValue(newItemStock);
    } else {
      inventory.sheet
        .getRange(inventory.rowNumber, inventory.stockIndex + 1)
        .setValue(oldItemStock);
      newInventory.sheet
        .getRange(newInventory.rowNumber, newInventory.stockIndex + 1)
        .setValue(newItemStock);
    }
    requisitionSheet
      .getRange(record.rowNumber, 1, 1, requisitionHeaders.length)
      .setValues([updatedValues]);
  } catch (error) {
    previousStocks.forEach((stock, rowNumber) => {
      const target = rowNumber === inventory.rowNumber ? inventory : newInventory;
      try {
        target.sheet.getRange(rowNumber, target.stockIndex + 1).setValue(stock);
      } catch (rollbackError) {
        console.error("Requisition edit stock rollback failed:", rollbackError);
      }
    });
    throw error;
  }

  return {
    message: "แก้ไขรายการเบิกและปรับยอดคงเหลือเรียบร้อยแล้ว",
    data: {
      requisition_no: requisitionNo,
      request_date: requestDate,
      department: department,
      requester_name: requesterName,
      item_id: itemId,
      item_name: newInventory.itemName,
      quantity: quantity,
      remark: remark,
      current_stock: newItemStock,
      previous_item_id: oldItemId,
      previous_item_stock: oldItemStock
    }
  };
}


function handleRequisitionGroupEdit_(payload) {
  const requisitionNo = String(payload.requisition_no || "").trim();
  const requestDate = String(payload.request_date || "").trim();
  const requesterName = String(payload.requester_name || "").trim();
  const remark = String(payload.remark || "").trim();
  const requestedItems = Array.isArray(payload.items) ? payload.items : [];

  if (!requisitionNo) throw new Error("ไม่พบเลขที่ใบเบิก");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestDate)) {
    throw new Error("กรุณาระบุวันที่เบิกให้ถูกต้อง");
  }
  const dateParts = requestDate.split("-").map(Number);
  const parsedDate = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]));
  if (
    parsedDate.getUTCFullYear() !== dateParts[0] ||
    parsedDate.getUTCMonth() !== dateParts[1] - 1 ||
    parsedDate.getUTCDate() !== dateParts[2]
  ) {
    throw new Error("วันที่เบิกไม่มีอยู่จริง");
  }
  if (!requesterName || requesterName.length > 150) {
    throw new Error("กรุณาระบุชื่อผู้เบิกไม่เกิน 150 ตัวอักษร");
  }
  if (remark.length > 1000) throw new Error("หมายเหตุต้องไม่เกิน 1,000 ตัวอักษร");
  if (!requestedItems.length) throw new Error("กรุณาเพิ่มวัสดุอย่างน้อย 1 รายการ");

  const newItems = requestedItems.map((item) => {
    const itemId = String(getValue_(item, ["item_id", "itemId"])).trim();
    const quantity = Number(getValue_(item, ["quantity", "qty"]));
    if (!itemId) throw new Error("กรุณาเลือกวัสดุทุกรายการ");
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("จำนวนที่เบิกทุกรายการต้องมากกว่า 0");
    }
    return { itemId, quantity };
  });

  const sheet = getSheet_(CONFIG.SHEETS.REQUISITIONS, CONFIG.HEADERS.REQUISITIONS);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const indexes = {
    requisitionNo: findColumn_(headers, ["requisition_no"]),
    requestDate: findColumn_(headers, ["request_date"]),
    department: findColumn_(headers, ["department"]),
    requester: findColumn_(headers, ["requester_name"]),
    itemId: findColumn_(headers, ["item_id"]),
    itemName: findColumn_(headers, ["item_name"]),
    quantity: findColumn_(headers, ["quantity"]),
    remark: findColumn_(headers, ["remark"])
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    throw new Error("Sheet Requisitions ขาดคอลัมน์ที่จำเป็นสำหรับแก้ไขรายการ");
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("ไม่พบรายการเบิกที่ต้องการแก้ไข");
  const allRows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const oldRows = [];
  allRows.forEach((values, index) => {
    if (String(values[indexes.requisitionNo]).trim() === requisitionNo) {
      oldRows.push({ rowNumber: index + 2, values });
    }
  });
  if (!oldRows.length) throw new Error("ไม่พบรายการเบิกเลขที่ " + requisitionNo);

  const oldQuantityByItem = new Map();
  oldRows.forEach(({ values }) => {
    const itemId = String(values[indexes.itemId]).trim();
    const quantity = Number(values[indexes.quantity]);
    if (!itemId || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("ข้อมูลวัสดุหรือจำนวนเดิมไม่ถูกต้อง จึงไม่สามารถปรับสต็อกได้");
    }
    oldQuantityByItem.set(itemId, (oldQuantityByItem.get(itemId) || 0) + quantity);
  });

  const newQuantityByItem = new Map();
  newItems.forEach(({ itemId, quantity }) => {
    newQuantityByItem.set(itemId, (newQuantityByItem.get(itemId) || 0) + quantity);
  });
  const inventoryById = getInventoryRecords_([
    ...new Set([...oldQuantityByItem.keys(), ...newQuantityByItem.keys()])
  ]);

  const updatedStocks = new Map();
  inventoryById.forEach((inventory, itemId) => {
    const newStock = inventory.currentStock +
      (oldQuantityByItem.get(itemId) || 0) -
      (newQuantityByItem.get(itemId) || 0);
    if (newStock < 0) {
      throw new Error(
        "วัสดุ " + inventory.itemName + " คงเหลือไม่พอสำหรับจำนวนใหม่"
      );
    }
    updatedStocks.set(itemId, newStock);
  });

  const replacementRows = newItems.map(({ itemId, quantity }, index) => {
    const values = (oldRows[index] || oldRows[0]).values.slice();
    values[indexes.requestDate] = requestDate;
    values[indexes.requester] = requesterName;
    values[indexes.itemId] = itemId;
    values[indexes.itemName] = inventoryById.get(itemId).itemName;
    values[indexes.quantity] = quantity;
    values[indexes.remark] = remark;
    return values;
  });
  const updatedExistingRows = [];
  const deletedRows = [];
  let appendedRowStart = 0;
  let appendedRowCount = 0;

  try {
    inventoryById.forEach((inventory, itemId) => {
      inventory.sheet
        .getRange(inventory.rowNumber, inventory.stockIndex + 1)
        .setValue(updatedStocks.get(itemId));
    });

    const updatedCount = Math.min(oldRows.length, replacementRows.length);
    for (let index = 0; index < updatedCount; index++) {
      sheet.getRange(oldRows[index].rowNumber, 1, 1, headers.length)
        .setValues([replacementRows[index]]);
      updatedExistingRows.push(oldRows[index]);
    }
    if (oldRows.length > replacementRows.length) {
      oldRows.slice(replacementRows.length).sort((a, b) => b.rowNumber - a.rowNumber)
        .forEach((row) => {
          sheet.deleteRow(row.rowNumber);
          deletedRows.push(row);
        });
    } else if (replacementRows.length > oldRows.length) {
      appendedRowStart = sheet.getLastRow() + 1;
      appendedRowCount = replacementRows.length - oldRows.length;
      sheet.getRange(
        appendedRowStart,
        1,
        appendedRowCount,
        headers.length
      ).setValues(replacementRows.slice(oldRows.length));
    }
  } catch (error) {
    if (appendedRowCount) {
      try {
        sheet.deleteRows(appendedRowStart, appendedRowCount);
      } catch (rollbackError) {
        console.error("Requisition edit appended rows rollback failed:", rollbackError);
      }
    }
    deletedRows.sort((a, b) => a.rowNumber - b.rowNumber).forEach((row) => {
      try {
        sheet.insertRowsBefore(row.rowNumber, 1);
        sheet.getRange(row.rowNumber, 1, 1, headers.length).setValues([row.values]);
      } catch (rollbackError) {
        console.error("Requisition edit deleted rows rollback failed:", rollbackError);
      }
    });
    updatedExistingRows.forEach((row) => {
      try {
        sheet.getRange(row.rowNumber, 1, 1, headers.length).setValues([row.values]);
      } catch (rollbackError) {
        console.error("Requisition edit row rollback failed:", rollbackError);
      }
    });
    inventoryById.forEach((inventory) => {
      try {
        inventory.sheet
          .getRange(inventory.rowNumber, inventory.stockIndex + 1)
          .setValue(inventory.currentStock);
      } catch (rollbackError) {
        console.error("Requisition edit stock rollback failed:", rollbackError);
      }
    });
    throw error;
  }

  return {
    message: "แก้ไขรายละเอียดใบเบิกและปรับยอดคงเหลือเรียบร้อยแล้ว",
    data: {
      requisition_no: requisitionNo,
      request_date: requestDate,
      requester_name: requesterName,
      items: newItems.map(({ itemId, quantity }) => ({
        item_id: itemId,
        item_name: inventoryById.get(itemId).itemName,
        quantity
      }))
    }
  };
}


function handleRequisitionDelete_(payload) {
  const requisitionNo = String(payload.requisition_no || "").trim();
  if (!requisitionNo) throw new Error("ไม่พบเลขที่ใบเบิก");

  const requisitionSheet = getSheet_(
    CONFIG.SHEETS.REQUISITIONS,
    CONFIG.HEADERS.REQUISITIONS
  );
  const headers = requisitionSheet
    .getRange(1, 1, 1, requisitionSheet.getLastColumn())
    .getDisplayValues()[0];
  const requisitionNoIndex = findColumn_(headers, ["requisition_no"]);
  const itemIdIndex = findColumn_(headers, ["item_id"]);
  const quantityIndex = findColumn_(headers, ["quantity"]);
  if (requisitionNoIndex < 0 || itemIdIndex < 0 || quantityIndex < 0) {
    throw new Error("Sheet Requisitions ขาดคอลัมน์ที่จำเป็นสำหรับลบรายการ");
  }

  const lastRow = requisitionSheet.getLastRow();
  if (lastRow < 2) throw new Error("ไม่พบรายการเบิกที่ต้องการลบ");
  const values = requisitionSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const matches = [];
  values.forEach((row, index) => {
    if (String(row[requisitionNoIndex]).trim() === requisitionNo) {
      matches.push({ rowNumber: index + 2, values: row });
    }
  });
  if (!matches.length) throw new Error("ไม่พบรายการเบิกเลขที่ " + requisitionNo);

  const requestedById = new Map();
  matches.forEach((record) => {
    const itemId = String(record.values[itemIdIndex]).trim();
    const quantity = Number(record.values[quantityIndex]);
    if (!itemId || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("ข้อมูลวัสดุหรือจำนวนเดิมไม่ถูกต้อง จึงไม่สามารถคืนสต็อกได้");
    }
    requestedById.set(itemId, (requestedById.get(itemId) || 0) + quantity);
  });
  const inventoryById = getInventoryRecords_([...requestedById.keys()]);

  const updatedInventories = [];
  const deletedRecords = [];
  try {
    requestedById.forEach((quantity, itemId) => {
      const inventory = inventoryById.get(itemId);
      inventory.sheet
        .getRange(inventory.rowNumber, inventory.stockIndex + 1)
        .setValue(inventory.currentStock + quantity);
      updatedInventories.push(inventory);
    });
    matches.sort((a, b) => b.rowNumber - a.rowNumber).forEach((record) => {
      requisitionSheet.deleteRow(record.rowNumber);
      deletedRecords.push(record);
    });
  } catch (error) {
    deletedRecords.sort((a, b) => a.rowNumber - b.rowNumber).forEach((record) => {
      try {
        requisitionSheet.insertRowsBefore(record.rowNumber, 1);
        requisitionSheet
          .getRange(record.rowNumber, 1, 1, headers.length)
          .setValues([record.values]);
      } catch (rollbackError) {
        console.error("Requisition delete row rollback failed:", rollbackError);
      }
    });
    updatedInventories.forEach((inventory) => {
      try {
        inventory.sheet
          .getRange(inventory.rowNumber, inventory.stockIndex + 1)
          .setValue(inventory.currentStock);
      } catch (rollbackError) {
        console.error("Requisition delete stock rollback failed:", rollbackError);
      }
    });
    throw error;
  }

  const returnedItems = [...requestedById.entries()].map(([itemId, quantity]) => {
    const inventory = inventoryById.get(itemId);
    return {
      item_id: itemId,
      quantity: quantity,
      current_stock: inventory.currentStock + quantity
    };
  });
  const firstReturnedItem = returnedItems[0];
  return {
    message: "ลบใบเบิกและคืนวัสดุเข้าคลังเรียบร้อยแล้ว",
    data: {
      requisition_no: requisitionNo,
      items: returnedItems,
      item_id: firstReturnedItem.item_id,
      quantity: firstReturnedItem.quantity,
      current_stock: firstReturnedItem.current_stock
    }
  };
}


function getInventoryRecords_(itemIds) {
  const requestedIds = [...new Set(itemIds.map((itemId) =>
    String(itemId || "").trim()
  ))];
  if (!requestedIds.length || requestedIds.some((itemId) => !itemId)) {
    throw new Error("ไม่พบรหัสวัสดุที่ต้องการตรวจสอบ");
  }

  const sheet = getSheet_(
    CONFIG.SHEETS.INVENTORY,
    CONFIG.HEADERS.INVENTORY
  );
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("ไม่มีข้อมูลวัสดุในคลัง");

  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getDisplayValues()[0];
  const idIndex = findColumn_(headers, ["item_id", "itemId", "รหัสวัสดุ"]);
  const nameIndex = findColumn_(headers, ["item_name", "itemName", "ชื่อวัสดุ"]);
  const unitIndex = findColumn_(headers, ["unit", "หน่วย"]);
  const stockIndex = findColumn_(
    headers,
    ["current_stock", "currentStock", "stock", "คงเหลือ"]
  );
  if (idIndex < 0 || nameIndex < 0 || stockIndex < 0) {
    throw new Error("Inventory ต้องมีคอลัมน์ item_id, item_name และ current_stock");
  }

  const values = sheet
    .getRange(2, 1, lastRow - 1, sheet.getLastColumn())
    .getValues();
  const requestedSet = new Set(requestedIds);
  const inventoryById = new Map();
  values.forEach((row, index) => {
    const itemId = String(row[idIndex] || "").trim();
    if (!requestedSet.has(itemId)) return;
    if (inventoryById.has(itemId)) {
      throw new Error("พบรหัสวัสดุซ้ำ กรุณาแก้ข้อมูล Inventory ก่อน");
    }

    const rawStock = row[stockIndex];
    const currentStock = Number(
      typeof rawStock === "string" ? rawStock.replace(/,/g, "").trim() : rawStock
    );
    if (!Number.isFinite(currentStock) || currentStock < 0) {
      throw new Error("ยอดคงเหลือของวัสดุรหัส " + itemId + " ไม่ถูกต้อง");
    }
    inventoryById.set(itemId, {
      sheet: sheet,
      rowNumber: index + 2,
      itemId: itemId,
      itemName: String(row[nameIndex] || "").trim(),
      unit: unitIndex < 0 ? "" : String(row[unitIndex] || "").trim(),
      currentStock: currentStock,
      stockIndex: stockIndex
    });
  });

  requestedIds.forEach((itemId) => {
    if (!inventoryById.has(itemId)) {
      throw new Error("ไม่พบวัสดุรหัส " + itemId);
    }
  });
  return inventoryById;
}


function handleStockUpdate_(payload) {
  requireAdminToken_(payload);

  const itemId = String(payload.item_id || "").trim();
  const newStock = Number(payload.current_stock);
  const reason = String(payload.reason || "").trim();
  if (!itemId) throw new Error("ไม่พบรหัสวัสดุ");
  if (!Number.isFinite(newStock) || newStock < 0) {
    throw new Error("ยอดคงเหลือต้องเป็น 0 หรือมากกว่า");
  }
  if (!reason || reason.length > 300) {
    throw new Error("กรุณาระบุเหตุผลในการปรับยอดไม่เกิน 300 ตัวอักษร");
  }

  const inventorySheet = getSheet_(
    CONFIG.SHEETS.INVENTORY,
    CONFIG.HEADERS.INVENTORY
  );
  const lastRow = inventorySheet.getLastRow();
  if (lastRow < 2) throw new Error("ไม่มีข้อมูลวัสดุในคลัง");

  const headers = inventorySheet
    .getRange(1, 1, 1, inventorySheet.getLastColumn())
    .getDisplayValues()[0];
  const idIndex = findColumn_(headers, ["item_id", "itemId", "รหัสวัสดุ"]);
  const nameIndex = findColumn_(headers, ["item_name", "itemName", "ชื่อวัสดุ"]);
  const stockIndex = findColumn_(
    headers,
    ["current_stock", "currentStock", "stock", "คงเหลือ"]
  );
  if (idIndex < 0 || nameIndex < 0 || stockIndex < 0) {
    throw new Error(
      "Sheet Inventory ต้องมีคอลัมน์ item_id, item_name และ current_stock"
    );
  }

  const matches = inventorySheet
    .getRange(2, idIndex + 1, lastRow - 1, 1)
    .createTextFinder(itemId)
    .matchEntireCell(true)
    .matchCase(true)
    .findAll();
  if (!matches.length) throw new Error("ไม่พบวัสดุรหัส " + itemId);
  if (matches.length > 1) throw new Error("พบรหัสวัสดุซ้ำใน Inventory");

  const rowNumber = matches[0].getRow();
  const previousStock = Number(
    inventorySheet.getRange(rowNumber, stockIndex + 1).getValue()
  );
  if (!Number.isFinite(previousStock) || previousStock < 0) {
    throw new Error("ยอดคงเหลือเดิมไม่ถูกต้อง กรุณาตรวจสอบ Inventory");
  }
  const itemName = String(
    inventorySheet.getRange(rowNumber, nameIndex + 1).getDisplayValue()
  ).trim();

  inventorySheet.getRange(rowNumber, stockIndex + 1).setValue(newStock);

  let auditWarning = "";
  try {
    const auditSheet = getSheet_(
      CONFIG.SHEETS.STOCK_ADJUSTMENTS,
      CONFIG.HEADERS.STOCK_ADJUSTMENTS
    );
    const auditHeaders = auditSheet
      .getRange(1, 1, 1, auditSheet.getLastColumn())
      .getDisplayValues()[0];
    const now = new Date();
    appendRecord_(auditSheet, auditHeaders, {
      adjustment_no: createDocumentNo_("ADJ"),
      adjustment_date: now,
      item_id: itemId,
      item_name: itemName,
      previous_stock: previousStock,
      new_stock: newStock,
      reason: reason,
      admin: "Admin PIN"
    });
  } catch (error) {
    console.error("Stock adjustment audit write failed:", error);
    auditWarning = " ปรับยอดแล้ว แต่บันทึกประวัติการปรับยอดไม่สำเร็จ";
  }

  return {
    message: "ปรับยอดคงเหลือเรียบร้อยแล้ว" + auditWarning,
    data: {
      item_id: itemId,
      item_name: itemName,
      previous_stock: previousStock,
      current_stock: newStock,
      reason: reason,
      audit_warning: auditWarning || null
    }
  };
}


function handleSurvey_(payload) {
  const sheet = getSheet_(
    CONFIG.SHEETS.SURVEYS,
    CONFIG.HEADERS.SURVEYS
  );
  const department = String(
    getValue_(payload, ["department", "dept_name"])
  ).trim();
  const itemName = String(
    getValue_(payload, ["item_name", "itemName"])
  ).trim();
  const expectedQty = Number(getValue_(
    payload,
    ["expected_qty", "expectedQty", "quantity", "qty"]
  ));
  const reason = String(
    getValue_(payload, ["reason", "remark", "note"])
  ).trim();
  const requestedMonth = String(payload.survey_month || "").trim();

  if (!department) throw new Error("กรุณาเลือกแผนก");
  if (!itemName) throw new Error("กรุณาระบุชื่อวัสดุ");
  if (!Number.isFinite(expectedQty) || expectedQty <= 0) {
    throw new Error("จำนวนวัสดุที่ต้องการต้องมากกว่า 0");
  }
  if (itemName.length > 200) throw new Error("ชื่อวัสดุต้องไม่เกิน 200 ตัวอักษร");
  if (!reason || reason.length > 500) {
    throw new Error("กรุณาระบุเหตุผลไม่เกิน 500 ตัวอักษร");
  }

  const now = new Date();
  const day = Number(Utilities.formatDate(
    now,
    CONFIG.TIME_ZONE,
    "d"
  ));
  if (day < 1 || day > 10) {
    throw new Error("ระบบสำรวจวัสดุเปิดให้บันทึกเฉพาะวันที่ 1-10 ของเดือน");
  }

  const surveyMonth = Utilities.formatDate(
    now,
    CONFIG.TIME_ZONE,
    "yyyy-MM"
  );
  if (requestedMonth && requestedMonth !== surveyMonth) {
    throw new Error("เลือกสำรวจได้เฉพาะเดือนปัจจุบัน");
  }

  const record = {
    survey_id: createDocumentNo_("SURVEY"),
    survey_month: surveyMonth,
    department: department,
    item_name: itemName,
    expected_qty: expectedQty,
    reason: reason,
    created_at: now
  };
  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getDisplayValues()[0];
  appendRecord_(sheet, headers, record);
  return { message: "บันทึกแบบสำรวจวัสดุเรียบร้อยแล้ว", data: record };
}


function handleImportInventory_(payload) {
  requireAdminToken_(payload);

  const rows = payload.data || payload.inventory;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("ข้อมูลนำเข้าต้องเป็น Array ที่มีรายการ");
  }

  const sheet = getSheet_(
    CONFIG.SHEETS.INVENTORY,
    CONFIG.HEADERS.INVENTORY
  );
  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getDisplayValues()[0];
  const idIndex = findColumn_(headers, ["item_id", "itemId", "รหัสวัสดุ"]);
  const nameIndex = findColumn_(headers, ["item_name", "itemName", "ชื่อวัสดุ"]);
  const categoryIndex = findColumn_(headers, ["category", "หมวดหมู่"]);
  const unitIndex = findColumn_(headers, ["unit", "หน่วย"]);
  const stockIndex = findColumn_(
    headers,
    ["current_stock", "currentStock", "stock", "คงเหลือ"]
  );
  const thresholdIndex = findColumn_(
    headers,
    ["min_threshold", "minThreshold", "ขั้นต่ำ"]
  );
  if (idIndex < 0 || nameIndex < 0 || stockIndex < 0) {
    throw new Error(
      "Inventory ต้องมีคอลัมน์ item_id, item_name และ current_stock"
    );
  }

  const output = rows.map((item, index) => {
    const id = getValue_(item, ["item_id", "itemId", "รหัสวัสดุ"]);
    const name = getValue_(item, ["item_name", "itemName", "ชื่อวัสดุ"]);
    const stock = Number(getValue_(
      item,
      ["current_stock", "currentStock", "stock", "คงเหลือ"]
    ));
    if (!String(id).trim() || !String(name).trim()) {
      throw new Error("รายการที่ " + (index + 1) + " ไม่มีรหัสหรือชื่อวัสดุ");
    }
    if (!Number.isFinite(stock) || stock < 0) {
      throw new Error("ยอดคงเหลือของรายการที่ " + (index + 1) + " ไม่ถูกต้อง");
    }

    const row = new Array(headers.length).fill("");
    row[idIndex] = id;
    row[nameIndex] = name;
    row[stockIndex] = stock;
    if (categoryIndex >= 0) {
      row[categoryIndex] = getValue_(item, ["category", "หมวดหมู่"]);
    }
    if (unitIndex >= 0) {
      row[unitIndex] = getValue_(item, ["unit", "หน่วย"]);
    }
    if (thresholdIndex >= 0) {
      const threshold = getValue_(item, [
        "min_threshold",
        "minThreshold",
        "ขั้นต่ำ"
      ]);
      row[thresholdIndex] = threshold === "" ? 0 : Number(threshold);
    }
    return row;
  });

  const oldLastRow = sheet.getLastRow();
  if (oldLastRow > 1) {
    sheet.getRange(2, 1, oldLastRow - 1, headers.length).clearContent();
  }
  sheet.getRange(2, 1, output.length, headers.length).setValues(output);
  return {
    message: "นำเข้าข้อมูล Inventory เรียบร้อยแล้ว",
    data: { imported: output.length }
  };
}


function appendRecord_(sheet, headers, record) {
  const row = headers.map(header => {
    const key = normalizeHeader_(header);
    return Object.prototype.hasOwnProperty.call(record, key)
      ? record[key]
      : "";
  });
  sheet.appendRow(row);
}


function enqueueRequisitionEmail_(requisition) {
  const properties = PropertiesService.getScriptProperties();
  const recipient = String(
    properties.getProperty(CONFIG.EMAIL.RECIPIENT_PROPERTY) || ""
  ).trim();
  if (!recipient) {
    return {
      status: "not_configured",
      message: "ยังไม่ได้ตั้งค่าอีเมลแจ้งเตือน"
    };
  }

  try {
    if (
      properties.getProperty(CONFIG.EMAIL.TRIGGER_CONFIGURED_PROPERTY) !== "true"
    ) {
      return {
        status: "trigger_not_configured",
        message: "ยังไม่ได้เปิดใช้งานตัวส่งอีเมลอัตโนมัติ"
      };
    }

    const sheet = getSheet_(
      CONFIG.SHEETS.EMAIL_QUEUE,
      CONFIG.HEADERS.EMAIL_QUEUE
    );
    appendRecord_(
      sheet,
      sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0],
      {
        notification_id: Utilities.getUuid(),
        created_at: new Date(),
        requisition_no: requisition.requisition_no,
        recipient: recipient,
        request_date: requisition.request_date,
        requester_name: requisition.requester_name,
        items_json: JSON.stringify(requisition.items),
        remark: requisition.remark,
        status: "queued",
        attempts: 0,
        processing_started_at: "",
        last_error: "",
        sent_at: ""
      }
    );

    return {
      status: "queued",
      message: "จัดคิวส่งอีเมลแจ้งเตือนแล้ว"
    };
  } catch (error) {
    console.error("Requisition email queue write failed:", error);
    return {
      status: "queue_failed",
      message: "บันทึกใบเบิกแล้ว แต่จัดคิวอีเมลแจ้งเตือนไม่สำเร็จ"
    };
  }
}


function setupRequisitionEmailNotifications() {
  // Run once from the Apps Script editor attached to the inventory spreadsheet.
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    "ตั้งค่าอีเมลแจ้งเตือนการเบิก",
    "ระบุอีเมลผู้รับ 1 รายหรือหลายราย คั่นด้วยเครื่องหมายจุลภาค",
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const recipients = response.getResponseText()
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  const invalidRecipients = recipients.filter((email) =>
    !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)
  );
  if (!recipients.length || invalidRecipients.length) {
    ui.alert("อีเมลไม่ถูกต้อง", "กรุณาตรวจสอบอีเมลและลองใหม่", ui.ButtonSet.OK);
    return;
  }

  const remainingQuota = MailApp.getRemainingDailyQuota();
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty(
    CONFIG.EMAIL.RECIPIENT_PROPERTY,
    recipients.join(",")
  );
  properties.setProperty(CONFIG.EMAIL.TRIGGER_CONFIGURED_PROPERTY, "false");

  const hasTrigger = ScriptApp.getProjectTriggers().some((trigger) =>
    trigger.getHandlerFunction() === "processRequisitionEmailQueue"
  );
  if (!hasTrigger) {
    ScriptApp.newTrigger("processRequisitionEmailQueue")
      .timeBased()
      .everyMinutes(1)
      .create();
  }
  properties.setProperty(CONFIG.EMAIL.TRIGGER_CONFIGURED_PROPERTY, "true");

  ui.alert(
    "ตั้งค่าเรียบร้อย",
    "ระบบจะส่งอีเมลแจ้งเตือนจากคิวทุก 1 นาที\n" +
      "ผู้รับ: " + recipients.join(", ") + "\n" +
      "โควตาผู้รับคงเหลือวันนี้: " + remainingQuota,
    ui.ButtonSet.OK
  );
}


function testRequisitionEmailNotification() {
  const ui = SpreadsheetApp.getUi();
  const recipient = String(
    PropertiesService.getScriptProperties()
      .getProperty(CONFIG.EMAIL.RECIPIENT_PROPERTY) || ""
  ).trim();
  if (!recipient) {
    ui.alert(
      "ยังไม่ได้ตั้งค่าอีเมล",
      "กรุณารัน setupRequisitionEmailNotifications ก่อน",
      ui.ButtonSet.OK
    );
    return;
  }

  const sender = Session.getEffectiveUser().getEmail() || "ไม่สามารถระบุได้";
  try {
    const remainingQuota = MailApp.getRemainingDailyQuota();
    MailApp.sendEmail({
      to: recipient,
      subject: "[ทดสอบ] ระบบแจ้งเตือนการเบิกวัสดุ",
      body:
        "นี่คืออีเมลทดสอบจากระบบเบิกวัสดุ\n" +
        "ผู้รับ: " + recipient + "\n" +
        "บัญชีที่สั่งส่ง: " + sender + "\n\n" +
        "การส่งคำขอสำเร็จไม่ได้ยืนยันว่าอีเมลถึง Inbox " +
        "กรุณาตรวจสอบ All Mail และ Spam/Junk",
      htmlBody:
        "<h2>ทดสอบระบบแจ้งเตือนการเบิกวัสดุ</h2>" +
        "<p>MailApp รับคำขอส่งอีเมลนี้แล้ว</p>" +
        "<p><strong>ผู้รับ:</strong> " + escapeEmailHTML_(recipient) + "<br>" +
        "<strong>บัญชีที่สั่งส่ง:</strong> " +
        escapeEmailHTML_(sender) + "</p>" +
        "<p>กรุณาตรวจสอบ Inbox, All Mail และ Spam/Junk</p>",
      name: "ระบบเบิกวัสดุ"
    });
    ui.alert(
      "MailApp รับคำขอส่งแล้ว",
      "ผู้รับ: " + recipient + "\n" +
        "บัญชีที่สั่งส่ง: " + sender + "\n" +
        "โควตาผู้รับคงเหลือวันนี้: " + remainingQuota + "\n\n" +
        "สถานะนี้ยังไม่ยืนยันการส่งถึง Inbox กรุณาตรวจสอบ All Mail และ Spam/Junk",
      ui.ButtonSet.OK
    );
  } catch (error) {
    console.error("Requisition email test failed:", error);
    ui.alert(
      "ส่งอีเมลทดสอบไม่สำเร็จ",
      String(error.message || error),
      ui.ButtonSet.OK
    );
  }
}


function processRequisitionEmailQueue() {
  const jobs = withScriptLock_(() => {
    const sheet = getSheet_(
      CONFIG.SHEETS.EMAIL_QUEUE,
      CONFIG.HEADERS.EMAIL_QUEUE
    );
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getDisplayValues()[0];
    const indexes = {};
    CONFIG.HEADERS.EMAIL_QUEUE.forEach((header) => {
      indexes[header] = findColumn_(headers, [header]);
    });
    if (Object.values(indexes).some((index) => index < 0)) {
      throw new Error("ชีตคิวอีเมลขาดคอลัมน์ที่จำเป็น");
    }

    const rows = sheet
      .getRange(2, 1, lastRow - 1, headers.length)
      .getValues();
    const claimed = [];
    const now = Date.now();

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const status = String(row[indexes.status] || "");
      const processingTime = new Date(
        row[indexes.processing_started_at]
      ).getTime();
      const staleClaim = status === "sending" &&
        (!Number.isFinite(processingTime) || now - processingTime > 10 * 60 * 1000);
      if (
        (status !== "queued" && !staleClaim) ||
        Number(row[indexes.attempts] || 0) >= CONFIG.EMAIL.MAX_ATTEMPTS ||
        claimed.length >= CONFIG.EMAIL.BATCH_SIZE
      ) {
        continue;
      }

      row[indexes.status] = "sending";
      row[indexes.attempts] = Number(row[indexes.attempts] || 0) + 1;
      row[indexes.processing_started_at] = new Date(now);
      row[indexes.last_error] = "";
      sheet.getRange(index + 2, 1, 1, headers.length).setValues([row]);
      claimed.push({
        rowNumber: index + 2,
        row: row,
        indexes: indexes,
        headers: headers
      });
    }

    return claimed;
  });

  let sent = 0;
  let failed = 0;
  jobs.forEach((job) => {
    let errorMessage = "";
    try {
      sendRequisitionEmail_(job.row, job.indexes);
      sent++;
    } catch (error) {
      console.error("Requisition email send failed:", error);
      errorMessage = String(error.message || error).slice(0, 1000);
      failed++;
    }
    completeRequisitionEmailJob_(job, errorMessage);
  });
  return { sent: sent, failed: failed };
}


function completeRequisitionEmailJob_(job, errorMessage) {
  withScriptLock_(() => {
    const sheet = getSheet_(
      CONFIG.SHEETS.EMAIL_QUEUE,
      CONFIG.HEADERS.EMAIL_QUEUE
    );
    const row = sheet
      .getRange(job.rowNumber, 1, 1, job.headers.length)
      .getValues()[0];
    const notificationIndex = job.indexes.notification_id;
    if (
      String(row[notificationIndex]) !==
      String(job.row[notificationIndex])
    ) {
      throw new Error("คิวอีเมลเปลี่ยนระหว่างส่ง กรุณาตรวจสอบรายการ");
    }

    const attempts = Number(row[job.indexes.attempts] || 0);
    row[job.indexes.status] = errorMessage
      ? attempts >= CONFIG.EMAIL.MAX_ATTEMPTS ? "failed" : "queued"
      : "submitted";
    row[job.indexes.processing_started_at] = "";
    row[job.indexes.last_error] = errorMessage;
    row[job.indexes.sent_at] = errorMessage ? "" : new Date();
    sheet.getRange(job.rowNumber, 1, 1, job.headers.length).setValues([row]);
  });
}


function sendRequisitionEmail_(row, indexes) {
  const value = (key) => row[indexes[key]];
  const items = JSON.parse(String(value("items_json") || "[]"));
  if (!Array.isArray(items) || !items.length) {
    throw new Error("ข้อมูลวัสดุในคิวอีเมลไม่ถูกต้อง");
  }

  const requisitionNo = String(value("requisition_no") || "");
  const requester = String(value("requester_name") || "-");
  const requestDate = String(value("request_date") || "-");
  const remark = String(value("remark") || "-");
  const itemRows = items.map((item) =>
    "<tr><td>" + escapeEmailHTML_(item.item_id) + "</td>" +
    "<td>" + escapeEmailHTML_(item.item_name) + "</td>" +
    "<td>" + escapeEmailHTML_(item.quantity) + "</td>" +
    "<td>" + escapeEmailHTML_(item.unit || "") + "</td></tr>"
  ).join("");
  const plainItems = items.map((item) =>
    "- " + String(item.item_name || item.item_id) +
    " (" + String(item.item_id) + ") x " + String(item.quantity) +
    (item.unit ? " " + String(item.unit) : "")
  ).join("\n");
  const body =
    "มีการเบิกวัสดุใหม่\n\n" +
    "เลขที่ใบเบิก: " + requisitionNo + "\n" +
    "วันที่: " + requestDate + "\n" +
    "ผู้เบิก: " + requester + "\n\n" +
    "รายการวัสดุ:\n" + plainItems + "\n\n" +
    "หมายเหตุ: " + remark;
  const htmlBody =
    "<h2>มีการเบิกวัสดุใหม่</h2>" +
    "<p><strong>เลขที่ใบเบิก:</strong> " + escapeEmailHTML_(requisitionNo) + "<br>" +
    "<strong>วันที่:</strong> " + escapeEmailHTML_(requestDate) + "<br>" +
    "<strong>ผู้เบิก:</strong> " + escapeEmailHTML_(requester) + "</p>" +
    "<table border=\"1\" cellpadding=\"6\" cellspacing=\"0\" " +
    "style=\"border-collapse:collapse\"><thead><tr><th>รหัสวัสดุ</th>" +
    "<th>ชื่อวัสดุ</th><th>จำนวน</th><th>หน่วย</th></tr></thead>" +
    "<tbody>" + itemRows + "</tbody></table>" +
    "<p><strong>หมายเหตุ:</strong> " + escapeEmailHTML_(remark) + "</p>";

  MailApp.sendEmail({
    to: String(value("recipient")),
    subject: "มีการเบิกวัสดุใหม่: " + requisitionNo,
    body: body,
    htmlBody: htmlBody,
    name: "ระบบเบิกวัสดุ"
  });
}


function escapeEmailHTML_(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}


function createDocumentNo_(prefix) {
  const timestamp = Utilities.formatDate(
    new Date(),
    CONFIG.TIME_ZONE,
    "yyyyMMdd-HHmmss"
  );
  const random = Math.floor(Math.random() * 900 + 100);
  return prefix + "-" + timestamp + "-" + random;
}


/**
 * ตั้งหรือเปลี่ยนรหัสผู้ดูแล:
 * 1. เปิดโปรเจกต์ Apps Script เดียวกับ Web App ที่หน้าเว็บเรียกใช้
 * 2. เลือก setAdminPin จากรายการฟังก์ชัน แล้วกด Run
 * 3. อนุญาตสิทธิ์และกรอกรหัสในหน้าต่างที่เปิดขึ้น
 * ระบบเก็บเฉพาะค่าแฮชใน Script Properties ไม่ต้องใส่รหัสในโค้ด
 */
function setAdminPin() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    "ตั้งรหัสผู้ดูแล",
    "กรอกรหัสอย่างน้อย 8 ตัวอักษร (แนะนำ 12 ตัวขึ้นไป) ระบบจะเก็บเฉพาะค่าแฮช",
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const pin = response.getResponseText();
  if (pin.length < 8) {
    ui.alert("รหัสต้องมีอย่างน้อย 8 ตัวอักษร");
    return;
  }

  PropertiesService.getScriptProperties().setProperty(
    CONFIG.ADMIN.PIN_HASH_PROPERTY,
    sha256Base64_(pin)
  );
  CacheService.getScriptCache().remove(
    CONFIG.ADMIN.FAILED_ATTEMPTS_CACHE_KEY
  );
  ui.alert("ตั้งรหัสผู้ดูแลแล้ว กรุณาปิด/เปิดหน้าเว็บใหม่ก่อนทดสอบ");
}


function testConnection() {
  const result = {
    spreadsheet: getSpreadsheet_().getName(),
    inventoryCount: getSheetData_(CONFIG.SHEETS.INVENTORY).length,
    departmentCount: getSheetData_(CONFIG.SHEETS.DEPARTMENTS).length,
    requisitionCount: getSheetData_(CONFIG.SHEETS.REQUISITIONS).length,
    surveyCount: getSheetData_(CONFIG.SHEETS.SURVEYS).length
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
