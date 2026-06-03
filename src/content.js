(function () {
  'use strict';

  const BUTTON_ID = 'yt-live-pip-button';
  const SCRIPT_VERSION = 'chat-bridge-v1';
  const RETRY_ATTEMPTS = 20;
  const RETRY_INTERVAL_MS = 500;
  const PIP_WIDTH = 480;
  const PIP_HEIGHT = 760;
  const PIP_VIDEO_WIDTH = 480;
  const PIP_VIDEO_HEIGHT = 270;
  const MESSAGE_CHANNEL = 'yt-live-pip-with-chat';
  const CHAT_MESSAGE_SELECTOR = [
    'yt-live-chat-text-message-renderer',
    'yt-live-chat-paid-message-renderer',
    'yt-live-chat-paid-sticker-renderer',
    'yt-live-chat-membership-item-renderer',
    'yt-live-chat-viewer-engagement-message-renderer'
  ].join(',');
  const MAX_MIRRORED_MESSAGES = 80;
  const PUBLISH_THROTTLE_MS = 300;
  const SCROLL_STICK_THRESHOLD = 40;
  const AUTHOR_TYPES = ['owner', 'moderator', 'member', 'verified'];
  const BADGE_GLYPH = { owner: '★', moderator: '🛡', member: '★', verified: '✓' };

  let retryTimer = 0;
  let latestChatMessages = [];
  let latestChatSignature = '';
  const chatSubscribers = new Set();

  function detectPageMode() {
    if (location.pathname !== '/watch') return null;

    const video = document.querySelector('video.html5-main-video');
    const duration = video ? video.duration : NaN;

    if (document.querySelector('.ytp-live') || duration === Infinity) return 'live';
    if (document.querySelector('ytd-live-chat-frame#chat')) return 'archive';

    // メタデータ未取得の間は live/archive を vod と誤判定しないよう確定を保留する
    if (!Number.isFinite(duration) || duration <= 0) return null;

    return 'vod';
  }

  function supportsDocumentPiP() {
    return (
      'documentPictureInPicture' in window &&
      typeof window.documentPictureInPicture.requestWindow === 'function'
    );
  }

  function getPiPWindow() {
    return supportsDocumentPiP() ? window.documentPictureInPicture.window : null;
  }

  function removeButton() {
    document.getElementById(BUTTON_ID)?.remove();
  }

  function injectButton() {
    const mode = detectPageMode();
    if (mode === null || !supportsDocumentPiP()) {
      removeButton();
      return false;
    }

    const rightControls = document.querySelector('.ytp-right-controls');
    if (!rightControls) return false;

    const buttonLabel = mode === 'vod' ? 'PiP で表示' : 'チャット付き PiP で表示';

    const existingButton = rightControls.querySelector(`#${BUTTON_ID}`);
    if (existingButton?.dataset.ytLivePipVersion === SCRIPT_VERSION) {
      if (existingButton.title !== buttonLabel) {
        existingButton.title = buttonLabel;
        existingButton.setAttribute('aria-label', buttonLabel);
      }
      return true;
    }
    existingButton?.remove();

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.className = 'ytp-button';
    button.type = 'button';
    button.dataset.ytLivePipVersion = SCRIPT_VERSION;
    button.title = buttonLabel;
    button.setAttribute('aria-label', buttonLabel);
    button.innerHTML = [
      '<svg height="100%" viewBox="0 0 36 36" width="100%" aria-hidden="true" focusable="false">',
      '<path d="M10.5 10.5h15v11h-15z" fill="none" stroke="#fff" stroke-width="2"/>',
      '<rect x="18.5" y="15" width="5" height="3.5" rx="0.7" fill="#fff"/>',
      '<path d="M13 14.5h3.8M13 17.5h2.4" stroke="#fff" stroke-linecap="round" stroke-width="1.4"/>',
      '</svg>'
    ].join('');
    button.addEventListener('click', onButtonClick);

    const nativePiPButton = rightControls.querySelector('.ytp-pip-button');
    if (nativePiPButton) {
      nativePiPButton.before(button);
    } else {
      rightControls.prepend(button);
    }

    return true;
  }

  async function onButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const existingWindow = getPiPWindow();
    if (existingWindow && !existingWindow.closed) {
      existingWindow.close();
      return;
    }

    try {
      await openPiP();
    } catch (error) {
      console.warn('[YouTube Live PiP] Failed to open PiP window.', error);
    }
  }

  async function openPiP() {
    const mode = detectPageMode();
    if (mode === null) return;
    const withChat = mode !== 'vod';

    const videoId = new URL(location.href).searchParams.get('v');
    const video = document.querySelector('video.html5-main-video');
    if (!video || !videoId || !supportsDocumentPiP()) return;

    const videoHome = video.parentNode;
    const videoNextSibling = video.nextSibling;
    const videoStyleBackup = video.getAttribute('style');

    const restoreVideo = () => {
      if (!videoHome || video.parentNode === videoHome) return;

      if (videoNextSibling && videoNextSibling.parentNode === videoHome) {
        videoHome.insertBefore(video, videoNextSibling);
      } else {
        videoHome.appendChild(video);
      }

      if (videoStyleBackup === null) {
        video.removeAttribute('style');
      } else {
        video.setAttribute('style', videoStyleBackup);
      }
    };

    let pipWindow;
    let restoreChat = () => {};
    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: withChat ? PIP_WIDTH : PIP_VIDEO_WIDTH,
        height: withChat ? PIP_HEIGHT : PIP_VIDEO_HEIGHT
      });

      setupPiPDocument(pipWindow);

      const root = pipWindow.document.createElement('div');
      root.className = withChat ? 'ytpip-root' : 'ytpip-root ytpip-no-chat';
      pipWindow.document.body.appendChild(root);

      const stage = pipWindow.document.createElement('div');
      stage.className = 'ytpip-stage';
      stage.appendChild(video);
      video.style.cssText = 'width:100%;height:100%;display:block;object-fit:contain;background:#000;';
      root.appendChild(stage);

      if (!window.YtPipControls || typeof window.YtPipControls.mount !== 'function') {
        throw new Error('YtPipControls.mount is not available');
      }

      window.YtPipControls.mount(pipWindow, stage, video, mode);

      if (withChat) {
        const chatFrame = createChatFrame(pipWindow, videoId, mode);
        restoreChat = chatFrame.restore;
        root.appendChild(chatFrame.element);
      }

      pipWindow.addEventListener('pagehide', () => {
        restoreVideo();
        restoreChat();
      }, { once: true });
    } catch (error) {
      restoreVideo();
      restoreChat();
      if (pipWindow && !pipWindow.closed) {
        pipWindow.close();
      }
      throw error;
    }
  }

  function setupPiPDocument(pipWindow) {
    injectStylesheet(pipWindow, chrome.runtime.getURL('src/pip-controls.css'));
    pipWindow.document.title = 'YouTube Live PiP';
    pipWindow.document.body.style.cssText =
      'margin:0;background:#0f0f0f;color:#fff;color-scheme:dark;font-family:Roboto,Arial,sans-serif;';
  }

  function createChatFrame(pipWindow, videoId, mode) {
    if (document.querySelector('ytd-live-chat-frame#chat') || latestChatMessages.length > 0) {
      return createMirroredChat(pipWindow, mode);
    }

    const chatPath = mode === 'live' ? 'live_chat' : 'live_chat_replay';
    return createPiPChatFrame(pipWindow, createFallbackChatUrl(chatPath, videoId), mode);
  }

  function createPiPChatFrame(pipWindow, chatUrl, mode) {
    const chat = pipWindow.document.createElement('iframe');
    chat.className = 'ytpip-chat';
    chat.src = chatUrl;
    chat.allow = 'autoplay; encrypted-media';
    chat.title = mode === 'live' ? 'YouTube live chat' : 'YouTube live chat replay';
    return {
      element: chat,
      restore() {}
    };
  }

  function createMirroredChat(pipWindow, mode) {
    const chat = pipWindow.document.createElement('section');
    chat.className = 'ytpip-chat ytpip-chat-mirror';
    chat.setAttribute('aria-label', mode === 'live' ? 'ライブチャット' : 'チャットのリプレイ');

    const title = pipWindow.document.createElement('div');
    title.className = 'ytpip-chat-title';
    title.textContent = mode === 'live' ? 'ライブチャット' : 'チャットのリプレイ';

    const list = pipWindow.document.createElement('div');
    list.className = 'ytpip-chat-list';
    list.setAttribute('role', 'log');
    list.setAttribute('aria-live', 'polite');

    chat.append(title, list);

    const render = (messages) => {
      renderChatMessages(pipWindow, list, messages);
    };
    const subscriber = (messages) => render(messages);
    chatSubscribers.add(subscriber);
    render(latestChatMessages);

    return {
      element: chat,
      restore() {
        chatSubscribers.delete(subscriber);
      }
    };
  }

  function getChatObserveTarget(sourceDocument) {
    return (
      sourceDocument.querySelector('yt-live-chat-item-list-renderer #items') ||
      queryDeepAll(sourceDocument, '#items, yt-live-chat-item-list-renderer').at(-1) ||
      sourceDocument.body ||
      sourceDocument.documentElement
    );
  }

  function getChatMessages(root) {
    // 通常は light DOM の querySelectorAll で全件取れる（高速・実測で deep 走査と同件数）。
    // YouTube が #items を shadow root 下へ移す形に変わった場合のみ、
    // getChatObserveTarget と整合する deep 走査にフォールバックする。
    const direct = root.querySelectorAll(CHAT_MESSAGE_SELECTOR);
    const nodes = direct.length > 0 ? Array.from(direct) : queryDeepAll(root, CHAT_MESSAGE_SELECTOR);
    return nodes
      .slice(-MAX_MIRRORED_MESSAGES)
      .map(readChatMessage)
      .filter((message) => message.author || message.body || message.bodyParts.length > 0);
  }

  function readAuthorType(renderer) {
    const raw = (renderer.getAttribute('author-type') || '').trim().toLowerCase();
    if (AUTHOR_TYPES.includes(raw)) return raw;

    const nameEl = renderer.querySelector('#author-name');
    const nameType = (nameEl?.getAttribute('type') || '').trim().toLowerCase();
    if (AUTHOR_TYPES.includes(nameType)) return nameType;

    for (const type of AUTHOR_TYPES) {
      if (nameEl?.classList.contains(type)) return type;
    }

    return '';
  }

  function readAuthorBadges(renderer) {
    const container =
      renderer.querySelector('#chat-badges') ||
      renderer.querySelector('#author-badges') ||
      renderer;
    const badges = Array.from(container.querySelectorAll('yt-live-chat-author-badge-renderer'));

    return badges
      .map((badge) => {
        const type = (badge.getAttribute('type') || '').trim().toLowerCase();
        const label = (
          badge.getAttribute('aria-label') ||
          badge.getAttribute('shared-tooltip-text') ||
          readText(badge.querySelector('#tooltip')) ||
          ''
        ).trim();
        const imgEl =
          type === 'member'
            ? badge.querySelector('#image img, img#img, #image yt-img-shadow img')
            : null;
        const rawSrc = imgEl?.getAttribute('src') || imgEl?.src || '';
        const iconUrl = /^https:\/\//i.test(rawSrc) ? rawSrc : '';
        return { type, label, iconUrl };
      })
      .filter((badge) => badge.type || badge.iconUrl || badge.label);
  }

  function readMessageContent(root) {
    const parts = [];
    if (!root) return parts;

    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent) parts.push({ type: 'text', text: child.textContent });
        } else if (child.nodeName === 'IMG') {
          const alt = child.getAttribute('alt') || '';
          const src = child.getAttribute('src') || child.src || '';
          parts.push({ type: 'emoji', alt, url: /^https:\/\//i.test(src) ? src : '' });
        } else if (child.childNodes && child.childNodes.length > 0) {
          walk(child);
        }
      }
    };
    walk(root);

    return parts;
  }

  // 描画に使う全フィールドを織り込む。絵文字 url・バッジ・authorType の変化も
  // キーに反映され、再描画（無変化スキップ解除・ノード再生成）が走るようにする。
  function messageKey(message) {
    return JSON.stringify([
      message.time,
      message.author,
      message.authorType,
      message.badges,
      message.bodyParts,
      message.body
    ]);
  }

  // 同一内容メッセージ（絵文字のみ・空キー等）が衝突しないよう出現順に連番で一意化する。
  function buildMessageKeys(messages) {
    const seen = new Map();
    return messages.map((message) => {
      const base = messageKey(message);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      return n === 0 ? base : base + '#' + n;
    });
  }

  // 古い行の編集・更新も取りこぼさないよう全件のキーで署名する。
  function messagesSignature(messages) {
    return messages.length + ':' + buildMessageKeys(messages).join('|');
  }

  function readChatMessage(renderer) {
    const bodyParts = readMessageContent(renderer.querySelector('#message'));
    const body = bodyParts.length > 0
      ? ''
      : (
          readText(renderer.querySelector('#purchase-amount')) ||
          readText(renderer.querySelector('#header-subtext')) ||
          readText(renderer)
        );

    return {
      time: readText(renderer.querySelector('#timestamp')),
      author: readText(renderer.querySelector('#author-name, #author-text')),
      authorType: readAuthorType(renderer),
      badges: readAuthorBadges(renderer),
      bodyParts,
      body
    };
  }

  function renderChatMessages(pipWindow, list, messages) {
    if (messages.length === 0) {
      const empty = pipWindow.document.createElement('div');
      empty.className = 'ytpip-chat-empty';
      empty.textContent = 'チャットを読み込み中';
      list.replaceChildren(empty);
      return;
    }

    // DOM 変更前に「最下部付着中か」を 1 回だけ読み取る（レイアウトスラッシング回避）。
    const stick =
      list.scrollHeight - list.scrollTop - list.clientHeight < SCROLL_STICK_THRESHOLD;

    const newKeys = buildMessageKeys(messages);
    const newKeySet = new Set(newKeys);

    // 新スナップショットに無い既存ノード（押し出された古いメッセージや empty）を除去。
    for (const child of Array.from(list.children)) {
      if (!child.dataset.key || !newKeySet.has(child.dataset.key)) {
        child.remove();
      }
    }

    const existing = new Map();
    for (const child of list.children) {
      existing.set(child.dataset.key, child);
    }

    // 既存ノードは可能な限り再利用し、新規分だけ生成して順序を揃える（in-place 差分）。
    let ref = list.firstChild;
    for (let i = 0; i < messages.length; i++) {
      let item = existing.get(newKeys[i]);
      if (item) {
        existing.delete(newKeys[i]);
      } else {
        item = createChatMessageElement(pipWindow, messages[i]);
        item.dataset.key = newKeys[i];
      }
      if (ref === item) {
        ref = ref.nextSibling;
      } else {
        list.insertBefore(item, ref);
      }
    }

    if (stick) {
      list.scrollTop = list.scrollHeight;
    }
  }

  function createChatMessageElement(pipWindow, message) {
    const doc = pipWindow.document;
    const item = doc.createElement('div');
    item.className = 'ytpip-chat-item';
    if (message.authorType) {
      item.classList.add('ytpip-author-' + message.authorType);
    }

    const meta = doc.createElement('div');
    meta.className = 'ytpip-chat-meta';

    if (message.time) {
      const time = doc.createElement('span');
      time.className = 'ytpip-chat-time';
      time.textContent = message.time;
      meta.appendChild(time);
    }

    if (message.author) {
      const author = doc.createElement('span');
      author.className = 'ytpip-chat-author';
      author.textContent = message.author;
      meta.appendChild(author);

      for (const badge of message.badges || []) {
        meta.appendChild(createBadgeElement(doc, badge));
      }
    }

    const body = doc.createElement('div');
    body.className = 'ytpip-chat-message';
    appendMessageBody(doc, body, message);

    if (meta.children.length > 0) {
      item.appendChild(meta);
    }
    item.appendChild(body);

    return item;
  }

  function createBadgeElement(doc, badge) {
    const el = doc.createElement('span');
    el.className = 'ytpip-badge';
    if (/^[a-z-]+$/.test(badge.type)) el.classList.add('ytpip-badge-' + badge.type);
    if (badge.label) el.title = badge.label;

    if (badge.type === 'member' && badge.iconUrl) {
      const img = doc.createElement('img');
      img.className = 'ytpip-badge-img';
      img.src = badge.iconUrl;
      img.alt = badge.label || 'member';
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        const glyph = doc.createElement('span');
        glyph.className = 'ytpip-badge-glyph';
        glyph.textContent = BADGE_GLYPH.member;
        img.replaceWith(glyph);
      }, { once: true });
      el.appendChild(img);
    } else {
      const glyph = doc.createElement('span');
      glyph.className = 'ytpip-badge-glyph';
      glyph.textContent = BADGE_GLYPH[badge.type] || '•';
      el.appendChild(glyph);
    }

    return el;
  }

  function appendMessageBody(doc, body, message) {
    const parts = message.bodyParts || [];
    if (parts.length === 0) {
      body.textContent = message.body;
      return;
    }

    for (const part of parts) {
      if (part.type === 'emoji' && part.url) {
        const img = doc.createElement('img');
        img.className = 'ytpip-emoji';
        img.src = part.url;
        img.alt = part.alt || '';
        img.title = part.alt || '';
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('error', () => {
          img.replaceWith(doc.createTextNode(part.alt || ''));
        }, { once: true });
        body.appendChild(img);
      } else if (part.type === 'emoji') {
        body.appendChild(doc.createTextNode(part.alt || ''));
      } else {
        body.appendChild(doc.createTextNode(part.text));
      }
    }
  }

  function queryDeepAll(root, selector) {
    const matches = Array.from(root.querySelectorAll(selector));

    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        matches.push(...queryDeepAll(element.shadowRoot, selector));
      }
    }

    return matches;
  }

  function readText(element) {
    return (element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function createFallbackChatUrl(chatPath, videoId) {
    const chatUrl = new URL(`https://www.youtube.com/${chatPath}`);
    chatUrl.searchParams.set('v', videoId);
    chatUrl.searchParams.set('embed_domain', location.hostname);
    chatUrl.searchParams.set('is_popout', '1');
    return chatUrl.toString();
  }

  function isChatFramePage() {
    return location.pathname === '/live_chat' || location.pathname === '/live_chat_replay';
  }

  function initChatBridge() {
    const mode = location.pathname === '/live_chat' ? 'live' : 'archive';
    const observeOptions = { childList: true, subtree: true };
    let observeTarget = getChatObserveTarget(document);
    let throttleTimer = 0;
    let lastRun = 0;
    let observer;

    const publish = () => {
      throttleTimer = 0;
      lastRun = Date.now();
      // 監視対象が配信切替・SPA 遷移で作り直されたら、再探索して observe し直す。
      if (!observeTarget || !observeTarget.isConnected) {
        observeTarget = getChatObserveTarget(document);
        observer.disconnect();
        observer.observe(observeTarget, observeOptions);
      }
      const messages = getChatMessages(document);
      window.parent.postMessage({
        source: MESSAGE_CHANNEL,
        type: 'chat-messages',
        mode,
        messages
      }, location.origin);
    };

    // leading + trailing の時間スロットル。バースト中に毎フレーム走るのを防ぐ。
    const queuePublish = () => {
      if (throttleTimer) return;
      const wait = Math.max(0, PUBLISH_THROTTLE_MS - (Date.now() - lastRun));
      if (wait === 0) {
        publish();
      } else {
        throttleTimer = window.setTimeout(publish, wait);
      }
    };

    observer = new MutationObserver(queuePublish);
    observer.observe(observeTarget, observeOptions);

    const pollTimer = window.setInterval(queuePublish, 1000);
    window.addEventListener('pagehide', () => {
      observer.disconnect();
      window.clearInterval(pollTimer);
      if (throttleTimer) window.clearTimeout(throttleTimer);
    }, { once: true });

    publish();
  }

  function onChatBridgeMessage(event) {
    if (event.origin !== location.origin) return;

    const data = event.data;
    if (
      !data ||
      data.source !== MESSAGE_CHANNEL ||
      data.type !== 'chat-messages' ||
      !Array.isArray(data.messages)
    ) {
      return;
    }

    const mode = detectPageMode();
    if ((mode === 'live' || mode === 'archive') && data.mode !== mode) return;

    const messages = data.messages.slice(-MAX_MIRRORED_MESSAGES);
    const signature = messagesSignature(messages);
    if (signature === latestChatSignature) return;

    latestChatSignature = signature;
    latestChatMessages = messages;
    for (const subscriber of chatSubscribers) {
      subscriber(latestChatMessages);
    }
  }

  function injectStylesheet(pipWindow, url) {
    const link = pipWindow.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    pipWindow.document.head.appendChild(link);
  }

  function tryInjectWithRetry(maxAttempts = RETRY_ATTEMPTS, intervalMs = RETRY_INTERVAL_MS) {
    clearInterval(retryTimer);

    let attempts = 0;
    const tick = () => {
      const injected = injectButton();
      // vod は live/archive シグナル (.ytp-live / chat frame) が未確定の途中段階でも
      // 該当しうるため、確定モードになるまで polling を続けて早期停止しない。
      // これにより archive のチャット枠が遅れて挿入されてもボタンが追従する。
      const settled = injected && detectPageMode() !== 'vod';
      if (settled || attempts >= maxAttempts) {
        clearInterval(retryTimer);
        retryTimer = 0;
      }
    };

    retryTimer = window.setInterval(() => {
      attempts += 1;
      tick();
    }, intervalMs);

    tick();
  }

  function onNavigate() {
    const pipWindow = getPiPWindow();
    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
    }

    removeButton();
    tryInjectWithRetry();
  }

  function init() {
    if (isChatFramePage()) {
      initChatBridge();
      return;
    }

    if (window.top !== window) return;

    window.addEventListener('message', onChatBridgeMessage);
    document.addEventListener('yt-navigate-finish', onNavigate);
    document.addEventListener('yt-page-data-updated', () => tryInjectWithRetry());
    tryInjectWithRetry();
  }

  init();
})();
