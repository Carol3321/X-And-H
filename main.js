import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { GestureEngine, followRotation, FINGER_DEFS } from './gesture-engine.mjs';

const CONFIG = {
  colors: { bg: 0x000000, champagneGold: 0xffd966, deepGreen: 0x03180a, accentRed: 0x990000 },
  particles: { count: 1500, dustCount: 2500, treeHeight: 24, treeRadius: 8 },
  camera: { z: 50 }
};

const STATE = {
  // focusIndex 从 0 开始：第一次捏合会翻到第 2 张（第 1 张是默认的 JOYEUX NOEL 占位卡）
  mode: 'TREE', focusIndex: 0, focusTarget: null,
  hand: { detected: false, x: 0, y: 0 },
  rotation: { x: 0, y: 0 }
};

let scene, camera, renderer, composer;
let mainGroup;
let clock = new THREE.Clock();
let particleSystem = [];
let photoMeshGroup = new THREE.Group();
let handLandmarker, video, webcamCanvas, webcamCtx;
let caneTexture;

// 手势引擎：所有判定逻辑都在 gesture-engine.mjs 里，这里只负责“读懂结果”
const gestures = new GestureEngine();
let lastPose = null;          // 最近一帧的手势快照，给 UI / 预览用
let lastLandmarks = null;     // 最近一帧原始关键点

async function init() {
  initThree();
  setupEnvironment();
  setupLights();
  createTextures();
  createParticles();
  createDust();
  // 不再放 JOYEUX NOEL 占位卡：相册里只有真实照片
  setupPostProcessing();
  setupEvents();
  cacheUi();

  // 先让相册和相机跑起来：识别模型 6MB + 100 张缩略图同时抢带宽，慢网下两边都卡。
  // 缩略图优先，模型最多等 12 秒再开始下。
  const galleryDone = loadGallery();
  setTimeout(() => startModelLoad().catch((err) => console.warn('模型预热失败:', err)), 12000);
  galleryDone.finally(() => startModelLoad().catch((err) => console.warn('模型预热失败:', err)));

  // 第二次打开时模型/缩略图直接走缓存
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  await Promise.all([
    Promise.race([
      initMediaPipe(),
      new Promise(resolve => setTimeout(resolve, 8000))
    ]).catch(err => console.warn('MediaPipe init skipped:', err)),
    Promise.race([
      galleryDone,
      new Promise(resolve => setTimeout(resolve, 6000))
    ])
  ]);

  const loader = document.getElementById('loader');
  if (loader) {
    loader.style.opacity = 0;
    setTimeout(() => loader.remove(), 800);
  }
  animate();
}

function initThree() {
  const container = document.getElementById('canvas-container');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.colors.bg);
  scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.01);
  camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 2, CONFIG.camera.z);
  updateViewMetrics();
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = 2.2;
  container.appendChild(renderer.domElement);
  mainGroup = new THREE.Group();
  // 整体下移一点，给顶部标题（Happy New Year / X And H）留出呼吸空间
  mainGroup.position.y = -1.2;
  scene.add(mainGroup);
}

function setupEnvironment() {
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
}

function setupLights() {
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const innerLight = new THREE.PointLight(0xffaa00, 2, 20);
  innerLight.position.set(0, 5, 0);
  mainGroup.add(innerLight);
  const spotGold = new THREE.SpotLight(0xffcc66, 1200);
  spotGold.position.set(30, 40, 40);
  spotGold.angle = 0.5;
  spotGold.penumbra = 0.5;
  scene.add(spotGold);
  const spotBlue = new THREE.SpotLight(0x6688ff, 600);
  spotBlue.position.set(-30, 20, -30);
  scene.add(spotBlue);
  const fill = new THREE.DirectionalLight(0xffeebb, 0.8);
  fill.position.set(0, 0, 50);
  scene.add(fill);
}

function setupPostProcessing() {
  const renderScene = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
  bloomPass.threshold = 0.7;
  bloomPass.strength = 0.45;
  bloomPass.radius = 0.4;
  if (/[?&]nobloom/.test(location.search)) bloomPass.strength = 0;   // 调试：关掉泛光
  const q = new URLSearchParams(location.search);
  if (q.has('exp')) renderer.toneMappingExposure = Number(q.get('exp'));
  if (q.has('bs')) bloomPass.strength = Number(q.get('bs'));
  if (q.has('bt')) bloomPass.threshold = Number(q.get('bt'));
  composer = new EffectComposer(renderer);
  composer.addPass(renderScene);
  composer.addPass(bloomPass);
  // 被特写的那张照片放到 layer 1，渲染时会被主相机跳过，
  // 之后单独直接画到画布上（见 animate），这样它既不吃泛光也不吃色调映射。
  photoCamera = camera.clone();
  photoCamera.layers.set(1);
}

/** 把某张照片切换到"独立叠加"图层（只有它自己会走叠加渲染） */
function setPhotoOverlay(mesh, on) {
  if (!mesh) return;
  // 只有“被特写叠加”的那张才关掉色调映射（保证颜色 = 原图），树上的照片照常参与场景曝光
  const plane = mesh.userData.photoMesh;
  if (plane && plane.material) {
    plane.material.toneMapped = !on;
    plane.material.needsUpdate = true;
  }
  mesh.traverse((o) => { on ? o.layers.set(1) : o.layers.set(0); });
}
let photoCamera = null;
let overlayPhotoMesh = null;

