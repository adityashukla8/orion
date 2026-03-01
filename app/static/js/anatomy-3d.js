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
  let modal     = null;   // parent .overlay-modal wrapper
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
    modal  = canvas.closest('.tile-panel');

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
    const w = canvas.offsetWidth  || canvas.parentElement.offsetWidth  || 400;
    const h = canvas.offsetHeight || canvas.parentElement.offsetHeight || 300;
    console.log('[Anatomy3D] resize → canvas', w, '×', h);
    renderer.setSize(w, h, false);
    if (camera) {
      camera.aspect = w / (h || 1);
      camera.updateProjectionMatrix();
    }
  }

  function _loadModel(url) {
    console.log('[Anatomy3D] fetching:', url);
    const loader = new THREE.GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        console.log('[Anatomy3D] GLB loaded. Scene children:', gltf.scene.children.length);
        model = gltf.scene;
        scene.add(model);

        // Step 1: measure raw bounding box (vertices in mm)
        const rawBox  = new THREE.Box3().setFromObject(model);
        const rawSize = rawBox.getSize(new THREE.Vector3());
        const maxDim  = Math.max(rawSize.x, rawSize.y, rawSize.z);
        console.log('[Anatomy3D] raw bbox size:', rawSize, 'maxDim:', maxDim.toFixed(1), 'mm');

        // Step 2: scale to 2 Three.js units FIRST
        model.scale.setScalar(2 / maxDim);

        // Step 3: recompute bbox in scaled space, then centre
        const scaledBox    = new THREE.Box3().setFromObject(model);
        const scaledCentre = scaledBox.getCenter(new THREE.Vector3());
        model.position.sub(scaledCentre);
        console.log('[Anatomy3D] scaled centre (should be ~0):', scaledCentre);

        // Step 4: auto-position camera so model fills ~60% of view
        const scaledSize   = scaledBox.getSize(new THREE.Vector3());
        const scaledMaxDim = Math.max(scaledSize.x, scaledSize.y, scaledSize.z);
        const camDist = scaledMaxDim / (2 * Math.tan(THREE.MathUtils.degToRad(22.5)));
        camera.position.set(0, 0, camDist * 1.4);
        camera.near  = camDist * 0.01;
        camera.far   = camDist * 10;
        camera.lookAt(new THREE.Vector3(0, 0, 0));
        camera.updateProjectionMatrix();
        console.log('[Anatomy3D] camDist:', camDist.toFixed(2), ' near/far:', camera.near.toFixed(3), camera.far.toFixed(1));

        // Step 5: fix materials — DoubleSide prevents back-face culling from
        // axis remap; opaque avoids transparent-mesh depth-sort blanks.
        let meshCount = 0;
        model.traverse((child) => {
          if (child.isMesh && child.material) {
            child.material.side        = THREE.DoubleSide;
            child.material.transparent = false;
            child.material.depthWrite  = true;
            child.material.needsUpdate = true;
            meshCount++;
          }
        });
        console.log('[Anatomy3D] patched', meshCount, 'materials');

        // Step 6: build structure map
        model.traverse((child) => {
          if (child.isMesh) {
            const key = child.name.toLowerCase();
            structures[key] = child;
            console.log('  mesh name:', JSON.stringify(child.name), '→ key:', JSON.stringify(key));
          }
        });
        console.log('[Anatomy3D] structures ready:', Object.keys(structures));
      },
      undefined,
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
   * Hides the AR modal.
   */
  function hide() {
    if (modal) { modal.classList.remove('visible'); window.ORION_relayoutModals?.(); }
  }

  function _show() {
    if (modal) {
      modal.classList.add('visible');
      window.ORION_relayoutModals?.();
      // Re-sync renderer size after modal is repositioned by relayout
      requestAnimationFrame(_resizeRenderer);
    }
  }


  // ── Public interface ──────────────────────────────────────────────────────
  return { init, rotate, toggleStructure, reset, hide };

})();
