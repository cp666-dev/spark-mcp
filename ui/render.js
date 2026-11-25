// Spark MCP's panel DOM, in the Assistive Intelligence "Strip" design. It knows nothing about
// LUNA: main.js hands it AddOnLogic.view(record), and it calls the handlers it was given.

(function (global) {
  'use strict';

  // The mark: UA's diamond, verbatim from LUNA.app/.../images/misc/UniversalAudioIcon.svg.
  const MARK =
    '<svg class="aip-mark" viewBox="0 0 181.25 110.25" aria-hidden="true" data-state="offline">' +
    '<path class="core" d="M11.896,56.266 L89.983,101.538 L168.074,56.266 L89.987,8.737 Z"/>' +
    '<path class="ring" fill-rule="evenodd" d="M2.099,56.41L89.987,2.914l87.887,53.496l-86.633,50.22l-1.254,0.729L2.099,56.41z M11.915,56.303l78.068,45.261l78.073-45.261L89.987,8.784L11.915,56.303z"/>' +
    '<path class="letters" d="M107.065,76.147v-0.775V62.56l39.026-1.875l-0.21-2.718h-38.816V34.19c0-6.594-5.342-11.936-11.936-11.939c-6.594,0.004-11.934,5.346-11.934,11.939v11.588l-0.012,0.104v12.086h-2.286l-4.387,6.061l6.673-0.32v10.752c-0.007,3.82-3.1,6.914-6.923,6.92c-3.819-0.006-6.913-3.1-6.919-6.92l0.055-34.095v-0.519c0,0,0.162-4.57-2.501-6.965c-3.526-3.082-10.864-1.287-10.864-1.287c9.088,0.051,8.309,7.834,8.309,7.834l-0.014,0.937v34.095c0.002,6.594,5.34,11.937,11.935,11.937c6.594,0,11.937-5.343,11.937-11.937V63.465l13.892-0.666l0.017,12.572v0.359c0,0-0.261,4.568,2.404,6.964c3.526,3.082,10.864,1.289,10.864,1.289C106.67,84.086,107.065,76.147,107.065,76.147 M88.198,57.967V46.163l0.013-0.109V34.19c0.007-3.824,3.096-6.916,6.919-6.923c3.823,0.007,6.916,3.099,6.92,6.923l0.032,23.777H88.198z"/>' +
    '</svg>';

  // Lucide (ISC licence) geometry, 24-unit grid, as in the Assistive Intelligence panel.
  const REPEAT = '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>';
  const CHECK = '<path d="M20 6 9 17l-5-5"/>';
  const SETTINGS = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-2.82-1.12l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0-1.17-2.82H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.12-2.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 2.82-1.17V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 2.82 1.17l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0 1.17 2.82H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function btn(cls, title) {
    const b = el('button', cls);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  }
  function icon(paths, size) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'aip-ico aip-ico-' + size);
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = paths;
    return s;
  }
  function kv(k, v) {
    const r = el('div', 'aip-kv');
    r.append(el('span', 'aip-kv-k', k), el('span', 'aip-kv-v', v));
    return r;
  }

  function createPanel(root, h) {
    root.classList.add('aip');
    root.replaceChildren();

    const bridge = el('div', 'aip-bridge');
    const stateRow = el('div', 'aip-state');
    stateRow.insertAdjacentHTML('afterbegin', MARK);
    const mark = stateRow.firstChild;
    const stateText = el('div', 'aip-state-text');
    const word = el('div', 'aip-state-word');
    const detail = el('div', 'aip-state-detail');
    stateText.append(word, detail);
    const loop = btn('aip-btn spk-loop', 'Loop this section (L)');
    loop.append(icon(REPEAT, 10), el('span', null, 'LOOP'));
    loop.onclick = () => h.onLoop();
    const gear = btn('aip-btn spk-gear', 'Model and API key');
    gear.append(icon(SETTINGS, 12));
    gear.onclick = (event) => { event.stopPropagation(); h.onSettings(); };
    stateRow.append(stateText, loop, gear);
    bridge.append(stateRow);

    const ctx = el('div', 'aip-ctx');
    const ctxRow = el('div', 'aip-ctx-row');
    const cell = (key) => {
      const c = el('div', 'aip-cell aip-cell--click');
      const value = el('span', 'aip-cell-v is-empty', '-');
      c.append(el('span', 'aip-cell-k', key), value);
      return value;
    };
    const trackCell = cell('TRACK');
    const sectionCell = cell('SECTION');
    ctxRow.append(trackCell.parentNode, sectionCell.parentNode);
    ctx.append(ctxRow);

    const sec = el('div', 'aip-sec');
    const secL = el('div', 'aip-sec-side');
    const secTitle = el('div', 'aip-sec-title', 'SHOOTOUT');
    const secR = el('div', 'aip-sec-side aip-sec-side--end');
    const blind = btn('aip-tag aip-tag--request spk-tag-blind', 'Show or hide which plugin is which (B)');
    blind.textContent = 'BLIND';
    blind.onclick = () => h.onBlind();
    secR.append(blind);
    sec.append(secL, secTitle, secR);

    const slots = el('div', 'aip-slots');
    const well = el('div', 'aip-well');
    slots.append(well);

    const actions = el('div', 'spk-actions');
    const keep = btn('spk-action spk-keep', 'Keep the one you are hearing (Return)');
    const keepLabel = el('span', null, 'KEEP');
    keep.append(keepLabel, el('span', null, 'RETURN'));
    keep.onclick = () => h.onKeep();
    const cancel = btn('spk-action spk-cancel', 'Put the track back as it was (Esc)');
    cancel.append(el('span', null, 'CANCEL'), el('span', null, 'ESC'));
    cancel.onclick = () => h.onCancel();
    actions.append(keep, cancel);

    const form = el('form', 'aip-prompt spk-prompt');
    form.autocomplete = 'off';
    const input = el('input', 'aip-input');
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Tell Spark what the track needs');
    form.append(input);
    form.onsubmit = (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      if (h.onPrompt(text) !== false) {
        input.value = '';
        // Back to the panel, so the number keys choose candidates again.
        input.blur();
      }
    };

    const settings = el('form', 'aip-pop-setups spk-settings');
    settings.autocomplete = 'off';
    settings.hidden = true;
    settings.onclick = (event) => event.stopPropagation();
    document.addEventListener('mousedown', (event) => {
      if (!settings.hidden && !settings.contains(event.target) && !gear.contains(event.target)) h.onSettings(false);
    });

    root.append(bridge, ctx, sec, slots, actions, form, settings);

    function field(label, value, options = {}) {
      const row = el('label', 'spk-field');
      const box = el('input', 'aip-input');
      box.type = options.secret ? 'password' : 'text';
      box.value = value ?? '';
      box.placeholder = options.placeholder ?? '';
      box.spellcheck = false;
      row.append(el('span', 'aip-kv-k', label), box);
      settings.append(row);
      return box;
    }

    /** s: null, or { providers: [{ id, label }], provider, key, model, baseUrl, needsBaseUrl, note } */
    function renderSettings(s) {
      settings.hidden = !s;
      if (!s) return;
      settings.replaceChildren();
      const head = el('div', 'aip-pop-head');
      head.append(el('span', 'aip-pop-title', 'Model'), el('span', 'aip-pop-esc', 'ESC'));
      settings.append(head);
      const seg = el('div', 'aip-seg spk-field');
      for (const p of s.providers) {
        const b = btn('aip-seg-btn' + (p.id === s.provider ? ' is-on' : ''), p.label);
        b.textContent = p.short;
        b.onclick = () => h.onProvider(p.id);
        seg.append(b);
      }
      settings.append(seg);
      const key = field('KEY', s.key, { secret: true, placeholder: s.keyPlaceholder });
      const model = field('MODEL', s.model, { placeholder: 'Model name' });
      const base = s.needsBaseUrl ? field('URL', s.baseUrl, { placeholder: 'http://localhost:11434/v1' }) : null;
      settings.append(el('div', 'aip-pop-hint', s.note));
      const actionsRow = el('div', 'spk-settings-actions');
      const save = el('button', 'aip-btn is-on', 'SAVE');
      save.type = 'submit';
      actionsRow.append(save);
      settings.append(actionsRow);
      settings.onsubmit = (event) => {
        event.preventDefault();
        h.onSaveSettings({ key: key.value.trim(), model: model.value.trim(), baseUrl: base?.value.trim() ?? '' });
      };
      key.focus();
    }

    function row(c) {
      const slot = el('div', 'aip-slot spk-row' + (c.on ? ' is-on' : ''));
      slot.dataset.key = c.key;
      const body = el('div', 'aip-slot-body');
      const head = el('div', 'aip-slot-head');
      head.append(el('span', 'aip-slot-n', c.key), el('span', 'aip-slot-title', c.title));
      if (c.check) head.append(el('span', 'aip-tag aip-tag--check', 'QUIET'));
      body.append(head);
      if (c.preset || c.why || c.change) {
        const info = el('div', 'aip-slot-detail');
        if (c.preset) info.append(kv('PRESET', c.preset));
        if (c.why) info.append(kv('WHY', c.why));
        if (c.change) info.append(kv('DOES', c.change));
        body.append(info);
      }
      const hear = btn('aip-go spk-hear', 'Hear this (' + c.key + ')');
      hear.append(el('span', 'aip-go-label', c.on ? 'ON' : 'HEAR'), el('span', 'aip-go-key', c.key));
      hear.onclick = () => h.onListen(c.key);
      slot.append(body, hear);
      return slot;
    }

    function idle(view, picks, opt) {
      if (view.done) {
        const done = el('div', 'aip-slot aip-slot--done');
        const ico = el('span', 'aip-done-ico');
        ico.append(icon(CHECK, 12));
        done.append(ico, el('span', 'aip-done-title', view.done.title + (view.done.sub ? ' · ' + view.done.sub : '')), el('span', 'aip-done-word', view.done.blind ? 'PICKED BLIND' : 'PICKED'));
        well.append(done);
      }
      if (view.notice) {
        const notice = el('div', 'aip-notice aip-notice--boxed');
        const body = el('div', 'aip-notice-body');
        body.append(el('div', 'aip-notice-title', view.phase === 'stalled' ? 'The print stalled' : 'The shootout stopped'), el('div', 'aip-notice-t', view.notice));
        notice.append(el('span', 'aip-notice-led'), body);
        well.append(notice);
      }
      if (!view.done && !view.notice && !picks.length && !opt.reply && !opt.working) {
        const empty = el('div', 'aip-empty');
        empty.append(el('div', null, 'No shootout yet.'), el('div', null, 'Select a track, loop a section, and say what it needs below.'), el('div', null, 'Plugins you own show up here, printed from your session, working equally hard and level matched, to judge by ear.'));
        if (opt.needsKey) {
          const add = el('button', 'aip-btn is-on spk-add-key', 'ADD YOUR API KEY');
          add.type = 'button';
          add.onclick = (event) => { event.stopPropagation(); h.onSettings(); };
          empty.append(add);
        }
        well.append(empty);
      }
      if (picks.length) {
        well.append(el('div', 'spk-picks-title', 'Recent picks'));
        for (const pick of picks) {
          const line = el('div', 'spk-pick');
          line.append(el('span', 'spk-pick-name', pick.kept.name + (pick.kept.presetName ? ' · ' + pick.kept.presetName : '')), el('span', 'spk-pick-role', pick.role + (pick.blind ? ' · blind' : '')));
          well.append(line);
        }
      }
    }

    function render(view, picks, opt) {
      opt = opt || {};
      renderSettings(opt.settings || null);
      root.dataset.state = view.state;
      mark.setAttribute('data-state', view.state);
      word.textContent = view.word;
      detail.textContent = view.detail || '';
      detail.title = view.detail || '';
      const ready = view.phase === 'ready';
      loop.hidden = !ready;
      loop.classList.toggle('is-on', !!opt.looping);
      trackCell.textContent = view.track || '-';
      trackCell.classList.toggle('is-empty', !view.track);
      trackCell.title = view.track || '';
      sectionCell.textContent = view.section || '-';
      sectionCell.classList.toggle('is-empty', !view.section);
      blind.hidden = !ready;
      blind.classList.toggle('is-off', !view.blind);
      const stalled = view.phase === 'stalled';
      actions.hidden = !ready && !stalled;
      keep.hidden = stalled;
      cancel.classList.toggle('is-wide', stalled);
      keep.disabled = !view.canKeep;
      keepLabel.textContent = view.canKeep ? 'KEEP ' + view.listening : 'CHOOSE ONE';
      cancel.disabled = false;

      well.replaceChildren();
      if (stalled) {
        idle(view, [], opt);
      } else if (view.phase === 'printing') {
        if (opt.reply) well.append(el('div', 'spk-reply', opt.reply));
        well.append(el('div', 'spk-progress', view.detail));
      } else if (ready) {
        if (opt.reply) well.append(el('div', 'spk-reply', opt.reply));
        well.append(row({ key: '0', title: 'As it was', on: view.listening === '0' }));
        well.lastChild.classList.add('spk-row--original');
        for (const c of view.candidates) well.append(row(c));
      } else {
        if (opt.reply) well.append(el('div', 'spk-reply', opt.reply));
        idle(view, picks || [], opt);
      }

      input.disabled = !!opt.working;
      input.placeholder = opt.working ? 'Working on it. Esc stops it.' : ready ? 'Ask for something else, like “heavier”' : 'Say what it needs, then Return';
      form.hidden = view.state === 'offline';
    }

    return { render };
  }

  global.SparkPanel = { createPanel };
})(globalThis);
