/*
 * F005 core — CSV 주문 검증·매출 요약 로직 (UMD: 브라우저 + Node 공용)
 *
 * 외부 라이브러리 없음. Node에서는 require('./core.js'),
 * 브라우저에서는 <script src="core.js"> 후 window.F005Core 로 사용한다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.F005Core = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REQUIRED_HEADERS = ['order_id', 'date', 'item', 'quantity', 'unit_price'];
  var MAX_BYTES = 1024 * 1024;
  var MAX_ROWS = 5000;

  var FATAL_MESSAGES = {
    EMPTY_INPUT: '입력된 데이터가 없습니다.',
    BYTE_LIMIT: '입력 크기가 1MB를 초과했습니다.',
    ROW_LIMIT: '데이터 행이 최대 5,000행을 초과했습니다.',
    UNCLOSED_QUOTE: '닫히지 않은 따옴표가 있습니다. CSV 형식을 확인해 주세요.',
    MALFORMED_QUOTE: '따옴표 위치가 올바르지 않습니다. CSV 형식을 확인해 주세요.',
    ENCODING_DAMAGE: '손상된 문자(U+FFFD)가 포함되어 있습니다. 입력 인코딩을 확인해 주세요.',
    HEADER_COLUMN_COUNT: '헤더 열 개수가 5개가 아닙니다.',
    DUPLICATE_HEADER: '헤더가 중복되었습니다.',
    MISSING_HEADER: '필수 헤더가 없습니다.'
  };

  /* 합성 샘플: 정상 3행(합계 45,000원) + 중복 1행 + 잘못된 날짜 1행 + 음수 수량 1행 */
  var SAMPLE_CSV = [
    'order_id,date,item,quantity,unit_price',
    'A-1001,2026-01-05,노트,2,10000',
    'A-1002,2026-01-06,펜,1,15000',
    'A-1003,2026-01-07,노트,2,5000',
    'A-1001,2026-01-08,지우개,1,3000',
    'A-1004,2026-02-30,펜,3,2000',
    'A-1005,2026-01-10,노트,-1,5000'
  ].join('\n') + '\n';

  function byteLength(str) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str).length;
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.byteLength(str, 'utf8');
    }
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  function fatal(code, detail) {
    var message = FATAL_MESSAGES[code] || '처리할 수 없습니다.';
    if (detail) message += ' (' + detail + ')';
    return {
      ok: false,
      fatal: { code: code, message: message, detail: detail || null },
      header: null,
      validRows: [],
      errors: [],
      items: [],
      summary: { validCount: 0, errorCount: 0, revenue: 0 }
    };
  }

  /*
   * RFC4180 유사 파서.
   * - BOM 제거, CRLF/LF/CR 처리
   * - 따옴표 필드 안의 쉼표·개행·"" 이스케이프 처리
   * - 각 행에 원본 줄 번호(1-based)를 기록
   */
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var rows = [];
    var cells = [];
    var field = '';
    var inQuotes = false;
    var quoteClosed = false;
    var i = 0;
    var n = text.length;
    var line = 1;
    var rowLine = 1;

    while (i < n) {
      var ch = text.charAt(i);

      if (inQuotes) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; quoteClosed = true; i += 1; continue;
        }
        if (ch === '\r') {
          if (text.charAt(i + 1) === '\n') { field += '\r\n'; i += 2; } else { field += '\r'; i += 1; }
          line += 1; continue;
        }
        if (ch === '\n') { field += '\n'; i += 1; line += 1; continue; }
        field += ch; i += 1; continue;
      }

      if (ch === '"') {
        if (field.length === 0 && !quoteClosed) { inQuotes = true; i += 1; continue; }
        return { error: 'MALFORMED_QUOTE' };
      }
      if (ch === ',') { cells.push(field); field = ''; quoteClosed = false; i += 1; continue; }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i += 2; else i += 1;
        cells.push(field); field = ''; quoteClosed = false;
        rows.push({ cells: cells, line: rowLine });
        cells = [];
        line += 1; rowLine = line;
        continue;
      }
      if (quoteClosed) return { error: 'MALFORMED_QUOTE' };
      field += ch; i += 1;
    }

    if (inQuotes) return { error: 'UNCLOSED_QUOTE' };
    cells.push(field);
    rows.push({ cells: cells, line: rowLine });
    return { rows: rows };
  }

  function isBlankRow(row) {
    return row.cells.length === 1 && row.cells[0].trim() === '';
  }

  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  function daysInMonth(y, m) {
    var table = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return table[m - 1];
  }

  function isValidDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var y = Number(s.slice(0, 4));
    var m = Number(s.slice(5, 7));
    var d = Number(s.slice(8, 10));
    if (y < 1 || y > 9999) return false;
    if (m < 1 || m > 12) return false;
    if (d < 1 || d > daysInMonth(y, m)) return false;
    return true;
  }

  /* 지수/Infinity/부호/소수점을 거부하기 위해 숫자 문자열을 정규식으로 먼저 제한한다. */
  function isNonNegativeInt(s) {
    if (!/^\d+$/.test(s)) return false;
    var v = Number(s);
    return Number.isSafeInteger(v) && v >= 0;
  }

  function isPositiveInt(s) {
    if (!/^\d+$/.test(s)) return false;
    var v = Number(s);
    return Number.isSafeInteger(v) && v > 0;
  }

  /*
   * 스프레드시트 수식 주입 방어:
   * ASCII 공백/제어문자뿐 아니라 JS whitespace(NBSP, U+2028/2029, U+FEFF 등)도
   * 앞쪽에서 건너뛴 뒤 첫 문자가 = + - @ 이면 apostrophe를 붙인다.
   */
  function isFormulaPadding(ch) {
    var code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
    return /\s/.test(ch);
  }

  function csvText(value) {
    var s = value === null || value === undefined ? '' : String(value);
    var j = 0;
    while (j < s.length && isFormulaPadding(s.charAt(j))) j += 1;
    var first = s.charAt(j);
    if (first === '=' || first === '+' || first === '-' || first === '@') s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function validateCsv(text) {
    if (typeof text !== 'string' || text.trim() === '') return fatal('EMPTY_INPUT');
    if (byteLength(text) > MAX_BYTES) return fatal('BYTE_LIMIT');
    if (text.indexOf('\uFFFD') !== -1) return fatal('ENCODING_DAMAGE');

    var parsed = parseCsv(text);
    if (parsed.error) return fatal(parsed.error);
    var rows = parsed.rows;

    var headerIndex = -1;
    for (var i = 0; i < rows.length; i++) {
      if (!isBlankRow(rows[i])) { headerIndex = i; break; }
    }
    if (headerIndex === -1) return fatal('EMPTY_INPUT');

    var headerCells = rows[headerIndex].cells.map(function (c) { return c.trim(); });
    if (headerCells.length !== REQUIRED_HEADERS.length) {
      return fatal('HEADER_COLUMN_COUNT', '실제 ' + headerCells.length + '개');
    }

    var seen = Object.create(null);
    var duplicates = [];
    var missing = [];
    for (var h = 0; h < headerCells.length; h++) {
      if (seen[headerCells[h]]) {
        if (duplicates.indexOf(headerCells[h]) === -1) duplicates.push(headerCells[h]);
      }
      seen[headerCells[h]] = true;
    }
    for (var r = 0; r < REQUIRED_HEADERS.length; r++) {
      if (!seen[REQUIRED_HEADERS[r]]) missing.push(REQUIRED_HEADERS[r]);
    }
    if (duplicates.length) return fatal('DUPLICATE_HEADER', duplicates.join(', '));
    if (missing.length) return fatal('MISSING_HEADER', missing.join(', '));

    var col = {};
    for (var c = 0; c < headerCells.length; c++) col[headerCells[c]] = c;

    var dataRows = [];
    for (var d = headerIndex + 1; d < rows.length; d++) {
      if (!isBlankRow(rows[d])) dataRows.push(rows[d]);
    }
    if (dataRows.length > MAX_ROWS) return fatal('ROW_LIMIT', '실제 ' + dataRows.length + '행');

    var validRows = [];
    var errors = [];
    var accepted = new Map();
    var itemMap = Object.create(null);
    var total = 0;

    for (var k = 0; k < dataRows.length; k++) {
      var row = dataRows[k];
      var cells = row.cells;

      if (cells.length !== headerCells.length) {
        errors.push({
          line: row.line,
          order_id: cells[col.order_id] ? cells[col.order_id].trim() : '',
          code: 'COLUMN_MISMATCH',
          reason: '열 개수가 헤더와 다릅니다(기대 ' + headerCells.length + '개, 실제 ' + cells.length + '개).'
        });
        continue;
      }

      var id = cells[col.order_id].trim();
      var date = cells[col.date].trim();
      var item = cells[col.item].trim();
      var qtyRaw = cells[col.quantity].trim();
      var priceRaw = cells[col.unit_price].trim();

      var code = null;
      var reason = null;

      if (id === '') {
        code = 'EMPTY_ID'; reason = 'order_id가 비어 있습니다.';
      } else if (item === '') {
        code = 'EMPTY_ITEM'; reason = 'item이 비어 있습니다.';
      } else if (!isValidDate(date)) {
        code = 'BAD_DATE'; reason = 'date가 YYYY-MM-DD 형식의 실제 달력 날짜가 아닙니다.';
      } else if (!isPositiveInt(qtyRaw)) {
        code = 'BAD_QUANTITY'; reason = 'quantity는 1 이상의 안전한 정수여야 합니다(지수/부호/소수 금지).';
      } else if (!isNonNegativeInt(priceRaw)) {
        code = 'BAD_PRICE'; reason = 'unit_price는 0 이상의 안전한 정수(KRW)여야 합니다(지수/부호/소수 금지).';
      } else {
        var qty = Number(qtyRaw);
        var price = Number(priceRaw);
        var amount = qty * price;
        var seenItem = itemMap[item];
        var itemQuantity = seenItem ? seenItem.quantity : 0;
        if (!Number.isSafeInteger(amount)) {
          code = 'AMOUNT_OVERFLOW'; reason = '금액(수량×단가)이 안전한 정수 범위를 초과했습니다.';
        } else if (!Number.isSafeInteger(total + amount)) {
          code = 'TOTAL_OVERFLOW'; reason = '유효매출 합계가 안전한 정수 범위를 초과했습니다.';
        } else if (accepted.has(id)) {
          code = 'DUPLICATE_ORDER'; reason = 'order_id가 중복되었습니다(앞선 유효행만 인정).';
        } else if (!Number.isSafeInteger(itemQuantity + qty)) {
          code = 'ITEM_QTY_OVERFLOW'; reason = '품목 수량 합계가 안전한 정수 범위를 초과했습니다.';
        } else {
          total += amount;
          accepted.set(id, true);
          if (!seenItem) itemMap[item] = { item: item, quantity: 0, revenue: 0 };
          itemMap[item].quantity += qty;
          itemMap[item].revenue += amount;
          validRows.push({
            line: row.line,
            order_id: id,
            date: date,
            item: item,
            quantity: qty,
            unit_price: price,
            amount: amount
          });
          continue;
        }
      }

      errors.push({ line: row.line, order_id: id, code: code, reason: reason });
    }

    var items = Object.keys(itemMap).map(function (key) { return itemMap[key]; });
    items.sort(function (a, b) {
      return b.revenue - a.revenue || a.item.localeCompare(b.item, 'ko');
    });

    return {
      ok: true,
      fatal: null,
      header: headerCells,
      validRows: validRows,
      errors: errors,
      items: items,
      summary: {
        validCount: validRows.length,
        errorCount: errors.length,
        revenue: total
      }
    };
  }

  function toValidCsv(result) {
    var lines = ['order_id,date,item,quantity,unit_price,amount'];
    result.validRows.forEach(function (row) {
      lines.push([
        csvText(row.order_id),
        csvText(row.date),
        csvText(row.item),
        String(row.quantity),
        String(row.unit_price),
        String(row.amount)
      ].join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  function toErrorCsv(result) {
    var lines = ['row_number,order_id,reason'];
    result.errors.forEach(function (row) {
      lines.push([
        String(row.line),
        csvText(row.order_id),
        csvText(row.reason)
      ].join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /* 자동 전송 기능이 없는 요청서 텍스트 템플릿(고객이 직접 작성). */
  function buildRequestTemplate() {
    return [
      '[작은 업무 자동화] 구축 요청서 (로컬 시연용 템플릿)',
      '',
      '※ 이 파일은 고객이 직접 작성해 보관하거나 담당자에게 전달하는 용도입니다.',
      '※ 시연 페이지는 이 요청서를 자동으로 전송하지 않습니다.',
      '',
      '1. 업무 내용',
      '   -',
      '',
      '2. 입력 파일 형식과 열',
      '   - 파일 종류(예: CSV, 스프레드시트 내보내기):',
      '   - 열 이름과 의미:',
      '',
      '3. 원하는 결과',
      '   - 결과 형태(예: 요약표, 검증 목록, DOCX 문서):',
      '   - 필요한 지표:',
      '',
      '4. 처리 빈도',
      '   - (예: 매일 1회, 주 1회, 월 1회)',
      '',
      '5. 실행 환경',
      '   - 운영체제:',
      '   - 사용 도구(엑셀/구글시트/기타):',
      '',
      '6. 희망 기한',
      '   -',
      '',
      '7. 예산 범위',
      '   -',
      '',
      '8. 샘플 데이터 제공 가능 여부',
      '   - 합성/익명 샘플 제공: 가능 / 불가',
      ''
    ].join('\n');
  }

  return {
    REQUIRED_HEADERS: REQUIRED_HEADERS,
    MAX_BYTES: MAX_BYTES,
    MAX_ROWS: MAX_ROWS,
    SAMPLE_CSV: SAMPLE_CSV,
    byteLength: byteLength,
    parseCsv: parseCsv,
    isValidDate: isValidDate,
    validateCsv: validateCsv,
    toValidCsv: toValidCsv,
    toErrorCsv: toErrorCsv,
    csvText: csvText,
    buildRequestTemplate: buildRequestTemplate
  };
});
