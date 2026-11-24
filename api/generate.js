// Vercel 서버리스 함수: POST /api/generate
// 공공데이터포털 "국립중앙도서관_사서추천도서(국립어린이청소년도서관)" (odcloud) 에서
// 키워드와 관련된 그림책을 찾아 { books: [...] } 형태로 돌려줍니다.
// 표지는 제목/출판사/저자로 카카오 책 검색(없으면 구글 도서)에서 찾아옵니다.
// 환경변수: ODCLOUD_API_KEY (공공데이터포털), KAKAO_REST_API_KEY (카카오 REST API 키)

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

// 비교용: 괄호/공백/특수문자 제거 + 소문자
function norm(s) {
  return str(s).toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
}

// 두 글자 묶음 중 하나가 다른 쪽을 포함하면 같다고 봐요
function similar(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

// 저자 문자열("이주항 글 ;이주희 그림")에서 첫 번째 이름만 뽑기
function firstAuthor(author) {
  const first = str(author).split(/[;,/]/)[0];
  return first.replace(/\s*(글|그림|지음|옮김|저|역|엮음|편).*$/, "").trim();
}

// 제목/출판사/저자로 표지 이미지 주소를 찾아요 (확실하지 않으면 빈 문자열)
async function findCover(book) {
  const title = book.title;
  if (!title) return "";
  const query = title.replace(/[()\[\]]/g, " ").replace(/\s+/g, " ").trim();

  // 1순위: 카카오 책 검색
  const kakaoKey = process.env.KAKAO_REST_API_KEY;
  if (kakaoKey) {
    try {
      const r = await fetch(
        `https://dapi.kakao.com/v3/search/book?target=title&size=10&query=${encodeURIComponent(query)}`,
        { headers: { Authorization: `KakaoAK ${kakaoKey}` } }
      );
      if (r.ok) {
        const j = await r.json();
        const docs = (j.documents || []).filter(
          (d) => d.thumbnail && similar(d.title, title)
        );
        const best =
          docs.find((d) => similar(d.publisher, book.publisher)) ||
          docs.find((d) => (d.authors || []).some((a) => similar(a, firstAuthor(book.author)))) ||
          docs[0];
        if (best) return best.thumbnail.replace(/^http:/, "https:");
      } else {
        console.error("kakao error:", r.status);
      }
    } catch (e) {
      console.error("kakao fetch failed:", e.message);
    }
  }

  // 2순위: 구글 도서
  try {
    const au = firstAuthor(book.author);
    const q = `intitle:${query}` + (au ? `+inauthor:${au}` : "");
    const r = await fetch(
      `https://www.googleapis.com/books/v1/volumes?maxResults=5&q=${encodeURIComponent(q).replace(/%2B/g, "+")}`
    );
    if (!r.ok) return "";
    const j = await r.json();
    for (const it of j.items || []) {
      const info = it.volumeInfo || {};
      const links = info.imageLinks;
      if (links && similar(info.title, title)) {
        const url = links.thumbnail || links.smallThumbnail;
        if (url) return url.replace(/^http:/, "https:");
      }
    }
    return "";
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
    cover: ""
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
        b.cover = await findCover(b);
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
