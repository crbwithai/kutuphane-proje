#!/usr/bin/env python3
"""
Bibliotheca — kütüphane veritabanı aracı

Doğruluk kaynağı tools/library.db (SQLite). Site veritabanını doğrudan okumaz;
`cikar` komutu data/ klasörüne statik dosyalar yazar (dizin + kitap ayrıntıları + kapaklar).

Komutlar
  kur                       şemayı oluştur/güncelle (boş veritabanına tools/source/*.tsv'den ilk aktarım)
  topla [--hepsi] [ID...]   Open Library + Vikipedi'den eşleşme ve özet topla (eksik olanlar)
  kapaklar                  Open Library kapaklarını indir, küçült → data/covers/
  rapor [--sorunlu] [--bolum N] [--ara METİN]
                            kitapların eşleşme / özet durumunu listele
  duzelt ID [--ol OL123W] [--wiki tr:Madde | en:Madde | -] [--ara-baslik B] [--ara-yazar Y]
            [--dogrula] [--sorunlu] [--gizle] [--goster] [--not METİN]
                            elle düzeltme; arama bilgisi değişirse eşleşme yeniden toplanır
  cikar [--ozetsiz]         siteye aktar: data/index.js, data/d/NN.js

Özet sırası: Türkçe (Open Library'de Türkçe metin ya da Türkçe Vikipedi) → Open Library eser
açıklaması → Open Library baskı açıklaması (Türkçe baskı öncelikli) → İngilizce Vikipedi.
Her özetin kaynağı ve bağlantısı saklanır.
"""
import argparse, difflib, glob, hashlib, json, os, re, sqlite3, subprocess, sys, tempfile, threading, time, unicodedata
import urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'tools', 'library.db')
SCHEMA = os.path.join(ROOT, 'tools', 'schema.sql')
SEED = os.path.join(ROOT, 'tools', 'source')
CACHE = os.path.join(ROOT, 'tools', '.cache')
DATA = os.path.join(ROOT, 'data')
UA = 'BibliothecaBuild/1.0 (+https://github.com/crbwithai/kutuphane-proje; static site data build)'
SHARD = 50   # ayrıntı dosyası başına kitap

SECTIONS = [
    ('i-turk-edebiyati', 'I', 'Türk Edebiyatı', 'Litterae Turcicae'),
    ('ii-dunya-klasikleri', 'II', 'Dünya Klasikleri', 'Classica Mundi'),
    ('iii-mitoloji', 'III', 'Mitoloji ve Antik Çağ', 'Mythos et Antiquitas'),
    ('iv-felsefe', 'IV', 'Felsefe', 'Philosophia'),
    ('v-iktisat-bilim', 'V', 'İktisat ve Bilim', 'Oeconomia et Scientia'),
    ('vi-tarih', 'VI', 'Tarih', 'Historia'),
]

now = lambda: datetime.now(timezone.utc).isoformat(timespec='seconds')


def connect():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys = ON')
    return con


# =====================================================================
#  Ağ: diske önbellekli, sunucu başına hız sınırlı, iş parçacığı güvenli
# =====================================================================
os.makedirs(CACHE, exist_ok=True)
_last, _locks, _guard = {}, {}, threading.Lock()


class NetworkError(Exception):
    """Sunucuya ulaşılamadı ya da sürekli hata döndü. "Bulunamadı" ile karıştırılmamalı:
    bu durumda kitap veritabanına yazılmaz, sonraki çalıştırmada yeniden denenir."""


def fetch(url, host_delay, raw=False):
    key = hashlib.sha1(url.encode()).hexdigest()
    path = os.path.join(CACHE, key + ('.bin' if raw else '.json'))
    if os.path.exists(path):
        if raw:
            return open(path, 'rb').read()
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    host = urllib.parse.urlparse(url).netloc
    with _guard:
        lock = _locks.setdefault(host, threading.Lock())
    with lock:  # aynı sunucuya iki isteğin başlangıcı arasında en az host_delay saniye
        wait = _last.get(host, 0) + host_delay - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[host] = time.time()
    data = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read()
            data = body if raw else json.loads(body.decode('utf-8'))
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                data = b'' if raw else {'__404': True}
                break
            retry_after = e.headers.get('Retry-After', '')   # 429/503: sunucunun istediği kadar bekle
            time.sleep(min(int(retry_after), 60) if retry_after.isdigit() else 5 * (attempt + 1))
        except Exception:
            time.sleep(5 * (attempt + 1))
    if data is None:
        raise NetworkError(f'{host}: yanıt alınamadı')
    if raw:
        open(path, 'wb').write(data)
    else:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
    return data