function createTextures() {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0,0,128,128);
  ctx.fillStyle = '#880000';
  ctx.beginPath();
  for(let i=-128; i<256; i+=32) {
    ctx.moveTo(i, 0); ctx.lineTo(i+32, 128); ctx.lineTo(i+16, 128); ctx.lineTo(i-16, 0);
  }
  ctx.fill();
  caneTexture = new THREE.CanvasTexture(canvas);
  caneTexture.wrapS = THREE.RepeatWrapping;
  caneTexture.wrapT = THREE.RepeatWrapping;
  caneTexture.repeat.set(3, 3);
}

const _tmpScale = new THREE.Vector3();

class Particle {
  constructor(mesh, type, isDust = false) {    this.mesh = mesh;
    this.type = type;
    this.isDust = isDust;
    this.posTree = new THREE.Vector3();
    this.posScatter = new THREE.Vector3();
    this.baseScale = mesh.scale.x;
    const speedMult = (type === 'PHOTO') ? 0.3 : 2.0;
    this.spinSpeed = new THREE.Vector3(
      (Math.random() - 0.5) * speedMult,
      (Math.random() - 0.5) * speedMult,
      (Math.random() - 0.5) * speedMult
    );
    this.calculatePositions();
  }
  calculatePositions() {
    const h = CONFIG.particles.treeHeight;
    const halfH = h / 2;
    let t = Math.random();
    t = Math.pow(t, 0.8);
    const y = (t * h) - halfH;
    let rMax = CONFIG.particles.treeRadius * (1.0 - t);
    if (rMax < 0.5) rMax = 0.5;
    const angle = t * 50 * Math.PI + Math.random() * Math.PI;
    const r = rMax * (0.8 + Math.random() * 0.4);
    this.posTree.set(Math.cos(angle) * r, y, Math.sin(angle) * r);
    let rScatter = this.isDust ? (12 + Math.random()*20) : (8 + Math.random()*12);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    this.posScatter.set(
      rScatter * Math.sin(phi) * Math.cos(theta),
      rScatter * Math.sin(phi) * Math.sin(theta),
      rScatter * Math.cos(phi)
    );
  }
  update(dt, mode, focusTargetMesh) {
    let target = this.posTree;
    if (mode === 'SCATTER') target = this.posScatter;
    else if (mode === 'FOCUS') {
      if (this.mesh === focusTargetMesh) {
        const desiredWorldPos = new THREE.Vector3(0, 1.1, 35);
        const invMatrix = new THREE.Matrix4().copy(mainGroup.matrixWorld).invert();
        target = desiredWorldPos.applyMatrix4(invMatrix);
      } else { target = this.posScatter; }
    }
    const isFocusTarget = mode === 'FOCUS' && this.mesh === focusTargetMesh;
    const lerpSpeed = isFocusTarget ? 5.0 : 2.0;
    // 指数衰减插值：与帧率无关，60Hz / 144Hz 手感一致
    this.mesh.position.lerp(target, 1 - Math.exp(-lerpSpeed * dt));
    if (mode === 'SCATTER') {
      this.mesh.rotation.x += this.spinSpeed.x * dt;
      this.mesh.rotation.y += this.spinSpeed.y * dt;
      this.mesh.rotation.z += this.spinSpeed.z * dt;
    } else if (mode === 'TREE') {
      this.mesh.rotation.x = THREE.MathUtils.lerp(this.mesh.rotation.x, 0, dt);
      this.mesh.rotation.z = THREE.MathUtils.lerp(this.mesh.rotation.z, 0, dt);
      this.mesh.rotation.y += 0.5 * dt;
    }
    if (isFocusTarget) {
      this.mesh.lookAt(camera.position);
    }
    let s = this.baseScale;
    if (this.isDust) {
      s = this.baseScale * (0.8 + 0.4 * Math.sin(clock.elapsedTime * 4 + this.mesh.id));
      if (mode === 'TREE') s = 0;
    } else if (mode === 'SCATTER' && this.type === 'PHOTO') {
      s = this.baseScale * 2.5;
    } else if (mode === 'FOCUS') {
      if (isFocusTarget) s = this.focusScaleFor();   // 按视口自适应放大，手机竖屏也不会被裁
      else s = this.baseScale * 0.8;
    }
    this.mesh.scale.lerp(_tmpScale.set(s, s, s), 1 - Math.exp(-4 * dt));
  }

  /** 特写时放多大：占屏幕高度 66%、宽度 88%，两者取小，保证不裁切也不挡标题 */
  focusScaleFor() {
    const fw = this.frameW || 1.4;
    const fh = this.frameH || 1.4;
    // 每次都按当前相机算，避免横竖屏/窗口尺寸变化后用到旧值
    const dist = Math.max(camera.position.z - 35, 1);
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * dist;
    const w = h * camera.aspect;
    return Math.min((h * 0.66) / fh, (w * 0.88) / fw);
  }
}

// 特写平面(z=35)附近的可视范围（世界单位），窗口尺寸变化时更新
const viewMetrics = { w: 18, h: 11.5 };
function updateViewMetrics() {
  if (!camera) return;
  const dist = Math.max(camera.position.z - 35, 1);
  viewMetrics.h = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * dist;
  viewMetrics.w = viewMetrics.h * camera.aspect;
}

