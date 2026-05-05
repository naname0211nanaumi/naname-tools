const PORT = 8788;
const DB_PATH = new URL("../data/sets.json", import.meta.url).pathname;
const PUBLIC_DIR = new URL("../public", import.meta.url).pathname;

type ColorConfig = {
  bg: string;
  text: string;
  border: string;
  borderWidth: number;
};

type GiftMapping = {
  giftName: string;
  giftId?: string;
  giftImageURL: string;
};

type Block = {
  id: string;
  obstacleName: string;
  obstacleType: "obstacle" | "help";
  gift: GiftMapping;
  enabled: boolean;
  bandEnabled: boolean;
  bandText: string;
  imageScale: number;
  colorOverride?: {
    bg?: string;
    text?: string;
    border?: string;
    borderWidth?: number;
  };
};

type ObstacleSet = {
  id: string;
  name: string;
  title: string;
  subtitle: string;
  winCounterLabel: string;
  winCount: number;
  winCounterUnit: string;
  currentWinLabel: string;
  currentWin: number;
  layoutColumns: number;
  obstacleColor: ColorConfig;
  helpColor: ColorConfig;
  blocks: Block[];
};

type DB = {
  activeSetId: string;
  slideIntervalSec: number;
  sets: ObstacleSet[];
};

const DEFAULT_OBSTACLE_COLOR: ColorConfig = {
  bg: "#a5dcef",
  text: "#ffffff",
  border: "#ffffff",
  borderWidth: 3,
};

const DEFAULT_HELP_COLOR: ColorConfig = {
  bg: "#fcd9e0",
  text: "#ffffff",
  border: "#ffffff",
  borderWidth: 3,
};

let db: DB = { activeSetId: "", slideIntervalSec: 3, sets: [] };

async function loadDB(): Promise<void> {
  try {
    const text = await Deno.readTextFile(DB_PATH);
    db = JSON.parse(text) as DB;
    if (!db.slideIntervalSec) db.slideIntervalSec = 3;
    for (const set of db.sets) {
      if (!set.obstacleColor) set.obstacleColor = { ...DEFAULT_OBSTACLE_COLOR };
      if (!set.helpColor) set.helpColor = { ...DEFAULT_HELP_COLOR };
    }
  } catch {
    console.log("[DB] sets.json not found, using defaults");
  }
}

async function saveDB(): Promise<void> {
  await Deno.writeTextFile(DB_PATH, JSON.stringify(db, null, 2));
}

const clients = new Set<WebSocket>();

function broadcast(msg: unknown): void {
  const json = JSON.stringify(msg);
  for (const ws of clients) {
    try {
      ws.send(json);
    } catch {
      clients.delete(ws);
    }
  }
}

function getActiveSet(): ObstacleSet | undefined {
  return db.sets.find((s) => s.id === db.activeSetId);
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

async function serveStatic(filePath: string): Promise<Response> {
  try {
    const data = await Deno.readFile(`${PUBLIC_DIR}/${filePath}`);
    return new Response(data, {
      headers: { "content-type": getContentType(filePath) },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

await loadDB();
log(`Starting obstacle-table server on port ${PORT}`);

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  // ===== WebSocket =====
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      clients.add(socket);
      log(`[WS] open clients=${clients.size}`);
      try {
        socket.send(JSON.stringify({ type: "set_updated", data: db }));
      } catch {
        clients.delete(socket);
      }
    };
    socket.onmessage = () => {};
    socket.onclose = () => {
      clients.delete(socket);
      log(`[WS] close`);
    };
    socket.onerror = () => clients.delete(socket);
    return response;
  }

  // ===== API: DB取得 =====
  if (url.pathname === "/api/db" && req.method === "GET") {
    return new Response(JSON.stringify(db), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // ===== API: DB保存 =====
  if (url.pathname === "/api/db" && req.method === "POST") {
    const text = await req.text();
    const newDB = safeJsonParse(text) as unknown as DB | null;
    if (!newDB || !Array.isArray(newDB.sets)) {
      return new Response("Bad Request", { status: 400 });
    }
    db = newDB;
    if (!db.slideIntervalSec) db.slideIntervalSec = 3;
    await saveDB();
    broadcast({ type: "set_updated", data: db });
    log("[API] DB saved and broadcasted");
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // ===== TikFinity Webhook =====
  if (url.pathname === "/webhook" && req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      const text = await req.text();
      body = safeJsonParse(text) ??
        Object.fromEntries(new URLSearchParams(text).entries());
    } catch { /* ignore */ }

    const giftName = String(body.giftName ?? "").trim();
    if (giftName) {
      const activeSet = getActiveSet();
      if (activeSet) {
        const block = activeSet.blocks.find(
          (b) => b.enabled && b.gift.giftName === giftName,
        );
        if (block) {
          if (!block.gift.giftId && body.giftId) {
            block.gift.giftId = String(body.giftId);
            await saveDB();
          }
          broadcast({ type: "gift_received", blockId: block.id, giftName });
          log(`[WEBHOOK] gift_received: ${giftName} → block ${block.id}`);
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // ===== 静的ファイル =====
  if (url.pathname === "/" || url.pathname === "/overlay") {
    return serveStatic("overlay.html");
  }
  if (url.pathname === "/admin") {
    return serveStatic("admin.html");
  }

  const filePath = url.pathname.replace(/^\//, "");
  if (filePath) return serveStatic(filePath);

  return new Response("Not Found", { status: 404 });
});
