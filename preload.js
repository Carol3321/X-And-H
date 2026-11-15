// 后台预加载：烟花播放期间准备 模型 与 100 张照片
// 策略：模型(字节) → 缩略图(下载+解码，供树上挂图) → 高清图(只下字节，树用到时再解码)
(function () {
  'use strict';
  const CONCURRENCY_THUMB = 6;
  const CONCURRENCY_FULL = 6;

  // 只把字节拉进 HTTP 缓存，不解码（高清图解码交给树，避免抢烟花 CPU）
  async function fetchBytes(urls, concurrency) {
    let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const u = urls[i++];
        try { await fetch(u); } catch (e) { /* 失败不阻塞 */ }
        await new Promise(r => setTimeout(r, 0));
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  // 下载 + 解码（缩略图只有 512px，解码开销小，解完树挂图秒出）
  async function fetchDecoded(urls, concurrency, onProgress) {
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
        await new Promise(r => setTimeout(r, 0));
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

      // 1) 模型（任务A）—— 优先，树的手势要用
      await fetchBytes([
        'assets/hand_landmarker.task',
        'assets/wasm/vision_wasm_internal.wasm',
        'assets/wasm/vision_wasm_internal.js',
        'assets/bundle.js'
      ], 2);
      S.model = true;
      console.log('[preload] 模型完成');

      // 2) 照片（任务B）—— 缩略图先下完并解码（树上要挂），再下高清图字节
      try {
        const res = await fetch('assets/photos/manifest.json');
        const data = await res.json();
        const photos = (data && data.photos) || [];
        S.total = photos.length;
        const thumbs = photos.map(p => 'assets/photos/' + p.thumb);
        const fulls = photos.map(p => 'assets/photos/' + p.full);

        await fetchDecoded(thumbs, CONCURRENCY_THUMB, () => S.thumbs++);
        console.log('[preload] 缩略图完成 ' + S.thumbs + '/' + S.total);

        await fetchBytes(fulls, CONCURRENCY_FULL);
        S.fulls = S.total;
        console.log('[preload] 高清图文件完成 ' + S.fulls + '/' + S.total);
      } catch (e) { console.warn('[preload] 照片预加载失败', e); }

      S.done = true;
      console.log('[preload] 全部完成');
    }
  };
})();