function createParticles() {
  const sphereGeo = new THREE.SphereGeometry(0.5, 32, 32);
  const boxGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 0.3, 0),
    new THREE.Vector3(0.1, 0.5, 0), new THREE.Vector3(0.3, 0.4, 0)
  ]);
  const candyGeo = new THREE.TubeGeometry(curve, 16, 0.08, 8, false);
  const goldMat = new THREE.MeshStandardMaterial({
    color: CONFIG.colors.champagneGold, metalness: 1.0, roughness: 0.1,
    envMapIntensity: 2.0, emissive: 0x443300, emissiveIntensity: 0.3
  });
  const greenMat = new THREE.MeshStandardMaterial({
    color: CONFIG.colors.deepGreen, metalness: 0.2, roughness: 0.8,
    emissive: 0x002200, emissiveIntensity: 0.2
  });
  const redMat = new THREE.MeshPhysicalMaterial({
    color: CONFIG.colors.accentRed, metalness: 0.3, roughness: 0.2, clearcoat: 1.0,
    emissive: 0x330000
  });
  const candyMat = new THREE.MeshStandardMaterial({ map: caneTexture, roughness: 0.4 });
  for (let i = 0; i < CONFIG.particles.count; i++) {
    const rand = Math.random();
    let mesh, type;
    if (rand < 0.40) { mesh = new THREE.Mesh(boxGeo, greenMat); type = 'BOX'; }
    else if (rand < 0.70) { mesh = new THREE.Mesh(boxGeo, goldMat); type = 'GOLD_BOX'; }
    else if (rand < 0.92) { mesh = new THREE.Mesh(sphereGeo, goldMat); type = 'GOLD_SPHERE'; }
    else if (rand < 0.97) { mesh = new THREE.Mesh(sphereGeo, redMat); type = 'RED'; }
    else { mesh = new THREE.Mesh(candyGeo, candyMat); type = 'CANE'; }
    const s = 0.4 + Math.random() * 0.5;
    mesh.scale.set(s,s,s);
    mesh.rotation.set(Math.random()*6, Math.random()*6, Math.random()*6);
    mainGroup.add(mesh);
    particleSystem.push(new Particle(mesh, type, false));
  }
  const starGeo = new THREE.OctahedronGeometry(1.2, 0);
  const starMat = new THREE.MeshStandardMaterial({
    color: 0xffdd88, emissive: 0xffaa00, emissiveIntensity: 1.0, metalness: 1.0, roughness: 0
  });
  const star = new THREE.Mesh(starGeo, starMat);
  star.position.set(0, CONFIG.particles.treeHeight/2 + 1.2, 0);
  mainGroup.add(star);
  mainGroup.add(photoMeshGroup);
}

function createDust() {
  const geo = new THREE.TetrahedronGeometry(0.08, 0);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffeebb, transparent: true, opacity: 0.8 });
  for(let i=0; i<CONFIG.particles.dustCount; i++) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(0.5 + Math.random());
    mainGroup.add(mesh);
    particleSystem.push(new Particle(mesh, 'DUST', true));
  }
}

function createDefaultPhotos() {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#050505'; ctx.fillRect(0,0,512,512);
  ctx.strokeStyle = '#eebb66'; ctx.lineWidth = 15; ctx.strokeRect(20,20,472,472);
  ctx.font = '500 60px Times New Roman'; ctx.fillStyle = '#eebb66';
  ctx.textAlign = 'center';
  ctx.fillText("JOYEUX", 256, 230);
  ctx.fillText("NOEL", 256, 300);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  addPhotoToScene(tex);
}

function addPhotoToScene(texture, fullUrl = null) {
  // 按原图宽高比生成相框，避免竖图被拉成正方形
  const img = texture.image;
  const aspect = (img && img.width && img.height) ? img.width / img.height : 1;
  const LONG = 1.2;                                   // 长边尺寸
  const pw = aspect >= 1 ? LONG : LONG * aspect;
  const ph = aspect >= 1 ? LONG / aspect : LONG;

  const frameGeo = new THREE.BoxGeometry(pw + 0.2, ph + 0.2, 0.05);
  const frameMat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.champagneGold, metalness: 1.0, roughness: 0.1 });
  const frame = new THREE.Mesh(frameGeo, frameMat);

  const photoGeo = new THREE.PlaneGeometry(pw, ph);
  // 树上的照片照常参与场景曝光；只有被“特写叠加”时才关掉色调映射（见 setPhotoOverlay）
  const photoMat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  const photo = new THREE.Mesh(photoGeo, photoMat);
  photo.position.z = 0.04;
  const group = new THREE.Group();
  group.add(frame);
  group.add(photo);
  group.userData.photoMesh = photo;   // 点开大图时要换 texture
  const s = 0.8;
  group.scale.set(s,s,s);
  photoMeshGroup.add(group);
  const particle = new Particle(group, 'PHOTO', false);
  particle.frameW = pw + 0.2;         // 相框尺寸，特写时按它算最大可放倍数
  particle.frameH = ph + 0.2;
  particle.fullUrl = fullUrl;         // 树上用缩略图，大图按需加载
  particle.thumbTexture = texture;    // 大图被回收时退回这张
  particle.fullTexture = null;
  particle.orderIndex = 1e6 + (photoSeq++);   // 用户上传的排在内置相册之后
  particleSystem.push(particle);
  return particle;
}
let photoSeq = 0;

/**
 * 相册：assets/photos/manifest.json 里列着每张图的大图和缩略图路径。
 * 树上只加载 320px 缩略图（55 张总共约 17MB 显存），
 * 真正点开某一张时才去取 1600px 原图，避免手机显存爆掉。
 */
