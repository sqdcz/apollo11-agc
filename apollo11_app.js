/* APOLLO 11 · AGC MISSION CONSOLE
   真实尺度双空间：深空段 1 单位 = 1 km；月面段 1 单位 = 1 m
   贴图全部本地生成或本地文件，无外部请求。 */
(function () {
"use strict";

/* ================= 工具 ================= */
var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
var lerp = function (a, b, t) { return a + (b - a) * t; };
var ease = function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
var $ = function (id) { return document.getElementById(id); };
var D2R = Math.PI / 180;
var V3 = function (x, y, z) { return new THREE.Vector3(x, y, z); };
var UP_Y = new THREE.Vector3(0, 1, 0);
var _tmpA = V3(), _tmpB = V3(), _tmpC = V3();

/* 值噪声（置换表，避免大量 Math.sin 调用） */
var PERM = new Uint8Array(512);
(function () {
  var r = new Uint8Array(256), i, j, t;
  for (i = 0; i < 256; i++) r[i] = i;
  for (i = 255; i > 0; i--) { j = (Math.random() * (i + 1)) | 0; t = r[i]; r[i] = r[j]; r[j] = t; }
  for (i = 0; i < 512; i++) PERM[i] = r[i & 255];
})();
function h2(i, j) { return PERM[(PERM[i & 255] + (j & 255)) & 255] / 255; }
function vnoise(x, y) {
  var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  var a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function fbm(x, y, oct) {
  var s = 0, a = 0.5, f = 1, i;
  for (i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}
function cvs(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function ctex(c, rx, ry, linear) {
  var t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (rx) t.repeat.set(rx, ry || rx);
  t.anisotropy = 8;
  /* 颜色贴图必须标 sRGB，否则会被当成线性数据，整体偏亮发白 */
  if (!linear) t.encoding = THREE.sRGBEncoding;
  return t;
}

/* ================= 渲染基础 ================= */
/* r128 没有颜色管理：hex 颜色被当作线性值直接进光照计算，
   于是 #6a675f 这种中灰会被当成 0.42 的反照率（相当于 sRGB 0.68 的亮灰），
   整个画面因此永远偏亮、明暗对比永远出不来。
   这里统一把写出来的 hex 当成 sRGB，转一次到线性空间，颜色才对得上眼睛。 */
(function () {
  var _setHex = THREE.Color.prototype.setHex;
  THREE.Color.prototype.setHex = function (hex) {
    _setHex.call(this, hex);
    return this.convertSRGBToLinear();
  };
})();

var FOG_HAZE = new THREE.Color(0xc9d7e2);
/* 天空穹顶的 uFade 是线性乘子，这里做一次 gamma 近似，视觉上更接近"变暗" */
function sftoLinear(v) { return Math.pow(clamp(v, 0, 1), 1.6); }

var canvas = $('scene');
var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
if ('toneMapping' in renderer) { renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.92; }

var scene = new THREE.Scene();
var sceneFog = new THREE.Fog(0x0b0d11, 1e7, 2e7);
scene.fog = sceneFog;
/* 发射段的雾色：地面天空色 ↔ 真空近黑 */
var FOG_GROUND = new THREE.Color(0xc9d7e2);
var FOG_SPACE = new THREE.Color(0x070a10);
var camera = new THREE.PerspectiveCamera(48, 1, 0.05, 4000000);

/* 太阳方向：左前上方约 45° 斜射。
   以前是正对镜头方向，等于给所有模型打正平光，明暗交界线跑到轮廓外，
   看起来就像一张贴纸。改成斜射后立体感才出得来。 */
var SUN_DIR = V3(0.78, 0.44, 0.45).normalize();

var sunLight = new THREE.DirectionalLight(0xfff4e2, 2.15);
sunLight.position.copy(SUN_DIR).multiplyScalar(1e6);
scene.add(sunLight);
/* 环境光只负责托底：给太高整机发白、明暗不分，这是之前"光效假"的主因之一 */
scene.add(new THREE.AmbientLight(0x2b3d4e, 0.30));
/* 地照（地球反照光）：从太阳反侧补一点冷光，暗面才不是死黑 */
var bounce = new THREE.DirectionalLight(0x6f93bd, 0.17);
bounce.position.copy(SUN_DIR).multiplyScalar(-1);
bounce.position.y += 0.4;
scene.add(bounce);

/* 太阳本体：球体网格（Sprite 在相机背后会铺满全屏） */
var sunBody = new THREE.Group();
(function () {
  var p = SUN_DIR.clone().multiplyScalar(2400000);
  [[24000, 0xfffdf2, 1, false], [56000, 0xffd9a2, 0.28, true], [112000, 0xffc27a, 0.09, true]]
    .forEach(function (o) {
      var mat = o[3]
        ? new THREE.MeshBasicMaterial({ color: o[1], transparent: true, opacity: o[2], blending: THREE.AdditiveBlending, depthWrite: false })
        : new THREE.MeshBasicMaterial({ color: o[1] });
      var s = new THREE.Mesh(new THREE.SphereGeometry(o[0], 18, 18), mat);
      s.position.copy(p);
      s.frustumCulled = false;
      sunBody.add(s);
    });
  scene.add(sunBody);
})();

/* 天空穹顶：只在发射场/低空出现，随高度上升褪成黑色真空。
   不描这个，火箭就是在纯黑背景里飘着 —— 也就是之前说的"远景有 bug"。 */
var skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(180000, 32, 22),
  new THREE.ShaderMaterial({
    uniforms: { uSun: { value: SUN_DIR }, uFade: { value: 0 } },
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: [
      'varying vec3 vD; uniform vec3 uSun; uniform float uFade;',
      'void main(){',
      ' vec3 d = normalize(vD);',
      ' vec3 zen = vec3(0.030,0.070,0.165);',
      ' vec3 hor = vec3(0.62,0.74,0.86);',
      ' vec3 col = mix(hor, zen, pow(clamp(d.y,0.0,1.0), 0.40));',
      ' float below = clamp(-d.y*4.0, 0.0, 1.0);',
      ' col = mix(col, hor*0.80, below);',
      ' float s = max(dot(d, normalize(uSun)), 0.0);',
      ' col += vec3(1.0,0.88,0.66) * pow(s, 260.0) * 2.4;',
      ' col += vec3(1.0,0.84,0.58) * pow(s, 7.0) * 0.13;',
      ' gl_FragColor = vec4(col * mix(uFade, 1.0, below * 0.92), 1.0);',
      '}'
    ].join('\n'),
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false
  })
);
skyDome.renderOrder = -100;
skyDome.visible = false;
scene.add(skyDome);

/* 星空（带亮度与色温差异） */
var starField = (function () {
  var g = new THREE.BufferGeometry(), n = 3800, p = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (var i = 0; i < n; i++) {
    var r = 1600000, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    p[i * 3] = r * Math.sin(ph) * Math.cos(th);
    p[i * 3 + 1] = r * Math.cos(ph);
    p[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    var b = 0.35 + Math.pow(Math.random(), 2.4) * 0.65;
    var warm = Math.random();
    col[i * 3] = b * (0.86 + warm * 0.14);
    col[i * 3 + 1] = b * (0.92 + warm * 0.06);
    col[i * 3 + 2] = b;
  }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  var pts = new THREE.Points(g, new THREE.PointsMaterial({
    size: 2.1, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false
  }));
  scene.add(pts);
  return pts;
})();

/* ================= 深空天体（1 单位 = 1 km） ================= */
var EARTH_R = 6371, MOON_R = 1737, D_EM = 384400;
var TL = new THREE.TextureLoader();
function loadSRGB(url, cb) {
  TL.load(url, function (t) {
    if ('encoding' in t) t.encoding = THREE.sRGBEncoding;
    t.anisotropy = 8;
    cb(t);
  });
}

/* 地球 */
var earthMat = new THREE.MeshStandardMaterial({
  color: 0xd6d6d6, roughness: 0.86, metalness: 0.02
});
loadSRGB('earth_atmos_2048.jpg', function (t) {
  earthMat.map = t;
  /* 从月球看地球是亮的（大气散射），不能让它背光面变成黑球：
     同一张图兼作自发光，给一个较低的强度，既保住明暗交界线又不至于死黑 */
  earthMat.emissive = new THREE.Color(0xffffff);
  earthMat.emissiveMap = t;
  earthMat.emissiveIntensity = 0.38;
  earthMat.needsUpdate = true;
});
loadSRGB('earth_normal_2048.jpg', function (t) {
  earthMat.normalMap = t; earthMat.normalScale = new THREE.Vector2(0.7, 0.7); earthMat.needsUpdate = true;
});
loadSRGB('earth_specular_2048.jpg', function (t) {
  earthMat.roughnessMap = t; earthMat.metalness = 0.12; earthMat.needsUpdate = true;
});
var earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 128, 128), earthMat);
earth.rotation.y = 2.1;
scene.add(earth);

/* 云层 */
var cloudMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false, roughness: 1, metalness: 0
});
loadSRGB('earth_clouds_1024.png', function (t) {
  cloudMat.map = t; cloudMat.alphaMap = t; cloudMat.needsUpdate = true;
});
var clouds = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * 1.008, 96, 96), cloudMat);
earth.add(clouds);

/* 大气：Fresnel 边缘辉光（不是整圈糊蓝） */
var atmoMat = new THREE.ShaderMaterial({
  uniforms: {},
  vertexShader: [
    'varying vec3 vN; varying vec3 vP;',
    'void main(){ vN=normalize(normalMatrix*normal);',
    ' vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz;',
    ' gl_Position=projectionMatrix*mv; }'
  ].join('\n'),
  fragmentShader: [
    'varying vec3 vN; varying vec3 vP;',
    'void main(){',
    ' float f=1.0-abs(dot(normalize(vN),normalize(-vP)));',
    ' f=pow(clamp(f,0.0,1.0),3.2);',
    ' vec3 c=mix(vec3(0.16,0.42,0.95),vec3(0.55,0.82,1.0),f);',
    ' gl_FragColor=vec4(c, f*0.55);',
    '}'
  ].join('\n'),
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide
});
var atmo = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * 1.022, 64, 64), atmoMat);
earth.add(atmo);

/* 月球 */
var moonMat = new THREE.MeshStandardMaterial({ color: 0x8d8d8d, roughness: 0.96, metalness: 0.02 });
loadSRGB('moon_1024.jpg', function (t) {
  moonMat.map = t;
  /* 环月段的相机在 100 km 高度俯视整个月面，经常落在背光面 ——
     不给自发光就是纯黑一片（像素采样实测 0,0,0），加一点像地球照的底光 */
  moonMat.emissive = new THREE.Color(0xffffff);
  moonMat.emissiveMap = t;
  moonMat.emissiveIntensity = 0.16;
  moonMat.needsUpdate = true;
});
var moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_R, 144, 144), moonMat);
moon.visible = false;
scene.add(moon);

/* ================= 月面地表（程序化高清：颜色 + 法线 + 起伏） ================= */
function buildLunarMaps() {
  var S = 1024;
  var hgt = new Float32Array(S * S);
  var i, x, y, dx, dy, d, v, idx;
  /* 基础起伏：低频地形 + 中频微起伏，幅度刻意压低（真实月壤对比很弱） */
  for (y = 0; y < S; y++) {
    for (x = 0; x < S; x++) {
      hgt[y * S + x] = (fbm(x / 130, y / 130, 3) - 0.5) * 0.55
        + (fbm(x / 38, y / 38, 3) - 0.5) * 0.32;
    }
  }
  /* 陨石坑：小坑多、大坑少，边缘不设亮环 */
  for (i = 0; i < 170; i++) {
    var cr = 3.5 + Math.pow(Math.random(), 3.4) * 46;
    var cx = Math.random() * S, cy = Math.random() * S;
    if (cx < cr * 1.8 || cy < cr * 1.8 || cx > S - cr * 1.8 || cy > S - cr * 1.8) continue;
    var dep = 0.30 + Math.random() * 0.55;
    var x0 = Math.max(0, (cx - cr * 1.6) | 0), x1 = Math.min(S - 1, (cx + cr * 1.6) | 0);
    var y0 = Math.max(0, (cy - cr * 1.6) | 0), y1 = Math.min(S - 1, (cy + cr * 1.6) | 0);
    for (y = y0; y <= y1; y++) {
      for (x = x0; x <= x1; x++) {
        dx = x - cx; dy = y - cy;
        d = Math.sqrt(dx * dx + dy * dy) / cr;
        if (d > 1.6) continue;
        if (d < 1) v = -Math.sqrt(1 - d * d) * dep + (d > 0.88 ? dep * 0.10 : 0);
        else v = dep * 0.16 * Math.exp(-(d - 1) * 4.2);
        idx = y * S + x;
        hgt[idx] = hgt[idx] + v;
      }
    }
  }
  /* 细碎石子与微坑 */
  for (i = 0; i < 2600; i++) {
    x = (Math.random() * S) | 0; y = (Math.random() * S) | 0;
    var rr = 1.0 + Math.random() * 3.0;
    for (var oy = -2; oy <= 2; oy++) for (var ox = -2; ox <= 2; ox++) {
      var ddx = ox / rr, ddy = oy / rr, dd = ddx * ddx + ddy * ddy;
      if (dd > 1) continue;
      var px = (x + ox + S) % S, py = (y + oy + S) % S;
      hgt[py * S + px] -= (1 - dd) * 0.028;
    }
  }
  /* 溅射亮斑 */
  for (i = 0; i < 140; i++) {
    x = (Math.random() * S) | 0; y = (Math.random() * S) | 0;
    var sr = 4 + Math.random() * 22;
    for (var sy = -sr; sy <= sr; sy += 2) for (var sx = -sr; sx <= sr; sx += 2) {
      var sd = Math.sqrt(sx * sx + sy * sy) / sr;
      if (sd > 1) continue;
      var qx = (x + sx + S) % S, qy = (y + sy + S) % S;
      hgt[qy * S + qx] += (1 - sd) * (1 - sd) * 0.10;
    }
  }

  /* 法线（Sobel）——同时用来给反照率烘焙明暗。
     地面材质不带 normalMap（低端显卡上会出棋盘噪点），
     所以把太阳方向下的浮雕明暗直接烤进颜色里，坑才有立体感。 */
  var str = 13;
  /* 太阳在贴图 uv 空间的投影：u 沿 +X，v 沿 -Z（平面绕 X 转了 -90°） */
  var Lu = 0.866, Lv = -0.500;
  var nrm = new Float32Array(S * S * 2);
  for (y = 0; y < S; y++) {
    for (x = 0; x < S; x++) {
      var xa = (x - 1 + S) % S, xb = (x + 1) % S, ya = (y - 1 + S) % S, yb = (y + 1) % S;
      var hl = hgt[y * S + xa], hr = hgt[y * S + xb], hu = hgt[ya * S + x], hd = hgt[yb * S + x];
      var nX = (hl - hr) * str, nY = (hu - hd) * str;
      var len = Math.sqrt(nX * nX + nY * nY + 1);
      nrm[(y * S + x) * 2] = nX / len;
      nrm[(y * S + x) * 2 + 1] = nY / len;
    }
  }

  /* 颜色贴图：暖灰 + 浮雕明暗 + 颗粒 */
  var cc = cvs(S, S), cx2 = cc.getContext('2d');
  var img = cx2.createImageData(S, S), data = img.data;
  for (i = 0; i < S * S; i++) {
    var h = hgt[i];
    var lam = nrm[i * 2] * Lu + nrm[i * 2 + 1] * Lv;
    var shade = clamp(0.60 + lam * 0.52, 0.16, 1.20);
    var br = (116 + h * 54) * shade + (vnoise((i % S) * 0.7, ((i / S) | 0) * 0.7) - 0.5) * 14;
    br = clamp(br, 34, 196);
    data[i * 4] = br * 1.015;
    data[i * 4 + 1] = br * 0.988;
    data[i * 4 + 2] = br * 0.948;
    data[i * 4 + 3] = 255;
  }
  cx2.putImageData(img, 0, 0);

  /* 法线贴图（保留备用，地面材质当前不挂） */
  var nc = cvs(S, S), nx2 = nc.getContext('2d');
  var nimg = nx2.createImageData(S, S), nd = nimg.data;
  for (i = 0; i < S * S; i++) {
    var k = i * 4;
    nd[k] = (nrm[i * 2] * 0.5 + 0.5) * 255;
    nd[k + 1] = (nrm[i * 2 + 1] * 0.5 + 0.5) * 255;
    nd[k + 2] = 255;
    nd[k + 3] = 255;
  }
  nx2.putImageData(nimg, 0, 0);

  /* 粗糙度贴图 */
  var rc = cvs(S, S), rx2 = rc.getContext('2d');
  var rimg = rx2.createImageData(S, S), rd = rimg.data;
  for (i = 0; i < S * S; i++) {
    var g = 235 + clamp(hgt[i], -1, 1) * 18;
    rd[i * 4] = rd[i * 4 + 1] = rd[i * 4 + 2] = g;
    rd[i * 4 + 3] = 255;
  }
  rx2.putImageData(rimg, 0, 0);

  var tc = ctex(cc, 1, 1), tn = ctex(nc, 1, 1, true), tr = ctex(rc, 1, 1, true);
  tc.anisotropy = 16; tn.anisotropy = 16;
  return { color: tc, normal: tn, rough: tr };
}

var LMAPS = buildLunarMaps();
LMAPS.color.repeat.set(150, 150);
LMAPS.normal.repeat.set(26, 26);
LMAPS.rough.repeat.set(26, 26);
var groundGeo = new THREE.PlaneGeometry(120000, 120000, 110, 110);
(function () {
  var pa = groundGeo.attributes.position, i, x, y, r, f, h;
  for (i = 0; i < pa.count; i++) {
    x = pa.getX(i); y = pa.getY(i); r = Math.sqrt(x * x + y * y);
    f = clamp((r - 2600) / 26000, 0, 1);
    h = (fbm(x * 0.00007 + 13.2, y * 0.00007 + 7.7, 3) - 0.5) * 420 * f
      + (fbm(x * 0.0006, y * 0.0006, 2) - 0.5) * 26 * f;
    pa.setZ(i, h);
  }
  groundGeo.computeVertexNormals();
})();
var groundMat = new THREE.MeshStandardMaterial({
  map: LMAPS.color, roughnessMap: LMAPS.rough, roughness: 0.98, metalness: 0, color: 0xffffff
});
var ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.visible = false;
scene.add(ground);

