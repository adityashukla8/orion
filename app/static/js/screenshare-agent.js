/**
 * screenshare-agent.js
 * ====================
 * Screen capture module for ORION's Screen_Advisor agent.
 *
 * Captures the surgeon's FULL SCREEN at 1 FPS and sends JPEG frames over the
 * existing WebSocket connection as JSON: { type: 'image_frame', data: <base64> }
 *
 * The server's upstream_task() handles this message type and forwards decoded
 * JPEG bytes to Gemini via send_realtime(Blob('image/jpeg', ...)).
 *
 * Activation is system-managed — driven by _activeAgent in app.js, NOT by
 * model tool calls. getDisplayMedia() is requested once per session; subsequent
 * activations reuse the existing MediaStream (no repeated permission dialogs).
 *
 * Public API:
 *   ScreenshareAgent.activate(ws)  — start sending frames; requests permission on first call only
 *   ScreenshareAgent.deactivate()  — stop sending frames; keep MediaStream alive for reuse
 *   ScreenshareAgent.teardown()    — full stop; release MediaStream (call on WS disconnect)
 *   ScreenshareAgent.isActive()    — returns bool (currently sending frames)
 */

const ScreenshareAgent = (() => {
  // --- Config ---
  const FRAME_INTERVAL_MS = 1000;   // 1 FPS — Gemini Live API limit
  const CANVAS_SIZE       = 768;    // 768×768 px as recommended by ADK docs
  const JPEG_QUALITY      = 0.82;   // balance quality vs. payload size

  // --- State ---
  let _stream     = null;   // MediaStream from getDisplayMedia (kept alive between activations)
  let _video      = null;   // offscreen <video> element
  let _canvas     = null;   // offscreen <canvas> for frame extraction
  let _ctx        = null;   // 2D canvas context
  let _intervalId = null;   // setInterval handle
  let _ws         = null;   // WebSocket reference
  let _active     = false;  // currently sending frames

  // --- Border element ---
  const BORDER_ID = 'screenshare-border';

  function _setBorder(on) {
    const el = document.getElementById(BORDER_ID);
    if (el) el.classList.toggle('active', on);
  }

  /**
   * Start sending frames to Gemini. Requests getDisplayMedia() only on the
   * first call per session; subsequent calls reuse the existing _stream.
   * @param {WebSocket} ws — the open ORION WebSocket connection
   */
  async function activate(ws) {
    if (_active) return;   // already sending
    _ws = ws;

    if (!_stream) {
      // First activation this session — request screen capture permission
      try {
        _stream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'always', frameRate: { ideal: 1, max: 1 } },
          audio: false,
        });
      } catch (err) {
        console.warn('[ScreenshareAgent] getDisplayMedia denied or cancelled:', err);
        document.dispatchEvent(new CustomEvent('screenshare:error', { detail: err }));
        return;
      }

      // If the user clicks "Stop sharing" in the browser's native UI, full teardown
      _stream.getVideoTracks()[0].addEventListener('ended', () => {
        console.log('[ScreenshareAgent] Browser stop-sharing button clicked');
        teardown();
      });

      // Build offscreen video + canvas (only once, reused across activations)
      _video = document.createElement('video');
      _video.srcObject = _stream;
      _video.muted = true;
      await _video.play();

      _canvas = document.createElement('canvas');
      _canvas.width  = CANVAS_SIZE;
      _canvas.height = CANVAS_SIZE;
      _ctx = _canvas.getContext('2d');

      document.dispatchEvent(new CustomEvent('screenshare:started'));
    }

    // Resume (or begin) frame sending
    _active = true;
    _setBorder(true);
    _captureFrame();   // send first frame immediately
    _intervalId = setInterval(_captureFrame, FRAME_INTERVAL_MS);
  }

  /**
   * Stop sending frames but keep the MediaStream alive.
   * Next activate() call will resume instantly without a permission dialog.
   */
  function deactivate() {
    if (!_active) return;
    clearInterval(_intervalId);
    _intervalId = null;
    _active = false;
    _setBorder(false);
    // _stream, _video, _canvas intentionally kept alive
  }

  /**
   * Full stop: release the MediaStream and all resources.
   * Call when the WebSocket disconnects or the user explicitly ends vision mode.
   */
  function teardown() {
    deactivate();
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
    document.dispatchEvent(new CustomEvent('screenshare:stopped'));
  }

  /**
   * Capture a single frame, encode as JPEG, and send over WebSocket.
   */
  function _captureFrame() {
    if (!_active || !_video || !_ctx || !_ws) return;
    if (_ws.readyState !== WebSocket.OPEN) return;

    const vw = _video.videoWidth  || CANVAS_SIZE;
    const vh = _video.videoHeight || CANVAS_SIZE;
    const scale = Math.min(CANVAS_SIZE / vw, CANVAS_SIZE / vh);
    const dw = vw * scale, dh = vh * scale;
    const dx = (CANVAS_SIZE - dw) / 2, dy = (CANVAS_SIZE - dh) / 2;

    _ctx.fillStyle = '#000';
    _ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    _ctx.drawImage(_video, dx, dy, dw, dh);

    const base64 = _canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',', 2)[1];
    if (!base64) return;
    _ws.send(JSON.stringify({ type: 'image_frame', data: base64 }));
  }

  function isActive() { return _active; }

  return { activate, deactivate, teardown, isActive };
})();
