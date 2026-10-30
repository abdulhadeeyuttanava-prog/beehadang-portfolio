'use strict';
// Beehadang's portfolio — stage 1.
// Everything lives in this browser's IndexedDB. The only network calls are price/FX lookups
// (asset symbols only, never balances).

// ---------- storage ----------
const DB_NAME = 'portfolio', STORE = 'kv', KEY = 'state';

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function loadState() {
  const db = await idb();
  return new Promise(res => {
    const q = db.transaction(STORE).objectStore(STORE).get(KEY);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => res(null);
  });
}
async function saveState() {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(S, KEY);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

// ---------- default data ----------
const TYPES = { stock: 'หุ้น/ETF', crypto: 'คริปโต', gold: 'ทอง', cash: 'เงินฝาก' };
const TX = { buy: 'ซื้อ', sell: 'ขาย', dividend: 'ปันผล', interest: 'ดอกเบี้ย', fee: 'ค่าธรรมเนียม' };
// CoinGecko ids for coins seen in the user's accounts.
const COINGECKO = { BTC: 'bitcoin', ETH: 'ethereum', XRP: 'ripple', DOT: 'polkadot', ZIL: 'zilliqa',
  LUNC: 'terra-luna', USDT: 'tether', KUB: 'bitkub-coin', BNB: 'binancecoin', SOL: 'solana', ADA: 'cardano' };

const uid = () => Math.random().toString(36).slice(2, 10);

function defaultState() {
  const acc = n => ({ id: uid(), name: n });
  const accounts = ['Dime', 'Bitkub', 'Bitazza', 'Binance', 'ธนาคาร'].map(acc);
  const a = (symbol, type, currency, extra = {}) => ({ id: uid(), symbol, name: symbol, type, currency,
    priceSource: type === 'crypto' ? 'coingecko' : type === 'stock' ? 'finnhub' : 'manual',
    coingeckoId: COINGECKO[symbol] || '', country: '', sector: '', ...extra });
  const assets = [
    a('TSM', 'stock', 'USD', { name: 'Taiwan Semiconductor', country: 'ไต้หวัน', sector: 'เซมิคอนดักเตอร์' }),
    a('SPUS', 'stock', 'USD', { name: 'SP Funds S&P 500 Sharia ETF', country: 'สหรัฐ', sector: 'ETF' }),
    a('SPWO', 'stock', 'USD', { name: 'SP Funds World ex-US ETF', country: 'ทั่วโลก', sector: 'ETF' }),
    a('GOOG', 'stock', 'USD', { name: 'Alphabet', country: 'สหรัฐ', sector: 'เทคโนโลยี' }),
    a('CVX', 'stock', 'USD', { name: 'Chevron', country: 'สหรัฐ', sector: 'พลังงาน' }),
    ...['BTC', 'ETH', 'XRP', 'DOT', 'ZIL', 'LUNC', 'USDT', 'KUB'].map(s => a(s, 'crypto', 'THB')),
    a('GOLD', 'gold', 'THB', { name: 'ทองคำ (Dime)' }),
    a('DEPOSIT', 'cash', 'THB', { name: 'เงินฝากธนาคาร', priceSource: 'fixed' }),
  ];
  return {
    version: 1,
    settings: { displayName: "Beehadang's portfolio", finnhubKey: '',
      targets: { stock: 70, crypto: 15, gold: 5, cash: 10 }, band: 5, concentrationLimit: 25 },
    accounts, assets, txns: [], dca: [], prices: {}, fx: { USD: 33.68, at: null },
  };
}

let S;

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 2) => Number.isFinite(n) ? n.toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';
const baht = n => fmt(n, 0) + ' ฿';
const pct = n => Number.isFinite(n) ? (n >= 0 ? '+' : '') + fmt(n * 100, 2) + '%' : '–';
const cls = n => n > 0 ? 'good' : n < 0 ? 'bad' : '';
const today = () => new Date().toISOString().slice(0, 10);
const asset = id => S.assets.find(a => a.id === id);
const account = id => S.accounts.find(a => a.id === id);
const fxNow = cur => cur === 'USD' ? (S.fx.USD || 0) : 1;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600);
}

// ---------- portfolio maths ----------
// Average-cost method, everything converted to THB at each transaction's own FX rate.
function computeHoldings() {
  const h = {};
  const get = id => h[id] ??= { assetId: id, qty: 0, costThb: 0, costCur: 0, realizedThb: 0, incomeThb: 0, byAccount: {} };
  const txns = [...S.txns].sort((a, b) => a.date.localeCompare(b.date));
  for (const t of txns) {
    const x = get(t.assetId), fx = t.fx || 1, a = asset(t.assetId);
    const sameCur = a && t.currency === a.currency;
    if (t.type === 'buy') {
      const gross = t.qty * t.price + (t.fee || 0);
      x.qty += t.qty; x.costThb += gross * fx; if (sameCur) x.costCur += gross;
      x.byAccount[t.accountId] = (x.byAccount[t.accountId] || 0) + t.qty;
    } else if (t.type === 'sell') {
      const q = Math.min(t.qty, x.qty), avgThb = x.qty ? x.costThb / x.qty : 0, avgCur = x.qty ? x.costCur / x.qty : 0;
      x.realizedThb += (q * t.price - (t.fee || 0)) * fx - avgThb * q;
      x.costThb -= avgThb * q; x.costCur -= avgCur * q; x.qty -= q;
      x.byAccount[t.accountId] = (x.byAccount[t.accountId] || 0) - q;
    } else if (t.type === 'dividend' || t.type === 'interest') {
      x.incomeThb += ((t.amount || 0) - (t.tax || 0)) * fx;
    } else if (t.type === 'fee') {
      x.realizedThb -= (t.amount || 0) * fx;
    }
  }
  const rows = [];
  for (const x of Object.values(h)) {
    const a = asset(x.assetId); if (!a) continue;
    const p = priceOf(a);
    x.asset = a;
    x.price = p;
    x.valueCur = p == null ? null : x.qty * p;
    x.valueThb = p == null ? null : x.valueCur * fxNow(a.currency);
    x.unrealThb = x.valueThb == null ? null : x.valueThb - x.costThb;
    x.unrealPct = x.costThb > 0 && x.unrealThb != null ? x.unrealThb / x.costThb : null;
    x.unrealCur = x.valueCur != null && a.currency !== 'THB' ? x.valueCur - x.costCur : null;
    x.fxEffectThb = x.unrealCur != null ? x.unrealThb - x.unrealCur * fxNow(a.currency) : null;
    if (Math.abs(x.qty) > 1e-12 || x.realizedThb || x.incomeThb) rows.push(x);
  }
  return rows.sort((a, b) => (b.valueThb || 0) - (a.valueThb || 0));
}