async function loadGallery() {
  try {
    const res = await fetch('assets/photos/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const photos = (data && data.photos) || [];

    // 先按清单把 100 个位置全部建好（用一张占位纹理），
    // 缩略图陆续到了再换贴图。这样翻页序号和总数从一开始就是固定的，不会跳变。
    const placeholder = createPlaceholderTexture();
    const slots = photos.map((item, index) => {
      const p = addPhotoToScene(placeholder, `assets/photos/${item.full}`);
      p.orderIndex = index;
      p.photoId = item.id;
      p.midUrl = item.mid ? `assets/photos/${item.mid}` : null;
      p.thumbUrl = `assets/photos/${item.thumb}`;
      return p;
    });

    const loader = new THREE.TextureLoader();
    let ok = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < slots.length) {
        const p = slots[cursor++];
        try {
          const url = await fetchToCache(p.thumbUrl);      // 带超时，卡住的请求不会一直占着
          const tex = await loader.loadAsync(url);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
          applyTextureToParticle(p, tex);
          p.thumbTexture = tex;
          ok++;
        } catch (e) {
          console.warn('照片加载失败:', p.thumbUrl, e);
        }
      }
    };
    // 并发 4 路：慢网下开太多反而每张都变慢，还容易把连接占满
    await Promise.all(
      Array.from({ length: Math.min(4, slots.length) }, worker)
    );
    console.log(`相册：已加载 ${ok}/${slots.length} 张`);
    applyDebugMode();
    applyDebugPhoto();
  } catch (err) {
    console.warn('相册清单读取失败:', err);
  }
}

/** 灰色占位纹理：缩略图没到位时先占着位置 */
function createPlaceholderTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 4;
  const g = c.getContext('2d');
  g.fillStyle = '#0d0b06';
  g.fillRect(0, 0, 4, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 先带超时地把图拉进 HTTP 缓存，再交给 TextureLoader；失败重试一次 */
async function fetchToCache(url, timeoutMs = 12000, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await r.arrayBuffer();          // 读完即进缓存
      return url;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 调试用：?mode=scatter 直接切到散开状态 */
function applyDebugMode() {
  const m = /[?&]mode=(tree|scatter)/i.exec(location.search);
  if (!m) return;
  STATE.mode = m[1].toUpperCase();
  STATE.focusTarget = null;
  applyFocusOverlay();
}

/** 调试用：?photo=35 直接把第 35 张放进特写，方便检查画质 */
function applyDebugPhoto() {
  const m = /[?&]photo=(\d+)/.exec(location.search);
  if (!m) return;
  const list = photoList();
  if (!list.length) return;
  const idx = Math.max(0, Math.min(Number(m[1]), list.length - 1));
  STATE.mode = 'FOCUS';
  STATE.focusIndex = idx;
  STATE.focusTarget = list[idx].mesh;
  ensureFullTexture(STATE.focusTarget);
  applyFocusOverlay();
}

/**
 * 特写用的大图：按需加载 + 缓存 + 预取相邻张。
 * 之前是"翻到哪张才去下载"，慢网络下会先看到 320px 缩略图（发糊），
 * 现在提前把下一张/上一张也拉下来，翻页时基本是秒切原图。
 */
const fullCache = [];          // 最近用过的大图（LRU），防止显存无限增长
const FULL_CACHE_MAX = 8;
const fullLoader = new THREE.TextureLoader();

function loadFullTexture(p) {
  if (!p || !p.fullUrl) return Promise.resolve(null);
  if (p.fullTexture) return Promise.resolve(p.fullTexture);
  if (p.fullPromise) return p.fullPromise;
  p.fullPromise = new Promise((resolve) => {
    fullLoader.load(
      p.fullUrl,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        p.fullTexture = tex;
        p.fullPromise = null;
        touchFullCache(p);
        resolve(tex);
      },
      undefined,
      () => { p.fullPromise = null; resolve(null); }
    );
  });
  return p.fullPromise;
}

function touchFullCache(p) {
  const i = fullCache.indexOf(p);
  if (i >= 0) fullCache.splice(i, 1);
  fullCache.push(p);
  while (fullCache.length > FULL_CACHE_MAX) {
    const old = fullCache.shift();
    if (!old || old === overlayPhotoParticle()) continue;
    const plane = old.mesh.userData.photoMesh;
    if (plane && old.fullTexture) {
      if (plane.material.map === old.fullTexture) {
        plane.material.map = old.thumbTexture;   // 退回缩略图，释放显存
        plane.material.needsUpdate = true;
      }
      old.fullTexture.dispose();
      old.fullTexture = null;
    }
  }
}

function overlayPhotoParticle() {
  return overlayPhotoMesh ? particleSystem.find(x => x.mesh === overlayPhotoMesh) : null;
}

/** 先把 720px 的中间版本贴上（几十 KB，秒到），避免只看到 384px 缩略图 */
function loadMidTexture(p) {
  if (!p || !p.midUrl) return Promise.resolve(null);
  if (p.midTexture) return Promise.resolve(p.midTexture);
  if (p.midPromise) return p.midPromise;
  p.midPromise = new Promise((resolve) => {
    fullLoader.load(
      p.midUrl,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        p.midTexture = tex;
        p.midPromise = null;
        resolve(tex);
      },
      undefined,
      () => { p.midPromise = null; resolve(null); }
    );
  });
  return p.midPromise;
}

function applyTextureToParticle(p, tex) {
  if (!p || !tex) return;
  const plane = p.mesh.userData.photoMesh;
  if (!plane) return;
  if (plane.material.map === tex) return;
  plane.material.map = tex;
  plane.material.needsUpdate = true;
}

