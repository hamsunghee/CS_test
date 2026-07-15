/**
 * 반품 검수 MVP - Google Apps Script backend
 *
 * 이번 버전 변경사항:
 * - doGet?action=lookup&productBarcode=상품바코드 조회 추가
 * - 상품리스트 탭에서 상품바코드/바코드번호 기준으로 주문번호·상품명 자동 매칭
 * - GitHub Pages 같은 외부 정적 사이트에서도 읽을 수 있도록 JSONP callback 지원
 *
 * 설치 위치:
 * 1) 기존 Google Apps Script 프로젝트 열기
 * 2) 이 파일 전체를 붙여넣기
 * 3) PRODUCT_SPREADSHEET_ID / PRODUCT_SHEET_NAME 확인
 * 4) 배포 > 배포 관리 > 새 버전 배포 또는 새 배포 > 웹 앱
 *    - 실행 권한: 나
 *    - 액세스 권한: 모든 사용자 또는 회사 정책에 맞는 사용자
 * 5) 생성된 Web App URL을 app.js의 DEFAULT_GAS_URL 또는 앱 설정 화면에 입력
 */

// 반품 검수 결과가 저장될 탭 이름입니다.
const SHEET_NAME = '반품검수대장';
const PHOTO_FOLDER_NAME = '반품검수사진';

// 이 값을 비워두면 이 스크립트가 연결된 스프레드시트에 저장합니다.
// standalone Apps Script에서 쓰거나 저장 시트를 고정하고 싶으면 기록용 스프레드시트 ID를 넣으세요.
const RECORD_SPREADSHEET_ID = '';

// 상품 바코드 스캔 후 상품명을 자동 조회할 원본 스프레드시트/탭입니다.
const PRODUCT_SPREADSHEET_ID = '1lWJmD91V-i3f_GrLqn3DGwuZih2InxxzCc3v_uB0VzQ';
const PRODUCT_SHEET_NAME = '상품리스트';

// true로 바꾸면 사진 파일을 링크가 있는 모든 사용자가 볼 수 있게 공유합니다.
// 회사 내부 자료라면 false 유지 후, 폴더/시트 권한을 필요한 직원에게만 공유하세요.
const MAKE_PHOTO_LINK_PUBLIC = false;