function priceOf(a) {
  if (a.priceSource === 'fixed') return 1;
  return S.prices[a.id]?.price ?? null;
}

// Money-weighted return. Flows from the investor's view: buys negative, sells/income positive.
function xirr(flows) {
  if (flows.length < 2 || !flows.some(f => f.v > 0) || !flows.some(f => f.v < 0)) return null;
  const t0 = flows[0].d;
  // Annualising less than ~3 months of history gives wild numbers, so wait for more data.
  if (flows[flows.length - 1].d - t0 < 90 * 864e5) return null;
  const yrs = f => (f.d - t0) / 31557600000;
  const npv = r => flows.reduce((s, f) => s + f.v / Math.pow(1 + r, yrs(f)), 0);
  let lo = -0.9999, hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, v = npv(mid);
    if (Math.abs(v) < 1e-6) return mid;
    if (npv(lo) * v < 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

function portfolioFlows(holdings, filterAssetId) {
  const flows = [];
  for (const t of S.txns) {
    if (filterAssetId && t.assetId !== filterAssetId) continue;
    const fx = t.fx || 1, d = new Date(t.date).getTime();
    if (t.type === 'buy') flows.push({ d, v: -(t.qty * t.price + (t.fee || 0)) * fx });
    else if (t.type === 'sell') flows.push({ d, v: (t.qty * t.price - (t.fee || 0)) * fx });
    else if (t.type === 'dividend' || t.type === 'interest') flows.push({ d, v: ((t.amount || 0) - (t.tax || 0)) * fx });
    else if (t.type === 'fee') flows.push({ d, v: -(t.amount || 0) * fx });
  }
  const value = holdings.filter(h => !filterAssetId || h.assetId === filterAssetId).reduce((s, h) => s + (h.valueThb || 0), 0);
  if (value > 0) flows.push({ d: Date.now(), v: value });
  return flows.sort((a, b) => a.d - b.d);
}

function allocation(holdings) {
  const by = { stock: 0, crypto: 0, gold: 0, cash: 0 };
  let total = 0;
  for (const h of holdings) { if (h.valueThb > 0) { by[h.asset.type] += h.valueThb; total += h.valueThb; } }
  return { by, total };
}

// Split a monthly amount across under-weight groups so the mix moves toward the target without selling.
function dcaSuggestion(amount, alloc) {
  const T = S.settings.targets, newTotal = alloc.total + amount;
  const gaps = {};
  let gapSum = 0;
  for (const k of Object.keys(T)) { gaps[k] = Math.max(0, newTotal * T[k] / 100 - alloc.by[k]); gapSum += gaps[k]; }
  const out = {};
  for (const k of Object.keys(T)) out[k] = gapSum ? amount * gaps[k] / gapSum : amount * T[k] / 100;
  return out;
}

// ---------- prices ----------
async function refreshPrices(silent) {
  const errs = [];
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    if (j?.rates?.THB) S.fx = { USD: j.rates.THB, at: new Date().toISOString() };
  } catch { errs.push('อัตราแลกเปลี่ยน'); }

  const coins = S.assets.filter(a => a.priceSource === 'coingecko' && a.coingeckoId);
  if (coins.length) {
    try {
      const ids = [...new Set(coins.map(a => a.coingeckoId))].join(',');
      const j = await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=thb`)).json();
      for (const a of coins) {
        const p = j[a.coingeckoId]?.thb;
        if (p != null) S.prices[a.id] = { price: p, at: new Date().toISOString() };
      }
    } catch { errs.push('คริปโต'); }
  }

  const stocks = S.assets.filter(a => a.priceSource === 'finnhub');
  if (stocks.length && S.settings.finnhubKey) {
    for (const a of stocks) {
      try {
        const j = await (await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(a.symbol)}&token=${encodeURIComponent(S.settings.finnhubKey)}`)).json();
        if (j?.c) S.prices[a.id] = { price: j.c, at: new Date().toISOString() };
      } catch { errs.push(a.symbol); }
    }
  } else if (stocks.length && !silent) errs.push('หุ้น (ยังไม่ได้ใส่คีย์ Finnhub ในตั้งค่า)');

  S.lastRefresh = new Date().toISOString();
  await saveState();
  render();
  if (!silent) toast(errs.length ? 'อัปเดตไม่ได้: ' + errs.join(', ') : 'อัปเดตราคาแล้ว');
}

