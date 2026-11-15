(() => {
  'use strict';

  const canvas = document.getElementById('sky');
  let running = false;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const TAU = Math.PI * 2;
  const rand = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pick = a => a[(Math.random() * a.length) | 0];

  const COLOR = {
    magenta:   { rgb: [255, 24, 172] },
    rose:      { rgb: [255, 55, 116] },
    deepRed:   { rgb: [222, 16, 55] },
    orangeRed: { rgb: [255, 74, 32] },
    gold:      { rgb: [255, 183, 55] },
    warmWhite: { rgb: [255, 226, 178] },
    white:     { rgb: [244, 250, 255] },
    cyan:      { rgb: [48, 231, 255] },
    blue:      { rgb: [42, 119, 255] },
    violet:    { rgb: [174, 58, 255] },
    lime:      { rgb: [188, 255, 82] },
    pinkWhite: { rgb: [255, 188, 224] }
  };

  const HEART_COLORS = [COLOR.magenta, COLOR.rose, COLOR.deepRed];
  const PEONY_COLORS = [COLOR.orangeRed, COLOR.gold, COLOR.rose, COLOR.deepRed];
  const RAY_COLORS = [COLOR.blue, COLOR.cyan, COLOR.white, COLOR.warmWhite, COLOR.pinkWhite, COLOR.magenta];
  const STAR_COLORS = [COLOR.white, COLOR.cyan, COLOR.pinkWhite];
  const EMBER_COLORS = [COLOR.rose, COLOR.magenta, COLOR.pinkWhite, COLOR.white, COLOR.warmWhite];
  const TYPES = ['heart', 'heart', 'heart', 'chrys', 'chrys', 'peony', 'willow', 'star', 'ring', 'double'];

  let W = 1, H = 1, DPR = 1, focal = 800;
  let quality = 1;
  let maxParticles = 8500;
  let maxEmbers = 3000;
  let minEmbers = 1900;
  let mobile = false;
  let simTime = 0;
  let nextLaunch = 0.9;
  let lastTime = performance.now();
  let slowFrames = 0;

  const particles = [];
  const rockets = [];
  const embers = [];
  const flashes = [];
  const sprites = new Map();

  for (const color of Object.values(COLOR)) {
    color.css = `rgb(${color.rgb[0]},${color.rgb[1]},${color.rgb[2]})`;
  }

  function glowSprite(color) {
    if (sprites.has(color)) return sprites.get(color);
    const s = document.createElement('canvas');
    s.width = s.height = 96;
    const g = s.getContext('2d');
    const [r, green, blue] = color.rgb;
    const gradient = g.createRadialGradient(48, 48, 0, 48, 48, 48);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.075, 'rgba(255,252,246,0.98)');
    gradient.addColorStop(0.18, `rgba(${r},${green},${blue},0.88)`);
    gradient.addColorStop(0.42, `rgba(${r},${green},${blue},0.28)`);
    gradient.addColorStop(0.72, `rgba(${r},${green},${blue},0.065)`);
    gradient.addColorStop(1, `rgba(${r},${green},${blue},0)`);
    g.fillStyle = gradient;
    g.fillRect(0, 0, 96, 96);
    sprites.set(color, s);
    return s;
  }

  const hotSprite = glowSprite(COLOR.white);
  for (const color of Object.values(COLOR)) glowSprite(color);

  function resize() {
    W = Math.max(1, window.innerWidth);
    H = Math.max(1, window.innerHeight);
    mobile = Math.min(W, H) < 620;
    DPR = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 1.75);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#02040c';
    ctx.fillRect(0, 0, W, H);
    focal = Math.max(620, Math.min(W, H) * 1.13);
    maxParticles = Math.floor((mobile ? 6500 : 9800) * quality);
    maxEmbers = Math.floor((mobile ? 1900 : 3000) * quality);
    minEmbers = Math.floor((mobile ? 1100 : 1900) * quality);
  }

  function scaleAt(z) {
    return focal / Math.max(240, z);
  }

  function screenToWorld(sx, sy, z) {
    const s = scaleAt(z);
    return { x: (sx - W * 0.5) / s, y: (H * 0.56 - sy) / s, z };
  }

  function project(x, y, z) {
    const s = scaleAt(z);
    return { x: W * 0.5 + x * s, y: H * 0.56 - y * s, s };
  }

  function velocityForOffset(offset, formTime, drag) {
    return offset * drag / (1 - Math.exp(-drag * formTime));
  }

  function addParticle(x, y, z, vx, vy, vz, options) {
    if (particles.length >= maxParticles) return null;
    const trailLen = options.trailLen || 8;
    const hist = new Float32Array(36);
    for (let i = 0; i < trailLen; i++) {
      hist[i * 3] = x;
      hist[i * 3 + 1] = y;
      hist[i * 3 + 2] = z;
    }
    const p = {
      x, y, z, vx, vy, vz,
      age: 0,
      life: options.life || rand(1.8, 3.1),
      size: options.size || 1,
      width: options.width || 0.8,
      alpha: options.alpha === undefined ? 1 : options.alpha,
      color: options.color || COLOR.white,
      drag: options.drag === undefined ? 0.48 : options.drag,
      gravity: options.gravity === undefined ? 20 : options.gravity,
      trailLen,
      hist,
      sample: 0,
      flicker: Math.random() < 0.42,
      phase: rand(TAU),
      diffuseAt: options.diffuseAt || 99,
      diffusion: options.diffusion || 0,
      seed: rand(TAU)
    };
    particles.push(p);
    return p;
  }

  function moveParticle(p, dt) {
    p.age += dt;
    const drag = Math.exp(-p.drag * dt);
    p.vx *= drag;
    p.vy = p.vy * drag - p.gravity * dt;
    p.vz *= drag;
    if (p.age > p.diffuseAt) {
      const d = p.diffusion * dt;
      p.vx += Math.sin(simTime * 2.1 + p.seed) * d;
      p.vz += Math.cos(simTime * 1.7 + p.seed * 1.7) * d * 0.65;
      p.vy -= d * 0.4;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    p.sample += dt;
    if (p.sample >= 1 / 60) {
      p.sample %= 1 / 60;
      const h = p.hist;
      for (let i = p.trailLen - 1; i > 0; i--) {
        const a = i * 3, b = a - 3;
        h[a] = h[b];
        h[a + 1] = h[b + 1];
        h[a + 2] = h[b + 2];
      }
      h[0] = p.x;
      h[1] = p.y;
      h[2] = p.z;
    }
  }

  function addEmber(x, y, z, burst, preAge = 0) {
    if (embers.length >= maxEmbers) return;
    const angle = rand(TAU);
    const speed = burst ? rand(4, 34) : rand(0, 4);
    embers.push({
      x, y, z,
      vx: Math.cos(angle) * speed,
      vy: (burst ? Math.sin(angle) * speed * 0.45 : 0) - rand(4, 19),
      vz: rand(-8, 8),
      age: preAge,
      life: rand(3.8, 7.8),
      size: rand(0.6, 1.6),
      alpha: rand(0.28, 0.78),
      color: Math.random() < 0.78 ? pick(EMBER_COLORS) : COLOR.gold,
      phase: rand(TAU),
      drift: rand(0.4, 1.5)
    });
  }

  function ambientEmber(preAge = 0) {
    const z = rand(900, 1700);
    const sx = rand(-20, W + 20);
    const sy = Math.random() < 0.72 ? rand(H * 0.43, H * 1.04) : rand(H * 0.16, H * 0.55);
    const p = screenToWorld(sx, sy, z);
    addEmber(p.x, p.y, p.z, false, preAge);
  }

  function burstEmbers(x, y, z, amount) {
    const n = Math.floor(amount * quality);
    for (let i = 0; i < n; i++) {
      addEmber(x + rand(-8, 8), y + rand(-8, 8), z + rand(-18, 18), true, rand(0, 0.35));
    }
  }

  function addFlash(x, y, z, radius, color) {
    flashes.push({ x, y, z, radius, color, age: 0, life: rand(0.45, 0.7) });
  }

  function buildHeart(x, y, z, color, widthPx, density = 1) {
    const count = Math.floor((mobile ? 690 : 980) * density * quality);
    const s = scaleAt(z);
    const unit = widthPx / (32 * s);
    const roll = rand(-0.075, 0.075);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const yaw = rand(-0.14, 0.14);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const form = 0.82, drag = 0.25;

    for (let i = 0; i < count; i++) {
      const u = rand(TAU);
      const edge = Math.random() < 0.7;
      const radial = edge ? rand(0.87, 1.015) : Math.sqrt(Math.random()) * 0.79;
      const zn = rand(-1, 1);
      const cross = Math.sqrt(1 - zn * zn);
      const hy = 13 * Math.cos(u) - 5 * Math.cos(2 * u) - 2 * Math.cos(3 * u) - Math.cos(4 * u);
      let ox = 16 * Math.pow(Math.sin(u), 3) * cross * radial * unit;
      let oy = (hy + 2.1) * cross * radial * unit;
      let oz = zn * 6.2 * radial * unit;
      const rx = ox * cr - oy * sr;
      oy = ox * sr + oy * cr;
      ox = rx;
      const rz = oz * cy - ox * sy;
      ox = ox * cy + oz * sy;
      oz = rz;
      const inner = radial < 0.72;
      addParticle(
        x, y, z,
        velocityForOffset(ox, form, drag),
        velocityForOffset(oy, form, drag),
        velocityForOffset(oz, form, drag),
        {
          color,
          life: rand(2.75, 3.65),
          size: inner ? rand(1.15, 1.75) : rand(0.85, 1.35),
          width: 0.72,
          alpha: inner ? 0.96 : 0.85,
          drag,
          gravity: 10,
          trailLen: 7,
          diffuseAt: rand(1.02, 1.25),
          diffusion: rand(7, 15)
        }
      );
    }
  }

  function buildPeony(x, y, z, color, radiusPx, density = 1) {
    const count = Math.floor(rand(410, 610) * density * quality);
    const radius = radiusPx / scaleAt(z);
    const form = 0.56, drag = 0.66;
    for (let i = 0; i < count; i++) {
      const vz = rand(-1, 1);
      const a = rand(TAU);
      const r = Math.sqrt(1 - vz * vz);
      const speedShape = rand(0.86, 1.02);
      const dx = Math.cos(a) * r, dy = Math.sin(a) * r;
      addParticle(
        x, y, z,
        velocityForOffset(dx * radius * speedShape, form, drag),
        velocityForOffset(dy * radius * speedShape, form, drag),
        velocityForOffset(vz * radius * speedShape, form, drag),
        {
          color,
          life: rand(1.75, 2.75),
          size: rand(0.85, 1.45),
          width: 0.8,
          drag,
          gravity: rand(18, 27),
          trailLen: 7
        }
      );
    }
  }

  function buildChrys(x, y, z, color, radiusPx, density = 1) {
    const rays = Math.max(48, Math.floor(randInt(104, 182) * density * quality));
    const beads = density < 0.6 ? 3 : (mobile ? 4 : 5);
    const radius = radiusPx / scaleAt(z);
    const form = 0.68, drag = 0.43;
    const roll = rand(TAU);
    for (let i = 0; i < rays; i++) {
      const a = roll + TAU * (i + rand(-0.11, 0.11)) / rays;
      const dz = rand(-0.22, 0.22);
      const dx = Math.cos(a), dy = Math.sin(a);
      const rayScale = rand(0.89, 1.04);
      for (let j = 0; j < beads; j++) {
        const tip = j === beads - 1;
        const fraction = tip ? rayScale : (0.24 + 0.68 * (j + 1) / beads) * rand(0.93, 1.03);
        addParticle(
          x, y, z,
          velocityForOffset(dx * radius * fraction, form, drag),
          velocityForOffset(dy * radius * fraction, form, drag),
          velocityForOffset(dz * radius * fraction, form, drag),
          {
            color,
            life: tip ? rand(2.35, 3.35) : rand(1.8, 2.8),
            size: tip ? rand(1.35, 1.9) : rand(0.62, 1.0),
            width: tip ? 0.9 : 0.6,
            alpha: tip ? 1 : rand(0.6, 0.85),
            drag,
            gravity: rand(18, 25),
            trailLen: tip ? 10 : 7
          }
        );
      }
    }
  }

  function buildStar(x, y, z, color, radiusPx) {
    const rays = randInt(22, 38);
    const radius = radiusPx / scaleAt(z);
    const form = 0.34, drag = 0.72;
    for (let i = 0; i < rays; i++) {
      const a = TAU * i / rays + rand(-0.07, 0.07);
      for (let j = 0; j < 3; j++) {
        const f = 0.35 + j * 0.3;
        addParticle(x, y, z,
          velocityForOffset(Math.cos(a) * radius * f, form, drag),
          velocityForOffset(Math.sin(a) * radius * f, form, drag),
          velocityForOffset(rand(-0.15, 0.15) * radius * f, form, drag),
          {
            color,
            life: rand(1.6, 2.25),
            size: j === 2 ? 1.3 : 0.72,
            width: 0.65,
            alpha: j === 2 ? 1 : 0.65,
            drag,
            gravity: 20,
            trailLen: 6
          }
        );
      }
    }
  }

  function buildWillow(x, y, z, color, radiusPx) {
    const count = Math.floor(rand(270, 390) * quality);
    const radius = radiusPx / scaleAt(z);
    const form = 0.7, drag = 0.53;
    for (let i = 0; i < count; i++) {
      const a = rand(TAU);
      const dz = rand(-0.35, 0.35);
      const f = rand(0.65, 1);
      addParticle(x, y, z,
        velocityForOffset(Math.cos(a) * radius * f, form, drag),
        velocityForOffset((Math.sin(a) * 0.75 + 0.3) * radius * f, form, drag),
        velocityForOffset(dz * radius * f, form, drag),
        {
          color,
          life: rand(2.85, 3.6),
          size: rand(0.7, 1.3),
          width: 0.74,
          alpha: rand(0.68, 1),
          drag,
          gravity: rand(52, 72),
          trailLen: 12
        }
      );
    }
  }

  function buildRing(x, y, z, color, radiusPx) {
    const count = Math.floor(rand(210, 310) * quality);
    const radius = radiusPx / scaleAt(z);
    const arc = Math.random() < 0.34 ? rand(Math.PI * 1.35, Math.PI * 1.82) : TAU;
    const start = rand(TAU);
    const tilt = rand(-0.52, 0.52);
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const form = 0.58, drag = 0.38;
    for (let i = 0; i < count; i++) {
      const a = start + arc * (i + rand(-0.16, 0.16)) / count;
      const dx = Math.cos(a);
      const dy = Math.sin(a) * ct;
      const dz = Math.sin(a) * st;
      const f = rand(0.975, 1.025);
      addParticle(x, y, z,
        velocityForOffset(dx * radius * f, form, drag),
        velocityForOffset(dy * radius * f, form, drag),
        velocityForOffset(dz * radius * f, form, drag),
        {
          color,
          life: rand(2.1, 3),
          size: rand(0.85, 1.4),
          width: 0.65,
          drag,
          gravity: 14,
          trailLen: 7
        }
      );
    }
  }

  function explodeAt(x, y, z, type, color, sizePx) {
    const m = Math.min(W, H);
    addFlash(x, y, z, type === 'chrys' || type === 'double' ? 82 : 62, color);
    burstEmbers(x, y, z, type === 'heart' ? 170 : type === 'star' ? 70 : 120);

    if (type === 'heart') {
      buildHeart(x, y, z, color, sizePx || rand(m * 0.3, m * 0.45));
    } else if (type === 'peony') {
      buildPeony(x, y, z, color, sizePx || rand(m * 0.13, m * 0.22));
    } else if (type === 'chrys') {
      buildChrys(x, y, z, color, sizePx || rand(m * 0.23, Math.min(m * 0.39, W * 0.39)));
    } else if (type === 'star') {
      buildStar(x, y, z, color, sizePx || rand(m * 0.07, m * 0.12));
    } else if (type === 'willow') {
      buildWillow(x, y, z, color, sizePx || rand(m * 0.18, m * 0.29));
    } else if (type === 'ring') {
      buildRing(x, y, z, COLOR.gold, sizePx || rand(m * 0.12, m * 0.2));
    } else if (type === 'double') {
      if (Math.random() < 0.38) {
        buildHeart(x, y, z, pick(HEART_COLORS), (sizePx || rand(m * 0.28, m * 0.39)), 0.86);
        buildChrys(x, y, z, pick([COLOR.cyan, COLOR.blue, COLOR.pinkWhite]), (sizePx || m * 0.34) * 0.75, 0.46);
      } else {
        const radius = sizePx || rand(m * 0.22, m * 0.34);
        buildPeony(x, y, z, pick([COLOR.orangeRed, COLOR.gold, COLOR.rose]), radius * 0.46, 0.66);
        buildChrys(x, y, z, pick([COLOR.cyan, COLOR.blue, COLOR.white]), radius, 0.68);
      }
    }
  }

  function colorForType(type) {
    if (type === 'heart') return pick(HEART_COLORS);
    if (type === 'peony') return pick(PEONY_COLORS);
    if (type === 'chrys') return pick(RAY_COLORS);
    if (type === 'willow') return pick([COLOR.gold, COLOR.rose]);
    if (type === 'ring') return COLOR.gold;
    if (type === 'star') return pick(STAR_COLORS);
    return pick([COLOR.cyan, COLOR.blue, COLOR.rose, COLOR.gold]);
  }

  function launch(type, target, options = {}) {
    const z = rand(900, 1450);
    const tx = target ? target.x : rand(W * 0.1, W * 0.9);
    const ty = target ? clamp(target.y, H * 0.08, H * 0.9) : rand(H * 0.13, H * 0.49);
    const end = screenToWorld(tx, ty, z);
    const startX = clamp(tx + rand(-W * 0.18, W * 0.18), W * 0.04, W * 0.96);
    const start = screenToWorld(startX, H + 34, z);
    const duration = options.duration || clamp((H + 34 - ty) / H * 0.78 + rand(0.25, 0.45), 0.78, 1.32);
    const gravity = 15;
    const hist = new Float32Array(36);
    for (let i = 0; i < 12; i++) {
      hist[i * 3] = start.x;
      hist[i * 3 + 1] = start.y;
      hist[i * 3 + 2] = z;
    }
    const color = options.color || colorForType(type);
    const rocket = {
      x: start.x, y: start.y, z,
      vx: (end.x - start.x) / duration,
      vy: (end.y - start.y + 0.5 * gravity * duration * duration) / duration,
      vz: 0,
      gravity,
      age: 0,
      duration,
      sample: 0,
      hist,
      type,
      color,
      sizePx: options.sizePx || 0
    };
    rockets.push(rocket);
    return rocket;
  }

  function autoLaunch() {
    const type = pick(TYPES);
    if (type === 'heart' && Math.random() < 0.38) {
      const m = Math.min(W, H);
      const left = rand(W * 0.25, W * 0.48);
      const gap = rand(m * 0.17, m * 0.28);
      const y = rand(H * 0.19, H * 0.38);
      const color = pick(HEART_COLORS);
      launch('heart', { x: left, y }, { sizePx: rand(m * 0.32, m * 0.43), color, duration: rand(0.94, 1.12) });
      launch('heart', { x: clamp(left + gap, W * 0.5, W * 0.9), y: y + rand(-H * 0.055, H * 0.055) }, {
        sizePx: rand(m * 0.22, m * 0.32),
        color: Math.random() < 0.5 ? color : pick(HEART_COLORS),
        duration: rand(0.94, 1.16)
      });
    } else if (type === 'heart' || type === 'double') {
      const m = Math.min(W, H);
      const sizePx = type === 'heart' ? rand(m * 0.3, m * 0.45) : rand(m * 0.22, m * 0.34);
      const margin = Math.min(W * 0.34, sizePx * 0.62);
      launch(type, { x: rand(margin, W - margin), y: rand(H * 0.15, H * 0.46) }, { sizePx });
    } else {
      launch(type);
    }
  }

  function moveRocket(r, dt) {
    r.age += dt;
    r.vy -= r.gravity * dt;
    r.x += r.vx * dt;
    r.y += r.vy * dt;
    r.sample += dt;
    if (r.sample >= 1 / 60) {
      r.sample %= 1 / 60;
      for (let i = 11; i > 0; i--) {
        const a = i * 3, b = a - 3;
        r.hist[a] = r.hist[b];
        r.hist[a + 1] = r.hist[b + 1];
        r.hist[a + 2] = r.hist[b + 2];
      }
      r.hist[0] = r.x;
      r.hist[1] = r.y;
      r.hist[2] = r.z;
    }
  }

  function update(dt) {
    simTime += dt;
    nextLaunch -= dt;
    if (nextLaunch <= 0) {
      autoLaunch();
      if (simTime < 4) nextLaunch = rand(0.9, 1.45);
      else if (simTime < 8) nextLaunch = rand(0.55, 0.9);
      else nextLaunch = rand(0.35, 0.56);
    }

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      moveRocket(r, dt);
      if (r.age >= r.duration) {
        explodeAt(r.x, r.y, r.z, r.type, r.color, r.sizePx);
        rockets.splice(i, 1);
      }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      moveParticle(p, dt);
      if (p.age >= p.life || p.z < 280) {
        if (Math.random() < 0.075) addEmber(p.x, p.y, p.z, false);
        particles[i] = particles[particles.length - 1];
        particles.pop();
      }
    }

    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i];
      e.age += dt;
      e.vx += Math.sin(simTime * 0.7 + e.phase) * e.drift * dt;
      e.vy -= 3.8 * dt;
      e.vx *= Math.exp(-0.18 * dt);
      e.vz *= Math.exp(-0.2 * dt);
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.z += e.vz * dt;
      if (e.age >= e.life) {
        embers[i] = embers[embers.length - 1];
        embers.pop();
      }
    }

    if (embers.length < minEmbers) {
      const add = Math.min(10, minEmbers - embers.length);
      for (let i = 0; i < add; i++) ambientEmber();
    }

    for (let i = flashes.length - 1; i >= 0; i--) {
      flashes[i].age += dt;
      if (flashes[i].age >= flashes[i].life) flashes.splice(i, 1);
    }
  }

  function particleAlpha(p) {
    const t = p.age / p.life;
    let fade = t < 0.53 ? 1 : Math.pow(clamp(1 - (t - 0.53) / 0.47, 0, 1), 1.65);
    if (p.flicker && t > 0.62) fade *= 0.64 + 0.36 * Math.sin(simTime * 27 + p.phase);
    return p.alpha * fade * clamp(p.age / 0.045, 0, 1);
  }

  function traceTrail(p, from, to) {
    const h = p.hist;
    ctx.beginPath();
    for (let j = from; j <= to; j++) {
      const k = j * 3;
      const q = project(h[k], h[k + 1], h[k + 2]);
      if (j === from) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
  }

  function drawParticles() {
    ctx.strokeStyle = COLOR.white.css;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const alpha = particleAlpha(p);
      if (alpha <= 0.005) continue;
      const q = project(p.x, p.y, p.z);
      if (q.x < -360 || q.x > W + 360 || q.y < -360 || q.y > H + 360) continue;
      const depth = clamp(1.32 - p.z / 2600, 0.56, 1.08);
      const a = alpha * depth;
      const width = Math.max(0.32, p.size * p.width * q.s * 1.15);
      ctx.strokeStyle = p.color.css;
      ctx.globalAlpha = a * 0.9;
      ctx.lineWidth = width;
      traceTrail(p, 0, Math.min(3, p.trailLen - 1));
      if (p.trailLen > 4) {
        ctx.globalAlpha = a * 0.48;
        ctx.lineWidth = width * 0.68;
        traceTrail(p, 3, Math.min(7, p.trailLen - 1));
      }
      if (p.trailLen > 8) {
        ctx.globalAlpha = a * 0.18;
        ctx.lineWidth = width * 0.4;
        traceTrail(p, 7, p.trailLen - 1);
      }
      const glowSize = Math.max(4, p.size * q.s * (p.age < 0.18 ? 11 : 8.5));
      ctx.globalAlpha = a * (p.age < 0.18 ? 1 : 0.96);
      ctx.drawImage(glowSprite(p.color), q.x - glowSize * 0.5, q.y - glowSize * 0.5, glowSize, glowSize);
      if (p.age < 0.16) {
        const hot = glowSize * 0.72;
        ctx.globalAlpha = a * (1 - p.age / 0.16) * 0.95;
        ctx.drawImage(hotSprite, q.x - hot * 0.5, q.y - hot * 0.5, hot, hot);
      }
    }
  }

  function drawEmbers() {
    for (let i = 0; i < embers.length; i++) {
      const e = embers[i];
      const q = project(e.x, e.y, e.z);
      if (q.x < -15 || q.x > W + 15 || q.y < -15 || q.y > H + 20) continue;
      const t = e.age / e.life;
      const fade = Math.sin(Math.min(1, t) * Math.PI);
      const flicker = 0.55 + 0.45 * Math.sin(simTime * (5 + e.drift * 3) + e.phase);
      const alpha = Math.min(0.9, e.alpha * fade * (0.58 + 0.52 * flicker) * 1.35);
      const size = Math.max(2.8, e.size * q.s * 6.8);
      ctx.globalAlpha = alpha;
      ctx.drawImage(glowSprite(e.color), q.x - size * 0.5, q.y - size * 0.5, size, size);
    }
  }

  function drawFlashes() {
    for (const f of flashes) {
      const q = project(f.x, f.y, f.z);
      const t = f.age / f.life;
      const radius = f.radius * q.s * (0.45 + t * 0.85);
      ctx.globalAlpha = Math.pow(1 - t, 2) * 0.9;
      ctx.drawImage(glowSprite(f.color), q.x - radius, q.y - radius, radius * 2, radius * 2);
      const hot = radius * 0.48;
      ctx.globalAlpha = Math.pow(1 - t, 3) * 0.95;
      ctx.drawImage(hotSprite, q.x - hot, q.y - hot, hot * 2, hot * 2);
    }
  }

  function drawRockets() {
    for (const r of rockets) {
      const q = project(r.x, r.y, r.z);
      ctx.strokeStyle = r.color.css;
      for (let segment = 0; segment < 3; segment++) {
        const from = segment * 4;
        const to = Math.min(11, from + 4);
        ctx.beginPath();
        for (let j = from; j <= to; j++) {
          const k = j * 3;
          const p = project(r.hist[k], r.hist[k + 1], r.hist[k + 2]);
          if (j === from) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.globalAlpha = [0.88, 0.44, 0.14][segment];
        ctx.lineWidth = Math.max(0.3, (1.55 - segment * 0.46) * q.s);
        ctx.stroke();
      }
      const glow = 24 * q.s;
      ctx.globalAlpha = 0.95;
      ctx.drawImage(glowSprite(r.color), q.x - glow * 0.5, q.y - glow * 0.5, glow, glow);
      const hot = 10 * q.s;
      ctx.globalAlpha = 1;
      ctx.drawImage(hotSprite, q.x - hot * 0.5, q.y - hot * 0.5, hot, hot);
    }
  }

  function render() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(2,4,12,0.16)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    drawEmbers();
    drawParticles();
    drawFlashes();
    drawRockets();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function preAgeParticle(p, seconds) {
    const steps = Math.ceil(seconds * 60);
    const dt = seconds / steps;
    for (let i = 0; i < steps; i++) moveParticle(p, dt);
  }

  function prewarm() {
    for (let i = 0; i < minEmbers; i++) ambientEmber(rand(0, 2.4));
    const m = Math.min(W, H);
    const seeds = [
      { type: 'heart', x: 0.32, y: 0.3, age: 0.62, size: m * 0.39 },
      { type: 'heart', x: 0.55, y: 0.34, age: 0.4, size: m * 0.28 },
      { type: 'chrys', x: 0.76, y: 0.27, age: 0.46, size: m * 0.34 },
      { type: 'peony', x: 0.17, y: 0.48, age: 0.58, size: m * 0.18 },
      { type: 'willow', x: 0.61, y: 0.48, age: 0.74, size: m * 0.25 },
      { type: 'chrys', x: 0.43, y: 0.18, age: 0.2, size: m * 0.3 },
      { type: 'ring', x: 0.86, y: 0.48, age: 0.52, size: m * 0.16 },
      { type: 'star', x: 0.09, y: 0.23, age: 0.26, size: m * 0.1 },
      { type: 'double', x: 0.72, y: 0.16, age: 0.3, size: m * 0.28 },
      { type: 'peony', x: 0.36, y: 0.52, age: 0.24, size: m * 0.17 }
    ];
    for (const seed of seeds) {
      const z = rand(950, 1350);
      const p = screenToWorld(W * seed.x, H * seed.y, z);
      const start = particles.length;
      explodeAt(p.x, p.y, p.z, seed.type, colorForType(seed.type), seed.size);
      for (let i = start; i < particles.length; i++) preAgeParticle(particles[i], seed.age);
    }
    for (let i = 0; i < 3; i++) {
      const r = launch(pick(TYPES));
      const age = rand(0.15, r.duration * 0.64);
      const steps = Math.ceil(age * 60);
      for (let j = 0; j < steps; j++) moveRocket(r, age / steps);
    }
  }

  function frame(now) {
    const rawDt = (now - lastTime) / 1000;
    lastTime = now;
    const dt = clamp(rawDt, 0.001, 0.034);
    update(dt);
    render();

    if (rawDt > 0.03) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 2);
    if (slowFrames > 100 && quality > 0.62) {
      quality = Math.max(0.6, quality - 0.12);
      maxParticles = Math.floor((mobile ? 6500 : 9800) * quality);
      maxEmbers = Math.floor((mobile ? 1550 : 2500) * quality);
      minEmbers = Math.floor((mobile ? 760 : 1350) * quality);
      slowFrames = 0;
    }
    frame.__raf = requestAnimationFrame(frame);
  }

  canvas.addEventListener('pointerdown', event => {
    event.preventDefault();
    const type = Math.random() < 0.48 ? 'heart' : pick(TYPES);
    launch(type, { x: event.clientX, y: event.clientY });
  }, { passive: false });

  document.addEventListener('visibilitychange', () => {
    lastTime = performance.now();
  });
  window.addEventListener('resize', resize, { passive: true });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize, { passive: true });

  let prewarmed = false;
  window.__fireworks = {
    // 在邀请页空闲时就先算好 180 帧，避免点击瞬间同步计算造成卡顿
    prewarm() {
      if (prewarmed) return;
      prewarmed = true;
      lastTime = performance.now();
      resize();
      prewarm();
      for (let i = 0; i < 180; i++) update(1 / 60);
    },
    start() {
      if (running) return;
      running = true;
      lastTime = performance.now();
      requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(frame.__raf || 0);
    }
  };
})();