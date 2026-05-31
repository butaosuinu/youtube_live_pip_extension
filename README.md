# YouTube Live PiP with Chat

YouTube のライブ配信とライブアーカイブを、動画とチャット込みで 1 つの Document Picture-in-Picture ウィンドウに表示する Chrome 拡張です。

## Requirements

- Chrome 116 以降
- Manifest V3 対応の Chromium 系ブラウザ
- YouTube にログインしている場合、チャット iframe は通常の Cookie 認証を利用します

## Install

1. Chrome で `chrome://extensions` を開く。
2. 右上の「デベロッパー モード」を有効にする。
3. 「パッケージ化されていない拡張機能を読み込む」を押す。
4. このリポジトリのルートディレクトリを選択する。

## Usage

1. YouTube のライブ配信ページ、またはライブアーカイブページを開く。
2. プレイヤー右下のコントロールバーに追加される PiP + chat ボタンを押す。
3. PiP ウィンドウ内で動画、チャット、再生コントロールを操作する。

通常の VOD ではチャットがないため、拡張ボタンは表示されません。

## Controls

- ライブ配信: 再生/一時停止、ミュート、音量、LIVE 表示
- ライブアーカイブ: 再生/一時停止、ミュート、音量、シーク、時刻表示

PiP 内のコントロールバーは動画領域へのホバーまたはフォーカスで表示され、一定時間後に自動で隠れます。

## Known Limitations

- ライブアーカイブのチャットリプレイは、動画のシーク位置と完全には同期しません。YouTube の標準 watch ページ内同期は内部の postMessage 機構に依存しており、この MVP では再現していません。
- 字幕、画質切替、再生速度変更、レイアウト切替は対象外です。
- Firefox と Safari は対象外です。
