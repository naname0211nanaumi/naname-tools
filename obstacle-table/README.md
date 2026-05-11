# obstacle-table

七海ナナメ｜TikTok Live 妨害表ツール

OBS Browser Source用の妨害表オーバーレイ＋管理画面。
ギフト→妨害の対応を管理画面で編集し、保存時にOBS側へ即時反映する。

## 起動

```bash
deno task start   # 本番
deno task dev     # 開発（ファイル監視・自動再起動）
```

ポート: `8788`

## URL

| 用途 | URL |
|------|-----|
| OBSオーバーレイ | http://localhost:8788/overlay |
| 管理画面 | http://localhost:8788/admin |
| TikFinity Webhook | http://localhost:8788/webhook |

## OBS設定

Browser Sourceで以下を指定:
- URL: `http://localhost:8788/overlay`
- Width: 1080 / Height: 1920（縦長配信想定。横長なら適宜変更）
- カスタムCSSは不要（背景透過済み）

## TikFinity設定

Webhook URL: `http://localhost:8788/webhook`
イベント: `gift`

## ディレクトリ構成

```
obstacle-table/
├── deno.json
├── data/
│   └── sets.json          # 妨害表セット全データ（自動生成）
├── server/
│   ├── main.ts            # HTTPサーバー＋WS＋Webhook
│   └── streamtoearn.ts    # ギフト一覧取得・キャッシュ
└── public/
    ├── overlay.html       # OBS用
    └── admin.html         # 管理画面
```

## データモデル

```typescript
type GiftMapping = {
  giftName: string;       // streamtoearn由来。TikFinityのgiftName完全一致
  giftId?: string;        // TikFinity初回受信時に自動補完
  giftImageURL: string;   // streamtoearn由来
};

type Block = {
  id: string;
  obstacleName: string;          // 妨害名/お助け名
  obstacleType: 'obstacle' | 'help';  // 妨害(青) / お助け(ピンク)
  gift: GiftMapping;
  enabled: boolean;
  bandEnabled: boolean;          // お助け帯の有無
  bandText: string;              // 帯テキスト（"お助け"等）
  imageScale: number;            // 0.5〜1.5
};

type Set = {
  id: string;
  name: string;                  // "GTA山登りセット"等
  title: string;                 // overlay上部大タイトル
  subtitle: string;              // overlay上部小タイトル（ルール）
  winCounterLabel: string;       // "ホラゲ残り"
  winCount: number;              // 43
  winCounterUnit: string;        // "個"
  currentWinLabel: string;       // "現在のWIN数"
  currentWin: number;
  layoutColumns: number;         // 1〜10
  blocks: Block[];
};

type DB = {
  activeSetId: string;
  sets: Set[];
};
```

## ギフト紐付けの方針

- 主キー: `giftName`（TikFinity webhook の giftName と完全一致）
- 補助: `giftId`（初回受信時に自動補完してログに残る）
- streamtoearn から `giftName` と画像URLを取得してデータベースに保存

## 既知の制約

- streamtoearn 側のページ構造が変わるとパースが壊れる。その場合は
  `server/streamtoearn.ts` を修正すること。
- giftName ベースのマッチなので、TikTokのギフト名表記が変わると外れる。
  実運用ではgiftIdベースに切替推奨（自動補完されたID基準で再保存）。
