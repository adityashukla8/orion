/**
 * ct-viewer.js — CT scan slice overlay renderer
 * ===============================================
 * Renders CT PNG slices from GCS onto a canvas element layered
 * over the surgical video. Maintains current slice state internally.
 *
 * Public API (called by app.js dispatchRenderCommand):
 *   CTViewer.init(config)
 *   CTViewer.navigate(direction, count)
 *   CTViewer.jumpToLandmark(landmark)
 *   CTViewer.hide()
 */

'use strict';

const CTViewer = (() => {

  // ── State ────────────────────────────────────────────────────────────────
  let canvas      = null;
  let ctx         = null;
  let modal       = null;   // parent .overlay-modal wrapper
  let gcsBase     = '';
  let ctPath      = '';
  let totalSlices = 350;
  let currentSlice = 67;   // start at mid-chest (~carina level)

  // Must match CT_LANDMARKS in tools.py exactly (same slice numbers).
  // Calibrated to LIDC-IDRI-0001: 133 slices, 2.5mm spacing, z=-340→-10mm.
  const LANDMARKS = {
    'diaphragm':   11,
    'tumor':       29,
    'carina':      69,
    'bronchus':    65,
    'aortic_arch': 81,
    'clavicle':   115,
  };


  // ── Initialisation ───────────────────────────────────────────────────────

  /**
   * @param {Object} config
   * @param {string} config.canvasId       - DOM id of the CT canvas element
   * @param {string} config.gcsBase        - GCS public HTTPS base URL
   * @param {string} config.ctPath         - path inside bucket: e.g. 'ct/case_demo_001'
   * @param {number} config.totalSlices    - total number of PNG slices
   */
  function init(config) {
    canvas      = document.getElementById(config.canvasId);
    ctx         = canvas.getContext('2d');
    modal       = canvas.closest('.overlay-modal');
    gcsBase     = config.gcsBase;
    ctPath      = config.ctPath;
    totalSlices = config.totalSlices || 350;

    // Size canvas to match its modal body (modal is in layout even when opacity:0)
    _resizeCanvas();
    window.addEventListener('resize', _resizeCanvas);
  }

  function _resizeCanvas() {
    if (!canvas) return;
    canvas.width  = canvas.offsetWidth  || canvas.parentElement.offsetWidth;
    canvas.height = canvas.offsetHeight || canvas.parentElement.offsetHeight;
  }


  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Moves the current slice by `count` steps in `direction`.
   * @param {'prev'|'next'} direction
   * @param {number} count
   */
  function navigate(direction, count) {
    count = parseInt(count, 10) || 1;
    if (direction === 'prev') {
      currentSlice = Math.max(1, currentSlice - count);
    } else {
      currentSlice = Math.min(totalSlices, currentSlice + count);
    }
    _loadAndDraw(currentSlice);
  }

  /**
   * Jumps to the slice number corresponding to a named landmark.
   * @param {string} landmark - must match a key in LANDMARKS
   */
  function jumpToLandmark(landmark) {
    const key = landmark.toLowerCase().replace(/ /g, '_');
    const slice = LANDMARKS[key];
    if (!slice) {
      console.warn('CTViewer: unknown landmark', landmark);
      return;
    }
    currentSlice = slice;
    _loadAndDraw(currentSlice, landmark);
  }

  /**
   * Hides the CT modal.
   */
  function hide() {
    if (modal) { modal.classList.remove('visible'); window.ORION_relayoutModals?.(); }
  }


  // ── Rendering ─────────────────────────────────────────────────────────────

  /**
   * Constructs the GCS URL for a slice, loads it as an Image,
   * and draws it onto the canvas with semi-transparency.
   */
  function _loadAndDraw(sliceNum, landmarkLabel) {
    if (!canvas || !ctx) return;

    // Zero-pad slice number to 3 digits: 1 → '001'
    const padded = String(sliceNum).padStart(3, '0');
    const url = `${gcsBase}/${ctPath}/${padded}.png`;

    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      _resizeCanvas();

      // Show the modal
      if (modal) { modal.classList.add('visible'); window.ORION_relayoutModals?.(); }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1.0;

      _drawLabel(sliceNum, landmarkLabel);
    };

    img.onerror = () => {
      console.error('CTViewer: failed to load slice', url);
      // Draw error state on canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ef9a9a';
      ctx.font = '14px monospace';
      ctx.fillText(`CT slice ${sliceNum} not found`, 20, 40);
    };

    img.src = url;
  }

  /**
   * Draws slice number and optional landmark label onto the canvas.
   */
  function _drawLabel(sliceNum, landmarkLabel) {
    const pad = 14;

    ctx.font = "600 11px 'Poppins', sans-serif";
    ctx.textBaseline = 'top';

    // Slice counter — top-right
    const sliceText = `SLICE ${sliceNum} / ${totalSlices}`;
    const sliceW = ctx.measureText(sliceText).width;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(canvas.width - sliceW - pad * 2 - 4, pad - 4, sliceW + 8, 20);
    ctx.fillStyle = '#1a4e80';
    ctx.fillText(sliceText, canvas.width - sliceW - pad - 4, pad);

    // Landmark label — below slice counter
    if (landmarkLabel) {
      const label = landmarkLabel.toUpperCase().replace(/_/g, ' ');
      const labelW = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(canvas.width - labelW - pad * 2 - 4, pad + 24, labelW + 8, 20);
      ctx.fillStyle = '#2a6090';
      ctx.fillText(label, canvas.width - labelW - pad - 4, pad + 24);
    }
  }


  // ── Public interface ──────────────────────────────────────────────────────
  return { init, navigate, jumpToLandmark, hide };

})();
