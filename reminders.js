/* Reminders: lets a phone subscribe to notifications, and lets someone paste the family link on the setup screen. */
(function () {
  var PUBLIC_KEY = 'BMEp__H2u_F9FlT_c7n1XmysY2W_l2hwz4jXtY_Vs3CYtiepELoocmHGr9JUEb7wwgTG5ZTmj5EXbeqNLzQF2ak';
  var KEY_RE = /^[A-Za-z0-9_-]{24,64}$/, STORE = 'vitals-family-code';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function currentKey() {
    var h = location.hash.replace(/^#/, '');
    if (KEY_RE.test(h)) return h;
    try { var s = localStorage.getItem(STORE); if (s && KEY_RE.test(s)) return s; } catch (e) {}
    return null;
  }

  /* ---------- paste the family link on the setup screen ---------- */
  function buildPaste() {
    var setup = $('setup'); if (!setup || $('paste-link')) return;
    var label = el('label', null, 'Or paste the family link here');
    label.setAttribute('for', 'paste-link');
    var input = el('input'); input.id = 'paste-link'; input.autocomplete = 'off';
    label.appendChild(input);
    var row = el('div', 'row'), btn = el('button', null, 'Open the log'), msg = el('span', 'small muted');
    btn.type = 'button'; row.appendChild(btn); row.appendChild(msg);
    btn.onclick = function () {
      var v = input.value.trim(), code = v.indexOf('#') >= 0 ? v.slice(v.lastIndexOf('#') + 1) : v;
      if (!KEY_RE.test(code)) { msg.textContent = 'That doesn’t look like the full family link. Copy it again and paste the whole thing.'; return; }
      try { localStorage.setItem(STORE, code); } catch (e) {}
      location.hash = code; location.reload();
    };
    setup.appendChild(label); setup.appendChild(row);
  }

  /* ---------- reminders panel ---------- */
  function b64ToBytes(s) {
    var pad = '='.repeat((4 - s.length % 4) % 4), raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function idFor(endpoint) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('').slice(0, 40);
    });
  }

  function buildPanel(key) {
    if ($('reminders')) return;
    var anchor = $('doc-form') && $('doc-form').closest('section'); if (!anchor) return;
    var panel = el('section', 'panel'); panel.id = 'reminders';
    panel.appendChild(el('h2', null, 'Reminders'));
    panel.appendChild(el('p', null, 'Get a notification on this phone when a check hasn’t been logged by 9 AM, 2 PM or 8 PM. It stays quiet when the check is already saved.'));
    var status = el('p', 'verdict plain', 'Checking this phone…'); status.id = 'rem-status';
    var row = el('div', 'row'), btn = el('button', 'primary', 'Turn on reminders'); btn.type = 'button'; btn.id = 'rem-btn'; btn.hidden = true;
    row.appendChild(btn);
    panel.appendChild(status); panel.appendChild(row);
    panel.appendChild(el('p', 'small muted', 'Each phone turns reminders on for itself. They can arrive up to 15 minutes late.'));
    anchor.parentNode.insertBefore(panel, anchor);

    function say(cls, text) { status.className = 'verdict ' + cls; status.textContent = text; }
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      if (ios) {
        say('warn', 'On an iPhone, reminders only work from the Home Screen.');
        var steps = el('ol', 'small');
        ['Copy the family link from the Family link section below.', 'In Safari, tap the Share button, then “Add to Home Screen”.', 'Open the log from the new Home Screen icon. If it asks for the family link, paste it.', 'Come back to this section and tap “Turn on reminders”.']
          .forEach(function (t) { steps.appendChild(el('li', null, t)); });
        panel.insertBefore(steps, row);
      } else say('warn', 'This browser can’t show reminders. Try Chrome on Android, or Safari on an iPhone.');
      return;
    }
    if (typeof firebase === 'undefined' || !firebase.apps.length) { say('warn', 'Reminders need the log to be connected. Reload the page and try again.'); return; }
    var store = firebase.firestore().collection('logs').doc(key).collection('push');

    function show(on) {
      btn.hidden = false; btn.disabled = false;
      btn.textContent = on ? 'Turn off reminders' : 'Turn on reminders';
      btn.className = on ? '' : 'primary';
      if (on) say('ok', 'Reminders are on for this phone.');
      else say('plain', Notification.permission === 'denied'
        ? 'Notifications are blocked for this page. Allow them in the browser’s site settings, then try again.'
        : 'Reminders are off for this phone.');
      btn.onclick = on ? turnOff : turnOn;
    }
    var regReady = navigator.serviceWorker.register('sw.js').then(function () { return navigator.serviceWorker.ready; });

    function turnOn() {
      btn.disabled = true; say('plain', 'Turning on…');
      Promise.resolve(Notification.requestPermission()).then(function (perm) {
        if (perm !== 'granted') { show(false); return; }
        return regReady.then(function (reg) {
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(PUBLIC_KEY) });
        }).then(function (sub) {
          return idFor(sub.endpoint).then(function (id) { return store.doc(id).set({ sub: JSON.stringify(sub), at: Date.now() }); });
        }).then(function () { show(true); });
      }).catch(function () { show(false); say('bad', 'Could not turn on reminders. Check the connection and try again.'); });
    }
    function turnOff() {
      btn.disabled = true;
      regReady.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
        if (!sub) return;
        return idFor(sub.endpoint).then(function (id) {
          return sub.unsubscribe().then(function () { return store.doc(id).delete(); });
        });
      }).then(function () { show(false); }, function () { show(true); say('bad', 'Could not turn off reminders. Try again.'); });
    }
    regReady.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) { show(!!sub); }, function () { say('warn', 'This browser can’t show reminders.'); });
  }

  function init() { var key = currentKey(); if (key) buildPanel(key); else buildPaste(); }
  init();
  var starter = $('setup-new');
  if (starter) starter.addEventListener('click', function () { setTimeout(init, 0); });
})();