# =====================================================================
#  Karşılaştırma yardımcıları
# =====================================================================
def norm(s):
    s = (s or '').replace('ı', 'i').replace('İ', 'i')
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def surname_tokens(author):
    toks = [t for t in norm(author).split() if len(t) >= 3 and t not in ('von', 'van', 'der', 'del', 'des', 'and', 'ibn', 'bin')]
    return toks[-1:] if toks else []


def author_ok(want, names):
    """İstenen yazarın soyadı verilen ad(lar)da geçiyor mu? (yazım farklarına toleranslı)"""
    if not want:
        return True
    hay = ' '.join(norm(n) for n in names or []).split()
    for part in re.split(r'\s*(?:&|,| ve | and )\s*', want):
        for tok in surname_tokens(part):
            if tok in hay or any(difflib.SequenceMatcher(None, tok, h).ratio() >= 0.8 for h in hay):
                return True
    return False


def title_sim(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0
    if a in b or b in a:
        return 1
    return difflib.SequenceMatcher(None, a, b).ratio()


def is_turkish(text):
    return len(re.findall(r'[ğışĞİŞ]', text or '')) >= 3


def trim(text, limit=900):
    text = re.sub(r'[ \t]+\n', '\n', text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind('. '), cut.rfind('.\n'))
    return (cut[:end + 1] if end > 200 else cut.rstrip() + '…').strip()


# =====================================================================
#  Open Library
# =====================================================================
OL_DELAY = 0.4   # ≈2,5 istek/sn (Open Library tanıtılmış istemcilere 3/sn izin veriyor)
FIELDS = 'key,title,author_name,first_publish_year,cover_i,number_of_pages_median,edition_count'


def ol_search(title, author):
    q = {'title': title, 'fields': FIELDS, 'limit': '10'}
    if author:
        q['author'] = author
    d = fetch('https://openlibrary.org/search.json?' + urllib.parse.urlencode(q), OL_DELAY)
    docs = (d or {}).get('docs') or []
    if not docs:
        q = {'q': f'{title} {author}'.strip(), 'fields': FIELDS, 'limit': '10'}
        d = fetch('https://openlibrary.org/search.json?' + urllib.parse.urlencode(q), OL_DELAY)
        docs = (d or {}).get('docs') or []
    best, best_score = None, -1
    for i, doc in enumerate(docs):
        score = (2 if author_ok(author, doc.get('author_name')) else 0) + title_sim(title, doc.get('title', '')) \
            + min(doc.get('edition_count', 0), 200) / 400 - i * 0.02
        if score > best_score:
            best, best_score = doc, score
    return best


def ol_by_key(work_key):
    d = fetch('https://openlibrary.org/search.json?' + urllib.parse.urlencode({'q': f'key:/works/{work_key}', 'fields': FIELDS}), OL_DELAY)
    return ((d or {}).get('docs') or [None])[0]


def clean_ol_desc(text):
    text = text.replace('\r', '')
    text = re.split(r'\n-{3,}|\n\*\*Also contained in|\n\[\d+\]:|\nSee also|\n\(\[source\]', text)[0]
    text = re.sub(r'^From \[?wikipedia\]?\(?[^\n]*\)?:\s*', '', text, flags=re.I)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    text = re.sub(r'\[([^\]]+)\]\[\d+\]', r'\1', text)
    text = re.sub(r'\([^()]*(IPA|tr\.|Russian:|Greek:|Latin:)[^()]*\)', '', text)
    text = re.sub(r'[*_#>]+', '', text)
    return re.sub(r'\n{2,}', '\n\n', text).strip()


def ol_description(key):
    d = fetch(f'https://openlibrary.org{key}.json', OL_DELAY) or {}
    desc = d.get('description')
    if isinstance(desc, dict):
        desc = desc.get('value')
    return clean_ol_desc(desc) if desc and len(desc) >= 80 else None


def ol_edition_description(key):
    """Eser kaydında açıklama yoksa baskılara bak: Türkçe baskının açıklaması öncelikli."""
    d = fetch(f'https://openlibrary.org{key}/editions.json?limit=100', OL_DELAY) or {}
    best = None
    for e in d.get('entries', []):
        desc = e.get('description')
        if isinstance(desc, dict):
            desc = desc.get('value')
        if not desc or len(desc) < 120:
            continue
        tur = any(l.get('key') == '/languages/tur' for l in e.get('languages', []))
        rank = (tur or is_turkish(desc), len(desc))
        if not best or rank > best[0]:
            best = (rank, clean_ol_desc(desc), e['key'])
    return (best[1], best[2]) if best else (None, None)


# =====================================================================
#  Vikipedi: tek sorguda adaylar + giriş metni + Türkçe karşılık
# =====================================================================
WIKI_DELAY = 0.2   # ≈5 istek/sn


def wiki_query(lang, **params):
    q = {'action': 'query', 'format': 'json', 'formatversion': '2', 'redirects': '1',
         'prop': 'extracts|pageprops|langlinks|info', 'exintro': '1', 'explaintext': '1', 'exlimit': '20',
         'ppprop': 'disambiguation', 'lllang': 'tr', 'lllimit': '50', 'inprop': 'url', **params}
    d = fetch(f'https://{lang}.wikipedia.org/w/api.php?' + urllib.parse.urlencode(q), WIKI_DELAY) or {}
    pages = d.get('query', {}).get('pages', [])
    return sorted(pages, key=lambda p: p.get('index', 0))


def wiki_page(lang, title):
    pages = wiki_query(lang, titles=title)
    p = pages[0] if pages else None
    if not p or p.get('missing') or not p.get('extract'):
        return None
    # başka bir maddeye (ör. yazarın biyografisine) yönlendiren başlıkları reddet
    if title_sim(re.sub(r'\s*\(.*\)$', '', title), re.sub(r'\s*\(.*\)$', '', p.get('title', ''))) < 0.6:
        return None
    return p


def wiki_find(lang, title, author):
    """Eserin kendi maddesi: başlığı benzer, giriş metni yazarı anıyor, anlam ayrımı ya da yazar biyografisi değil."""
    pages = wiki_query(lang, generator='search', gsrsearch=f'{title} {author}'.strip(), gsrlimit='6')
    direct = wiki_page(lang, title)
    for p in ([direct] if direct else []) + pages:
        name = re.sub(r'\s*\(.*\)$', '', p.get('title', ''))
        ext = p.get('extract') or ''
        if title_sim(title, name) < 0.75 or len(ext) < 80:
            continue
        if 'disambiguation' in (p.get('pageprops') or {}):
            continue
        if author and (not author_ok(author, [ext]) or title_sim(author, name) > 0.8):
            continue
        return p
    return None


def clean_wiki(text):
    """Giriş metnindeki telaffuz/özgün yazım parantezlerini çıkar: (Rusça: Анна Каренина; [ˈanə …])"""
    text = re.sub(r'\s*\((?:[^()]|\([^()]*\))*?(?:\[|ˈ|[\u0370-\u03ff\u0400-\u04ff\u0590-\u06ff\u0900-\u0dff\u3040-\u9fff])(?:[^()]|\([^()]*\))*?\)', '', text)
    return re.sub(r'\s{2,}', ' ', text).replace(' ,', ',').strip()


def tr_link(en_page):
    links = en_page.get('langlinks') or []
    return links[0]['title'] if links else None


# =====================================================================
#  Tek kitabı topla
# =====================================================================
def collect(b):
    """b: books satırı (dict). (eşleşme, özet) döndürür; veritabanına yazmaz."""
    flags = []
    doc = ol_by_key(b['ol_override']) if b['ol_override'] else ol_search(b['search_title'], b['search_author'])
    if not doc:
        flags.append('OL_YOK')
    else:
        if not author_ok(b['search_author'], doc.get('author_name')):
            flags.append('YAZAR_UYUSMUYOR')
        if not b['ol_override'] and title_sim(b['search_title'], doc.get('title', '')) < 0.6:
            flags.append('BASLIK_FARKLI')
        fy, y = doc.get('first_publish_year'), b['year']
        if y and fy and y > 1500 and fy < y - 3:
            flags.append(f'YIL_OL_{fy}')

    tr = en = None
    forced = bool(b['wiki_override']) and b['wiki_override'] != '-'
    if b['wiki_override'] == '-':   # elle: Vikipedi'de bu esere ait madde yok
        pass
    elif b['wiki_override']:
        lang, _, title = b['wiki_override'].partition(':')
        p = wiki_page(lang, title)
        if lang == 'tr':
            tr = p
        else:
            en = p
            tr = wiki_page('tr', tr_link(p)) if p and tr_link(p) else None
    else:
        en = wiki_find('en', b['search_title'], b['search_author'])
        if en and tr_link(en):
            tr = wiki_page('tr', tr_link(en))
        if not tr:
            tr = wiki_find('tr', b['title'], b['author'])

    key = doc['key'] if doc else None
    ol_desc = ol_description(key) if key and not tr and not (forced and en) else None
    ed_desc = ed_key = None
    if key and not tr and not (forced and en) and not (ol_desc and is_turkish(ol_desc)):
        ed_desc, ed_key = ol_edition_description(key)

    def S(text, source, url):
        return {'text': trim(text), 'lang': 'tr' if is_turkish(text) else 'en', 'source': source, 'url': url}

    if forced and (tr or en):   # elle seçilmiş madde kesindir
        summary = S(clean_wiki(tr['extract']), 'Türkçe Vikipedi', tr['fullurl']) if tr \
            else S(clean_wiki(en['extract']), 'English Wikipedia', en['fullurl'])
    elif ol_desc and is_turkish(ol_desc):
        summary = S(ol_desc, 'Open Library', f'https://openlibrary.org{key}')
    elif tr:
        summary = S(clean_wiki(tr['extract']), 'Türkçe Vikipedi', tr['fullurl'])
    elif ed_desc and is_turkish(ed_desc):
        summary = S(ed_desc, 'Open Library (baskı açıklaması)', f'https://openlibrary.org{ed_key}')
    elif ol_desc:
        summary = S(ol_desc, 'Open Library', f'https://openlibrary.org{key}')
    elif ed_desc:
        summary = S(ed_desc, 'Open Library (baskı açıklaması)', f'https://openlibrary.org{ed_key}')
    elif en:
        summary = S(clean_wiki(en['extract']), 'English Wikipedia', en['fullurl'])
    else:
        summary = None
        flags.append('OZET_YOK')

    match = {
        'work_key': key.rsplit('/', 1)[-1] if key else None,
        'ol_title': doc.get('title') if doc else None,
        'ol_authors': ', '.join((doc or {}).get('author_name', [])[:3]) or None,
        'first_year': (doc or {}).get('first_publish_year'),
        'cover_id': (doc or {}).get('cover_i'),
        'pages': (doc or {}).get('number_of_pages_median'),
        'flags': ' '.join(flags),
    }
    return match, summary


# =====================================================================
#  Komutlar
# =====================================================================
def cmd_kur(args):
    con = connect()
    con.executescript(open(SCHEMA, encoding='utf-8').read())
    if con.execute('SELECT count(*) FROM books').fetchone()[0]:
        print('Veritabanı zaten dolu; yalnızca şema güncellendi.')
        return
    if not os.path.isdir(SEED):
        sys.exit(f'Veritabanı boş ve ilk veri klasörü yok: {SEED}')
    for ordn, (slug, num, name, latin) in enumerate(SECTIONS, 1):
        sid = con.execute('INSERT INTO sections (num, name, latin, ord) VALUES (?,?,?,?)', (num, name, latin, ordn)).lastrowid
        path = os.path.join(SEED, slug + '.tsv')
        rows = [l.rstrip('\n').split('\t') for l in open(path, encoding='utf-8') if l.strip() and not l.startswith('#')]
        for i, cols in enumerate(rows, 1):
            cols = [c.strip() for c in cols] + [''] * (8 - len(cols))
            t, a, qt, qa, y, l, ol, wiki = cols[:8]
            con.execute('''INSERT INTO books (section_id, ord, title, author, search_title, search_author, year, lang, ol_override, wiki_override)
                           VALUES (?,?,?,?,?,?,?,?,?,?)''', (sid, i, t, a, qt or t, qa, int(y) if y else None, l, ol or None, wiki or None))
    con.commit()
    print(f"{con.execute('SELECT count(*) FROM books').fetchone()[0]} kitap, {len(SECTIONS)} bölüm aktarıldı → {DB}")


def cmd_topla(args):
    con = connect()
    if args.ids:
        rows = con.execute(f"SELECT * FROM books WHERE id IN ({','.join('?' * len(args.ids))})", args.ids).fetchall()
    elif args.hepsi:
        rows = con.execute("SELECT * FROM books WHERE status = 'aktif' ORDER BY id").fetchall()
    else:
        rows = con.execute("""SELECT b.* FROM books b LEFT JOIN ol_matches m ON m.book_id = b.id
                              WHERE b.status = 'aktif' AND m.book_id IS NULL ORDER BY b.id""").fetchall()
    rows = [dict(r) for r in rows]
    print(f'{len(rows)} kitap toplanacak…', flush=True)
    done = 0
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(collect, b): b for b in rows}
        for fut in as_completed(futures):   # yazma işi tek iş parçacığında (SQLite)
            b = futures[fut]
            try:
                match, summary = fut.result()
            except Exception as e:  # tek kitabın hatası tüm toplamayı durdurmasın
                print(f"  HATA #{b['id']} {b['title']}: {e}", flush=True)
                continue
            t = now()
            con.execute('''INSERT OR REPLACE INTO ol_matches (book_id, work_key, ol_title, ol_authors, first_year, cover_id, pages, flags, fetched_at)
                           VALUES (:id, :work_key, :ol_title, :ol_authors, :first_year, :cover_id, :pages, :flags, :t)''', {**match, 'id': b['id'], 't': t})
            if summary:
                con.execute('INSERT OR REPLACE INTO summaries (book_id, text, lang, source, url, fetched_at) VALUES (?,?,?,?,?,?)',
                            (b['id'], summary['text'], summary['lang'], summary['source'], summary['url'], t))
            else:
                con.execute('DELETE FROM summaries WHERE book_id = ?', (b['id'],))
            con.commit()
            done += 1
            print(f"{done}/{len(rows)} #{b['id']} {b['title']} → {match['ol_title'] or '-'} [{summary['source'] if summary else '-'}] {match['flags']}", flush=True)