/* 散落月岩 */
var rocks = new THREE.Group();
(function () {
  var m = new THREE.MeshStandardMaterial({ color: 0x6f6a61, roughness: 0.96, metalness: 0.02, flatShading: true });
  for (var i = 0; i < 24; i++) {
    var s = 0.5 + Math.random() * 2.8;
    var g = new THREE.IcosahedronGeometry(s, 0);
    var mesh = new THREE.Mesh(g, m);
    var a = Math.random() * Math.PI * 2, r = 24 + Math.random() * 1100;
    /* 半埋在月壤里，避免看起来像浮空的几何体 */
    mesh.position.set(Math.cos(a) * r, s * 0.18, Math.sin(a) * r);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    mesh.scale.set(1, 0.55 + Math.random() * 0.35, 1);
    rocks.add(mesh);
  }
})();
rocks.visible = false;
scene.add(rocks);

/* ================= 贴图工厂：金属箔 / 涂装 / 喷流 ================= */
/* 隔热箔：真实 LM/CSM 外面包的是多层镀铝聚酰亚胺，皱褶是成片、有方向的长条，
   不是满地椒盐噪点。旧版是 512px 撒随机短线 + bumpScale 0.5，近距离看就是一片电视雪花。 */
function foilTexture(base, dark, light, seed) {
  var S = 1024, c = cvs(S, S), x = c.getContext('2d'), i, k;
  x.fillStyle = base; x.fillRect(0, 0, S, S);

  /* 大尺度明暗：整片箔面的起伏 */
  for (i = 0; i < 70; i++) {
    var px = Math.random() * S, py = Math.random() * S, r = 90 + Math.random() * 320;
    var gr = x.createRadialGradient(px, py, 0, px, py, r);
    gr.addColorStop(0, (Math.random() > 0.5 ? light : dark).replace('ALPHA', (0.03 + Math.random() * 0.07).toFixed(3)));
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill();
  }

  /* 主体：揉皱的箔。真实 MLI 是无数不规则的小平面，
     各面朝向不同，所以明暗是一块一块的，不是一道道条纹。 */
  for (i = 0; i < 2200; i++) {
    var cx = Math.random() * S, cy = Math.random() * S;
    var rad = 6 + Math.random() * 34;
    var sides = 3 + ((Math.random() * 3) | 0);
    var a0 = Math.random() * Math.PI * 2;
    x.beginPath();
    for (k = 0; k < sides; k++) {
      var aa = a0 + (k / sides) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      var rr2 = rad * (0.55 + Math.random() * 0.75);
      var qx = cx + Math.cos(aa) * rr2, qy = cy + Math.sin(aa) * rr2;
      if (k === 0) x.moveTo(qx, qy); else x.lineTo(qx, qy);
    }
    x.closePath();
    var lit = Math.random();
    x.fillStyle = lit > 0.52
      ? light.replace('ALPHA', (0.03 + Math.random() * 0.13).toFixed(3))
      : dark.replace('ALPHA', (0.03 + Math.random() * 0.15).toFixed(3));
    x.fill();
  }

  /* 折痕亮线：短、锐，代表箔面折过来的那一道 */
  for (i = 0; i < 340; i++) {
    var fx = Math.random() * S, fy = Math.random() * S;
    var fl = 16 + Math.random() * 64, fa = Math.random() * Math.PI * 2;
    x.strokeStyle = light.replace('ALPHA', (0.08 + Math.random() * 0.16).toFixed(3));
    x.lineWidth = 0.6 + Math.random() * 1.4;
    x.beginPath(); x.moveTo(fx, fy);
    x.lineTo(fx + Math.cos(fa) * fl, fy + Math.sin(fa) * fl);
    x.stroke();
  }

  var t = ctex(c, seed || 1, seed || 1);
  t.anisotropy = 8;
  return t;
}
var TEX_GOLD = foilTexture('#b08a4e', 'rgba(78,54,22,ALPHA)', 'rgba(255,232,176,ALPHA)', 2);
var TEX_SILVER = foilTexture('#c3ccd4', 'rgba(70,84,96,ALPHA)', 'rgba(255,255,255,ALPHA)', 1.5);

/* 喷漆蒙皮：极浅的面板线 + 轻微不均，避免纯色塑料感 */
function paintTexture(base, lineAlpha) {
  var S = 512, c = cvs(S, S), x = c.getContext('2d'), i;
  x.fillStyle = base; x.fillRect(0, 0, S, S);
  for (i = 0; i < 900; i++) {
    x.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.045).toFixed(3) + ')';
    x.beginPath(); x.arc(Math.random() * S, Math.random() * S, 5 + Math.random() * 46, 0, 7); x.fill();
  }
  x.strokeStyle = 'rgba(108,112,120,' + lineAlpha + ')';
  x.lineWidth = 1.3;
  for (i = 0; i < 6; i++) { x.beginPath(); x.moveTo(i * S / 6, 0); x.lineTo(i * S / 6, S); x.stroke(); }
  for (i = 0; i < 8; i++) { x.beginPath(); x.moveTo(0, i * S / 8); x.lineTo(S, i * S / 8); x.stroke(); }
  return ctex(c, 1, 1);
}
var TEX_PAINT = paintTexture('#eceae1', 0.16);
var TEX_PAINT_B = paintTexture('#d8d6cc', 0.13);

/* 透明底贴花（USA / 国旗 / 编号），只画图案，其余透明 */
function textTex(w, h, draw) {
  var c = cvs(w, h), x = c.getContext('2d');
  x.clearRect(0, 0, w, h);
  draw(x, w, h);
  var t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.encoding = THREE.sRGBEncoding;
  t.anisotropy = 8;
  return t;
}
/* 竖排 "USA" */
function usaTex() {
  return textTex(160, 1024, function (x, w, h) {
    x.translate(w / 2, h / 2);
    x.rotate(-Math.PI / 2);
    x.fillStyle = '#17191c';
    x.font = 'bold 128px Arial, Helvetica, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('USA', 0, 0);
  });
}
var TEX_USA = usaTex();
/* 星条旗 */
function flagTex() {
  return textTex(512, 280, function (x, w, h) {
    var i;
    x.fillStyle = '#f7f7f7'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#b32434';
    for (i = 0; i < 7; i++) x.fillRect(0, h * (i * 2) / 13, w, h / 13);
    x.fillStyle = '#1e2a5a'; x.fillRect(0, 0, w * 0.41, h * 0.54);
    x.fillStyle = '#fff';
    for (i = 0; i < 50; i++) {
      var cx = w * 0.03 + (i % 6) * w * 0.062;
      var cy = h * 0.05 + ((i / 6) | 0) * h * 0.075;
      x.beginPath(); x.arc(cx, cy, 2.6, 0, 7); x.fill();
    }
  });
}
var TEX_FLAG = flagTex();

/* 土星五号一级涂装（周向 wrap）：白漆 + 底部滚转标定黑白块 + 发动机附近的熏黑
   注意 cylinder 的 v=0 在底部，而 canvas 的 y=H 在底部，所以"底部"画在 H 附近 */
function saturnLivery() {
  var W = 2048, H = 4096, c = cvs(W, H), x = c.getContext('2d'), i;
  var g0 = x.createLinearGradient(0, 0, W, 0);
  g0.addColorStop(0, '#e7e4da'); g0.addColorStop(0.35, '#f7f5ee');
  g0.addColorStop(0.7, '#e9e6dc'); g0.addColorStop(1, '#e7e4da');
  x.fillStyle = g0; x.fillRect(0, 0, W, H);
  /* 环向焊缝（横向细线，间距不等，别太规则） */
  x.strokeStyle = 'rgba(140,138,130,.20)'; x.lineWidth = 2;
  for (i = 0; i < 26; i++) { var yy = H * (i / 26) + (i % 3) * 9; x.beginPath(); x.moveTo(0, yy); x.lineTo(W, yy); x.stroke(); }
  /* 纵向蒙皮拼缝 */
  x.strokeStyle = 'rgba(150,148,140,.13)'; x.lineWidth = 2.5;
  for (i = 0; i < 12; i++) { x.beginPath(); x.moveTo(i * W / 12, 0); x.lineTo(i * W / 12, H); x.stroke(); }

  /* 底部滚转标定：4 象限黑白交替，高约 5.6 m */
  var bh = H * 0.133;
  for (i = 0; i < 8; i++) {
    x.fillStyle = i % 2 ? '#f2efe6' : '#15171a';
    x.fillRect(i * W / 8, H - bh, W / 8, bh);
  }
  /* 滚转图案上方一道细黑环 */
  x.fillStyle = '#15171a'; x.fillRect(0, H - bh - H * 0.006, W, H * 0.006);

  /* 靠近尾部的熏黑/油污 */
  for (i = 0; i < 260; i++) {
    var a = 0.03 + Math.random() * 0.09;
    x.fillStyle = 'rgba(' + (110 + Math.random() * 50 | 0) + ',' + (104 + Math.random() * 48 | 0) + ',' + (94 + Math.random() * 46 | 0) + ',' + a.toFixed(3) + ')';
    x.beginPath();
    x.arc(Math.random() * W, H - Math.random() * H * 0.22, 6 + Math.random() * 60, 0, 7);
    x.fill();
  }
  /* 上部轻微的色差与污渍 */
  for (i = 0; i < 500; i++) {
    x.fillStyle = 'rgba(' + (150 + Math.random() * 60 | 0) + ',' + (148 + Math.random() * 58 | 0) + ',' + (140 + Math.random() * 55 | 0) + ',' + (0.03 + Math.random() * 0.07).toFixed(3) + ')';
    x.beginPath(); x.arc(Math.random() * W, Math.random() * H, 4 + Math.random() * 30, 0, 7); x.fill();
  }
  return ctex(c, 1, 1);
}
var TEX_LIVERY = saturnLivery();

/* 喷流贴图（竖向渐变 + 横向衰减） */
function plumeTexture(inner, outer, mid, end) {
  var W = 128, H = 256, c = cvs(W, H), x = c.getContext('2d');
  var g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, inner); g.addColorStop(0.22, outer);
  g.addColorStop(0.62, mid); g.addColorStop(1, end);
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  /* 横向削边 */
  var g2 = x.createLinearGradient(0, 0, W, 0);
  g2.addColorStop(0, 'rgba(0,0,0,1)'); g2.addColorStop(0.5, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,1)');
  x.globalCompositeOperation = 'destination-out';
  x.fillStyle = g2; x.fillRect(0, 0, W, H);
  x.globalCompositeOperation = 'source-over';
  var t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.encoding = THREE.sRGBEncoding;
  return t;
}
var TEX_PLUME = plumeTexture('rgba(255,246,214,.99)', 'rgba(255,182,82,.94)', 'rgba(252,124,42,.58)', 'rgba(196,80,26,0)');
var TEX_PLUME_BLUE = plumeTexture('rgba(244,252,255,.95)', 'rgba(168,222,255,.72)', 'rgba(118,190,255,.30)', 'rgba(88,148,255,0)');

/* 光点标记 */
function dotTexture() {
  var c = cvs(96, 96), x = c.getContext('2d');
  var g = x.createRadialGradient(48, 48, 0, 48, 48, 48);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(160,240,255,.95)');
  g.addColorStop(0.42, 'rgba(60,190,255,.35)');
  g.addColorStop(1, 'rgba(0,120,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 96, 96);
  var t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  return t;
}
var TEX_DOT = dotTexture();

/* 再入等离子辉光（橙红渐变，加法混合） */
function glowTexture(rgb) {
  var S = 256, c = cvs(S, S), x = c.getContext('2d');
  var g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,240,1)');
  g.addColorStop(0.22, 'rgba(' + rgb + ',0.85)');
  g.addColorStop(0.55, 'rgba(' + rgb + ',0.30)');
  g.addColorStop(1, 'rgba(' + rgb + ',0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  var t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  return t;
}
var TEX_GLOW = glowTexture('255,140,50');

/* LM 接触阴影（软圆盘，弥补无实时阴影） */
var lmShadow = new THREE.Mesh(
  new THREE.CircleGeometry(1, 32),
  new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0, depthWrite: false, alphaMap: TEX_DOT })
);
lmShadow.rotation.x = -Math.PI / 2;
lmShadow.position.y = 0.06;
lmShadow.visible = false;
scene.add(lmShadow);

/* 月尘 */
function dustTexture() {
  var S = 256, c = cvs(S, S), x = c.getContext('2d');
  for (var i = 0; i < 900; i++) {
    var px = S / 2 + (Math.random() - 0.5) * S * 0.92;
    var py = S / 2 + (Math.random() - 0.5) * S * 0.92;
    var r = 2 + Math.random() * 16;
    var g = x.createRadialGradient(px, py, 0, px, py, r);
    var a = 0.02 + Math.random() * 0.09;
    g.addColorStop(0, 'rgba(190,180,162,' + a + ')');
    g.addColorStop(1, 'rgba(150,142,126,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill();
  }
  var t = new THREE.CanvasTexture(c);
  t.encoding = THREE.sRGBEncoding;
  return t;
}

/* 服务舱蒙皮：白漆 + 中段灰色散热板阵列 + 面板缝 */
function smSkin() {
  var W = 1024, H = 1024, c = cvs(W, H), x = c.getContext('2d'), i;
  x.fillStyle = '#f2f4f5'; x.fillRect(0, 0, W, H);
  for (i = 0; i < 700; i++) {
    x.fillStyle = 'rgba(200,208,212,' + (Math.random() * 0.28).toFixed(3) + ')';
    x.beginPath(); x.arc(Math.random() * W, Math.random() * H, 6 + Math.random() * 34, 0, 7); x.fill();
  }
  /* 散热板带 */
  x.fillStyle = '#d3d8db'; x.fillRect(0, H * 0.34, W, H * 0.36);
  x.strokeStyle = 'rgba(118,126,132,.75)'; x.lineWidth = 3;
  for (i = 0; i <= 20; i++) { x.beginPath(); x.moveTo(i * W / 20, H * 0.34); x.lineTo(i * W / 20, H * 0.70); x.stroke(); }
  x.lineWidth = 4;
  x.beginPath(); x.moveTo(0, H * 0.34); x.lineTo(W, H * 0.34); x.stroke();
  x.beginPath(); x.moveTo(0, H * 0.70); x.lineTo(W, H * 0.70); x.stroke();
  /* 上下环向缝 */
  x.strokeStyle = 'rgba(130,136,142,.5)'; x.lineWidth = 2.5;
  [0.10, 0.20, 0.84, 0.94].forEach(function (v) {
    x.beginPath(); x.moveTo(0, H * v); x.lineTo(W, H * v); x.stroke();
  });
  return ctex(c, 1, 1);
}
var TEX_SM = smSkin();
TEX_SM.repeat.set(1, 1);

/* ================= 材质 ================= */
var M = {
  white: new THREE.MeshStandardMaterial({ color: 0xe8e6dd, roughness: 0.72, metalness: 0.08 }),
  paint: new THREE.MeshStandardMaterial({ map: TEX_PAINT, roughness: 0.66, metalness: 0.10 }),
  paint2: new THREE.MeshStandardMaterial({ map: TEX_PAINT_B, roughness: 0.70, metalness: 0.08 }),
  livery: new THREE.MeshStandardMaterial({ map: TEX_LIVERY, roughness: 0.66, metalness: 0.10 }),
  sm: new THREE.MeshStandardMaterial({ map: TEX_SM, roughness: 0.66, metalness: 0.08 }),
  cm: new THREE.MeshStandardMaterial({ color: 0xb9c0c6, roughness: 0.42, metalness: 0.45 }),
  /* 上升级蒙皮：远看是一整片浅灰，别铺高频箔纹（远处会糊成噪点） */
  hull: new THREE.MeshStandardMaterial({ color: 0xcfd3d4, roughness: 0.62, metalness: 0.10 }),
  black: new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.66, metalness: 0.3 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.55, metalness: 0.55 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xa6b0ba, roughness: 0.48, metalness: 0.5 }),
  /* bumpScale 从 0.5 降到 0.07：箔面那点起伏本来就很浅，之前的值让贴图噪点全被放大成砂纸 */
  gold: new THREE.MeshStandardMaterial({ map: TEX_GOLD, bumpMap: TEX_GOLD, bumpScale: 0.035, color: 0xd9b271, roughness: 0.55, metalness: 0.26 }),
  silver: new THREE.MeshStandardMaterial({ map: TEX_SILVER, bumpMap: TEX_SILVER, bumpScale: 0.02, color: 0xdde4ea, roughness: 0.54, metalness: 0.16 }),
  bell: new THREE.MeshStandardMaterial({ color: 0x6a6055, roughness: 0.45, metalness: 0.6, side: THREE.DoubleSide }),
  bellIn: new THREE.MeshStandardMaterial({ color: 0x3a342d, roughness: 0.55, metalness: 0.7, side: THREE.DoubleSide }),
  leg: new THREE.MeshStandardMaterial({ color: 0x7f858c, roughness: 0.55, metalness: 0.35 }),
  pad: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.7, metalness: 0.25 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x9fe6ff, roughness: 0.08, metalness: 0.4, transparent: true, opacity: 0.55 }),
  visor: new THREE.MeshStandardMaterial({ color: 0xe0a52a, roughness: 0.12, metalness: 1.0 }),
  fabric: new THREE.MeshStandardMaterial({ color: 0xe6e4dc, roughness: 0.95, metalness: 0.0 }),
  flag: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, map: TEX_FLAG })
};
M.paint.map.repeat.set(4, 8);
M.paint2.map.repeat.set(3, 6);
M.gold.map.repeat.set(6, 1);   /* 补偿圆柱 UV 的横纵拉伸，否则纹理会被拉成木纹 */
M.silver.map.repeat.set(2.6, 1.0);

