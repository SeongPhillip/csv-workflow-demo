/*
 * F005 app — 정적 시연 페이지 UI 배선.
 * 데이터는 브라우저 안에서만 처리하며 외부 전송/자동 저장/localStorage를 사용하지 않는다.
 */
(function () {
  'use strict';

  var core = window.F005Core;
  if (!core) {
    return;
  }

  var inputEl = document.getElementById('csv-input');
  var fileEl = document.getElementById('csv-file');
  var sampleBtn = document.getElementById('btn-sample');
  var validateBtn = document.getElementById('btn-validate');
  var resetBtn = document.getElementById('btn-reset');
  var downloadValidBtn = document.getElementById('btn-download-valid');
  var downloadErrorsBtn = document.getElementById('btn-download-errors');
  var requestBtn = document.getElementById('btn-request-template');
  var noticeEl = document.getElementById('notice');
  var resultBody = document.getElementById('result-body');
  var resultPlaceholder = document.getElementById('result-placeholder');

  var lastResult = null;
  var loadGeneration = 0;
  var activeReader = null;

  /*
   * 파일 읽기는 비동기다. 초기화/샘플/직접 입력/다른 파일 선택이 일어나면
   * 세대 번호를 올리고 진행 중인 리더를 중단해, 늦게 도착한 콜백이 새 상태를 덮지 않게 한다.
   */
  function invalidateLoad() {
    loadGeneration += 1;
    var reader = activeReader;
    activeReader = null;
    if (reader && typeof reader.abort === 'function') {
      try { reader.abort(); } catch (e) { /* noop */ }
    }
    return loadGeneration;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setNotice(text, kind) {
    noticeEl.textContent = text || '';
    noticeEl.className = 'notice' + (kind ? ' is-' + kind : '');
  }

  function formatNumber(n) {
    try {
      return n.toLocaleString('ko-KR');
    } catch (e) {
      return String(n);
    }
  }

  function updateDownloadState() {
    var usable = !!(lastResult && !lastResult.fatal);
    downloadValidBtn.disabled = !(usable && lastResult.validRows.length > 0);
    downloadErrorsBtn.disabled = !(usable && lastResult.errors.length > 0);
  }

  function resetResults() {
    lastResult = null;
    clearNode(resultBody);
    if (resultPlaceholder) resultPlaceholder.hidden = false;
    updateDownloadState();
  }

  function summaryItem(label, value) {
    var box = document.createElement('div');
    box.className = 'summary-item';
    var l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    var v = document.createElement('span');
    v.className = 'value';
    v.textContent = value;
    box.appendChild(l);
    box.appendChild(v);
    return box;
  }

  function buildTable(captionText, headers, rows, numericCols) {
    var scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    var table = document.createElement('table');
    var caption = document.createElement('caption');
    caption.textContent = captionText;
    table.appendChild(caption);

    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    headers.forEach(function (text, index) {
      var th = document.createElement('th');
      th.scope = 'col';
      if (numericCols.indexOf(index) !== -1) th.className = 'num';
      th.textContent = text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    rows.forEach(function (cells) {
      var tr = document.createElement('tr');
      cells.forEach(function (cell, index) {
        var td = document.createElement('td');
        if (numericCols.indexOf(index) !== -1) td.className = 'num';
        var value = cell && typeof cell === 'object' ? cell.text : cell;
        if (cell && typeof cell === 'object' && cell.error) {
          td.className += ' error-cell';
        }
        td.textContent = value;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    return scroll;
  }

  function renderResult(result) {
    clearNode(resultBody);
    if (resultPlaceholder) resultPlaceholder.hidden = true;

    if (result.fatal) {
      var err = document.createElement('p');
      err.className = 'result-error error-cell';
      err.textContent = '처리할 수 없습니다: ' + result.fatal.message;
      resultBody.appendChild(err);
      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = '입력 형식을 수정한 뒤 다시 실행해 주세요. 이전 결과와 내려받기는 초기화되었습니다.';
      resultBody.appendChild(hint);
      return;
    }

    var summary = document.createElement('div');
    summary.className = 'summary';
    summary.appendChild(summaryItem('유효 행', formatNumber(result.summary.validCount) + '행'));
    summary.appendChild(summaryItem('오류 행', formatNumber(result.summary.errorCount) + '행'));
    summary.appendChild(summaryItem('유효매출 합계', formatNumber(result.summary.revenue) + '원'));
    resultBody.appendChild(summary);

    var note = document.createElement('p');
    note.className = 'excluded-note';
    note.textContent = '유효매출 합계는 오류 행을 제외한 값입니다. 오류 행은 합계와 품목 요약에 포함되지 않습니다.';
    resultBody.appendChild(note);

    var errorsHeading = document.createElement('h4');
    errorsHeading.className = 'result-sub';
    errorsHeading.textContent = '오류 목록';
    resultBody.appendChild(errorsHeading);

    if (result.errors.length === 0) {
      var noErr = document.createElement('p');
      noErr.className = 'empty-note';
      noErr.textContent = '오류 행이 없습니다.';
      resultBody.appendChild(noErr);
    } else {
      var errorRows = result.errors.map(function (e) {
        return [
          { text: String(e.line) },
          { text: e.order_id || '(없음)' },
          { text: e.reason, error: true }
        ];
      });
      resultBody.appendChild(buildTable(
        '행 번호는 원본 CSV의 줄 번호 기준입니다.',
        ['행 번호', 'order_id', '원인'],
        errorRows,
        [0]
      ));
    }

    var itemsHeading = document.createElement('h4');
    itemsHeading.className = 'result-sub';
    itemsHeading.textContent = '품목별 요약 (유효 행 기준)';
    resultBody.appendChild(itemsHeading);

    if (result.items.length === 0) {
      var noItem = document.createElement('p');
      noItem.className = 'empty-note';
      noItem.textContent = '집계할 유효 행이 없습니다.';
      resultBody.appendChild(noItem);
    } else {
      var itemRows = result.items.map(function (it) {
        return [
          { text: it.item },
          { text: formatNumber(it.quantity) },
          { text: formatNumber(it.revenue) }
        ];
      });
      resultBody.appendChild(buildTable(
        '품목명은 원본 값을 그대로 표시합니다.',
        ['품목', '수량 합계', '매출 합계(원)'],
        itemRows,
        [1, 2]
      ));
    }
  }

  function runValidation() {
    invalidateLoad();
    setNotice('');
    var result = core.validateCsv(inputEl.value);
    lastResult = result;
    renderResult(result);
    updateDownloadState();
    if (!result.fatal) {
      setNotice(
        '검증 완료 · 유효 ' + result.summary.validCount + '행, 오류 ' + result.summary.errorCount + '행',
        'info'
      );
    }
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob(['\uFEFF' + text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /* 파일 바이트를 UTF-8로 엄격 디코딩한다(가능하면 fatal). 실패 시 예외를 던진다. */
  function decodeReaderResult(reader) {
    var result = reader.result;
    if (typeof TextDecoder !== 'undefined' && result && typeof result !== 'string' &&
        typeof result.byteLength === 'number') {
      return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(result));
    }
    var text = result === null || result === undefined ? '' : String(result);
    if (text.indexOf('\uFFFD') !== -1) throw new Error('encoding');
    return text;
  }

  function readFile(reader, file) {
    if (typeof TextDecoder !== 'undefined' && typeof reader.readAsArrayBuffer === 'function') {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file, 'utf-8');
    }
  }

  inputEl.addEventListener('input', function () {
    invalidateLoad();
    resetResults();
    setNotice('');
  });

  fileEl.addEventListener('change', function () {
    var file = fileEl.files && fileEl.files[0];
    var token = invalidateLoad();
    inputEl.value = '';
    resetResults();
    setNotice('');
    if (!file) return;

    if (file.size > core.MAX_BYTES) {
      setNotice('파일 크기가 1MB를 초과했습니다. 결과를 초기화했습니다.', 'error');
      return;
    }

    var reader = new FileReader();
    activeReader = reader;

    reader.onload = function () {
      if (token !== loadGeneration) return;
      activeReader = null;
      var text;
      try {
        text = decodeReaderResult(reader);
      } catch (e) {
        inputEl.value = '';
        resetResults();
        setNotice('UTF-8로 해석할 수 없는 문자가 있습니다. 파일 인코딩을 확인해 주세요. 결과를 초기화했습니다.', 'error');
        return;
      }
      inputEl.value = text;
      runValidation();
    };

    reader.onerror = function () {
      if (token !== loadGeneration) return;
      activeReader = null;
      inputEl.value = '';
      resetResults();
      setNotice('파일을 읽지 못했습니다. 결과를 초기화했습니다.', 'error');
    };

    reader.onabort = function () {
      if (token !== loadGeneration) return;
      activeReader = null;
      inputEl.value = '';
      resetResults();
      setNotice('파일 읽기를 중단했습니다. 결과를 초기화했습니다.', 'error');
    };

    readFile(reader, file);
  });

  sampleBtn.addEventListener('click', function () {
    invalidateLoad();
    fileEl.value = '';
    inputEl.value = core.SAMPLE_CSV;
    resetResults();
    runValidation();
  });

  validateBtn.addEventListener('click', runValidation);

  resetBtn.addEventListener('click', function () {
    invalidateLoad();
    inputEl.value = '';
    fileEl.value = '';
    resetResults();
    setNotice('초기화했습니다.', 'info');
  });

  downloadValidBtn.addEventListener('click', function () {
    if (!lastResult || lastResult.fatal || lastResult.validRows.length === 0) return;
    downloadText('valid-orders.csv', core.toValidCsv(lastResult));
  });

  downloadErrorsBtn.addEventListener('click', function () {
    if (!lastResult || lastResult.fatal || lastResult.errors.length === 0) return;
    downloadText('error-report.csv', core.toErrorCsv(lastResult));
  });

  requestBtn.addEventListener('click', function () {
    downloadText('request-template.txt', core.buildRequestTemplate(), 'text/plain');
  });

  resetResults();
})();