def cmd_kapaklar(args):
    con = connect()
    rows = con.execute('''SELECT b.id, m.cover_id FROM books b JOIN ol_matches m ON m.book_id = b.id
                          LEFT JOIN covers c ON c.book_id = b.id
                          WHERE b.status = 'aktif' AND m.cover_id IS NOT NULL AND c.book_id IS NULL''').fetchall()
    out_dir = os.path.join(DATA, 'covers')
    os.makedirs(out_dir, exist_ok=True)
    print(f'{len(rows)} kapak indirilecek…', flush=True)

    def one(r):
        url = f"https://covers.openlibrary.org/b/id/{r['cover_id']}-M.jpg?default=false"
        body = fetch(url, 0.25, raw=True)
        if not body:
            return r['id'], None, 0, url
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            tmp.write(body)
        dest = os.path.join(out_dir, f"{r['id']}.jpg")
        # 240 px genişliğe küçült, JPEG kalitesi 72 (macOS sips)
        subprocess.run(['sips', '--resampleWidth', '240', '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', tmp.name, '--out', dest],
                       check=True, capture_output=True)
        os.unlink(tmp.name)
        return r['id'], f"{r['id']}.jpg", os.path.getsize(dest), url

    with ThreadPoolExecutor(max_workers=6) as pool:
        for n, fut in enumerate(as_completed([pool.submit(one, r) for r in rows]), 1):
            try:
                bid, file, size, url = fut.result()
            except Exception as e:
                print(f'  HATA: {e}', flush=True)
                continue
            con.execute('INSERT OR REPLACE INTO covers (book_id, file, bytes, source_url, fetched_at) VALUES (?,?,?,?,?)', (bid, file, size, url, now()))
            con.commit()
            if n % 50 == 0:
                print(f'{n}/{len(rows)}', flush=True)
    total = con.execute('SELECT count(file), coalesce(sum(bytes), 0) FROM covers').fetchone()
    print(f'{total[0]} kapak, toplam {total[1] / 1024 / 1024:.1f} MB')


