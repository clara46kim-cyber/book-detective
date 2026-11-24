// Vercel 서버리스 함수: POST /api/generate
// 공공데이터포털 "국립중앙도서관_사서추천도서(국립어린이청소년도서관)" (odcloud) 에서
// 키워드와 관련된 그림책을 찾아 { books: [...] } 형태로 돌려줍니다.
// 표지는 ISBN으로 구글 도서(Google Books)에서 찾아옵니다.
// 환경변수 ODCLOUD_API_KEY 에 공공데이터포털 인증키를 넣어 주세요.

const ENDPOINT =
  "https://api.odcloud.kr/api/15151124/v1/uddi:8d9836b3-d781-4047-af85-f3b939272ef7";
const PER_PAGE = 500;
const MAX_PAGES = 10;
const MAX_RESULTS = 5;
const CACHE_MS = 60 * 60 * 1000; // 데이터는 자주 안 바뀌므로 1시간 캐시

let cache = { at: 0, rows: null };

function cleanKey(raw) {
  // 인코딩된 키/디코딩된 키 어느 쪽을 붙여넣어도 동작하게 처리
  try { return encodeURIComponent(decodeURIComponent(raw.trim())); }
  catch (e) { return encodeURIComponent(raw.trim()); }
}

async function fetchPage(page, key) {
  const url = `${ENDPOINT}?page=${page}&perPage=${PER_PAGE}&returnType=JSON&serviceKey=${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error("odcloud " + res.status);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json();
}

async function loadAll(key) {
  if (cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;

  const first = await fetchPage(1, key);
  let rows = Array.isArray(first.data) ? first.data.slice() : [];
  const total = Number(first.totalCount) || rows.length;
  const pages = Math.min(Math.ceil(total / PER_PAGE), MAX_PAGES);

  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) => fetchPage(i + 2, key))
    );
    rest.forEach((r) => { if (Array.isArray(r.data)) rows = rows.concat(r.data); });
  }
  cache = { at: Date.now(), rows };
  return rows;
}

function str(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

function stripHtml(s) {
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("다."), cut.lastIndexOf("요."));
  return (lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + "…");
}

function score(row, words) {
  const title = str(row["제목"]);
  const theme = str(row["테마명"]) + " " + str(row["주제"]);
  const content = stripHtml(str(row["내용"]));
  const author = str(row["저자"]);
  let s = 0;
  for (const w of words) {
    if (title.includes(w)) s += 10;
    if (theme.includes(w)) s += 5;
    if (author.includes(w)) s += 3;
    if (content.includes(w)) s += 2;
  }
  return s;
}

// 행에서 ISBN(13자리 또는 10자리)을 찾아요.
function findIsbn(row) {
  const pick = (v) => {
    const m = String(v || "").replace(/[-\s]/g, "").match(/97[89]\d{10}|\d{9}[\dXx]/);
    return m ? m[0] : "";
  };
  // 1) 필드 이름에 isbn / 도서번호가 들어 있는 항목
  for (const k of Object.keys(row)) {
    if (/isbn|도서번호/i.test(k)) {
      const r = pick(row[k]);
      if (r) return r;
    }
  }
  // 2) 그래도 없으면 다른 항목의 값에서 13자리 ISBN(978/979로 시작)을 찾기
  for (const k of Object.keys(row)) {
    if (/제목|내용/.test(k)) continue;
    const m = String(row[k] || "").replace(/[-\s]/g, "").match(/97[89]\d{10}/);
    if (m) return m[0];
  }
  return "";
}

// ISBN으로 구글 도서에서 표지 이미지 주소를 찾아요 (없으면 빈 문자열)
async function findCover(isbn) {
  if (!isbn) return "";

  // 1순위: 카카오 책 검색 (한국 책 표지가 잘 나와요)
  const kakaoKey = process.env.KAKAO_REST_API_KEY;
  if (kakaoKey) {
    try {
      const r = await fetch(
        `https://dapi.kakao.com/v3/search/book?target=isbn&query=${isbn}`,
        { headers: { Authorization: `KakaoAK ${kakaoKey}` } }
      );
      if (r.ok) {
        const j = await r.json();
        const doc = j.documents && j.documents[0];
        if (doc && doc.thumbnail) return doc.thumbnail.replace(/^http:/, "https:");
      } else {
        console.error("kakao error:", r.status);
      }
    } catch (e) {
      console.error("kakao fetch failed:", e.message);
    }
  }

  // 2순위: 구글 도서
  try {
    const r = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`
    );
    if (!r.ok) return "";
    const j = await r.json();
    const links =
      j.items && j.items[0] && j.items[0].volumeInfo && j.items[0].volumeInfo.imageLinks;
    const url = links && (links.thumbnail || links.smallThumbnail);
    return url ? url.replace(/^http:/, "https:") : "";
  } catch (e) {
    return "";
  }
}

function toBook(row) {
  return {
    title: str(row["제목"]),
    author: str(row["저자"]),
    publisher: str(row["발행처"]),
    summary: shorten(stripHtml(str(row["내용"])), 220),
    cover: "",
    isbn: findIsbn(row),
    debug: JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => k !== "내용")))
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST 요청만 사용할 수 있어요." });
  }

  const apiKey = process.env.ODCLOUD_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "서버에 ODCLOUD_API_KEY 환경변수가 설정되지 않았어요." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const keyword = String((body && body.keyword) || "").trim().slice(0, 50);
  if (!keyword) {
    return res.status(400).json({ error: "키워드를 입력해 주세요." });
  }

  try {
    const rows = await loadAll(cleanKey(apiKey));
    const words = keyword.split(/\s+/).filter(Boolean);

    const books = rows
      .map((row) => ({ row, s: score(row, words) }))
      .filter((x) => x.s > 0 && str(x.row["제목"]))
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_RESULTS)
      .map((x) => toBook(x.row));

    // 표지 이미지 찾기 (동시에 요청해서 빠르게)
    await Promise.all(
      books.map(async (b) => {
        b.cover = await findCover(b.isbn);
      })
    );

    return res.status(200).json({ books });
  } catch (err) {
    console.error("odcloud error:", err.status, err.message, err.detail || "");
    if (err.status === 401) {
      return res.status(502).json({ error: "도서관 API 인증키가 올바르지 않아요. 키를 확인해 주세요." });
    }
    return res.status(502).json({ error: "도서관 API에서 책 정보를 가져오지 못했어요. 잠시 후 다시 시도해 주세요." });
  }
};
