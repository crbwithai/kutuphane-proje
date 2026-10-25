-- Bibliotheca kütüphane veritabanı (doğruluk kaynağı)
-- Site bu veritabanını doğrudan okumaz: `python3 tools/kutuphane.py cikar` ile data/ klasörüne statik dosya olarak aktarılır.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sections (
  id     INTEGER PRIMARY KEY,
  num    TEXT    NOT NULL,              -- Roma rakamı: I, II, ...
  name   TEXT    NOT NULL,              -- Türkçe ad
  latin  TEXT    NOT NULL,              -- Latince alt başlık
  ord    INTEGER NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS books (
  id             INTEGER PRIMARY KEY,   -- kalıcı kimlik: sitedeki adresler ve Okuma Köşem bunu kullanır
  section_id     INTEGER NOT NULL REFERENCES sections(id),
  ord            INTEGER NOT NULL,      -- bölüm içindeki raf sırası
  title          TEXT    NOT NULL,      -- Türkçe başlık
  author         TEXT    NOT NULL,      -- Türkçe yazımıyla yazar
  search_title   TEXT    NOT NULL,      -- Open Library / Vikipedi aramasında kullanılan başlık
  search_author  TEXT    NOT NULL DEFAULT '',
  year           INTEGER,               -- ilk yayın / yazılış yılı (MÖ için eksi)
  lang           TEXT    NOT NULL DEFAULT '',
  ol_override    TEXT,                  -- elle verilmiş Open Library eser kimliği (OL…W)
  wiki_override  TEXT,                  -- elle verilmiş Vikipedi maddesi, ör. "tr:Huzur (roman)"
  status         TEXT    NOT NULL DEFAULT 'aktif'    CHECK (status IN ('aktif', 'gizli')),
  review         TEXT    NOT NULL DEFAULT 'otomatik' CHECK (review IN ('otomatik', 'dogrulandi', 'sorunlu')),
  note           TEXT,
  UNIQUE (section_id, title, author)
);
CREATE INDEX IF NOT EXISTS books_section ON books (section_id, ord);

CREATE TABLE IF NOT EXISTS ol_matches (
  book_id     INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  work_key    TEXT,                     -- NULL: Open Library'de bulunamadı
  ol_title    TEXT,
  ol_authors  TEXT,
  first_year  INTEGER,
  cover_id    INTEGER,
  pages       INTEGER,
  flags       TEXT NOT NULL DEFAULT '', -- otomatik uyarılar: YAZAR_UYUSMUYOR, BASLIK_FARKLI, ...
  fetched_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ol_work ON ol_matches (work_key);

CREATE TABLE IF NOT EXISTS summaries (
  book_id     INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  lang        TEXT NOT NULL,            -- 'tr' / 'en'
  source      TEXT NOT NULL,            -- 'Türkçe Vikipedi', 'Open Library', ...
  url         TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS covers (
  book_id     INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  file        TEXT,                     -- data/covers/ altındaki dosya; NULL: kapak yok
  bytes       INTEGER,
  source_url  TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);

-- Gözden geçirme görünümü: her kitabın eşleşme ve özet durumu tek satırda
CREATE VIEW IF NOT EXISTS v_books AS
SELECT b.id, s.num AS bolum, b.title, b.author, b.year, b.status, b.review,
       m.work_key, m.ol_title, m.ol_authors, m.first_year, m.pages, m.cover_id, m.flags,
       sm.source AS ozet_kaynagi, sm.lang AS ozet_dili, length(sm.text) AS ozet_uzunlugu,
       c.file AS kapak
FROM books b
JOIN sections s ON s.id = b.section_id
LEFT JOIN ol_matches m ON m.book_id = b.id
LEFT JOIN summaries sm ON sm.book_id = b.id
LEFT JOIN covers c ON c.book_id = b.id;
