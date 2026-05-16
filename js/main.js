import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ============================================================
// RENDERER, SCENE, CAMERA
// ============================================================

const canvas = document.getElementById('three-canvas');
const container = document.getElementById('viewport-container');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef2f7);

const camera = new THREE.PerspectiveCamera(
  45,
  container.clientWidth / container.clientHeight,
  0.01,
  100
);
// Vista anterior ligeramente desde arriba
camera.position.set(0, 0.5, 3.5);

// ============================================================
// ILUMINACIÓN
// ============================================================

const ambient = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambient);

const directional = new THREE.DirectionalLight(0xffffff, 1.2);
directional.position.set(5, 10, 7);
scene.add(directional);

const fill = new THREE.DirectionalLight(0xc0d0ff, 0.25);
fill.position.set(-5, 0, -5);
scene.add(fill);

// ============================================================
// ORBIT CONTROLS
// ============================================================

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 1;
controls.maxDistance = 10;
controls.enablePan = false;
controls.target.set(0, 0, 0);
controls.update();

// ============================================================
// ESTADO GLOBAL
// ============================================================

const state = {
  currentMode: 'AL',
  torsoOpacity: 0.7,
  torsoMeshes: [],
  heartModel: null,
  pads: { AL: [], AP: [] },      // parches rojos / naranja
  vectors: { AL: null, AP: null }, // tubos animados
  coverages: { AL: null, AP: null }, // zonas de cobertura
  dsdTimer: 0,
  clock: new THREE.Clock(),
  vectorMaterials: [],
  modeSwitching: false,
};

// ============================================================
// CARGA DE MODELOS — BARRA DE PROGRESO
// ============================================================

const loadingScreen = document.getElementById('loading-screen');
const progressBar   = document.getElementById('progress-bar');
const loadingDetail = document.getElementById('loading-detail');

let torsoLoaded = false;
let heartLoaded = false;

function updateProgress(label, pct) {
  progressBar.style.width = pct + '%';
  loadingDetail.textContent = label;
}

function checkAllLoaded() {
  if (torsoLoaded && heartLoaded) {
    createPads();
    createVectors();
    setMode('ANAT');
    connectUI();
    loadingScreen.classList.add('hidden');
  }
}

const loader = new GLTFLoader();

// --- TORSO ---
updateProgress('Cargando torso…', 5);
loader.load(
  './assets/torso.glb',
  (gltf) => {
    const torso = gltf.scene;

    // Centrar y escalar
    const box = new THREE.Box3().setFromObject(torso);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 2.0 / maxDim; // aprox 2 unidades de alto
    torso.scale.setScalar(scale);
    torso.position.set(-center.x * scale, -center.y * scale, -center.z * scale);

    // Material transparente con vertex colors
    torso.traverse((child) => {
      if (child.isMesh) {
        child.material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          transparent: true,
          opacity: state.torsoOpacity,
          side: THREE.FrontSide,
          depthWrite: false,
        });
        child.renderOrder = 1;
        state.torsoMeshes.push(child);
      }
    });

    scene.add(torso);

    // Guardar bounding box escalada para posicionar corazón
    state.torsoBBox = new THREE.Box3().setFromObject(torso);
    state.torsoSize = state.torsoBBox.getSize(new THREE.Vector3());
    state.torsoCenter = state.torsoBBox.getCenter(new THREE.Vector3());

    torsoLoaded = true;
    updateProgress('Torso cargado ✓', 50);
    checkAllLoaded();
  },
  (progress) => {
    if (progress.total > 0) {
      const pct = 5 + (progress.loaded / progress.total) * 40;
      updateProgress('Cargando torso…', Math.round(pct));
    }
  },
  (err) => {
    console.error('Error cargando torso:', err);
    loadingDetail.textContent = 'Error al cargar torso.glb';
  }
);

