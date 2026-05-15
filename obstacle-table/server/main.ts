// server/main.ts
// 妨害表ツール - サーバー本体

import { fetchGifts } from "./streamtoearn.ts";

const PORT = 8788;
const DATA_PATH = "./data/sets.json";

// ============================================================
// 型定義
// ============================================================
interface ColorConfig {
  bg: string;
  text: string;
  border: string;
  borderWidth: number;
}

interface GiftMapping {
  giftName: string;
  giftId?: string;
  giftImageURL: string;
}

interface Block {
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
  bandColor?: {
    bg: string;
    text: string;
  };
}

interface ObstacleSet {
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
}

interface Topic {
  id: string;
  text: string;
  done: boolean;
  active: boolean;
  createdAt: number;
}

interface Memo {
  text: string;
  visible: boolean;
}

interface DB {
  activeSetId: string;
  slideIntervalSec: number;
  overlayView: "obstacle" | "topics";
  topics: Topic[];
  memo: Memo;
  sets: ObstacleSet[];
}

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

// ============================================================
// データ層
// ============================================================
async function loadDB(): Promise<DB> {
  const text = await Deno.readTextFile(DATA_PATH);
  const db = JSON.parse(text) as DB;
  // 既存データへのマイグレーション
  if (!db.slideIntervalSec) db.slideIntervalSec = 3;
  if (!db.overlayView) db.overlayView = "obstacle";
  if (!db.topics) db.topics = [];
  if (!db.memo) db.memo = { text: "", visible: false };
  for (const set of db.sets) {
    if (!set.obstacleColor) set.obstacleColor = { ...DEFAULT_OBSTACLE_COLOR };
    if (!set.helpColor) set.helpColor = { ...DEFAULT_HELP_COLOR };
  }
  return db;
}

async function saveDB(db: DB): Promise<void> {
  await Deno.writeTextFile(DATA_PATH, JSON.stringify(db, null, 2));
}

// ============================================================
// WebSocket
// ============================================================
const sockets = new Set<WebSocket>();

function broadcast(message: unknown): void {
  const text = JSON.stringify(message);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(text);
    }
  }
}

// ============================================================
// ルーティング
// ============================================================
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // WebSocket
  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => sockets.add(socket);
    socket.onclose = () => sockets.delete(socket);
    socket.onerror = () => sockets.delete(socket);
    return response;
  }

  // ===== Webhook =====
  if (path === "/webhook" && req.method === "POST") {
    return await handleWebhook(req);
  }

  // ===== API: アクティブセット取得（slideIntervalSec含む） =====
  if (path === "/api/active-set" && req.method === "GET") {
    const db = await loadDB();
    const set = db.sets.find((s) => s.id === db.activeSetId);
    if (!set) return new Response("Active set not found", { status: 404 });
    return Response.json({ ...set, slideIntervalSec: db.slideIntervalSec });
  }

  // ===== API: 全セット取得 =====
  if (path === "/api/sets" && req.method === "GET") {
    const db = await loadDB();
    return Response.json(db);
  }

  // ===== API: DB全体保存（admin保存ボタン） =====
  if (path === "/api/sets" && req.method === "POST") {
    const incoming = await req.json() as DB;
    await saveDB(incoming);

    // overlayへアクティブセット変更を配信（slideIntervalSec付き）
    const activeSet = incoming.sets.find((s) => s.id === incoming.activeSetId);
    broadcast({
      type: "set_updated",
      data: activeSet,
      slideIntervalSec: incoming.slideIntervalSec ?? 3,
    });

    return Response.json({ ok: true });
  }

  // ===== API: トピック一覧取得 =====
  if (path === "/api/topics" && req.method === "GET") {
    const db = await loadDB();
    return Response.json({ topics: db.topics, overlayView: db.overlayView });
  }

  // ===== API: トピック追加 =====
  if (path === "/api/topics" && req.method === "POST") {
    const { text } = await req.json() as { text: string };
    if (!text?.trim()) return Response.json({ ok: false, reason: "empty text" });
    const db = await loadDB();
    const topic: Topic = {
      id: `topic_${Date.now()}`,
      text: text.trim(),
      done: false,
      active: false,
      createdAt: Date.now(),
    };
    db.topics.push(topic);
    await saveDB(db);
    broadcast({ type: "topics_updated", topics: db.topics });
    return Response.json({ ok: true, topic });
  }

  // ===== API: トピック更新（done / active 切替） =====
  if (path.startsWith("/api/topics/") && req.method === "PATCH") {
    const id = path.split("/api/topics/")[1];
    const patch = await req.json() as { done?: boolean; active?: boolean };
    const db = await loadDB();
    const topic = db.topics.find((t) => t.id === id);
    if (!topic) return Response.json({ ok: false, reason: "not found" }, { status: 404 });
    if (patch.done !== undefined) topic.done = patch.done;
    if (patch.active !== undefined) {
      // active は同時に1つだけ
      if (patch.active) db.topics.forEach((t) => { t.active = t.id === id; });
      else topic.active = false;
    }
    await saveDB(db);
    broadcast({ type: "topics_updated", topics: db.topics });
    return Response.json({ ok: true });
  }

  // ===== API: トピック削除 =====
  if (path.startsWith("/api/topics/") && req.method === "DELETE") {
    const id = path.split("/api/topics/")[1];
    const db = await loadDB();
    db.topics = db.topics.filter((t) => t.id !== id);
    await saveDB(db);
    broadcast({ type: "topics_updated", topics: db.topics });
    return Response.json({ ok: true });
  }

  // ===== API: メモ取得 =====
  if (path === "/api/memo" && req.method === "GET") {
    const db = await loadDB();
    return Response.json(db.memo);
  }

  // ===== API: メモ更新 =====
  if (path === "/api/memo" && req.method === "POST") {
    const patch = await req.json() as Partial<Memo>;
    const db = await loadDB();
    if (patch.text !== undefined) db.memo.text = patch.text;
    if (patch.visible !== undefined) db.memo.visible = patch.visible;
    await saveDB(db);
    broadcast({ type: "memo_updated", memo: db.memo });
    return Response.json({ ok: true });
  }

  // ===== API: オーバーレイ表示切替 =====
  if (path === "/api/overlay-view" && req.method === "POST") {
    const { view } = await req.json() as { view: "obstacle" | "topics" };
    const db = await loadDB();
    db.overlayView = view;
    await saveDB(db);
    broadcast({ type: "overlay_view", view });
    return Response.json({ ok: true });
  }

  // ===== API: streamtoearn ギフト一覧 =====
  if (path === "/api/gifts" && req.method === "GET") {
    const force = url.searchParams.get("refresh") === "1";
    try {
      const gifts = await fetchGifts(force);
      return Response.json({ gifts });
    } catch (e) {
      return Response.json(
        { error: String(e), gifts: [] },
        { status: 500 },
      );
    }
  }

  // ===== API: local assets images =====
  if (path === "/api/local-images" && req.method === "GET") {
    try {
      const images = [];
      for await (const entry of Deno.readDir("./assets/images")) {
        if (!entry.isFile) continue;
        const name = entry.name;
        const ext = name.split(".").pop()?.toLowerCase();
        if (!ext || !["png", "jpg", "jpeg", "gif", "svg"].includes(ext)) continue;
        images.push({
          name,
          imageURL: `/assets/images/${encodeURIComponent(name)}`,
        });
      }
      return Response.json({ images });
    } catch (e) {
      return Response.json({ images: [], error: String(e) }, { status: 500 });
    }
  }

  // ===== 静的ファイル =====
  if (path === "/" || path === "/overlay") {
    return await serveFile("./public/overlay.html", "text/html");
  }
  if (path === "/admin") {
    return await serveFile("./public/admin.html", "text/html");
  }

  if (path.startsWith("/assets/")) {
    return await serveAsset(path);
  }

  return new Response("Not Found", { status: 404 });
}

