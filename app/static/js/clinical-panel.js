/**
 * clinical-panel.js — Clinical data card overlay
 * ================================================
 * Manages floating data cards displayed over the surgical view.
 * Each card shows a single patient data field (e.g. hemoglobin).
 * Cards stack in the lower-right corner.
 *
 * Public API (called by app.js dispatchRenderCommand):
 *   ClinicalPanel.init(config)
 *   ClinicalPanel.show(field, label, value, note)
 *   ClinicalPanel.showLoading(field)
 *   ClinicalPanel.hide()
 */

'use strict';

const ClinicalPanel = (() => {

  let container = null;

  // Map of field → card DOM element (for updating in-place)
  const cards = {};

  const STYLES = `
    .orion-card {
      background: rgba(5, 15, 30, 0.88);
      border: 1px solid rgba(79, 195, 247, 0.35);
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 8px;
      min-width: 200px;
      max-width: 260px;
      backdrop-filter: blur(6px);
      font-family: 'Courier New', monospace;
    }
    .orion-card-field {
      font-size: 9px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #4fc3f7;
      margin-bottom: 4px;
    }
    .orion-card-value {
      font-size: 16px;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 4px;
      letter-spacing: 0.5px;
    }
    .orion-card-note {
      font-size: 10px;
      color: #78909c;
      line-height: 1.4;
    }
    .orion-card-ts {
      font-size: 9px;
      color: #37474f;
      margin-top: 6px;
    }
    .orion-card-loading .orion-card-value {
      color: #546e7a;
      font-style: italic;
      font-size: 13px;
    }
  `;

  function init(config) {
    container = document.getElementById(config.containerId);

    // Inject card styles once
    if (!document.getElementById('orion-clinical-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'orion-clinical-styles';
      styleEl.textContent = STYLES;
      document.head.appendChild(styleEl);
    }

    // Position container in lower-right of the display area
    container.style.cssText = `
      position: absolute;
      bottom: 20px;
      right: 20px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      pointer-events: none;
    `;
  }

  /**
   * Shows a loading placeholder for a field while the tool executes.
   * Will be replaced by show() when the actual value arrives.
   */
  function showLoading(field) {
    _upsertCard(field, {
      label: _fieldLabel(field),
      value: 'retrieving…',
      note: '',
      loading: true,
    });
  }

  /**
   * Displays (or updates) a clinical data card.
   * @param {string} field  - e.g. 'hemoglobin'
   * @param {string} label  - display name, e.g. 'Hemoglobin'
   * @param {string} value  - e.g. '11.2 g/dL'
   * @param {string} note   - optional annotation
   */
  function show(field, label, value, note) {
    _upsertCard(field, { label, value, note, loading: false });
  }

  /**
   * Removes all clinical data cards.
   */
  function hide() {
    if (!container) return;
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    Object.keys(cards).forEach((k) => delete cards[k]);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  function _upsertCard(field, { label, value, note, loading }) {
    if (!container) return;

    let card = cards[field];
    if (!card) {
      card = document.createElement('div');
      card.className = 'orion-card';
      container.appendChild(card);
      cards[field] = card;
    }

    card.className = loading ? 'orion-card orion-card-loading' : 'orion-card';

    const ts = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });

    card.innerHTML = `
      <div class="orion-card-field">${_esc(label || field)}</div>
      <div class="orion-card-value">${_esc(value)}</div>
      ${note ? `<div class="orion-card-note">${_esc(note)}</div>` : ''}
      <div class="orion-card-ts">Last updated ${ts}</div>
    `;
  }

  function _fieldLabel(field) {
    const labels = {
      hemoglobin: 'Hemoglobin',
      creatinine: 'Creatinine',
      platelets:  'Platelets',
      inr:        'INR',
      bp:         'Blood Pressure',
      weight:     'Weight',
      age:        'Age',
      diagnosis:  'Diagnosis',
      procedure:  'Procedure',
      allergies:  'Allergies',
      medications:'Medications',
    };
    return labels[field] || field;
  }

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  return { init, show, showLoading, hide };

})();