def cmd_rapor(args):
    con = connect()
    where, params = ["1=1"], []
    if args.sorunlu:
        where.append("(flags != '' OR review = 'sorunlu' OR work_key IS NULL OR ozet_kaynagi IS NULL)")
    if args.bolum:
        where.append('bolum = ?')
        params.append(args.bolum)
    if args.ara:
        where.append('(title LIKE ? OR author LIKE ?)')
        params += [f'%{args.ara}%'] * 2
    rows = con.execute(f"SELECT * FROM v_books WHERE {' AND '.join(where)} ORDER BY id", params).fetchall()
    for r in rows:
        print(f"#{r['id']:<5}{r['bolum']:<4}{r['title'][:34]:<35}{r['author'][:22]:<23}→ {(r['ol_title'] or '-')[:34]:<35}"
              f"{(r['ol_authors'] or '-')[:22]:<23}{r['work_key'] or '-':<12}{(r['ozet_kaynagi'] or '-')[:18]:<19}{r['review']:<11}{r['status']:<6}{r['flags'] or ''}")
    stats = con.execute('''SELECT count(*), sum(work_key IS NOT NULL), sum(ozet_kaynagi IS NOT NULL), sum(flags != ''),
                                  sum(review = 'dogrulandi'), sum(status = 'gizli') FROM v_books''').fetchone()
    print(f'\n{len(rows)} satır · toplam {stats[0]} kitap · OL eşleşmesi {stats[1]} · özet {stats[2]} · uyarılı {stats[3]} · elle doğrulanan {stats[4]} · gizli {stats[5]}')
    for src, n in con.execute('SELECT ozet_kaynagi, count(*) FROM v_books GROUP BY 1 ORDER BY 2 DESC'):
        print(f'  özet kaynağı: {src or "(yok)"}: {n}')