// ---------- encrypted backup ----------
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function exportBackup(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(S)));
  const body = JSON.stringify({ app: 'beehadang-portfolio', v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) });
  const name = `portfolio-backup-${today()}.json`;
  const file = new File([body], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); }
    catch (e) { if (e.name !== 'AbortError') throw e; return; }
  } else {
    const url = URL.createObjectURL(file);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  S.lastBackup = new Date().toISOString(); S.dirty = false; await saveState();
}
async function importBackup(file, pass) {
  const j = JSON.parse(await file.text());
  const key = await deriveKey(pass, unb64(j.salt));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(j.iv) }, key, unb64(j.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// Starter file: plain JSON of opening positions, referenced by account name and symbol.
// It is merged into what is already on the device instead of replacing it.
async function importStarter(j) {
  if (!confirm(`นำเข้า ${j.txns.length} รายการจากไฟล์ "${j.title || 'ข้อมูลเริ่มต้น'}"?`)) return;
  let added = 0, skipped = 0;
  for (const r of j.txns) {
    let acc = S.accounts.find(a => a.name.toLowerCase() === r.account.toLowerCase());
    if (!acc) { acc = { id: uid(), name: r.account }; S.accounts.push(acc); }
    let a = S.assets.find(x => x.symbol === r.symbol);
    if (!a) {
      const type = r.assetType || 'crypto';
      a = { id: uid(), symbol: r.symbol, name: r.name || r.symbol, type, currency: r.currency || 'THB',
        priceSource: type === 'crypto' ? 'coingecko' : type === 'cash' ? 'fixed' : 'manual',
        coingeckoId: COINGECKO[r.symbol] || '', country: '', sector: '' };
      S.assets.push(a);
    }
    const key = r.importKey || `${r.date}|${r.account}|${r.symbol}|${r.qty}`;
    if (S.txns.some(t => t.importKey === key)) { skipped++; continue; }
    S.txns.push({ id: uid(), type: r.type || 'buy', date: r.date, accountId: acc.id, assetId: a.id, qty: r.qty, price: r.price,
      amount: r.amount, currency: r.currency || 'THB', fx: r.fx || 1, fee: r.fee, reason: r.reason || '', importKey: key });
    if (r.marketPrice != null && !S.prices[a.id]) S.prices[a.id] = { price: r.marketPrice, at: r.date + 'T12:00:00Z' };
    added++;
  }
  S.dirty = true; await saveState(); render();
  toast(`นำเข้าแล้ว ${added} รายการ${skipped ? ` (ข้าม ${skipped} ที่เคยนำเข้าแล้ว)` : ''}`);
}

// "account,symbol,qty,price[,currency]" per line → starter rows dated today.
function parsePasted(text) {
  const txns = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map((l, i) => {
    const [account, symbol, qty, price, currency = 'THB'] = l.split(',').map(x => x.trim());
    const q = Number(qty), p = Number(price);
    if (!account || !symbol || !(q > 0) || !(p >= 0)) throw new Error(`บรรทัด ${i + 1}`);
    const sym = symbol.toUpperCase(), cur = currency.toUpperCase();
    return { date: today(), account, symbol: sym, qty: q, price: p, currency: cur, fx: fxNow(cur),
      assetType: sym === 'DEPOSIT' ? 'cash' : undefined, marketPrice: p, reason: 'ยอดยกมา (วางจากข้อความ)' };
  });
  return { starter: 1, title: 'ข้อความที่วาง', txns };
}

// ---------- views ----------
let tab = 'overview';

function render() {
  $('#appTitle').textContent = S.settings.displayName;
  document.title = S.settings.displayName;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#view').innerHTML = { overview, holdings: holdingsView, txns: txnsView, journal, settings: settingsView }[tab]();
  bindView();
}

function alertsHtml(hs, alloc) {
  const out = [], T = S.settings.targets, band = S.settings.band;
  if (alloc.total > 0) {
    for (const k of Object.keys(T)) {
      const cur = alloc.by[k] / alloc.total * 100, diff = cur - T[k];
      if (Math.abs(diff) > band)
        out.push(`<div class="card alert">⚖️ <b>${TYPES[k]}</b> อยู่ที่ ${fmt(cur, 1)}% เป้าหมาย ${T[k]}% (${diff > 0 ? 'เกิน' : 'ขาด'} ${fmt(Math.abs(diff), 1)}%) ควร rebalance</div>`);
    }
    const lim = S.settings.concentrationLimit;
    const bySym = {};
    for (const h of hs) if (h.valueThb > 0) bySym[h.asset.symbol] = (bySym[h.asset.symbol] || 0) + h.valueThb;
    for (const [s, v] of Object.entries(bySym)) {
      const p = v / alloc.total * 100;
      if (p > lim && s !== 'DEPOSIT') out.push(`<div class="card alert badc">🎯 <b>${esc(s)}</b> ตัวเดียวคิดเป็น ${fmt(p, 1)}% ของพอร์ต (เกิน ${lim}%)</div>`);
    }
  }
  const d = new Date(), ym = today().slice(0, 7);
  for (const p of S.dca) {
    const done = S.txns.some(t => t.dcaId === p.id && t.date.startsWith(ym));
    if (!done && d.getDate() >= p.day) {
      const a = asset(p.assetId);
      out.push(`<div class="card alert">📅 ถึงรอบ DCA <b>${esc(a?.symbol)}</b> ${fmt(p.amount, 0)} ${p.currency} <button class="small" data-dca="${p.id}">บันทึกรายการ</button></div>`);
    }
  }
  if (S.dirty && S.txns.length) out.push(`<div class="card alert">💾 มีข้อมูลใหม่ที่ยังไม่ได้สำรอง <button class="small ghost" data-go="settings">สำรองเลย</button></div>`);
  const due = S.txns.filter(t => t.reviewDate && t.reviewDate <= today() && !t.reviewed);
  if (due.length) out.push(`<div class="card alert">📝 มี ${due.length} บันทึกถึงวันทบทวน <button class="small ghost" data-go="journal">ดู</button></div>`);
  return out.join('');
}

function overview() {
  if (!S.txns.length) return `<div class="card empty"><p>ยังไม่มีรายการ</p><p class="muted">กดปุ่ม ＋ เพื่อบันทึกการซื้อครั้งแรก หรือบันทึกยอดที่ถืออยู่ตอนนี้เป็นรายการซื้อ</p></div>` + alertsHtml([], { total: 0 });
  const hs = computeHoldings(), alloc = allocation(hs);
  const cost = hs.reduce((s, h) => s + h.costThb, 0);
  const unreal = hs.reduce((s, h) => s + (h.unrealThb || 0), 0);
  const realized = hs.reduce((s, h) => s + h.realizedThb, 0);
  const income = hs.reduce((s, h) => s + h.incomeThb, 0);
  const irr = xirr(portfolioFlows(hs));
  const missing = hs.filter(h => h.qty > 0 && h.price == null).map(h => h.asset.symbol);
  const T = S.settings.targets;
  const bars = Object.keys(T).map(k => {
    const cur = alloc.total ? alloc.by[k] / alloc.total * 100 : 0;
    return `<div style="margin-bottom:10px"><div class="row" style="border:0;padding:0"><span>${TYPES[k]}</span>
      <span class="muted">${fmt(cur, 1)}% / เป้า ${T[k]}% · ${baht(alloc.by[k])}</span></div>
      <div class="bar"><i style="width:${Math.min(cur, 100)}%;background:var(--${k})"></i><b style="left:${T[k]}%"></b></div></div>`;
  }).join('');
  return `
  <div class="card">
    <h2>มูลค่าพอร์ตทั้งหมด</h2>
    <div class="big">${baht(alloc.total)}</div>
    <div class="muted">ต้นทุน ${baht(cost)} · USD/THB ${fmt(S.fx.USD, 2)}${S.lastRefresh ? ' · อัปเดต ' + new Date(S.lastRefresh).toLocaleString('th-TH') : ''}</div>
    ${missing.length ? `<div class="muted warn">ยังไม่มีราคา: ${esc(missing.join(', '))}</div>` : ''}
  </div>
  <div class="grid2">
    <div class="card stat"><h2>กำไรที่ยังไม่ขาย</h2><div class="v ${cls(unreal)}">${baht(unreal)}</div><div class="muted">${pct(cost ? unreal / cost : null)}</div></div>
    <div class="card stat"><h2>XIRR ต่อปี</h2><div class="v ${cls(irr)}">${pct(irr)}</div><div class="muted">${irr == null ? 'ต้องมีข้อมูลอย่างน้อย 3 เดือน' : 'คิดตามจังหวะเงินที่ใส่'}</div></div>
    <div class="card stat"><h2>กำไรที่ขายแล้ว</h2><div class="v ${cls(realized)}">${baht(realized)}</div></div>
    <div class="card stat"><h2>ปันผล/ดอกเบี้ยสุทธิ</h2><div class="v good">${baht(income)}</div></div>
  </div>
  ${alertsHtml(hs, alloc)}
  <div class="card"><h2>สัดส่วนเทียบเป้าหมาย</h2>${bars}<div class="muted">เส้นดำ = เป้าหมาย · แจ้งเตือนเมื่อห่างเกิน ±${S.settings.band}%</div></div>
  <div class="card"><h2>เดือนนี้ควร DCA อะไร</h2>
    <label>เงินที่จะลงเดือนนี้ (บาท)</label><input id="dcaAmt" type="number" inputmode="decimal" value="${S.settings.lastDcaAmount || 15000}">
    <div id="dcaOut" style="margin-top:8px"></div></div>
  ${retirementHtml(alloc.total)}`;
}

function retirementHtml(total) {
  const r = S.settings.retire || { age: 28, retireAge: 55, monthlyIncome: 50000, yield: 4, ret: 7 };
  const n = (r.retireAge - r.age) * 12, i = r.ret / 100 / 12;
  const need = r.monthlyIncome * 12 / (r.yield / 100);
  const fvNow = total * Math.pow(1 + i, n);
  const factor = i ? (Math.pow(1 + i, n) - 1) / i : n;
  const monthly = n > 0 ? Math.max(0, (need - fvNow) / factor) : 0;
  return `<div class="card"><h2>เป้าเกษียณ</h2>
    <div>ต้องมีพอร์ต <b>${baht(need)}</b> ตอนอายุ ${r.retireAge} เพื่อปันผล ${baht(r.monthlyIncome)}/เดือน (ปันผล ${r.yield}%)</div>
    <div style="margin-top:6px">ต้องลงทุนเพิ่มประมาณ <b>${baht(monthly)}</b>/เดือน ถ้าผลตอบแทนเฉลี่ย ${r.ret}%/ปี</div>
    <div class="muted">ตัวเลขโดยประมาณ ยังไม่คิดเงินเฟ้อ · แก้สมมติฐานได้ในตั้งค่า</div></div>`;
}

function holdingsView() {
  const hs = computeHoldings().filter(h => h.qty > 1e-12);
  if (!hs.length) return `<div class="card empty">ยังไม่มีสินทรัพย์ที่ถืออยู่</div>`;
  const total = hs.reduce((s, h) => s + (h.valueThb || 0), 0);
  const groups = Object.keys(TYPES).map(k => {
    const g = hs.filter(h => h.asset.type === k);
    if (!g.length) return '';
    return `<div class="card"><h2>${TYPES[k]}</h2>${g.map(h => {
      const accs = Object.entries(h.byAccount).filter(([, q]) => q > 1e-12).map(([id]) => account(id)?.name).filter(Boolean).join(', ');
      const ir = xirr(portfolioFlows(hs, h.assetId));
      return `<div class="row" data-asset="${h.assetId}">
        <div><b>${esc(h.asset.symbol)}</b> <span class="chip">${total ? fmt((h.valueThb || 0) / total * 100, 1) : 0}%</span>
          <div class="muted">${fmt(h.qty, h.qty < 10 ? 6 : 2)} หน่วย · ${esc(accs)}</div>
          <div class="muted">ต้นทุนเฉลี่ย ${fmt(h.qty ? (h.asset.currency === 'THB' ? h.costThb : h.costCur) / h.qty : 0, 2)} ${h.asset.currency} · ราคา ${h.price == null ? '–' : fmt(h.price, 2)}</div></div>
        <div class="r"><b>${h.valueThb == null ? '–' : baht(h.valueThb)}</b>
          <div class="${cls(h.unrealThb)}">${h.unrealThb == null ? '' : baht(h.unrealThb) + ' (' + pct(h.unrealPct) + ')'}</div>
          ${h.unrealCur != null ? `<div class="muted">${fmt(h.unrealCur, 2)} USD · ค่าเงิน ${baht(h.fxEffectThb)}</div>` : ''}
          ${ir != null ? `<div class="muted">XIRR ${pct(ir)}</div>` : ''}
          ${h.incomeThb ? `<div class="muted">ปันผล ${baht(h.incomeThb)}</div>` : ''}</div></div>`;
    }).join('')}</div>`;
  }).join('');
  return groups + `<p class="muted">แตะสินทรัพย์ที่เป็นราคาตั้งเอง (เช่น ทอง) เพื่อใส่ราคาล่าสุด</p>`;
}

function txnLine(t) {
  const a = asset(t.assetId), fx = t.fx || 1;
  const amt = t.type === 'buy' || t.type === 'sell' ? t.qty * t.price : t.amount;
  return `<div class="row" data-txn="${t.id}"><div><b>${TX[t.type]} ${esc(a?.symbol)}</b>
    <div class="muted">${t.date} · ${esc(account(t.accountId)?.name || '')}${t.type === 'buy' || t.type === 'sell' ? ` · ${fmt(t.qty, 6)} @ ${fmt(t.price, 2)}` : ''}</div>
    ${t.reason ? `<div class="muted">“${esc(t.reason.slice(0, 80))}”</div>` : ''}</div>
    <div class="r">${fmt(amt, 2)} ${t.currency}${t.currency !== 'THB' ? `<div class="muted">${baht(amt * fx)}</div>` : ''}</div></div>`;
}

function txnsView() {
  if (!S.txns.length) return `<div class="card empty">ยังไม่มีรายการ กด ＋ เพื่อเพิ่ม</div>`;
  const list = [...S.txns].sort((a, b) => b.date.localeCompare(a.date));
  return `<div class="card"><h2>รายการทั้งหมด (${list.length})</h2>${list.map(txnLine).join('')}</div><p class="muted">แตะรายการเพื่อแก้ไขหรือลบ</p>`;
}

function journal() {
  const list = S.txns.filter(t => t.reason || t.reviewDate).sort((a, b) => b.date.localeCompare(a.date));
  if (!list.length) return `<div class="card empty">ยังไม่มีบันทึก ใส่ "เหตุผล" ตอนเพิ่มรายการ แล้วจะมาแสดงที่นี่</div>`;
  return list.map(t => {
    const a = asset(t.assetId), p = priceOf(a);
    const since = (t.type === 'buy' || t.type === 'sell') && p != null && t.price && a.currency === t.currency ? p / t.price - 1 : null;
    const due = t.reviewDate && t.reviewDate <= today() && !t.reviewed;
    return `<div class="card ${due ? 'alert' : ''}"><div class="row" style="border:0;padding:0"><b>${TX[t.type]} ${esc(a?.symbol)} · ${t.date}</b>
      ${since != null ? `<span class="${cls(since)}">ราคาตั้งแต่วันนั้น ${pct(since)}</span>` : ''}</div>
      ${t.reason ? `<p><b>เหตุผล:</b> ${esc(t.reason)}</p>` : ''}
      ${t.exitPlan ? `<p><b>จะเปลี่ยนใจเมื่อ:</b> ${esc(t.exitPlan)}</p>` : ''}
      ${t.confidence ? `<p class="muted">ความมั่นใจ ${t.confidence}/5</p>` : ''}
      ${t.reviewNote ? `<p><b>ทบทวน:</b> ${esc(t.reviewNote)}</p>` : ''}
      ${t.reviewDate ? `<div class="muted">วันทบทวน ${t.reviewDate} ${t.reviewed ? '✓ ทบทวนแล้ว' : ''}</div>` : ''}
      ${due ? `<div class="actions"><button class="small" data-review="${t.id}">ทบทวนตอนนี้</button></div>` : ''}</div>`;
  }).join('');
}

function settingsView() {
  const st = S.settings, T = st.targets, r = st.retire || { age: 28, retireAge: 55, monthlyIncome: 50000, yield: 4, ret: 7 };
  return `
  <div class="card"><h2>สำรองข้อมูล</h2>
    <p class="muted">ข้อมูลอยู่ในเครื่องนี้เท่านั้น ถ้าลบแอปหรือล้างเบราว์เซอร์ ข้อมูลจะหาย ให้สำรองไฟล์เข้ารหัสไว้ใน iCloud/Google Drive ของคุณเป็นประจำ
    ${S.lastBackup ? '<br>สำรองล่าสุด ' + new Date(S.lastBackup).toLocaleString('th-TH') : ''}</p>
    <div class="actions" style="justify-content:flex-start"><button id="backupBtn">สำรองข้อมูล</button><button id="restoreBtn" class="ghost">กู้คืน / นำเข้าไฟล์</button></div>
    <input type="file" id="restoreFile" accept=".json,application/json" hidden></div>
  <div class="card"><h2>วางข้อมูล</h2>
    <p class="muted">วางข้อความที่ได้จาก Claude แล้วกดนำเข้า บรรทัดละรายการ: บัญชี,สัญลักษณ์,จำนวน,ราคาต่อหน่วย[,สกุลเงิน]</p>
    <textarea id="pasteBox" rows="5" placeholder="Bitazza,ETH,0.6806,75178.13"></textarea>
    <div class="actions" style="justify-content:flex-start"><button id="pasteBtn">นำเข้าจากข้อความ</button></div></div>
  <div class="card"><h2>พอร์ตเป้าหมาย (%)</h2>
    <div class="grid2">${Object.keys(T).map(k => `<div><label>${TYPES[k]}</label><input type="number" data-target="${k}" value="${T[k]}"></div>`).join('')}</div>
    <div class="grid2"><div><label>แจ้งเตือนเมื่อห่างเกิน (±%)</label><input type="number" id="band" value="${st.band}"></div>
    <div><label>เตือนเมื่อตัวเดียวเกิน (%)</label><input type="number" id="conc" value="${st.concentrationLimit}"></div></div></div>
  <div class="card"><h2>เป้าเกษียณ</h2><div class="grid2">
    <div><label>อายุตอนนี้</label><input type="number" data-ret="age" value="${r.age}"></div>
    <div><label>อายุเกษียณ</label><input type="number" data-ret="retireAge" value="${r.retireAge}"></div>
    <div><label>ปันผลที่ต้องการ/เดือน (บาท)</label><input type="number" data-ret="monthlyIncome" value="${r.monthlyIncome}"></div>
    <div><label>อัตราปันผลตอนเกษียณ (%)</label><input type="number" data-ret="yield" value="${r.yield}"></div>
    <div><label>ผลตอบแทนเฉลี่ยที่คาด (%/ปี)</label><input type="number" data-ret="ret" value="${r.ret}"></div></div></div>
  <div class="card"><h2>ราคาอัตโนมัติ</h2>
    <label>คีย์ Finnhub (ฟรี สำหรับราคาหุ้นสหรัฐ)</label><input id="finnhub" value="${esc(st.finnhubKey)}" placeholder="วางคีย์ที่นี่">
    <p class="muted">สมัครฟรีที่ finnhub.io แล้วคัดลอก API key มาวาง คริปโตใช้ CoinGecko และค่าเงินใช้ open.er-api ไม่ต้องใช้คีย์</p></div>
  <div class="card"><h2>แผน DCA</h2>${S.dca.map(p => `<div class="row"><span>${esc(asset(p.assetId)?.symbol)} · ${esc(account(p.accountId)?.name)} · ทุกวันที่ ${p.day}</span>
    <span>${fmt(p.amount, 0)} ${p.currency} <button class="small ghost" data-deldca="${p.id}">ลบ</button></span></div>`).join('') || '<p class="muted">ยังไม่มี</p>'}
    <div class="actions" style="justify-content:flex-start"><button id="addDca" class="ghost">เพิ่มแผน DCA</button></div></div>
  <div class="card"><h2>สินทรัพย์และบัญชี</h2>
    ${S.assets.map(a => `<div class="row" data-editasset="${a.id}"><span><b>${esc(a.symbol)}</b> <span class="muted">${esc(a.name)}</span></span><span class="chip">${TYPES[a.type]} · ${a.currency}</span></div>`).join('')}
    <div class="actions" style="justify-content:flex-start"><button id="addAsset" class="ghost">เพิ่มสินทรัพย์</button><button id="addAccount" class="ghost">เพิ่มบัญชี</button></div>
    <p class="muted">บัญชี: ${S.accounts.map(a => esc(a.name)).join(', ')}</p></div>
  <div class="card"><h2>ทั่วไป</h2><label>ชื่อพอร์ต</label><input id="dispName" value="${esc(st.displayName)}">
    <div class="actions" style="justify-content:flex-start"><button id="saveSettings">บันทึกการตั้งค่า</button></div></div>`;
}

// ---------- forms ----------
function openModal(html, onSubmit) {
  const f = $('#modalForm'), m = $('#modal');
  f.innerHTML = html;
  f.onsubmit = async e => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const ok = await onSubmit(new FormData(f), e.submitter?.value);
    if (ok !== false) m.close();
  };
  m.showModal();
}
const opts = (list, sel, label = x => x.name) => list.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(label(x))}</option>`).join('');

function txnForm(t = {}, preset = {}) {
  const isNew = !t.id;
  t = { type: 'buy', date: today(), currency: 'THB', fx: 1, ...preset, ...t };
  const html = `<h3>${isNew ? 'เพิ่มรายการ' : 'แก้ไขรายการ'}</h3>
    <label>ประเภท</label><select name="type" id="fType">${Object.entries(TX).map(([k, v]) => `<option value="${k}" ${k === t.type ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <div class="grid2"><div><label>วันที่</label><input type="date" name="date" value="${t.date}" required></div>
      <div><label>บัญชี</label><select name="accountId">${opts(S.accounts, t.accountId)}</select></div></div>
    <label>สินทรัพย์</label><select name="assetId" id="fAsset">${opts(S.assets, t.assetId, a => `${a.symbol} · ${TYPES[a.type]}`)}</select>
    <div id="qtyFields" class="grid2"><div><label>จำนวนหน่วย</label><input name="qty" type="number" step="any" inputmode="decimal" value="${t.qty ?? ''}"></div>
      <div><label>ราคาต่อหน่วย</label><input name="price" type="number" step="any" inputmode="decimal" value="${t.price ?? ''}"></div></div>
    <div id="amtFields"><label>จำนวนเงิน</label><input name="amount" type="number" step="any" inputmode="decimal" value="${t.amount ?? ''}"></div>
    <div class="grid2"><div><label>สกุลเงินที่จ่าย</label><select name="currency" id="fCur"><option ${t.currency === 'THB' ? 'selected' : ''}>THB</option><option ${t.currency === 'USD' ? 'selected' : ''}>USD</option></select></div>
      <div><label>อัตรา 1 หน่วย = ? บาท</label><input name="fx" id="fFx" type="number" step="any" value="${t.fx}"></div></div>
    <div class="grid2"><div><label>ค่าธรรมเนียม</label><input name="fee" type="number" step="any" value="${t.fee ?? ''}"></div>
      <div><label>ภาษีหัก ณ ที่จ่าย</label><input name="tax" type="number" step="any" value="${t.tax ?? ''}"></div></div>
    <p class="muted" id="buyHint">ถ้ารู้แค่ยอดเงินที่ DCA ใส่จำนวนเงินในช่องราคา × จำนวนหน่วยตามที่แอปโบรกเกอร์แสดง</p>
    <details ${t.reason ? 'open' : ''}><summary>บันทึกเหตุผล (ไม่บังคับ)</summary>
      <label>ทำไมถึงซื้อ/ขาย</label><textarea name="reason" rows="3">${esc(t.reason || '')}</textarea>
      <label>จะเปลี่ยนใจเมื่อ</label><input name="exitPlan" value="${esc(t.exitPlan || '')}">
      <div class="grid2"><div><label>ความมั่นใจ (1–5)</label><input name="confidence" type="number" min="1" max="5" value="${t.confidence ?? ''}"></div>
        <div><label>วันทบทวน</label><input type="date" name="reviewDate" value="${t.reviewDate || ''}"></div></div></details>
    <input type="hidden" name="dcaId" value="${t.dcaId || ''}">
    <div class="actions">${isNew ? '' : '<button value="delete" class="danger" formnovalidate>ลบ</button>'}
      <button value="cancel" class="ghost" formnovalidate>ยกเลิก</button><button value="save">บันทึก</button></div>`;
  openModal(html, async (fd, action) => {
    if (action === 'delete') {
      if (!confirm('ลบรายการนี้?')) return false;
      S.txns = S.txns.filter(x => x.id !== t.id);
    } else {
      const num = k => fd.get(k) === '' || fd.get(k) == null ? undefined : Number(fd.get(k));
      const rec = { id: t.id || uid(), type: fd.get('type'), date: fd.get('date'), accountId: fd.get('accountId'), assetId: fd.get('assetId'),
        qty: num('qty'), price: num('price'), amount: num('amount'), currency: fd.get('currency'), fx: num('fx') || 1,
        fee: num('fee'), tax: num('tax'), reason: fd.get('reason').trim(), exitPlan: fd.get('exitPlan').trim(),
        confidence: num('confidence'), reviewDate: fd.get('reviewDate') || '', dcaId: fd.get('dcaId') || undefined,
        reviewed: t.reviewed, reviewNote: t.reviewNote };
      if ((rec.type === 'buy' || rec.type === 'sell') && !(rec.qty > 0 && rec.price >= 0)) { toast('ใส่จำนวนหน่วยและราคา'); return false; }
      if (!['buy', 'sell'].includes(rec.type) && !(rec.amount > 0)) { toast('ใส่จำนวนเงิน'); return false; }
      S.txns = S.txns.filter(x => x.id !== rec.id).concat(rec);
    }
    S.dirty = true; await saveState(); render();
  });
  const sync = () => {
    const ty = $('#fType').value, trade = ty === 'buy' || ty === 'sell';
    $('#qtyFields').hidden = !trade; $('#amtFields').hidden = trade; $('#buyHint').hidden = ty !== 'buy';
  };
  $('#fType').onchange = sync; sync();
  $('#fCur').onchange = () => { $('#fFx').value = $('#fCur').value === 'USD' ? S.fx.USD : 1; };
  $('#fAsset').onchange = () => {
    const a = asset($('#fAsset').value);
    if (a && isNew) { $('#fCur').value = a.currency; $('#fFx').value = fxNow(a.currency); }
  };
  if (isNew && !preset.currency) $('#fAsset').onchange();
}

function assetForm(a = {}) {
  const isNew = !a.id;
  a = { type: 'stock', currency: 'USD', priceSource: 'finnhub', ...a };
  const p = S.prices[a.id]?.price;
  openModal(`<h3>${isNew ? 'เพิ่มสินทรัพย์' : esc(a.symbol)}</h3>
    <div class="grid2"><div><label>สัญลักษณ์</label><input name="symbol" value="${esc(a.symbol || '')}" required></div>
      <div><label>ชื่อ</label><input name="name" value="${esc(a.name || '')}"></div></div>
    <div class="grid2"><div><label>ประเภท</label><select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === a.type ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><label>สกุลเงินของราคา</label><select name="currency"><option ${a.currency === 'THB' ? 'selected' : ''}>THB</option><option ${a.currency === 'USD' ? 'selected' : ''}>USD</option></select></div></div>
    <label>แหล่งราคา</label><select name="priceSource">
      <option value="manual" ${a.priceSource === 'manual' ? 'selected' : ''}>ใส่เอง</option>
      <option value="finnhub" ${a.priceSource === 'finnhub' ? 'selected' : ''}>Finnhub (หุ้นสหรัฐ)</option>
      <option value="coingecko" ${a.priceSource === 'coingecko' ? 'selected' : ''}>CoinGecko (คริปโต)</option>
      <option value="fixed" ${a.priceSource === 'fixed' ? 'selected' : ''}>คงที่ 1 (เงินฝาก)</option></select>
    <label>CoinGecko id (ถ้าเป็นคริปโต)</label><input name="coingeckoId" value="${esc(a.coingeckoId || '')}">
    <div class="grid2"><div><label>ประเทศ</label><input name="country" value="${esc(a.country || '')}"></div>
      <div><label>อุตสาหกรรม</label><input name="sector" value="${esc(a.sector || '')}"></div></div>
    <label>ราคาล่าสุด (ใส่เองได้)</label><input name="manualPrice" type="number" step="any" value="${p ?? ''}">
    <div class="actions">${isNew ? '' : '<button value="delete" class="danger" formnovalidate>ลบ</button>'}
      <button value="cancel" class="ghost" formnovalidate>ยกเลิก</button><button value="save">บันทึก</button></div>`,
  async (fd, action) => {
    if (action === 'delete') {
      if (S.txns.some(t => t.assetId === a.id)) { toast('ลบไม่ได้ มีรายการที่ใช้สินทรัพย์นี้'); return false; }
      S.assets = S.assets.filter(x => x.id !== a.id);
    } else {
      const rec = { ...a, id: a.id || uid() };
      for (const k of ['symbol', 'name', 'type', 'currency', 'priceSource', 'coingeckoId', 'country', 'sector']) rec[k] = String(fd.get(k) || '').trim();
      rec.symbol = rec.symbol.toUpperCase();
      if (!rec.coingeckoId && rec.type === 'crypto') rec.coingeckoId = COINGECKO[rec.symbol] || '';
      S.assets = S.assets.filter(x => x.id !== rec.id).concat(rec);
      const mp = fd.get('manualPrice');
      if (mp !== '' && Number(mp) !== p) S.prices[rec.id] = { price: Number(mp), at: new Date().toISOString(), manual: true };
    }
    await saveState(); render();
  });
}

function dcaForm() {
  openModal(`<h3>แผน DCA</h3>
    <label>สินทรัพย์</label><select name="assetId">${opts(S.assets, null, a => a.symbol)}</select>
    <label>บัญชี</label><select name="accountId">${opts(S.accounts)}</select>
    <div class="grid2"><div><label>จำนวนเงิน</label><input name="amount" type="number" step="any" required></div>
      <div><label>สกุลเงิน</label><select name="currency"><option>THB</option><option>USD</option></select></div></div>
    <label>ทุกวันที่ของเดือน</label><input name="day" type="number" min="1" max="28" value="1" required>
    <div class="actions"><button value="cancel" class="ghost" formnovalidate>ยกเลิก</button><button value="save">บันทึก</button></div>`,
  async fd => {
    S.dca.push({ id: uid(), assetId: fd.get('assetId'), accountId: fd.get('accountId'), amount: Number(fd.get('amount')),
      currency: fd.get('currency'), day: Number(fd.get('day')) });
    await saveState(); render();
  });
}

function reviewForm(t) {
  const a = asset(t.assetId);
  openModal(`<h3>ทบทวน ${esc(a?.symbol)} (${t.date})</h3>
    <p><b>ตอนนั้นคิดว่า:</b> ${esc(t.reason || '–')}</p>
    <label>ตอนนี้ผลเป็นอย่างไร ตัดสินใจถูกไหม เรียนรู้อะไร</label><textarea name="note" rows="4">${esc(t.reviewNote || '')}</textarea>
    <div class="actions"><button value="cancel" class="ghost" formnovalidate>ยกเลิก</button><button value="save">บันทึก</button></div>`,
  async fd => { t.reviewNote = fd.get('note').trim(); t.reviewed = true; S.dirty = true; await saveState(); render(); });
}

function passForm(title, cb) {
  openModal(`<h3>${title}</h3><label>รหัสผ่านไฟล์สำรอง</label><input name="pass" type="password" required minlength="6" autocomplete="new-password">
    <p class="muted">จำรหัสนี้ไว้ ถ้าลืมจะเปิดไฟล์สำรองไม่ได้</p>
    <div class="actions"><button value="cancel" class="ghost" formnovalidate>ยกเลิก</button><button value="ok">ตกลง</button></div>`,
  async fd => { try { await cb(fd.get('pass')); } catch (e) { toast('ไม่สำเร็จ: ' + (e.name === 'OperationError' ? 'รหัสผ่านไม่ถูกต้อง' : e.message)); return false; } });
}

// ---------- events ----------
function bindView() {
  const v = $('#view');
  v.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { tab = b.dataset.go; render(); });
  v.querySelectorAll('[data-txn]').forEach(r => r.onclick = () => txnForm(S.txns.find(t => t.id === r.dataset.txn)));
  v.querySelectorAll('[data-asset]').forEach(r => r.onclick = () => assetForm(asset(r.dataset.asset)));
  v.querySelectorAll('[data-editasset]').forEach(r => r.onclick = () => assetForm(asset(r.dataset.editasset)));
  v.querySelectorAll('[data-review]').forEach(b => b.onclick = () => reviewForm(S.txns.find(t => t.id === b.dataset.review)));
  v.querySelectorAll('[data-dca]').forEach(b => b.onclick = () => {
    const p = S.dca.find(x => x.id === b.dataset.dca);
    const a = asset(p.assetId), price = priceOf(a);
    const fx = p.currency === 'USD' ? S.fx.USD : 1;
    const priceInPay = price == null ? undefined : price * fxNow(a.currency) / fx;
    txnForm({}, { type: 'buy', assetId: p.assetId, accountId: p.accountId, currency: p.currency, fx, dcaId: p.id,
      price: priceInPay ? +priceInPay.toFixed(6) : undefined, qty: priceInPay ? +(p.amount / priceInPay).toFixed(8) : undefined });
  });
  v.querySelectorAll('[data-deldca]').forEach(b => b.onclick = async () => { S.dca = S.dca.filter(x => x.id !== b.dataset.deldca); await saveState(); render(); });

  const amt = $('#dcaAmt');
  if (amt) {
    const show = () => {
      const n = Number(amt.value) || 0, s = dcaSuggestion(n, allocation(computeHoldings()));
      $('#dcaOut').innerHTML = Object.keys(s).filter(k => s[k] >= 1).map(k => `<div class="row"><span>${TYPES[k]}</span><b>${baht(s[k])}</b></div>`).join('')
        + '<div class="muted">แบ่งให้กลุ่มที่ต่ำกว่าเป้าก่อน โดยไม่ต้องขายของเดิม</div>';
    };
    amt.oninput = () => { S.settings.lastDcaAmount = Number(amt.value) || 0; saveState(); show(); };
    show();
  }

  if ($('#saveSettings')) {
    $('#saveSettings').onclick = async () => {
      const st = S.settings;
      v.querySelectorAll('[data-target]').forEach(i => st.targets[i.dataset.target] = Number(i.value) || 0);
      const sum = Object.values(st.targets).reduce((a, b) => a + b, 0);
      if (Math.round(sum) !== 100) return toast(`เป้าหมายรวมได้ ${sum}% ต้องเท่ากับ 100%`);
      st.band = Number($('#band').value) || 5; st.concentrationLimit = Number($('#conc').value) || 25;
      st.retire = st.retire || {};
      v.querySelectorAll('[data-ret]').forEach(i => st.retire[i.dataset.ret] = Number(i.value) || 0);
      st.finnhubKey = $('#finnhub').value.trim(); st.displayName = $('#dispName').value.trim() || st.displayName;
      await saveState(); render(); toast('บันทึกแล้ว');
    };
    $('#addDca').onclick = dcaForm;
    $('#addAsset').onclick = () => assetForm();
    $('#addAccount').onclick = async () => {
      const n = prompt('ชื่อบัญชี'); if (!n) return;
      S.accounts.push({ id: uid(), name: n.trim() }); await saveState(); render();
    };
    $('#backupBtn').onclick = () => passForm('สำรองข้อมูลแบบเข้ารหัส', async p => { await exportBackup(p); render(); toast('สำรองแล้ว'); });
    $('#restoreBtn').onclick = () => $('#restoreFile').click();
    $('#pasteBtn').onclick = () => {
      const text = $('#pasteBox').value.trim();
      if (!text) return toast('ยังไม่ได้วางข้อความ');
      try {
        if (text.startsWith('{')) return importStarter(JSON.parse(text));
        importStarter(parsePasted(text));
      } catch (e) { toast('อ่านข้อความไม่ได้: ' + e.message); }
    };
    $('#restoreFile').onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      e.target.value = '';
      let j = null;
      try { j = JSON.parse(await file.text()); } catch { return toast('อ่านไฟล์ไม่ได้'); }
      if (j?.starter) return importStarter(j);
      passForm('กู้คืนข้อมูล (ข้อมูลในเครื่องนี้จะถูกแทนที่)', async p => {
        const data = await importBackup(file, p);
        if (!data?.settings || !Array.isArray(data.txns)) throw new Error('ไฟล์ไม่ถูกต้อง');
        S = data; await saveState(); render(); toast(`กู้คืนแล้ว ${S.txns.length} รายการ`);
      });
    };
  }
}

document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); scrollTo(0, 0); });
$('#fab').onclick = () => txnForm();
$('#refreshBtn').onclick = () => refreshPrices(false);

(async () => {
  S = await loadState() || defaultState();
  await saveState();
  render();
  // Daily prices: refresh when the app opens if the last refresh is older than 6 hours.
  if (!S.lastRefresh || Date.now() - new Date(S.lastRefresh) > 6 * 3600e3) refreshPrices(true);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
  if (navigator.storage?.persist) navigator.storage.persist();
})();
