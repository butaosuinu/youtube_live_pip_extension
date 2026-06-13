window.YtPipControls = (function () {
  'use strict';

  function mount(pipWindow, stage, video, mode) {
    const doc = pipWindow.document;
    const cleanupTasks = [];

    const bar = doc.createElement('div');
    bar.className = 'ytpip-controls';
    bar.innerHTML = [
      '<button class="ytpip-btn ytpip-play" type="button" aria-label="再生/一時停止">',
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"></svg>',
      '</button>',
      '<div class="ytpip-time" data-time></div>',
      '<input class="ytpip-seek" type="range" min="0" max="100" step="0.1" value="0" data-seek aria-label="シーク">',
      '<button class="ytpip-live-indicator" type="button" data-live aria-label="最新の位置に移動">LIVE</button>',
      '<button class="ytpip-btn ytpip-mute" type="button" aria-label="ミュート">',
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"></svg>',
      '</button>',
      '<input class="ytpip-volume" type="range" min="0" max="1" step="0.01" value="1" data-volume aria-label="音量">'
    ].join('');
    stage.appendChild(bar);

    const playButton = bar.querySelector('.ytpip-play');
    const muteButton = bar.querySelector('.ytpip-mute');
    const volume = bar.querySelector('[data-volume]');
    const seek = bar.querySelector('[data-seek]');
    const time = bar.querySelector('[data-time]');
    const liveBadge = bar.querySelector('[data-live]');

    if (mode === 'live') {
      seek.hidden = true;
      time.hidden = true;
    } else {
      liveBadge.hidden = true;
    }

    const on = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      cleanupTasks.push(() => target.removeEventListener(type, handler, options));
    };

    const updatePlayIcon = () => {
      playButton.querySelector('svg').innerHTML = video.paused
        ? '<path d="M8 5v14l11-7z" fill="#fff"/>'
        : '<path d="M6 5h4v14H6zm8 0h4v14h-4z" fill="#fff"/>';
    };

    const togglePlayback = () => {
      if (video.paused) {
        void video.play().catch(() => {});
      } else {
        video.pause();
      }
    };

    const updateMuteIcon = () => {
      muteButton.querySelector('svg').innerHTML = video.muted || video.volume === 0
        ? [
            '<path d="M4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3c-.7.5-1.4.9-2.3 1.1v2.1c1.4-.3 2.6-.9 3.7-1.8l2 2L21 19.7 5.6 4.3 4.3 3z" fill="#fff"/>',
            '<path d="M12 4 9.9 6.1 12 8.2V4zm7 8c0 .9-.2 1.8-.5 2.6l1.5 1.5c.6-1.2 1-2.6 1-4.1 0-4.3-3-7.9-7-8.8v2.1c2.9.8 5 3.5 5 6.7zm-2.5 0c0 .2 0 .4-.1.6L14 10.2V8c1.5.7 2.5 2.2 2.5 4z" fill="#fff"/>'
          ].join('')
        : '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8c1.5-.7 2.5-2.2 2.5-4zM14 3.2v2.1c2.9.9 5 3.5 5 6.7s-2.1 5.8-5 6.7v2.1c4-.9 7-4.5 7-8.8s-3-7.9-7-8.8z" fill="#fff"/>';
    };

    const updateVolume = () => {
      volume.value = String(video.muted ? 0 : video.volume);
      updateMuteIcon();
    };

    const setVolume = () => {
      video.volume = Number.parseFloat(volume.value);
      if (video.volume > 0) {
        video.muted = false;
      }
      updateMuteIcon();
    };

    const updateSeek = () => {
      if (!Number.isFinite(video.duration)) return;

      seek.max = String(video.duration);
      if (!seek.dataset.dragging) {
        seek.value = String(video.currentTime);
      }
      time.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    };

    const setSeekDragging = () => {
      seek.dataset.dragging = '1';
    };

    const clearSeekDragging = () => {
      delete seek.dataset.dragging;
    };

    const seekVideo = () => {
      const nextTime = Number.parseFloat(seek.value);
      if (Number.isFinite(nextTime)) {
        video.currentTime = nextTime;
      }
    };

    // しきい値: ライブエッジから何秒遅れたら「最新ではない」とみなすか
    const LIVE_BEHIND_THRESHOLD_SEC = 10;
    let lastLiveCheck = 0;

    const nativeLiveBadge = () => document.querySelector('#movie_player .ytp-live-badge');

    const goToLive = () => {
      const ranges = video.seekable;
      if (ranges && ranges.length > 0) {
        const liveEdge = ranges.end(ranges.length - 1);
        if (Number.isFinite(liveEdge)) {
          video.currentTime = liveEdge;
          if (video.paused) {
            void video.play().catch(() => {});
          }
          return;
        }
      }
      // フォールバック: ネイティブのライブバッジをクリック
      nativeLiveBadge()?.click();
    };

    const isBehindLive = () => {
      const ranges = video.seekable;
      if (ranges && ranges.length > 0) {
        const edge = ranges.end(ranges.length - 1);
        if (Number.isFinite(edge)) {
          return edge - video.currentTime > LIVE_BEHIND_THRESHOLD_SEC;
        }
      }
      // seekable が空のときだけネイティブバッジのクラスを参照
      const badge = nativeLiveBadge();
      return badge ? !badge.classList.contains('ytp-live-badge-is-livehead') : false;
    };

    const updateLiveState = () => {
      const now = performance.now();
      if (now - lastLiveCheck < 1000) return; // 1秒スロットル
      lastLiveCheck = now;
      liveBadge.classList.toggle('ytpip-behind', isBehindLive());
    };

    // 一時停止中は timeupdate が発火しないため、その間だけ定期的に遅延状態を見直す
    let liveTicker = 0;
    const startLiveTicker = () => {
      if (liveTicker) return;
      liveTicker = pipWindow.setInterval(updateLiveState, 2000);
    };
    const stopLiveTicker = () => {
      if (!liveTicker) return;
      pipWindow.clearInterval(liveTicker);
      liveTicker = 0;
    };

    let hideTimer = 0;
    const showControls = () => {
      bar.classList.add('visible');
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (!bar.matches(':focus-within')) {
          bar.classList.remove('visible');
        }
      }, 2500);
    };

    on(playButton, 'click', togglePlayback);
    on(video, 'play', updatePlayIcon);
    on(video, 'pause', updatePlayIcon);

    on(muteButton, 'click', () => {
      video.muted = !video.muted;
    });
    on(volume, 'input', setVolume);
    on(video, 'volumechange', updateVolume);

    if (mode === 'live') {
      on(liveBadge, 'click', goToLive);
      on(video, 'timeupdate', updateLiveState);
      on(video, 'seeked', updateLiveState); // 最新化直後に即時反映
      on(video, 'pause', startLiveTicker); // 一時停止中も遅延を検知できるように
      on(video, 'play', stopLiveTicker);
      cleanupTasks.push(stopLiveTicker); // pagehide でタイマーを確実に停止
      if (video.paused) startLiveTicker(); // 既に一時停止状態で開いた場合
      updateLiveState(); // 初期状態
    } else {
      on(video, 'timeupdate', updateSeek);
      on(video, 'durationchange', updateSeek);
      on(video, 'loadedmetadata', updateSeek);
      on(seek, 'pointerdown', setSeekDragging);
      on(doc, 'pointerup', clearSeekDragging);
      on(seek, 'input', seekVideo);
      updateSeek();
    }

    on(stage, 'pointermove', showControls);
    on(stage, 'pointerenter', showControls);
    on(bar, 'focusin', showControls);

    on(pipWindow, 'pagehide', () => {
      clearTimeout(hideTimer);
      while (cleanupTasks.length > 0) {
        cleanupTasks.pop()();
      }
    }, { once: true });

    updatePlayIcon();
    updateVolume();
    showControls();
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '0:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs}`;
    }

    return `${minutes}:${secs}`;
  }

  return { mount };
})();
