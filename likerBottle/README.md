# Liker Bottle – わんコメ対応版

## 構成

```
liker-bottle-onecomme/
├── source.html      ← OBSブラウザソース用（瓶表示）
├── controller.html  ← OBSカスタムブラウザドック用（手動操作）
└── README.md
```

## セットアップ

### 1. OBSにブラウザソースを追加
- ソースを追加 → ブラウザ
- URL: `ローカルファイル` → `source.html` のパスを指定
- 幅: 300 / 高さ: 480
- 「OBSで透明背景を使用」にチェック

### 2. OBSにカスタムブラウザドックを追加（オプション）
- ツール → カスタムブラウザドック
- URL: `controller.html` のパスを指定

---

## いいね検知の仕組み

### ① わんコメ経由（優先）
わんコメが起動してTikTok Liveに接続されていれば自動でいいねを検知します。

**わんコメ側の設定は不要です（自動で接続を試みます）。**

接続確認: source.html 右下に `◉ わんコメ` と表示されれば成功。

### ② TikFinity経由（フォールバック）
わんコメが使えないときの予備。
`server.js`（別途Node.jsが必要）が起動していれば自動的に切り替わります。

接続確認: source.html 右下に `◉ TikFinity` と表示されれば成功。

---

## わんコメのTikTokいいねイベントについて

わんコメのWSから届くいいねイベントの想定形式:

```json
{
  "type": "systemComment",
  "data": {
    "service": "TikTok",
    "data": {
      "type": "like",
      "likeCount": 5
    }
  }
}
```

実際のイベント形式はわんコメのバージョンによって異なる場合があります。
もし反応しない場合は、わんコメのWS受信内容をブラウザのコンソールで確認し、
source.html の `handleOneCommeComment` 関数を調整してください。

---

## 手動デバッグ

ブラウザで source.html を開き、コンソールで:
```javascript
// いいねを50追加
window.postMessage({ type: 'add_likes', value: 50 }, '*');
// 目標を変更
window.postMessage({ type: 'set_goal', value: 2000 }, '*');
// リセット
window.postMessage({ type: 'reset' }, '*');
```
