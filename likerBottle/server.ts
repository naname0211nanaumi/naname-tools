/**
 * server.ts
 * TikFinity互換重視 + エンドロール集計対応
 *
 * 起動:
 *   deno run --allow-net server.ts
 */

const PORT = 3000;

const clients = new Set<WebSocket>();

type LikeUser = {
  name: string;
  likes: number;
};

type GiftUser = {
  name: string;
  coins: number;
  giftCount: number;
  gifts: Record<string, number>;
};

const bottleState = {
  likes: 0,
  goal: 1000,
  liquidColor: { top: "#5082d2", bottom: "#0d2370" },
  glassColor: "blue",
  bottleShape: "standard",
  floatItems: ["gem", "star"],
};

const sessionState = {
  totalLikes: 0,
  totalGiftCoins: 0,
  likesByUser: new Map<string, LikeUser>(),
  giftsByUser: new Map<string, GiftUser>(),
};

// 参考値として保持
let lastTotalLikeCount = 0;

function log(message: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] ${message}`, ...args);
}

function broadcast(msg: unknown) {
  const json = JSON.stringify(msg);
  for (const ws of clients) {
    try {
      ws.send(json);
    } catch {
      clients.delete(ws);
    }
  }
}

function toPosInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseFormBody(text: string): Record<string, string> {
  const params = new URLSearchParams(text);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function buildEndrollData() {
  const allGifters = [...sessionState.giftsByUser.values()]
    .map((u) => ({
      name: u.name,
      coins: u.coins,
      giftCount: u.giftCount,
      gifts: u.gifts,
    }))
    .sort((a, b) => {
      if (b.coins !== a.coins) return b.coins - a.coins;
      if (b.giftCount !== a.giftCount) return b.giftCount - a.giftCount;
      return a.name.localeCompare(b.name, "ja");
    });

  const allLikers = [...sessionState.likesByUser.values()]
    .map((u) => ({
      name: u.name,
      likes: u.likes,
    }))
    .sort((a, b) => {
      if (b.likes !== a.likes) return b.likes - a.likes;
      return a.name.localeCompare(b.name, "ja");
    });

  return {
    summary: {
      totalLikes: sessionState.totalLikes,
      totalGiftCoins: sessionState.totalGiftCoins,
      likerCount: allLikers.length,
      gifterCount: allGifters.length,
    },
    allGifters,
    allLikers,
  };
}

function addAnonymousLikes(count: number) {
  const safeCount = Math.max(1, toPosInt(count, 1));

  bottleState.likes += safeCount;
  sessionState.totalLikes += safeCount;

  log(
    `[LIKE] anonymous +${safeCount} bottleLikes=${bottleState.likes} totalLikes=${sessionState.totalLikes}`,
  );

  broadcast({ type: "add_likes", value: safeCount });
}

function addNamedLikes(name: string, count: number) {
  const safeName = pickString(name, "Unknown");
  const safeCount = Math.max(1, toPosInt(count, 1));

  const current = sessionState.likesByUser.get(safeName);
  if (current) {
    current.likes += safeCount;
  } else {
    sessionState.likesByUser.set(safeName, {
      name: safeName,
      likes: safeCount,
    });
  }

  bottleState.likes += safeCount;
  sessionState.totalLikes += safeCount;

  log(
    `[LIKE] ${safeName} +${safeCount} bottleLikes=${bottleState.likes} totalLikes=${sessionState.totalLikes}`,
  );

  broadcast({ type: "add_likes", value: safeCount });
}

function addGift(name: string, giftName: string, coins: number, giftCount: number) {
  const safeName = pickString(name, "Unknown");
  const safeGiftName = pickString(giftName, "Unknown Gift");
  const safeCoins = Math.max(0, toPosInt(coins, 0));
  const safeGiftCount = Math.max(1, toPosInt(giftCount, 1));

  const current = sessionState.giftsByUser.get(safeName);

  if (current) {
    current.coins += safeCoins;
    current.giftCount += safeGiftCount;
    current.gifts[safeGiftName] = (current.gifts[safeGiftName] || 0) + safeGiftCount;
  } else {
    sessionState.giftsByUser.set(safeName, {
      name: safeName,
      coins: safeCoins,
      giftCount: safeGiftCount,
      gifts: {
        [safeGiftName]: safeGiftCount,
      },
    });
  }

  sessionState.totalGiftCoins += safeCoins;

  log(
    `[GIFT] ${safeName} ${safeGiftName} x${safeGiftCount} +${safeCoins} coins totalGiftCoins=${sessionState.totalGiftCoins}`,
  );
}

function resetSession() {
  bottleState.likes = 0;
  sessionState.totalLikes = 0;
  sessionState.totalGiftCoins = 0;
  sessionState.likesByUser.clear();
  sessionState.giftsByUser.clear();
  lastTotalLikeCount = 0;

  log("[SESSION] reset");

  broadcast({ type: "reset" });
  broadcast({ type: "session_reset" });
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  // ===== WebSocket =====
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.onopen = () => {
      clients.add(socket);
      log(`[WS] open clients=${clients.size}`);

      try {
        socket.send(JSON.stringify({
          type: "state",
          data: {
            ...bottleState,
            endrollData: buildEndrollData(),
          },
        }));
      } catch {
        clients.delete(socket);
      }
    };

    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "{}");

        switch (msg.type) {
          case "show_endroll":
            broadcast({ type: "start_endroll", data: buildEndrollData() });
            log("[WS] show_endroll");
            break;

          case "stop_endroll":
            broadcast({ type: "stop_endroll" });
            log("[WS] stop_endroll");
            break;

          case "reset_session":
            resetSession();
            break;

          case "get_endroll_data":
            socket.send(JSON.stringify({
              type: "endroll_data",
              data: buildEndrollData(),
            }));
            break;

          case "set_goal":
            bottleState.goal = Math.max(1, toPosInt(msg.value, 1000));
            broadcast({ type: "set_goal", value: bottleState.goal });
            break;

          case "add_likes": {
            const add = Math.max(0, toPosInt(msg.value, 0));
            if (add > 0) {
              bottleState.likes += add;
              sessionState.totalLikes += add;
              broadcast({ type: "add_likes", value: add });
              log(`[WS] add_likes +${add} bottleLikes=${bottleState.likes} totalLikes=${sessionState.totalLikes}`);
            }
            break;
          }

          case "set_likes": {
            const nextLikes = Math.max(0, toPosInt(msg.value, 0));
            const diff = nextLikes - bottleState.likes;

            bottleState.likes = nextLikes;
            if (diff > 0) {
              sessionState.totalLikes += diff;
            }

            broadcast({ type: "set_likes", value: bottleState.likes });
            break;
          }

          case "reset":
            bottleState.likes = 0;
            lastTotalLikeCount = 0;
            broadcast({ type: "reset" });
            break;

          case "set_liquid_color":
            if (msg.value && typeof msg.value === "object") {
              bottleState.liquidColor = msg.value;
              broadcast({ type: "set_liquid_color", value: bottleState.liquidColor });
            }
            break;

          case "set_glass_color":
            bottleState.glassColor = String(msg.value);
            broadcast({ type: "set_glass_color", value: bottleState.glassColor });
            break;

          case "set_bottle_shape":
            bottleState.bottleShape = String(msg.value);
            broadcast({ type: "set_bottle_shape", value: bottleState.bottleShape });
            break;

          case "set_float_items":
            if (Array.isArray(msg.value)) {
              bottleState.floatItems = msg.value.map(String);
              broadcast({ type: "set_float_items", value: bottleState.floatItems });
            }
            break;
        }
      } catch (e) {
        log("[WS] message parse error", e);
      }
    };

    socket.onclose = () => {
      clients.delete(socket);
      log(`[WS] close clients=${clients.size}`);
    };

    socket.onerror = () => {
      clients.delete(socket);
      log(`[WS] error clients=${clients.size}`);
    };

    return response;
  }

  // ===== Like =====
  if (url.pathname === "/like") {
    log(`[LIKE HIT] method=${req.method} ${url.pathname}${url.search}`);

    if (req.method === "OPTIONS") {
      return new Response("ok", { status: 200 });
    }

    let count = 0;
    let name = pickString(
      url.searchParams.get("name"),
      url.searchParams.get("nickname"),
      url.searchParams.get("username"),
    );

    // 手動テスト用
    const queryLikeCount = toPosInt(url.searchParams.get("count"), 0);
    if (queryLikeCount > 0) {
      count = queryLikeCount;
    }

    if (req.method === "POST") {
      const raw = await req.text();
      log("[LIKE BODY RAW]", raw);

      const contentType = req.headers.get("content-type") ?? "";
      let body: Record<string, unknown> | null = null;

      if (contentType.includes("application/json")) {
        body = safeJsonParse(raw);
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        body = parseFormBody(raw);
      } else {
        body = safeJsonParse(raw) ?? parseFormBody(raw);
      }

      if (body) {
        name = pickString(name, body.name, body.nickname, body.username);

        const bodyTotalLikeCount = toPosInt(body.totalLikeCount, 0);
        if (bodyTotalLikeCount > 0) {
          log(`[LIKE META] totalLikeCount=${bodyTotalLikeCount}`);
          lastTotalLikeCount = bodyTotalLikeCount;
        }

        // likeCount / count / likes のいずれかを読む。なければ1
        const bodyLikeCount = toPosInt(
          body.likeCount ?? body.count ?? body.likes,
          0,
        );
        count = bodyLikeCount > 0 ? bodyLikeCount : 1;
      }
    }

    if (count <= 0) {
      return new Response(JSON.stringify({
        ok: true,
        source: "like",
        method: req.method,
        added: 0,
        skipped: true,
        bottleLikes: bottleState.likes,
        endrollData: buildEndrollData(),
      }, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (name) {
      addNamedLikes(name, count);
    } else {
      addAnonymousLikes(count);
    }

    return new Response(JSON.stringify({
      ok: true,
      source: "like",
      method: req.method,
      added: count,
      name: name || null,
      bottleLikes: bottleState.likes,
      lastTotalLikeCount,
      endrollData: buildEndrollData(),
    }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // ===== Gift =====
  if (req.method === "GET" && url.pathname === "/gift") {
    const name = pickString(
      url.searchParams.get("name"),
      url.searchParams.get("nickname"),
      url.searchParams.get("username"),
      "Unknown",
    );
    const giftName = pickString(url.searchParams.get("giftName"), "Unknown Gift");
    const coins = Math.max(0, toPosInt(url.searchParams.get("coins"), 0));
    // TikFinity は repeatCount, 手動テスト用に giftCount も受け付ける
    const giftCount = Math.max(1, toPosInt(
      url.searchParams.get("repeatCount") ?? url.searchParams.get("giftCount"),
      1,
    ));

    addGift(name, giftName, coins, giftCount);

    return new Response(JSON.stringify({
      ok: true,
      source: "gift",
      name,
      giftName,
      coins,
      giftCount,
      endrollData: buildEndrollData(),
    }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // ===== Endroll =====
  if (req.method === "GET" && url.pathname === "/endroll/start") {
    const data = buildEndrollData();
    broadcast({ type: "endroll_data", data });
    broadcast({ type: "start_endroll", data });
    log("[ENDROLL] start");
    return new Response("ok");
  }

  if (req.method === "GET" && url.pathname === "/endroll/stop") {
    broadcast({ type: "stop_endroll" });
    log("[ENDROLL] stop");
    return new Response("ok");
  }

  // ===== Reset =====
  if (req.method === "GET" && url.pathname === "/session/reset") {
    resetSession();
    return new Response("ok");
  }

  // ===== Status =====
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
    return new Response(JSON.stringify({
      ok: true,
      clients: clients.size,
      bottleState,
      lastTotalLikeCount,
      endrollData: buildEndrollData(),
    }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  log(`[HTTP] 404 ${req.method} ${url.pathname}`);
  return new Response("Not Found", { status: 404 });
});

console.log(`✓ server running on http://localhost:${PORT}`);
console.log(`  ws               ws://localhost:${PORT}`);
console.log(`  status           http://localhost:${PORT}/status`);
console.log(`  like             http://localhost:${PORT}/like`);
console.log(`  gift             http://localhost:${PORT}/gift?name=test&giftName=Rose&coins=3&giftCount=3`);
console.log(`  start endroll    http://localhost:${PORT}/endroll/start`);
console.log(`  stop endroll     http://localhost:${PORT}/endroll/stop`);
console.log(`  reset session    http://localhost:${PORT}/session/reset`);