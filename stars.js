// 星空背景：深蓝黑底 + 轻微闪烁/漂浮的星点
(function () {
  'use strict';
  const canvas = document.getElementById('stars');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, stars = [];

  function resize() {
    W = canvas.width = Math.max(1, window.innerWidth);
    H = canvas.height = Math.max(1, window.innerHeight);
    const n = Math.floor((W * H) / 9000);
    stars = [];
    for (let i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: 0.4 + Math.random() * 1.4,
        tw: Math.random() * Math.PI * 2,
        sp: 0.5 + Math.random() * 1.6,
        alpha: 0.25 + Math.random() * 0.6
      });
    }
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      const a = s.alpha * (0.55 + 0.45 * Math.sin(t * s.sp + s.tw));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fill();
    }
  }

  let raf;
  function loop(t) {
    draw(t / 1000);
    raf = requestAnimationFrame(loop);
  }

  resize();
  window.addEventListener('resize', resize, { passive: true });
  raf = requestAnimationFrame(loop);

  window.__stars = {
    boost() {  // 点击后星光增强：临时整体变亮
      for (const s of stars) s.alpha = Math.min(1, s.alpha * 1.6);
    }
  };
})();