/* ---- 通用几何助手 ---- */
/* 两点之间的圆柱（严格对齐端点，避免靠旋转角"凑"出来的错位） */
function strutBetween(g2, x1, y1, z1, x2, y2, z2, rad, mat, seg) {
  var dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
  var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return null;
  var m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, seg || 8), mat);
  m.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
  m.quaternion.setFromUnitVectors(UP_Y, V3(dx, dy, dz).normalize());
  g2.add(m);
  return m;
}
/* 火箭发动机喷管：抛物型轮廓的旋转体，比直锥筒真实得多 */
function bellGeo(rThroat, rExit, len, seg) {
  var pts = [], i, t;
  for (i = 0; i <= 16; i++) {
    t = i / 16;
    pts.push(new THREE.Vector2(rThroat + (rExit - rThroat) * Math.pow(t, 0.58), -t * len));
  }
  return new THREE.LatheGeometry(pts, seg || 28);
}
/* 贴花：沿圆柱面包一段弧，图案透明底，正好贴合蒙皮曲率 */
function decalPatch(r, y, h, ang, halfAng, tex, extra) {
  var g = new THREE.CylinderGeometry(r, r, h, 16, 1, true, ang - halfAng, halfAng * 2);
  var m = new THREE.MeshStandardMaterial({
    map: tex, transparent: true, roughness: 0.68, metalness: 0.08,
    side: THREE.DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
  });
  if (extra) Object.keys(extra).forEach(function (k) { m[k] = extra[k]; });
  var mesh = new THREE.Mesh(g, m);
  mesh.position.y = y;
  return mesh;
}

/* 截锥形喷流：真实发动机的尾焰不是尖锥，收口要留截面 */
function plumeMesh2(tex, rTop, rBot, len) {
  var g = new THREE.CylinderGeometry(rTop, rBot, len, 24, 1, true);
  var m = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  var mesh = new THREE.Mesh(g, m);
  mesh.position.y = -len / 2;
  return mesh;
}

function plumeMesh(tex, r, len) {
  var g = new THREE.ConeGeometry(r, len, 22, 1, true);
  var m = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  var mesh = new THREE.Mesh(g, m);
  mesh.rotation.x = Math.PI;
  mesh.position.y = -len / 2;
  return mesh;
}

/* ================= 模型：土星五号（真实尺寸，1 单位 = 1 m） ================= */
function buildSaturn() {
  var g = new THREE.Group();
  var i, a, k, k2, b1, b2, t;

  /* 关键标高（局部 y，单位 m；y=0 为尾焰出口平面） */
  var Y0 = 4.0;                 /* S-IC 箱体底面 */
  var Y1 = Y0 + 42.1;           /* S-IC 顶 */
  var Y2 = Y1 + 4.4 + 24.8;     /* S-II 顶 */
  var Y3 = Y2 + 4.2 + 17.8;     /* S-IVB 顶 */
  var YIU = Y3 + 1.1;           /* 仪器单元顶 */
  var YSLA = YIU + 8.3;         /* SLA 顶 */
  var YCM = YSLA + 3.4;         /* 指令舱顶 */

  /* ---------- S-IC 一级 ---------- */
  var s1 = new THREE.Mesh(new THREE.CylinderGeometry(5.03, 5.03, 42.1, 72, 1, true), M.livery);
  s1.position.y = Y0 + 21.05; g.add(s1);

  /* 电缆整流罩：贯穿整个箭体的竖向凹槽，土星五号最好认的特征之一 */
  var raceMat = new THREE.MeshStandardMaterial({ color: 0xdedbd2, roughness: 0.68, metalness: 0.12 });
  var race = new THREE.Mesh(new THREE.BoxGeometry(0.40, 41.2, 1.05), raceMat);
  race.position.set(4.9, Y0 + 21.0, 0); g.add(race);
  var race2 = new THREE.Mesh(new THREE.BoxGeometry(0.38, 23.8, 0.95), raceMat);
  race2.position.set(4.9, Y1 + 4.4 + 12.4, 0); g.add(race2);

  /* 尾裙 + 推力结构底板 */
  var skirt = new THREE.Mesh(new THREE.CylinderGeometry(5.03, 4.52, 3.7, 72, 1, true), M.black);
  skirt.position.y = Y0 - 1.85; g.add(skirt);
  var basePlate = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.6, 0.34, 48), M.dark);
  basePlate.position.y = Y0 - 3.6; g.add(basePlate);

  /* 外圈四台 F-1 的整流鼓包 */
  for (i = 0; i < 4; i++) {
    a = i * Math.PI / 2 + Math.PI / 4;
    var fair = new THREE.Mesh(new THREE.CylinderGeometry(1.30, 1.85, 3.1, 18, 1, true), M.black);
    fair.position.set(Math.cos(a) * 4.15, Y0 - 1.5, Math.sin(a) * 4.15);
    g.add(fair);
  }

  /* 5 台 F-1（抛物线喷管，内外两层，看进去是暗的） */
  function f1(px, pz, len) {
    var grp = new THREE.Group();
    grp.add(new THREE.Mesh(bellGeo(0.62, 1.60, len, 26), M.bell));
    var inner = new THREE.Mesh(bellGeo(0.56, 1.48, len * 0.95, 24), M.bellIn);
    inner.position.y = -0.06; grp.add(inner);
    var throat = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.62, 1.0, 14), M.dark);
    throat.position.y = 0.45; grp.add(throat);
    grp.position.set(px, Y0 - 0.2, pz);
    return grp;
  }
  g.add(f1(0, 0, 3.5));
  for (i = 0; i < 4; i++) {
    a = i * Math.PI / 2 + Math.PI / 4;
    g.add(f1(Math.cos(a) * 3.05, Math.sin(a) * 3.05, 3.2));
  }

  /* 4 片尾翼（位于外圈发动机之间，45° 偏置） */
  var finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(3.0, 0);
  finShape.lineTo(3.0, 1.35);
  finShape.lineTo(0.5, 6.0);
  finShape.lineTo(0, 6.0);
  finShape.lineTo(0, 0);
  var finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.40, bevelEnabled: false });
  finGeo.translate(0, 0, -0.20);
  for (i = 0; i < 4; i++) {
    a = i * Math.PI / 2;
    var fin = new THREE.Mesh(finGeo, M.black);
    fin.position.set(Math.cos(a) * 4.75, 0.4, Math.sin(a) * 4.75);
    fin.rotation.y = -a;
    g.add(fin);
  }

  /* ---------- S-IC / S-II 级间段 ---------- */
  var inter = new THREE.Mesh(new THREE.CylinderGeometry(5.03, 5.03, 4.4, 72, 1, true), M.black);
  inter.position.y = Y1 + 2.2; g.add(inter);
  for (i = 0; i < 4; i++) {
    a = i * Math.PI / 2 + Math.PI / 4;
    var ull = new THREE.Mesh(new THREE.CylinderGeometry(0.40, 0.40, 1.0, 12), M.dark);
    ull.position.set(Math.cos(a) * 4.68, Y1 + 3.9, Math.sin(a) * 4.68);
    g.add(ull);
    var ullN = new THREE.Mesh(new THREE.ConeGeometry(0.40, 0.48, 12), M.dark);
    ullN.position.set(Math.cos(a) * 4.68, Y1 + 4.64, Math.sin(a) * 4.68);
    g.add(ullN);
  }

  /* ---------- S-II 二级 ---------- */
  var s2 = new THREE.Mesh(new THREE.CylinderGeometry(5.03, 5.03, 24.8, 72, 1, true), M.paint);
  s2.position.y = Y1 + 4.4 + 12.4; g.add(s2);
  var s2band = new THREE.Mesh(new THREE.CylinderGeometry(5.05, 5.05, 1.4, 72, 1, true), M.black);
  s2band.position.y = Y1 + 4.4 + 0.7; g.add(s2band);
  /* 5 台 J-2（在级间段内，从下方能看到喷管） */
  for (i = 0; i < 5; i++) {
    a = i * Math.PI * 2 / 5;
    var j2 = new THREE.Mesh(bellGeo(0.28, 0.64, 1.9, 16), M.bell);
    j2.position.set(Math.cos(a) * (i === 0 ? 0 : 2.0), Y1 + 3.9, Math.sin(a) * (i === 0 ? 0 : 2.0));
    g.add(j2);
  }

  /* ---------- S-II / S-IVB 锥形级间段 ---------- */
  var inter2 = new THREE.Mesh(new THREE.CylinderGeometry(3.32, 5.03, 4.2, 72, 1, true), M.black);
  inter2.position.y = Y2 + 2.1; g.add(inter2);

  /* ---------- S-IVB 三级 ---------- */
  var s4 = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.3, 17.8, 56, 1, true), M.paint);
  s4.position.y = Y2 + 4.2 + 8.9; g.add(s4);
  var s4band = new THREE.Mesh(new THREE.CylinderGeometry(3.31, 3.31, 0.85, 56, 1, true), M.black);
  s4band.position.y = Y3 - 0.42; g.add(s4band);
  /* 辅助推进系统 APS 小舱 */
  for (i = 0; i < 2; i++) {
    a = i * Math.PI + 0.45;
    var aps = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.4, 0.85), M.dark);
    aps.position.set(Math.cos(a) * 3.35, Y2 + 5.2, Math.sin(a) * 3.35);
    aps.rotation.y = -a;
    g.add(aps);
  }

  /* ---------- 仪器单元 IU ---------- */
  var iu = new THREE.Mesh(new THREE.CylinderGeometry(3.32, 3.32, 1.05, 48), M.steel);
  iu.position.y = Y3 + 0.52; g.add(iu);

  /* ---------- SLA：四片花瓣，瓣与瓣之间是真实的缝 ---------- */
  for (i = 0; i < 4; i++) {
    var th0 = i * Math.PI / 2 + 0.032;
    var petal = new THREE.Mesh(
      new THREE.CylinderGeometry(1.96, 3.30, 8.3, 24, 1, true, th0, Math.PI / 2 - 0.064), M.paint2);
    petal.position.y = YIU + 4.15; g.add(petal);
  }
  var slaRing = new THREE.Mesh(new THREE.CylinderGeometry(3.33, 3.33, 0.26, 48), M.dark);
  slaRing.position.y = YIU + 0.13; g.add(slaRing);

  /* ---------- 指令舱（旋转体：锥面收到圆弧顶） ---------- */
  var cmPts = [];
  for (i = 0; i <= 18; i++) {
    t = i / 18;
    var rr = 1.95 * Math.sqrt(Math.max(0, 1 - Math.pow(t, 2.4) * 0.88));
    cmPts.push(new THREE.Vector2(rr, t * 3.4));
  }
  var cm = new THREE.Mesh(new THREE.LatheGeometry(cmPts, 48), M.cm);
  cm.position.y = YSLA; g.add(cm);
  var probeDisk = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.1, 16), M.dark);
  probeDisk.position.y = YSLA + 3.28; g.add(probeDisk);
  var probe = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.8, 10), M.steel);
  probe.position.y = YSLA + 3.62; g.add(probe);
  [[0.44, 0.62], [-0.44, 0.62], [0, 1.0]].forEach(function (p) {
    var w = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.07, 12), M.dark);
    w.position.set(p[0], YSLA + p[1], 1.62);
    w.rotation.x = Math.PI / 2;
    g.add(w);
  });

  /* ---------- 发射逃逸塔 LES：锥形格构桁架 ---------- */
  var les = new THREE.Group();
  var lh = 8.4, rB = 0.96, rT = 0.30;
  function lr(v) { return lerp(rB, rT, v); }
  for (i = 0; i < 4; i++) {
    a = i * Math.PI / 2 + Math.PI / 4;
    strutBetween(les, Math.cos(a) * rB, 0, Math.sin(a) * rB,
      Math.cos(a) * rT, lh, Math.sin(a) * rT, 0.055, M.steel, 6);
  }
  for (i = 0; i <= 8; i++) {
    var ty = i / 8, rad = lr(ty), py = ty * lh;
    for (k = 0; k < 4; k++) {
      var a1 = k * Math.PI / 2 + Math.PI / 4, a2 = a1 + Math.PI / 2;
      strutBetween(les, Math.cos(a1) * rad, py, Math.sin(a1) * rad,
        Math.cos(a2) * rad, py, Math.sin(a2) * rad, 0.032, M.steel, 5);
    }
    if (i < 8) {
      var ny = (i + 1) / 8, nr = lr(ny), nyp = ny * lh;
      for (k2 = 0; k2 < 4; k2++) {
        b1 = k2 * Math.PI / 2 + Math.PI / 4;
        b2 = b1 + Math.PI / 2;
        strutBetween(les, Math.cos(b1) * rad, py, Math.sin(b1) * rad,
          Math.cos(b1) * nr, nyp, Math.sin(b1) * nr, 0.026, M.steel, 5);
        strutBetween(les, Math.cos(b1) * rad, py, Math.sin(b1) * rad,
          Math.cos(b2) * nr, nyp, Math.sin(b2) * nr, 0.022, M.steel, 5);
      }
    }
  }
  var escMotor = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.46, 2.2, 16), M.dark);
  escMotor.position.y = lh + 1.1; les.add(escMotor);
  var escNose = new THREE.Mesh(new THREE.ConeGeometry(0.33, 1.3, 16), M.dark);
  escNose.position.y = lh + 2.85; les.add(escNose);
  for (i = 0; i < 4; i++) {
    a = i * Math.PI / 2 + Math.PI / 4;
    var nz = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 10), M.bell);
    nz.position.set(Math.cos(a) * 0.32, lh - 0.1, Math.sin(a) * 0.32);
    nz.rotation.x = Math.PI;
    les.add(nz);
  }
  for (i = 0; i < 4; i++) {
    a = i * Math.PI / 2;
    var cn = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.05), M.steel);
    cn.position.set(Math.cos(a) * 0.52, lh + 0.5, Math.sin(a) * 0.52);
    cn.rotation.y = -a;
    cn.rotation.z = 0.28;
    les.add(cn);
  }
  les.position.y = YCM - 0.15;
  g.add(les);

  /* ---------- 竖排 USA + 星条旗：贴合曲面的一次性贴花 ---------- */
  [0.32, Math.PI + 0.32].forEach(function (ang) {
    g.add(decalPatch(5.058, Y0 + 24.0, 9.0, ang, 0.150, TEX_USA));
    g.add(decalPatch(5.058, Y1 + 4.4 + 14.0, 7.0, ang, 0.150, TEX_USA));
  });
  [0.98, Math.PI + 0.98].forEach(function (ang) {
    g.add(decalPatch(5.058, Y0 + 33.5, 2.7, ang, 0.46, TEX_FLAG));
    g.add(decalPatch(5.058, Y1 + 4.4 + 19.8, 2.4, ang, 0.46, TEX_FLAG));
  });

  /* ---------- 尾焰：内芯 + 外层橙焰 ---------- */
  var fl = plumeMesh2(TEX_PLUME, 5.2, 2.6, 62);
  fl.position.y = Y0 - 3.7;
  g.add(fl);
  var flOuter = plumeMesh2(TEX_PLUME, 9.0, 5.0, 46);
  flOuter.position.y = Y0 - 3.7;
  flOuter.material.opacity = 0;
  g.add(flOuter);
  g.userData.flameOuter = flOuter;

  g.userData.flame = fl;
  g.userData.les = les;
  g.userData.top = YCM;
  g.visible = false;
  scene.add(g);
  return g;
}

/* ================= 模型：CSM（指令舱 + 服务舱） ================= */
function buildCSM() {
  var g = new THREE.Group();
  var i, a;

  /* 服务舱 SM：Ø3.90 × 7.40，蒙皮带散热板阵列 */
  var smBody = new THREE.Mesh(new THREE.CylinderGeometry(1.95, 1.95, 7.4, 48, 1, true), M.sm);
  smBody.position.y = 3.7; g.add(smBody);
  /* 前后安装环 */
  var ringTop = new THREE.Mesh(new THREE.CylinderGeometry(1.97, 1.97, 0.22, 48), M.dark);
  ringTop.position.y = 7.3; g.add(ringTop);
  var ringBot = new THREE.Mesh(new THREE.CylinderGeometry(1.97, 1.97, 0.26, 48), M.dark);
  ringBot.position.y = 0.15; g.add(ringBot);

  /* SPS 主发动机：抛物线喷管 */
  var spsBell = new THREE.Mesh(bellGeo(0.30, 0.85, 1.75, 26), M.bell);
  spsBell.position.y = -0.05; g.add(spsBell);
  var spsInner = new THREE.Mesh(bellGeo(0.27, 0.78, 1.68, 24), M.bellIn);
  spsInner.position.y = -0.12; g.add(spsInner);
  var spsNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.34, 0.7, 14), M.dark);
  spsNeck.position.y = 0.3; g.add(spsNeck);

  /* 指令舱 CM：旋转体，锥面收到圆弧顶 */
  var pts = [];
  var prof = [[1.95, 0], [1.80, 0.42], [1.58, 0.88], [1.34, 1.34], [1.10, 1.78],
              [0.92, 2.18], [0.80, 2.52], [0.72, 2.86], [0.66, 3.10], [0.52, 3.24]];
  prof.forEach(function (p, k) {
    pts.push(new THREE.Vector2(p[0], p[1] + 7.35));
    if (k === prof.length - 1) pts.push(new THREE.Vector2(0.02, p[1] + 7.42));
  });
  var cm = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), M.cm);
  g.add(cm);
  /* 对接探头 + 前隔舱盖 */
  var probeDisk = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.10, 18), M.dark);
  probeDisk.position.y = 10.80; g.add(probeDisk);
  var probe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.72, 10), M.steel);
  probe.position.y = 11.16; g.add(probe);
  /* 舷窗：两侧各两个 + 中央一个 */
  [[0.46, 9.62, 1.55], [-0.46, 9.62, 1.55], [0.0, 10.05, 1.42]].forEach(function (p) {
    var w = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.09, 14), M.glass);
    w.position.set(p[0], p[1], p[2]);
    w.rotation.x = Math.PI / 2;
    w.rotation.z = 0;
    g.add(w);
    var fr = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.05, 14), M.dark);
    fr.position.set(p[0], p[1], p[2] - 0.03);
    fr.rotation.x = Math.PI / 2;
    g.add(fr);
  });

  /* RCS 四联喷口 ×4（服务舱顶部靠前） */
  for (i = 0; i < 4; i++) {
    a = i * Math.PI / 2 + Math.PI / 4;
    var quad = new THREE.Group();
    var blk = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.34), M.dark);
    quad.add(blk);
    for (var k = 0; k < 4; k++) {
      var b = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.24, 8), M.bell);
      b.position.set(Math.cos(k * Math.PI / 2) * 0.19, -0.1, Math.sin(k * Math.PI / 2) * 0.19);
      b.rotation.x = Math.PI / 2;
      quad.add(b);
    }
    quad.position.set(Math.cos(a) * 1.98, 6.55, Math.sin(a) * 1.98);
    quad.rotation.y = -a;
    g.add(quad);
  }

  /* 高增益天线 + 支杆 */
  var dish = new THREE.Mesh(new THREE.SphereGeometry(0.70, 22, 16, 0, Math.PI * 2, 0, 1.15), M.steel);
  dish.position.set(2.35, 4.45, 0.1);
  dish.rotation.z = -1.2;
  g.add(dish);
  var dishMast = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.2, 6), M.steel);
  dishMast.position.set(1.95, 4.25, 0.1);
  dishMast.rotation.z = 1.15;
  g.add(dishMast);
  /* 两个 S 波段小天线 */
  [[0, 3.2, -2.02], [0, 5.6, 2.02]].forEach(function (p) {
    var s = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10, 0, Math.PI * 2, 0, 1.3), M.steel);
    s.position.set(p[0], p[1], p[2]);
    s.rotation.x = p[2] > 0 ? -1.2 : 1.2;
    g.add(s);
  });

  /* 尾焰 */
  var pl = plumeMesh(TEX_PLUME_BLUE, 0.9, 7);
  pl.position.y = -1.7;
  g.add(pl);
  g.userData.plume = pl;
  g.visible = false;
  scene.add(g);
  return g;
}

