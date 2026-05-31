# YouTube Live PiP with Chat - Chrome拡張 実装計画

## 1. ゴール

YouTube Live の視聴ページ、およびライブ配信のアーカイブページで、動画とチャット（YouTube標準のチャットリスト UI）を **単一のDocument PiPウィンドウ** にまとめて表示する Chrome 拡張を実装する。

### 要件
- macOS Spaces（仮想ディスプレイ）を越境して常時表示される
- チャットは弾幕方式ではなく YouTube 標準のリスト形式
- 動画とチャットは別ウィンドウではなく同一 PiP ウィンドウ内に縦並び
- **ライブ配信ではライブチャット、アーカイブではチャットリプレイ**を表示
- **PiP ウィンドウ内に独自の再生コントロール**（再生/一時停止・音量・シーク）を実装
- YouTube プレイヤーのコントロールバーにネイティブな見た目のボタンを追加して起動

### 非要件（MVP では対象外）
- チャットリプレイの動画再生位置との完全同期（後述の既知制約を参照）
- メンバーシップ限定チャット投稿 UI の細かい調整
- 字幕、画質切替、再生速度変更などの高度な機能
- Firefox / Safari 対応
- レイアウト切り替え（縦/横）UI

## 2. 技術スタック

- Manifest V3
- バニラ JS / バニラ CSS（ビルドツール不要、TypeScript も不要）
- 対象ブラウザ: Chrome 116+（Document PiP API 要件）

## 3. アーキテクチャ

### コンポーネント

| ファイル | 責務 |
|---------|------|
| `src/content.js` | ボタン注入、ページ種別判定、PiP ライフサイクル、SPA 遷移追従 |
| `src/pip-controls.js` | PiP ウィンドウ内のコントロール UI 生成と video 要素へのバインド |
| `src/content.css` | 注入ボタンの最小限のスタイル |
| `src/pip-controls.css` | PiP ウィンドウ内コントロールのスタイル（PiP 内で `<style>` として注入） |

content.js から `pip-controls.js` の `mountControls(pipWindow, video, mode)` 関数を呼び出す構成。Manifest V3 の content_scripts に複数 JS を並べると順番に読み込まれるため、グローバルな関数として公開すれば import 不要。

### 状態管理ポリシー
- `documentPictureInPicture.window` を single source of truth として二重起動防止
- 動画要素の元の親ノードと `style` 属性を保持し、PiP 閉鎖時に確実に復元
- ページ種別は **3 値** で管理: `'live'` / `'archive'` / `'vod'`（後 2 者は微妙に異なる扱い）

## 4. ファイル構成

```
youtube-live-pip-chat/
├── manifest.json
├── src/
│   ├── content.js
│   ├── content.css
│   ├── pip-controls.js
│   └── pip-controls.css
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── README.md
```

## 5. 実装詳細