/** 某张照片成为特写时：先上 720px，再换 1800px（并预取后面几张） */
function ensureFullTexture(mesh) {
  if (!mesh) return;
  const p = particleSystem.find(x => x.mesh === mesh);
  if (!p) return;

  if (p.fullTexture) {
    applyTextureToParticle(p, p.fullTexture);
  } else {
    // 中间版本先顶上
    loadMidTexture(p).then((mid) => {
      if (mid && !p.fullTexture) applyTextureToParticle(p, mid);
    });
    loadFullTexture(p).then((tex) => {
      if (!tex) return;
      applyTextureToParticle(p, tex);
      // 大图到位后释放中间版本，省显存
      if (p.midTexture) { p.midTexture.dispose(); p.midTexture = null; }
    });
  }

  // 预取：后面两张的大图 + 四张的中间版本
  const list = photoList();
  const i = list.findIndex(x => x.mesh === mesh);
  if (i >= 0) {
    for (let k = 1; k <= 4; k++) {
      const q = list[(i + k) % list.length];
      if (!q || q === p) continue;
      loadMidTexture(q);
      if (k <= 2) loadFullTexture(q);
    }
  }
}

function handleImageUpload(e) {
  const files = e.target.files;
  if(!files.length) return;
  Array.from(files).forEach(f => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      new THREE.TextureLoader().load(ev.target.result, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        addPhotoToScene(t);
      });
    }
    reader.readAsDataURL(f);
  });
}

// ============================================================
//  MediaPipe：识别手部 21 个关键点
// ============================================================
let cameraLive = false;   // 摄像头流是否已拿到

/** 把 getUserMedia 的报错翻译成人话 */
function cameraErrorText(err) {
  const name = err && err.name ? err.name : 'UnknownError';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '⚠ 摄像头被浏览器阻止了：点地址栏右侧的相机图标 → 改为「允许」→ 刷新';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '⚠ 没找到摄像头设备，检查是否被禁用或断开';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '⚠ 摄像头被其它程序占用（微信/会议软件），关掉再刷新';
  }
  if (name === 'OverconstrainedError') {
    return '⚠ 摄像头不支持请求的参数，已尝试降级，请刷新重试';
  }
  return '⚠ 摄像头打开失败：' + name;
}

async function initMediaPipe() {
  video = document.getElementById('webcam');
  webcamCanvas = document.getElementById('webcam-preview');
  webcamCtx = webcamCanvas ? webcamCanvas.getContext('2d') : null;
  if (webcamCanvas) { webcamCanvas.width = 192; webcamCanvas.height = 144; }

  // 1) 先做环境检查：file:// 或 http 非 localhost 时浏览器根本不给摄像头，
  //    以前这里会静默跳过，用户只看到“把手举到摄像头前…”以为程序坏了
  if (!window.isSecureContext) {
    setHintText(`⚠ 当前是 ${location.protocol}// 打开，浏览器不允许用摄像头。请用 http://localhost 或 https 链接`);
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setHintText('⚠ 这个浏览器不支持摄像头接口，换 Chrome / Edge / Safari 试试');
    return;
  }

  // 2) 先要摄像头，让授权弹窗尽早出现
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: { ideal: 'user' } },
      audio: false
    });
    video.srcObject = stream;
    video.muted = true;
    video.addEventListener('loadeddata', () => { video.play().catch(() => {}); });
    cameraLive = true;
    if (ui.webcamWrap) ui.webcamWrap.classList.add('active');
    setHintText('摄像头已就绪 · 正在加载识别模型…', false);
    predictWebcam();
  } catch (err) {
    console.warn('摄像头打开失败:', err);
    setHintText(cameraErrorText(err));
    return;
  }
  // 3) 模型在后台等（不阻塞页面显示）
  modelReady
    .then((lm) => { handLandmarker = lm; })
    .catch((err) => {
      console.warn('手部模型加载失败:', err);
      setHintText('⚠ 手部模型加载失败，摄像头正常但没有手势识别');
    });
}

/**
 * 页面一打开就开始拉识别模型（不等摄像头授权），
 * 并把下载进度显示在底部提示里——16MB 的包在慢网下要几分钟，
 * 没有进度条会被当成卡死。
 */
let modelReady = null;
function startModelLoad() {
  if (modelReady) return modelReady;
  const WASM_BASE = 'assets/wasm';
  const MODEL_URL = './assets/hand_landmarker.task';

  const visionReady = FilesetResolver.forVisionTasks(WASM_BASE);
  // 模型解压后 7.46MB，用它算百分比和剩余时间，让人知道要等多久
  const MODEL_BYTES = 7.46 * 1048576;
  const t0 = performance.now();
  const modelBlob = fetchWithProgress(MODEL_URL, (got) => {
    if (STATE.mode === 'FOCUS') return;   // 正在翻照片就别抢提示
    const pct = Math.min(99, Math.round((got / MODEL_BYTES) * 100));
    const secs = (performance.now() - t0) / 1000;
    const speed = got / Math.max(secs, 1);                       // 字节/秒
    const left = Math.max(0, (MODEL_BYTES - got) / Math.max(speed, 1));
    const eta = left >= 90 ? `${Math.round(left / 60)} 分钟` : `${Math.max(1, Math.round(left))} 秒`;
    setHintText(`识别模型 ${pct}% · 约还需 ${eta}`, false);
  });

  modelReady = (async () => {
    const [vision, blob] = await Promise.all([visionReady, modelBlob]);
    setHintText('识别模型已下载完 · 正在启动识别引擎…', false);
    return HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: URL.createObjectURL(blob),
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 1,
      // 用 MediaPipe 默认阈值（0.5）：更宽容，暗光/手偏一点也能跟住
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
  })();
  return modelReady;
}

/** 边下边报进度；content-length 是压缩后的大小，所以只报"已下载多少"不报百分比 */
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`模型下载失败 HTTP ${res.status}`);
  if (!res.body || !res.body.getReader) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress) onProgress(got);
  }
  return new Blob(chunks, { type: 'application/octet-stream' });
}

