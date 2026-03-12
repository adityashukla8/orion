/**
 * screenshare-agent.js
 * ====================
 * Screen capture module for ORION's Screen_Advisor agent.
 *
 * Captures the surgeon's screen at 1 FPS and sends JPEG frames over the
 * existing WebSocket connection as JSON: { type: 'image_frame', data: <base64> }
 *
 * The server's upstream_task() already handles this message type and forwards
 * the decoded JPEG bytes to Gemini via send_realtime(Blob('image/jpeg', ...)).
 *
 * Public API:
 *   ScreenshareAgent.start(ws)   — request screen share + begin frame loop
 *   ScreenshareAgent.stop()      — stop frame loop + release MediaStream
 *   ScreenshareAgent.isActive()  — returns bool
 */

const ScreenshareAgent = (() => {
  // --- Config ---
  const FRAME_INTERVAL_MS = 1000;   // 1 FPS — Gemini Live API limit
  const CANVAS_SIZE       = 768;    // 768×768 px as recommended by ADK docs
  const JPEG_QUALITY      = 0.82;   // balance quality vs. payload size

  // --- State ---
  let _stream     = null;   // MediaStream from getDisplayMedia
  let _video      = null;   // offscreen <video> element
  let _canvas     = null;   // offscreen <canvas> for frame extraction
  let _ctx        = null;   // 2D canvas context
  let _intervalId = null;   // setInterval handle
  let _ws         = null;   // WebSocket reference
  let _active     = false;

  // --- Border element ---
  const BORDER_ID = 'screenshare-border';

  function _setBorder(active) {
    const el = document.getElementById(BORDER_ID);
    if (!el) return;
    if (active) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  }

  /**
   * Request screen capture via getDisplayMedia and begin sending frames.
   * @param {WebSocket} ws — the open ORION WebSocket connection
   */
  async function start(ws) {
    if (_active) return;   // idempotent

    _ws = ws;

    // Request screen / window / tab share from the browser
    try {
      _stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          frameRate: { ideal: 1, max: 1 },
        },
        audio: false,
      });
    } catch (err) {
      console.warn('[ScreenshareAgent] getDisplayMedia denied or cancelled:', err);
      // Notify app.js so it can update UI state
      document.dispatchEvent(new CustomEvent('screenshare:error', { detail: err }));
      return;
    }

    // If the user stops sharing via the browser's built-in "Stop sharing" button,
    // mirror that into ORION's state.
    _stream.getVideoTracks()[0].addEventListener('ended', () => {
      console.log('[ScreenshareAgent] Screen share ended by user (browser stop button)');
      stop();
    });

    // Build an offscreen video element to drive the canvas
    _video = document.createElement('video');
    _video.srcObject = _stream;
    _video.muted = true;
    await _video.play();

    // Build an offscreen canvas for frame extraction
    _canvas = document.createElement('canvas');
    _canvas.width  = CANVAS_SIZE;
    _canvas.height = CANVAS_SIZE;
    _ctx = _canvas.getContext('2d');

    _active = true;
    _setBorder(true);
    document.dispatchEvent(new CustomEvent('screenshare:started'));

    // Begin frame capture loop
    _intervalId = setInterval(_captureFrame, FRAME_INTERVAL_MS);

    // Send first frame immediately (don't wait 1 second for the first visual)
    _captureFrame();
  }

  /**
   * Stop the frame loop and release the MediaStream.
   */
  function stop() {
    if (!_active) return;

    clearInterval(_intervalId);
    _intervalId = null;

    if (_stream) {
      _stream.getTracks().forEach(t => t.stop());
      _stream = null;
    }

    if (_video) {
      _video.srcObject = null;
      _video = null;
    }

    _canvas = null;
    _ctx    = null;
    _ws     = null;
    _active = false;

    _setBorder(false);
    document.dispatchEvent(new CustomEvent('screenshare:stopped'));
  }

  /**
   * Capture a single frame, encode as JPEG, and send over WebSocket.
   */
  function _captureFrame() {
    if (!_active || !_video || !_ctx || !_ws) return;
    if (_ws.readyState !== WebSocket.OPEN) return;

    // Draw current video frame, letterboxed into the square canvas
    const vw = _video.videoWidth  || CANVAS_SIZE;
    const vh = _video.videoHeight || CANVAS_SIZE;
    const scale = Math.min(CANVAS_SIZE / vw, CANVAS_SIZE / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (CANVAS_SIZE - dw) / 2;
    const dy = (CANVAS_SIZE - dh) / 2;

    _ctx.fillStyle = '#000';
    _ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    _ctx.drawImage(_video, dx, dy, dw, dh);

    // Encode as JPEG (base64 data URL) and strip the header prefix
    const dataUrl = _canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const base64  = dataUrl.split(',', 2)[1];

    if (!base64) return;

    _ws.send(JSON.stringify({ type: 'image_frame', data: base64 }));
  }

  function isActive() {
    return _active;
  }

  return { start, stop, isActive };
})();