const HEADERS = [
  '저장일시',
  '상품바코드',
  '송장번호',
  '주문번호',
  '상품명',
  '반품사유',
  '기타상세',
  '검수결과',
  '메모',
  '사진개수',
  '사진링크',
  '담당자',
  '기기정보',
  '원본ID',
  '수신일시',
  '소스'
];

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const action = String(params.action || '').toLowerCase();

  if (action === 'lookup') {
    return lookupInvoice_(e);
  }

  return jsonOrJsonpOutput_(e, {
    ok: true,
    service: 'return-inspection-mvp',
    message: '반품 검수 Google Apps Script Web App is running. POST 저장 또는 GET ?action=lookup&productBarcode=상품바코드 조회를 사용할 수 있습니다.',
    sheetName: SHEET_NAME,
    productSheetName: PRODUCT_SHEET_NAME,
    now: new Date().toISOString()
  });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    const payload = parsePayload(e);
    const ss = getRecordSpreadsheet_();
    const sheet = ensureSheet(ss);

    const photos = Array.isArray(payload.photos) ? payload.photos : [];
    const photoLinks = savePhotosToDrive_(photos, payload);

    sheet.appendRow([
      safe(payload.createdAt),
      asText(payload.productBarcode),
      asText(payload.invoiceNumber),
      asText(payload.orderNumber),
      safe(payload.productName),
      safe(payload.returnReason),
      safe(payload.returnReasonDetail),
      safe(payload.inspectionResult),
      safe(payload.memo),
      photoLinks.length,
      photoLinks.join('\n'),
      safe(payload.workerName),
      safe(payload.deviceInfo),
      safe(payload.id),
      new Date(),
      safe(payload.source)
    ]);

    return jsonOutput({
      ok: true,
      saved: true,
      photoCount: photoLinks.length,
      photoLinks: photoLinks
    });
  } catch (err) {
    console.error(err);
    return jsonOutput({
      ok: false,
      error: String(err && err.message ? err.message : err)
    });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

function lookupInvoice_(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const barcode = String(params.productBarcode || params.barcode || params.invoice || params.tracking || '').trim();
    if (!barcode) {
      return jsonOrJsonpOutput_(e, { ok: false, found: false, error: 'productBarcode parameter is required' });
    }

    const ss = SpreadsheetApp.openById(PRODUCT_SPREADSHEET_ID);
    const sheet = ss.getSheetByName(PRODUCT_SHEET_NAME);
    if (!sheet) throw new Error('상품리스트 탭을 찾을 수 없습니다: ' + PRODUCT_SHEET_NAME);

    const values = sheet.getDataRange().getDisplayValues();
    if (!values || values.length < 2) {
      return jsonOrJsonpOutput_(e, { ok: true, found: false, productBarcode: barcode, message: '상품리스트에 조회할 데이터가 없습니다.' });
    }

    const headers = values[0].map(function (v) { return String(v || '').trim(); });
    const barcodeCol = findColumn_(headers, [
      '상품바코드', '상품 바코드', '상품바코드번호', '제품바코드', '제품 바코드',
      '바코드번호', '바코드', 'barcode', 'productbarcode', 'product barcode', 'jan', 'ean', 'upc',
      '단품코드', '품목코드', '상품코드', '옵션코드', 'sku', 'itemcode', 'productcode'
    ]);
    const orderCol = findColumn_(headers, ['주문번호', '주문번호쇼핑몰', '쇼핑몰주문번호', '주문코드', 'order', 'orderno', 'orderid']);
    const productCol = findColumn_(headers, ['상품명', '제품명', '품목명', '상품', 'product', 'productname', 'item', 'itemname']);
    const codeCol = findColumn_(headers, ['단품코드', '품목코드', '상품코드', '옵션코드', 'sku', 'itemcode', 'productcode']);
    const optionCol = findColumn_(headers, ['옵션', '옵션명', '옵션정보', '규격', '색상', '사이즈', 'option']);
    const quantityCol = findColumn_(headers, ['수량', '주문수량', 'qty', 'quantity']);

    // 상품바코드 컬럼명을 찾지 못하면 1열을 기준으로 매칭합니다.
    const matchCol = barcodeCol >= 0 ? barcodeCol : 0;
    const target = normalizeLookupKey_(barcode);
    let foundRow = null;
    let rowIndex = -1;

    for (let i = 1; i < values.length; i += 1) {
      const row = values[i];
      const cellKey = normalizeLookupKey_(row[matchCol]);
      if (cellKey && cellKey === target) {
        foundRow = row;
        rowIndex = i + 1;
        break;
      }
    }

    if (!foundRow) {
      return jsonOrJsonpOutput_(e, {
        ok: true,
        found: false,
        productBarcode: barcode,
        matchedColumn: headers[matchCol] || 'A열',
        message: '상품리스트에서 일치하는 상품 바코드를 찾지 못했습니다.'
      });
    }

    const productName = valueAt_(foundRow, productCol);
    const productCode = valueAt_(foundRow, codeCol);
    const option = valueAt_(foundRow, optionCol);
    const quantity = valueAt_(foundRow, quantityCol);
    const orderNumber = valueAt_(foundRow, orderCol);
    const productDisplay = [productName, option, productCode].filter(function (v) { return v; }).join(' / ');

    return jsonOrJsonpOutput_(e, {
      ok: true,
      found: true,
      productBarcode: barcode,
      rowNumber: rowIndex,
      matchedColumn: headers[matchCol] || 'A열',
      data: {
        productBarcode: barcode,
        orderNumber: orderNumber,
        productName: productName,
        productCode: productCode,
        option: option,
        quantity: quantity,
        productDisplay: productDisplay || productName || productCode || ''
      }
    });
  } catch (err) {
    console.error(err);
    return jsonOrJsonpOutput_(e, {
      ok: false,
      found: false,
      error: String(err && err.message ? err.message : err)
    });
  }
}

function getRecordSpreadsheet_() {
  if (RECORD_SPREADSHEET_ID) return SpreadsheetApp.openById(RECORD_SPREADSHEET_ID);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('기록용 스프레드시트를 찾을 수 없습니다. 스프레드시트에 연결된 Apps Script에서 실행하거나 RECORD_SPREADSHEET_ID를 입력하세요.');
  }
  return ss;
}