### 5.1 `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "YouTube Live PiP with Chat",
  "version": "0.1.0",
  "description": "YouTube ライブ配信とアーカイブの動画+チャットを1つのPiPウィンドウに表示",
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "content_scripts": [
    {
      "matches": ["https://www.youtube.com/*"],
      "js": ["src/pip-controls.js", "src/content.js"],
      "css": ["src/content.css"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["src/pip-controls.css"],
      "matches": ["https://www.youtube.com/*"]
    }
  ]
}
```

**ポイント**:
- `host_permissions` は `content_scripts.matches` で足りるため不要
- `pip-controls.js` を先に読み込み、その関数を `content.js` から呼ぶ
- `pip-controls.css` は PiP ウィンドウへ `<link>` で注入するため web_accessible_resources に登録

### 5.2 `src/content.js` の責務分割

| 関数 | 責務 |
|------|------|
| `detectPageMode()` | `'live'` / `'archive'` / `'vod'` / `null` を返す |
| `injectButton()` | プレイヤーコントロールに PiP ボタンを挿入（冪等） |
| `openPiP()` | Document PiP ウィンドウを生成し動画＋チャット＋コントロールを配置 |
| `tryInjectWithRetry()` | プレイヤー DOM の遅延構築に追従するリトライ |
| `init()` | エントリポイント、SPA イベント登録 |

### 5.3 ページ種別の判定

```js
function detectPageMode() {
  if (!/^\/watch$/.test(location.pathname)) return null;

  const isLive = !!document.querySelector('.ytp-live');
  const hasChat = !!document.querySelector('ytd-live-chat-frame#chat');

  if (isLive) return 'live';
  if (hasChat) return 'archive';   // 元ライブのアーカイブ（チャットリプレイあり）
  return 'vod';                    // 通常VOD（チャットなし）
}
```

**ボタン表示ポリシー**: `live` と `archive` のみで表示。`vod` ではボタンを出さない（標準 PiP で足りるため）。

### 5.4 ボタン注入

挿入先は `.ytp-right-controls` 内、既存 PiP ボタン（`.ytp-pip-button`）の手前。

```js
function injectButton() {
  const mode = detectPageMode();
  if (mode !== 'live' && mode !== 'archive') return false;
  if (!('documentPictureInPicture' in window)) return false;

  const rightControls = document.querySelector('.ytp-right-controls');
  if (!rightControls) return false;
  if (rightControls.querySelector('#yt-live-pip-button')) return true;

  const btn = document.createElement('button');
  btn.id = 'yt-live-pip-button';
  btn.className = 'ytp-button';
  btn.title = 'チャット付き PiP で表示';
  btn.setAttribute('aria-label', 'チャット付き PiP で表示');
  btn.innerHTML = `
    <svg height="100%" viewBox="0 0 36 36" width="100%" style="pointer-events:none">
      <path d="M11 11h14v10H11z" fill="none" stroke="#fff" stroke-width="2"/>
      <rect x="19" y="15" width="4" height="3" fill="#fff"/>
      <path d="M13 14h3M13 17h2" stroke="#fff" stroke-width="1.2"/>
    </svg>
  `;
  btn.addEventListener('click', onButtonClick);

  const pipBtn = rightControls.querySelector('.ytp-pip-button');
  if (pipBtn) pipBtn.before(btn);
  else rightControls.prepend(btn);
  return true;
}
```

### 5.5 PiP 起動ロジック（コア）

前回検証で得た知見：
- **動画**: 既存 `<video>` を移動（再生状態と音声を保持）
- **チャット**: 既存 iframe は移動せず、PiP 側で**新規 iframe を生成**
- **チャット URL の分岐**: ライブは `live_chat`、アーカイブは `live_chat_replay`

```js
async function onButtonClick() {
  if (documentPictureInPicture.window) {
    documentPictureInPicture.window.close();
    return;
  }
  await openPiP();
}

async function openPiP() {
  const mode = detectPageMode();
  if (mode !== 'live' && mode !== 'archive') return;

  const videoId = new URL(location.href).searchParams.get('v');
  const video = document.querySelector('video.html5-main-video');
  if (!video || !videoId) return;

  const videoHome = video.parentElement;
  const videoStyleBackup = video.getAttribute('style') || '';

  const pip = await documentPictureInPicture.requestWindow({
    width: 480,
    height: 760,
  });

  // PiP 側スタイル注入
  injectStylesheet(pip, chrome.runtime.getURL('src/pip-controls.css'));
  pip.document.body.style.cssText =
    'margin:0;background:#0f0f0f;color-scheme:dark;font-family:Roboto,Arial,sans-serif';

  const root = pip.document.createElement('div');
  root.className = 'ytpip-root';
  pip.document.body.appendChild(root);

  // 動画ステージ
  const stage = pip.document.createElement('div');
  stage.className = 'ytpip-stage';
  stage.appendChild(video);
  video.style.cssText = 'width:100%;height:100%;display:block';
  root.appendChild(stage);

  // 5.6 で実装する関数を呼ぶ
  window.YtPipControls.mount(pip, stage, video, mode);

  // チャット iframe
  const chatPath = mode === 'live' ? 'live_chat' : 'live_chat_replay';
  const chatUrl = new URL(`https://www.youtube.com/${chatPath}`);
  chatUrl.searchParams.set('v', videoId);
  chatUrl.searchParams.set('embed_domain', location.hostname);
  chatUrl.searchParams.set('is_popout', '1');

  const chat = pip.document.createElement('iframe');
  chat.className = 'ytpip-chat';
  chat.src = chatUrl.toString();
  chat.allow = 'autoplay';
  root.appendChild(chat);

  // クリーンアップ
  pip.addEventListener('pagehide', () => {
    if (videoHome && video.parentElement !== videoHome) {
      videoHome.appendChild(video);
      video.setAttribute('style', videoStyleBackup);
    }
  }, { once: true });
}