def cmd_duzelt(args):
    con = connect()
    b = con.execute('SELECT * FROM books WHERE id = ?', (args.id,)).fetchone()
    if not b:
        sys.exit(f'#{args.id} bulunamadı')
    sets, refetch = {}, False
    if args.ol is not None:
        sets['ol_override'] = args.ol or None
        refetch = True
    if args.wiki is not None:
        sets['wiki_override'] = args.wiki or None
        refetch = True
    if args.ara_baslik:
        sets['search_title'] = args.ara_baslik
        refetch = True
    if args.ara_yazar is not None:
        sets['search_author'] = args.ara_yazar
        refetch = True
    if args.dogrula:
        sets['review'] = 'dogrulandi'
    if args.sorunlu:
        sets['review'] = 'sorunlu'
    if args.gizle:
        sets['status'] = 'gizli'
    if args.goster:
        sets['status'] = 'aktif'
    if args.not_ is not None:
        sets['note'] = args.not_
    if sets:
        con.execute(f"UPDATE books SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), args.id))
    if refetch:  # eski eşleşme silinir; `topla` yeniden toplar
        con.execute('DELETE FROM ol_matches WHERE book_id = ?', (args.id,))
        con.execute('DELETE FROM summaries WHERE book_id = ?', (args.id,))
        con.execute('DELETE FROM covers WHERE book_id = ?', (args.id,))
    con.commit()
    print(f"#{args.id} {b['title']}: {sets or 'değişiklik yok'}{' — yeniden toplanacak' if refetch else ''}")


def js_dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def cmd_cikar(args):
    con = connect()
    need = '' if args.ozetsiz else 'AND sm.book_id IS NOT NULL'
    rows = con.execute(f'''
        SELECT b.id, s.ord - 1 AS s, b.title, b.author, b.year, b.lang, m.work_key, m.pages,
               c.file AS cover, sm.text, sm.source, sm.url
        FROM books b JOIN sections s ON s.id = b.section_id
        JOIN ol_matches m ON m.book_id = b.id AND m.work_key IS NOT NULL
        LEFT JOIN summaries sm ON sm.book_id = b.id
        LEFT JOIN covers c ON c.book_id = b.id
        WHERE b.status = 'aktif' {need}
        ORDER BY s.ord, b.ord''').fetchall()
    skipped = con.execute("SELECT count(*) FROM books WHERE status = 'aktif'").fetchone()[0] - len(rows)

    sections = [{'n': r['num'], 't': r['name'], 'la': r['latin']} for r in con.execute('SELECT * FROM sections ORDER BY ord')]
    # Dizin: rafı çizmek için gereken en az bilgi → [id, bölüm, başlık, yazar, yıl, sayfa]
    index = [[r['id'], r['s'], r['title'], r['author'], r['year'], r['pages']] for r in rows]
    shards = {}
    for r in rows:
        shards.setdefault(r['id'] // SHARD, {})[r['id']] = {
            'l': r['lang'], 'k': r['work_key'], 'c': r['cover'],
            'd': r['text'], 'ds': r['source'], 'du': r['url'],
        }

    os.makedirs(os.path.join(DATA, 'd'), exist_ok=True)
    # Sürüm: içerik değişince değişir; ayrıntı dosyaları ?v= ile istenir, eski önbellek kullanılmaz
    version = hashlib.sha1(js_dump([sections, index, shards]).encode()).hexdigest()[:10]
    with open(os.path.join(DATA, 'index.js'), 'w', encoding='utf-8') as f:
        f.write('/* Otomatik üretildi: tools/kutuphane.py cikar — elle düzenlemeyin. */\n')
        f.write(f"window.LIBRARY = {js_dump({'sections': sections, 'books': index, 'shard': SHARD, 'version': version})};\n")
    keep = set()
    for n, items in shards.items():
        name = f'{n:02d}.js'
        keep.add(name)
        with open(os.path.join(DATA, 'd', name), 'w', encoding='utf-8') as f:
            f.write(f'window.__libraryShard({n},{js_dump(items)});\n')
    for old in glob.glob(os.path.join(DATA, 'd', '*.js')):   # artık kullanılmayan parçaları sil
        if os.path.basename(old) not in keep:
            os.remove(old)
    size_i = os.path.getsize(os.path.join(DATA, 'index.js'))
    size_d = sum(os.path.getsize(os.path.join(DATA, 'd', k)) for k in keep)
    print(f'{len(rows)} kitap aktarıldı ({skipped} dışarıda: gizli, eşleşmesiz ya da özetsiz) · sürüm {version}')
    print(f'data/index.js {size_i / 1024:.0f} KB · {len(keep)} ayrıntı dosyası toplam {size_d / 1024:.0f} KB')


def main():
    p = argparse.ArgumentParser(description='Bibliotheca kütüphane veritabanı aracı')
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('kur').set_defaults(fn=cmd_kur)
    t = sub.add_parser('topla')
    t.add_argument('ids', nargs='*', type=int)
    t.add_argument('--hepsi', action='store_true')
    t.set_defaults(fn=cmd_topla)
    sub.add_parser('kapaklar').set_defaults(fn=cmd_kapaklar)
    r = sub.add_parser('rapor')
    r.add_argument('--sorunlu', action='store_true')
    r.add_argument('--bolum')
    r.add_argument('--ara')
    r.set_defaults(fn=cmd_rapor)
    d = sub.add_parser('duzelt')
    d.add_argument('id', type=int)
    d.add_argument('--ol')
    d.add_argument('--wiki')
    d.add_argument('--ara-baslik')
    d.add_argument('--ara-yazar')
    d.add_argument('--dogrula', action='store_true')
    d.add_argument('--sorunlu', action='store_true')
    d.add_argument('--gizle', action='store_true')
    d.add_argument('--goster', action='store_true')
    d.add_argument('--not', dest='not_')
    d.set_defaults(fn=cmd_duzelt)
    c = sub.add_parser('cikar')
    c.add_argument('--ozetsiz', action='store_true', help='özeti bulunmayan kitapları da aktar')
    c.set_defaults(fn=cmd_cikar)
    args = p.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
