const cache = new Map<string, string>();

export async function fetchGiftImageURL(giftName: string): Promise<string> {
  if (cache.has(giftName)) return cache.get(giftName)!;

  try {
    const url = `https://www.streamtoearn.com/tiktok-gifts?q=${encodeURIComponent(giftName)}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return "";

    const html = await resp.text();
    // TikTok CDN image URLを探す
    const match = html.match(
      /https:\/\/[a-z0-9-]+\.tiktokcdn\.com\/[^\s"'<>]+\.(?:jpg|png|webp|gif)[^\s"'<>]*/i,
    );
    const imageURL = match?.[0] ?? "";
    if (imageURL) cache.set(giftName, imageURL);
    return imageURL;
  } catch {
    return "";
  }
}