let lastVideoTime = -1;
let lastDetectAt = 0;
const DETECT_INTERVAL_MS = 1000 / 30;   // 手部检测限流到 30fps
// 诊断：真的每秒跑了几次手部检测
const diag = { detects: 0, fps: 0, handHit: 0, lastTick: 0 };
async function predictWebcam() {
  requestAnimationFrame(predictWebcam);
  if (!video || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  // 视频被浏览器暂停时自动续播（否则画面冻结、检测也停摆）
  if (video.paused) video.play().catch(() => {});

  // 模型还没加载好：先把摄像头画面画出来，让用户知道相机是通的
  if (!handLandmarker) {
    drawPreview(null, null);
    return;
  }

  const now = performance.now();
  // 关键：摄像头在 640x480 下可能跑到 60fps，如果每帧都送进 MediaPipe，
  // 相当于把同一帧喂两遍，跟踪器会算错运动而丢掉手部（表现为“完全没反应”）。
  // 这里限流到 30fps，正好是一次视频帧一次检测。
  if (lastDetectAt && now - lastDetectAt < DETECT_INTERVAL_MS) return;

  const dt = lastDetectAt ? (now - lastDetectAt) / 1000 : 1 / 30;
  lastDetectAt = now;

  const result = handLandmarker.detectForVideo(video, now);
  diag.detects++;
  if (result && result.landmarks && result.landmarks.length) diag.handHit++;
  if (now - diag.lastTick > 1000) {
    diag.fps = Math.round((diag.detects * 1000) / (now - diag.lastTick));
    diag.detects = 0;
    diag.lastTick = now;
  }
  processGestures(result, dt);
}

/**
 * 把识别结果喂给手势引擎，并处理模式切换。
 * 引擎内部已经做了归一化 + 滞回 + 多帧投票，这里只做"应用动作"。
 */
function processGestures(result, dt) {
  const lm = (result && result.landmarks && result.landmarks[0]) || null;
  lastLandmarks = lm;

  const ev = gestures.update(lm, dt);
  lastPose = ev;

  STATE.hand.detected = ev.visible;
  STATE.hand.x = ev.x;
  STATE.hand.y = ev.y;

  if (ev.changed) applyMode(ev.mode);

  // "再看一次换一张"：捏合一次 → 翻到下一张（一直捏着只算一次）
  // 注意：不再用左右滑动翻页——捏着拍照时手稍微一移动就会误判成滑动，导致连翻好几张
  if (ev.pinchStart && STATE.mode === 'FOCUS') {
    cycleFocus(1);
  }

  drawPreview(lm, ev);
  updateHud(ev);
}

function applyMode(mode) {
  STATE.mode = mode;
  STATE.focusTarget = null;
  // 进入特写就直接翻到"下一张"，所以每捏一次都是新的一张
  if (mode === 'FOCUS') showPhoto(1);
  else applyFocusOverlay();
  updateHud(lastPose, true);
  flashHint();
}

/** 让当前特写的照片走"独立叠加"图层（不吃泛光/色调映射），其余照片回到普通图层 */
function applyFocusOverlay() {
  const target = STATE.mode === 'FOCUS' ? STATE.focusTarget : null;
  if (overlayPhotoMesh && overlayPhotoMesh !== target) setPhotoOverlay(overlayPhotoMesh, false);
  if (target) setPhotoOverlay(target, true);
  overlayPhotoMesh = target;
}

function photoList() {
  const list = particleSystem.filter(p => p.type === 'PHOTO');
  // 并发加载会让数组顺序不定，这里按相册清单顺序固定下来，翻页才符合直觉
  list.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  return list;
}

/** 当前特写照片是第几张（给 UI 显示 3 / 8） */
function focusInfo() {
  const list = photoList();
  if (!list.length || !STATE.focusTarget) return null;
  let i = STATE.focusIndex;
  if (!(i >= 0 && i < list.length) || list[i].mesh !== STATE.focusTarget) {
    i = list.findIndex(p => p.mesh === STATE.focusTarget);
  }
  return i < 0 ? null : { index: i, total: list.length };
}

/** dir = 1 下一张，-1 上一张；按顺序翻页，不再按指尖位置挑 */
function cycleFocus(dir) {
  showPhoto(dir);
}

function showPhoto(dir) {
  const list = photoList();
  if (!list.length) return;
  focusAtIndex(STATE.focusIndex + dir);
}

/** 直接跳到第 i 张（会自动取模），方向键 / U 键都走这里 */
function focusAtIndex(i) {
  const list = photoList();
  if (!list.length) return;
  const n = list.length;
  STATE.mode = 'FOCUS';
  STATE.focusIndex = ((i % n) + n) % n;
  STATE.focusTarget = list[STATE.focusIndex].mesh;
  ensureFullTexture(STATE.focusTarget);
  applyFocusOverlay();
  flashHint();
  updateHud(lastPose, true);
  if (ui.mode && STATE.mode === 'FOCUS') {
    ui.mode.textContent = `🖼 照片 ${STATE.focusIndex + 1} / ${n} · 捏合或 ↑↓ 翻页`;
    ui.mode.dataset.state = '';
  }
}

// ============================================================
//  摄像头预览：镜像画面 + 手部骨架，让"识别到了什么"一眼可见
// ============================================================
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17]
];
// 每根手指的关节在关键点数组里的下标（画不同颜色用）
const FINGER_JOINTS = [[1,2,3,4],[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]];
const FINGER_COLORS = {
  on: '#7dffb0',
  off: 'rgba(255,255,255,0.25)'
};

