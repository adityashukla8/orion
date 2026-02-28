/**
 * app.js — ORION WebSocket client and event router
 * =================================================
 * ES module — loaded with <script type="module"> in index.html.
 *
 * Responsibilities:
 *   1. Manages WebSocket connection lifecycle
 *   2. Starts audio I/O via bidi-demo AudioWorklet functions
 *   3. Starts surgical video frame capture (1 fps)
 *   4. Receives ADK event JSON from server, dispatches to display modules
 */

import { startAudioPlayerWorklet } from './audio-player.js';
import { startAudioRecorderWorklet, stopMicrophone } from './audio-recorder.js';

// ── Configuration ──────────────────────────────────────────────────────────
const CONFIG = Object.assign({
  gcsBucket:     'orion-assets-2026',
  ctPath:        'ct/case_demo_001',
  ctTotalSlices: 133,
  modelPath:     'models/lung_model.glb',
  videoPath:     'video/surgical_video.mp4',
}, window.ORION_CONFIG || {});

const GCS_BASE = `https://storage.googleapis.com/${CONFIG.gcsBucket}`;

// ── DOM references ─────────────────────────────────────────────────────────
const connectBtn    = document.getElementById('connect-btn');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const micIndicator  = document.getElementById('mic-indicator');
const routingLog    = document.getElementById('routing-log');
const transcriptLog = document.getElementById('transcript-log');
const surgicalVideo = document.getElementById('surgical-video');

// ── Audio state ────────────────────────────────────────────────────────────
let audioPlayerNode = null;
let micStream       = null;

// ── WebSocket / capture state ──────────────────────────────────────────────
let ws            = null;
let videoInterval = null;
let offscreenCtx  = null;

// ── Entry point ────────────────────────────────────────────────────────────
connectBtn.addEventListener('click', connect);
surgicalVideo.src = `${GCS_BASE}/${CONFIG.videoPath}`;


async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const userId    = `surgeon_${Date.now()}`;
  const sessionId = `session_${Date.now()}`;
  const protocol  = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl     = `${protocol}://${window.location.host}/ws/${userId}/${sessionId}`;

  setStatus('connecting', 'ORION CONNECTING…');
  logRouting('Connecting to ORION server…', 'turn');

  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = async () => {
    setStatus('active', 'ORION ACTIVE');
    connectBtn.textContent = 'Connected';
    connectBtn.classList.add('connected');
    logRouting('WebSocket connected. Session established.', 'turn');

    // Start audio output (24kHz playback)
    [audioPlayerNode] = await startAudioPlayerWorklet();

    // Start audio input (16kHz capture) — handler receives ArrayBuffer
    [, , micStream] = await startAudioRecorderWorklet(audioRecorderHandler);
    micIndicator.classList.add('active');

    // Start video frame capture
    startVideoCapture();

    // Initialise display modules
    CTViewer.init({
      canvasId:    'ct-canvas',
      gcsBase:     GCS_BASE,
      ctPath:      CONFIG.ctPath,
      totalSlices: CONFIG.ctTotalSlices,
    });
    Anatomy3D.init({
      canvasId: 'ar-canvas',
      modelUrl: `${GCS_BASE}/${CONFIG.modelPath}`,
    });
    ClinicalPanel.init({ containerId: 'clinical-panel' });
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') handleServerEvent(event.data);
  };

  ws.onclose = () => {
    setStatus('offline', 'ORION OFFLINE');
    connectBtn.textContent = 'Reconnect ORION';
    connectBtn.classList.remove('connected');
    micIndicator.classList.remove('active');
    stopVideoCapture();
    if (micStream) { stopMicrophone(micStream); micStream = null; }
    logRouting('Connection closed.', 'turn');
  };

  ws.onerror = () => {
    setStatus('offline', 'CONNECTION ERROR');
    logRouting('WebSocket error — check server logs.', 'error');
  };
}


// ── Audio I/O ──────────────────────────────────────────────────────────────

/** Called by startAudioRecorderWorklet — receives raw PCM ArrayBuffer. */
function audioRecorderHandler(pcmData) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(pcmData);  // binary frame, direct ArrayBuffer — no JSON wrapping
  }
}

/** Decode base64 PCM audio and send to AudioWorklet player. */
function base64ToArray(base64) {
  // Handle base64url encoding (replace - and _ with + and /)
  const std = base64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(std);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}


// ── Video frame capture ────────────────────────────────────────────────────

function startVideoCapture() {
  const offscreen = document.createElement('canvas');
  offscreen.width = 320; offscreen.height = 240;
  offscreenCtx = offscreen.getContext('2d');

  videoInterval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (surgicalVideo.readyState < 2) return;
    offscreenCtx.drawImage(surgicalVideo, 0, 0, 320, 240);
    const b64 = offscreen.toDataURL('image/jpeg', 0.6);
    ws.send(JSON.stringify({ type: 'image_frame', data: b64 }));
  }, 1000);
}

