/**
 * anatomy-3d.js — Three.js 3D lung anatomy model renderer
 * =========================================================
 * Loads a GLB lung anatomy model from GCS and renders it on a
 * canvas layered over the surgical video. Transparent background
 * so the surgical view shows through.
 *
 * Public API (called by app.js dispatchRenderCommand):
 *   Anatomy3D.init(config)
 *   Anatomy3D.rotate(axis, degrees)
 *   Anatomy3D.toggleStructure(structureName, visible)
 *   Anatomy3D.reset()
 *   Anatomy3D.hide()
 *
 * IMPORTANT — mesh names:
 *   After loading the model, all mesh names are logged to the console.
 *   Update the toggle_structure docstring in tools.py to use the exact
 *   names that appear. The names listed here ('parenchyma', 'tumor', etc.)
 *   are defaults — they MUST match your specific GLB file.
 */

'use strict';

const Anatomy3D = (() => {

  // ── State ────────────────────────────────────────────────────────────────
  let renderer  = null;
  let scene     = null;
  let camera    = null;
  let model     = null;
  let canvas    = null;
  let animFrame = null;

  // Map of lowercased mesh name → Three.js Mesh object
  // Populated after model loads via traverse()
  const structures = {};


  // ── Initialisation ───────────────────────────────────────────────────────

  /**
   * @param {Object} config
   * @param {string} config.canvasId  - DOM id of the AR canvas element
   * @param {string} config.modelUrl  - public GCS URL to lung_model.glb
   */
  function init(config) {
    canvas = document.getElementById(config.canvasId);

    // Renderer with alpha so Three.js background is transparent
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0);  // fully transparent background

    scene = new THREE.Scene();

    // Camera
    const aspect = canvas.offsetWidth / (canvas.offsetHeight || 1);
    camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100);
    camera.position.set(0, 0, 3);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(5, 10, 7.5);
    scene.add(dirLight);

    // Resize handler
    _resizeRenderer();
    window.addEventListener('resize', _resizeRenderer);

    // Load the GLB model
    _loadModel(config.modelUrl);

    // Start render loop
    _renderLoop();
  }

  function _resizeRenderer() {
    if (!renderer || !canvas) return;
    const w = canvas.offsetWidth  || canvas.parentElement.offsetWidth;
    const h = canvas.offsetHeight || canvas.parentElement.offsetHeight;
    renderer.setSize(w, h, false);
    if (camera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  function _loadModel(url) {
    const loader = new THREE.GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        model = gltf.scene;
        scene.add(model);

        // Centre and scale the model
        const box = new THREE.Box3().setFromObject(model);
        const centre = box.getCenter(new THREE.Vector3());
        const size   = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        model.position.sub(centre);
        model.scale.setScalar(2 / maxDim);

        // Build structure map and log mesh names for tools.py calibration
        console.log('[Anatomy3D] Loaded model. Mesh names:');
        model.traverse((child) => {
          if (child.isMesh) {
            const lowerName = child.name.toLowerCase();
            structures[lowerName] = child;
            console.log('  mesh:', child.name, '→ key:', lowerName);
          }
        });
        console.log('[Anatomy3D] Update toggle_structure docstring in tools.py with these names.');
      },
      undefined,  // progress callback (not needed)
      (err) => {
        console.error('[Anatomy3D] Failed to load model:', err);
      }
    );
  }

  function _renderLoop() {
    animFrame = requestAnimationFrame(_renderLoop);
    if (renderer && scene && camera) {
      renderer.render(scene, camera);
    }
  }


  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Rotates the model to a specific absolute angle on the given axis.
   * @param {'x'|'y'|'z'} axis
   * @param {number} degrees
   */
  function rotate(axis, degrees) {
    if (!model) return;
    _show();
    axis = axis.toLowerCase();
    if (!['x', 'y', 'z'].includes(axis)) return;
    model.rotation[axis] = THREE.MathUtils.degToRad(degrees);
  }

  /**
   * Shows or hides a named mesh structure.
   * structureName must match a key in the `structures` map (lowercased).
   * @param {string} structureName
   * @param {boolean} visible
   */
  function toggleStructure(structureName, visible) {
    _show();
    const key = structureName.toLowerCase().trim();
    const mesh = structures[key];
    if (mesh) {
      mesh.visible = visible;
    } else {
      console.warn('[Anatomy3D] toggleStructure: unknown structure:', structureName);
      console.log('[Anatomy3D] Available structures:', Object.keys(structures));
    }
  }

  /**
   * Resets model to default orientation and makes all structures visible.
   */
  function reset() {
    if (!model) return;
    _show();
    model.rotation.set(0, 0, 0);
    Object.values(structures).forEach((mesh) => { mesh.visible = true; });
  }

  /**
   * Hides the AR canvas entirely.
   */
  function hide() {
    if (canvas) canvas.style.display = 'none';
  }

  function _show() {
    if (canvas) canvas.style.display = 'block';
  }


  // ── Public interface ──────────────────────────────────────────────────────
  return { init, rotate, toggleStructure, reset, hide };

})();