function drawPreview(lm, ev) {
  if (!webcamCtx || !webcamCanvas || !video || video.readyState < 2) return;
  const w = webcamCanvas.width;
  const h = webcamCanvas.height;

  // 镜像绘制，符合"照镜子"的直觉（同时和手左右移动的控制方向保持一致）
  webcamCtx.save();
  webcamCtx.translate(w, 0);
  webcamCtx.scale(-1, 1);
  webcamCtx.drawImage(video, 0, 0, w, h);
  webcamCtx.restore();

  if (!lm) return;

  // 关键点也要镜像：镜像后 x_screen = (1 - x) * w
  const px = (i) => (1 - lm[i].x) * w;
  const py = (i) => lm[i].y * h;

  const extended = (ev && ev.extended) || [false,false,false,false,false];

  // 骨骼
  webcamCtx.lineWidth = 2;
  for (const [a, b] of HAND_CONNECTIONS) {
    webcamCtx.strokeStyle = 'rgba(255, 214, 102, 0.55)';
    webcamCtx.beginPath();
    webcamCtx.moveTo(px(a), py(a));
    webcamCtx.lineTo(px(b), py(b));
    webcamCtx.stroke();
  }

  // 手指：伸直的绿色，蜷起的灰色
  FINGER_JOINTS.forEach((joints, fi) => {
    webcamCtx.strokeStyle = extended[fi] ? FINGER_COLORS.on : FINGER_COLORS.off;
    webcamCtx.lineWidth = extended[fi] ? 3 : 2;
    webcamCtx.beginPath();
    const base = fi === 0 ? 1 : joints[0];
    webcamCtx.moveTo(px(base), py(base));
    for (const j of joints) webcamCtx.lineTo(px(j), py(j));
    webcamCtx.stroke();
  });

  // 关键点
  for (let i = 0; i < lm.length; i++) {
    webcamCtx.fillStyle = i === 4 || i === 8 ? '#fff6d0' : 'rgba(255,255,255,0.8)';
    webcamCtx.beginPath();
    webcamCtx.arc(px(i), py(i), i === 4 || i === 8 ? 3 : 1.8, 0, Math.PI * 2);
    webcamCtx.fill();
  }

  // 捏合时把拇指尖-食指尖连一条高亮线，明确告诉用户"我抓到你的捏合了"
  if (ev && ev.label === 'FOCUS') {
    webcamCtx.strokeStyle = '#ff5b7f';
    webcamCtx.lineWidth = 3;
    webcamCtx.beginPath();
    webcamCtx.moveTo(px(4), py(4));
    webcamCtx.lineTo(px(8), py(8));
    webcamCtx.stroke();
  }
}

// ============================================================
//  状态提示 UI
// ============================================================
const ui = {};
function cacheUi() {
  ui.hint = document.getElementById('gesture-hint');
  ui.mode = document.getElementById('gh-mode');
  ui.dot = document.getElementById('gh-dot');
  ui.webcamWrap = document.getElementById('webcam-wrapper');
  ui.debug = document.getElementById('gesture-debug');
  ui.dbgLabel = document.getElementById('dbg-label');
  ui.dbgConf = document.getElementById('dbg-conf');
  ui.dbgPinch = document.getElementById('dbg-pinch');
  ui.dbgSpread = document.getElementById('dbg-spread');
  ui.dbgCurl = document.getElementById('dbg-curl');
  ui.dbgVotes = document.getElementById('dbg-votes');
  ui.dbgDet = document.getElementById('dbg-det');
  ui.dbgVideo = document.getElementById('dbg-video');
  ui.dbgFingers = document.getElementById('dbg-fingers');
  if (ui.dbgFingers && !ui.dbgFingers.childElementCount) {
    for (const def of FINGER_DEFS) {
      const dot = document.createElement('span');
      dot.className = 'finger-dot';
      dot.dataset.key = def.key;
      dot.title = def.label;
      dot.textContent = def.label[0];
      ui.dbgFingers.appendChild(dot);
    }
  }
}

const MODE_TEXT = {
  TREE: '🎄 圣诞树',
  SCATTER: '✨ 散开',
  FOCUS: '🖼 照片特写',
  IDLE: '待机',
  OFF: '手势不可用'
};

function setHint(mode) {
  if (!ui.mode) return;
  ui.mode.textContent = mode === 'OFF'
    ? '手势识别不可用（需要摄像头权限）'
    : (MODE_TEXT[mode] || MODE_TEXT.IDLE);
}

/** 直接设置提示文字；warn=true 表示错误（红色、且不会被状态刷新覆盖） */
function setHintText(text, warn = true) {
  if (!ui.mode) return;
  ui.mode.textContent = text;
  if (warn) {
    ui.mode.dataset.state = 'ERR';
    if (ui.hint) ui.hint.classList.add('warn');
    if (ui.dot) ui.dot.classList.remove('on');
  } else {
    ui.mode.dataset.state = '';
    if (ui.hint) ui.hint.classList.remove('warn');
  }
}

