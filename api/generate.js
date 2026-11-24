// Vercel 서버리스 함수: POST /api/generate
// 공공데이터포털 "국립중앙도서관_사서추천도서(국립어린이청소년도서관)" (odcloud) 에서
// 키워드와 관련된 그림책을 찾아 { books: [...] } 형태로 돌려줍니다.
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

function
