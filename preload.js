// 后台预加载：烟花播放期间下载+解码 模型 与 100 张照片（写入 HTTP 缓存，供照片树直接命中）
(function () {
  'use strict';
  const CONCURRENCY_THUMB = 6;
  const CONCURRENCY_FULL = 4;

  async function fetchAll(urls, concurrency) {
    let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const u = urls[i++];
        try { await fetch(u); } catch (e) { /* 失败不阻塞 */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  }

  // 下载 + 解码图片：既暖 HTTP 缓存，也暖浏览器解码缓存
  async function prefetchImages(urls, concurrency, onProgress) {
    let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const u = urls[i++];
        try {
          const img = new Image();
          img.src = u;
          await img.decode();
          if (onProgress) onProgress();
        } catch (e) { /* 单张失败不影响整体 */ }
        await new Promise(r => setTimeout(r, 0));   // 让出主线程，避免卡烟花
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  window.__preload = {
    status: { model: false, thumbs: 0, fulls: 0, total: 0, done: false },

    async run() {
      const S = this.status;
      if (S.running) return;
      S.running = true;

      // 1) 模型（任务A）—— 优先
      await fetchAll([
        'assets/hand_landmarker.task',
        'assets/wasm/vision_wasm_internal.wasm',
        'assets/wasm/vision_wasm_internal.js',
        'assets/bundle.js'
      ], 2);
      S.model = true;

      // 2) 照片（任务B）—— 先全部缩略图（树要挂图），再高清展示档
      try {
        const res = await fetch('assets/photos/manifest.json');
        const data = await res.json();
        const photos = (data && data.photos) || [];
        S.total = photos.length;
        const thumbs = photos.map(p => 'assets/photos/' + p.thumb);
        const fulls = photos.map(p => 'assets/photos/' + p.full);
        await prefetchImages(thumbs, CONCURRENCY_THUMB, () => S.thumbs++);
        await prefetchImages(fulls, CONCURRENCY_FULL, () => S.fulls++);
      } catch (e) { /* manifest 缺失不阻塞 */ }

      S.done = true;
    }
  };
})();