// --- CORAZÓN ---
loader.load(
  './assets/heart.glb',
  (gltf) => {
    const heart = gltf.scene;

    // Esperar a que el torso esté listo para posicionar correctamente
    const positionHeart = () => {
      if (!state.torsoBBox) {
        // Torso aún no cargado, reintentar
        setTimeout(positionHeart, 100);
        return;
      }

      const hBox = new THREE.Box3().setFromObject(heart);
      const hSize = hBox.getSize(new THREE.Vector3());
      const hMaxDim = Math.max(hSize.x, hSize.y, hSize.z);

      // El corazón debe ser ~18% del alto del torso
      const desiredHeartHeight = state.torsoSize.y * 0.18;
      const hScale = desiredHeartHeight / hMaxDim;
      heart.scale.setScalar(hScale);

      // Posición anatómica dentro del torso:
      // Hemitórax izquierdo del paciente = X positivo en vista frontal (derecha del espectador)
      // Mediastino: tercio superior del tórax, levemente anterior
      const tc = state.torsoCenter;
      const ts = state.torsoSize;

      heart.position.set(
        tc.x + ts.x * 0.06,   // hemitórax izquierdo, más centrado en mediastino
        tc.y + ts.y * 0.13,   // mediastino medio
        tc.z + ts.z * 0.08    // levemente anterior
      );
      // Rotación Y: positivo = antihorario visto desde arriba (hacia izquierda del espectador)
      //             negativo = horario visto desde arriba (hacia derecha del espectador)
      heart.rotation.y = -Math.PI / 8; // ~-22°: giro leve hacia la derecha del espectador

      // Materiales del corazón: conservar color GLB, añadir renderOrder
      heart.traverse((child) => {
        if (child.isMesh) {
          child.renderOrder = 2;
          if (child.material) {
            child.material.depthWrite = true;
          }
        }
      });

      scene.add(heart);
      state.heartModel = heart;

      // Guardar centro del corazón para las curvas de vectores
      const finalBox = new THREE.Box3().setFromObject(heart);
      state.heartCenter = finalBox.getCenter(new THREE.Vector3());
      state.heartSize = finalBox.getSize(new THREE.Vector3());

      heartLoaded = true;
      updateProgress('Corazón cargado ✓', 90);
      checkAllLoaded();
    };

    positionHeart();
  },
  (progress) => {
    if (progress.total > 0) {
      const pct = 55 + (progress.loaded / progress.total) * 35;
      updateProgress('Cargando corazón…', Math.round(pct));
    }
  },
  (err) => {
    console.error('Error cargando corazón:', err);
    loadingDetail.textContent = 'Error al cargar heart.glb';
  }
);

// ============================================================
// GEOMETRÍA DE PARCHES
// ============================================================

// Geometría de parche rectangular con esquinas redondeadas
function createPadGeometry(width, height, thickness, cornerR) {
  const shape = new THREE.Shape();
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(cornerR, w * 0.4, h * 0.4);

  shape.moveTo(-w + r, -h);
  shape.lineTo( w - r, -h);
  shape.absarc( w - r, -h + r, r, -Math.PI / 2, 0, false);
  shape.lineTo( w,  h - r);
  shape.absarc( w - r,  h - r, r, 0,  Math.PI / 2, false);
  shape.lineTo(-w + r,  h);
  shape.absarc(-w + r,  h - r, r,  Math.PI / 2, Math.PI, false);
  shape.lineTo(-w, -h + r);
  shape.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
  });
  geo.translate(0, 0, -thickness / 2); // centrar en Z
  return geo;
}