function parsePayload(e) {
  if (!e) throw new Error('No event object');

  if (e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (jsonErr) {
      // form-urlencoded로 payload 필드에 들어오는 경우도 대응
      if (e.parameter && e.parameter.payload) {
        return JSON.parse(e.parameter.payload);
      }
      throw new Error('POST body JSON parse failed: ' + jsonErr.message);
    }
  }

  if (e.parameter && e.parameter.payload) {
    return JSON.parse(e.parameter.payload);
  }

  throw new Error('POST body is empty');
}

function ensureSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  const lastCol = Math.max(sheet.getLastColumn(), HEADERS.length);
  const firstRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const hasHeader = firstRow.some(function (v) { return v !== ''; });

  if (!hasHeader) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#0f172a')
      .setFontColor('#ffffff');
    sheet.autoResizeColumns(1, HEADERS.length);
    return sheet;
  }

  // 이전 버전 시트에는 '상품바코드' 컬럼이 없을 수 있습니다.
  // 기존 데이터 컬럼 밀림을 막기 위해 저장일시 바로 뒤에 새 컬럼을 삽입합니다.
  const normalized = firstRow.map(normalizeHeader_);
  if (normalized.indexOf(normalizeHeader_('상품바코드')) === -1) {
    sheet.insertColumnAfter(1);
    sheet.getRange(1, 2).setValue('상품바코드');
  }

  const headerRange = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), HEADERS.length));
  headerRange
    .setFontWeight('bold')
    .setBackground('#0f172a')
    .setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, Math.max(sheet.getLastColumn(), HEADERS.length));

  return sheet;
}

function savePhotosToDrive_(photos, payload) {
  if (!photos.length) return [];

  const folder = getOrCreateFolder_(PHOTO_FOLDER_NAME);
  const invoice = sanitizeFileName_(payload.invoiceNumber || payload.productBarcode || 'no-code');
  const rowId = sanitizeFileName_(payload.id || Utilities.getUuid());
  const links = [];

  photos.forEach(function (dataUrl, index) {
    if (!dataUrl || typeof dataUrl !== 'string') return;

    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return;

    const contentType = match[1];
    const extension = contentType.indexOf('png') > -1 ? 'png' : contentType.indexOf('webp') > -1 ? 'webp' : 'jpg';
    const bytes = Utilities.base64Decode(match[2]);
    const fileName = `${invoice}_${rowId}_${index + 1}.${extension}`;
    const blob = Utilities.newBlob(bytes, contentType, fileName);
    const file = folder.createFile(blob);

    if (MAKE_PHOTO_LINK_PUBLIC) {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }

    links.push(file.getUrl());
  });

  return links;
}

function getOrCreateFolder_(name) {
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

function findColumn_(headers, candidates) {
  const normalizedHeaders = headers.map(normalizeHeader_);
  const normalizedCandidates = candidates.map(normalizeHeader_);

  for (let i = 0; i < normalizedCandidates.length; i += 1) {
    const exactIdx = normalizedHeaders.indexOf(normalizedCandidates[i]);
    if (exactIdx >= 0) return exactIdx;
  }

  for (let h = 0; h < normalizedHeaders.length; h += 1) {
    for (let c = 0; c < normalizedCandidates.length; c += 1) {
      if (normalizedHeaders[h] && normalizedCandidates[c] && normalizedHeaders[h].indexOf(normalizedCandidates[c]) >= 0) return h;
    }
  }

  return -1;
}

function normalizeHeader_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()\[\]{}<>:;,.\/\\|_\-]/g, '');
}

function normalizeLookupKey_(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z가-힣]/g, '');
}

function valueAt_(row, index) {
  if (index < 0 || index >= row.length) return '';
  return safe(row[index]).trim();
}

function sanitizeFileName_(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|#%{}~&]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function asText(value) {
  const v = safe(value);
  return v ? "'" + v : '';
}

function safe(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonOrJsonpOutput_(e, obj) {
  const callback = e && e.parameter ? String(e.parameter.callback || '') : '';
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(callback)) {
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(obj) + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonOutput(obj);
}
