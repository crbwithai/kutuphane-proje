/*
  Bibliotheca — kavisli kitaplık, büyüteç ve spot ışığı

  Kitaplığın 6 bölmesi bir silindirin iç yüzüne dizilir; izleyici silindirin içindedir.
  Fare tekerleği / parmakla sürükleme / ← → tuşları silindiri döndürür.
  İmlecin altındaki kitap ve komşuları büyür (Mac Dock etkisi).
  Kitaba tıklanınca okuma penceresi o kitabın bilgileriyle açılır, kitap rafta boşluk bırakır.
*/
(() => {
  const stage = document.querySelector('.stage');
  const wall = stage.querySelector('.wall');
  const bays = [...wall.querySelectorAll(':scope > .bay')];
  const header = document.querySelector('header');

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');

  const ROWS = 3;                    // her bölme 3 raf katı
  const PLANK = 14;                  // raf tahtası (CSS --plank ile aynı)
  const CROWN = 72;                  // bölme etiketi alanı (CSS --crown ile aynı)
  const FRAME = 38;                  // bölme çerçevesi + raf iç boşluğu (yatay toplam)
  const SPAN = 150 * Math.PI / 180;  // tüm duvarın kapladığı yay
  const CAMERA = 1.3;                // kamera uzaklığı = yarıçap × bu sayı
  const HIDE = 80 * Math.PI / 180;   // bu açıdan ötedeki bölmeler gizlenir
  const MAG = [1.6, 1.34, 1.15, 1.05];

  let R = 1000;          // silindir yarıçapı (px)
  let panels = [];       // { bay, alpha, half, shade }
  let beta = 0;          // şu anki bakış açısı (radyan)
  let target = 0;        // süzülerek varılacak bakış açısı
  let minB = 0, maxB = 0;
  let raf = 0;
  let pointer = null;   // son fare konumu (büyüteç için)

  // Her bölmeye karartma katmanı
  bays.forEach(bay => {
    const shade = document.createElement('div');
    shade.className = 'bay-shade';
    shade.setAttribute('aria-hidden', 'true');
    bay.append(shade);
  });

  /* ---------- Yerleşim: kitaplığı ekrana sığdır, bölmeleri silindire diz ---------- */
  function layout() {
    const progress = maxB > minB ? (target - minB) / (maxB - minB) : 0;

    // Yükseklik: menü, ipucu satırı, korniş ve kaide dışında kalan alan 3 raf katına bölünür
    const avail = innerHeight - header.offsetHeight - 44 - 46 - 12;
    const row = Math.max(90, Math.min(210, Math.floor((avail - CROWN - 9) / ROWS - PLANK)));
    const k = row / 210;
    const height = 9 + CROWN + ROWS * (row + PLANK);
    wall.style.setProperty('--row', row + 'px');
    wall.style.setProperty('--k', k);

    // Genişlik: kitap kalınlıkları toplamı 3 kata yayılacak kadar; sığmazsa biraz genişlet
    const widths = bays.map(bay => {
      const books = [...bay.querySelectorAll('.book')];
      const sum = books.reduce((s, b) => s + parseFloat(b.style.getPropertyValue('--w')) * k + 2, 0);
      const shelf = bay.querySelector('.shelf');
      let w = Math.ceil(sum / ROWS * 1.06) + FRAME;
      bay.style.height = height + 'px';
      bay.style.width = w + 'px';
      for (let i = 0; i < 12 && shelf.scrollHeight > shelf.clientHeight + 1; i++) {
        w = Math.ceil(w * 1.04);
        bay.style.width = w + 'px';
      }
      return w;
    });

    // Bölmeler çokgenin kenarlarıdır: köşeleri çember üzerinde buluşur
    const total = widths.reduce((a, b) => a + b, 0);
    R = Math.max(total / SPAN, Math.max(...widths));
    const halves = widths.map(w => Math.asin(w / (2 * R)));
    const centers = [];
    halves.reduce((a, h, i) => { const c = i ? a + halves[i - 1] + h : 0; centers.push(c); return c; }, 0);
    const mid = centers[centers.length - 1] / 2;

    panels = bays.map((bay, i) => {
      const alpha = centers[i] - mid;
      const apothem = Math.sqrt(R * R - widths[i] * widths[i] / 4);
      bay.style.left = -widths[i] / 2 + 'px';
      bay.style.top = -height / 2 + 'px';
      bay.style.transform = `rotateY(${-alpha}rad) translateZ(${-apothem}px)`;
      return { bay, alpha, half: halves[i], shade: bay.querySelector('.bay-shade') };
    });

    // Uçlarda boşluğa bakılmaz: ilk/son bölmenin dış kenarı ekranın kenarına oturur
    const view = edgeAngle(innerWidth / 2 - 16);
    const first = panels[0];
    const last = panels[panels.length - 1];
    minB = first.alpha - first.half + view;
    maxB = last.alpha + last.half - view;
    if (minB > maxB) minB = maxB = 0;
    stage.style.perspective = Math.round(R * CAMERA) + 'px';
    beta = target = minB + progress * (maxB - minB);
    render();
  }

  // Ekran merkezinden X piksel uzaktaki noktanın duvarda kaç radyanlık açıya denk geldiği
  // (perspektifli izdüşümün tersi, ikiye bölme yöntemiyle)
  function edgeAngle(X) {
    let lo = 0, hi = Math.PI / 2;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      const x = CAMERA * R * Math.sin(m) / (CAMERA - 1 + Math.cos(m));
      if (x < X) lo = m; else hi = m;
    }
    return lo;
  }

  /* ---------- Çizim: duvarı döndür, uzaklaşan bölmeleri karart ---------- */
  function render() {
    wall.style.transform = `translateZ(${R}px) rotateY(${beta}rad)`;
    for (const p of panels) {
      const off = Math.abs(p.alpha - beta);
      p.bay.style.visibility = off - p.half > HIDE ? 'hidden' : '';
      p.shade.style.opacity = Math.min(0.92, Math.max(0, (off - p.half * 0.6) / 0.9)).toFixed(3);
    }
  }

  function tick() {
    const d = target - beta;
    beta = reduceMotion.matches || Math.abs(d) < 1e-4 ? target : beta + d * 0.14;
    render();
    if (pointer) magnify(pointer.x, pointer.y);
    raf = beta === target ? 0 : requestAnimationFrame(tick);
  }

  function go(angle) {
    target = Math.min(maxB, Math.max(minB, angle));
    if (!raf) raf = requestAnimationFrame(tick);
  }

  const popoverOpen = () => document.querySelector(':popover-open') !== null;

  /* ---------- Fare tekerleği ---------- */
  document.addEventListener('wheel', e => {
    if (popoverOpen() || e.target.closest?.('[popover]')) return;
    e.preventDefault();
    const px = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerWidth : 1;
    go(target + px * unit / R * 1.4);
  }, { passive: false });

  /* ---------- Parmakla sürükleme (dokunmatik) ---------- */
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
    if (Math.abs(dx) > 8) dragged = true;
    if (dragged) go(drag.start - dx / R * 1.2);
  });
  addEventListener('pointerup', () => { drag = null; });
  addEventListener('pointercancel', () => { drag = null; });
  // Sürükleme bittiğinde parmağın altındaki kitap açılmasın
  stage.addEventListener('click', e => {
    if (!dragged) return;
    e.preventDefault();
    e.stopPropagation();
    dragged = false;
  }, true);

  /* ---------- Klavye ---------- */
  addEventListener('keydown', e => {
    if (popoverOpen() || e.target.closest?.('input, textarea')) return;
    if (e.key === 'ArrowRight') { go(target + 220 / R); e.preventDefault(); }
    if (e.key === 'ArrowLeft')  { go(target - 220 / R); e.preventDefault(); }
  });
  // Tab ile bir kitaba gelinince o kitap ortaya döner
  wall.addEventListener('focusin', e => {
    if (!e.target.matches(':focus-visible')) return;
    const book = e.target.closest('.book');
    const p = book && panels.find(p => p.bay.contains(book));
    if (!p) return;
    const x = book.offsetLeft + book.offsetWidth / 2 - p.bay.offsetWidth / 2;
    go(p.alpha + Math.asin(Math.max(-1, Math.min(1, x / R))));
  });

  /* ---------- Büyüteç (Dock etkisi) ---------- */
  let current = null;
  let magged = [];
  let magRaf = 0;

  function clearMag() {
    magged.forEach(b => { b.style.removeProperty('--mag'); b.style.zIndex = ''; });
    magged = [];
    current = null;
  }

  function magnify(x, y) {
    const hit = document.elementFromPoint(x, y);
    const book = hit && hit.closest('.wall .book:not(.is-out)');
    if (book === current) return;
    clearMag();
    if (!book) return;
    current = book;
    const list = book.parentElement.children;
    const i = Array.prototype.indexOf.call(list, book);
    for (let d = -3; d <= 3; d++) {
      const b = list[i + d];
      if (!b || b.offsetTop !== book.offsetTop) continue;
      b.style.setProperty('--mag', MAG[Math.abs(d)]);
      b.style.zIndex = 30 - Math.abs(d);
      magged.push(b);
    }
  }

  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || !finePointer.matches || reduceMotion.matches) return;
    pointer = { x: e.clientX, y: e.clientY };
    if (!magRaf) magRaf = requestAnimationFrame(() => { magRaf = 0; magnify(pointer.x, pointer.y); });
  });
  document.addEventListener('mouseleave', () => { pointer = null; clearMag(); });

  /* ---------- Kitaba tıklama: okuma penceresini doldur, kitabı raftan çek ---------- */
  const reader = document.getElementById('book-reader');
  const cover = document.getElementById('reader-cover');
  const flap = document.getElementById('reader-flap');
  const readerTitle = document.getElementById('reader-title');
  const byline = document.getElementById('reader-byline');
  let outBook = null;

  document.addEventListener('click', e => {
    const spine = e.target.closest('.spine[popovertarget="book-reader"]');
    if (!spine) return;
    const book = spine.closest('.book');
    const { title, author } = book.dataset;
    const c = book.style.getPropertyValue('--c');
    const t = book.style.getPropertyValue('--t');

    for (const el of [cover, flap]) {
      el.style.setProperty('--c', c);
      el.style.setProperty('--t', t);
    }
    cover.firstElementChild.textContent = title;
    cover.lastElementChild.textContent = author;
    const [flapTitle, flapAuthor] = flap.querySelectorAll('p');
    flapTitle.textContent = title;
    flapAuthor.textContent = author;
    readerTitle.textContent = title;
    byline.textContent = author;

    clearMag();
    if (outBook) outBook.classList.remove('is-out');
    outBook = book;
    book.classList.add('is-out');
  });

  reader.addEventListener('toggle', e => {
    if (e.newState !== 'closed' || !outBook) return;
    outBook.classList.remove('is-out');
    outBook = null;
  });

  /* ---------- Başlat ---------- */
  let resizeRaf = 0;
  addEventListener('resize', () => {
    if (!resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; layout(); });
  });
  addEventListener('load', layout);
  layout();
})();
