(function () {
  'use strict';

  const BUTTON_ID = 'yt-live-pip-button';
  const SCRIPT_VERSION = 'chat-bridge-v1';
  const RETRY_ATTEMPTS = 20;
  const RETRY_INTERVAL_MS = 500;
  const PIP_WIDTH = 480;
  const PIP_HEIGHT = 760;
  const MESSAGE_CHANNEL = 'yt-live-pip-with-chat';
  const CHAT_MESSAGE_SELECTOR = [
    'yt-live-chat-text-message-renderer',
    'yt-live-chat-paid-message-renderer',
    'yt-live-chat-paid-sticker-renderer',
    'yt-live-chat-membership-item-renderer',
    'yt-live-chat-viewer-engagement-message-renderer'
  ].join(',');
  const MAX_MIRRORED_MESSAGES = 80;
  const AUTHOR_TYPES = ['owner', 'moderator', 'member', 'verified'];
  const BADGE_GLYPH = { owner: '★', moderator: '🛡', member: '★', verified: '✓' };

  let retryTimer = 0;
  let latestChatMessages = [];
  const chatSubscribers = new Set();

  function detectPageMode() {
    if (location.pathname !== '/watch') return null;

    const isLive = Boolean(document.querySelector('.ytp-live'));
    const hasChat = Boolean(document.querySelector('ytd-live-chat-frame#chat'));

    if (isLive) return 'live';
    if (hasChat) return 'archive';
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
    if ((mode !== 'live' && mode !== 'archive') || !supportsDocumentPiP()) {
      removeButton();
      return false;
    }

    const rightControls = document.querySelector('.ytp-right-controls');
    if (!rightControls) return false;

    const existingButton = rightControls.querySelector(`#${BUTTON_ID}`);
    if (existingButton?.dataset.ytLivePipVersion === SCRIPT_VERSION) return true;
    existingButton?.remove();

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.className = 'ytp-button';
    button.type = 'button';
    button.dataset.ytLivePipVersion = SCRIPT_VERSION;
    button.title = 'チャット付き PiP で表示';
    button.setAttribute('aria-label', 'チャット付き PiP で表示');
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
    if (mode !== 'live' && mode !== 'archive') return;

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
        width: PIP_WIDTH,
        height: PIP_HEIGHT
      });

      setupPiPDocument(pipWindow);

      const root = pipWindow.document.createElement('div');
      root.className = 'ytpip-root';
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
      const chatFrame = createChatFrame(pipWindow, videoId, mode);
      restoreChat = chatFrame.restore;
      root.appendChild(chatFrame.element);

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
      queryDeepAll(sourceDocument, '#items, yt-live-chat-item-list-renderer').at(-1) ||
      sourceDocument.body ||
      sourceDocument.documentElement
    );
  }

  function getChatMessages(sourceDocument) {
    return queryDeepAll(sourceDocument, CHAT_MESSAGE_SELECTOR)
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
        const imgEl = badge.querySelector('#image img, img#img, #image yt-img-shadow img');
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

  function partsToText(parts) {
    return parts
      .map((part) => (part.type === 'text' ? part.text : part.alt || ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function readChatMessage(renderer) {
    const bodyParts = readMessageContent(renderer.querySelector('#message'));
    const body = bodyParts.length > 0
      ? partsToText(bodyParts)
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
    const fragment = pipWindow.document.createDocumentFragment();

    if (messages.length === 0) {
      const empty = pipWindow.document.createElement('div');
      empty.className = 'ytpip-chat-empty';
      empty.textContent = 'チャットを読み込み中';
      fragment.appendChild(empty);
    }

    for (const message of messages) {
      fragment.appendChild(createChatMessageElement(pipWindow, message));
    }

    list.replaceChildren(fragment);
    list.scrollTop = list.scrollHeight;
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
    return (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
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
    let publishQueued = false;

    const publish = () => {
      publishQueued = false;
      const messages = getChatMessages(document);
      window.parent.postMessage({
        source: MESSAGE_CHANNEL,
        type: 'chat-messages',
        mode,
        messages
      }, location.origin);
    };

    const queuePublish = () => {
      if (publishQueued) return;
      publishQueued = true;
      requestAnimationFrame(publish);
    };

    const observer = new MutationObserver(queuePublish);
    observer.observe(getChatObserveTarget(document), {
      childList: true,
      subtree: true,
      characterData: true
    });

    const pollTimer = window.setInterval(queuePublish, 1000);
    window.addEventListener('pagehide', () => {
      observer.disconnect();
      window.clearInterval(pollTimer);
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

    latestChatMessages = data.messages.slice(-MAX_MIRRORED_MESSAGES);
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
    retryTimer = window.setInterval(() => {
      attempts += 1;
      if (injectButton() || attempts >= maxAttempts) {
        clearInterval(retryTimer);
        retryTimer = 0;
      }
    }, intervalMs);

    injectButton();
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
