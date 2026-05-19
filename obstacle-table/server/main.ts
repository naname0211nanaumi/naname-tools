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
  if (path === "/webhook/like" && req.method === "POST") {
    return await handleLikeWebhook(req);
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
    const incoming = await req.json() as Partial<DB>;
    const db = await loadDB();
    // sets/activeSetId/slideIntervalSec のみ更新。topics/memo/overlayViewは保持
    if (incoming.sets !== undefined) db.sets = incoming.sets;
    if (incoming.activeSetId !== undefined) db.activeSetId = incoming.activeSetId;
    if (incoming.slideIntervalSec !== undefined) db.slideIntervalSec = incoming.slideIntervalSec;
    await saveDB(db);

    // overlayへアクティブセット変更を配信（slideIntervalSec付き）
    const activeSet = db.sets.find((s) => s.id === db.activeSetId);
    broadcast({
      type: "set_updated",
      data: activeSet,
      slideIntervalSec: db.slideIntervalSec ?? 3,
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

  // ===== スタンプカード =====
  if (path === "/stamp-card") {
    return await serveFile("./public/stamp-card.html", "text/html");
  }
  if (path === "/api/stamp-card/settings" && req.method === "GET") {
    const sc = await loadStampDB();
    return Response.json(sc.settings);
  }
  if (path === "/api/stamp-card/settings" && req.method === "POST") {
    const settings = await req.json() as StampCardSettings;
    const sc = await loadStampDB();
    sc.settings = settings;
    await saveStampDB(sc);
    broadcast({ type: "stamp_settings_updated", settings });
    return Response.json({ ok: true });
  }
  if (path === "/api/stamp-card/today" && req.method === "GET") {
    const sc = await loadStampDB();
    const today = todayStr();
    const entries = sc.entries.filter((e) => e.date === today);
    const maxCards = sc.settings.gridCols * sc.settings.gridRows;
    return Response.json({ entries, count: entries.length, maxCards, complete: entries.length >= maxCards });
  }
  if (path === "/api/stamp-card/stats" && req.method === "GET") {
    const sc = await loadStampDB();
    const daily: { date: string; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const s = dateStr(d);
      daily.push({ date: s, count: sc.entries.filter((e) => e.date === s).length });
    }
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const calendar: { date: string; count: number }[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const s = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      calendar.push({ date: s, count: sc.entries.filter((e) => e.date === s).length });
    }
    return Response.json({ daily, calendar });
  }
  if (path === "/api/stamp-card/rankings" && req.method === "GET") {
    const sc = await loadStampDB();
    const now = new Date();
    const monthPfx = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const userNick = new Map<string, string>();
    for (const e of sc.entries) userNick.set(e.uniqueId, e.nickname);

    const countBy = (entries: StampEntry[]) => {
      const m = new Map<string, number>();
      for (const e of entries) m.set(e.uniqueId, (m.get(e.uniqueId) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([uid, count]) => ({ uniqueId: uid, nickname: userNick.get(uid) ?? uid, count }));
    };
    const streaks = calcStreaks(sc.entries);
    const toSRanking = (key: "current" | "max") =>
      [...streaks.entries()].sort((a, b) => b[1][key] - a[1][key]).slice(0, 20)
        .map(([uid, s]) => ({ uniqueId: uid, nickname: userNick.get(uid) ?? uid, count: s[key] }));

    return Response.json({
      monthly: countBy(sc.entries.filter((e) => e.date.startsWith(monthPfx))),
      cumulative: countBy(sc.entries),
      currentStreak: toSRanking("current"),
      maxStreak: toSRanking("max"),
    });
  }
  if (path === "/api/stamp-card/participants" && req.method === "GET") {
    const sc = await loadStampDB();
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    const dateF = url.searchParams.get("date") ?? "";
    let results = [...sc.entries].sort((a, b) => b.stampedAt - a.stampedAt);
    if (search) results = results.filter((e) => e.nickname.toLowerCase().includes(search) || e.uniqueId.toLowerCase().includes(search));
    if (dateF) results = results.filter((e) => e.date === dateF);
    return Response.json({ participants: results, total: results.length });
  }
  if (path.startsWith("/api/stamp-card/participants/") && req.method === "DELETE") {
    const parts = path.split("/");
    const uid = decodeURIComponent(parts[4]);
    const date = parts[5];
    const sc = await loadStampDB();
    sc.entries = sc.entries.filter((e) => !(e.uniqueId === uid && e.date === date));
    await saveStampDB(sc);
    broadcast({ type: "stamp_card_updated" });
    return Response.json({ ok: true });
  }
  if (path === "/webhook/comment" && req.method === "POST") {
    return await handleCommentWebhook(req);
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
// スタンプカード データ層
// ============================================================
interface StampCardColors {
  cardBg: string; cardBorder: string; stampedBg: string;
  usernameColor: string; overlayBg: string;
}
interface StampCardSettings {
  gridCols: number; gridRows: number;
  backgroundImageURL: string; stampImageURL: string;
  stampSoundURL: string; completeSoundURL: string;
  colorPreset: string; colors: StampCardColors; enabled: boolean;
}
interface StampEntry {
  uniqueId: string; nickname: string; date: string; stampedAt: number;
}
interface StampCardDB {
  settings: StampCardSettings; entries: StampEntry[];
}

const STAMP_PATH = "./data/stamp-card.json";
const DEFAULT_STAMP_SETTINGS: StampCardSettings = {
  gridCols: 5, gridRows: 2,
  backgroundImageURL: "", stampImageURL: "", stampSoundURL: "", completeSoundURL: "",
  colorPreset: "blue",
  colors: { cardBg: "#0d1a2e", cardBorder: "#4488ff", stampedBg: "#0d2e4a", usernameColor: "#aaccff", overlayBg: "rgba(5,10,25,0.8)" },
  enabled: true,
};

async function loadStampDB(): Promise<StampCardDB> {
  try {
    return JSON.parse(await Deno.readTextFile(STAMP_PATH)) as StampCardDB;
  } catch {
    return { settings: { ...DEFAULT_STAMP_SETTINGS }, entries: [] };
  }
}
async function saveStampDB(db: StampCardDB): Promise<void> {
  await Deno.writeTextFile(STAMP_PATH, JSON.stringify(db, null, 2));
}

// スタンプを1枚押す。重複チェック込み。戻り値: 実際に押したか
async function tryStamp(uniqueId: string, nickname: string, reason: string): Promise<boolean> {
  const sc = await loadStampDB();
  if (!sc.settings.enabled) return false;
  const today = todayStr();
  if (sc.entries.some((e) => e.uniqueId === uniqueId && e.date === today)) return false;

  sc.entries.push({ uniqueId, nickname, date: today, stampedAt: Date.now() });
  await saveStampDB(sc);

  const todayEntries = sc.entries.filter((e) => e.date === today);
  const maxCards = sc.settings.gridCols * sc.settings.gridRows;
  const complete = todayEntries.length >= maxCards;
  broadcast({ type: "stamp_card_stamp", uniqueId, nickname, todayCount: todayEntries.length, maxCards, complete });
  if (complete) broadcast({ type: "stamp_card_complete" });
  console.log(`[STAMP:${reason}] ${nickname}(${uniqueId}) → ${todayEntries.length}/${maxCards}`);
  return true;
}

function todayStr(): string { return dateStr(new Date()); }
function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function calcStreaks(entries: StampEntry[]): Map<string, { current: number; max: number }> {
  const byUser = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!byUser.has(e.uniqueId)) byUser.set(e.uniqueId, new Set());
    byUser.get(e.uniqueId)!.add(e.date);
  }
  const today = todayStr();
  const result = new Map<string, { current: number; max: number }>();
  for (const [uid, dates] of byUser) {
    const sorted = [...dates].sort();
    let max = 0, streak = 0;
    let prev: string | null = null;
    for (const d of sorted) {
      if (!prev) { streak = 1; }
      else {
        const diff = (new Date(d).getTime() - new Date(prev).getTime()) / 86400000;
        streak = diff === 1 ? streak + 1 : 1;
      }
      max = Math.max(max, streak);
      prev = d;
    }
    let current = 0;
    let check = new Date(today + "T00:00:00");
    while (dates.has(dateStr(check))) {
      current++;
      check = new Date(check.getTime() - 86400000);
    }
    result.set(uid, { current, max });
  }
  return result;
}

async function handleCommentWebhook(req: Request): Promise<Response> {
  try {
    const payload = await req.json() as TikFinityPayload;
    const uniqueId = payload.data?.user?.uniqueId ?? "";
    const nickname = payload.data?.user?.nickname ?? "anonymous";
    if (!uniqueId) return Response.json({ ok: false, reason: "no uniqueId" });
    const stamped = await tryStamp(uniqueId, nickname, "comment");
    return Response.json({ ok: true, stamped });
  } catch (e) {
    console.error("Comment webhook error:", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
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
    comment?: string;
    likeCount?: number;
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

async function handleLikeWebhook(req: Request): Promise<Response> {
  try {
    const raw = await req.json() as Record<string, unknown>;
    const data = (raw.data as Record<string, unknown>) ?? raw;
    const user = (data.user as Record<string, unknown>) ?? {};
    const uniqueId = String(user.uniqueId ?? "");
    const nickname = String(user.nickname ?? "anonymous");
    if (!uniqueId) return Response.json({ ok: true });
    const stamped = await tryStamp(uniqueId, nickname, "like");
    return Response.json({ ok: true, stamped });
  } catch (e) {
    console.error("Like webhook error:", e);
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

async function handleWebhook(req: Request): Promise<Response> {
  try {
    const payload = await req.json() as TikFinityPayload;
    const giftId = String(payload.data?.giftId ?? payload.giftId ?? "");
    const giftName = payload.data?.giftName ?? payload.giftName ?? "";
    const diamonds = payload.data?.diamondCount ?? payload.diamondCount ?? 0;
    const uniqueId = payload.data?.user?.uniqueId ?? "";
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

    // スタンプカード: ギフト送信者をスタンプ
    if (uniqueId) {
      await tryStamp(uniqueId, userName, `gift:${giftName}`);
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
console.log(`  Overlay:    http://localhost:${PORT}/overlay`);
console.log(`  Admin:      http://localhost:${PORT}/admin`);
console.log(`  StampCard:  http://localhost:${PORT}/stamp-card`);
console.log(`  Webhook:    http://localhost:${PORT}/webhook`);
console.log(`  LikeHook:   http://localhost:${PORT}/webhook/like`);

Deno.serve({ port: PORT }, handler);
