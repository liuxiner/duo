import { readFile, writeFile } from 'node:fs/promises';

const SOURCE = '宁波多多6.6) - 6月.csv';
const OUTPUT = '宁波多多6月每日看板.html';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function clean(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim();
}

function numberValue(value) {
  const text = clean(value).replace(/[,\s￥]/g, '');
  if (!text || text === '--') return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function dateLabelToIso(label) {
  const match = clean(label).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!match) return '';
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function parseSource(rows) {
  const top = rows[0];
  const headers = rows[1];
  const dateStarts = [];

  top.forEach((value, index) => {
    const iso = dateLabelToIso(value);
    if (iso) dateStarts.push({ iso, index });
  });

  return rows.slice(2)
    .filter((row) => clean(row[0]) && clean(row[1]))
    .map((row) => {
      const daily = dateStarts.map(({ iso, index }) => ({
        date: iso,
        price: numberValue(row[index]),
        sales: numberValue(row[index + 1]) || 0,
        sendShared: numberValue(row[index + 2]) || 0,
        returnOrDamage: numberValue(row[index + 3]) || 0,
        inboundOrReturn: numberValue(row[index + 4]) || 0,
        remaining: numberValue(row[index + 5]),
        cloudStock: numberValue(row[index + 6]),
        sharedStock: numberValue(row[index + 7]),
      }));

      return {
        id: clean(row[0]),
        name: clean(row[1]),
        barcode: clean(row[2]),
        packSpec: clean(row[3]),
        shelfLife: clean(row[4]),
        cost: numberValue(row[5]),
        quote: clean(row[6]),
        schedule: clean(row[7]),
        openingRemaining: numberValue(row[8]),
        openingCloudStock: numberValue(row[9]),
        openingSharedStock: numberValue(row[10]),
        daily,
        turnoverEstimate: numberValue(row[67]),
        mayAverage: numberValue(row[68]),
        aprilMax: numberValue(row[69]),
        finalCloudStock: numberValue(row[72]),
        cloudShortage: numberValue(row[73]),
        note: clean(row[74]),
      };
    });
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function html(data) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>宁波多多6月每日看板</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #6b7280;
      --line: #dfe3ea;
      --accent: #2563eb;
      --green: #15803d;
      --red: #dc2626;
      --amber: #b45309;
      --soft-blue: #eaf1ff;
      --soft-red: #fff1f2;
      --soft-amber: #fff7ed;
      --soft-green: #ecfdf3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 3;
      background: rgba(246, 247, 249, .94);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(10px);
    }
    .wrap { width: min(1480px, calc(100vw - 32px)); margin: 0 auto; }
    .topbar {
      min-height: 72px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    h1 { margin: 0; font-size: 22px; letter-spacing: 0; }
    .subtitle { color: var(--muted); font-size: 13px; margin-top: 2px; }
    .controls {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    label { color: var(--muted); font-size: 12px; }
    select, input {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      padding: 0 10px;
      font: inherit;
    }
    input[type="number"] { width: 76px; }
    main { padding: 20px 0 28px; }
    .cards {
      display: grid;
      grid-template-columns: repeat(5, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }
    .card, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .card { padding: 14px; min-height: 92px; }
    .card .label { color: var(--muted); font-size: 12px; }
    .card .value { margin-top: 6px; font-size: 25px; font-weight: 700; }
    .card .hint { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 14px;
    }
    .panel { padding: 14px; }
    .panel h2 {
      margin: 0 0 10px;
      font-size: 15px;
      letter-spacing: 0;
    }
    .chart {
      width: 100%;
      height: 260px;
      display: block;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .search { width: min(360px, 100%); }
    .table-wrap {
      overflow: auto;
      max-height: calc(100vh - 290px);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      min-width: 1180px;
      background: #fff;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 9px 10px;
      text-align: right;
      white-space: nowrap;
      vertical-align: middle;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #f9fafb;
      color: #374151;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    td:first-child, th:first-child,
    td:nth-child(2), th:nth-child(2) { text-align: left; }
    .name {
      max-width: 360px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 650;
    }
    .ok { background: var(--soft-green); color: var(--green); }
    .warn { background: var(--soft-amber); color: var(--amber); }
    .bad { background: var(--soft-red); color: var(--red); }
    .info { background: var(--soft-blue); color: var(--accent); }
    .pos { color: var(--green); font-weight: 650; }
    .neg { color: var(--red); font-weight: 650; }
    .muted { color: var(--muted); }
    @media (max-width: 1100px) {
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .grid { grid-template-columns: 1fr; }
      .topbar { align-items: flex-start; flex-direction: column; padding: 14px 0; }
      .controls { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap topbar">
      <div>
        <h1>宁波多多6月每日看板</h1>
        <div class="subtitle">销量变化、库存差异、周转天数和补货优先级</div>
      </div>
      <div class="controls">
        <label>日期 <select id="dateSelect"></select></label>
        <label>预期口径 <select id="basisSelect">
          <option value="mayAverage">5月平均</option>
          <option value="aprilMax">4月MAX</option>
          <option value="selectedSales">当日销量</option>
        </select></label>
        <label>补货阈值 <input id="thresholdInput" type="number" min="1" step="1" value="7"> 天</label>
      </div>
    </div>
  </header>
  <main class="wrap">
    <section class="cards">
      <div class="card"><div class="label">当日销量</div><div id="kpiSales" class="value">-</div><div id="kpiSalesHint" class="hint">-</div></div>
      <div class="card"><div class="label">剩余库存</div><div id="kpiStock" class="value">-</div><div class="hint">选中日期日末库存</div></div>
      <div class="card"><div class="label">低于补货阈值</div><div id="kpiRisk" class="value">-</div><div id="kpiRiskHint" class="hint">-</div></div>
      <div class="card"><div class="label">库存低于预期日销</div><div id="kpiShort" class="value">-</div><div class="hint">剩余库存 < 预期日销</div></div>
      <div class="card"><div class="label">平均周转天数</div><div id="kpiTurnover" class="value">-</div><div class="hint">剩余库存 / 预期日销</div></div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>每日总销量趋势</h2>
        <canvas id="salesTrend" class="chart"></canvas>
      </div>
      <div class="panel">
        <h2>当日销量 TOP 10</h2>
        <canvas id="topSales" class="chart"></canvas>
      </div>
    </section>

    <section class="panel">
      <div class="toolbar">
        <h2>商品明细</h2>
        <input id="searchInput" class="search" placeholder="搜索商品名称 / ID / 条码">
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th data-sort="name">商品</th>
              <th data-sort="id">ID</th>
              <th data-sort="sales">当日销量</th>
              <th data-sort="salesChange">销量变化</th>
              <th data-sort="remaining">剩余库存</th>
              <th data-sort="expected">预期日销</th>
              <th data-sort="dailyGap">库存-预期</th>
              <th data-sort="safetyGap">距补货线</th>
              <th data-sort="turnoverDays">可周转</th>
              <th data-sort="price">价格</th>
              <th data-sort="cloudShortage">云仓少货</th>
              <th data-sort="schedule">排期</th>
              <th data-sort="note">备注</th>
            </tr>
          </thead>
          <tbody id="productBody"></tbody>
        </table>
      </div>
    </section>
  </main>

  <script>
    const products = ${escapeScriptJson(data.products)};
    const dates = ${escapeScriptJson(data.dates)};
    const state = { date: dates[dates.length - 1], basis: 'mayAverage', threshold: 7, query: '', sort: 'safetyGap', dir: 'asc' };

    const fmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
    const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

    function num(value) { return Number.isFinite(value) ? value : 0; }
    function formatNum(value) { return Number.isFinite(value) ? fmt.format(value) : '-'; }
    function formatMoney(value) { return Number.isFinite(value) ? '￥' + money.format(value) : '-'; }
    function dateText(iso) { return iso.replace('2026-', '6/').replace('-', '/'); }

    function dailyOf(product, date) {
      return product.daily.find(day => day.date === date) || {};
    }

    function previousDate(date) {
      const index = dates.indexOf(date);
      return index > 0 ? dates[index - 1] : null;
    }

    function expectedSales(product, selected) {
      if (state.basis === 'aprilMax') return num(product.aprilMax);
      if (state.basis === 'selectedSales') return num(selected.sales);
      return num(product.mayAverage);
    }

    function enrichedRows() {
      const prev = previousDate(state.date);
      return products.map(product => {
        const selected = dailyOf(product, state.date);
        const previous = prev ? dailyOf(product, prev) : {};
        const expected = expectedSales(product, selected);
        const remaining = Number.isFinite(selected.remaining) ? selected.remaining : num(product.finalCloudStock);
        const sales = num(selected.sales);
        const salesChange = sales - num(previous.sales);
        const dailyGap = remaining - expected;
        const safetyStock = expected * state.threshold;
        const safetyGap = remaining - safetyStock;
        const turnoverDays = expected > 0 ? remaining / expected : null;
        return {
          product, selected, previous, expected, remaining, sales, salesChange,
          dailyGap, safetyGap, turnoverDays,
          risk: expected > 0 && turnoverDays <= state.threshold,
        };
      });
    }

    function riskClass(row) {
      if (!Number.isFinite(row.turnoverDays)) return 'info';
      if (row.turnoverDays <= Math.max(2, state.threshold / 2)) return 'bad';
      if (row.turnoverDays <= state.threshold) return 'warn';
      return 'ok';
    }

    function riskText(row) {
      if (!Number.isFinite(row.turnoverDays)) return '无预期';
      if (row.turnoverDays <= Math.max(2, state.threshold / 2)) return '立即补';
      if (row.turnoverDays <= state.threshold) return '需关注';
      return '充足';
    }

    function renderKpis(rows) {
      const totalSales = rows.reduce((sum, row) => sum + row.sales, 0);
      const previous = previousDate(state.date);
      const previousTotal = previous ? products.reduce((sum, product) => sum + num(dailyOf(product, previous).sales), 0) : 0;
      const totalStock = rows.reduce((sum, row) => sum + num(row.remaining), 0);
      const riskRows = rows.filter(row => row.risk);
      const shortRows = rows.filter(row => row.expected > 0 && row.dailyGap < 0);
      const turnoverRows = rows.filter(row => Number.isFinite(row.turnoverDays));
      const avgTurnover = turnoverRows.length ? turnoverRows.reduce((sum, row) => sum + row.turnoverDays, 0) / turnoverRows.length : null;

      document.getElementById('kpiSales').textContent = formatNum(totalSales);
      const diff = totalSales - previousTotal;
      document.getElementById('kpiSalesHint').innerHTML = previous ? '较前日 ' + signed(diff) : '首日无前日对比';
      document.getElementById('kpiStock').textContent = formatNum(totalStock);
      document.getElementById('kpiRisk').textContent = riskRows.length;
      document.getElementById('kpiRiskHint').textContent = '阈值：' + state.threshold + ' 天';
      document.getElementById('kpiShort').textContent = shortRows.length;
      document.getElementById('kpiTurnover').textContent = Number.isFinite(avgTurnover) ? formatNum(avgTurnover) + '天' : '-';
    }

    function signed(value) {
      const cls = value >= 0 ? 'pos' : 'neg';
      const prefix = value > 0 ? '+' : '';
      return '<span class="' + cls + '">' + prefix + formatNum(value) + '</span>';
    }

    function renderTable(rows) {
      const q = state.query.toLowerCase();
      const filtered = rows.filter(({ product }) => {
        return !q || product.name.toLowerCase().includes(q) || product.id.toLowerCase().includes(q) || product.barcode.toLowerCase().includes(q);
      });
      filtered.sort((a, b) => {
        const av = sortValue(a, state.sort);
        const bv = sortValue(b, state.sort);
        const result = typeof av === 'string' ? av.localeCompare(String(bv), 'zh-CN') : num(av) - num(bv);
        return state.dir === 'asc' ? result : -result;
      });

      document.getElementById('productBody').innerHTML = filtered.map(row => {
        const product = row.product;
        return '<tr>' +
          '<td><div class="name" title="' + esc(product.name) + '">' + esc(product.name) + '</div></td>' +
          '<td>' + esc(product.id) + '</td>' +
          '<td>' + formatNum(row.sales) + '</td>' +
          '<td>' + signed(row.salesChange) + '</td>' +
          '<td>' + formatNum(row.remaining) + '</td>' +
          '<td>' + formatNum(row.expected) + '</td>' +
          '<td class="' + (row.dailyGap >= 0 ? 'pos' : 'neg') + '">' + formatNum(row.dailyGap) + '</td>' +
          '<td class="' + (row.safetyGap >= 0 ? 'pos' : 'neg') + '">' + formatNum(row.safetyGap) + '</td>' +
          '<td><span class="tag ' + riskClass(row) + '">' + (Number.isFinite(row.turnoverDays) ? formatNum(row.turnoverDays) + '天' : '-') + ' · ' + riskText(row) + '</span></td>' +
          '<td>' + formatMoney(row.selected.price) + '</td>' +
          '<td class="' + (num(product.cloudShortage) < 0 ? 'neg' : '') + '">' + formatNum(product.cloudShortage) + '</td>' +
          '<td>' + esc(product.schedule) + '</td>' +
          '<td class="muted">' + esc(product.note) + '</td>' +
        '</tr>';
      }).join('');
    }

    function sortValue(row, key) {
      if (key in row) return row[key];
      if (key === 'name') return row.product.name;
      if (key === 'id') return row.product.id;
      if (key === 'price') return row.selected.price;
      if (key === 'cloudShortage') return row.product.cloudShortage;
      if (key === 'schedule') return row.product.schedule;
      if (key === 'note') return row.product.note;
      return '';
    }

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    function setupCanvas(canvas) {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      return { ctx, w: rect.width, h: rect.height };
    }

    function drawSalesTrend() {
      const canvas = document.getElementById('salesTrend');
      const { ctx, w, h } = setupCanvas(canvas);
      ctx.clearRect(0, 0, w, h);
      const points = dates.map(date => products.reduce((sum, product) => sum + num(dailyOf(product, date).sales), 0));
      drawAxes(ctx, w, h);
      const max = Math.max(...points, 1);
      const left = 42, right = 16, top = 18, bottom = 34;
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      points.forEach((value, index) => {
        const x = left + (w - left - right) * (index / Math.max(1, points.length - 1));
        const y = top + (h - top - bottom) * (1 - value / max);
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      points.forEach((value, index) => {
        const x = left + (w - left - right) * (index / Math.max(1, points.length - 1));
        const y = top + (h - top - bottom) * (1 - value / max);
        ctx.fillStyle = dates[index] === state.date ? '#dc2626' : '#2563eb';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#374151';
        ctx.font = '12px sans-serif';
        ctx.fillText(dateText(dates[index]), x - 14, h - 10);
      });
    }

    function drawTopSales(rows) {
      const canvas = document.getElementById('topSales');
      const { ctx, w, h } = setupCanvas(canvas);
      ctx.clearRect(0, 0, w, h);
      const topRows = [...rows].sort((a, b) => b.sales - a.sales).slice(0, 10);
      const max = Math.max(...topRows.map(row => row.sales), 1);
      const left = 136, right = 40, top = 8;
      const rowH = (h - top - 8) / Math.max(1, topRows.length);
      ctx.font = '12px sans-serif';
      topRows.forEach((row, index) => {
        const y = top + index * rowH + 6;
        const barW = (w - left - right) * (row.sales / max);
        ctx.fillStyle = '#eef2ff';
        ctx.fillRect(left, y, w - left - right, Math.max(14, rowH - 8));
        ctx.fillStyle = '#2563eb';
        ctx.fillRect(left, y, barW, Math.max(14, rowH - 8));
        ctx.fillStyle = '#374151';
        ctx.fillText(row.product.name.slice(0, 12), 4, y + 12);
        ctx.fillText(formatNum(row.sales), left + barW + 6, y + 12);
      });
    }

    function drawAxes(ctx, w, h) {
      ctx.strokeStyle = '#dfe3ea';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(42, 18);
      ctx.lineTo(42, h - 34);
      ctx.lineTo(w - 16, h - 34);
      ctx.stroke();
    }

    function render() {
      const rows = enrichedRows();
      renderKpis(rows);
      renderTable(rows);
      drawSalesTrend();
      drawTopSales(rows);
    }

    function init() {
      document.getElementById('dateSelect').innerHTML = dates.map(date => '<option value="' + date + '">' + date + '</option>').join('');
      document.getElementById('dateSelect').value = state.date;
      document.getElementById('dateSelect').addEventListener('change', event => { state.date = event.target.value; render(); });
      document.getElementById('basisSelect').addEventListener('change', event => { state.basis = event.target.value; render(); });
      document.getElementById('thresholdInput').addEventListener('input', event => { state.threshold = Number(event.target.value) || 1; render(); });
      document.getElementById('searchInput').addEventListener('input', event => { state.query = event.target.value.trim(); render(); });
      document.querySelectorAll('th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
          const key = th.dataset.sort;
          if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
          else { state.sort = key; state.dir = key === 'safetyGap' ? 'asc' : 'desc'; }
          render();
        });
      });
      window.addEventListener('resize', render);
      render();
    }

    init();
  </script>
</body>
</html>`;
}

const text = await readFile(SOURCE, 'utf8');
const rows = parseCsv(text);
const products = parseSource(rows);
const dates = products[0]?.daily.map((day) => day.date) || [];

await writeFile(OUTPUT, html({ products, dates }), 'utf8');
console.log(`Wrote ${OUTPUT} with ${products.length} products and ${dates.length} dates.`);
