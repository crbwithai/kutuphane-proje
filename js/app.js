/*
  Bibliotheca — dışa bükük kitaplık, dock büyüteci, okuma penceresi, arama, Okuma Köşem

  Kitaplık bir silindirin dış yüzüdür. Her kitap, raf dilimi ve dikme silindir üzerindeki
  kendi açısına bir kez yerleştirilir (rotateY + translateZ); kaydırırken yalnızca silindir döner.
  Kitap verisi js/books.js'ten gelir (tools/build_books.py üretir).
*/
(() => {
  // Statik API: data/index.js rafı çizmek için gereken dizini verir; özet, kapak ve bağlantılar
  // kitap açılınca data/d/NN.js parçalarından yüklenir (tools/kutuphane.py cikar üretir).
  const LIB = window.LIBRARY || { sections: [], books: [], shard: 50, version: '0' };
  const SECTIONS = LIB.sections;
  const BOOKS = LIB.books.map(([id, s, t, a, y, p]) => ({ id, s, t, a, y, p }));
  const $ = id => document.getElementById(id);

  const stage = document.querySelector('.stage');
  const drum = $('drum');
  const header = document.querySelector('header');
  const hint = $('hint');
  const tip = $('tip');
  const reader = $('reader');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');

  const MAG = 3.2;      // dock: imleçteki kitabın büyüme katı
  const SIGMA = 1.25;   // dock: etkinin komşulara yayılması (kitap sayısı)

  const LEATHER = [
    ['#5a1d14', '#d9b46a'], ['#3b2415', '#cfae6b'], ['#6b4428', '#ead6a4'], ['#1d1814', '#c9a35a'], ['#22311f', '#d4b874'],
    ['#1f2a3d', '#d6bd80'], ['#4a1622', '#dcbc7c'], ['#6e2a1c', '#ecd3a0'], ['#3d3a1f', '#dcc58a'], ['#2e1c12', '#b99a5c'],
  ];
  const VELLUM = [['#dccaa0', '#3a2614'], ['#cdb989', '#4a2a18'], ['#e2d4b2', '#5a1c12']];
  const LABELS = ['#7a1f14', '#141110', '#1f2a3d'];
  const VARIANTS = ['b-bands', 'b-tooled', 'b-label', 'b-boss', 'b-bands'];

  // Kitap başına sabit "rastgele" sayılar: her yüklemede aynı görünüm
  const rnd = (i, s) => { const x = Math.sin((i + 1) * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x); };
  const pick = (arr, r) => arr[Math.floor(r * arr.length)];
  const norm = s => s.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmtYear = y => y == null ? '—' : y < 0 ? `MÖ ${-y}` : y < 1000 ? `MS ${y}` : String(y);

  if (!BOOKS.length) {
    hint.textContent = 'Kitap dizini yüklenemedi (data/index.js).';
    return;
  }

  /* ---------- Kitaplar: DOM bir kez kurulur ---------- */
  const books = BOOKS.map((d, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'bk';
    el.dataset.i = i;
    el.setAttribute('aria-label', `${d.t} — ${d.a}`);
    const span = document.createElement('span');
    span.textContent = d.t;
    el.append(span);

    const vellum = rnd(i, 3) < 0.16;
    const pal = vellum ? pick(VELLUM, rnd(i, 6)) : pick(LEATHER, rnd(i, 6));
    const variant = vellum ? 'b-vellum' : pick(VARIANTS, rnd(i, 4));
    el.classList.add(variant);
    if (!vellum && rnd(i, 5) < 0.05) el.classList.add('b-chain');
    el.style.setProperty('--c', pal[0]);
    el.style.setProperty('--g', pal[1]);
    if (variant === 'b-label') el.style.setProperty('--lab', pick(LABELS, rnd(i, 7)));

    // Ölçüler raf yüksekliğine oranlı; kalınlık Open Library'deki sayfa sayısından
    const pages = d.p || 250 + rnd(i, 1) * 300;
    return {
      d, el, i,
      tk: clamp(0.065 + pages / 9000, 0.065, 0.19) + rnd(i, 1) * 0.025,
      hk: clamp(0.6 + rnd(i, 2) * 0.27 + (pages > 700 ? 0.06 : 0), 0.58, 0.94),
      m: 1, x0: 0, x: 0, w0: 0, w: 0, h0: 0, th: 0, row: null, slice: null,
    };
  });

  const sections = SECTIONS.map((s, k) => ({ ...s, k, items: books.filter(b => b.d.s === k) }));

  /* ---------- Yerleşim ----------
     Duvar tek bir eğriliğe göre bükülür: k = 1/yarıçap. k > 0 dışbükey (silindirin dışından bakış),
     k < 0 içbükey (izleyiciyi saran iç yüzey), k = 0 düz. Görünüm değişirken k yumuşakça düzlükten
     geçip ters döner. Raf dilimleri, dikmeler ve etiketler duvar üzerindeki yay konumlarına (u) göre
     her karede konumlanır (≈70 parça); kitaplar dilimlerin içinde düz durur. */
  const MODES = {
    dis: { label: 'Dışbükey', cam: 1.6, hide: 1.75, radius: () => Math.max(innerWidth * 0.85, G.W / (2 * Math.PI * 0.85)) },
    ic:  { label: 'İçbükey',  cam: 1.1, hide: 1.4,  radius: () => Math.max(innerWidth * 0.62, G.W / (2 * Math.PI * 0.85)) },
    // Düz (hafif): bükülme, mum titremesi ve cam bulanıklığı yok — zayıf cihazlar için
    duz: { label: 'Düz',      cam: 1,   hide: Infinity, radius: () => Infinity },
  };
  const MODE_KEY = 'bibliotheca:gorunum';
  const G = { k: 0, P: 1000, hide: 1.75, minV: 0, maxV: 0, W: 0 };
  const ORDER = ['dis', 'ic', 'duz'];
  let mode = 'dis';
  let chosen = false;   // kullanıcı görünümü kendisi seçti mi (otomatik hafif mod buna dokunmaz)
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (ORDER.includes(saved)) { mode = saved; chosen = true; }
  } catch (_) { /* varsayılan */ }
  // Belleği az cihazda baştan hafif mod
  if (!chosen && navigator.deviceMemory && navigator.deviceMemory <= 4) mode = 'duz';
  let morph = null;     // görünüm geçişi: { from, to, t0 }
  let structure = [];   // { el, u, lift, tail, hidden }
  let slices = [];
  let view = 0;         // ekranın ortasına gelen duvar noktası (px, duvar merkezine göre)
  let target = 0;       // süzülerek varılacak nokta

  // Duvar boyunca s px uzaktaki noktanın konumu (x, z) ve yüzey açısı
  function curve(k, s) {
    if (Math.abs(k) < 1e-7) return [s, 0, 0];
    const a = k * s;
    return [Math.sin(a) / k, (Math.cos(a) - 1) / k, a];
  }

  // Ekran merkezinden X px uzağa düşen yay uzunluğu (perspektifli izdüşümün tersi)
  function edgeArc(g, X) {
    let best = 0, bestX = 0;
    const max = Math.abs(g.k) < 1e-7 ? X : Math.min(G.W, g.hide / Math.abs(g.k));
    for (let s = 0; s <= max; s += 2) {
      const [x, z] = curve(g.k, s);
      if (z >= g.P * 0.9) break;
      const sx = x * g.P / (g.P - z);
      if (sx >= X) return s;
      if (sx > bestX) { bestX = sx; best = s; }
    }
    return best;
  }

  function geometry(m) {
    const R = MODES[m].radius();
    const flat = !isFinite(R);
    const g = { k: flat ? 0 : (m === 'dis' ? 1 : -1) / R, P: flat ? 2400 : MODES[m].cam * R, hide: MODES[m].hide };
    const e = edgeArc(g, innerWidth / 2 - 12);   // duvarın uçları ekranın kenarına oturur
    g.minV = -G.W / 2 + e;
    g.maxV = G.W / 2 - e;
    if (g.minV > g.maxV) g.minV = g.maxV = 0;
    return g;
  }

  function size(el, left, top, w, h) {
    const s = el.style;
    s.left = left + 'px';
    s.top = top - G.H / 2 + 'px';
    s.width = w + 'px';
    if (h != null) s.height = h + 'px';
  }

  // Kitaplar bulundukları raf diliminin içine düz yerleşir: dilim başına tek 3B katman.
  // Büyüyen kitap izleyiciye doğru öne çıkar; içbükeyde de komşu dilimin arkasında kalmaz.
  function placeBook(b) {
    const s = b.el.style;
    s.left = b.x - b.slice.x0 + 'px';
    s.top = G.ch + b.rowIndex * (G.rh + G.pt) + G.rh - b.h0 + 'px';
    s.width = b.w + 'px';
    s.height = b.h0 + 'px';
    s.setProperty('--bw', b.w.toFixed(2));
    b.u = b.x + b.w / 2 - G.W / 2;
  }

  function layout() {
    const progress = G.maxV > G.minV ? (target - G.minV) / (G.maxV - G.minV) : 0;
    const top = header.offsetHeight + 4;
    const avail = Math.max(320, innerHeight - top - hint.offsetHeight - 22);

    G.rows = avail < 560 ? 5 : 7;
    G.ch = clamp(avail * 0.055, 26, 46);
    G.bh = clamp(avail * 0.035, 14, 28);
    G.pt = clamp(avail * 0.011, 5, 9);
    G.rh = (avail - G.ch - G.bh - G.rows * G.pt) / G.rows;
    G.H = avail;
    G.gap = 1;
    G.pw = clamp(G.rh * 0.22, 12, 22);
    G.pad = G.rh * 0.12;

    const cy = top + avail / 2;
    drum.style.top = cy + 'px';
    stage.style.perspectiveOrigin = `50% ${cy}px`;
    for (const [k, v] of [['--ch', G.ch], ['--bh', G.bh], ['--pt', G.pt], ['--rh', G.rh]]) drum.style.setProperty(k, v + 'px');

    // Her bölüm kendi içinde G.rows kata dengeli dağılır; bölümler arasında meşe dikme
    let x = G.pw;
    const postsX = [0];
    sections.forEach(sec => {
      const total = sec.items.reduce((s, b) => s + b.tk * G.rh + G.gap, 0);
      const per = total / G.rows;
      sec.rows = Array.from({ length: G.rows }, () => []);
      let r = 0, cx = 0;
      for (const b of sec.items) {
        const w = b.tk * G.rh;
        if (cx > 0 && cx + w / 2 > per && r < G.rows - 1) { r++; cx = 0; }
        b.w0 = b.w = w;
        b.h0 = b.hk * G.rh;
        b.rowIndex = r;
        b.rx = cx;
        cx += w + G.gap;
        sec.rows[r].push(b);
      }
      const inner = Math.max(0, ...sec.rows.map(row => row.reduce((s, b) => s + b.w0 + G.gap, 0)));
      sec.x0 = x + G.pad;
      sec.x1 = sec.x0 + inner;
      sec.rows.forEach(row => { row.sec = sec; row.forEach((b, j) => { b.row = row; b.ri = j; b.x0 = b.x = sec.x0 + b.rx; }); });
      x = sec.x1 + G.pad;
      postsX.push(x);
      x += G.pw;
    });
    G.W = x;

    // Raf dilimleri (kitaplar içlerinde), dikmeler, bölüm etiketleri
    structure.forEach(p => p.el.remove());
    structure = [];
    slices = [];
    const sf = document.createDocumentFragment();
    const SLICE = clamp(Math.min(MODES.dis.radius(), MODES.ic.radius()) * 0.05, 24, 72);   // ≈3°: kavis pürüzsüz
    const part = (el, u, lift, tail = '') => { const p = { el, u, lift, tail, hidden: false }; structure.push(p); sf.append(el); return p; };
    for (let k = 0; k * SLICE < G.W; k++) {
      const el = document.createElement('div');
      el.className = 'slice';
      el.innerHTML = '<div class="cornice"></div><div class="cab"></div><div class="plinth"></div>';
      el.style.setProperty('--ox', -k * SLICE + 'px');
      const w = Math.min(SLICE, G.W - k * SLICE) + 1;
      size(el, -w / 2, 0, w, G.H);
      slices.push({ el, x0: k * SLICE, ...part(el, k * SLICE + w / 2 - G.W / 2, 0) });
    }
    books.forEach(b => {
      b.slice = slices[clamp(Math.floor((b.x0 + b.w0 / 2) / SLICE), 0, slices.length - 1)];
      b.slice.el.append(b.el);
    });
    postsX.forEach(px => {
      const el = document.createElement('div');
      el.className = 'post';
      size(el, -G.pw / 2, -4, G.pw, G.H + 8);
      part(el, px + G.pw / 2 - G.W / 2, 3);
    });
    sections.forEach(sec => {
      const el = document.createElement('div');
      el.className = 'plate';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = sec.n;
      el.append(num, document.createTextNode(sec.t));
      const ph = G.ch * 0.72;
      el.style.setProperty('--pf', ph * 0.62 + 'px');
      el.style.left = '0px';
      el.style.top = (G.ch - ph) / 2 - G.H / 2 + 'px';
      el.style.height = ph + 'px';
      el.style.transformOrigin = '0 50%';
      part(el, (sec.x0 + sec.x1) / 2 - G.W / 2, 4, ' translateX(-50%)');
    });
    drum.prepend(sf);
    drum.append(lens.el);
    lens.el.style.top = -G.H / 2 + 'px';   // raf dilimleriyle aynı dikey referans

    books.forEach(placeBook);
    dock = null;
    lensReset(null);
    morph = null;
    Object.assign(G, geometry(mode));
    view = target = G.minV + progress * (G.maxV - G.minV);
    render();
  }

  function render() {
    stage.style.perspective = G.P + 'px';
    for (const p of structure) {
      const s = p.u - view;
      const off = Math.abs(G.k * s) > G.hide;
      if (off !== p.hidden) {
        p.hidden = off;
        p.el.style.opacity = off ? '0' : '';   // opacity: katman ve çizimi korunur, geri gelince yeniden çizilmez
      }
      if (off) continue;
      const [x, z, a] = curve(G.k, s);
      p.el.style.transform = `translate3d(${x.toFixed(2)}px,0,${z.toFixed(2)}px) rotateY(${a.toFixed(5)}rad) translateZ(${p.lift}px)${p.tail}`;
    }
    placeLens();
  }

  /* ---------- Görünüm: dışbükey ↔ içbükey ---------- */
  const modeBtn = $('mode');
  const ARCS = { dis: 'M3 13 Q13 3 23 13', ic: 'M3 5 Q13 15 23 5', duz: 'M3 9 L23 9' };
  function syncModeButton() {
    const other = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    modeBtn.dataset.mode = mode;
    modeBtn.querySelector('.arc').setAttribute('d', ARCS[mode]);
    modeBtn.querySelector('.label').textContent = MODES[mode].label;
    modeBtn.setAttribute('aria-label', `Görünüm: ${MODES[mode].label}. ${MODES[other].label} görünüme geç`);
    document.documentElement.classList.toggle('lite', mode === 'duz');
  }
  function setMode(m, save = true) {
    if (m === mode) return;
    mode = m;
    if (save) {
      chosen = true;
      try { localStorage.setItem(MODE_KEY, m); } catch (_) { /* yalnızca bu oturum */ }
    }
    syncModeButton();
    hideTip();
    const to = geometry(m);
    if (reduceMotion.matches) {
      Object.assign(G, to);
      view = target = clamp(view, G.minV, G.maxV);
      render();
      return;
    }
    morph = { from: { k: G.k, P: G.P, hide: G.hide, minV: G.minV, maxV: G.maxV }, to, t0: performance.now() };
    kick();
  }
  modeBtn.addEventListener('click', () => setMode(ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]));

  // Kare süresi gözcüsü: açılıştan 1 sn sonra 2 sn izler; cihaz zorlanıyorsa hafif moda geçer
  function watchFrames() {
    if (chosen || mode === 'duz') return;
    const gaps = [];
    let last = 0;
    const until = performance.now() + 3000;
    const step = t => {
      if (last && t > until - 2000) gaps.push(t - last);
      last = t;
      if (t < until) { requestAnimationFrame(step); return; }
      gaps.sort((a, b) => a - b);
      if (gaps.length > 10 && gaps[gaps.length >> 1] > 28 && !chosen) {
        setMode('duz', false);
        hint.textContent = 'Cihazın için hafif (düz) görünüme geçildi. Sağ üstteki düğmeyle değiştirebilirsin.';
      }
    };
    requestAnimationFrame(step);
  }

  function morphStep(now) {
    const t = clamp((now - morph.t0) / 900, 0, 1);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;   // yavaş başla, yavaş bitir
    const { from, to } = morph;
    G.k = from.k + (to.k - from.k) * e;
    G.P = from.P + (to.P - from.P) * e;
    G.hide = Math.max(from.hide, to.hide);
    G.minV = from.minV + (to.minV - from.minV) * e;
    G.maxV = from.maxV + (to.maxV - from.maxV) * e;
    view = clamp(view, G.minV, G.maxV);
    target = clamp(target, G.minV, G.maxV);
    if (t === 1) { Object.assign(G, to); morph = null; }
    render();
  }

  /* ---------- Dock: mercek katmanı ----------
     Raftaki kitaplara dokunulmaz, böylece raf dilimleri her karede yeniden çizilmez. İmlecin
     çevresindeki kitapların kopyaları ayrı, küçük bir katmanda büyür ve rafın önünde durur.
     Aslılar hiç gizlenmez (gizlemek raf dilimini yeniden çizdirir): merceğin arkasındaki raf
     zemini renginde bir şerit onları örter. Büyüme sönünce kopya aslının tam üstüne biner ve
     kaldırılır — geçiş görünmez. */
  const LENS_K = 6;   // imlecin iki yanında merceğe alınan kitap sayısı
  const lens = { el: document.createElement('div'), row: null, hi: 0, u: 0, half: 0, items: new Map(), shown: false };
  lens.el.className = 'lens';
  lens.el.setAttribute('aria-hidden', 'true');
  const lensBg = document.createElement('div');   // aslıları örten raf zemini şeridi
  lensBg.className = 'lens-bg';
  lens.el.append(lensBg);
  let dock = null;    // { b, frac }

  function cloneOf(b) {
    if (!b.clone) {
      const c = b.el.cloneNode(true);
      c.removeAttribute('aria-label');
      c.removeAttribute('data-i');
      c.tabIndex = -1;
      c.classList.remove('hit', 'is-out');
      b.clone = c;
    }
    return b.clone;
  }

  function lensDrop(b) {
    const it = lens.items.get(b);
    if (!it) return;
    it.c.remove();
    lens.items.delete(b);
  }

  function lensReset(row) {
    for (const b of [...lens.items.keys()]) lensDrop(b);
    lens.row = row;
    if (!row && lens.shown) { lens.el.style.visibility = 'hidden'; lens.shown = false; }
  }

  function placeLens() {
    if (!lens.shown) return;
    const [x, z, a] = curve(G.k, lens.u - view);
    // İçbükeyde duvar izleyiciye doğru kıvrılır: düz mercek, kenarlarına kadar duvarın önünde kalsın diye
    // kavisin o genişlikteki derinliği (sehim ≈ yarıGenişlik² / 2R) kadar öne alınır.
    const lift = 8 + (G.k < 0 ? lens.half * lens.half * -G.k / 2 : 0);
    lens.el.style.transform = `translate3d(${x.toFixed(2)}px,0,${z.toFixed(2)}px) rotateY(${a.toFixed(5)}rad) translateZ(${lift.toFixed(1)}px)`;
  }

  // Merkezdeki kitap yerinde kalır; diğerleri büyüdükçe iki yana açılır
  function layoutLens() {
    const row = lens.row;
    const hi = lens.hi;
    const c = row[hi];
    const m = b => (lens.items.get(b) || { m: 1 }).m;
    let lo = hi, up = hi;
    for (const b of lens.items.keys()) { lo = Math.min(lo, b.ri); up = Math.max(up, b.ri); }
    const left = new Map();
    const cw = c.w0 * m(c);
    left.set(c, -cw / 2);
    let edge = -cw / 2 - G.gap;
    for (let j = hi - 1; j >= lo; j--) { const w = row[j].w0 * m(row[j]); edge -= w; left.set(row[j], edge); edge -= G.gap; }
    edge = cw / 2 + G.gap;
    for (let j = hi + 1; j <= up; j++) { left.set(row[j], edge); edge += row[j].w0 * m(row[j]) + G.gap; }
    const rowBottom = G.ch + c.rowIndex * (G.rh + G.pt) + G.rh;
    for (const [b, it] of lens.items) {
      const w = b.w0 * it.m;
      const h = b.h0 * it.m;
      const st = it.c.style;
      st.left = left.get(b) + 'px';
      st.width = w + 'px';
      st.height = h + 'px';
      st.top = Math.max(G.ch * 0.5, rowBottom - h) + 'px';   // korniş üstüne taşmaz, gerekirse aşağı uzar
      st.zIndex = Math.round(it.m * 10);
      st.setProperty('--bw', w.toFixed(2));
    }
    lens.u = c.x0 + c.w0 / 2 - G.W / 2;
    let minL = Infinity, maxR = -Infinity;
    for (const [b, it] of lens.items) { minL = Math.min(minL, left.get(b)); maxR = Math.max(maxR, left.get(b) + b.w0 * it.m); }
    lens.half = Math.max(-minL, maxR);
    const bg = lensBg.style;   // şerit yalnızca raf katının iç boşluğunu kaplar
    bg.left = minL - 1 + 'px';
    bg.width = maxR - minL + 2 + 'px';
    bg.top = rowBottom - G.rh + 'px';
    bg.height = G.rh + 'px';
    if (!lens.shown) { lens.el.style.visibility = ''; lens.shown = true; }
    placeLens();
  }

  function dockStep() {
    if (!dock && !lens.items.size) return false;
    if (dock && lens.row !== dock.b.row) lensReset(dock.b.row);
    const row = lens.row;
    if (dock) lens.hi = dock.b.ri;
    const lo = dock ? Math.max(0, lens.hi - LENS_K) : 0;
    const up = dock ? Math.min(row.length - 1, lens.hi + LENS_K) : -1;
    for (let j = lo; j <= up; j++) {
      const b = row[j];
      if (!lens.items.has(b)) {
        const c = cloneOf(b);
        lens.el.append(c);
        lens.items.set(b, { c, m: 1 });
      }
    }
    let moving = false;
    for (const [b, it] of lens.items) {
      const inWindow = dock && b.ri >= lo && b.ri <= up;
      const goal = inWindow ? 1 + (MAG - 1) * Math.exp(-((b.ri - lens.hi - dock.frac) ** 2) / (2 * SIGMA * SIGMA)) : 1;
      const next = reduceMotion.matches ? goal : it.m + (goal - it.m) * 0.24;
      it.m = Math.abs(next - goal) < 0.003 ? goal : next;
      if (it.m !== goal) moving = true;
    }
    layoutLens();
    for (const [b, it] of lens.items) {
      if (it.m === 1 && !(dock && b.ri >= lo && b.ri <= up)) lensDrop(b);   // sönen kitap rafa döner
    }
    if (!lens.items.size) lensReset(null);
    return moving;
  }

  function setDock(b, frac = 0) {
    dock = b ? { b, frac } : null;
    if (b) loadDetail(b.d.id).catch(() => {});   // üzerine gelinen kitabın ayrıntısını önceden çek
    kick();
  }

  // Büyümüşse kopyanın, değilse rafın üstündeki kitabın ekran dikdörtgeni
  const rectOf = b => (lens.items.has(b) ? lens.items.get(b).c : b.el).getBoundingClientRect();

  /* ---------- Künye etiketi: büyüyen kitabın tepesinin üstünde, onu örtmeden ---------- */
  let tipBook = null;
  function showTip(b) {
    const d = b.d;
    if (tipBook !== b) {
      tipBook = b;
      tip.querySelector('b').textContent = d.t;
      tip.querySelector('span').textContent = `${d.a} · ${fmtYear(d.y)}`;
      tip.querySelector('small').textContent = `${SECTIONS[d.s].n} · ${SECTIONS[d.s].t}`;
    }
    tip.classList.add('show');
    const t = tip.getBoundingClientRect();
    const r = rectOf(b);
    let y = r.top - t.height - 10;
    if (y < header.offsetHeight + 4) y = r.bottom + 10;
    const x = clamp(r.left + r.width / 2 - t.width / 2, 8, innerWidth - t.width - 8);
    tip.style.transform = `translate(${x}px, ${clamp(y, 8, innerHeight - t.height - 8)}px)`;
  }
  function hideTip() { tip.classList.remove('show'); tipBook = null; }

  /* ---------- Döngü ---------- */
  let raf = 0;
  let ptr = null;          // son fare konumu
  let pendingTip = null;   // dönüş bitince künyesi gösterilecek kitap

  function kick() { if (!raf) raf = requestAnimationFrame(tick); }

  function tick(now) {
    raf = 0;
    const morphing = !!morph;
    if (morph) morphStep(now);
    const d = target - view;
    const rotating = d !== 0;
    if (rotating) {
      view = reduceMotion.matches || Math.abs(d) < 0.05 ? target : view + d * 0.14;
      if (!morphing) render();
    }
    const docking = dockStep();
    if ((rotating || morphing) && ptr) hoverAt(ptr.x, ptr.y);
    if (pendingTip && view === target && !morph) { showTip(pendingTip); pendingTip = null; }
    else if (tipBook && dock && dock.b === tipBook && docking) showTip(tipBook);
    if (view !== target || morph || docking) kick();
  }

  function go(u) {
    target = clamp(u, G.minV, G.maxV);
    kick();
  }

  // Mercekteki (büyümüş) kitapların kapladığı alan onlara aittir; en çok büyümüş olan önceliklidir
  const inside = (x, y, r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  function bookAt(x, y) {
    let best = null, bestM = 0;
    for (const [b, it] of lens.items) {
      if (it.m > bestM && inside(x, y, it.c.getBoundingClientRect())) { best = b; bestM = it.m; }
    }
    if (best) return best;
    const hit = document.elementFromPoint(x, y);
    const el = hit && hit.closest('.drum .bk');
    return el ? books[el.dataset.i] : null;
  }

  function hoverAt(x, y) {
    const b = bookAt(x, y);
    if (!b) {
      if (dock) setDock(null);
      hideTip();
      return;
    }
    const r = rectOf(b);
    const frac = clamp((x - r.left) / r.width - 0.5, -0.5, 0.5);
    if (!dock || dock.b !== b || Math.abs(dock.frac - frac) > 0.02) setDock(b, frac);
    showTip(b);
  }

  const popoverOpen = () => document.querySelector(':popover-open') !== null;

  /* ---------- Fare ---------- */
  let hoverRaf = 0;
  addEventListener('pointermove', e => {
    if (drag) return;
    if (e.pointerType !== 'mouse' || !finePointer.matches || popoverOpen()) return;
    ptr = { x: e.clientX, y: e.clientY };
    if (!hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; if (ptr) hoverAt(ptr.x, ptr.y); });
  });
  document.addEventListener('mouseleave', () => { ptr = null; setDock(null); hideTip(); });

  document.addEventListener('wheel', e => {
    if (e.ctrlKey || popoverOpen() || (e.target.closest && e.target.closest('[popover], .results'))) return;
    e.preventDefault();
    const px = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerWidth : 1;
    go(target + px * unit * 1.2);
  }, { passive: false });

  /* ---------- Parmakla sürükleme ---------- */
  let drag = null;
  let dragged = false;
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    drag = { x: e.clientX, start: target };
    dragged = false;
  });
  addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 8) { dragged = true; hideTip(); }
    if (dragged) go(drag.start - dx * 1.3);
  });
  addEventListener('pointerup', () => { drag = null; });
  addEventListener('pointercancel', () => { drag = null; });

  /* ---------- Tıklama / dokunma ---------- */
  stage.addEventListener('click', e => {
    if (dragged) { dragged = false; return; }
    const b = e.detail === 0 ? (e.target.closest('.bk') && books[e.target.closest('.bk').dataset.i]) : bookAt(e.clientX, e.clientY);
    if (!b) { if (!finePointer.matches) { setDock(null); hideTip(); } return; }
    // Dokunmatik: ilk dokunuş büyütür ve künyeyi gösterir, büyümüş kitaba ikinci dokunuş açar
    if (!finePointer.matches && e.detail !== 0 && !(dock && dock.b === b)) {
      setDock(b);
      pendingTip = b;
      return;
    }
    openReader(b);
  });

  /* ---------- Klavye ---------- */
  addEventListener('keydown', e => {
    if (popoverOpen() || (e.target.closest && e.target.closest('input, textarea'))) return;
    if (e.key === 'ArrowRight') { go(target + 260); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { go(target - 260); e.preventDefault(); }
  });
  drum.addEventListener('focusin', e => {
    const el = e.target.closest('.bk');
    if (!el || !el.matches(':focus-visible')) return;
    const b = books[el.dataset.i];
    ptr = null;
    setDock(b);
    go(b.u);
    pendingTip = b;
  });
  drum.addEventListener('focusout', () => { if (!ptr) hideTip(); });

  /* ---------- Okuma penceresi ---------- */
  let current = null;

  function link(href, text) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    return a;
  }

  /* ---------- Kitap ayrıntıları: parça parça, ihtiyaç anında ---------- */
  const shards = new Map();    // parça no → Promise<{ id: ayrıntı }>
  const waiting = new Map();   // parça no → resolve
  window.__libraryShard = (n, items) => {
    const resolve = waiting.get(n);
    if (resolve) { waiting.delete(n); resolve(items); }
  };

  function loadDetail(id) {
    const n = Math.floor(id / LIB.shard);
    if (!shards.has(n)) {
      shards.set(n, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        const fail = () => {
          clearTimeout(timer);
          waiting.delete(n);
          shards.delete(n);   // bir sonraki denemede yeniden istenir
          s.remove();
          reject(new Error('Ayrıntı dosyası yüklenemedi'));
        };
        const timer = setTimeout(fail, 12000);
        waiting.set(n, items => { clearTimeout(timer); s.remove(); resolve(items); });
        s.onerror = fail;
        s.src = `data/d/${String(n).padStart(2, '0')}.js?v=${LIB.version}`;
        document.head.append(s);
      }));
    }
    return shards.get(n).then(items => items[id]);
  }

  function setSummaryNote(text, retry) {
    const sum = $('r-summary');
    const p = document.createElement('p');
    p.className = 'none';
    p.lang = 'tr';
    p.textContent = text;
    if (retry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'linkish';
      btn.textContent = 'Yeniden dene';
      btn.addEventListener('click', retry);
      p.append(' ', btn);
    }
    sum.replaceChildren(p);
  }

  function fill(b) {
    const d = b.d;
    $('r-title').textContent = d.t;
    $('r-author').textContent = d.a;
    $('r-flap').textContent = d.t;
    $('r-draw-t').textContent = d.t;
    $('r-draw-a').textContent = d.a;

    // Kapak yüklenene dek çizili deri kapak görünür
    const img = $('r-img');
    img.hidden = true;
    $('r-draw').hidden = false;
    img.onload = null;
    img.removeAttribute('src');
    $('r-cap').textContent = '';
    renderMeta(d, null);
    $('r-source').replaceChildren();
    $('r-ol').href = `https://openlibrary.org/search?q=${encodeURIComponent(d.t)}`;
    setSummaryNote('Yapraklar çevriliyor…');
    syncFavButton();

    loadDetail(d.id).then(x => {
      if (current !== b) return;   // bu arada başka kitap açıldıysa eski yanıtı yok say
      if (!x) { setSummaryNote('Bu eserin ayrıntıları arşivde bulunamadı.'); return; }
      fillDetail(b, x);
    }, () => {
      if (current === b) setSummaryNote('Ayrıntılar yüklenemedi. Bağlantını kontrol et.', () => fill(b));
    });
  }

  function renderMeta(d, x) {
    const meta = $('r-meta');
    meta.replaceChildren();
    const sec = SECTIONS[d.s];
    [
      ['Yazar', d.a],
      ['Tarih', d.y == null ? null : (d.y < 1500 ? '≈ ' : '') + fmtYear(d.y)],
      ['Özgün dil', x && x.l],
      ['Sayfa', d.p ? `≈ ${d.p} (Open Library)` : null],
      ['Bölüm', `${sec.n} · ${sec.t}`],
    ].forEach(([k, v]) => {
      if (!v) return;
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      meta.append(dt, dd);
    });
  }

  function fillDetail(b, x) {
    const d = b.d;
    renderMeta(d, x);

    // Kapak: kendi sunduğumuz küçültülmüş kopya (data/covers/); yoksa çizili kapak kalır
    if (x.c) {
      const img = $('r-img');
      img.alt = `${d.t} kapağı`;
      img.onload = () => {
        if (current !== b) return;
        img.hidden = false;
        $('r-draw').hidden = true;
        $('r-cap').textContent = 'Kapak: Open Library';
      };
      img.src = `data/covers/${x.c}?v=${LIB.version}`;
    }

    const sum = $('r-summary');
    sum.replaceChildren();
    sum.lang = (x.d.match(/[ğışĞİŞ]/g) || []).length >= 3 ? 'tr' : 'en';
    x.d.split(/\n+/).map(s => s.trim()).filter(Boolean).forEach(par => {
      const p = document.createElement('p');
      p.textContent = par;
      sum.append(p);
    });

    const src = $('r-source');
    src.replaceChildren('Kaynak: ', link(x.du, x.ds));
    if (/Vikipedi|Wikipedia/.test(x.ds)) {
      src.append(' · metin ', link('https://creativecommons.org/licenses/by-sa/4.0/deed.tr', 'CC BY-SA 4.0'), ' lisanslıdır.');
    }
    $('r-ol').href = `https://openlibrary.org/works/${x.k}`;
  }

  function openReader(b) {
    current = b;
    fill(b);
    hideTip();
    setDock(null);
    lensReset(null);
    b.el.classList.add('is-out');
    reader.showPopover();
  }

  reader.addEventListener('toggle', e => {
    if (e.newState !== 'closed' || !current) return;
    const el = current.el;
    el.classList.remove('is-out');
    current = null;
    el.focus({ preventScroll: true });
  });

  /* ---------- Okuma Köşem ---------- */
  const FKEY = 'bibliotheca:okuma-kosemi:v2';   // kitap kimlikleri (veritabanındaki kalıcı id)
  const byKey = new Map(books.map(b => [b.d.id, b]));
  const favList = $('fav-list');

  function loadFavs() {
    try {
      const raw = localStorage.getItem(FKEY);
      if (raw) return JSON.parse(raw).filter(k => byKey.has(k));
    } catch (_) { /* gizli pencere vb.: varsayılan raf */ }
    return ['Suç ve Ceza', 'Odysseia', 'Ulusların Zenginliği', 'Saatleri Ayarlama Enstitüsü', 'Gülün Adı']
      .map(t => books.find(b => b.d.t === t)).filter(Boolean).map(b => b.d.id);
  }
  let favs = loadFavs();

  function saveFavs() {
    try { localStorage.setItem(FKEY, JSON.stringify(favs)); } catch (_) { /* yazılamazsa oturum boyunca geçerli */ }
    renderFavs();
  }

  function renderFavs() {
    $('fav-count').textContent = favs.length;
    $('fav-count-nav').textContent = favs.length;
    $('fav-empty').hidden = favs.length > 0;
    favList.replaceChildren(...favs.map(k => {
      const b = byKey.get(k);
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      open.dataset.i = b.i;
      const t = document.createElement('b');
      t.textContent = b.d.t;
      const a = document.createElement('i');
      a.textContent = `${b.d.a} · ${fmtYear(b.d.y)}`;
      open.append(t, a);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rm';
      rm.dataset.k = k;
      rm.textContent = 'çıkar';
      rm.setAttribute('aria-label', `${b.d.t} kitabını Okuma Köşemden çıkar`);
      li.append(open, rm);
      return li;
    }));
  }

  function syncFavButton() {
    if (!current) return;
    const on = favs.includes(current.d.id);
    const btn = $('r-fav');
    btn.setAttribute('aria-pressed', on);
    btn.textContent = on ? '❦ Okuma Köşemde' : 'Okuma Köşeme ekle';
  }

  $('r-fav').addEventListener('click', () => {
    if (!current) return;
    const k = current.d.id;
    favs = favs.includes(k) ? favs.filter(x => x !== k) : favs.concat(k);
    saveFavs();
    syncFavButton();
  });
  favList.addEventListener('click', e => {
    const rm = e.target.closest('.rm');
    if (rm) { favs = favs.filter(k => k !== +rm.dataset.k); saveFavs(); return; }
    const open = e.target.closest('.open');
    if (open) { $('drawer').hidePopover(); openReader(books[open.dataset.i]); }
  });
  $('fav-clear').addEventListener('click', () => { favs = []; saveFavs(); });

  /* ---------- Arama: yazım hatalarına toleranslı, canlı sonuç listesi ---------- */
  const input = $('q');
  const list = $('results');
  const veil = $('veil');
  const index = books.map(b => {
    const t = norm(b.d.t), a = norm(b.d.a);
    return { b, t, a, toks: `${t} ${a}`.split(/[^a-z0-9]+/).filter(Boolean) };
  });
  let results = [];
  let active = -1;
  let hits = [];
  let lastQ = '';
  let hitIdx = -1;

  // İki kelime arasındaki düzeltme sayısı (eksik/fazla/yanlış harf, yer değiştiren iki harf).
  // max'ı aşınca erken çıkar.
  function edits(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur.push(v);
        rowMin = Math.min(rowMin, v);
      }
      if (rowMin > max) return max + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  // Puan: küçük olan önde. Infinity: eşleşmedi.
  function score(e, q, qToks) {
    if (e.t.startsWith(q)) return 0;
    if (e.t.includes(q)) return 1;
    if (e.a.includes(q)) return 2;
    let total = 3;
    for (const w of qToks) {
      const tol = w.length <= 3 ? 0 : w.length <= 6 ? 1 : 2;   // kelime uzadıkça daha çok hata affedilir
      let best = Infinity;
      for (const tk of e.toks) {
        if (tk.startsWith(w)) { best = 0; break; }
        const d = Math.min(edits(w, tk, tol), tk.length > w.length ? edits(w, tk.slice(0, w.length), tol) : Infinity);
        if (d < best) best = d;
      }
      if (best > tol) return Infinity;
      total += best;
    }
    return total;
  }

  function search(raw) {
    const q = norm(raw.trim());
    if (!q) return [];
    const qToks = q.split(/[^a-z0-9]+/).filter(Boolean);
    return index
      .map(e => ({ e, s: score(e, q, qToks) }))
      .filter(r => r.s !== Infinity)
      .sort((x, y) => x.s - y.s || x.e.b.i - y.e.b.i)
      .map(r => ({ b: r.e.b, near: r.s > 3 }));
  }

  function openList(open) {
    list.hidden = !open;
    veil.hidden = !open;
    input.setAttribute('aria-expanded', open);
    if (!open) { active = -1; input.removeAttribute('aria-activedescendant'); }
  }

  function renderList() {
    if (!input.value.trim()) { openList(false); return; }
    const shown = results.slice(0, 30);
    const items = shown.map((r, n) => {
      const li = document.createElement('li');
      li.id = `res-${n}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', n === active);
      li.dataset.n = n;
      const t = document.createElement('b');
      t.textContent = r.b.d.t;
      const a = document.createElement('i');
      a.textContent = `${r.b.d.a} · ${fmtYear(r.b.d.y)}`;
      if (r.near) {
        const near = document.createElement('span');
        near.className = 'near';
        near.textContent = '≈ yakın eşleşme';
        a.append(near);
      }
      const sec = document.createElement('small');
      sec.textContent = SECTIONS[r.b.d.s].n;
      li.append(t, a, sec);
      return li;
    });
    const status = document.createElement('li');
    status.className = 'status';
    status.setAttribute('role', 'presentation');
    status.textContent = results.length
      ? (results.length > shown.length ? `${results.length} sonuçtan ilk ${shown.length} tanesi` : `${results.length} sonuç`)
      : 'Raflarda eşleşen eser yok.';
    list.replaceChildren(...items, status);
    if (active >= 0) input.setAttribute('aria-activedescendant', `res-${active}`);
    else input.removeAttribute('aria-activedescendant');
    openList(true);
  }

  function markHits(bs) {
    hits.forEach(b => b.el.classList.remove('hit'));
    hits = bs;
    hits.forEach(b => b.el.classList.add('hit'));
  }

  // Kitaplıkta o esere git: döner, kitap büyür, künyesi çıkar
  function goToBook(b, note) {
    ptr = null;
    setDock(b);
    go(b.u);
    pendingTip = b;
    if (note) hint.textContent = note;
  }

  function choose(n) {
    const r = results[n];
    if (!r) return;
    openList(false);
    markHits(results.map(x => x.b));
    lastQ = norm(input.value);
    hitIdx = n;
    goToBook(r.b, results.length > 1
      ? `“${input.value.trim()}”: ${results.length} eser · ${n + 1}. gösteriliyor — sonraki için yine “Ara”ya bas.`
      : `“${input.value.trim()}”: 1 eser bulundu. Açmak için kitaba tıkla.`);
  }

  let typing = 0;
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      results = search(input.value);
      active = -1;
      renderList();
      if (!input.value.trim()) { markHits([]); lastQ = ''; defaultHint(); }
    }, 70);
  });
  input.addEventListener('focus', () => { if (input.value.trim()) { results = search(input.value); renderList(); } });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden) { results = search(input.value); renderList(); }
      const n = Math.min(results.length, 30);
      if (!n) return;
      active = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n;
      renderList();
      list.querySelector(`#res-${active}`)?.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    } else if (e.key === 'Escape') {
      openList(false);
    }
  });
  list.addEventListener('mousedown', e => e.preventDefault());   // tıklarken arama kutusu odağı kaybetmesin
  list.addEventListener('click', e => {
    const li = e.target.closest('li[data-n]');
    if (li) choose(+li.dataset.n);
  });
  veil.addEventListener('click', () => openList(false));
  document.addEventListener('pointerdown', e => { if (!list.hidden && !e.target.closest('.search')) openList(false); });

  $('search').addEventListener('submit', e => {
    e.preventDefault();
    if (active >= 0) { choose(active); return; }
    const q = norm(input.value.trim());
    if (!q) { markHits([]); defaultHint(); return; }
    if (q === lastQ && hits.length && list.hidden) {   // aynı arama: sonraki esere geç
      hitIdx = (hitIdx + 1) % results.length;
      choose(hitIdx);
      return;
    }
    results = search(input.value);
    if (!results.length) { renderList(); hint.textContent = `“${input.value.trim()}” raflarda bulunamadı.`; return; }
    choose(0);
  });

  function defaultHint() {
    hint.textContent = finePointer.matches
      ? `${books.length} cilt · Tekerlekle döndür · Kitabın üstüne gel, büyüsün · Tıkla ve aç`
      : `${books.length} cilt · Kaydırarak döndür · Dokun: büyüt · Yeniden dokun: aç`;
  }

  /* ---------- Başlat ---------- */
  let resizeRaf = 0;
  // Yerleşim yalnızca ölçüler gerçekten değişince yeniden kurulur (tüm rafların yeniden çizilmesi pahalı)
  let laidOut = '';
  function relayout() {
    const key = `${innerWidth}x${innerHeight}x${header.offsetHeight}x${hint.offsetHeight}`;
    if (key === laidOut) return;
    laidOut = key;
    layout();
  }
  addEventListener('resize', () => {
    if (!resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; relayout(); });
  });
  defaultHint();
  renderFavs();
  syncModeButton();
  relayout();
  watchFrames();
  // Yazı tipleri gelince üst bant yüksekliği değişebilir
  if (document.fonts) document.fonts.ready.then(relayout);
})();