function stopVideoCapture() {
  clearInterval(videoInterval);
  videoInterval = null;
}


// ── Server event handling ──────────────────────────────────────────────────

/**
 * ADK serialises events as snake_case via model_dump_json().
 * Some fields may also arrive camelCase — we check both to be safe.
 */
function handleServerEvent(jsonString) {
  let event;
  try { event = JSON.parse(jsonString); }
  catch { return; }

  // Input transcription (surgeon speech — what Gemini heard).
  // Server uses by_alias=True so camelCase arrives first; snake_case is fallback.
  const inputText = event.inputTranscription?.text ?? event.input_transcription?.text;
  if (inputText) addTranscript('surgeon', inputText);

  // Output transcription (ORION spoken response)
  const outputText = event.outputTranscription?.text ?? event.output_transcription?.text;
  if (outputText) addTranscript('orion', outputText);

  // Agent routing visibility (show which specialist took the turn)
  if (event.author && event.author !== 'ORION_Orchestrator') {
    logRouting(`→ ${event.author}`, 'transfer');
  }

  const parts = event.content?.parts ?? [];
  for (const part of parts) {

    // Audio output — send PCM to AudioWorklet player.
    // Forward audio from ANY agent (orchestrator or sub-agents). ADK's
    // multi-agent live flow has sub-agents generate the audio response.
    const inlineData = part.inlineData ?? part.inline_data;
    const mimeType   = inlineData?.mimeType ?? inlineData?.mime_type ?? '';
    if (inlineData && mimeType.startsWith('audio/pcm') && audioPlayerNode) {
      audioPlayerNode.port.postMessage(base64ToArray(inlineData.data));
    }

    // Text from model (non-audio fallback)
    if (part.text && event.content?.role === 'model' && !outputText) {
      addTranscript('orion', part.text);
    }

    // Function call → dispatch to display layer
    const fc = part.functionCall ?? part.function_call;
    if (fc) {
      logRouting(`▶ ${fc.name}(${JSON.stringify(fc.args)})`, 'tool-call');
      dispatchRenderCommand(fc.name, fc.args ?? fc.arguments ?? {});
    }

    // Function response → update display with actual clinical values
    const fr = part.functionResponse ?? part.function_response;
    if (fr) handleFunctionResponse(fr);
  }

  // Interrupt — stop current audio playback
  if (event.interrupted && audioPlayerNode) {
    audioPlayerNode.port.postMessage({ command: 'endOfAudio' });
  }

  if (event.turnComplete ?? event.turn_complete) {
    micIndicator.classList.add('active');
  }
}


// ── Render command dispatch ────────────────────────────────────────────────

function dispatchRenderCommand(toolName, args) {
  switch (toolName) {
    case 'display_patient_data':
      ClinicalPanel.showLoading(args.field);
      break;
    case 'hide_patient_data':
      ClinicalPanel.hide();
      break;
    case 'navigate_ct':
      CTViewer.navigate(args.direction, args.count || 1);
      break;
    case 'jump_to_landmark':
      CTViewer.jumpToLandmark(args.landmark);
      break;
    case 'hide_ct':
      CTViewer.hide();
      break;
    case 'rotate_model':
      Anatomy3D.rotate(args.axis, args.degrees);
      break;
    case 'toggle_structure':
      Anatomy3D.toggleStructure(args.structure, args.visible);
      break;
    case 'reset_3d_view':
      Anatomy3D.reset();
      break;
    case 'hide_all_overlays':
      CTViewer.hide(); ClinicalPanel.hide(); Anatomy3D.hide();
      break;
    default:
      console.warn('[app.js] Unknown tool:', toolName);
  }
}

function handleFunctionResponse(fr) {
  const cmd = fr.response?.render_command;
  if (!cmd) return;
  if (cmd.layer === 'clinical' && cmd.action === 'show') {
    ClinicalPanel.show(cmd.field, cmd.label, cmd.value, cmd.note);
  }
}


// ── UI helpers ─────────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusText.textContent = text;
  statusDot.className = state === 'active' ? 'active' : '';
}

function logRouting(text, type = 'turn') {
  const entry = document.createElement('div');
  entry.className = `routing-event ${type}`;
  entry.textContent = text;
  routingLog.appendChild(entry);
  routingLog.scrollTop = routingLog.scrollHeight;
  while (routingLog.children.length > 50) routingLog.removeChild(routingLog.firstChild);
}

function addTranscript(speaker, text) {
  if (!text?.trim()) return;
  const entry = document.createElement('div');
  entry.className = `transcript-entry ${speaker}`;
  entry.innerHTML = `
    <div class="speaker">${speaker === 'surgeon' ? 'Surgeon' : 'ORION'}</div>
    <div class="text">${escapeHtml(text)}</div>`;
  transcriptLog.appendChild(entry);
  transcriptLog.scrollTop = transcriptLog.scrollHeight;
  while (transcriptLog.children.length > 100) transcriptLog.removeChild(transcriptLog.firstChild);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