let hudAt = 0;
function updateHud(ev, force = false) {
  if (!ev) return;
  const now = performance.now();
  if (!force && now - hudAt < 100) return;
  hudAt = now;

  // 只要摄像头通了就显示预览，不再等"识别到手"才出现
  if (ui.webcamWrap) ui.webcamWrap.classList.toggle('active', cameraLive);
  if (ui.dot) ui.dot.classList.toggle('on', !!ev.visible);

  // 顶部/底部主提示：只有"识别到手"时才覆盖为手势名，避免一闪一闪
  if (ui.mode) {
    if (ui.mode.dataset.state === 'ERR') return;   // 出错信息不要被状态刷掉
    const info = STATE.mode === 'FOCUS' ? focusInfo() : null;
    if (info) {
      // 用方向键翻照片时也要显示序号（不依赖是否识别到手）
      ui.mode.textContent = `🖼 照片 ${info.index + 1} / ${info.total} · 捏合或 ↑↓ 翻页`;
      ui.mode.dataset.state = ev.visible ? ev.label : 'NONE';
    } else if (ev.visible) {
      ui.mode.textContent = MODE_TEXT[ev.mode] || MODE_TEXT.IDLE;
      ui.mode.dataset.state = ev.label;
    } else {
      ui.mode.textContent = cameraLive
        ? '摄像头已就绪 · 把手举到画面里'
        : '把手举到摄像头前…';
      ui.mode.dataset.state = 'NONE';
    }
  }

  if (!ui.debug || !ui.debug.classList.contains('visible')) return;

  const m = ev.metrics;
  if (ui.dbgLabel) ui.dbgLabel.textContent = ev.label;
  if (ui.dbgConf) ui.dbgConf.textContent = (ev.confidence * 100).toFixed(0) + '%';
  if (m) {
    if (ui.dbgPinch) ui.dbgPinch.textContent = m.pinch.toFixed(2);
    if (ui.dbgSpread) ui.dbgSpread.textContent = m.spread.toFixed(2);
    if (ui.dbgCurl) ui.dbgCurl.textContent = m.indexCurl.toFixed(2);
  }
  if (ui.dbgVotes) {
    ui.dbgVotes.textContent = gestures.votes.length ? gestures.votes.join(' ') : '—';
  }
  if (ui.dbgDet) ui.dbgDet.textContent = `${diag.fps}/s`;
  if (ui.dbgVideo && video) {
    ui.dbgVideo.textContent = video.paused
      ? '已暂停'
      : `${video.videoWidth}x${video.videoHeight} ${video.currentTime.toFixed(1)}s`;
  }
  if (ui.dbgFingers) {
    const dots = ui.dbgFingers.children;
    for (let i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('on', !!ev.extended[i]);
    }
  }
}

function flashHint() {
  if (!ui.hint) return;
  ui.hint.classList.remove('flash');
  // 触发重排，让动画可以重放
  void ui.hint.offsetWidth;
  ui.hint.classList.add('flash');
}

function setupEvents() {
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    updateViewMetrics();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });
  const input = document.getElementById('file-input');
  if (input) input.addEventListener('change', handleImageUpload);
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'h') {
      const controls = document.querySelector('.upload-wrapper');
      if (controls) controls.classList.toggle('ui-hidden');
    } else if (k === 'g' && ui.debug) {
      ui.debug.classList.toggle('visible');
    } else if (k === 'arrowdown' || k === 'arrowup') {
      // 方向键翻照片：手累了可以不用手势
      e.preventDefault();
      const list = photoList();
      if (!list.length) return;
      if (STATE.mode !== 'FOCUS') {
        focusAtIndex(k === 'arrowdown' ? 0 : list.length - 1);
      } else {
        focusAtIndex(STATE.focusIndex + (k === 'arrowdown' ? 1 : -1));
      }
    } else if (k === 'u') {
      // U 直接回到第一张
      e.preventDefault();
      focusAtIndex(0);
    }
  });
}



function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  updateSceneRotation(dt);
  for (const p of particleSystem) p.update(dt, STATE.mode, STATE.focusTarget);
  if (photoCamera) {
    photoCamera.position.copy(camera.position);
    photoCamera.quaternion.copy(camera.quaternion);
    photoCamera.projectionMatrix.copy(camera.projectionMatrix);
    photoCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  }
  composer.render();
  // 照片叠加层：后处理完成后直接画在画布上，保证照片是原图颜色
  if (overlayPhotoMesh) {
    // scene.background 是纯色时 three 会强制清屏，必须连 autoClearColor 一起关，
    // 否则这一帧会把后处理结果（背景里的散开粒子）整块擦黑
    const prevClearColor = renderer.autoClearColor;
    renderer.autoClear = false;
    renderer.autoClearColor = false;
    renderer.clearDepth();
    renderer.render(scene, photoCamera);
    renderer.autoClearColor = prevClearColor;
    renderer.autoClear = true;
  }
}

/**
 * 场景旋转：
 *  - SCATTER：手掌横向位置直接映射到 ±180°，整圈都能转到；纵向控制俯仰
 *  - TREE / FOCUS：缓慢自转，俯仰回正
 * 手放在画面中间只有 3% 死区，几乎一动手就有反馈。
 */
function updateSceneRotation(dt) {
  const rot = gestures.cfg.smooth;
  if (STATE.mode === 'SCATTER' && STATE.hand.detected) {
    // 纯函数：手掌位置 → 朝向，单级平滑 16/s（约 60ms 跟手）
    const next = followRotation(STATE.rotation, { x: gestures.x, y: gestures.y }, rot, dt);
    STATE.rotation.y = next.y;
    STATE.rotation.x = next.x;
  } else if (STATE.mode === 'TREE') {
    STATE.rotation.y += 0.3 * dt;
    STATE.rotation.x += (0 - STATE.rotation.x) * (1 - Math.exp(-2.0 * dt));
  } else {
    STATE.rotation.y += 0.1 * dt;
    STATE.rotation.x += (0 - STATE.rotation.x) * (1 - Math.exp(-2.0 * dt));
  }
  mainGroup.rotation.y = STATE.rotation.y;
  mainGroup.rotation.x = STATE.rotation.x;
}

init();