/* ================= 模型：登月舱 LM（足垫底 = y0，总高约 7 m） ================= */
function buildLM() {
  var g = new THREE.Group();
  var i;

  /* ---- 下降级：八角柱，对边宽 4.2 m，高 2.35 m ---- */
  var DR = 2.28;                 /* 外接圆半径（对边 = 2R·cos22.5° ≈ 4.21） */
  var DY0 = 1.55, DY1 = 3.90;    /* 下降级底面 / 顶面 */
  var ds = new THREE.Mesh(new THREE.CylinderGeometry(DR, DR, DY1 - DY0, 8), M.gold);
  ds.position.y = (DY0 + DY1) / 2;
  ds.rotation.y = Math.PI / 8;
  g.add(ds);

  /* 顶板 + 结构环 */
  var deck = new THREE.Mesh(new THREE.CylinderGeometry(DR + 0.03, DR + 0.03, 0.13, 8), M.dark);
  deck.position.y = DY1 + 0.06; deck.rotation.y = Math.PI / 8; g.add(deck);
  /* 八角棱线 */
  for (i = 0; i < 8; i++) {
    var a = i * Math.PI / 4 + Math.PI / 8;
    var rib = new THREE.Mesh(new THREE.BoxGeometry(0.09, DY1 - DY0 - 0.1, 0.13), M.dark);
    rib.position.set(Math.cos(a) * (DR - 0.02), (DY0 + DY1) / 2, Math.sin(a) * (DR - 0.02));
    rib.rotation.y = -a;
    g.add(rib);
  }
  /* 上下两道箍环 */
  [DY0 + 0.35, DY1 - 0.35].forEach(function (yy) {
    var ring = new THREE.Mesh(new THREE.TorusGeometry(DR * 1.005, 0.045, 4, 8), M.dark);
    ring.rotation.x = Math.PI / 2; ring.rotation.z = Math.PI / 8;
    ring.position.y = yy; g.add(ring);
  });

  /* 下降主发动机（钟形，喷口在 LM 中心下方） */
  var eng = new THREE.Mesh(bellGeo(0.30, 0.95, 1.0, 22), M.bell);
  eng.position.y = DY0 - 0.02; g.add(eng);
  var engInner = new THREE.Mesh(bellGeo(0.27, 0.88, 0.94, 20), M.bellIn);
  engInner.position.y = DY0 - 0.08; g.add(engInner);
  var engTop = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.44, 0.45, 14), M.dark);
  engTop.position.y = DY0 + 0.2; g.add(engTop);

  /* ---- 4 条着陆腿：主支柱 + 伸展腿 + 斜撑 + 足垫 ---- */
  for (i = 0; i < 4; i++) {
    var al = i * Math.PI / 2 + Math.PI / 4;
    var ca = Math.cos(al), sa = Math.sin(al);
    /* 主支柱：从下降级上缘斜向外下方 */
    strutBetween(g, ca * 2.10, DY1 - 0.35, sa * 2.10, ca * 3.45, 1.15, sa * 3.45, 0.10, M.leg, 8);
    /* 伸展腿：继续到足垫 */
    strutBetween(g, ca * 3.45, 1.15, sa * 3.45, ca * 4.22, 0.26, sa * 4.22, 0.062, M.leg, 8);
    /* 反向斜撑 */
    strutBetween(g, ca * 2.10, DY0 + 0.45, sa * 2.10, ca * 3.60, 0.95, sa * 3.60, 0.050, M.dark, 6);
    /* 足垫（带边缘环） */
    var pad = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.40, 0.09, 20), M.pad);
    pad.position.set(ca * 4.22, 0.13, sa * 4.22);
    g.add(pad);
    var padRim = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.035, 4, 18), M.dark);
    padRim.rotation.x = Math.PI / 2;
    padRim.position.set(ca * 4.22, 0.18, sa * 4.22);
    g.add(padRim);
  }

  /* ---- 梯子（+Z 侧，从下降级顶到底部） ---- */
  var ladder = new THREE.Group();
  for (i = 0; i < 2; i++) {
    var rail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 3.5, 6), M.steel);
    rail.position.set((i ? 1 : -1) * 0.28, 0, 0);
    ladder.add(rail);
  }
  for (i = 0; i < 8; i++) {
    var rung = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.56, 6), M.steel);
    rung.rotation.z = Math.PI / 2;
    rung.position.y = -1.6 + i * 0.46;
    ladder.add(rung);
  }
  ladder.position.set(0, 2.6, 2.32);
  ladder.rotation.x = -0.10;
  g.add(ladder);
  /* 舱门前的小平台 */
  var porch = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.5), M.pad);
  porch.position.set(0, DY1 + 0.02, 2.05); g.add(porch);

  /* ---- 上升级 ---- */
  var asGroup = new THREE.Group();
  var AY = DY1 + 0.12;          /* 上升级底面相对组原点 */
  /* 下段：八角柱 */
  var body = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.62, 1.45, 8), M.hull);
  body.position.y = 0.72; body.rotation.y = Math.PI / 8; asGroup.add(body);
  /* 上段：收口 */
  var top = new THREE.Mesh(new THREE.CylinderGeometry(1.16, 1.55, 1.15, 8), M.hull);
  top.position.y = 2.02; top.rotation.y = Math.PI / 8; asGroup.add(top);
  /* 顶盖 + 对接隧道 */
  var roof = new THREE.Mesh(new THREE.CylinderGeometry(1.14, 1.14, 0.12, 8), M.dark);
  roof.position.y = 2.64; roof.rotation.y = Math.PI / 8; asGroup.add(roof);
  var tunnel = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.56, 0.36, 14), M.dark);
  tunnel.position.y = 2.86; asGroup.add(tunnel);
  /* 前脸：舱门 + 两个三角舷窗 */
  var door = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.92, 0.08), M.dark);
  door.position.set(0, 0.55, 1.56); asGroup.add(door);
  [-1, 1].forEach(function (s) {
    var tri = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.07, 3), M.glass);
    tri.position.set(s * 0.72, 1.15, 1.42);
    tri.rotation.set(Math.PI / 2, 0, s > 0 ? -Math.PI / 2 : Math.PI / 2);
    asGroup.add(tri);
  });
  /* RCS 四组（每个角一组，带 4 个喷口） */
  for (i = 0; i < 4; i++) {
    var ar = i * Math.PI / 2 + Math.PI / 4;
    var quad = new THREE.Group();
    quad.add(new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.26, 0.30), M.dark));
    for (var k = 0; k < 4; k++) {
      var nz = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 8), M.bell);
      nz.position.set(Math.cos(k * Math.PI / 2) * 0.16, k < 2 ? 0.1 : -0.1, Math.sin(k * Math.PI / 2) * 0.16);
      nz.rotation.x = k < 2 ? 0 : Math.PI;
      quad.add(nz);
    }
    quad.position.set(Math.cos(ar) * 1.5, 1.35, Math.sin(ar) * 1.5);
    quad.rotation.y = -ar;
    asGroup.add(quad);
  }
  /* 会合雷达 + 天线 */
  var rndz = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.30, 0.16, 12), M.dark);
  rndz.position.set(1.05, 2.55, 0.1); rndz.rotation.z = 0.5; asGroup.add(rndz);
  var ant = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 10, 0, Math.PI * 2, 0, 1.2), M.steel);
  ant.position.set(-1.0, 2.5, -0.35); ant.rotation.set(0.6, 0, 0.5); asGroup.add(ant);
  /* 上升发动机 */
  var aeng = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.50, 0.85, 14, 1, true), M.bell);
  aeng.position.y = -0.42; asGroup.add(aeng);
  /* 上升喷流 */
  /* 上升喷流：细芯 + 外扩柔光，单锥看着像根玻璃针 */
  var apl = plumeMesh(TEX_PLUME_BLUE, 1.05, 3.0);
  apl.position.y = -0.9; asGroup.add(apl);
  var aplOut = plumeMesh(TEX_PLUME_BLUE, 2.30, 2.6);
  aplOut.position.y = -0.75; aplOut.material.opacity = 0;
  asGroup.add(aplOut);

  asGroup.position.y = AY;
  asGroup.userData.plume = apl;
  asGroup.userData.plumeOuter = aplOut;
  g.add(asGroup);
  g.userData.asc = asGroup;

  /* 下降主发动机喷流（挂在喷口平面） */
  var pl = plumeMesh(TEX_PLUME, 1.25, 9);
  pl.position.y = DY0 - 1.02; g.add(pl);
  g.userData.plume = pl;

  g.userData.dust = null;
  g.visible = false;
  scene.add(g);
  return g;
}
/* 组合体 CSM+LM（深空飞行，局部 +Y 为飞行方向） */
function buildStack() {
  var g = new THREE.Group();

  /* 复用已建好的高细节模型，只把它们搬进组合体 */
  var c = buildCSM();
  scene.remove(c);
  c.visible = true;
  c.position.set(0, 0, 0);
  g.add(c);

  var l = buildLM();
  scene.remove(l);
  l.visible = true;
  /* LM 倒扣在指令舱前端：上升级顶对着 CM 的对接探头 */
  l.position.set(0, 17.6, 0);
  l.rotation.z = Math.PI;
  l.scale.setScalar(1.0);
  l.userData.asc.visible = true;
  l.userData.plume.material.opacity = 0;
  l.userData.asc.userData.plume.material.opacity = 0;
  l.userData.asc.position.y = 4.45;
  g.add(l);

  g.userData.csm = c;
  g.userData.lm = l;
  g.visible = false;
  scene.add(g);
  return g;
}
/* ================= 模型：宇航员 / 月球车 / 国旗 / ALSEP ================= */
function buildAstro() {
  var g = new THREE.Group();
  var torso = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 1.05, 16), M.fabric);
  torso.position.y = 1.55; g.add(torso);
  /* PLSS 背包 */
  var plss = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.98, 0.44), M.fabric);
  plss.position.set(0, 1.65, -0.44); g.add(plss);
  /* 头盔 + 金面窗 */
  var helm = new THREE.Mesh(new THREE.SphereGeometry(0.41, 22, 22), M.fabric);
  helm.position.y = 2.32; g.add(helm);
  var visor = new THREE.Mesh(new THREE.SphereGeometry(0.38, 22, 22, 0, Math.PI * 2, 0, 1.15), M.visor);
  visor.position.set(0, 2.34, 0.1); visor.rotation.x = Math.PI / 2; visor.rotation.z = Math.PI;
  g.add(visor);
  /* 四肢 */
  [1, -1].forEach(function (s) {
    var arm = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.12, 0.9, 12), M.fabric);
    arm.position.set(s * 0.5, 1.55, 0.04); arm.rotation.z = s * 0.42; g.add(arm);
    var glove = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 12), M.fabric);
    glove.position.set(s * 0.72, 1.1, 0.08); g.add(glove);
    var thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.15, 0.62, 12), M.fabric);
    thigh.position.set(s * 0.2, 0.85, 0); g.add(thigh);
    var shin = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.13, 0.6, 12), M.fabric);
    shin.position.set(s * 0.2, 0.32, 0.02); g.add(shin);
    var boot = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.2, 0.5), M.dark);
    boot.position.set(s * 0.2, 0.09, 0.08); g.add(boot);
  });
  g.visible = false;
  scene.add(g);
  return g;
}

function buildRover() {
  var g = new THREE.Group();
  var i, k;

  /* 车架：两根纵梁 + 横梁 */
  [-0.62, 0.62].forEach(function (z) {
    var beam = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 2.9, 8), M.steel);
    beam.rotation.z = Math.PI / 2; beam.position.set(0, 0.60, z); g.add(beam);
  });
  [-1.25, -0.4, 0.4, 1.25].forEach(function (x) {
    var cross = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.24, 8), M.steel);
    cross.rotation.x = Math.PI / 2; cross.position.set(x, 0.60, 0); g.add(cross);
  });
  /* 载物台 */
  var deck = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.07, 1.05), M.pad);
  deck.position.set(-0.15, 0.70, 0); g.add(deck);
  /* 后部电池箱（金色隔热） */
  [-0.34, 0.34].forEach(function (z) {
    var batt = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.36, 0.34), M.gold);
    batt.position.set(-1.16, 0.72, z); g.add(batt);
  });

  /* 两个座椅（折叠椅：坐垫 + 靠背） */
  [-0.42, 0.42].forEach(function (z) {
    var cush = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.07, 0.44), M.fabric);
    cush.position.set(-0.42, 0.86, z); g.add(cush);
    var back = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.52, 0.44), M.fabric);
    back.position.set(-0.72, 1.10, z); g.add(back);
  });

  /* 操纵台 + T 形手柄 */
  var console = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.34, 0.95), M.dark);
  console.position.set(0.42, 1.02, 0); g.add(console);
  var stick = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.36, 6), M.steel);
  stick.position.set(0.42, 1.34, 0); stick.rotation.z = -0.25; g.add(stick);
  var grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.34), M.steel);
  grip.position.set(0.38, 1.50, 0); g.add(grip);

  /* 低增益天线桅杆 + 高增益碟形天线 */
  var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.95, 6), M.steel);
  mast.position.set(-1.05, 1.16, 0); g.add(mast);
  var lga = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.20, 12), M.pad);
  lga.position.set(-1.05, 1.66, 0); lga.rotation.x = Math.PI; g.add(lga);
  var hga = new THREE.Mesh(new THREE.SphereGeometry(0.30, 16, 10, 0, Math.PI * 2, 0, 1.15), M.pad);
  hga.position.set(1.18, 1.12, 0.38); hga.rotation.set(1.2, 0, 0.35); g.add(hga);

  /* 四个轮子：外圈轮辋 + 辐条 + 轮毂，模拟钢丝网轮的观感 */
  var wheels = [];
  function makeWheel() {
    var w = new THREE.Group();
    var rim = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.052, 5, 26), M.pad);
    w.add(rim);
    var rim2 = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.030, 5, 24), M.dark);
    w.add(rim2);
    for (k = 0; k < 12; k++) {
      var ak = k * Math.PI / 6;
      var spoke = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.018, 0.018), M.steel);
      spoke.rotation.z = ak;
      w.add(spoke);
    }
    var hubm = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.17, 12), M.silver);
    hubm.rotation.x = Math.PI / 2;
    w.add(hubm);
    return w;
  }
  [[-1.05, -0.78], [-1.05, 0.78], [1.05, -0.78], [1.05, 0.78]].forEach(function (p) {
    var w = makeWheel();
    w.position.set(p[0], 0.40, p[1]);
    g.add(w);
    wheels.push(w);
    /* 挡泥板：弧形板，由两根小支杆撑着 */
    var fender = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.30, 14, 1, true, 0.45, 2.2), M.pad);
    fender.rotation.x = Math.PI / 2;
    fender.position.set(p[0], 0.40, p[1]);
    g.add(fender);
    var fs = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.05), M.steel);
    fs.position.set(p[0], 0.62, p[1] + (p[1] > 0 ? 0.28 : -0.28));
    fs.rotation.x = p[1] > 0 ? 0.5 : -0.5;
    g.add(fs);
  });

  g.userData.wheels = wheels;
  g.visible = false;
  scene.add(g);
  return g;
}

function buildFlag() {
  var g = new THREE.Group();
  var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 3.4, 8), M.steel);
  pole.position.y = 1.7; g.add(pole);
  var bar = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1.7, 8), M.steel);
  bar.rotation.z = Math.PI / 2; bar.position.set(0.85, 3.32, 0); g.add(bar);
  /* 旗面：带褶皱顶点位移 */
  var cg = new THREE.PlaneGeometry(1.66, 1.0, 14, 6);
  var pa = cg.attributes.position;
  for (var i = 0; i < pa.count; i++) {
    var px = pa.getX(i), py = pa.getY(i);
    pa.setZ(i, Math.sin(px * 5.2 + py * 2.0) * 0.035 + Math.sin(py * 7.0) * 0.02);
  }
  cg.computeVertexNormals();
  var cloth = new THREE.Mesh(cg, M.flag);
  cloth.position.set(0.85, 2.82, 0);
  g.add(cloth);
  g.userData.cloth = cloth;
  g.visible = false;
  scene.add(g);
  return g;
}

function buildALSEP() {
  var g = new THREE.Group();
  var base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 0.9), M.silver);
  base.position.y = 0.11; g.add(base);
  var ant = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6), M.dark);
  ant.position.y = 0.9; g.add(ant);
  var dish = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12, 0, Math.PI * 2, 0, 1.4), M.white);
  dish.position.y = 1.6; dish.rotation.x = Math.PI; g.add(dish);
  var panel = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.05), M.dark);
  panel.position.set(0.5, 0.5, 0); panel.rotation.y = 0.5; g.add(panel);
  g.visible = false;
  scene.add(g);
  return g;
}

