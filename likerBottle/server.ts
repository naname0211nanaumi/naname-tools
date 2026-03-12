/**
 * Liker Bottle – server.ts (Deno)
 * 役割:
 *   1. TikFinityからのいいねイベントを受信 (GET/POST /like)
 *   2. source.html / controller.html と WebSocket で通信
 *   3. コントローラーからの操作コマンドをsourceに転送
 *
 * 起動:
 *   deno run --allow-net server.ts
 *
 * ポート:
 *   3000
 */

const PORT = 3000;

// 接続中のWebSocketクライアント管理
const clients = new Set<WebSocket>();

// 現在の状態
const state = {
  likes: 0,
  goal: 1000,
  liquidColor: { top: "#5082d2", bottom: "#0d2370" },
  glassColor: "blue",
  bottleShape: "standard",
  floatItems: ["gem", "star"],
};

// 全クライアントにブロードキャスト
function broadcast(msg: unknown) {
  const json = JSON.stringify(msg);

  for (const ws of clients) {
    try {
      ws.send(json);
    } catch (err) {
      console.warn("[WS] send failed. removing client.", err);
      clients.delete(ws);
    }
  }
}

// 接続中クライアント数をログ
function logClients() {
  console.log(`[WS] clients: ${clients.size}`);
}

// 安全にJSONパース
function safeParseJson(text: string): Record<string, unknown> | null {
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

// いいね数抽出
function extractLikeCountFromBody(body: Record<string, unknown> | null): number {
  if (!body) return 1;

  const candidates = [
    body.likeCount,
    body.count,
    body.likes,
    body.totalLikes,
    body.totalLikeCount,
    body.value,
  ];

  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }

  return 1;
}

// いいねを追加して通知
function addLikes(count: number, source: string) {
  const safeCount = Math.max(1, Math.floor(Number(count) || 1));
  state.likes += safeCount;

  console.log(`[LIKE] source=${source} add=${safeCount} total=${state.likes}`);

  broadcast({ type: "add_likes", value: safeCount });
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  // ===== WebSocket アップグレード =====
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.onopen = () => {
      clients.add(socket);
      logClients();

      try {
        socket.send(JSON.stringify({ type: "state", data: state }));
      } catch (err) {
        console.warn("[WS] failed to send initial state", err);
      }
    };

    socket.onmessage = (ev) => {
      let msg: Record<string, unknown> | null = null;

      if (typeof ev.data === "string") {
        msg = safeParseJson(ev.data);
      }

      if (!msg) {
        console.warn("[WS] invalid message:", ev.data);
        return;
      }

      switch (msg.type) {
        case "set_likes":
          state.likes = Math.max(0, Number(msg.value) || 0);
          console.log(`[CTRL] set_likes -> ${state.likes}`);
          broadcast({ type: "set_likes", value: state.likes });
          break;

        case "add_likes": {
          const count = Math.max(0, Number(msg.value) || 0);
          state.likes += count;
          console.log(`[CTRL] add_likes -> +${count} total=${state.likes}`);
          broadcast({ type: "add_likes", value: count });
          break;
        }

        case "set_goal":
          state.goal = Math.max(1, Number(msg.value) || 1000);
          console.log(`[CTRL] set_goal -> ${state.goal}`);
          broadcast({ type: "set_goal", value: state.goal });
          break;

        case "reset":
          state.likes = 0;
          console.log("[CTRL] reset");
          broadcast({ type: "reset" });
          break;

        case "set_liquid_color":
          if (
            msg.value &&
            typeof msg.value === "object" &&
            "top" in msg.value &&
            "bottom" in msg.value
          ) {
            state.liquidColor = msg.value as typeof state.liquidColor;
            console.log("[CTRL] set_liquid_color ->", state.liquidColor);
            broadcast({ type: "set_liquid_color", value: state.liquidColor });
          }
          break;

        case "set_glass_color":
          state.glassColor = String(msg.value);
          console.log(`[CTRL] set_glass_color -> ${state.glassColor}`);
          broadcast({ type: "set_glass_color", value: state.glassColor });
          break;

        case "set_bottle_shape":
          state.bottleShape = String(msg.value);
          console.log(`[CTRL] set_bottle_shape -> ${state.bottleShape}`);
          broadcast({ type: "set_bottle_shape", value: state.bottleShape });
          break;

        case "set_float_items":
          if (Array.isArray(msg.value)) {
            state.floatItems = msg.value.map(String);
            console.log("[CTRL] set_float_items ->", state.floatItems);
            broadcast({ type: "set_float_items", value: state.floatItems });
          }
          break;

        default:
          console.warn("[WS] unknown message type:", msg.type);
          break;
      }
    };

    socket.onclose = () => {
      clients.delete(socket);
      logClients();
    };

    socket.onerror = (err) => {
      console.warn("[WS] socket error:", err);
      clients.delete(socket);
      logClients();
    };

    return response;
  }

  // ===== TikFinity Webhook / URL Trigger =====
  // URLのみ設定可能なケースを考慮して GET / POST 両対応
  if (url.pathname === "/like") {
    console.log(`\n[LIKE] hit method=${req.method} path=${url.pathname}${url.search}`);

    let count = 1;

    // 1. URLクエリ優先
    // 例: /like?count=5
    const qpCount = Number(url.searchParams.get("count"));
    if (Number.isFinite(qpCount) && qpCount > 0) {
      count = qpCount;
      addLikes(count, "query");
      return new Response(
        JSON.stringify({ ok: true, source: "query", added: count, total: state.likes }, null, 2),
        { headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }

    // 2. POST body から取得
    if (req.method === "POST") {
      const raw = await req.text();
      console.log("[LIKE] raw body:", raw);

      const body = safeParseJson(raw);
      count = extractLikeCountFromBody(body);

      addLikes(count, "post_body");

      return new Response(
        JSON.stringify({ ok: true, source: "post_body", added: count, total: state.likes }, null, 2),
        { headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }

    // 3. GETでクエリ無しなら 1 加算
    addLikes(1, "plain_get");

    return new Response(
      JSON.stringify({ ok: true, source: "plain_get", added: 1, total: state.likes }, null, 2),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  // ===== ステータス確認 =====
  if (req.method === "GET" && url.pathname === "/") {
    return new Response(
      JSON.stringify(
        {
          status: "running",
          clients: clients.size,
          state,
        },
        null,
        2,
      ),
      {
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  console.warn(`[HTTP] ${req.method} ${url.pathname} -> 404`);
  return new Response("Not Found", { status: 404 });
});

console.log(`✓ Liker Bottle server running on ws://localhost:${PORT}`);
console.log(`  TikFinity trigger:  http://localhost:${PORT}/like`);
console.log(`  Status:             http://localhost:${PORT}/`);