async function serveAsset(path: string): Promise<Response> {
  const decoded = decodeURIComponent(path);
  if (!decoded.startsWith("/assets/")) {
    return new Response("Forbidden", { status: 403 });
  }
  const filePath = `.${decoded}`;
  if (filePath.includes("..")) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const data = await Deno.readFile(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase();
    const contentType = ext === "svg" ? "image/svg+xml"
      : ext === "png" ? "image/png"
      : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "gif" ? "image/gif"
      : "application/octet-stream";
    return new Response(data, {
      headers: { "content-type": contentType },
    });
  } catch {
    return new Response("File not found", { status: 404 });
  }
}

async function serveFile(
  path: string,
  contentType: string,
): Promise<Response> {
  try {
    const content = await Deno.readTextFile(path);
    return new Response(content, {
      headers: { "content-type": `${contentType}; charset=utf-8` },
    });
  } catch {
    return new Response("File not found", { status: 404 });
  }
}

// ============================================================
// TikFinity Webhook
// ============================================================
interface TikFinityPayload {
  event?: string;
  data?: {
    giftId?: number | string;
    giftName?: string;
    diamondCount?: number;
    repeatCount?: number;
    repeatEnd?: boolean;
    user?: {
      nickname?: string;
      uniqueId?: string;
    };
  };
  // 直フィールド版
  giftId?: number | string;
  giftName?: string;
  diamondCount?: number;
}

async function handleWebhook(req: Request): Promise<Response> {
  try {
    const payload = await req.json() as TikFinityPayload;
    const giftId = String(payload.data?.giftId ?? payload.giftId ?? "");
    const giftName = payload.data?.giftName ?? payload.giftName ?? "";
    const diamonds = payload.data?.diamondCount ?? payload.diamondCount ?? 0;
    const userName = payload.data?.user?.nickname ?? "anonymous";

    if (!giftName) {
      return Response.json({ ok: false, reason: "no giftName" });
    }

    const db = await loadDB();
    const activeSet = db.sets.find((s) => s.id === db.activeSetId);
    if (!activeSet) {
      return Response.json({ ok: false, reason: "no active set" });
    }

    const block = activeSet.blocks.find(
      (b) => b.enabled && b.gift.giftName === giftName,
    );

    // giftIdの自動補完（初回受信時）
    if (block && giftId && !block.gift.giftId) {
      block.gift.giftId = giftId;
      await saveDB(db);
      console.log(
        `[gift-id-bound] ${giftName} → giftId=${giftId} (auto-saved)`,
      );
    }

    if (block) {
      broadcast({
        type: "gift_received",
        blockId: block.id,
        giftName,
        giftId,
        diamonds,
        userName,
        obstacleName: block.obstacleName,
        obstacleType: block.obstacleType,
        timestamp: Date.now(),
      });
      console.log(
        `[GIFT] ${userName} → ${giftName}(${diamonds}💎) → ${block.obstacleName}`,
      );
    } else {
      console.log(
        `[GIFT-UNMAPPED] ${userName} → ${giftName}(id:${giftId}, ${diamonds}💎)`,
      );
    }

    return Response.json({ ok: true });
  } catch (e) {
    console.error("Webhook error:", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

// ============================================================
// 起動
// ============================================================
console.log(`妨害表ツール起動: http://localhost:${PORT}`);
console.log(`  Overlay: http://localhost:${PORT}/overlay`);
console.log(`  Admin:   http://localhost:${PORT}/admin`);
console.log(`  Webhook: http://localhost:${PORT}/webhook`);

Deno.serve({ port: PORT }, handler);