/* ================= 发射场（球冠贴地 + 米制局部组：台体 / 塔架） ================= */
var launchSite = new THREE.Group();
(function () {
  var S = 512, c = cvs(S, S), x = c.getContext('2d'), i, a, k;

  /* --- 近地表：细粒沙土（高频细节，随距离重复铺开） --- */
  x.fillStyle = '#8b8069'; x.fillRect(0, 0, S, S);
  for (i = 0; i < 12000; i++) {
    var v = Math.random();
    x.fillStyle = v > 0.80 ? 'rgba(62,72,50,.5)' : v > 0.48 ? 'rgba(158,146,118,.45)' : 'rgba(104,95,78,.45)';
    x.beginPath(); x.arc(Math.random() * S, Math.random() * S, Math.random() * 5 + 0.8, 0, 7); x.fill();
  }
  var sand = ctex(c, 260, 260);
  sand.anisotropy = 8;

  /* --- 中远景：大尺度地貌（灌木/湿地色块），不做重复，避免一眼看出格子 --- */
  var c2 = cvs(512, 512), y2 = c2.getContext('2d');
  y2.fillStyle = '#6e7358'; y2.fillRect(0, 0, 512, 512);
  for (i = 0; i < 420; i++) {
    var px = Math.random() * 512, py = Math.random() * 512, r = 10 + Math.random() * 90;
    var g2 = y2.createRadialGradient(px, py, 0, px, py, r);
    var hue = Math.random();
    g2.addColorStop(0, hue > 0.6 ? 'rgba(96,104,72,.55)' : hue > 0.3 ? 'rgba(132,126,98,.5)' : 'rgba(58,72,58,.5)');
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    y2.fillStyle = g2; y2.beginPath(); y2.arc(px, py, r, 0, 7); y2.fill();
  }
  var land = ctex(c2, 260, 260);
  land.anisotropy = 8;

  /* 直径 40 km 的地面：近景用细粒沙土，中远景用大尺度地貌，
     两层套在一起，地平线才不会是一块硬边黑斑。
     尺寸必须压在雾距以内 —— 之前写成半径 1500/45000 单位（1500 km！），
     比地球半径还大，高空俯视就是一块铺满屏幕的平板。 */
  var capNear = new THREE.Mesh(
    new THREE.CircleGeometry(40, 96),
    new THREE.MeshStandardMaterial({ map: sand, roughness: 1, metalness: 0, color: 0x8f8b7d, transparent: true })
  );
  capNear.rotation.x = -Math.PI / 2;
  capNear.position.y = EARTH_R + 0.0045;
  launchSite.add(capNear);

  var capFar = new THREE.Mesh(
    new THREE.RingGeometry(40, 130, 96, 1),
    new THREE.MeshStandardMaterial({ map: land, roughness: 1, metalness: 0, color: 0x8f8b7d, transparent: true })
  );
  capFar.rotation.x = -Math.PI / 2;
  capFar.position.y = EARTH_R + 0.0035;
  launchSite.add(capFar);

  /* 米制局部组：内部一律用米，整体缩到 km */
  var pg = new THREE.Group();
  pg.position.set(0, EARTH_R, 0);
  pg.scale.setScalar(0.001);

  /* 混凝土台体 */
  var conc = new THREE.Mesh(new THREE.CylinderGeometry(84, 88, 6.2, 56),
    new THREE.MeshStandardMaterial({ color: 0x6a675f, roughness: 0.96, metalness: 0.04 }));
  conc.position.y = 3.1;
  pg.add(conc);
  /* 台面黄线（一圈细环，给尺度和"有人造物"的感觉） */
  var yellow = new THREE.Mesh(new THREE.RingGeometry(82.2, 83.0, 72),
    new THREE.MeshStandardMaterial({ color: 0xa8912f, roughness: 0.88, metalness: 0.05 }));
  yellow.rotation.x = -Math.PI / 2; yellow.position.y = 6.22; pg.add(yellow);

  /* 导流槽 */
  var trench = new THREE.Mesh(new THREE.BoxGeometry(20, 0.18, 44),
    new THREE.MeshStandardMaterial({ color: 0x1e1c19, roughness: 0.95 }));
  trench.position.set(0, 6.24, 0); pg.add(trench);

  /* ---- 发射塔架（LUT）：四柱 + 每层横梁 + 交叉斜撑 + 摆杆 ---- */
  var tm = new THREE.MeshStandardMaterial({ color: 0x949aa1, roughness: 0.5, metalness: 0.75 });
  var tm2 = new THREE.MeshStandardMaterial({ color: 0x7d838a, roughness: 0.55, metalness: 0.7 });
  var TX = -26, TZ = -8, TH = 118, HW = 5.6, BAY = 11.8;
  var levels = Math.floor(TH / BAY);

  /* 四根角柱 */
  for (i = 0; i < 4; i++) {
    var cx = (i & 1 ? 1 : -1) * HW, cz = (i & 2 ? 1 : -1) * HW;
    var col = new THREE.Mesh(new THREE.BoxGeometry(1.5, TH, 1.5), tm);
    col.position.set(TX + cx, 6 + TH / 2, TZ + cz);
    pg.add(col);
  }
  /* 每层：四边横梁 + 四个面的交叉斜撑 */
  for (k = 0; k <= levels; k++) {
    var ly = 6 + k * BAY;
    for (i = 0; i < 4; i++) {
      var horiz = (i & 1) ? 1 : 0;
      var beam = new THREE.Mesh(
        new THREE.BoxGeometry(horiz ? 0.5 : HW * 2, 0.5, horiz ? HW * 2 : 0.5), tm2);
      beam.position.set(TX + (i === 0 ? -HW : i === 1 ? HW : 0), ly, TZ + (i === 2 ? -HW : i === 3 ? HW : 0));
      pg.add(beam);
    }
    if (k < levels) {
      /* 四个面各打一个 X 形斜撑 */
      var fy0 = ly, fy1 = ly + BAY;
      [[-HW, -HW, HW, -HW], [-HW, HW, HW, HW], [-HW, -HW, -HW, HW], [HW, -HW, HW, HW]]
        .forEach(function (f) {
          strutBetween(pg, TX + f[0], fy0, TZ + f[1], TX + f[2], fy1, TZ + f[3], 0.20, tm2, 5);
          strutBetween(pg, TX + f[0], fy1, TZ + f[1], TX + f[2], fy0, TZ + f[3], 0.20, tm2, 5);
        });
    }
  }
  /* 顶部吊车（锤头式） */
  var craneMast = new THREE.Mesh(new THREE.BoxGeometry(2.2, 12, 2.2), tm);
  craneMast.position.set(TX, 6 + TH + 6, TZ); pg.add(craneMast);
  var craneArm = new THREE.Mesh(new THREE.BoxGeometry(34, 1.6, 2.0), tm);
  craneArm.position.set(TX + 14, 6 + TH + 12, TZ); pg.add(craneArm);
  var counter = new THREE.Mesh(new THREE.BoxGeometry(7, 3.4, 3.2), tm2);
  counter.position.set(TX - 9, 6 + TH + 10, TZ); pg.add(counter);

  /* 三根摆杆（通向火箭的勤务臂） */
  [26, 52, 78].forEach(function (ay, idx) {
    var arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.6, 19), tm2);
    arm.position.set(TX + HW + 8, 6 + ay, TZ + (idx === 1 ? 1.5 : -1.5));
    pg.add(arm);
    /* 臂端的小平台 */
    var plate = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.4, 4.2), tm);
    plate.position.set(TX + HW + 15.6, 6 + ay - 1.4, TZ + (idx === 1 ? 1.5 : -1.5));
    pg.add(plate);
  });

  /* 避雷塔（三根细高杆，红色） */
  var lm2 = new THREE.MeshStandardMaterial({ color: 0x7a6a63, roughness: 0.85, metalness: 0.25 });
  [[58, -6], [-42, 52], [-42, -60]].forEach(function (p) {
    var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.42, 128, 6), lm2);
    mast.position.set(p[0], 6 + 64, p[1]);
    pg.add(mast);
  });

  /* 远处树线：几条低矮的深色长条，用来压住地平线 */
  var treeMat = new THREE.MeshStandardMaterial({ color: 0x323d28, roughness: 1, metalness: 0 });
  [[-3600, 2600, 5200, 0.5], [2400, 4300, 6800, -0.9], [5200, -1800, 4600, 1.7],
   [-1200, -4600, 5600, 0.1], [6400, 3600, 4200, 2.4]].forEach(function (tk) {
    var strip = new THREE.Mesh(new THREE.BoxGeometry(tk[2], 22, 120), treeMat);
    strip.position.set(tk[0], 11, tk[1]);
    strip.rotation.y = tk[3];
    pg.add(strip);
  });
  /* 装配大楼 VAB：远景地标 */
  var vab = new THREE.Mesh(new THREE.BoxGeometry(158, 160, 198),
    new THREE.MeshStandardMaterial({ color: 0xcfcdc6, roughness: 0.92 }));
  vab.position.set(-5600, 80, 3900);
  pg.add(vab);
  var vab2 = new THREE.Mesh(new THREE.BoxGeometry(60, 60, 60),
    new THREE.MeshStandardMaterial({ color: 0xb9b7b0, roughness: 0.92 }));
  vab2.position.set(-4900, 30, 3200);
  pg.add(vab2);

  launchSite.add(pg);
})();
launchSite.visible = false;
scene.add(launchSite);

/* ================= 实例化 ================= */
var saturn = buildSaturn();
var csm = buildCSM();
var lm = buildLM();
var stack = buildStack();
var astro = buildAstro();
var rover = buildRover();
var flag = buildFlag();
var alsep = buildALSEP();
var lmAsc = lm.userData.asc;

/* 再入等离子体辉光 */
var reentryGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: TEX_GLOW, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending
}));
reentryGlow.visible = false;
reentryGlow.renderOrder = 15;
scene.add(reentryGlow);

/* 光点标记 */
var marker = new THREE.Sprite(new THREE.SpriteMaterial({
  map: TEX_DOT, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending
}));
marker.visible = false;
marker.renderOrder = 20;
scene.add(marker);

/* 喷流点光源 */
var engineLight = new THREE.PointLight(0xffbf7a, 0, 90, 2);
scene.add(engineLight);

/* LM 接触阴影（软圆盘，弥补无实时阴影） */
var lmShadow = new THREE.Mesh(
  new THREE.CircleGeometry(1, 32),
  new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0, depthWrite: false, alphaMap: TEX_DOT })
);
lmShadow.rotation.x = -Math.PI / 2;
lmShadow.position.y = 0.06;
lmShadow.visible = false;
scene.add(lmShadow);

/* 月尘 */
var dust = new THREE.Sprite(new THREE.SpriteMaterial({
  map: dustTexture(), transparent: true, opacity: 0, depthWrite: false
}));
dust.visible = false;
scene.add(dust);

/* ================= 状态 ================= */
var state = { mode: 'auto', idx: 0, ct: 0, run: false, speed: 1, cam: 'chase', alarm: false, met: 0, snap: true };
var MAXT = 45000, FUEL0 = 8200, G_MOON = 1.62;
var D = { alt: 15000, vs: -30, hs: 1500, thr: 1, fuel: FUEL0, dry: 2100, t: 0, done: false, ok: false, phase: 'P63', pitch: 0 };
var userThr = 0.5;
var keys = {};
var dtLast = 1 / 60;
var abortS = { t: 0, active: false, done: false };
var roverS = { x: 0, z: 0, y: 0, head: 0, spd: 0, batt: 100, roll: 0 };

function resetD() {
  D.alt = 15000; D.vs = -30; D.hs = 1500; D.thr = 1; D.fuel = FUEL0;
  D.t = 0; D.done = false; D.landed = false; D.ok = false; D.phase = 'P63'; D.pitch = 0;
}
/* 垂直比例压缩：真实高度非线性映射到可视高度，保证 LM 全程可见 */
function visY(alt) { return 0.6 + Math.pow(Math.max(0, alt), 0.62) * 0.9; }

function setClip(n, f) { camera.near = n; camera.far = f; camera.updateProjectionMatrix(); }

/* ================= 相机 ================= */
var camTgt = new THREE.Vector3();
function aim(px, py, pz, tx, ty, tz) {
  _tmpA.set(px, py, pz);
  _tmpB.set(tx, ty, tz);
  /* 深空段物体每帧位移可达数公里，跟随镜头必须硬贴，插值会被甩开 */
  camera.position.copy(_tmpA);
  camTgt.copy(_tmpB);
  state.snap = false;
  camera.lookAt(camTgt);
}
function vk() { return state.cam === 'ext' ? 2.6 : state.cam === 'near' ? 0.42 : 1; }
function faceDir(obj, dx, dy, dz, roll) {
  _tmpC.set(dx, dy, dz);
  if (_tmpC.lengthSq() < 1e-9) return;
  _tmpC.normalize();
  obj.quaternion.setFromUnitVectors(UP_Y, _tmpC);
  if (roll) obj.rotateY(roll);
}

