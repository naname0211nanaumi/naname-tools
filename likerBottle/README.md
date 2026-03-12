# Liker Bottle v2

TikTokライブのいいね数を香水瓶で可視化するOBSブラウザソース。

## ファイル構成

```
liker-bottle-v2/
├── source.html      ← OBSブラウザソース（瓶の表示）
├── controller.html  ← OBSカスタムブラウザドック（操作パネル）
├── server.ts        ← Denoサーバー（中継 & TikFinity受信）
├── start.bat        ← サーバー起動ボタン（ダブルクリック）
└── README.md
```

---

## 初回セットアップ

### 1. Deno インストール（初回のみ）

PowerShellで実行:
```powershell
irm https://deno.land/install.ps1 | iex
```

インストール後、PowerShellを再起動してください。

### 2. サーバー起動

`start.bat` をダブルクリック。

```
✓ Liker Bottle server running on ws://localhost:3000
```

と表示されれば成功。

---

## OBS 設定

### ブラウザソース（瓶の表示）
- ソース追加 → ブラウザ → ローカルファイル: `source.html`
- 幅: **300** / 高さ: **480**
- 「OBSを介して音声を制御する」: オフ
- 「透過」: オン ✓

### カスタムブラウザドック（操作パネル）
- ツール → カスタムブラウザドック → 追加
- URL: ローカルファイルパス `controller.html`

---

## いいね取得の仕組み

```
優先: わんコメ (ws://localhost:11180)
         ↓ わんコメが死んだら自動切替
フォールバック: TikFinity → POST /like → server.ts → source.html
```

### TikFinity設定（フォールバック使用時）

1. TikFinity を開く
2. アクション設定 → イベント: **Like**
3. アクション: **HTTP Request**
   - URL: `http://localhost:3000/like`
   - Method: `POST`
   - Body: `{"likeCount": 1}`

---

## コントローラー機能

| 機能 | 説明 |
|------|------|
| +1 / +10 / +50 / +100 | いいね手動追加 |
| Reset | いいねをリセット |
| 手動セット | 任意の数値にセット |
| 目標 | 目標いいね数（分母）を変更 |
| 液体の色 | 上・下グラデーションカラー変更 |
| ガラス色 | ブルー/ピンク/グリーン/ゴールド/ホワイト |
| 形状 | スタンダード/スリム/ラウンド |
| 浮遊モチーフ | 💎✦🌙💧⬡❄ を自由に組み合わせ |

---

## 接続状態（瓶右下）

| 表示 | 意味 |
|------|------|
| `◉ わんコメ` | わんコメ経由でいいね取得中 |
| `◉ TikFinity` | TikFinity経由でいいね取得中 |
| `— 待機中` | どちらも未接続 |
