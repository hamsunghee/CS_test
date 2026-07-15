(() => {
  'use strict';

  const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbxAFChbpPXQ3qo4smvsA8rD5ATNdZy6PShAEY0cUyZqCiOe2oz7shTXf92m3Kz1IC0/exec';
  const LS_RECORDS = 'return_inspection_mvp_records_v1';
  const LS_CONFIG = 'return_inspection_mvp_config_v1';
  const MAX_PHOTOS = 4;
  const LOOKUP_MIN_LENGTH = 4;
  const LOOKUP_DEBOUNCE_MS = 650;

  const state = {
    activeTab: 'form',
    records: [],
    config: {
      gasUrl: DEFAULT_GAS_URL,
      workerName: '',
      storeLocalPhotos: true,
      autoLookup: true
    },
    form: getEmptyForm(),
    lookup: {
      status: 'idle',
      message: '',
      productBarcode: '',
      data: null
    },
    historySearch: '',
    historyFilter: 'all',
    lookupTimer: null
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function getEmptyForm() {
    return {
      productBarcode: '',
      invoiceNumber: '',
      orderNumber: '',
      productName: '',
      returnReason: '단순변심',
      returnReasonDetail: '',
      inspectionResult: '재입고',
      memo: '',
      photos: []
    };
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatDate(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `r_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function loadState() {
    try {
      const savedRecords = localStorage.getItem(LS_RECORDS);
      if (savedRecords) state.records = JSON.parse(savedRecords) || [];
    } catch (err) {
      console.warn('records load failed', err);
      state.records = [];
    }

    try {
      const savedConfig = localStorage.getItem(LS_CONFIG);
      if (savedConfig) state.config = { ...state.config, ...JSON.parse(savedConfig) };
    } catch (err) {
      console.warn('config load failed', err);
    }
  }

  function saveRecords() {
    try {
      localStorage.setItem(LS_RECORDS, JSON.stringify(state.records));
    } catch (err) {
      console.warn('records save failed', err);
      toast('기기 저장공간이 부족합니다. 오래된 로컬 내역을 삭제하거나 사진 수를 줄여주세요.');
    }
  }

  function saveConfig() {
    localStorage.setItem(LS_CONFIG, JSON.stringify(state.config));
  }

  function isGasConfigured() {
    return Boolean(state.config.gasUrl && state.config.gasUrl.startsWith('https://script.google.com/'));
  }

  function updateHeaderBadge() {
    const badge = $('#headerSyncBadge');
    if (!badge) return;
    const pending = state.records.filter((r) => r.syncStatus !== 'synced').length;

    if (isGasConfigured()) {
      badge.className = pending > 0 ? 'sync-badge warn' : 'sync-badge ok';
      badge.textContent = pending > 0 ? `전송대기 ${pending}건` : '구글시트 연결';
    } else {
      badge.className = 'sync-badge warn';
      badge.textContent = '로컬 저장모드';
    }
  }

  function toast(message, ms = 2400) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function notice(type, text) {
    const icon = type === 'ok' ? '✓' : type === 'error' ? '!' : type === 'info' ? 'i' : '⚠';
    return `<div class="notice ${type}"><strong>${icon}</strong><span>${escapeHtml(text)}</span></div>`;
  }


  function renderLookupStatus() {
    const lookup = state.lookup || { status: 'idle' };
    if (lookup.status === 'idle') {
      return '<div class="lookup-box muted">상품 바코드를 스캔/입력하면 Apps Script가 상품리스트 탭에서 주문번호와 상품명을 찾아옵니다.</div>';
    }
    if (lookup.status === 'loading') {
      return `<div class="lookup-box loading"><span class="spinner"></span><span>${escapeHtml(lookup.message || '상품 정보를 조회 중입니다...')}</span></div>`;
    }
    if (lookup.status === 'found') {
      const d = lookup.data || {};
      const lines = [
        d.orderNumber ? `<span><b>주문번호</b> ${escapeHtml(d.orderNumber)}</span>` : '',
        d.productName ? `<span><b>상품명</b> ${escapeHtml(d.productName)}</span>` : '',
        d.productCode ? `<span><b>단품코드</b> ${escapeHtml(d.productCode)}</span>` : '',
        d.option ? `<span><b>옵션</b> ${escapeHtml(d.option)}</span>` : '',
        d.quantity ? `<span><b>수량</b> ${escapeHtml(d.quantity)}</span>` : ''
      ].filter(Boolean).join('');
      return `<div class="lookup-box ok"><strong>상품리스트 매칭 완료</strong><div class="lookup-lines">${lines}</div></div>`;
    }
    if (lookup.status === 'not_found') {
      return `<div class="lookup-box warn">${escapeHtml(lookup.message || '상품리스트에서 일치하는 상품 바코드를 찾지 못했습니다. 필요하면 직접 입력하세요.')}</div>`;
    }
    return `<div class="lookup-box error">${escapeHtml(lookup.message || '상품 정보 조회 중 오류가 발생했습니다. 직접 입력하거나 설정을 확인하세요.')}</div>`;
  }

  function updateLookupStatusDom() {
    const el = $('#lookupStatus');
    if (el) el.innerHTML = renderLookupStatus();
  }

  function setLookupStatus(status, message = '', data = null, productBarcode = '') {
    state.lookup = { status, message, data, productBarcode };
    updateLookupStatusDom();
  }

  function clearLookupTimer() {
    if (state.lookupTimer) {
      clearTimeout(state.lookupTimer);
      state.lookupTimer = null;
    }
  }

  function scheduleProductLookup(productBarcode) {
    clearLookupTimer();
    const barcode = String(productBarcode || '').trim();
    if (!state.config.autoLookup) return setLookupStatus('idle');
    if (!barcode || barcode.length < LOOKUP_MIN_LENGTH) return setLookupStatus('idle');
    state.lookupTimer = setTimeout(() => lookupProductByBarcode(barcode), LOOKUP_DEBOUNCE_MS);
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    $$('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    render();
  }

  function render() {
    updateHeaderBadge();
    const view = $('#view');
    if (!view) return;

    if (state.activeTab === 'form') renderForm(view);
    if (state.activeTab === 'history') renderHistory(view);
    if (state.activeTab === 'stats') renderStats(view);
    if (state.activeTab === 'settings') renderSettings(view);
  }

  function renderForm(view) {
    const f = state.form;
    view.innerHTML = `
      ${isGasConfigured()
        ? ''
        : notice('warn', 'Google Apps Script URL이 설정되어 있지 않으면 이 기기에만 임시 저장됩니다.')}

      <form id="inspectionForm" autocomplete="off">
        <section class="card">
          <h2 class="card-title">상품 바코드 스캔</h2>
          <p class="card-subtitle">상품 바코드를 스캔하거나 직접 입력하면 상품리스트 탭과 매칭해 상품 정보를 자동으로 채웁니다.</p>
          <div class="field">
            <label for="productBarcode">상품 바코드 <span class="optional">선택</span></label>
            <div class="input-row">
              <input id="productBarcode" class="input mono" type="text" inputmode="numeric" placeholder="상품 바코드 입력 또는 스캔" value="${escapeHtml(f.productBarcode)}" />
              <button id="productScanBtn" class="btn btn-dark btn-scan" type="button">▦ 스캔</button>
            </div>
            <div id="lookupStatus" class="lookup-status">${renderLookupStatus()}</div>
          </div>
        </section>

        <section class="card">
          <h2 class="card-title">송장번호 스캔</h2>
          <p class="card-subtitle">택배 송장번호는 배송 추적/반품 기록용입니다. 스캔 또는 수기 입력 모두 가능합니다.</p>
          <div class="field">
            <label for="invoiceNumber">송장번호 <span class="optional">선택</span></label>
            <div class="input-row">
              <input id="invoiceNumber" class="input mono" type="text" inputmode="numeric" placeholder="송장번호 입력 또는 스캔" value="${escapeHtml(f.invoiceNumber)}" />
              <button id="invoiceScanBtn" class="btn btn-dark btn-scan" type="button">▦ 스캔</button>
            </div>
          </div>
        </section>

        <section class="card">
          <h2 class="card-title">상품 정보</h2>
          <p class="card-subtitle">주문번호와 상품명/단품코드는 선택 입력입니다. 상품 바코드가 상품리스트 탭과 매칭되면 자동으로 채워집니다.</p>
          <div class="field">
            <label for="orderNumber">주문번호 <span class="optional">선택</span></label>
            <input id="orderNumber" class="input" type="text" placeholder="자동 조회 또는 직접 입력" value="${escapeHtml(f.orderNumber)}" />
          </div>
          <div class="field">
            <label for="productName">상품명 / 단품코드 <span class="optional">선택</span></label>
            <input id="productName" class="input" type="text" placeholder="자동 조회 또는 직접 입력" value="${escapeHtml(f.productName)}" />
          </div>
        </section>

        <section class="card">
          <h2 class="card-title">반품 사유</h2>
          <div class="field">
            <label for="returnReason">반품 사유 <span class="required">*</span></label>
            <select id="returnReason" class="select">
              ${['단순변심', '파손', '불량', '오배송', '기타'].map((v) => `<option value="${v}" ${f.returnReason === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
          <div id="reasonDetailWrap" class="field ${f.returnReason === '기타' ? '' : 'hidden'}">
            <label for="returnReasonDetail">기타 상세 사유</label>
            <input id="returnReasonDetail" class="input" type="text" placeholder="기타 사유 입력" value="${escapeHtml(f.returnReasonDetail)}" />
          </div>
        </section>

        <section class="card">
          <h2 class="card-title">검수 결과</h2>
          <div class="segmented" id="inspectionResultGroup">
            ${['재입고', '폐기', '공장반품'].map((v) => `
              <button type="button" class="segment-btn ${f.inspectionResult === v ? 'active' : ''}" data-value="${v}">${v}</button>
            `).join('')}
          </div>
        </section>

        <section class="card">
          <h2 class="card-title">
            <span>사진 첨부</span>
            <span class="photo-count">${f.photos.length} / ${MAX_PHOTOS}</span>
          </h2>
          <p class="card-subtitle">모바일에서는 사진 추가 버튼을 누르면 카메라가 열립니다. 업로드 전 자동 압축됩니다.</p>
          <div class="photo-grid" id="photoGrid">
            ${f.photos.map((src, i) => `
              <div class="photo-tile">
                <img src="${src}" alt="검수 사진 ${i + 1}" data-preview-index="${i}" />
                <button type="button" class="photo-remove" data-remove-photo="${i}" aria-label="사진 삭제">×</button>
              </div>
            `).join('')}
            ${f.photos.length < MAX_PHOTOS ? '<button type="button" id="addPhotoBtn" class="photo-add"><span style="font-size:22px">📷</span><span>사진 추가</span></button>' : ''}
          </div>
          <input id="photoInput" type="file" accept="image/*" capture="environment" class="hidden" />
        </section>

        <section class="card">
          <h2 class="card-title">메모</h2>
          <textarea id="memo" class="textarea" placeholder="파손 위치, 구성품 누락, 전달사항 등 선택 입력">${escapeHtml(f.memo)}</textarea>
        </section>

        <button id="submitBtn" type="submit" class="btn btn-primary btn-block">✓ 검수 완료 및 구글시트 저장</button>
        <button id="resetFormBtn" type="button" class="btn btn-outline btn-block" style="margin-top:8px">입력 양식 초기화</button>
      </form>
    `;

    bindFormEvents();
  }

  function bindFormEvents() {
    const bindInput = (id, key) => {
      const el = $(`#${id}`);
      if (!el) return;
      el.addEventListener('input', () => { state.form[key] = el.value; });
    };
    const productBarcodeInput = $('#productBarcode');
    if (productBarcodeInput) {
      productBarcodeInput.addEventListener('input', () => {
        state.form.productBarcode = productBarcodeInput.value;
        scheduleProductLookup(productBarcodeInput.value);
      });
      productBarcodeInput.addEventListener('blur', () => {
        const barcode = productBarcodeInput.value.trim();
        if (barcode && barcode.length >= LOOKUP_MIN_LENGTH) lookupProductByBarcode(barcode);
      });
    }
    bindInput('invoiceNumber', 'invoiceNumber');
    bindInput('orderNumber', 'orderNumber');
    bindInput('productName', 'productName');
    bindInput('returnReasonDetail', 'returnReasonDetail');
    bindInput('memo', 'memo');

    $('#returnReason')?.addEventListener('change', (e) => {
      state.form.returnReason = e.target.value;
      if (state.form.returnReason !== '기타') state.form.returnReasonDetail = '';
      render();
    });

    $('#inspectionResultGroup')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (!btn) return;
      state.form.inspectionResult = btn.dataset.value;
      render();
    });

    $('#productScanBtn')?.addEventListener('click', () => openScanner('productBarcode'));
    $('#invoiceScanBtn')?.addEventListener('click', () => openScanner('invoiceNumber'));
    $('#addPhotoBtn')?.addEventListener('click', () => $('#photoInput')?.click());
    $('#photoInput')?.addEventListener('change', handlePhotoSelected);

    $$('[data-remove-photo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.removePhoto);
        state.form.photos.splice(idx, 1);
        render();
      });
    });

    $$('[data-preview-index]').forEach((img) => {
      img.addEventListener('click', () => openLightbox(img.src));
    });

    $('#resetFormBtn')?.addEventListener('click', () => {
      if (!confirm('입력 중인 내용을 초기화할까요?')) return;
      state.form = getEmptyForm();
      setLookupStatus('idle');
      render();
    });

    $('#inspectionForm')?.addEventListener('submit', handleSubmit);
  }

  async function handlePhotoSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (state.form.photos.length >= MAX_PHOTOS) {
      toast('사진은 최대 4장까지 등록할 수 있습니다.');
      return;
    }

    try {
      toast('사진 압축 중입니다...');
      const dataUrl = await compressImage(file, 1000, 0.78);
      state.form.photos.push(dataUrl);
      toast('사진이 추가되었습니다.');
      render();
    } catch (err) {
      console.error(err);
      toast('사진 처리 중 오류가 발생했습니다.');
    }
  }

  function compressImage(file, maxWidth = 1000, quality = 0.78) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let { width, height } = img;
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(reader.result);
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const f = state.form;
    const productBarcode = f.productBarcode.trim();
    const invoiceNumber = f.invoiceNumber.trim();
    const orderNumber = f.orderNumber.trim();
    const productName = f.productName.trim();

    if (!productBarcode && !invoiceNumber) return toast('상품 바코드 또는 송장번호 중 하나를 입력하거나 스캔해주세요.');
    if (f.returnReason === '기타' && !f.returnReasonDetail.trim()) return toast('기타 상세 사유를 입력해주세요.');

    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.textContent = '저장 중...';

    const record = {
      id: makeId(),
      createdAt: formatDate(),
      productBarcode,
      invoiceNumber,
      orderNumber,
      productName,
      returnReason: f.returnReason,
      returnReasonDetail: f.returnReason === '기타' ? f.returnReasonDetail.trim() : '',
      inspectionResult: f.inspectionResult,
      memo: f.memo.trim(),
      photos: [...f.photos],
      photoCount: f.photos.length,
      workerName: state.config.workerName || '',
      deviceInfo: getDeviceInfo(),
      syncStatus: 'local_only'
    };

    let synced = false;
    if (isGasConfigured()) {
      synced = await postToAppsScript(record);
    }
    record.syncStatus = synced ? 'synced' : 'local_only';
    record.syncedAt = synced ? formatDate() : '';

    const recordForLocal = { ...record };
    if (!state.config.storeLocalPhotos && synced) {
      recordForLocal.photos = [];
    }

    state.records.unshift(recordForLocal);
    saveRecords();

    state.form = getEmptyForm();
    setLookupStatus('idle');
    render();
    toast(synced ? '검수 완료: 구글시트 전송을 시도했습니다.' : '검수 완료: 기기에 임시 저장되었습니다.');
  }

  function getDeviceInfo() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS Safari/Browser';
    if (/Android/i.test(ua)) return 'Android Browser';
    if (/Windows/i.test(ua)) return 'Windows Browser';
    if (/Macintosh/i.test(ua)) return 'Mac Browser';
    return 'Browser';
  }

  async function postToAppsScript(record) {
    const url = state.config.gasUrl.trim();
    if (!url) return false;

    const payload = {
      ...record,
      source: 'html-css-js-mvp',
      submittedAt: new Date().toISOString()
    };
    delete payload.syncStatus;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 18000);
      await fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeout);
      // no-cors에서는 응답 내용 확인이 불가능합니다. 네트워크 오류 없이 요청이 끝나면 성공 시도로 봅니다.
      return true;
    } catch (err) {
      console.warn('Apps Script POST failed', err);
      return false;
    }
  }

  function renderHistory(view) {
    const filtered = getFilteredRecords();
    view.innerHTML = `
      <section class="card">
        <h2 class="card-title">
          <span>검수 내역</span>
          <span class="photo-count">${filtered.length} / ${state.records.length}건</span>
        </h2>
        <div class="input-row" style="margin-bottom:10px">
          <input id="historySearch" class="input" type="search" placeholder="상품바코드, 송장, 주문번호, 상품명 검색" value="${escapeHtml(state.historySearch)}" />
        </div>
        <div class="filter-row" id="filterRow">
          ${['all', '재입고', '폐기', '공장반품'].map((v) => `<button type="button" class="filter-pill ${state.historyFilter === v ? 'active' : ''}" data-filter="${v}">${v === 'all' ? '전체' : v}</button>`).join('')}
        </div>
        <div style="display:flex; gap:6px; margin-top:12px; flex-wrap:wrap">
          <button id="syncAllBtn" class="btn btn-amber btn-small" type="button">대기건 전체 전송</button>
          <button id="exportCsvBtn" class="btn btn-soft btn-small" type="button">CSV 내보내기</button>
          <button id="clearAllBtn" class="btn btn-red btn-small" type="button">로컬 전체삭제</button>
        </div>
      </section>

      <section id="recordList">
        ${filtered.length ? filtered.map(renderRecordCard).join('') : '<div class="card empty"><strong>검수 내역이 없습니다</strong><span>검수 탭에서 첫 반품을 등록해주세요.</span></div>'}
      </section>
    `;

    $('#historySearch')?.addEventListener('input', (e) => {
      state.historySearch = e.target.value;
      renderHistory($('#view'));
    });

    $$('#filterRow [data-filter]').forEach((btn) => btn.addEventListener('click', () => {
      state.historyFilter = btn.dataset.filter;
      renderHistory($('#view'));
    }));

    $('#exportCsvBtn')?.addEventListener('click', exportCsv);
    $('#clearAllBtn')?.addEventListener('click', clearAllLocal);
    $('#syncAllBtn')?.addEventListener('click', syncAllPending);

    $$('[data-sync-id]').forEach((btn) => btn.addEventListener('click', () => syncOne(btn.dataset.syncId)));
    $$('[data-delete-id]').forEach((btn) => btn.addEventListener('click', () => deleteOne(btn.dataset.deleteId)));
    $$('[data-photo-src]').forEach((img) => img.addEventListener('click', () => openLightbox(img.dataset.photoSrc)));
  }

  function getFilteredRecords() {
    const q = state.historySearch.trim().toLowerCase();
    return state.records.filter((r) => {
      const matchesFilter = state.historyFilter === 'all' || r.inspectionResult === state.historyFilter;
      const hay = [r.productBarcode, r.invoiceNumber, r.orderNumber, r.productName, r.returnReason, r.returnReasonDetail, r.memo, r.workerName].join(' ').toLowerCase();
      return matchesFilter && (!q || hay.includes(q));
    });
  }

  function renderRecordCard(r) {
    const cardClass = r.inspectionResult === '폐기' ? 'discard' : r.inspectionResult === '공장반품' ? 'factory' : '';
    const syncBadge = r.syncStatus === 'synced'
      ? '<span class="badge ok">구글시트 전송됨</span>'
      : '<span class="badge warn">전송 대기</span>';
    const resultClass = r.inspectionResult === '폐기' ? 'red' : r.inspectionResult === '공장반품' ? 'warn' : 'ok';

    return `
      <article class="record-card ${cardClass}">
        <div class="record-head">
          <div class="record-date">${escapeHtml(r.createdAt)}</div>
          ${syncBadge}
        </div>
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:center; padding-left:4px">
          <div>
            <div class="meta-label">상품 바코드</div>
            <div class="meta-value mono">${escapeHtml(r.productBarcode || '')}</div>
          </div>
          <span class="badge ${resultClass}">${escapeHtml(r.inspectionResult)}</span>
        </div>
        <div class="meta-grid">
          <div><div class="meta-label">송장번호</div><div class="meta-value mono">${escapeHtml(r.invoiceNumber || '')}</div></div>
          <div><div class="meta-label">주문번호</div><div class="meta-value">${escapeHtml(r.orderNumber || '')}</div></div>
          <div><div class="meta-label">상품명</div><div class="meta-value">${escapeHtml(r.productName || '')}</div></div>
        </div>
        <div class="reason-box"><strong>반품 사유:</strong> ${escapeHtml(r.returnReason)}${r.returnReasonDetail ? ` (${escapeHtml(r.returnReasonDetail)})` : ''}</div>
        ${r.memo ? `<div class="memo-box"><strong>메모:</strong><br>${escapeHtml(r.memo).replaceAll('\n', '<br>')}</div>` : ''}
        ${r.workerName ? `<div class="reason-box"><strong>담당자:</strong> ${escapeHtml(r.workerName)}</div>` : ''}
        ${r.photos && r.photos.length ? `
          <div class="thumbnail-row">
            ${r.photos.map((src, i) => `<button type="button" class="thumbnail" aria-label="사진 ${i + 1} 보기"><img src="${src}" alt="사진 ${i + 1}" data-photo-src="${src}"></button>`).join('')}
          </div>
        ` : ''}
        <div class="record-actions">
          ${r.syncStatus === 'synced' ? '' : `<button class="btn btn-amber btn-small" type="button" data-sync-id="${escapeHtml(r.id)}">구글 전송</button>`}
          <button class="btn btn-red btn-small" type="button" data-delete-id="${escapeHtml(r.id)}">목록 삭제</button>
        </div>
      </article>
    `;
  }

  async function syncOne(id) {
    const record = state.records.find((r) => r.id === id);
    if (!record) return;
    if (!isGasConfigured()) return toast('설정 탭에서 Apps Script URL을 먼저 저장해주세요.');

    toast('구글시트 전송 중...');
    const ok = await postToAppsScript(record);
    if (ok) {
      record.syncStatus = 'synced';
      record.syncedAt = formatDate();
      saveRecords();
      render();
      toast('전송을 시도했습니다. 시트에서 실제 행을 확인해주세요.');
    } else {
      toast('전송 실패: 네트워크 또는 Apps Script 배포 권한을 확인해주세요.');
    }
  }

  async function syncAllPending() {
    if (!isGasConfigured()) return toast('설정 탭에서 Apps Script URL을 먼저 저장해주세요.');
    const pending = state.records.filter((r) => r.syncStatus !== 'synced');
    if (!pending.length) return toast('전송 대기 건이 없습니다.');

    if (!confirm(`전송 대기 ${pending.length}건을 Google Sheet로 전송할까요?`)) return;
    let success = 0;
    for (const record of pending) {
      // 순차 전송: Apps Script 동시 실행 충돌 방지
      // eslint-disable-next-line no-await-in-loop
      const ok = await postToAppsScript(record);
      if (ok) {
        record.syncStatus = 'synced';
        record.syncedAt = formatDate();
        success += 1;
        saveRecords();
      }
    }
    render();
    toast(`전체 전송 완료: ${success}/${pending.length}건 전송 시도`);
  }

  function deleteOne(id) {
    if (!confirm('이 검수 기록을 이 기기 목록에서 삭제할까요? 구글시트에 이미 저장된 행은 삭제되지 않습니다.')) return;
    state.records = state.records.filter((r) => r.id !== id);
    saveRecords();
    render();
  }

  function clearAllLocal() {
    if (!state.records.length) return toast('삭제할 로컬 내역이 없습니다.');
    if (!confirm('이 기기에 저장된 모든 검수 내역을 삭제할까요? 구글시트 데이터는 삭제되지 않습니다.')) return;
    state.records = [];
    saveRecords();
    render();
    toast('로컬 내역을 모두 삭제했습니다.');
  }

  function exportCsv() {
    if (!state.records.length) return toast('내보낼 데이터가 없습니다.');
    const headers = ['저장일시', '상품바코드', '송장번호', '주문번호', '상품명', '반품사유', '기타상세', '검수결과', '메모', '사진개수', '담당자', '전송상태'];
    const rows = state.records.map((r) => [
      r.createdAt,
      `="${r.productBarcode || ''}"`,
      `="${r.invoiceNumber || ''}"`,
      `="${r.orderNumber || ''}"`,
      r.productName,
      r.returnReason,
      r.returnReasonDetail || '',
      r.inspectionResult,
      r.memo || '',
      r.photoCount ?? (r.photos ? r.photos.length : 0),
      r.workerName || '',
      r.syncStatus === 'synced' ? '구글시트 전송됨' : '전송대기'
    ]);
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `반품검수대장_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    return `"${String(value ?? '').replaceAll('"', '""')}"`;
  }

  function renderStats(view) {
    const total = state.records.length;
    const count = (value) => state.records.filter((r) => r.inspectionResult === value).length;
    const restock = count('재입고');
    const discard = count('폐기');
    const factory = count('공장반품');
    const pct = (n) => total ? Math.round((n / total) * 100) : 0;
    const synced = state.records.filter((r) => r.syncStatus === 'synced').length;
    const reasons = ['단순변심', '파손', '불량', '오배송', '기타'].map((name) => ({
      name,
      count: state.records.filter((r) => r.returnReason === name).length
    }));

    view.innerHTML = `
      <section class="stats-hero">
        <p>누적 검수 처리량</p>
        <strong>${total}<span style="font-size:18px;color:#94a3b8"> 건</span></strong>
        <p style="margin-top:8px">구글시트 전송됨 ${synced}건 · 대기 ${total - synced}건</p>
      </section>

      <section class="stats-grid">
        <div class="stat-card"><small>재입고</small><strong>${restock}</strong><small>${pct(restock)}%</small></div>
        <div class="stat-card"><small>폐기</small><strong>${discard}</strong><small>${pct(discard)}%</small></div>
        <div class="stat-card"><small>공장반품</small><strong>${factory}</strong><small>${pct(factory)}%</small></div>
      </section>

      <section class="card">
        <h2 class="card-title">검수 결과 비율</h2>
        <div class="progress" aria-label="검수 결과 비율">
          <span class="p-green" style="width:${pct(restock)}%"></span>
          <span class="p-red" style="width:${pct(discard)}%"></span>
          <span class="p-amber" style="width:${pct(factory)}%"></span>
        </div>
        <p class="card-subtitle" style="margin:12px 0 0">재입고 ${pct(restock)}% · 폐기 ${pct(discard)}% · 공장반품 ${pct(factory)}%</p>
      </section>

      <section class="card">
        <h2 class="card-title">반품 사유별 현황</h2>
        ${total ? reasons.map((r) => `
          <div class="reason-line">
            <div class="reason-line-head"><span>${r.name}</span><span>${r.count}건 (${pct(r.count)}%)</span></div>
            <div class="mini-bar"><span style="width:${pct(r.count)}%"></span></div>
          </div>
        `).join('') : '<div class="empty"><strong>데이터가 없습니다</strong><span>검수 등록 후 통계가 표시됩니다.</span></div>'}
      </section>
    `;
  }

  function renderSettings(view) {
    view.innerHTML = `
      <section class="card">
        <h2 class="card-title">Google Apps Script 설정</h2>
        <p class="card-subtitle">전 직원이 같은 URL을 사용하면 하나의 구글 스프레드시트에 함께 적재됩니다.</p>
        ${isGasConfigured()
          ? notice('ok', '현재 Apps Script URL이 설정되어 있습니다. 저장 시 구글시트 전송을 시도합니다.')
          : notice('warn', 'URL이 없거나 형식이 맞지 않습니다. 현재는 로컬 저장만 가능합니다.')}
        <div class="field">
          <label for="gasUrl">Apps Script Web App URL</label>
          <input id="gasUrl" class="input mono" type="url" value="${escapeHtml(state.config.gasUrl || '')}" placeholder="https://script.google.com/macros/s/.../exec" />
        </div>
        <div class="field">
          <label for="workerName">담당자명 또는 작업대명</label>
          <input id="workerName" class="input" type="text" value="${escapeHtml(state.config.workerName || '')}" placeholder="예: 홍길동 / 반품검수 1번" />
        </div>
        <label style="display:flex; gap:8px; align-items:flex-start; margin:10px 0; font-size:12px; color:#475569; font-weight:800; line-height:1.45">
          <input id="autoLookup" type="checkbox" ${state.config.autoLookup ? 'checked' : ''} style="margin-top:2px" />
          <span>상품 바코드 입력/스캔 후 상품리스트 탭에서 주문번호·상품명을 자동 조회합니다.</span>
        </label>
        <label style="display:flex; gap:8px; align-items:flex-start; margin:10px 0; font-size:12px; color:#475569; font-weight:800; line-height:1.45">
          <input id="storeLocalPhotos" type="checkbox" ${state.config.storeLocalPhotos ? 'checked' : ''} style="margin-top:2px" />
          <span>전송 후에도 이 기기 내역에 사진 미리보기를 보관합니다. 저장공간이 부족하면 체크 해제하세요.</span>
        </label>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px">
          <button id="saveSettingsBtn" class="btn btn-dark" type="button">설정 저장</button>
          <button id="testGasBtn" class="btn btn-soft" type="button">전송 테스트</button>
        </div>
      </section>

      <section class="card">
        <h2 class="card-title">현재 구현 범위</h2>
        ${notice('info', '이 MVP는 현장 입력, 사진 첨부, 구글시트 적재, 로컬 임시보관까지 구현합니다.')}
        ${notice('info', '상품 바코드 스캔 후 상품리스트 탭에서 주문번호와 상품명을 조회합니다. 단, 상품리스트 탭에 해당 상품 바코드가 미리 있어야 합니다.')}
        ${notice('warn', '이카운트 ERP 실시간 조회/자동반영, 직원 로그인/권한관리는 이 코드만으로는 구현되어 있지 않습니다.')}
      </section>

      <section class="card">
        <h2 class="card-title">Apps Script 코드 파일</h2>
        <p class="card-subtitle">ZIP 안의 <strong>apps-script/Code.gs</strong>를 Apps Script 편집기에 붙여넣으면 됩니다. 현재 제공한 URL을 계속 쓰려면 해당 스크립트 프로젝트에서 코드만 교체한 뒤 새 버전으로 배포하세요.</p>
        <button id="copyGuideBtn" class="btn btn-outline btn-block" type="button">설치 순서 복사</button>
      </section>
    `;

    $('#saveSettingsBtn')?.addEventListener('click', () => {
      const gasUrl = $('#gasUrl').value.trim();
      state.config.gasUrl = gasUrl || DEFAULT_GAS_URL;
      state.config.workerName = $('#workerName').value.trim();
      state.config.autoLookup = $('#autoLookup').checked;
      state.config.storeLocalPhotos = $('#storeLocalPhotos').checked;
      saveConfig();
      render();
      toast('설정이 저장되었습니다.');
    });

    $('#testGasBtn')?.addEventListener('click', sendTestRecord);
    $('#copyGuideBtn')?.addEventListener('click', copyInstallGuide);
  }

  async function sendTestRecord() {
    const gasUrl = $('#gasUrl')?.value.trim() || state.config.gasUrl;
    state.config.gasUrl = gasUrl;
    saveConfig();

    if (!isGasConfigured()) return toast('Apps Script URL 형식이 올바르지 않습니다.');

    const test = {
      id: makeId(),
      createdAt: formatDate(),
      productBarcode: 'P-BARCODE-TEST',
      invoiceNumber: 'P-CONN-TEST',
      orderNumber: 'TEST-000',
      productName: '통신 확인용 테스트 행',
      returnReason: '단순변심',
      returnReasonDetail: '',
      inspectionResult: '재입고',
      memo: '전송 테스트 데이터입니다. 확인 후 구글시트에서 삭제해도 됩니다.',
      photos: [],
      photoCount: 0,
      workerName: state.config.workerName || '테스트',
      deviceInfo: getDeviceInfo()
    };
    toast('전송 테스트 중...');
    const ok = await postToAppsScript(test);
    toast(ok ? '전송 테스트를 시도했습니다. 구글시트에 테스트 행이 생겼는지 확인해주세요.' : '전송 테스트 실패: 배포 권한과 URL을 확인해주세요.', 3600);
  }

  function copyInstallGuide() {
    const text = `반품 검수 MVP 설치 순서\n\n1. ZIP 파일 압축 해제\n2. index.html, style.css, app.js를 같은 폴더에 둠\n3. 전직원 사용용이면 HTTPS 호스팅에 업로드\n   예: GitHub Pages, Netlify, Cloudflare Pages, 사내 웹서버\n4. Google Apps Script 편집기에서 apps-script/Code.gs 붙여넣기\n5. 배포 > 새 배포 > 웹 앱\n   - 실행 권한: 나\n   - 액세스 권한: 모든 사용자 또는 회사 정책에 맞는 사용자\n6. 생성된 Web App URL을 app.js의 DEFAULT_GAS_URL 또는 앱 설정 탭에 입력\n7. 상품 바코드 자동조회 사용 시 apps-script/Code.gs의 PRODUCT_SPREADSHEET_ID와 PRODUCT_SHEET_NAME 확인\n8. 모바일에서 링크 접속 후 카메라 권한 허용\n`;
    navigator.clipboard?.writeText(text).then(() => toast('설치 순서를 복사했습니다.')).catch(() => toast('복사에 실패했습니다.'));
  }


  async function lookupProductByBarcode(productBarcode) {
    const barcode = String(productBarcode || '').trim();
    if (!barcode || barcode.length < LOOKUP_MIN_LENGTH) return;
    if (!isGasConfigured()) {
      setLookupStatus('error', 'Apps Script URL이 설정되어 있지 않아 상품 조회를 할 수 없습니다.');
      return;
    }

    setLookupStatus('loading', `상품 바코드 ${barcode} 조회 중...`, null, barcode);
    try {
      const result = await jsonpRequest(state.config.gasUrl.trim(), {
        action: 'lookup',
        productBarcode: barcode,
        barcode: barcode
      }, 12000);

      if (String(state.form.productBarcode || '').trim() !== barcode) return;

      if (result && result.ok && result.found) {
        const data = result.data || {};
        if (data.orderNumber) state.form.orderNumber = data.orderNumber;
        const productValue = data.productDisplay || [data.productName, data.productCode].filter(Boolean).join(' / ');
        if (productValue) state.form.productName = productValue;

        const orderEl = $('#orderNumber');
        const productEl = $('#productName');
        if (orderEl) orderEl.value = state.form.orderNumber;
        if (productEl) productEl.value = state.form.productName;

        setLookupStatus('found', '상품리스트 매칭 완료', data, barcode);
        toast('상품 정보가 자동 입력되었습니다.');
        return;
      }

      setLookupStatus('not_found', '상품리스트에서 일치하는 상품 바코드를 찾지 못했습니다. 필요하면 상품 정보를 직접 입력하세요.', null, barcode);
    } catch (err) {
      console.warn('lookup failed', err);
      setLookupStatus('error', '상품 조회에 실패했습니다. Apps Script 배포 URL/권한과 상품리스트 탭명을 확인하세요.', null, barcode);
    }
  }

  function jsonpRequest(baseUrl, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const callbackName = `__returnLookup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const url = new URL(baseUrl);
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
      url.searchParams.set('callback', callbackName);

      const script = document.createElement('script');
      const timer = setTimeout(() => cleanup(() => reject(new Error('lookup timeout'))), timeoutMs);

      function cleanup(done) {
        clearTimeout(timer);
        try { delete window[callbackName]; } catch (err) { window[callbackName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
        if (typeof done === 'function') done();
      }

      window[callbackName] = (data) => cleanup(() => resolve(data));
      script.onerror = () => cleanup(() => reject(new Error('lookup script load failed')));
      script.src = url.toString();
      document.head.appendChild(script);
    });
  }

  function openLightbox(src) {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.innerHTML = `<img src="${src}" alt="사진 크게 보기">`;
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  }

  function openScanner(targetKey = 'productBarcode') {
    const isProduct = targetKey === 'productBarcode';
    const targetLabel = isProduct ? '상품 바코드' : '송장번호';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-head">
        <h2>${targetLabel} 스캔</h2>
        <button id="scannerCloseBtn" class="btn btn-soft btn-small" type="button">닫기</button>
      </div>
      <div class="scanner-box">
        <div id="scannerReader" style="width:100%; height:100%"></div>
        <video id="nativeScannerVideo" class="hidden" playsinline muted></video>
        <div class="scanner-frame"></div>
      </div>
      <div id="scannerStatus" class="scanner-status">카메라를 시작하는 중입니다. 권한 요청이 나오면 허용해주세요.</div>
    `;
    document.body.appendChild(modal);

    let stopFn = null;
    const close = async () => {
      if (stopFn) await stopFn();
      modal.remove();
    };
    $('#scannerCloseBtn', modal).addEventListener('click', close);

    const onScan = async (text) => {
      if (!text) return;
      if (navigator.vibrate) navigator.vibrate(80);
      const scannedValue = String(text).trim();
      state.form[targetKey] = scannedValue;
      await close();
      render();
      toast(`${targetLabel} 스캔 완료: ${scannedValue}`);
      if (isProduct) lookupProductByBarcode(scannedValue);
    };

    if (window.Html5Qrcode) {
      stopFn = startHtml5QrcodeScanner(onScan, modal, targetLabel);
    } else if ('BarcodeDetector' in window) {
      stopFn = startNativeBarcodeScanner(onScan, modal, targetLabel);
    } else {
      $('#scannerStatus', modal).textContent = `이 브라우저는 바코드 스캔을 지원하지 않습니다. ${targetLabel}를 직접 입력해주세요.`;
    }
  }

  function startHtml5QrcodeScanner(onScan, modal, targetLabel = '바코드') {
    const status = $('#scannerStatus', modal);
    const scanner = new Html5Qrcode('scannerReader');
    let stopped = false;
    const config = {
      fps: 12,
      qrbox: (w, h) => ({ width: Math.min(w * 0.84, 360), height: Math.min(h * 0.34, 140) }),
      aspectRatio: 1.0
    };

    scanner.start(
      { facingMode: 'environment' },
      config,
      (decodedText) => onScan(decodedText),
      () => {}
    ).then(() => {
      status.textContent = `가이드 사각형 안에 ${targetLabel}를 맞춰주세요.`;
    }).catch((err) => {
      console.warn(err);
      status.textContent = '카메라를 시작할 수 없습니다. 브라우저 권한 또는 HTTPS 접속 여부를 확인하고, 어려우면 직접 입력해주세요.';
    });

    return async () => {
      if (stopped) return;
      stopped = true;
      try {
        if (scanner.isScanning) await scanner.stop();
        await scanner.clear();
      } catch (err) {
        console.warn('scanner stop failed', err);
      }
    };
  }

  function startNativeBarcodeScanner(onScan, modal, targetLabel = '바코드') {
    const status = $('#scannerStatus', modal);
    const video = $('#nativeScannerVideo', modal);
    const reader = $('#scannerReader', modal);
    reader.classList.add('hidden');
    video.classList.remove('hidden');

    let stream = null;
    let raf = null;
    let active = true;
    let detector = null;

    (async () => {
      try {
        const formats = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : undefined;
        detector = formats ? new BarcodeDetector({ formats }) : new BarcodeDetector();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        video.srcObject = stream;
        await video.play();
        status.textContent = `가이드 사각형 안에 ${targetLabel}를 맞춰주세요.`;
        tick();
      } catch (err) {
        console.warn(err);
        status.textContent = '카메라 또는 바코드 인식기를 시작할 수 없습니다. HTTPS 접속과 카메라 권한을 확인해주세요.';
      }
    })();

    async function tick() {
      if (!active || !detector) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) {
          await onScan(codes[0].rawValue);
          return;
        }
      } catch (err) {
        // 인식 중 흔히 발생하는 프레임 오류는 무시합니다.
      }
      raf = requestAnimationFrame(tick);
    }

    return async () => {
      active = false;
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((track) => track.stop());
    };
  }

  function init() {
    loadState();
    $$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => setActiveTab(btn.dataset.tab)));
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