/* ================= 真实 AGC 源码片段 ================= */
var CODE = {
  ignition: '# BURN, BABY, BURN -- MASTER IGNITION ROUTINE\n# Luminary099/BURN_BABY_BURN--MASTER_IGNITION_ROUTINE.agc\nBURNBABY  TC    PHASCHNG\n          OCT   04024\n          CAF   ZERO\n          TS    DVTOTAL\n          TS    DVTOTAL +1\n          TC    BANKCALL\n          CADR  P40AUTO',
  throttle: '# THROTTLE CONTROL (THROTTLE_CONTROL_ROUTINES.agc)\nTHROTTLE  CA    ABDELV\n          EXTEND\n          MP    /AF/CNST\n          TC    MASSMULT\n          DXCH  FP\n          EXTEND\n          DCA   /AFC/\n          TC    MASSMULT\n          TS    FC\n          DXCH  FCODD\n          ...\nDOIT      CA    PIF\n          AD    PIFPSET\n          TS    THRUST\n          CAF   BIT4\n          EXTEND\n          WOR   CHAN14',
  abort: '# ALARM AND ABORT (ALARM_AND_ABORT.agc)\n# 1202 = 执行器过载：执行程序排队溢出\n# 中止流程：上升级立即脱离下降级并点火\n        TC    ALARM\n        OCT   1202\n        TC    BANKCALL\n        CADR  ABORT',
  P63: '# P63 自动下降·刹车段（示意摘译）\n# THE_LUNAR_LANDING.agc / LUNAR_LANDING_GUIDANCE_EQUATIONS.agc\n        TC    PHASCHNG\n        OCT   05023\n        TC    BANKCALL\n        CADR  LUNARLAND\n# 高 15km -> 3km，主发动机大油门削水平速度',
  P64: '# P64 接近段（示意摘译）\n        CA    RATEINDX\n        EXTEND\n        MP    /GUID/CNST\n        TS    RATE\n# 水平速度近 0，稳定约 35 m/s 下降并修正落点',
  P65: '# P65 着陆段（示意摘译）\n        TC    BANKCALL\n        CADR  LUNARLAND\n# 高 <100m，下降率降到约 2 m/s，触月关机',
  landing: '# THE LUNAR LANDING (THE_LUNAR_LANDING.agc)\n# 下降制导方程见 LUNAR_LANDING_GUIDANCE_EQUATIONS.agc\n# P63/P64/P65 由 PHASE_TABLE 依次切换',
  ascent: '# ASCENT GUIDANCE (ASCENT_GUIDANCE.agc)\n        CA    ABVEL\n        EXTEND\n        MP    ...\n# 上升级发动机约 15.6 kN，约 7 分钟入轨',
  rover: '# 月面漫游（非 AGC 指令）\n# 月球车为手动驾驶，最高约 18 km/h\n# 两组银锌电池供电，续航约 92 km'
};
function hl(raw) {
  var esc = function (t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  return raw.split('\n').map(function (line) {
    var code = line, cmt = '', h = line.indexOf('#');
    if (h >= 0) { code = line.slice(0, h); cmt = line.slice(h); }
    var s = code.indexOf(';');
    if (s >= 0) { cmt = code.slice(s) + cmt; code = code.slice(0, s); }
    var out = esc(code).replace(
      /\b(TCF|TC|CAF|CA|CS|TS|DXCH|CCS|INDEX|EXTEND|AD|MP|DV|BZMF|WOR|DCA|DCS|DAS|OCT|DEC|BANK|SETLOC|EBANK|COUNT|CADR|2CADR|QXCH|ZL|LXCH|MASK|COM|INHINT|RELINT|PHASCHNG|RTNHOLD|BURNBABY|THROTTLE|DOIT|FLATOUT|ALARM)\b/g,
      '<span class="m">$1</span>');
    if (cmt) out += '<span class="c">' + esc(cmt) + '</span>';
    return out;
  }).join('\n');
}

/* ================= UI ================= */
var teleData = [];
var logEl = $('log');
function renderTele() {
  var g = $('tele');
  if (g.childElementCount !== teleData.length) {
    g.innerHTML = '';
    teleData.forEach(function (_, i) {
      var d = document.createElement('div');
      d.className = 'card';
      d.innerHTML = '<div class="k" id="tk' + i + '"></div><div class="v"><span id="tv' + i + '"></span><span class="u" id="tu' + i + '"></span></div>';
      g.appendChild(d);
    });
  }
  teleData.forEach(function (t, i) {
    $('tk' + i).textContent = t[0];
    $('tv' + i).textContent = t[1];
    $('tu' + i).textContent = t[2] || '';
  });
  if (teleData.length >= 2) {
    $('hudLblA').textContent = teleData[0][0].toUpperCase();
    $('hudA').textContent = teleData[0][1];
    $('hudUa').textContent = teleData[0][2] || '';
    $('hudLblV').textContent = teleData[1][0].toUpperCase();
    $('hudV').textContent = teleData[1][1];
    $('hudUv').textContent = teleData[1][2] || '';
  }
}
function metStr(t) {
  t = Math.max(0, t);
  var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function log(msg, cls) {
  var d = document.createElement('div');
  d.className = 'ln' + (cls ? ' ' + cls : '');
  d.innerHTML = '<span class="t">' + metStr(state.met) + '</span> ' + msg;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}
function setPhase(t, d, codeKey) {
  $('pT').textContent = t;
  $('pD').textContent = d;
  if (codeKey) { $('code').innerHTML = hl(CODE[codeKey] || CODE.landing); setCodeTab(codeKey); }
}
function setCodeTab(k) {
  document.querySelectorAll('#ctabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.k === k); });
}
function showCode(k) { $('code').innerHTML = hl(CODE[k] || CODE.landing); setCodeTab(k); }
function alarmOn() {
  state.alarm = true;
  var p = $('alarmPill');
  if (p) p.style.display = 'inline-block';
  log('⚠ AGC 程序告警 1202（执行器过载 / 排队溢出）——真实任务着陆前曾连续出现。', 'w');
}
function alarmOff() {
  state.alarm = false;
  var p = $('alarmPill');
  if (p) p.style.display = 'none';
}

/* ================= 下降物理 ================= */
function autoThrottle() {
  /* 末段必须提前收敛：可用推力加速度只有约 5.1 m/s²，扣掉月面重力净减速约 3.5 m/s²，
     原来到 100 m 才把目标降到 -2.2，根本刹不住（实测触月 -24 m/s，日志判定"着陆失败"）。
     现在 500 m 转 -10、160 m 转 -1.5，实测触月 -1.5 m/s。 */
  if (D.landed) return 0;
  var tgt = D.alt > 3000 ? -55 : D.alt > 500 ? -35 : D.alt > 160 ? -10 : -1.5;
  var aNet = (tgt - D.vs) / 8;
  var aUp = G_MOON + aNet;
  return clamp((aUp * (D.dry + Math.max(0, D.fuel))) / MAXT, 0.04, 1);
}
function stepD(thr, dt) {
  var m = D.dry + Math.max(0, D.fuel);
  var aUp = (thr * MAXT) / m;
  D.vs += (aUp - G_MOON) * dt;
  D.alt += D.vs * dt;
  D.thr = thr;
  D.fuel = Math.max(0, D.fuel - thr * 14.7 * dt);
  if (D.hs > 0) D.hs = Math.max(0, D.hs - (D.alt > 1500 ? 12 : 4) * dt);
  if (D.alt <= 0) {
    D.alt = 0;
    if (!D.done) { D.done = true; D.landed = true; D.ok = D.vs > -6 && D.vs < 0 && D.fuel > 0; }
    D.vs = 0;   /* 落到地面就静止，否则每帧都在"再次触月"，日志和尾焰会一直重来 */
  }
  var np = D.alt > 3000 ? 'P63' : D.alt > 100 ? 'P64' : D.alt > 0 ? 'P65' : 'TOUCH';
  if (np !== D.phase && D.phase !== 'TOUCH') {
    D.phase = np;
    var pd = PDESC[np];
    if (pd) setPhase(pd[0], pd[1], pd[2]);
  }
  if (!state.alarm && D.alt < 2600 && D.alt > 1400 && Math.random() < 0.004) alarmOn();
}
var PDESC = {
  P63: ['动力下降 · P63 刹车', '高 15 km → 3 km：主发动机近满油门，把 1500 m/s 的水平速度削到接近零，同时控制下降率。', 'P63'],
  P64: ['动力下降 · P64 接近', '高 3 km → 100 m：水平速度近零，转约 35 m/s 稳定下降，持续修正落点偏差。', 'P64'],
  P65: ['动力下降 · P65 着陆', '高 < 100 m：下降率降到约 2 m/s，准备触月关机。真实任务常被 1202 告警打断转人工。', 'P65'],
  TOUCH: ['触月成功', '登月舱接触月面，主发动机关机。全程由 AGC 下降制导律完成。', 'landing']
};
function updateDescentTele() {
  teleData = [
    ['高度', Math.round(D.alt).toLocaleString(), 'm'],
    ['垂直速度', D.vs.toFixed(1), 'm/s'],
    ['水平速度', Math.round(D.hs).toLocaleString(), 'm/s'],
    ['油门', Math.round(D.thr * 100), '%'],
    ['燃料', Math.round(D.fuel).toLocaleString(), 'kg'],
    ['程序', D.phase, '']
  ];
}

/* ================= 章节 ================= */
var CH = [];

/* 1. 发射 */
CH.push({
  name: '发射', dur: 30, met0: 0, code: 'ignition',
  setup: function () {
    hideAll(); setClip(0.02, 4000000);
    earth.visible = true; earth.position.set(0, 0, 0); earth.scale.setScalar(1);
    clouds.rotation.set(0, 0, 0);
    saturn.visible = true; saturn.scale.setScalar(0.001);
    saturn.position.set(0, EARTH_R + 0.006, 0);
    saturn.rotation.set(0, 0, 0);
    saturn.quaternion.identity();
    launchSite.visible = true;
    skyDome.visible = true;
    marker.visible = true;
    engineLight.distance = 0.34;
    engineLight.intensity = 0;
    $('teleLbl').textContent = '发射数据';
    setPhase('SA-506 发射 · 真实尺寸', '土星五号高 110.6 m、直径 10.1 m，在肯尼迪角 39A 点火。五台 F-1 总推力约 34 MN，起飞重量约 2900 t。', 'ignition');
    teleData = [['高度', '0', 'km'], ['速度', '0.00', 'km/s'], ['推力', '100', '%'], ['级', 'S-IC', ''], ['MET', '00:00', ''], ['乘员', '3', '']];
    log('点火序列开始，五台 F-1 达到额定推力。');
  },
  update: function (dt) {
    var t = state.ct / this.dur;
    /* 高度曲线逼近真实弹道：起飞头几秒几乎不动（刚离架），之后越爬越快。
       指数从 1.8 提到 3.2 —— 原来的曲线 1 秒就到 456 m，相机只能抬头 50° 以上
       去追，地面和塔架全被甩出画面。 */
    var alt = lerp(0, 200, Math.pow(t, 3.2));
    saturn.position.y = EARTH_R + 0.006 + alt;
    /* 45 km 以上收起发射场那块平面地面，让带真实贴图的地球球面接管画面；
       否则高空段会看到一张被雾照亮的"棕色平板"，一眼就假 */
    launchSite.visible = alt < 45;

    /* 姿态：重力转弯。绕固定的世界轴一次转到位，
       不要在 rotation.x / rotation.z 上各转一点 —— 那样箭体是"歪"的不是"俯"的 */
    var pr = Math.pow(clamp((t - 0.03) / 0.97, 0, 1), 1.25);
    var pitch = pr * 1.05;
    saturn.quaternion.setFromAxisAngle(V3(0.86, 0, 0.51).normalize(), pitch);

    var fl = saturn.userData.flame;
    /* 低空时尾焰大半被台面切掉（真实发射台有导流槽），所以先把长度压到 35%，
       随高度舒展开，不然只看得到喷口处一小撮火 */
    var flare = lerp(0.35, 1, clamp(alt / 0.9, 0, 1));
    fl.material.opacity = 0.80 + 0.18 * Math.sin(state.ct * 26) * Math.sin(state.ct * 7);
    /* 低空火焰被台面压住，横向放大成火团，才看得出"五台 F-1 在喷" */
    var wide = lerp(1.9, 1, clamp(alt / 0.9, 0, 1));
    fl.scale.set((1 + 0.06 * Math.sin(state.ct * 19)) * wide, (0.94 + 0.20 * Math.sin(state.ct * 15)) * flare, wide);
    var fo = saturn.userData.flameOuter;
    fo.material.opacity = 0.52 + 0.09 * Math.sin(state.ct * 13);
    fo.scale.set((1 + 0.10 * Math.sin(state.ct * 9)) * wide, (0.82 + 0.16 * Math.sin(state.ct * 11)) * flare, wide);

    /* 发动机光：挂在喷口平面（局部 y≈0.3 m），不是挂在箭体中心。
       distance 必须有界 —— 之前 0（无限远）+ intensity 26 直接把整个台面照爆 */
    engineLight.position.set(0, saturn.position.y - 0.0004, 0);
    engineLight.intensity = 6.5 * clamp(1 - alt / 9, 0.16, 1);
    engineLight.distance = 0.17;

    /* 天空随高度褪成真空 */
    skyDome.position.copy(camera.position);
    skyDome.material.uniforms.uFade.value = Math.pow(clamp(1 - alt / 52, 0, 1), 0.8);
    /* 天上还有星星的白天是假的，随高度把它们放出来 */
    starField.material.opacity = clamp((alt - 6) / 26, 0, 0.95);


    /* 机位：起飞瞬间贴在地面（30 m 高、水平 300 m）平视，
       1.2 km 内平滑过渡到伴飞，之后固定在火箭侧下方 —— 之前过渡到 4.5 km
       才完成，中途相机被甩在火箭下方 1.1 km，等于抬头 75° 看天，地面全丢 */
    var dist = 0.30 + alt * 0.0015;
    /* 1 单位 = 1 km，所以 60 m 要写 0.06。低空时相机锁在地表上方 60 m
       （仰拍发射台），火箭爬起来之后自动变成侧下方 12 m 的伴飞机位。 */
    var camY = Math.max(EARTH_R + 0.06, saturn.position.y - 0.012);
    aim(dist * 0.50, camY, dist * 0.87, 0, saturn.position.y + 0.055, 0);

    markerTo(saturn, 0.02);
    if (t > 0.16 && !this._a) { this._a = true; log('S-IC 一级关机，反推火箭点火，级间分离。', 'g'); }
    if (t > 0.34 && !this._b) { this._b = true; log('S-II 五台 J-2 点火，继续爬升。'); }
    if (t > 0.62 && !this._c) { this._c = true; log('S-II 关机分离，S-IVB 点火进入 185 km 停泊轨道。'); }
    if (t > 0.85 && !this._d) { this._d = true; log('入轨完成，绕地球一圈半后准备 TLI。', 'g'); }
    teleData = [
      ['高度', alt.toFixed(0), 'km'],
      ['速度', clamp(alt / 26, 0, 7.8).toFixed(2), 'km/s'],
      ['推力', t < 0.16 ? '100' : t < 0.34 ? '0' : '100', '%'],
      ['级', t < 0.18 ? 'S-IC' : t < 0.36 ? 'S-II' : 'S-IVB', ''],
      ['MET', metStr(state.met).slice(0, 5), ''],
      ['过载', (1 + t * 2.6).toFixed(1), 'g']
    ];
  }
});

/* 2. 地月转移 */
CH.push({
  name: '地月转移', dur: 40, met0: 3 * 3600 + 20 * 60, code: 'ignition',
  setup: function () {
    hideAll(); setClip(0.004, 4000000);
    earth.visible = true; earth.position.set(0, 0, 0); earth.scale.setScalar(1);
    moon.visible = true; moon.position.set(D_EM, 0, 0); moon.scale.setScalar(1);
    stack.visible = true; stack.scale.setScalar(0.001);
    stack.position.set(EARTH_R + 320, 0, 0);
    faceDir(stack, 1, 0, 0, 0);
    if (stack.userData.lm) stack.userData.lm.visible = true;
    stack.userData.csm.userData.plume.material.opacity = 0;
    marker.visible = true;
    engineLight.intensity = 0;
    $('teleLbl').textContent = '转移轨道';
    setPhase('跨月入射 TLI · 真实距离', 'S-IVB 二次点火约 5 分 47 秒，速度增量约 3.05 km/s。此后组合体沿地月连线惯性滑行约 3 天，中途做调头对接把 LM 拖出来。', 'ignition');
    teleData = [['地月距离', '384,400', 'km'], ['速度', '10.4', 'km/s'], ['姿态', '调头', ''], ['耗时', '0.0', '天'], ['目标', '月球', ''], ['MET', '03:20', '']];
    log('TLI 点火完成，飞离地球。');
  },
  update: function (dt) {
    var t = state.ct / this.dur;
    var x = lerp(EARTH_R + 320, D_EM - MOON_R - 1400, ease(t));
    var sy = Math.sin(t * Math.PI) * 0.5;
    stack.position.set(x, sy, 0);
    faceDir(stack, 1, 0, 0, t * 0.5);
    var d = 0.055 * vk();
    aim(x + d * (SUN_DIR.x * 0.7 - 0.5), sy + d * (SUN_DIR.y * 0.7 + 0.42), d * SUN_DIR.z * 0.9, x, sy, 0);
    markerTo(stack, 0.004);
    if (t > 0.28 && !this._dock) { this._dock = true; log('指令/服务舱转 180°，与登月舱对接并拖出。', 'g'); }
    if (t > 0.52 && !this._mid) { this._mid = true; log('越过地月中点，月球引力开始占主导。'); }
    if (t > 0.8 && !this._chk) { this._chk = true; log('中途校正点火，微调航线精度。'); }
    teleData = [
      ['距地球', Math.round(x - EARTH_R).toLocaleString(), 'km'],
      ['速度', (10.4 - 2.0 * t).toFixed(2), 'km/s'],
      ['姿态', t > 0.3 ? '已对接' : '调头中', ''],
      ['耗时', (t * 3.1).toFixed(1), '天'],
      ['目标', '月球', ''],
      ['MET', metStr(state.met).slice(0, 5), '']
    ];
  }
});

/* 3. 环月 */
CH.push({
  name: '环月', dur: 28, met0: 78 * 3600, code: 'landing',
  setup: function () {
    hideAll(); setClip(0.004, 4000000);
    moon.visible = true; moon.position.set(0, 0, 0); moon.scale.setScalar(1);
    earth.visible = true; earth.position.set(-D_EM, 0, 0); earth.scale.setScalar(1);
    stack.visible = true; stack.scale.setScalar(0.001);
    if (stack.userData.lm) stack.userData.lm.visible = true;
    stack.userData.csm.userData.plume.material.opacity = 0;
    marker.visible = true;
    engineLight.intensity = 0;
    $('teleLbl').textContent = '环月轨道';
    setPhase('环月捕获 LOI · 真实轨道', '服务舱主发动机反推约 6 分钟，速度减 0.9 km/s，被月球捕获进入 111×314 km 椭圆轨道，随后圆化到约 100 km。', 'landing');
    teleData = [['轨道高度', '100', 'km'], ['轨道速度', '1.63', 'km/s'], ['周期', '1.98', 'h'], ['倾角', '1.25', '°'], ['状态', '在轨', ''], ['MET', '78:00', '']];
    log('LOI-1 点火，进入环月轨道。');
  },
  update: function (dt) {
    var t = state.ct / this.dur;
    var a = t * Math.PI * 2 * 1.15 + 0.4, R = MOON_R + 100;
    var px = Math.cos(a) * R, pz = Math.sin(a) * R, py = Math.sin(a) * 60;
    stack.position.set(px, py, pz);
    faceDir(stack, -Math.sin(a), 0, Math.cos(a), 0.4);
    var d = 0.075 * vk();
    aim(px + d * (SUN_DIR.x * 0.55 - 0.35), py + d * (SUN_DIR.y * 0.5 + 0.55), pz + d * SUN_DIR.z * 0.9, px, py, pz);
    markerTo(stack, 0.006);
    if (t > 0.42 && !this._sep) { this._sep = true; log('指令舱与登月舱分离，Armstrong 与 Aldrin 进入 LM。', 'g'); }
    if (t > 0.7 && !this._chk) { this._chk = true; log('检查下降级、雷达与制导平台，准备 DOI 点火。'); }
    teleData = [
      ['轨道高度', '100', 'km'],
      ['轨道速度', (1.63 + Math.sin(t * 6) * 0.01).toFixed(2), 'km/s'],
      ['周期', '1.98', 'h'],
      ['倾角', '1.25', '°'],
      ['状态', t > 0.42 ? 'LM 独立' : '组合体', ''],
      ['MET', metStr(state.met).slice(0, 5), '']
    ];
  }
});

/* 4. 动力下降 */
CH.push({
  name: '动力下降', dur: 999, met0: 101 * 3600 + 36 * 60, code: 'throttle',
  setup: function () {
    hideAll(); setClip(0.08, 400000);
    ground.visible = true; rocks.visible = true;
    lm.visible = true; lm.scale.setScalar(1);
    resetD();
    /* 月球天上那颗地球：真实角直径约 1.9°，放 1.9 km 处按比例缩放 */
    earth.visible = true;
    earth.scale.setScalar(52 / EARTH_R);
    earth.position.copy(V3(-0.58, 0.36, -0.73).normalize().multiplyScalar(1900));
    lm.position.set(0, visY(D.alt), 0); lm.rotation.set(0, 0, 0);
    lm.userData.plume.material.opacity = 0;
    dust.visible = true; dust.material.opacity = 0;
    alarmOff();
    $('teleLbl').textContent = '下降制导';
    setPhase('动力下降 · P63', 'LM 在 15 km 高度启动下降发动机（DPS）。AGC 依次执行 P63 刹车、P64 接近、P65 着陆，可用上方标签查看对应指令。', 'throttle');
    teleData = [['高度', '15,000', 'm'], ['垂直速度', '-30', 'm/s'], ['水平速度', '1,500', 'm/s'], ['油门', '100', '%'], ['燃料', '8,200', 'kg'], ['程序', 'P63', '']];
    log('LM 分离，DPS 点火，开始动力下降。');
  },
  update: function (dt) {
    var steps = Math.max(1, Math.round(state.speed * 2));
    for (var i = 0; i < steps; i++) {
      stepD(autoThrottle(), (dt * state.speed) / steps);
      if (D.done) break;
    }
    var y = visY(D.alt);
    lm.position.y = y;
    /* 姿态：刹车段机头压低（发动机朝前上方），落地前回正 */
    var tilt = lerp(0.16, 0, clamp(1 - D.alt / 2600, 0, 1));
    lm.rotation.set(tilt * 0.85, 0, -tilt * 0.45);
    var po = (D.thr > 0.05 && !D.done && !D.landed) ? 0.34 + D.thr * 0.58 : 0;
    lm.userData.plume.material.opacity = po;
    lm.userData.plume.scale.set(0.9 + D.thr * 0.2, 0.55 + D.thr * 0.9, 0.9 + D.thr * 0.2);
    engineLight.position.set(0, y - 0.45, 0);
    engineLight.intensity = (D.done || D.landed) ? 0 : 1.6 + D.thr * 7.0;
    engineLight.distance = 55;   /* 米制场景：55 m，不是 7.5 cm */
    /* 月尘：低于 60 m 开始扬起 */
    if (D.alt < 70 && !D.done) {
      var k = 1 - D.alt / 70;
      dust.position.set(0, 1.2, 0);
      dust.scale.setScalar(lerp(12, 90, k));
      dust.material.opacity = k * 0.5;
    } else dust.material.opacity = 0;
    updateDescentTele();
    var base = clamp(13 + y * 0.13, 15, 46);
    var d = base * (state.cam === 'ext' ? 2.3 : state.cam === 'near' ? 0.4 : 1);
    /* 机位压到接近地面、略仰视：原来相机高在 LM 上方 5 m 俯拍，
       视线上方只剩 5°，天上那颗地球（仰角约 8°）被挤出画面 */
    aim(d * 0.66, y + 2.6 + d * 0.11, d * 0.72, 0, y + 2.6 + d * 0.16, 0);
    if (D.done) {
      dust.material.opacity = 0;
      /* 只播报一次：D.done 每帧会被 stepD 重新置位，不加闸门日志会刷满整屏 */
      if (!this._touched) {
        this._touched = true;
        if (D.ok) { log('平稳触月（垂直 ' + Math.abs(D.vs).toFixed(1) + ' m/s），DPS 关机。', 'g'); }
        else log('触月速度过大，着陆失败。', 'r');
        setTimeout(function () { if (state.mode === 'auto') { state.idx = 4; startChapter(4); } }, 1600);
      }
      D.done = false; D.alt = 0;
    }
  }
});

/* 5. 月面活动 */
CH.push({
  name: '月面活动', dur: 32, met0: 109 * 3600 + 20 * 60, code: 'rover',
  setup: function () {
    hideAll(); setClip(0.08, 400000);
    ground.visible = true; rocks.visible = true;
    /* 月球天上那颗地球：真实角直径约 1.9°，放 1.9 km 处按比例缩放 */
    earth.visible = true;
    earth.scale.setScalar(52 / EARTH_R);
    earth.position.copy(V3(-0.58, 0.36, -0.73).normalize().multiplyScalar(1900));
    lm.visible = true; lm.scale.setScalar(1); lm.position.set(0, 0, 0); lm.rotation.set(0, 0, 0);
    lm.userData.plume.material.opacity = 0;
    astro.visible = true; astro.position.set(-7, 0, 5); astro.rotation.y = 0.4;
    flag.visible = true; flag.position.set(8, 0, 6); flag.scale.setScalar(0.001);
    alsep.visible = true; alsep.position.set(-6, 0, 8);
    $('teleLbl').textContent = '月面状态';
    setPhase('月面行走 · EVA', '1969-07-21 02:56 UTC，Armstrong 踏上月面。展开国旗、部署 ALSEP 科学包、采集 21.5 kg 月岩。舱外活动约 2 小时 31 分。', 'rover');
    teleData = [['状态', '月面', ''], ['舱外', '2', '人'], ['舱外时长', '2:31', 'h'], ['月岩', '21.5', 'kg'], ['MET', '109:20', ''], ['通讯', 'S 波段', '']];
    log('舱门开启，Armstrong 沿梯子下到月面。');
  },
  update: function (dt) {
    var t = state.ct / this.dur;
    var w = ease(clamp(t * 1.1, 0, 1));
    astro.position.x = lerp(-7, 5.5, w);
    astro.position.z = 5 + Math.sin(state.ct * 1.6) * 0.4;
    astro.position.y = Math.abs(Math.sin(state.ct * 2.2)) * 0.22;
    astro.rotation.y = -0.5;
    var fs = clamp((t - 0.4) * 2.6, 0, 1);
    flag.scale.setScalar(Math.max(0.001, fs));
    if (fs > 0.92 && !this._flag) { this._flag = true; log('展开并固定国旗（带回力杆，所以看起来是"飘"的）。', 'g'); }
    if (t > 0.66 && !this._rock) { this._rock = true; log('采集月岩与月壤样本，装入样本袋。', 'g'); }
    if (t > 0.84 && !this._alsep) { this._alsep = true; log('部署 ALSEP 科学包：月震仪、激光反射器、太阳风收集器。', 'g'); }
    if (t > 0.93 && !this._flag2) { this._flag2 = true; log('与尼克松总统通话，随后返回舱内休息。'); }
    /* 机位压低、略微仰起，让地平线和天上的地球一起进画面 */
    var d = 26 * vk();
    var tx = astro.position.x * 0.35;
    aim(tx + d * 0.52, 4.4 + d * 0.06, 2 + d * 0.60, tx + 2, 7.0, 3);
    teleData = [
      ['状态', '月面', ''],
      ['舱外', '2', '人'],
      ['舱外时长', (2.5 * clamp(t, 0, 1)).toFixed(2), 'h'],
      ['月岩', (21.5 * clamp(t * 1.2, 0, 1)).toFixed(1), 'kg'],
      ['MET', metStr(state.met).slice(0, 5), ''],
      ['通讯', 'S 波段', '']
    ];
  }
});

/* 6. 上升返回 */
CH.push({
  name: '上升返回', dur: 30, met0: 124 * 3600, code: 'ascent',
  setup: function () {
    hideAll(); setClip(0.08, 400000);
    ground.visible = true; rocks.visible = true;
    lm.visible = true; lm.scale.setScalar(1); lm.position.set(0, 0, 0); lm.rotation.set(0, 0, 0);
    /* 月球天上那颗地球：真实角直径约 1.9°，放 1.9 km 处按比例缩放 */
    earth.visible = true;
    earth.scale.setScalar(52 / EARTH_R);
    earth.position.copy(V3(-0.58, 0.36, -0.73).normalize().multiplyScalar(1900));
    lm.userData.plume.material.opacity = 0;
    lmAsc.visible = true; lmAsc.position.set(0, 4.45, 0); lmAsc.rotation.set(0, 0, 0);
    lmAsc.userData.plume.material.opacity = 0;
    lmAsc.userData.plumeOuter.material.opacity = 0;
    csm.visible = true; csm.scale.setScalar(1); csm.position.set(0, 260, 0); csm.rotation.set(0, 0, 0);
    csm.userData.plume.material.opacity = 0;
    $('teleLbl').textContent = '上升段';
    setPhase('上升级点火 · Ascent', '上升级发动机（约 15.6 kN）点火，7 分多钟后进入 18×87 km 轨道，随后与指令舱交会对接。下降级留在月面。', 'ascent');
    teleData = [['高度', '0', 'm'], ['速度', '0.0', 'm/s'], ['目标', 'CSM', ''], ['对接', '—', ''], ['乘员', '2', ''], ['MET', '124:00', '']];
    log('上升级点火，离开月面。');
  },
  update: function (dt) {
    var t = state.ct / this.dur;
    var y = lerp(4.45, 240, Math.pow(ease(t), 1.25));
    lmAsc.position.y = y;
    /* 姿态：离开月面后按程序转弯，不是笔直往上飞 */
    var pv = ease(clamp((t - 0.12) / 0.62, 0, 1));
    lmAsc.rotation.z = -pv * 0.62;
    lmAsc.rotation.x = pv * 0.22;
    lmAsc.userData.plume.material.opacity = t < 0.9 ? 0.50 : 0;
    lmAsc.userData.plume.scale.set(1, 0.85 + 0.18 * Math.sin(state.ct * 18), 1);
    if (lmAsc.userData.plumeOuter) lmAsc.userData.plumeOuter.material.opacity = t < 0.9 ? 0.26 : 0;
    engineLight.position.set(Math.sin(pv * 0.62) * 2.2, y - 1.6, 0);
    engineLight.intensity = t < 0.9 ? 6.5 : 0;
    engineLight.distance = 60;   /* 米制场景：60 m（原来写的 0.06 = 6 cm，灯根本照不到） */
    /* 机位压到上升级下方仰视，否则尾焰被箭体挡住；
       距离只缓慢拉开（不是按高度线性放大），让上升级始终占住画面主体，
       靠月面自己往下沉来表达"越飞越高" */
    var d = (19 + y * 0.045) * vk();
    aim(d * 0.56, y - 1.3 - d * 0.06, d * 0.80, 0, y + 0.6, 0);
    if (t > 0.3 && !this._a) { this._a = true; log('上升级加速爬升，下降级留在月面作为发射平台。'); }
    if (t > 0.55 && !this._b) { this._b = true; log('进入环月轨道，雷达锁定指令舱。', 'g'); }
    if (t > 0.85 && !this._c) { this._c = true; log('完成交会与对接，两名航天员转移回指令舱。', 'g'); }
    teleData = [
      ['高度', Math.round(y * 42).toLocaleString(), 'm'],
      ['速度', clamp(y / 16, 0, 1.7).toFixed(2), 'km/s'],
      ['目标', 'CSM', ''],
      ['对接', t > 0.88 ? '完成' : '进行中', ''],
      ['乘员', '2', ''],
      ['MET', metStr(state.met).slice(0, 5), '']
    ];
  }
});

/* 7. 再入溅落 */
CH.push({
  name: '再入溅落', dur: 34, met0: 135 * 3600, code: 'abort',
  setup: function () {
    hideAll(); setClip(0.004, 4000000);
    earth.visible = true; earth.position.set(0, 0, 0); earth.scale.setScalar(1);
    moon.visible = true; moon.position.set(D_EM, 0, 0); moon.scale.setScalar(1);
    stack.visible = true; stack.scale.setScalar(0.001);
    stack.position.set(D_EM - MOON_R - 1200, 0, 0);
    faceDir(stack, -1, 0, 0, 0);
    /* 返航前 LM 已经丢弃，再入时只剩指令/服务舱 */
    if (stack.userData.lm) stack.userData.lm.visible = false;
    stack.userData.csm.userData.plume.material.opacity = 0;
    marker.visible = true;
    $('teleLbl').textContent = '返回段';
    setPhase('跨地入射 · 再入 · 真实距离', '服务舱点火 TEI（约 3.05 km/s）脱离月球，3 天后以约 11 km/s 冲入大气，靠隔热盾减速、开伞、溅落太平洋。', 'abort');
    teleData = [['地距', '384,400', 'km'], ['速度', '11.0', 'km/s'], ['降落伞', '未开', ''], ['溅落', '太平洋', ''], ['乘员', '3', ''], ['MET', '195:00', '']];
    log('TEI 点火，踏上归途。');
  },
  update: function (dt) {
    var t = state.ct / this.dur;
    var x = lerp(D_EM - MOON_R - 1200, EARTH_R + 90, ease(t));
    stack.position.set(x, 0, 0);
    faceDir(stack, -1, 0, 0, t * 0.25);
    var d = 0.062 * vk();
    /* 机位放到飞船外侧（+x 背离地球那一侧），视线朝 -x 回望，地球正好挂在飞船背后；
       原来相机在侧后方，地球只能从左边缘擦出去，整段看起来像在星空里飘 */
    aim(x + d * 0.95, d * 0.10, d * 0.26, x, 0, 0);
    markerTo(stack, 0.004);
    /* 等离子体：贴在指令舱前端，随再入加深 */
    var heat = clamp((t - 0.58) / 0.16, 0, 1) * (1 - clamp((t - 0.90) / 0.08, 0, 1));
    if (heat > 0.01) {
      _tmpA.set(0, 10.4, 0).applyQuaternion(stack.quaternion)
        .multiplyScalar(stack.scale.x).add(stack.position);
      reentryGlow.position.copy(_tmpA);
      reentryGlow.scale.setScalar(0.006 + heat * 0.013);
      reentryGlow.material.opacity = heat * 0.95;
      reentryGlow.visible = true;
    } else reentryGlow.visible = false;
    if (t > 0.62 && !this._re) { this._re = true; log('再入界面，气动加热，隔热盾表面升温。', 'w'); }
    if (t > 0.8 && !this._ch) { this._ch = true; log('减速伞与三具主伞依次展开。'); }
    if (t > 0.93 && !this._sp) { this._sp = true; log('平安溅落太平洋，1969-07-24 任务完成。', 'g'); }
    teleData = [
      ['地距', Math.round(384400 * (1 - t * 0.99)).toLocaleString(), 'km'],
      ['速度', (11 * (1 - Math.pow(t, 3) * 0.98)).toFixed(1), 'km/s'],
      ['降落伞', t > 0.8 ? '已开' : '未开', ''],
      ['溅落', t > 0.93 ? '完成' : '太平洋', ''],
      ['乘员', '3', ''],
      ['MET', metStr(state.met).slice(0, 5), '']
    ];
  }
});

/* ================= 标记 / 清理 ================= */
function markerTo(obj, minScale) {
  marker.position.copy(obj.position);
  var d = camera.position.distanceTo(obj.position);
  marker.scale.setScalar(Math.max(minScale || 0.0004, d * 0.02));
  /* Sprite 位于相机背后时会铺满全屏，这里直接剔除 */
  _tmpA.copy(obj.position).sub(camera.position);
  camera.getWorldDirection(_tmpB);
  marker.visible = _tmpA.dot(_tmpB) > 0;
}
function hideAll() {
  earth.visible = false; moon.visible = false; ground.visible = false; rocks.visible = false;
  saturn.visible = false; csm.visible = false; lm.visible = false; stack.visible = false;
  astro.visible = false; rover.visible = false; flag.visible = false; alsep.visible = false;
  marker.visible = false; dust.visible = false; dust.material.opacity = 0;
  reentryGlow.visible = false; reentryGlow.material.opacity = 0;
  lmShadow.visible = false;
  launchSite.visible = false;
  skyDome.visible = false;
  starField.material.opacity = 0.95;
  engineLight.intensity = 0;
  engineLight.distance = 0.09;
  lmAsc.visible = true; lmAsc.position.set(0, 4.45, 0);
  lmAsc.userData.plume.material.opacity = 0;
  if (lmAsc.userData.plumeOuter) lmAsc.userData.plumeOuter.material.opacity = 0;
  lm.userData.plume.material.opacity = 0;
  csm.userData.plume.material.opacity = 0;
  setClip(0.1, 4000000);
}

/* ================= 手动着陆 ================= */
function enterManual() {
  hideAll(); setClip(0.08, 400000);
  ground.visible = true; rocks.visible = true; lm.visible = true; lm.scale.setScalar(1);
  resetD(); D.alt = 3000; D.vs = -12; D.hs = 0; D.pitch = 0; userThr = 0.55;
  stepManual._done = false;
  $('thr').value = 55; $('thrv').textContent = '55%';
  lm.position.set(0, visY(D.alt), 0); lm.rotation.set(0, 0, 0);
  lm.userData.plume.material.opacity = 0;
  dust.visible = true; dust.material.opacity = 0;
  alarmOff();
  $('teleLbl').textContent = '手动下降';
  setPhase('手动着陆模式', '你来控油门与姿态：↑↓ 油门，←→ 左右倾斜。倾斜会产生水平推力、偏移落点并浪费燃料。目标 |垂直速度| < 6 m/s 且 |水平速度| < 3 m/s。', 'throttle');
  log('手动接管：从 3000 m 开始，注意燃料。');
}
function stepManual(dt) {
  var thr = userThr, m = D.dry + Math.max(0, D.fuel), aUp = (thr * MAXT) / m;
  D.vs += (aUp * Math.cos(D.pitch) - G_MOON) * dt;
  D.hs += aUp * Math.sin(D.pitch) * dt;
  D.alt += D.vs * dt;
  D.thr = thr;
  D.fuel = Math.max(0, D.fuel - thr * 14.7 * dt);
  D.pitch *= (1 - 0.55 * dt);
  if (D.alt <= 0) {
    D.alt = 0;
    if (!D.done) { D.done = true; D.ok = (D.vs > -6 && D.vs < 0 && Math.abs(D.hs) < 3 && D.fuel > 0); }
  }
  var y = visY(D.alt);
  lm.position.y = y;
  lm.rotation.z = -D.pitch;
  var po = (thr > 0.05 && !D.done) ? 0.22 + thr * 0.55 : 0;
  lm.userData.plume.material.opacity = po;
  lm.userData.plume.scale.set(0.9 + thr * 0.2, 0.55 + thr * 0.9, 0.9 + thr * 0.2);
  engineLight.position.set(0, y - 0.45, 0);
  engineLight.intensity = (D.done || D.landed) ? 0 : 1.6 + thr * 7.0;
  engineLight.distance = 55;   /* 米制场景：55 m，不是 7.5 cm */
  if (D.alt < 70 && !D.done) {
    var k = 1 - D.alt / 70;
    dust.position.set(0, 1.2, 0); dust.scale.setScalar(lerp(12, 90, k));
    dust.material.opacity = k * 0.5;
  } else dust.material.opacity = 0;
  teleData = [
    ['高度', Math.round(D.alt).toLocaleString(), 'm'],
    ['垂直速度', D.vs.toFixed(1), 'm/s'],
    ['水平速度', D.hs.toFixed(1), 'm/s'],
    ['油门', Math.round(thr * 100), '%'],
    ['姿态', (D.pitch / D2R).toFixed(0) + '°', ''],
    ['燃料', Math.round(D.fuel).toLocaleString(), 'kg']
  ];
  var base = clamp(22 + y * 0.42, 24, 170);
  var d = base * (state.cam === 'ext' ? 2.3 : state.cam === 'near' ? 0.4 : 1);
  aim(d * 0.66, y + 2.6 + d * 0.34, d * 0.72, 0, y + 2.6, 0);
  if (D.done) {
    state.run = false;
    $('play').textContent = '▶ 播放';
    lm.userData.plume.material.opacity = 0;
    engineLight.intensity = 0;
    if (stepManual._done) { D.done = false; D.alt = 0.0001; return; }
    stepManual._done = true;
    if (D.ok) {
      setPhase('柔着陆成功', '触月垂直速度 ' + Math.abs(D.vs).toFixed(1) + ' m/s、水平 ' + Math.abs(D.hs).toFixed(1) + ' m/s，剩余燃料 ' + Math.round(D.fuel) + ' kg。', 'P65');
      log('柔着陆成功！', 'g');
    } else {
      setPhase('坠毁', '触月垂直 ' + Math.abs(D.vs).toFixed(1) + ' m/s（阈值 6）、水平 ' + Math.abs(D.hs).toFixed(1) + ' m/s（阈值 3），或燃料耗尽。', 'abort');
      log('坠毁：触月速度过大或燃料耗尽。', 'r');
    }
    D.done = false; D.alt = 0.0001;
  }
}

/* ================= 中止 / 逃逸 ================= */
function enterAbort() {
  hideAll(); setClip(0.08, 400000);
  ground.visible = true; rocks.visible = true; lm.visible = true; lm.scale.setScalar(1);
  resetD(); D.alt = 6000; D.vs = -30;
  lm.position.set(0, visY(D.alt), 0); lm.rotation.set(0, 0, 0);
  lm.userData.plume.material.opacity = 0;
  lmAsc.visible = true; lmAsc.position.set(0, 4.45, 0); lmAsc.userData.plume.material.opacity = 0;
  dust.visible = true; dust.material.opacity = 0;
  alarmOff();
  abortS.t = 0; abortS.active = false; abortS.done = false;
  $('teleLbl').textContent = '中止 / 逃逸';
  setPhase('中止逃逸模式', '下降中出现险情时，按「⚠ 中止」或空格：上升级立即脱离下降级并点火爬升，回到环月轨道与指令舱会合。真实中由 ALARM_AND_ABORT 逻辑处理 1202 告警。', 'abort');
  log('下降中……随时可触发中止。');
}
function stepAbort(dt) {
  if (!abortS.active) {
    stepD(autoThrottle(), dt);
    var y = visY(D.alt);
    lm.position.y = y;
    lm.userData.plume.material.opacity = (D.thr > 0.05 && !D.landed) ? 0.25 + D.thr * 0.5 : 0;
    engineLight.position.set(0, y - 0.45, 0);
    engineLight.intensity = D.landed ? 0 : 1.6 + D.thr * 7.0;
    engineLight.distance = 55;   /* 米制场景：55 m，不是 7.5 cm */
    updateDescentTele();
    var base = clamp(13 + y * 0.13, 15, 46);
    var d = base * (state.cam === 'ext' ? 2.3 : state.cam === 'near' ? 0.4 : 1);
    aim(d * 0.66, y + 2.6 + d * 0.34, d * 0.72, 0, y + 2.6, 0);
    if (D.done) { state.run = false; log('下降过程中已经触月，未触发中止。', 'w'); D.done = false; }
  } else {
    abortS.t += dt;
    /* 系数 26 → 6 → 1.6：升得太快相机跟上去只剩一片黑（月面圆盘半径有限，
       爬到 700 m 以上画面就全空了）。1.6 时 11 秒到约 200 m，月面始终留在画面下部 */
    var y2 = 4.45 + abortS.t * abortS.t * 1.6;
    lmAsc.position.y = y2;
    lmAsc.userData.plume.material.opacity = 0.50;
    lmAsc.userData.plumeOuter.material.opacity = 0.26;
    lmAsc.userData.plume.scale.set(1, 0.85 + 0.2 * Math.sin(state.ct * 22), 1);
    /* y2 是上升级相对 lm 组的局部高度，相机和灯光要的是世界高度，
       少加 lm.position.y 会让镜头对着上升级下方几十米的空气（上一版就是全黑） */
    var wy = lm.position.y + y2;
    engineLight.position.set(0, wy - 1.5, 0);
    engineLight.intensity = 2.2;
    engineLight.distance = 55;   /* 同上：米制场景，别写成 0.09 */
    var d2 = 30 * (state.cam === 'ext' ? 2.3 : state.cam === 'near' ? 0.42 : 1);
    aim(d2 * 0.56, wy - 1.3 - d2 * 0.06, d2 * 0.80, 0, wy + 0.6, 0);
    teleData = [
      ['状态', '上升', ''],
      ['高度', Math.round(wy * 42).toLocaleString(), 'm'],
      ['垂直速度', '+', 'm/s'],
      ['程序', 'ABORT', ''],
      ['目标', '环月轨道', ''],
      ['MET', metStr(state.met).slice(0, 5), '']
    ];
    if (abortS.t > 1.2 && !abortS.done) {
      abortS.done = true;
      log('中止完成：上升级已脱离并稳定爬升，正在返回环月轨道。', 'g');
    }
  }
}
function doAbort() {
  if (state.mode !== 'abort' || abortS.active) return;
  abortS.active = true;
  D.done = true; D.thr = 0; D.fuel = 0;
  lm.userData.plume.material.opacity = 0;
  lmAsc.userData.plume.material.opacity = 0.62;
  lmAsc.userData.plumeOuter.material.opacity = 0.26;
  state.run = true;
  $('play').textContent = '⏸ 暂停';
  log('⚠ 中止！上升级与下降级分离，上升发动机点火。', 'w');
}

/* ================= 月面漫游 ================= */
function enterRover() {
  hideAll(); setClip(0.08, 400000);
  ground.visible = true; rocks.visible = true;
  rover.visible = true; flag.visible = true; alsep.visible = true; astro.visible = true;
  lm.visible = true; lm.scale.setScalar(1); lm.position.set(-22, 0, -14);
  rover.position.set(0, 0, 0); rover.rotation.set(0, 0, 0);
  flag.position.set(16, 0, 12); flag.scale.setScalar(1);
  alsep.position.set(-11, 0, 9);
  astro.position.set(-4, 0, 4); astro.rotation.y = Math.PI;
  roverS.x = 0; roverS.z = 0; roverS.head = 0; roverS.spd = 0; roverS.batt = 100; roverS.roll = 0;
  $('teleLbl').textContent = '漫游数据';
  setPhase('月面漫游模式', '用 WASD / 方向键驾驶月球车。真实月球车由航天员手动操控，最高约 18 km/h，靠两组银锌电池供电，三次 EVA 共行驶约 35 km。', 'rover');
  log('月球车就绪：WASD 驾驶，A/D 转向。');
}
function stepRover(dt) {
  var acc = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  var turn = (keys.a ? 1 : 0) - (keys.d ? 1 : 0);
  roverS.spd += (acc * 5.5 - (acc ? 0 : roverS.spd * 1.8)) * dt;
  roverS.spd = clamp(roverS.spd, -2.2, 5);
  roverS.head += turn * 1.35 * dt * (roverS.spd >= 0 ? 1 : -1);
  roverS.x += Math.sin(roverS.head) * roverS.spd * dt;
  roverS.z += Math.cos(roverS.head) * roverS.spd * dt;
  roverS.batt = Math.max(0, roverS.batt - Math.abs(roverS.spd) * 0.035 * dt);
  rover.position.set(roverS.x, 0, roverS.z);
  rover.rotation.y = roverS.head;
  /* 轮子转动与轻微俯仰 */
  var spin = roverS.spd * dt * 2.6;
  (rover.userData.wheels || []).forEach(function (w) { w.rotation.z -= spin; });
  var d = 23 * vk();
  aim(roverS.x + Math.sin(roverS.head) * d * 0.55 + Math.cos(roverS.head) * d * 0.75,
    1.9 + d * 0.30,
    roverS.z + Math.cos(roverS.head) * d * 0.55 + Math.sin(roverS.head) * d * 0.75,
    roverS.x, 0.95, roverS.z);
  teleData = [
    ['速度', Math.abs(roverS.spd * 3.6).toFixed(1), 'km/h'],
    ['航向', Math.round((roverS.head * 180 / Math.PI + 360) % 360) + '°', ''],
    ['电量', Math.round(roverS.batt), '%'],
    ['里程', Math.sqrt(roverS.x * roverS.x + roverS.z * roverS.z).toFixed(0), 'm'],
    ['模式', '漫游', ''],
    ['MET', metStr(state.met).slice(0, 5), '']
  ];
}

/* ================= 模式切换 / 主循环 ================= */
function startChapter(i) {
  state.idx = i; state.ct = 0; state.snap = true;
  if (CH[i].met0 !== undefined) state.met = CH[i].met0;
  /* 切章清空日志：否则上一章的日志（尤其是带告警的）会整段带进下一章，
     录制时表现成"再入段面板里全是着陆段的重复行" */
  if (logEl) logEl.innerHTML = '';
  CH[i].setup();
  CH[i]._a = CH[i]._b = CH[i]._c = CH[i]._d = false;
  CH[i]._dock = CH[i]._mid = CH[i]._chk = CH[i]._sep = CH[i]._flag = false;
  CH[i]._flag2 = CH[i]._rock = CH[i]._alsep = CH[i]._re = CH[i]._ch = CH[i]._sp = false;
  CH[i]._touched = false;
  for (var k = 0; k < CH.length; k++) {
    var s = $('seg' + k);
    if (!s) continue;
    s.className = 'seg' + (k === i ? ' on' : (k < i ? ' done' : ''));
    var f = $('fl' + k);
    if (f) f.style.width = '0%';
  }
  $('timeline').classList.toggle('hide', state.mode !== 'auto');
  CH[i].update(0);
}
function setMode(m) {
  state.mode = m; state.run = false; state.ct = 0; state.snap = true;
  if (logEl) logEl.innerHTML = '';
  document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('on', t.dataset.m === m); });
  $('timeline').classList.toggle('hide', m !== 'auto');
  $('thrCtl').classList.toggle('on', m === 'manual');
  if (m === 'auto') startChapter(0);
  else if (m === 'manual') enterManual();
  else if (m === 'abort') enterAbort();
  else if (m === 'rover') enterRover();
  updateHint();
  state.run = true;
  $('play').textContent = (m === 'abort') ? '⚠ 中止' : '⏸ 暂停';
}
function updateHint() {
  var h = {
    auto: '播放沿 7 阶段飞行；点顶部时间线跳转；V 切换视角；空格暂停。',
    manual: '↑↓ 油门，←→ 姿态倾斜；V 切换视角；空格暂停。',
    abort: '下降中按「⚠ 中止」或空格触发上升级逃逸。',
    rover: 'WASD / 方向键驾驶月球车；V 切换视角。'
  };
  $('hint').innerHTML = '<b>操作</b> ' + h[state.mode];
}
function buildTimeline() {
  var tl = $('timeline');
  tl.innerHTML = '';
  CH.forEach(function (c, i) {
    var s = document.createElement('div');
    s.className = 'seg'; s.id = 'seg' + i;
    s.innerHTML = '<div class="fl" id="fl' + i + '"></div><div class="nm">' + (i + 1) + '. ' + c.name + '</div>';
    s.onclick = function () {
      if (state.mode !== 'auto') setMode('auto');
      startChapter(i);
      state.run = true;
      $('play').textContent = '⏸ 暂停';
    };
    tl.appendChild(s);
  });
}

function updateFog() {
  var near = (state.mode === 'manual' || state.mode === 'abort' || state.mode === 'rover')
    || (state.mode === 'auto' && (state.idx === 3 || state.idx === 4 || state.idx === 5));
  var launch = state.mode === 'auto' && state.idx === 0;
  if (launch) {
    /* 发射段：低空用天空近似色收边（否则地面圆盘边缘露出硬边），
       随高度把雾色收到近黑、雾距推到天边 —— 否则 100 km 高空会看到
       一块被浅色雾罩亮的"棕色平板"，一眼假。
       雾距封顶 110 km，必须小于地面圆盘外径 130 km，否则边缘会露出硬线。 */
    var altKm = Math.max(0, saturn.position.y - EARTH_R);
    var k = clamp(altKm / 42, 0, 1);
    sceneFog.color.copy(FOG_GROUND).lerp(FOG_SPACE, k);
    var far = 30 + Math.min(altKm * 40, 80);
    sceneFog.near = far * 0.18;
    sceneFog.far = far;
  } else if (near) {
    sceneFog.color.setHex(0x0c0e12);
    sceneFog.near = 900;
    sceneFog.far = 7000;
  } else {
    sceneFog.color.setHex(0x0b0d11);
    sceneFog.near = 1e7;
    sceneFog.far = 2e7;
  }
}

function updateShadow() {
  var onGround = (state.mode === 'auto' && (state.idx === 3 || state.idx === 4 || state.idx === 5))
    || state.mode === 'manual' || state.mode === 'abort';
  if (!onGround) { lmShadow.visible = false; return; }
  var alt = 0;
  if (state.mode === 'manual' || state.mode === 'abort' || (state.mode === 'auto' && state.idx === 3)) alt = D.alt;
  var k = clamp(1 - alt / 4000, 0, 1);
  lmShadow.visible = true;
  lmShadow.position.set(0, 0.06, 0);
  lmShadow.scale.setScalar(3.6 + 1.8 * k);
  lmShadow.material.opacity = 0.05 + 0.15 * k;
}

function tick(dt) {
  if (!state.run) return;
  var sdt = dt * state.speed;
  dtLast = dt;
  state.met += sdt;
  if (state.mode === 'auto') {
    state.ct += sdt;
    var ch = CH[state.idx];
    if (ch) {
      ch.update(sdt);
      var f = $('fl' + state.idx);
      if (f) {
        var prog = ch.dur > 900 ? (1 - D.alt / 15000) : state.ct / ch.dur;
        f.style.width = clamp(prog * 100, 0, 100) + '%';
      }
      if (state.ct >= ch.dur && state.idx < CH.length - 1 && state.idx !== 3) startChapter(state.idx + 1);
    }
  } else if (state.mode === 'manual') stepManual(sdt);
  else if (state.mode === 'abort') stepAbort(sdt);
  else if (state.mode === 'rover') stepRover(sdt);
  updateShadow();
  updateFog();
}
var last = performance.now();
function loop(now) {
  var dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  dtLast = dt;
  tick(dt);
  $('mt').innerHTML = 'MET <span>' + metStr(state.met) + '</span>';
  renderTele();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

/* ================= 控件 ================= */
$('play').onclick = function () {
  if (state.mode === 'abort') { doAbort(); return; }
  state.run = !state.run;
  $('play').textContent = state.run ? '⏸ 暂停' : '▶ 播放';
};
$('reset').onclick = function () {
  state.run = false;
  logEl.innerHTML = '';
  alarmOff();
  state.met = 0;
  setMode(state.mode);
  state.run = false;
  $('play').textContent = state.mode === 'abort' ? '⚠ 中止' : '▶ 播放';
};
$('speed').oninput = function (e) {
  state.speed = parseFloat(e.target.value);
  $('spd').textContent = state.speed.toFixed(1) + '×';
};
$('thr').oninput = function (e) {
  userThr = parseFloat(e.target.value) / 100;
  $('thrv').textContent = Math.round(userThr * 100) + '%';
};
document.querySelectorAll('.tab').forEach(function (t) { t.onclick = function () { setMode(t.dataset.m); }; });
document.querySelectorAll('.vw button').forEach(function (b) {
  b.onclick = function () {
    state.cam = b.dataset.v;
    document.querySelectorAll('.vw button').forEach(function (x) { x.classList.toggle('on', x === b); });
  };
});
document.querySelectorAll('#ctabs button').forEach(function (b) {
  b.onclick = function () { showCode(b.dataset.k); };
});
window.addEventListener('keydown', function (e) {
  var k = e.key.toLowerCase();
  if (k === 'v') {
    state.cam = state.cam === 'ext' ? 'chase' : state.cam === 'chase' ? 'near' : 'ext';
    document.querySelectorAll('.vw button').forEach(function (x) { x.classList.toggle('on', x.dataset.v === state.cam); });
    return;
  }
  if (state.mode === 'abort' && k === ' ') { e.preventDefault(); doAbort(); return; }
  if (k === ' ') { e.preventDefault(); $('play').click(); return; }
  if (k === 'r') { $('reset').click(); return; }
  if (state.mode === 'manual') {
    if (e.key === 'ArrowUp') { userThr = clamp(userThr + 0.05, 0, 1); $('thr').value = userThr * 100; $('thrv').textContent = Math.round(userThr * 100) + '%'; e.preventDefault(); }
    if (e.key === 'ArrowDown') { userThr = clamp(userThr - 0.05, 0, 1); $('thr').value = userThr * 100; $('thrv').textContent = Math.round(userThr * 100) + '%'; e.preventDefault(); }
    if (e.key === 'ArrowLeft') { D.pitch = clamp(D.pitch + 3.5 * D2R, -25 * D2R, 25 * D2R); e.preventDefault(); }
    if (e.key === 'ArrowRight') { D.pitch = clamp(D.pitch - 3.5 * D2R, -25 * D2R, 25 * D2R); e.preventDefault(); }
  }
  if (state.mode === 'rover') {
    var m = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd' };
    var kk = m[k] || k;
    if ('wasd'.indexOf(kk) >= 0) { keys[kk] = true; e.preventDefault(); }
  }
});
window.addEventListener('keyup', function (e) {
  var k = e.key.toLowerCase();
  var m = { arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd' };
  var kk = m[k] || k;
  keys[kk] = false;
});

/* 触屏方向键：把按住/松开翻译成键盘事件，复用上面同一套逻辑 */
document.querySelectorAll('#touch .tb').forEach(function (btn) {
  var key = btn.dataset.key;
  var press = function (e) {
    e.preventDefault();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true }));
    btn.classList.add('on');
  };
  var release = function (e) {
    e.preventDefault();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: key, bubbles: true }));
    btn.classList.remove('on');
  };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
});

function resize() {
  var w = $('stage').clientWidth, h = $('stage').clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

/* ================= 启动 ================= */
buildTimeline();
resize();
setMode('auto');
state.run = false;
$('play').textContent = '▶ 播放';
log('控制台就绪。选择顶部模式，点「播放」开始（默认 1× 真实节奏，可调速）。');
requestAnimationFrame(loop);

/* 调试钩子（便于排查渲染问题，不影响运行） */
window.__APOLLO = {
  scene: scene, camera: camera, renderer: renderer, stack: stack, lm: lm,
  saturn: saturn, launchSite: launchSite, ground: ground, earth: earth, moon: moon, skyDome: skyDome,
  state: state, CH: CH, D: D, keys: keys, roverS: roverS, abortS: abortS,
  startChapter: startChapter, setMode: setMode, tick: tick,
  stepManual: stepManual, stepAbort: stepAbort, stepRover: stepRover, doAbort: doAbort,
  updateFog: updateFog, updateShadow: updateShadow, hideAll: hideAll, setClip: setClip,
  renderTele: renderTele, aim: aim, vk: vk,
  setThr: function (v) { userThr = v; }, getThr: function () { return userThr; },
  G_MOON: G_MOON, MAXT: MAXT
};
})();
