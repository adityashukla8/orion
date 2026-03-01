/**
 * clinical-panel.js — Patient vitals overlay modal
 * ==================================================
 * Renders patient clinical data as a single glassmorphism modal
 * centered on the surgical video. Fields appear as rows separated
 * by hairline dividers; the modal shows/hides as a unit.
 *
 * Public API (called by app.js dispatchRenderCommand):
 *   ClinicalPanel.init(config)
 *   ClinicalPanel.show(field, label, value, note)
 *   ClinicalPanel.showLoading(field)
 *   ClinicalPanel.hide()
 */

'use strict';

const ClinicalPanel = (() => {

  let modal = null;   // #clinical-modal — the outer .overlay-modal div
  let body  = null;   // #vitals-body — inner scrollable row container

  // Map of field → row DOM element (for in-place updates)
  const rows = {};

  const STYLES = `
    #vitals-body {
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .vitals-row {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding: 11px 16px;
      border-bottom: 1px solid rgba(140, 175, 220, 0.22);
      font-family: 'Poppins', sans-serif;
    }
    .vitals-row:last-child { border-bottom: none; }
    .vitals-label {
      flex: 0 0 36%;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.11em;
      text-transform: uppercase;
      color: rgba(30, 65, 130, 0.88);
      padding-top: 3px;
      line-height: 1.3;
    }
    .vitals-val-block { flex: 1; min-width: 0; }
    .vitals-value {
      font-size: 15px;
      font-weight: 700;
      color: #0d2448;
      letter-spacing: 0.02em;
      font-family: 'Poppins', sans-serif;
    }
    .vitals-value.loading {
      color: rgba(50, 100, 170, 0.65);
      font-style: italic;
      font-size: 13px;
      font-weight: 400;
    }
    .vitals-note {
      font-size: 10px;
      color: rgba(30, 65, 130, 0.75);
      margin-top: 3px;
      line-height: 1.45;
      font-family: 'Poppins', sans-serif;
    }
  `;

  // ── Public API ──────────────────────────────────────────────────────────

  function init(config) {
    modal = document.getElementById(config.modalId  || 'clinical-modal');
    body  = document.getElementById(config.bodyId   || 'vitals-body');

    if (!document.getElementById('orion-clinical-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'orion-clinical-styles';
      styleEl.textContent = STYLES;
      document.head.appendChild(styleEl);
    }
  }

  /**
   * Shows a "retrieving…" placeholder for a field while the tool executes.
   * Replaced by show() when the real value arrives from the function response.
   */
  function showLoading(field) {
    _upsertRow(field, {
      label:   _fieldLabel(field),
      value:   'retrieving…',
      note:    '',
      loading: true,
    });
    if (modal) { modal.classList.add('visible'); window.ORION_relayoutModals?.(); }
  }

  /**
   * Displays (or updates) a vitals row with real data.
   * @param {string} field
   * @param {string} label  - display name
   * @param {string} value  - e.g. '11.2 g/dL'
   * @param {string} note   - optional annotation
   */
  function show(field, label, value, note) {
    _upsertRow(field, { label, value, note, loading: false });
    if (modal) { modal.classList.add('visible'); window.ORION_relayoutModals?.(); }
  }

  /**
   * Clears all vitals rows and hides the modal.
   */
  function hide() {
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    Object.keys(rows).forEach((k) => delete rows[k]);
    if (modal) { modal.classList.remove('visible'); window.ORION_relayoutModals?.(); }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  function _upsertRow(field, { label, value, note, loading }) {
    if (!body) return;

    let row = rows[field];
    if (!row) {
      row = document.createElement('div');
      row.className = 'vitals-row';
      body.appendChild(row);
      rows[field] = row;
    }

    row.innerHTML = `
      <div class="vitals-label">${_esc(label || field)}</div>
      <div class="vitals-val-block">
        <div class="vitals-value${loading ? ' loading' : ''}">${_esc(value)}</div>
        ${note ? `<div class="vitals-note">${_esc(note)}</div>` : ''}
      </div>
    `;
  }

  function _fieldLabel(field) {
    const labels = {
      hemoglobin:  'Hemoglobin',
      creatinine:  'Creatinine',
      platelets:   'Platelets',
      inr:         'INR',
      bp:          'Blood Pressure',
      weight:      'Weight',
      age:         'Age',
      diagnosis:   'Diagnosis',
      procedure:   'Procedure',
      allergies:   'Allergies',
      medications: 'Medications',
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
