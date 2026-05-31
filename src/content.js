(function () {
  'use strict';

  const BUTTON_ID = 'yt-live-pip-button';
  const RETRY_ATTEMPTS = 20;
  const RETRY_INTERVAL_MS = 500;
  const PIP_WIDTH = 480;
  const PIP_HEIGHT = 760;

  let retryTimer = 0;

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

    if (rightControls.querySelector(`#${BUTTON_ID}`)) return true;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.className = 'ytp-button';
    button.type = 'button';
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
      root.appendChild(createChatFrame(pipWindow, videoId, mode));

      pipWindow.addEventListener('pagehide', restoreVideo, { once: true });
    } catch (error) {
      restoreVideo();
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
    const chatPath = mode === 'live' ? 'live_chat' : 'live_chat_replay';
    const chatUrl = new URL(`https://www.youtube.com/${chatPath}`);
    chatUrl.searchParams.set('v', videoId);
    chatUrl.searchParams.set('embed_domain', location.hostname);
    chatUrl.searchParams.set('is_popout', '1');

    const chat = pipWindow.document.createElement('iframe');
    chat.className = 'ytpip-chat';
    chat.src = chatUrl.toString();
    chat.allow = 'autoplay; encrypted-media';
    chat.title = mode === 'live' ? 'YouTube live chat' : 'YouTube live chat replay';
    return chat;
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
    document.addEventListener('yt-navigate-finish', onNavigate);
    document.addEventListener('yt-page-data-updated', () => tryInjectWithRetry());
    tryInjectWithRetry();
  }

  init();
})();