function createPads() {
  const tc = state.torsoCenter;
  const ts = state.torsoSize;

  // Parche estándar: ~10 × 13 cm → en unidades de escena (torso ~2u = ~170cm → 1u ≈ 85cm)
  const PAD_W = 0.13;   // ancho
  const PAD_H = 0.17;   // alto
  const PAD_D = 0.012;  // grosor
  const PAD_R = 0.025;  // radio esquinas

  function makePad(color, glowColor) {
    const geo = createPadGeometry(PAD_W, PAD_H, PAD_D, PAD_R);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.35),
      metalness: 0.2,
      roughness: 0.55,
      depthWrite: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;

    // Halo: rectángulo ligeramente mayor
    const haloGeo = createPadGeometry(PAD_W + 0.022, PAD_H + 0.022, PAD_D * 0.5, PAD_R + 0.01);
    const haloMat = new THREE.MeshBasicMaterial({
      color: glowColor,
      transparent: true,
      opacity: 0.30,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.renderOrder = 3;
    mesh.add(halo);

    return mesh;
  }

  // SISTEMA DE COORDENADAS (torso mirando a cámara, vista anterior):
  // X+ = izquierda paciente / X- = derecha paciente
  // Y+ = superior / Z+ = anterior

  // NOTA IMPORTANTE DE ORIENTACIÓN:
  // ExtrudeGeometry crea la forma en el plano XY con la cara apuntando a +Z.
  // Por tanto:
  //   Parche ANTERIOR  → cara ya apunta a +Z (cámara): sin rotación extra, solo tilt fino
  //   Parche LATERAL   → cara debe apuntar a +X (lateral izq): rotation.y = +π/2
  //   Parche POSTERIOR → cara debe apuntar a -Z (espalda):     rotation.y = π  (180°)

  // --- Parches AL (rojos) ---
  // Parche ANTERIOR: hemitórax DERECHO infraclavicular
  const alAnt = makePad(0xef4444, 0xff6666);
  alAnt.position.set(
    tc.x - ts.x * 0.13,
    tc.y + ts.y * 0.18,
    tc.z + ts.z * 0.35
  );
  // Tilt: top hacia atrás (–Z), bottom hacia adelante (+Z)
  alAnt.rotation.x = -Math.PI / 7;

  // Parche LATERAL: axila izquierda, línea media axilar
  const alLat = makePad(0xef4444, 0xff6666);
  alLat.position.set(
    tc.x + ts.x * 0.29,
    tc.y + ts.y * 0.09,
    tc.z + ts.z * 0.08
  );
  // Cara del parche apunta hacia el lateral izquierdo del paciente (+X)
  alLat.rotation.y = Math.PI / 2;

  state.pads.AL.push(alAnt, alLat);
  scene.add(alAnt, alLat);

  // --- Parches AP (naranja) ---
  // Parche ANTERIOR: paraesternal izquierdo, 3-4 EIC
  const apAnt = makePad(0xf97316, 0xffaa44);
  apAnt.position.set(
    tc.x + ts.x * 0.08,
    tc.y + ts.y * 0.18,
    tc.z + ts.z * 0.36
  );
  apAnt.rotation.x = -Math.PI / 7;

  // Parche POSTERIOR: infraescapular izquierdo — cara apunta hacia -Z (espalda)
  const apPost = makePad(0xf97316, 0xffaa44);
  apPost.position.set(
    tc.x + ts.x * 0.10,
    tc.y + ts.y * 0.12,
    tc.z - ts.z * 0.46
  );
  apPost.rotation.y = Math.PI;
  apPost.rotation.x = -Math.PI / 10; // top hacia atrás, bottom hacia adelante // cara hacia la espalda (-Z)

  state.pads.AP.push(apAnt, apPost);
  scene.add(apAnt, apPost);
}

// ============================================================
// MATERIAL DE VECTOR (SHADER ANIMADO)
// ============================================================

// speed: velocidad de la animación de flujo (refleja la corriente: mayor corriente = más rápido)
function createVectorMaterial(color, speed = 2.0) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      time:    { value: 0 },
      color:   { value: new THREE.Color(color) },
      opacity: { value: 0.9 },
      speed:   { value: speed },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform vec3 color;
      uniform float opacity;
      uniform float speed;
      varying vec2 vUv;
      void main() {
        float flow = fract(vUv.x * 3.0 - time * speed);
        float pulse = smoothstep(0.0, 0.2, flow) * smoothstep(0.5, 0.3, flow);
        float glow = 0.3 + 0.7 * pulse;
        gl_FragColor = vec4(color * glow, opacity * (0.4 + 0.6 * pulse));
      }
    `,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  state.vectorMaterials.push(mat);
  return mat;
}

// ============================================================
// CREACIÓN DE VECTORES Y ZONAS DE COBERTURA
// ============================================================

function createVectors() {
  const hc = state.heartCenter;
  const hs = state.heartSize;
  const tc = state.torsoCenter;
  const ts = state.torsoSize;

  // Posiciones de parches — deben coincidir exactamente con createPads()
  const alAntPos = new THREE.Vector3(
    tc.x - ts.x * 0.13, tc.y + ts.y * 0.18, tc.z + ts.z * 0.35
  );
  const alLatPos = new THREE.Vector3(
    tc.x + ts.x * 0.29, tc.y + ts.y * 0.09, tc.z + ts.z * 0.08
  );
  const apAntPos = new THREE.Vector3(
    tc.x + ts.x * 0.08, tc.y + ts.y * 0.18, tc.z + ts.z * 0.36
  );
  const apPostPos = new THREE.Vector3(
    tc.x + ts.x * 0.10, tc.y + ts.y * 0.12, tc.z - ts.z * 0.46
  );

  // --- Vector AL: de infraclavicular-derecho (X neg) a axilar-izquierdo (X pos)
  //     Trayectoria oblicua: entra por base superior derecha del corazón, cruza hacia ápex-lateral
  const alCurve = new THREE.CatmullRomCurve3([
    alAntPos,
    new THREE.Vector3(hc.x - hs.x * 0.2, hc.y + hs.y * 0.35, hc.z + hs.z * 0.3),
    hc.clone(), // centro del corazón
    new THREE.Vector3(hc.x + hs.x * 0.3, hc.y - hs.y * 0.2, hc.z + hs.z * 0.1),
    alLatPos,
  ]);
  const alTubeGeo = new THREE.TubeGeometry(alCurve, 60, 0.009, 8, false);
  const alMat = createVectorMaterial(0xef4444, 2.0);
  const alTube = new THREE.Mesh(alTubeGeo, alMat);
  alTube.renderOrder = 4;
  scene.add(alTube);
  state.vectors.AL = alTube;

  // --- Vector AP: de anterior-izquierdo a posterior-izquierdo, trayectoria sagital
  //     Atraviesa pared anterior VI → tabique → pared posterior VI
  const apCurve = new THREE.CatmullRomCurve3([
    apAntPos,
    new THREE.Vector3(hc.x + hs.x * 0.1, hc.y + hs.y * 0.15, hc.z + hs.z * 0.5),
    hc.clone(),
    new THREE.Vector3(hc.x + hs.x * 0.1, hc.y - hs.y * 0.05, hc.z - hs.z * 0.5),
    apPostPos,
  ]);
  const apTubeGeo = new THREE.TubeGeometry(apCurve, 60, 0.009, 8, false);
  const apMat = createVectorMaterial(0xf97316, 2.0);
  const apTube = new THREE.Mesh(apTubeGeo, apMat);
  apTube.renderOrder = 4;
  scene.add(apTube);
  state.vectors.AP = apTube;

  // --- Zonas de cobertura sobre el corazón ---
  createCoverageZones();
}

function createCoverageZones() {
  const hc = state.heartCenter;
  const hs = state.heartSize;

  // AL: zona anterior-lateral → esfera aplanada en cara anterior-lateral
  const alCovGeo = new THREE.SphereGeometry(hs.x * 0.55, 16, 12, 0, Math.PI * 1.4, 0, Math.PI);
  const alCovMat = new THREE.MeshBasicMaterial({
    color: 0xef4444,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const alCov = new THREE.Mesh(alCovGeo, alCovMat);
  alCov.position.set(
    hc.x,
    hc.y - hs.y * 0.12,   // bajado para incluir el ápex
    hc.z + hs.z * 0.12    // desplazado anterior: cubre pared anterior y VD, no pared posterior
  );
  alCov.scale.set(1, 0.85, 0.7);
  alCov.rotation.y = Math.PI * 0.15;
  alCov.renderOrder = 4;
  scene.add(alCov);
  state.coverages.AL = alCov;

  // AP: esfera completa — cubre pared posterior, tabique Y pared anterior del VI
  const apCovGeo = new THREE.SphereGeometry(hs.x * 0.55, 16, 12);
  const apCovMat = new THREE.MeshBasicMaterial({
    color: 0xf97316,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const apCov = new THREE.Mesh(apCovGeo, apCovMat);
  apCov.position.set(
    hc.x,
    hc.y - hs.y * 0.12,
    hc.z
  );
  apCov.scale.set(0.68, 0.70, 1.05); // más estrecho lateralmente y en el ápex, elongado AP
  apCov.renderOrder = 4;
  scene.add(apCov);
  state.coverages.AP = apCov;
}

// ============================================================
// GESTIÓN DE MODOS
// ============================================================

function setMode(mode, skipTransition = false) {
  if (state.modeSwitching && !skipTransition) return;
  state.modeSwitching = true;
  state.currentMode = mode;

  // Actualizar botones UI
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // Transición: fade out rápido → actualizar → fade in
  const fadeMs = skipTransition ? 0 : 200;

  setTimeout(() => {
    applyMode(mode);
    updateClinicalInfo(mode);
    state.dsdTimer = 0;
    state.modeSwitching = false;
  }, fadeMs);
}

function applyMode(mode) {
  const showAL  = (mode === 'AL' || mode === 'DSD');
  const showAP  = (mode === 'AP' || mode === 'DSD');
  const anatomy = (mode === 'ANAT');

  // Parches
  state.pads.AL.forEach(p => { p.visible = showAL && !anatomy; });
  state.pads.AP.forEach(p => { p.visible = showAP && !anatomy; });

  // Vectores
  state.vectors.AL.visible = showAL && !anatomy;
  state.vectors.AP.visible = showAP && !anatomy;

  // Coberturas
  state.coverages.AL.visible = showAL && !anatomy;
  state.coverages.AP.visible = showAP && !anatomy;

  // En modo DSD: AP empieza invisible y aparece tras 500ms
  if (mode === 'DSD') {
    state.vectors.AP.visible = false;
    state.pads.AP.forEach(p => { p.visible = false; });
    state.coverages.AP.visible = false;
  }
}

// ============================================================
// PANEL DE INFORMACIÓN CLÍNICA
// ============================================================

function updateClinicalInfo(mode) {
  document.querySelectorAll('.info-content').forEach(el => {
    el.classList.remove('active');
    el.style.display = 'none';
  });
  const target = document.getElementById('info-' + mode);
  if (target) {
    target.style.display = 'block';
    // Forzar reflow para que la transición de opacity funcione
    target.offsetHeight;
    target.classList.add('active');
  }
}

// ============================================================
// EVENTOS DE UI
// ============================================================

function connectUI() {
  // Botones de modo
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode !== state.currentMode) {
        setMode(btn.dataset.mode);
      }
    });
  });

  // Slider de opacidad
  const slider = document.getElementById('torsoOpacity');
  const opacityLabel = document.getElementById('opacityValue');
  slider.addEventListener('input', () => {
    const val = parseFloat(slider.value) / 100;
    state.torsoOpacity = val;
    opacityLabel.textContent = slider.value + '%';
    state.torsoMeshes.forEach(mesh => {
      mesh.material.opacity = val;
    });
  });

  // Resize
  window.addEventListener('resize', onResize);
}

function onResize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ============================================================
// ANIMACIÓN DSD (secuencial: AL → 500ms → AP)
// ============================================================

function updateDSD(delta) {
  if (state.currentMode !== 'DSD') return;

  state.dsdTimer += delta;

  const cycleDuration = 3.0;
  const t = state.dsdTimer % cycleDuration;

  // AL: visible desde t=0
  const alVisible = true;
  // AP: visible desde t=0.5s
  const apVisible = t >= 0.5;

  state.vectors.AL.visible = alVisible;
  state.coverages.AL.visible = alVisible;
  state.pads.AL.forEach(p => { p.visible = alVisible; });

  state.vectors.AP.visible = apVisible;
  state.coverages.AP.visible = apVisible;
  state.pads.AP.forEach(p => { p.visible = apVisible; });

  // Opacidad del vector AP: fade in entre 0.5 y 0.8s
  if (apVisible) {
    const fadeT = Math.min((t - 0.5) / 0.3, 1.0);
    state.vectors.AP.material.uniforms.opacity.value = 0.9 * fadeT;
  }
}

// ============================================================
// RENDER LOOP
// ============================================================

function animate() {
  requestAnimationFrame(animate);
  const delta = state.clock.getDelta();
  const elapsed = state.clock.getElapsedTime();

  controls.update();

  // Actualizar time en shaders de vectores
  state.vectorMaterials.forEach(mat => {
    mat.uniforms.time.value = elapsed;
  });

  // Animación DSD
  updateDSD(delta);

  renderer.render(scene, camera);
}

animate();
