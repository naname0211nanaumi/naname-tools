// server/streamtoearn.ts
// streamtoearn.io から TikTok ギフト一覧を取得・パース・キャッシュ

const URL_JP = "https://streamtoearn.io/gifts?region=JP";
const CACHE_PATH = "./data/streamtoearn-cache.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間

export interface Gift {
  name: string;
  imageURL: string;
  coins: number;
}

interface Cache {
  fetchedAt: number;
  gifts: Gift[];
}

// ============================================================
// HTMLパーサ
// ============================================================
// streamtoearn のリスト構造: <img src="...png~tplv-obj.webp" alt="GiftName"> ... コイン数
// 完璧なHTMLパースはせず、画像URLとaltからギフト名/URL、近傍テキストからcoinsを拾う
// ============================================================
function parseGifts(html: string): Gift[] {
  const gifts: Gift[] = [];

  // 画像タグを軸に分割。各画像の直後にコイン数が続く構造
  // <img src="..." alt="Rose"> ... Rose ... 1
  const imgRegex =
    /<img[^>]+src="(https:\/\/p16-webcast\.tiktokcdn\.com[^"]+)"[^>]+alt="([^"]+)"[^>]*>/g;

  const matches: Array<
    { name: string; imageURL: string; index: number }
  > = [];
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(html)) !== null) {
    matches.push({
      imageURL: m[1],
      name: decodeHtmlEntities(m[2].trim()),
      index: m.index,
    });
  }

  // 各imgの後に続くテキスト範囲(次のimgまで)から、最初に出てくる整数をcoins値として採用
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const segment = html.slice(start, end);

    // <img>タグ自体の中身は除外したいので、img終了タグ以降を見る
    const afterImg = segment.replace(/<img[^>]*>/g, "");

    // 数字を探す。streamtoearnは "Rose\n\n1 ![](coin.png)" のような構造
    // タグや属性内の数字を避けるため、「単独の整数」を狙う
    const coinMatch = afterImg.match(/>\s*(\d+)\s*<|\n\s*(\d+)\s*\n|\n\s*(\d+)\s*$/);
    let coins = 0;
    if (coinMatch) {
      coins = parseInt(coinMatch[1] || coinMatch[2] || coinMatch[3] || "0", 10);
    } else {
      // フォールバック: 単純に最初の整数を拾う
      const fallback = afterImg.match(/(\d+)/);
      if (fallback) coins = parseInt(fallback[1], 10);
    }

    if (matches[i].name && matches[i].imageURL) {
      gifts.push({
        name: matches[i].name,
        imageURL: matches[i].imageURL,
        coins,
      });
    }
  }

  // 重複排除（同名+同画像URL）
  const seen = new Set<string>();
  const dedup: Gift[] = [];
  for (const g of gifts) {
    const key = `${g.name}|${g.imageURL}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(g);
    }
  }
  return dedup;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ============================================================
// キャッシュ
// ============================================================
async function loadCache(): Promise<Cache | null> {
  try {
    const text = await Deno.readTextFile(CACHE_PATH);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function saveCache(cache: Cache): Promise<void> {
  await Deno.writeTextFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ============================================================
// 公開関数
// ============================================================
export async function fetchGifts(forceRefresh = false): Promise<Gift[]> {
  if (!forceRefresh) {
    const cache = await loadCache();
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      return cache.gifts;
    }
  }

  console.log("[streamtoearn] fetching...");
  const res = await fetch(URL_JP, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`streamtoearn fetch failed: ${res.status}`);
  }
  const html = await res.text();
  const gifts = parseGifts(html);
  console.log(`[streamtoearn] parsed ${gifts.length} gifts`);

  await saveCache({ fetchedAt: Date.now(), gifts });
  return gifts;
}