function injectStylesheet(pipWindow, url) {
  const link = pipWindow.document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  pipWindow.document.head.appendChild(link);
}
```

### 5.6 `src/pip-controls.js` — PiP内コントロール

`window.YtPipControls.mount(pipWindow, stageEl, videoEl, mode)` をエクスポート。

責務：
- ステージにオーバーレイ要素を挿入
- video のイベントを listen して UI を更新
- UI のイベントで video のプロパティを操作
- ホバーで自動表示・非表示

```js
window.YtPipControls = (function () {
  function mount(pip, stage, video, mode) {
    const doc = pip.document;
    const bar = doc.createElement('div');
    bar.className = 'ytpip-controls';
    bar.innerHTML = `
      <button class="ytpip-btn ytpip-play" aria-label="再生/一時停止">
        <svg viewBox="0 0 24 24" width="20" height="20"></svg>
      </button>
      <div class="ytpip-time" data-time></div>
      <input class="ytpip-seek" type="range" min="0" max="100" step="0.1" value="0" data-seek/>
      <div class="ytpip-live-indicator" data-live>LIVE</div>
      <button class="ytpip-btn ytpip-mute" aria-label="ミュート">
        <svg viewBox="0 0 24 24" width="20" height="20"></svg>
      </button>
      <input class="ytpip-volume" type="range" min="0" max="1" step="0.01" value="1" data-volume/>
    `;
    stage.appendChild(bar);

    const playBtn = bar.querySelector('.ytpip-play');
    const muteBtn = bar.querySelector('.ytpip-mute');
    const volume = bar.querySelector('[data-volume]');
    const seek = bar.querySelector('[data-seek]');
    const timeEl = bar.querySelector('[data-time]');
    const liveBadge = bar.querySelector('[data-live]');

    // モードに応じた表示切替
    if (mode === 'live') {
      seek.hidden = true;
      timeEl.hidden = true;
    } else {
      liveBadge.hidden = true;
    }

    // 再生/一時停止
    const updatePlayIcon = () => {
      playBtn.querySelector('svg').innerHTML = video.paused
        ? '<path d="M8 5v14l11-7z" fill="#fff"/>'
        : '<path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="#fff"/>';
    };
    playBtn.addEventListener('click', () => {
      video.paused ? video.play() : video.pause();
    });
    video.addEventListener('play', updatePlayIcon);
    video.addEventListener('pause', updatePlayIcon);
    updatePlayIcon();

    // 音量
    const updateMuteIcon = () => {
      muteBtn.querySelector('svg').innerHTML = (video.muted || video.volume === 0)
        ? '<path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.9 8.9 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.17v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" fill="#fff"/>'
        : '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" fill="#fff"/>';
    };
    muteBtn.addEventListener('click', () => {
      video.muted = !video.muted;
    });
    volume.addEventListener('input', () => {
      video.volume = parseFloat(volume.value);
      if (video.volume > 0) video.muted = false;
    });
    video.addEventListener('volumechange', () => {
      volume.value = String(video.muted ? 0 : video.volume);
      updateMuteIcon();
    });
    volume.value = String(video.muted ? 0 : video.volume);
    updateMuteIcon();

    // シーク (archive のみ)
    if (mode === 'archive') {
      const updateSeek = () => {
        if (!isFinite(video.duration)) return;
        seek.max = String(video.duration);
        if (!seek.dataset.dragging) seek.value = String(video.currentTime);
        timeEl.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
      };
      video.addEventListener('timeupdate', updateSeek);
      video.addEventListener('durationchange', updateSeek);
      seek.addEventListener('pointerdown', () => { seek.dataset.dragging = '1'; });
      seek.addEventListener('pointerup', () => { delete seek.dataset.dragging; });
      seek.addEventListener('input', () => {
        video.currentTime = parseFloat(seek.value);
      });
      updateSeek();
    }

    // ホバー表示制御
    let hideTimer;
    const showBar = () => {
      bar.classList.add('visible');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => bar.classList.remove('visible'), 2500);
    };
    stage.addEventListener('pointermove', showBar);
    stage.addEventListener('pointerenter', showBar);
    showBar();
  }

  function fmt(sec) {
    if (!isFinite(sec)) return '0:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  return { mount };
})();
```

### 5.7 `src/pip-controls.css`

```css
.ytpip-root {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100vh;
}
.ytpip-stage {
  background: #000;
  aspect-ratio: 16/9;
  position: relative;
}
.ytpip-chat {
  border: 0;
  width: 100%;
  height: 100%;
  background: #0f0f0f;
}
.ytpip-controls {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: linear-gradient(transparent, rgba(0,0,0,0.7));
  color: #fff;
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
.ytpip-controls.visible {
  opacity: 1;
  pointer-events: auto;
}
.ytpip-btn {
  background: none; border: 0; padding: 4px; cursor: pointer;
  color: #fff; display: inline-flex; align-items: center; justify-content: center;
}
.ytpip-seek {
  flex: 1;
  accent-color: #f00;
}
.ytpip-volume {
  width: 70px;
  accent-color: #fff;
}
.ytpip-live-indicator {
  background: #f00; color: #fff; font-weight: bold;
  padding: 2px 6px; border-radius: 2px; font-size: 10px;
  flex: 1; text-align: left;
}
.ytpip-time {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
```

### 5.8 SPA 遷移対応

```js
function init() {
  document.addEventListener('yt-navigate-finish', onNavigate);
  onNavigate();
}

function onNavigate() {
  documentPictureInPicture.window?.close();
  tryInjectWithRetry();
}

function tryInjectWithRetry(maxAttempts = 20, intervalMs = 500) {
  let attempts = 0;
  const timer = setInterval(() => {
    if (injectButton() || ++attempts >= maxAttempts) clearInterval(timer);
  }, intervalMs);
}

init();
```

### 5.9 `src/content.css`

```css
#yt-live-pip-button { vertical-align: top; }
#yt-live-pip-button svg { vertical-align: middle; }
```

## 6. 既知の制約：チャットリプレイの同期について

**現状**:
YouTube のチャットリプレイ iframe（`live_chat_replay`）は、YouTube watch ページに埋め込まれている場合のみ動画の `currentTime` と同期する。同期は YouTube 内部の postMessage 機構に依存しており、外部から完全に再現するのは非自明。

**MVP での挙動**:
- PiP を開いた時点から、チャットリプレイは iframe がデフォルトで動作する状態でロードされる
- 動画をシークしてもチャット側は追従しない可能性が高い
- 連続再生では実用上問題にならないケースが多い

**将来の改善案**（要検証）:
1. 動画の `seeked` イベント発火時に iframe を破棄→新規生成（重いが確実）
2. YouTube 内部の postMessage プロトコルをリバースエンジニアリングして自前で同期
3. 元タブの `ytd-live-chat-frame` iframe にメッセージを送って強制シーク

実装時は **MVP では同期しない前提** で進め、README に既知の制約として明記する。

## 7. エッジケース対応一覧

| ケース | 対応 |
|--------|------|
| 通常 VOD（チャットなし） | ボタン非表示 |
| ライブ配信 | `live_chat` を埋め込み、コントロールから seek を非表示、LIVE バッジ表示 |
| アーカイブ（元ライブ） | `live_chat_replay` を埋め込み、コントロールに seek 表示 |
| 既に PiP 起動中に再クリック | トグル動作（既存ウィンドウを閉じる） |
| PiP 表示中に SPA 遷移 | `yt-navigate-finish` で既存 PiP を閉じる |
| `<video>` が見つからない | early return でサイレント無視 |
| Chrome 116 未満 | `documentPictureInPicture` 未定義チェックでボタン非表示 |
| メンバー限定チャット | `is_popout=1` で Cookie 認証を継承 |
| アーカイブで `video.duration` が未確定 | `durationchange` イベントで再計算 |
| シーク中の `timeupdate` 衝突 | `data-dragging` フラグでドラッグ中は UI 値を更新しない |
| 動画要素の親ノード消失 | 復元時に `videoHome` 存在チェック |
| プレイヤー DOM の遅延構築 | `tryInjectWithRetry` で 500ms ごとに最大 20 回試行 |

## 8. 動作確認チェックリスト

ローカル読み込み後、以下を順番に確認：

### 共通
- [ ] ライブ配信ページとアーカイブページの両方でボタンが出現する
- [ ] 通常 VOD（チャット欄なし動画）ではボタンが出現しない
- [ ] Chrome 116 未満（または対象外ブラウザ）でボタンが出現しない
- [ ] ボタンクリックで PiP ウィンドウが開く
- [ ] PiP ウィンドウを閉じると元タブで動画再生が継続する
- [ ] macOS で別 Space に切り替えても PiP ウィンドウが追従して表示される
- [ ] 別の動画に SPA 遷移すると古い PiP は閉じ、新ページでボタンが再注入される
- [ ] ボタン再クリックで PiP がトグルする

### コントロール
- [ ] 動画ステージにホバーするとコントロールバーが表示される
- [ ] 一定時間操作がないと自動で非表示になる
- [ ] 再生/一時停止ボタンが動作し、アイコンが状態に追従する
- [ ] 音量スライダーで音量が変化する
- [ ] ミュートボタンで切り替わり、アイコンが追従する
- [ ] 音量を 0 にすると自動でミュートアイコンになる

### ライブ
- [ ] LIVE バッジが表示される
- [ ] シークバーが表示されない
- [ ] ライブチャットがリアルタイムで流れる
- [ ] PiP からチャット投稿できる（ログイン済み時）

### アーカイブ
- [ ] シークバーと時刻表示が表示される
- [ ] LIVE バッジは表示されない
- [ ] シークバーをドラッグすると動画がシークする
- [ ] 動画再生に伴ってシークバーが進む
- [ ] 時刻表示が `HH:MM:SS / HH:MM:SS` 形式で更新される
- [ ] チャットリプレイが iframe に表示される（同期は MVP 非対応で OK）

## 9. ローカル開発・読み込み手順

1. `chrome://extensions/` を開く
2. 右上「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」でリポジトリのルートディレクトリを選択
4. YouTube ライブ／アーカイブページを開いて動作確認
5. コード修正後は拡張機能カードの「再読み込み」ボタンを押し、ページもリロード

## 10. アイコン

MVP ではプレースホルダーで可：

```bash
# ImageMagick がある場合のワンライナー例
for size in 16 48 128; do
  convert -size ${size}x${size} xc:'#cc0000' \
    -fill white -gravity center -pointsize $((size/3)) \
    -annotate 0 'PiP' icons/icon-${size}.png
done
```

## 11. 着手順序（推奨）

1. ディレクトリ作成 + `manifest.json` + プレースホルダーアイコン
2. `src/content.js` に `detectPageMode()` と `injectButton()` の骨格を実装
3. Chrome に読み込んで、ライブ／アーカイブ／VOD 各ページでボタン表示の有無を確認
4. `openPiP()` を実装（チャット無し、動画だけ、コントロール無し）→ PiP 起動確認
5. `pip-controls.js` の再生/一時停止と音量を実装 → コントロール動作確認
6. アーカイブ用シーク機能を追加
7. チャット iframe 追加（live / archive の URL 分岐込み）
8. クリーンアップ（`pagehide`）と SPA 遷移ハンドラを実装
9. 動作確認チェックリストを一通り実施
10. README に既知の制約（チャットリプレイ同期）を記載

## 12. 将来の拡張候補

- チャットリプレイの動画同期（上述）
- ウィンドウサイズ・位置の記憶（`chrome.storage.local`）
- レイアウト切替（縦並び/横並び）
- ホットキー（`commands` API）
- 字幕表示
- 再生速度切替
