(function (global) {
  'use strict';

  var ESC = 0x1B, GS = 0x1D, LF = 0x0A;

  var CP1252_EXTRA = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F
  };

  function encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c === 0x0A) { out.push(LF); }
      else if (c < 0x80) { out.push(c); }
      else if (CP1252_EXTRA[c] !== undefined) { out.push(CP1252_EXTRA[c]); }
      else if (c >= 0xA0 && c <= 0xFF) { out.push(c); }
      else { out.push(0x3F); }
    }
    return out;
  }

  function EscPos() { this.b = []; }

  EscPos.prototype.raw = function () {
    for (var i = 0; i < arguments.length; i++) this.b.push(arguments[i] & 0xFF);
    return this;
  };

  EscPos.prototype.init = function () { return this.raw(ESC, 0x40); };
  EscPos.prototype.codepage = function (n) { return this.raw(ESC, 0x74, n); };
  EscPos.prototype.align = function (a) {
    return this.raw(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0);
  };
  EscPos.prototype.bold = function (on) { return this.raw(ESC, 0x45, on ? 1 : 0); };
  EscPos.prototype.underline = function (on) { return this.raw(ESC, 0x2D, on ? 1 : 0); };
  // GS ! (character size). ESC ! would read the same bits as font B and double height, and
  // would turn bold off.
  EscPos.prototype.size = function (w, h) {
    w = Math.max(1, Math.min(8, w || 1));
    h = Math.max(1, Math.min(8, h || 1));
    return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1));
  };
  EscPos.prototype.text = function (s) {
    var arr = encode(String(s));
    for (var i = 0; i < arr.length; i++) this.b.push(arr[i]);
    return this;
  };
  EscPos.prototype.line = function (s) { return this.text(s).raw(LF); };
  EscPos.prototype.feed = function (n) { return this.raw(ESC, 0x64, n == null ? 1 : n); };
  EscPos.prototype.cut = function (mode) {
    if (mode === 'partial') return this.raw(GS, 0x56, 0x42, 0x00);
    return this.raw(GS, 0x56, 0x00);
  };
  EscPos.prototype.rule = function (width) {
    var w = width || 32;
    return this.line(new Array(w + 1).join('-'));
  };

  EscPos.prototype.qr = function (data, moduleSize, ecLevel) {
    data = String(data);
    var bytes = encode(data);
    var len = bytes.length + 3;
    var pL = len & 0xFF, pH = (len >> 8) & 0xFF;
    var ec = ecLevel == null ? 0x31 : ecLevel;
    this.raw(GS, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
    this.raw(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, moduleSize || 6);
    this.raw(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, ec);
    this.raw(GS, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30);
    for (var i = 0; i < bytes.length; i++) this.b.push(bytes[i]);
    return this.raw(GS, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30);
  };

  EscPos.prototype.image = function (rasterBytes) {
    for (var i = 0; i < rasterBytes.length; i++) this.b.push(rasterBytes[i] & 0xFF);
    return this;
  };

  // FS . : esce dalla modalita caratteri cinese a doppio byte, attiva di default su molti
  // firmware cinesi (le lettere accentate uscirebbero come ideogrammi).
  EscPos.prototype.kanjiOff = function () { return this.raw(0x1C, 0x2E); };

  EscPos.prototype.bytes = function () { return this.b; };

  EscPos.loadImage = function (url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error(message('imageLoad', { src: url }))); };
      img.src = url;
    });
  };

  // Raster ESC/POS (GS v 0) largo maxWidth punti (384 = 58 mm). opts facoltativo:
  // { maxHeight } altezza massima in punti (0 = nessun limite), { band } righe per comando
  // (default 128). Le bande servono perche molti firmware cinesi leggono l'altezza su un
  // solo byte: oltre 255 righe stampano il resto dei pixel come testo e si bloccano.
  EscPos.rasterize = function (img, maxWidth, threshold, opts) {
    opts = opts || {};
    var paperW = (maxWidth || 384) & ~7;
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    var w = paperW;
    var h = Math.max(1, Math.round(ih * (w / iw)));
    if (opts.maxHeight && h > opts.maxHeight) {
      h = opts.maxHeight;
      w = Math.max(8, Math.min(paperW, Math.round(iw * (h / ih))));
    }
    var band = Math.max(1, Math.min(255, opts.band || 128));
    var canvas = document.createElement('canvas');
    canvas.width = paperW; canvas.height = h;
    var ctx = canvas.getContext('2d');
    // Fondo bianco: la trasparenza diventa carta, e un logo piu stretto resta centrato.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, paperW, h);
    ctx.drawImage(img, (paperW - w) >> 1, 0, w, h);
    var data = ctx.getImageData(0, 0, paperW, h).data;
    var bytesPerRow = paperW >> 3;
    var th = threshold == null ? 140 : threshold;
    var out = [];
    for (var y0 = 0; y0 < h; y0 += band) {
      var rows = Math.min(band, h - y0);
      out.push(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xFF, (bytesPerRow >> 8) & 0xFF, rows & 0xFF, (rows >> 8) & 0xFF);
      for (var y = y0; y < y0 + rows; y++) {
        for (var b = 0; b < bytesPerRow; b++) {
          var val = 0;
          for (var bit = 0; bit < 8; bit++) {
            var i = ((y * paperW) + (b * 8 + bit)) * 4;
            var lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum < th) val |= 1 << (7 - bit);
          }
          out.push(val);
        }
      }
    }
    return out;
  };

  function bytesToBase64(bytes) {
    var s = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.slice(i, i + chunk));
    }
    return btoa(s);
  }

  function timeoutError(ms) {
    var err = new Error(message('noAnswerMs', { ms: ms }));
    err.name = 'TimeoutError';
    return err;
  }

  // Chiamata JSON verso l'app con timeout. Senza timeout una richiesta appesa lascia la
  // pagina in attesa e occupa una delle poche connessioni per host del browser.
  function localJson(url, opts, timeoutMs) {
    opts = opts || {};
    if (opts.targetAddressSpace == null) opts.targetAddressSpace = 'loopback';
    // Senza cache: Chrome mette in coda le GET identiche dietro una ancora in corso (lock
    // della cache HTTP), quindi una sola /status appesa bloccherebbe tutte le successive,
    // da qualunque scheda. no-store non aggiunge header CORS e non provoca preflight.
    if (opts.cache == null) opts.cache = 'no-store';
    var ctl = null, timer = null, timedOut = false;
    if (timeoutMs && typeof AbortController !== 'undefined' && !opts.signal) {
      ctl = new AbortController();
      opts.signal = ctl.signal;
    }
    var started;
    try {
      started = fetch(url, opts);
    } catch (e) {
      started = Promise.reject(e);
    }
    var request = started
      .then(function (r) {
        return r.text().then(function (t) { return { r: r, t: t }; });
      })
      .then(function (x) {
        var j = null;
        try { j = x.t ? JSON.parse(x.t) : null; } catch (e) { j = null; }
        if (!j || typeof j !== 'object') {
          var err = new Error(message('badResponse', { status: x.r.status }));
          err.name = 'ResponseError';
          err.status = x.r.status;
          throw err;
        }
        return j;
      }, function (e) {
        if (timedOut) throw timeoutError(timeoutMs);
        throw e;
      });
    if (!timeoutMs) return request;
    // Il timer vince comunque, anche dove fetch ignora il segnale di abort.
    var deadline = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        timedOut = true;
        if (ctl) ctl.abort();
        reject(timeoutError(timeoutMs));
      }, timeoutMs);
    });
    return Promise.race([request, deadline]).then(function (v) {
      clearTimeout(timer);
      return v;
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  function timeoutOf(opts, def) {
    return opts && opts.timeoutMs != null ? opts.timeoutMs : def;
  }

  function navigate(target) {
    try {
      var a = global.document.createElement('a');
      a.href = target;
      a.style.display = 'none';
      a.rel = 'noopener';
      global.document.body.appendChild(a);
      a.click();
      global.setTimeout(function () {
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 1000);
    } catch (e) {
      global.location.href = target;
    }
  }

  var RawBT = {
    packageName: 'com.rawbtprint.bridge',
    scheme: 'rawbtprint',
    apiPort: 8787,
    config: function (packageName, scheme) {
      if (packageName) RawBT.packageName = packageName;
      if (scheme) RawBT.scheme = scheme;
      return RawBT;
    },
    apiUrl: function () { return 'http://127.0.0.1:' + RawBT.apiPort + '/print'; },
    statusUrl: function () { return 'http://127.0.0.1:' + RawBT.apiPort + '/status'; },
    selftestUrl: function () { return 'http://127.0.0.1:' + RawBT.apiPort + '/selftest'; },
    configUrl: function () { return 'http://127.0.0.1:' + RawBT.apiPort + '/config'; },
    receiptUrl: function () { return 'http://127.0.0.1:' + RawBT.apiPort + '/receipt'; },
    url: function (bytes) { return RawBT.scheme + ':base64,' + bytesToBase64(bytes); },
    intentUrl: function (bytes) {
      return 'intent:base64,' + bytesToBase64(bytes) +
        '#Intent;scheme=' + RawBT.scheme + ';package=' + RawBT.packageName + ';end';
    },
    navigate: function (target) { navigate(target); },
    // Verifica che l'app risponda. Non rifiuta mai e dice sempre com'e andata:
    // { ok: true, ms, status } oppure { ok: false, ms, reason, message } con reason
    // 'timeout' (connessione appesa), 'network' (rifiutata o bloccata dal browser)
    // o 'response' (risposta non JSON). L'ultimo esito resta in RawBT.lastCheck.
    check: function (timeoutMs) {
      var ms = timeoutMs || 5000;
      var t0 = Date.now();
      var p;
      try {
        p = localJson(RawBT.statusUrl(), { method: 'GET' }, ms);
      } catch (e) {
        p = Promise.reject(e);
      }
      return p.then(function (j) {
        if (j.app !== true) {
          RawBT.lastCheck = {
            ok: false, ms: Date.now() - t0, reason: 'response',
            message: message('notTheApp')
          };
          return RawBT.lastCheck;
        }
        RawBT.lastCheck = { ok: true, ms: Date.now() - t0, status: j };
        return RawBT.lastCheck;
      }, function (e) {
        var name = e && e.name;
        var reason = name === 'TimeoutError' ? 'timeout' : name === 'ResponseError' ? 'response' : 'network';
        RawBT.lastCheck = { ok: false, ms: Date.now() - t0, reason: reason, message: (e && e.message) || String(e) };
        return RawBT.lastCheck;
      });
    },
    lastCheck: null,
    // Compatibilita: lo stato dell'app oppure null. Per il motivo dell'errore usa check().
    ping: function (timeoutMs) {
      return RawBT.check(timeoutMs).then(function (r) { return r.ok ? r.status : null; });
    },
    // opts facoltativo: { timeoutMs } (0 = nessun timeout).
    sendApi: function (bytes, opts) {
      return localJson(RawBT.apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: bytesToBase64(bytes)
      }, timeoutOf(opts, 40000));
    },
    // Autotest completo dell'app (servizio, server, Bluetooth, stampante, batteria...): niente
    // stampa. Restituisce { ok, level, summary, ms, items: [{ name, level, detail }] }.
    selftest: function (opts) {
      return localJson(RawBT.selftestUrl(), { method: 'GET' }, timeoutOf(opts, 30000));
    },
    getConfig: function (opts) {
      return localJson(RawBT.configUrl(), { method: 'GET' }, timeoutOf(opts, 10000));
    },
    // Con logoUrl l'app scarica il logo prima di rispondere: serve piu tempo.
    setConfig: function (obj, opts) {
      return localJson(RawBT.configUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj)
      }, timeoutOf(opts, obj && obj.logoUrl ? 45000 : 10000));
    },
    // Invia uno scontrino come JSON: l'app genera l'ESC/POS (puo scaricare il logo e poi stampare).
    sendReceipt: function (spec, opts) {
      return localJson(RawBT.receiptUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec)
      }, timeoutOf(opts, 60000));
    },
    // Prova l'API locale. Se la connessione viene rifiutata subito (app chiusa, permesso
    // negato) apre l'app con lo scheme e restituisce { ok: true, fallback: true,
    // confirmed: false, error }: la stampa passa all'app e la pagina non ne conosce l'esito.
    // opts.fallback === false disattiva il ripiego. Dopo un timeout non ripiega mai
    // ({ ok: false, timeout: true, error }): la richiesta potrebbe essere gia in stampa e,
    // senza un nuovo gesto dell'utente, Chrome non aprirebbe comunque l'app.
    send: function (bytes, opts) {
      var t0 = Date.now();
      return RawBT.sendApi(bytes, opts).catch(function (e) {
        var msg = (e && e.message) || String(e);
        if (e && e.name === 'TimeoutError') return { ok: false, timeout: true, error: msg };
        if ((opts && opts.fallback === false) || Date.now() - t0 > 3000) return { ok: false, error: msg };
        navigate(RawBT.url(bytes));
        return { ok: true, fallback: true, confirmed: false, error: msg };
      });
    },
    sendIntent: function (bytes) { navigate(RawBT.intentUrl(bytes)); },
    sendRaw: function (bytes) {
      var b64 = bytesToBase64(bytes);
      var queried = 'intent://base64,' + b64 +
        '#Intent;scheme=' + RawBT.scheme + ';package=' + RawBT.packageName +
        ';action=android.intent.action.SEND;end';
      navigate(queried);
    },
    // Stato del permesso Local Network Access (Chrome 142+).
    // Chrome 145+: 'loopback-network' ("App sul dispositivo").
    // Chrome 142-144: 'local-network-access'.
    localAccess: function () {
      if (!global.navigator || !global.navigator.permissions) return Promise.resolve(null);
      var names = ['loopback-network', 'local-network-access'];
      var i = 0;
      function next() {
        if (i >= names.length) return Promise.resolve(null);
        var name = names[i++];
        try {
          return global.navigator.permissions.query({ name: name }).then(
            function (r) { return { name: name, state: r.state }; },
            function () { return next(); }
          );
        } catch (e) { return next(); }
      }
      return next();
    },
    localAccessHint: function (state) {
      return message(state === 'denied' ? 'lnaDenied' : 'lnaNeeded', { steps: message('lnaSteps') });
    }
  };

  // --- Stampa diretta via Web Bluetooth (stampanti BLE, senza app) ---
  // Profili dei canali seriali BLE delle stampanti termiche ESC/POS, nell'ordine in cui si
  // provano: 18f0/2af1 e quello verificato sulle Netum NT-1809 e sulle "BlueTooth Printer".
  var BLE_PROFILES = [
    { name: '18F0', service: '000018f0-0000-1000-8000-00805f9b34fb', write: '00002af1-0000-1000-8000-00805f9b34fb' },
    { name: 'E7810A71', service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f' },
    { name: 'ISSC', service: '49535343-fe7d-4ae5-8fa9-9fafd205e455', write: '49535343-8841-43f4-a8d4-ecbe34729bb3' },
    { name: 'FF00', service: '0000ff00-0000-1000-8000-00805f9b34fb', write: '0000ff02-0000-1000-8000-00805f9b34fb' },
    { name: 'FFE0', service: '0000ffe0-0000-1000-8000-00805f9b34fb', write: '0000ffe1-0000-1000-8000-00805f9b34fb' },
    { name: 'Nordic UART', service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e' }
  ];
  // Le "cat printer" (servizio AE30) stampano solo bitmap con un protocollo proprio, non ESC/POS.
  var BLE_CAT_SERVICE = '0000ae30-0000-1000-8000-00805f9b34fb';
  // Tutti i servizi che la pagina potra usare vanno dichiarati alla scelta del dispositivo:
  // quelli non elencati restano invisibili anche alla diagnostica.
  var BLE_OPTIONAL = BLE_PROFILES.map(function (p) { return p.service; }).concat([
    '000018f1-0000-1000-8000-00805f9b34fb', '0000fff0-0000-1000-8000-00805f9b34fb',
    '0000ffe6-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb',
    BLE_CAT_SERVICE
  ]);
  // Filtri del chooser: stampanti che annunciano un servizio noto o un nome tipico.
  // Phomemo M02 / M02 Pro announce only FEE7, never FF00: they are found by name (M02...).
  var BLE_FILTERS = BLE_PROFILES.map(function (p) { return { services: [p.service] }; }).concat([
    { name: 'BlueTooth Printer' }, { namePrefix: 'Printer' }, { namePrefix: 'MPT' },
    { namePrefix: 'NT-' }, { namePrefix: 'Netum' }, { namePrefix: 'POS' }, { namePrefix: 'MTP' },
    { namePrefix: 'M02' }
  ]);
  var BLE_STORE = 'printbridge.ble';

  // Phomemo M02 family over BLE (docs/phomemo-m02.md): data on FF02, replies on FF03.
  var PHOMEMO_SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb';
  var PHOMEMO_WRITE = '0000ff02-0000-1000-8000-00805f9b34fb';
  var PHOMEMO_NOTIFY = '0000ff03-0000-1000-8000-00805f9b34fb';
  // The only 1F 11 opcodes ever sent, besides 02 (density): firmware, battery, paper, cover,
  // temperature. Fixed on purpose: never build 1F 11 commands from page input.
  var PHOMEMO_QUERIES = [0x07, 0x08, 0x11, 0x12, 0x13];

  // Replies to the status queries, possibly glued in one notification: 1A type value(s).
  // raw: every byte received, for diagnostics.
  function parsePhomemoStatus(bytes) {
    var r = { firmware: null, battery: null, paper: null, cover: null, temperature: null, raw: bytes.slice() };
    for (var i = 0; i + 2 < bytes.length; i++) {
      if (bytes[i] !== 0x1A) continue;
      var type = bytes[i + 1], v = bytes[i + 2];
      if (type === 0x07 && i + 4 < bytes.length) { r.firmware = bytes[i + 2] + '.' + bytes[i + 3] + '.' + bytes[i + 4]; i += 4; }
      else if (type === 0x04) { if (v <= 100) r.battery = v; i += 2; }
      else if (type === 0x06 && (v === 0x89 || v === 0x88)) { r.paper = v === 0x89 ? 'ok' : 'out'; i += 2; }
      else if (type === 0x05 && (v === 0x98 || v === 0x99)) { r.cover = v === 0x98 ? 'closed' : 'open'; i += 2; }
      else if (type === 0x03 && (v === 0xA8 || v === 0xA9)) { r.temperature = v === 0xA8 ? 'ok' : 'hot'; i += 2; }
    }
    return r;
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function bleError(code, message) {
    var e = new Error(message);
    e.name = 'PrintBridgeBleError';
    e.code = code;
    return e;
  }

  var bleState = {
    device: null, server: null, char: null, profile: null, service: null,
    notifyChar: null, frameListeners: [],
    status: 'idle', lastError: null, listeners: [], queue: Promise.resolve()
  };

  function bleSaved() {
    try {
      var s = global.localStorage && global.localStorage.getItem(BLE_STORE);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }
  function bleSave(patch) {
    try {
      var cur = bleSaved() || {};
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k];
      global.localStorage.setItem(BLE_STORE, JSON.stringify(cur));
    } catch (e) { /* senza localStorage la stampante non viene ricordata */ }
  }
  function bleClear() {
    try { global.localStorage.removeItem(BLE_STORE); } catch (e) { /* niente da fare */ }
  }

  function bleInfo() {
    var d = bleState.device, c = bleState.char, saved = bleSaved() || {};
    return {
      status: bleState.status,
      name: d ? (d.name || saved.name || message('unnamedPrinter')) : (saved.name || null),
      paired: !!d,
      connected: !!(d && d.gatt && d.gatt.connected),
      profile: bleState.profile,
      characteristic: c ? c.uuid : null,
      writeMode: saved.writeMode || 'auto',
      chunk: saved.chunk || null,
      remembered: !!saved.name,
      lastError: bleState.lastError ? (bleState.lastError.message || String(bleState.lastError)) : null
    };
  }

  function bleSetStatus(status, err) {
    bleState.status = status;
    bleState.lastError = err || null;
    var info = bleInfo();
    bleState.listeners.slice().forEach(function (fn) { try { fn(info); } catch (e) { /* ascoltatore rotto */ } });
  }

  function bleOnDisconnect() {
    bleState.server = null;
    bleState.char = null;
    bleState.service = null;
    bleState.notifyChar = null;
    if (bleState.status !== 'idle') bleSetStatus('disconnected');
  }

  function bleAdopt(device) {
    if (bleState.device === device) return;
    var old = bleState.device;
    if (old) {
      try { old.removeEventListener('gattserverdisconnected', bleOnDisconnect); } catch (e) { /* vecchio dispositivo */ }
      try { if (old.gatt.connected) old.gatt.disconnect(); } catch (e) { /* gia scollegato */ }
    }
    bleState.device = device;
    bleState.server = null;
    bleState.char = null;
    bleState.profile = null;
    bleState.service = null;
    bleState.notifyChar = null;
    device.addEventListener('gattserverdisconnected', bleOnDisconnect);
  }

  function withTimeout(promise, ms, what) {
    var timer;
    return Promise.race([
      promise,
      new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          reject(bleError('timeout', message('noAnswerS', { what: what, s: Math.round(ms / 1000) })));
        }, ms);
      })
    ]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  // Solo la connessione GATT, senza scegliere il canale (serve anche alla diagnostica).
  function bleConnectRaw() {
    var d = bleState.device;
    if (!d) return Promise.reject(bleError('no-device', message('noPrinterPaired')));
    if (d.gatt.connected && bleState.server) return Promise.resolve(bleState.server);
    bleSetStatus('connecting');
    return withTimeout(d.gatt.connect(), 20000, message('connectingPrinter')).then(function (server) {
      bleState.server = server;
      return server;
    }, function (e) {
      try { d.gatt.disconnect(); } catch (x) { /* niente da chiudere */ }
      throw e;
    });
  }

  function writable(c) {
    return !!(c && c.properties && (c.properties.write || c.properties.writeWithoutResponse));
  }

  // Sceglie il canale di stampa: prima quello scelto a mano dall'utente, poi i profili noti.
  function blePick(server) {
    var saved = bleSaved() || {};
    var d = bleState.device;
    var override = saved.service && saved.characteristic && (!saved.name || saved.name === d.name)
      ? { service: saved.service, char: saved.characteristic } : null;
    return server.getPrimaryServices().then(function (services) {
      var byUuid = {};
      services.forEach(function (s) { byUuid[s.uuid] = s; });
      var tries = [];
      if (override && byUuid[override.service]) {
        tries.push({ name: 'scelto a mano', service: byUuid[override.service], write: override.char });
      }
      BLE_PROFILES.forEach(function (p) {
        if (byUuid[p.service]) tries.push({ name: p.name, service: byUuid[p.service], write: p.write });
      });
      function next(i) {
        if (i >= tries.length) {
          if (byUuid[BLE_CAT_SERVICE]) {
            throw bleError('cat-printer', message('catPrinter'));
          }
          throw bleError('no-channel', message('noChannel', {
            list: services.map(function (s) { return s.uuid; }).join(', ') || message('none') }));
        }
        var t = tries[i];
        return t.service.getCharacteristic(t.write).then(function (c) {
          if (writable(c)) return { profile: t.name, char: c, service: t.service };
          throw new Error('non scrivibile');
        }).catch(function () {
          // UUID atteso assente: prende la prima caratteristica scrivibile dello stesso servizio.
          return t.service.getCharacteristics().then(function (list) {
            var c = list.filter(writable)[0];
            if (c) return { profile: t.name, char: c, service: t.service };
            return next(i + 1);
          }, function () { return next(i + 1); });
        });
      }
      return next(0);
    }).then(function (found) {
      bleState.char = found.char;
      bleState.profile = found.profile;
      bleState.service = found.service;
      return found;
    });
  }

  // The channel a printer driver needs (Phomemo: service FF00, write FF02), whatever profile
  // blePick chose when pairing: some modules also expose other serial services.
  function bleUseChannel(serviceUuid, writeUuid, label) {
    if (bleState.char && bleState.service && bleState.service.uuid === serviceUuid && bleState.char.uuid === writeUuid) {
      return Promise.resolve();
    }
    // Missing (NotFoundError) or not declared to the browser (SecurityError) is no-channel;
    // anything else, such as a dropped link (NetworkError), keeps its own error.
    function missing(what, e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'SecurityError')) {
        return bleError('no-channel', message('notFoundOnPrinter', { what: what, detail: (e && e.message) || e }));
      }
      return e;
    }
    return bleState.server.getPrimaryService(serviceUuid).then(function (s) {
      return s.getCharacteristic(writeUuid).then(function (c) {
        if (!writable(c)) throw bleError('no-channel', message('notWritable', { uuid: writeUuid }));
        if (bleState.notifyChar && bleState.service !== s) bleState.notifyChar = null;
        bleState.service = s;
        bleState.char = c;
        bleState.profile = label;
      }, function (e) { throw missing('characteristic ' + writeUuid, e); });
    }, function (e) { throw missing('service ' + serviceUuid, e); });
  }

  // Notifications from the printer (Phomemo: FF03): credits, status, "print complete". They
  // may be refused (on some systems they need OS pairing): then the result is false and the
  // driver falls back to timers. Every frame goes to bleState.frameListeners as bytes.
  function bleFrame(ev) {
    var v = ev && ev.target && ev.target.value;
    if (!v || typeof v.getUint8 !== 'function') return;
    var bytes = [];
    for (var i = 0; i < v.byteLength; i++) bytes.push(v.getUint8(i));
    bleState.frameListeners.slice().forEach(function (fn) { try { fn(bytes); } catch (e) { /* listener */ } });
  }

  function bleNotify(uuid) {
    if (bleState.notifyChar && bleState.notifyChar.uuid === uuid) return Promise.resolve(true);
    var s = bleState.service;
    if (!s || !uuid) return Promise.resolve(false);
    return s.getCharacteristic(uuid).then(function (c) {
      var p = c.properties || {};
      if (!p.notify && !p.indicate) return false;
      // Bounded: a CCCD write left pending (pairing, encryption) must not block the queue.
      return withTimeout(c.startNotifications(), 10000, message('notificationsOn', { uuid: uuid })).then(function () {
        c.addEventListener('characteristicvaluechanged', bleFrame);
        bleState.notifyChar = c;
        return true;
      });
    }).catch(function () { return false; });
  }

  function bleListen(fn) {
    bleState.frameListeners.push(fn);
    return function () { bleState.frameListeners = bleState.frameListeners.filter(function (f) { return f !== fn; }); };
  }

  function hasSequence(bytes, seq) {
    for (var i = 0; i + seq.length <= bytes.length; i++) {
      var j = 0;
      while (j < seq.length && bytes[i + j] === seq[j]) j++;
      if (j === seq.length) return true;
    }
    return false;
  }

  function bleConnect() {
    if (bleState.device && bleState.device.gatt.connected && bleState.char) return Promise.resolve();
    return bleConnectRaw().then(blePick).then(function () {
      bleSetStatus('ready');
    }, function (e) {
      bleSetStatus('error', e);
      throw e;
    });
  }

  // Un collegamento caduto (stampante appena risvegliata dall'auto-sleep) si ritenta una
  // volta; un timeout no, altrimenti l'errore arriverebbe dopo oltre 40 s.
  function bleEnsure() {
    return bleConnect().catch(function (e) {
      if (!bleState.device || !e || e.name !== 'NetworkError') throw e;
      return delay(1500).then(bleConnect);
    });
  }

  function writeOne(c, piece, withResponse) {
    if (withResponse) return c.writeValueWithResponse ? c.writeValueWithResponse(piece) : c.writeValue(piece);
    return c.writeValueWithoutResponse ? c.writeValueWithoutResponse(piece) : c.writeValue(piece);
  }

  // Scrive a pezzi, una scrittura alla volta. Automatico: con conferma da 100 byte se la
  // caratteristica lo permette (se la stampante li rifiuta si scende a 20), altrimenti senza
  // conferma da 20 byte con 20 ms di pausa e l'ultimo pezzo con conferma quando possibile.
  // Le modalita scelte a mano si applicano alla lettera, anche all'ultimo pezzo.
  function bleWrite(bytes, onProgress) {
    var c = bleState.char;
    var props = c.properties || {};
    var saved = bleSaved() || {};
    var mode = saved.writeMode || 'auto';
    var withResp, chunk, pause;
    if (mode === 'noresponse-20' && props.writeWithoutResponse) { withResp = false; chunk = 20; pause = 20; }
    else if (mode === 'response-20' && props.write) { withResp = true; chunk = 20; pause = 0; }
    else if (mode === 'response-100' && props.write) { withResp = true; chunk = 100; pause = 0; }
    else if (props.write) { withResp = true; chunk = saved.chunk === 20 ? 20 : 100; pause = 0; }
    else { withResp = false; chunk = 20; pause = 20; }
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var off = 0, retries = 0, t0 = Date.now();
    function step() {
      if (off >= data.length) {
        // La stampante deve finire di ricevere: niente altro sul collegamento per un attimo.
        return delay(300).then(function () {
          return { ok: true, bytes: data.length, ms: Date.now() - t0, chunk: chunk, withResponse: withResp };
        });
      }
      var piece = data.slice(off, off + chunk);
      var last = off + piece.length >= data.length;
      var resp = withResp || (mode === 'auto' && last && !!props.write);
      return writeOne(c, piece, resp).then(function () {
        off += piece.length;
        retries = 0;
        if (onProgress) { try { onProgress(off, data.length); } catch (e) { /* callback della pagina */ } }
        return pause && !last ? delay(pause).then(step) : step();
      }, function (e) {
        var msg = (e && e.message) || '';
        var transient = /operation failed for unknown reason|already in progress/i.test(msg);
        if (transient && retries < 3) {
          // Il pezzo non e partito (collegamento occupato): si ritenta lo stesso pezzo.
          retries++;
          return delay(80 * retries).then(step);
        }
        var connected = bleState.device && bleState.device.gatt.connected;
        if (off === 0 && withResp && chunk > 20 && connected &&
            (e.name === 'NotSupportedError' || e.name === 'InvalidModificationError' || transient)) {
          // Primo pezzo rifiutato anche dopo i tentativi (spesso una scrittura lunga che il
          // firmware non gestisce): con conferma non e stato stampato nulla, si scende a 20 byte.
          chunk = 20;
          retries = 0;
          if (mode === 'auto') bleSave({ chunk: 20 });
          return step();
        }
        throw e;
      });
    }
    return step();
  }

  // Status frames a Phomemo printer sends on its own while printing (1A type value).
  var PRINTER_WARNINGS = [
    { seq: [0x1A, 0x06, 0x88], code: 'paper-out' },
    { seq: [0x1A, 0x05, 0x99], code: 'cover-open' },
    { seq: [0x1A, 0x03, 0xA9], code: 'too-hot' }
  ];

  // Writing for a printer driver (transport t): never the ESC/POS auto mode. Fixed chunks
  // without response (with response only if the characteristic has no write-without-response)
  // and a pause after each one, or, with flow 'credits', one chunk for each "01 01" credit the
  // printer sends (t.initialCredits to start; after t.creditTimeout ms with no credit it goes
  // back to pauses). Then, if t.done is set, it waits for that frame (Phomemo: 1A 0F 0C, "print
  // complete") until doneTimeout; without notifications it waits t.tailWait ms instead.
  function bleWritePaced(bytes, onProgress, t, rows, notifyOn) {
    var c = bleState.char, dev0 = bleState.device;
    var props = c.properties || {};
    var withResp = (!!t.withResponse && !!props.write) || !props.writeWithoutResponse;
    var chunk = Math.max(20, Math.min(t.maxChunk || 182, t.chunk || 128));
    var pause = t.delay == null ? 20 : t.delay;
    var credits = notifyOn && t.flow === 'credits' ? (t.initialCredits || 4) : -1;
    // Without credits (no notifications, or none in time) back to the tested 128 B / 20 ms:
    // 182 B chunks are only safe while the printer gates them.
    var fallbackChunk = Math.max(20, Math.min(chunk, t.fallbackChunk || 128));
    if (t.flow === 'credits' && credits < 0) chunk = fallbackChunk;
    var waiting = null, warnings = [], frames = 0;
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var off = 0, retries = 0, t0 = Date.now(), flow = credits >= 0 ? 'credits' : 'delay';
    var stop = bleListen(function (f) {
      frames++;
      if (f.length === 2 && f[0] === 0x01 && f[1] === 0x01 && credits >= 0) {
        credits++;
        if (waiting) { var w = waiting; waiting = null; w(); }
      }
      PRINTER_WARNINGS.forEach(function (pw) {
        if (hasSequence(f, pw.seq) && warnings.indexOf(pw.code) < 0) warnings.push(pw.code);
      });
    });
    function credit() {
      if (credits < 0) return Promise.resolve();
      if (credits > 0) { credits--; return Promise.resolve(); }
      return new Promise(function (resolve) {
        var timer = setTimeout(function () {
          // No credit in time: this printer (or this browser) does not send them.
          waiting = null;
          credits = -1;
          chunk = fallbackChunk;
          flow = 'credits+delay';
          resolve();
        }, t.creditTimeout || 1500);
        waiting = function () { clearTimeout(timer); credits--; resolve(); };
      });
    }
    function step() {
      if (off >= data.length) return Promise.resolve();
      var piece = null;
      // The chunk is cut after the credit: if credits stopped, it is already the fallback size.
      return credit().then(function () {
        piece = data.slice(off, off + chunk);
        return writeOne(c, piece, withResp);
      }).then(function () {
        off += piece.length;
        retries = 0;
        if (onProgress) { try { onProgress(off, data.length); } catch (e) { /* page callback */ } }
        return credits < 0 && pause ? delay(pause).then(step) : step();
      }, function (e) {
        var msg = (e && e.message) || '';
        if (/operation failed for unknown reason|already in progress/i.test(msg) && retries < 3) {
          // Not sent (link busy): the same chunk again; credits are not consumed twice.
          retries++;
          if (credits >= 0) credits++;
          return delay(80 * retries).then(step);
        }
        throw e;
      });
    }
    function finish() {
      if (!t.done || !notifyOn) {
        return delay(t.tailWait == null ? 300 : t.tailWait).then(function () { return null; });
      }
      // Gone (or replaced) before the wait starts, for example in the pause after the last
      // chunk: its disconnection event has already fired, so do not wait for it.
      var dev = bleState.device;
      if (!dev || dev !== dev0 || !dev.gatt || !dev.gatt.connected) return Promise.resolve(false);
      // Only frames that arrive after the last write count: a late one from an earlier job
      // is already past.
      return new Promise(function (resolve) {
        var limit = Math.round((t.doneBase == null ? 10000 : t.doneBase) + (rows || 0) * (t.donePerRow == null ? 40 : t.donePerRow));
        var settled = false;
        function end(v) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          off2();
          try { if (dev) dev.removeEventListener('gattserverdisconnected', lost); } catch (e) { /* gone */ }
          resolve(v);
        }
        // The printer went away (sleep, power off, out of range): no signal will come.
        function lost() { end(false); }
        var timer = setTimeout(function () { end(false); }, limit);
        var off2 = bleListen(function (f) { if (hasSequence(f, t.done)) end(true); });
        try { if (dev) dev.addEventListener('gattserverdisconnected', lost); } catch (e) { /* no events */ }
      });
    }
    return step().then(finish).then(function (done) {
      stop();
      return {
        ok: true, bytes: data.length, ms: Date.now() - t0, chunk: chunk, withResponse: withResp,
        flow: flow, notifications: !!notifyOn, done: done, warnings: warnings, frames: frames
      };
    }, function (e) {
      stop();
      throw e;
    });
  }

  function bleWaitAdvertisement(d, ms) {
    if (!d.watchAdvertisements) return Promise.resolve();
    return new Promise(function (resolve) {
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        try { d.removeEventListener('advertisementreceived', finish); } catch (e) { /* niente */ }
        try { if (ctl) ctl.abort(); } catch (e) { /* niente */ }
        resolve();
      }
      d.addEventListener('advertisementreceived', finish);
      setTimeout(finish, ms);
      try {
        var p = d.watchAdvertisements(ctl ? { signal: ctl.signal } : undefined);
        if (p && p.catch) p.catch(finish);
      } catch (e) { finish(); }
    });
  }

  RawBT.ble = {
    profiles: BLE_PROFILES,
    optionalServices: BLE_OPTIONAL,
    // Web Bluetooth c'e (Chrome Android e desktop; non Safari iOS ne Firefox).
    supported: function () {
      return !!(global.navigator && global.navigator.bluetooth && global.navigator.bluetooth.requestDevice);
    },
    // Radio Bluetooth presente (null se non si puo sapere).
    available: function () {
      var b = global.navigator && global.navigator.bluetooth;
      if (!b || !b.getAvailability) return Promise.resolve(null);
      return b.getAvailability().catch(function () { return null; });
    },
    // Il browser puo ricordare la stampante tra una visita e l'altra (getDevices). Su Chrome
    // stabile richiede chrome://flags/#enable-web-bluetooth-new-permissions-backend.
    canRemember: function () {
      var b = global.navigator && global.navigator.bluetooth;
      return !!(b && typeof b.getDevices === 'function');
    },
    saved: bleSaved,
    info: bleInfo,
    on: function (fn) {
      bleState.listeners.push(fn);
      return function () { bleState.listeners = bleState.listeners.filter(function (f) { return f !== fn; }); };
    },
    // Va chiamata DIRETTAMENTE nel gestore di un tocco: il chooser richiede un gesto utente.
    // opts.sameName: solo la stampante gia usata (un tocco); opts.all: tutti i dispositivi.
    pair: function (opts) {
      opts = opts || {};
      if (!RawBT.ble.supported()) {
        return Promise.reject(bleError('unsupported', message('bleUnsupported')));
      }
      var saved = bleSaved() || {};
      var options = opts.all
        ? { acceptAllDevices: true, optionalServices: BLE_OPTIONAL }
        : (opts.sameName && saved.name)
          ? { filters: [{ name: saved.name }], optionalServices: BLE_OPTIONAL }
          : { filters: BLE_FILTERS, optionalServices: BLE_OPTIONAL };
      var req;
      try {
        req = global.navigator.bluetooth.requestDevice(options);
      } catch (e) {
        return Promise.reject(e);
      }
      return req.then(function (device) {
        // Un'altra stampante: le scelte manuali fatte per la precedente non valgono piu.
        if (saved.name && device.name && saved.name !== device.name) bleClear();
        bleAdopt(device);
        bleSave({ name: device.name || null, id: device.id });
        return bleEnsure();
      }).then(bleInfo);
    },
    // Senza gesto: riusa la stampante di questa pagina o, se il browser lo permette, quella
    // ricordata. Restituisce null se serve un tocco (pair con sameName).
    reconnect: function () {
      if (bleState.device) return bleEnsure().then(bleInfo);
      var saved = bleSaved();
      if (!saved || !RawBT.ble.canRemember()) return Promise.resolve(null);
      return global.navigator.bluetooth.getDevices().then(function (list) {
        var d = list.filter(function (x) { return saved.id && x.id === saved.id; })[0] ||
          list.filter(function (x) { return saved.name && x.name === saved.name; })[0];
        if (!d) return null;
        bleAdopt(d);
        return bleWaitAdvertisement(d, 8000).then(bleEnsure).then(bleInfo);
      });
    },
    // Stampa i byte ESC/POS. opts.onProgress(inviati, totali). Le stampe vanno in coda.
    // opts.transport (from a printer driver, see PrintBridge.drivers) replaces the ESC/POS
    // write modes: its channel, notifications, chunk, pause or credits and "print complete";
    // opts.rows (image height) sets how long to wait for that signal.
    print: function (bytes, opts) {
      opts = opts || {};
      var t = opts.transport || null;
      function job() {
        if (!bleState.device) return Promise.reject(bleError('no-device', message('noPrinterPaired')));
        return bleEnsure().then(function () {
          if (!t) return null;
          return (t.service && t.write ? bleUseChannel(t.service, t.write, t.label || 'driver') : Promise.resolve())
            .then(function () { return t.notify ? bleNotify(t.notify) : false; });
        }).then(function (notifyOn) {
          bleSetStatus('printing');
          return t ? bleWritePaced(bytes, opts.onProgress, t, opts.rows, notifyOn) : bleWrite(bytes, opts.onProgress);
        }).then(function (r) {
          // The printer may have gone away while we waited for "print complete".
          bleSetStatus(bleState.device && bleState.device.gatt.connected ? 'ready' : 'disconnected');
          return r;
        }, function (e) {
          var connected = bleState.device && bleState.device.gatt.connected;
          bleSetStatus(connected ? 'ready' : 'disconnected', e);
          throw e;
        });
      }
      var p = bleState.queue.then(job, job);
      bleState.queue = p.catch(function () {});
      return p;
    },
    // Phomemo M02 family only: firmware, battery, paper, cover and temperature, asked with the
    // five read-only status queries 1F 11 07/08/11/12/13 and nothing else (an unknown 1F 11
    // opcode has been reported to brick an M02X). Needs notifications on FF03. Queued like a
    // print. Result: { firmware, battery, paper: 'ok'|'out', cover: 'closed'|'open',
    // temperature: 'ok'|'hot', raw (bytes received) } with null for what did not answer.
    phomemoStatus: function () {
      function job() {
        if (!bleState.device) return Promise.reject(bleError('no-device', message('noPrinterPaired')));
        var all = [], stop = null;
        return bleEnsure().then(function () {
          return bleUseChannel(PHOMEMO_SERVICE, PHOMEMO_WRITE, 'Phomemo');
        }).then(function () {
          return bleNotify(PHOMEMO_NOTIFY);
        }).then(function (on) {
          if (!on) throw bleError('no-notify', message('noNotify'));
          stop = bleListen(function (f) { all.push.apply(all, f); });
          var c = bleState.char, props = c.properties || {};
          var chain = Promise.resolve();
          PHOMEMO_QUERIES.forEach(function (op) {
            chain = chain.then(function () {
              return writeOne(c, new Uint8Array([0x1F, 0x11, op]), !props.writeWithoutResponse);
            }).then(function () { return delay(300); });
          });
          return chain.then(function () { return delay(700); });
        }).then(function () {
          if (stop) stop();
          return parsePhomemoStatus(all);
        }, function (e) {
          if (stop) stop();
          throw e;
        });
      }
      var p = bleState.queue.then(job, job);
      bleState.queue = p.catch(function () {});
      return p;
    },
    disconnect: function () {
      var d = bleState.device;
      try { if (d && d.gatt.connected) d.gatt.disconnect(); } catch (e) { /* gia scollegata */ }
      bleSetStatus('disconnected');
    },
    // Dimentica la stampante (anche nel browser, se supportato).
    forget: function () {
      var d = bleState.device;
      bleClear();
      if (d) {
        try { d.removeEventListener('gattserverdisconnected', bleOnDisconnect); } catch (e) { /* niente */ }
        try { if (d.gatt.connected) d.gatt.disconnect(); } catch (e) { /* niente */ }
      }
      bleState.device = null;
      bleState.server = null;
      bleState.char = null;
      bleState.profile = null;
      bleState.service = null;
      bleState.notifyChar = null;
      bleSetStatus('idle');
      return d && d.forget ? d.forget().catch(function () {}) : Promise.resolve();
    },
    // Diagnostica: servizi e caratteristiche visibili, con le proprieta.
    describe: function () {
      return bleConnectRaw().then(function (server) {
        return server.getPrimaryServices();
      }).then(function (services) {
        return Promise.all(services.map(function (s) {
          return s.getCharacteristics().then(function (list) {
            return {
              service: s.uuid,
              characteristics: list.map(function (c) {
                var p = c.properties || {};
                return { uuid: c.uuid, write: !!p.write, writeWithoutResponse: !!p.writeWithoutResponse, notify: !!p.notify, read: !!p.read };
              })
            };
          }, function () { return { service: s.uuid, characteristics: [] }; });
        }));
      }).then(function (list) {
        if (bleState.char) bleSetStatus('ready');
        else bleSetStatus('connected');
        return list;
      });
    },
    // Scelta manuale del canale (dalla diagnostica), ricordata per questa stampante.
    useCharacteristic: function (serviceUuid, charUuid) {
      bleSave({ service: serviceUuid, characteristic: charUuid, chunk: null });
      bleState.char = null;
      if (!bleState.server) return Promise.resolve(bleInfo());
      return blePick(bleState.server).then(function () { bleSetStatus('ready'); return bleInfo(); });
    },
    // 'auto' | 'response-100' | 'response-20' | 'noresponse-20'
    setWriteMode: function (mode) {
      bleSave({ writeMode: mode, chunk: null });
      bleSetStatus(bleState.status, bleState.lastError);
    },
    // Messaggio comprensibile per un errore di Web Bluetooth ('' = annullato dall'utente).
    explain: function (e) {
      var name = (e && e.name) || '', msg = (e && e.message) || String(e || ''), code = e && e.code;
      if (code === 'cat-printer') return message('explainCat');
      if (code === 'no-channel') return message('explainNoChannel', { detail: msg });
      if (code === 'unsupported') return message('explainUnsupported');
      if (code === 'timeout') return message('explainTimeout', { detail: msg });
      if (code === 'no-notify') return message('explainNoNotify');
      if (name === 'NotFoundError' && /cancel/i.test(msg)) return '';
      if (name === 'NotFoundError' && /permission|location|scan/i.test(msg)) return message('explainLocation');
      if (name === 'NotFoundError') return message('explainNotFound', { detail: msg });
      if (name === 'SecurityError') return message('explainGesture');
      if (name === 'NetworkError') return message('explainNetwork', { detail: msg });
      if (name === 'NotSupportedError') return message('explainNotSupported', { detail: msg });
      return msg;
    }
  };

  // --- Direct printing over Web Serial (computers: USB-serial and Bluetooth Classic) ---
  // Chrome and Edge on a computer open serial ports: USB-serial printers and, since Chrome 117,
  // Bluetooth Classic printers paired in the system (Serial Port Profile over RFCOMM). The bytes
  // are the same ESC/POS as for the app, written in 256 B chunks with 25 ms pauses as the app
  // does over SPP. Chrome remembers the ports a site was given, so reconnect() needs no tap.
  var SERIAL_SPP = '00001101-0000-1000-8000-00805f9b34fb';
  var SERIAL_STORE = 'printbridge.serial';
  var SERIAL_BAUDS = [9600, 19200, 38400, 57600, 115200];
  var SERIAL_CHUNK = 256, SERIAL_PAUSE = 25;
  var serialState = { port: null, status: 'idle', lastError: null, listeners: [], queue: Promise.resolve(), watching: false };

  function serialError(code, key, params) {
    var e = new Error(message(key, params));
    e.name = 'PrintBridgeSerialError';
    e.code = code;
    return e;
  }
  function serialWrap(code, e) {
    var err = new Error((e && e.message) || String(e));
    err.name = 'PrintBridgeSerialError';
    err.code = code;
    err.cause = e;
    return err;
  }
  function serialSaved() {
    try {
      var s = global.localStorage && global.localStorage.getItem(SERIAL_STORE);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }
  function serialSave(patch) {
    try {
      var cur = serialSaved() || {};
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k];
      global.localStorage.setItem(SERIAL_STORE, JSON.stringify(cur));
    } catch (e) { /* without localStorage the port is not remembered by the page */ }
  }
  function serialClear() {
    try { global.localStorage.removeItem(SERIAL_STORE); } catch (e) { /* nothing stored */ }
  }
  function portInfo(port) {
    try { return port && typeof port.getInfo === 'function' ? port.getInfo() : {}; } catch (e) { return {}; }
  }
  function hex4(n) {
    var s = Number(n).toString(16).toUpperCase();
    while (s.length < 4) s = '0' + s;
    return s;
  }
  function portLabel(info) {
    if (!info) return null;
    if (info.bluetoothServiceClassId) {
      return 'Bluetooth ' + (info.bluetoothServiceClassId === SERIAL_SPP ? 'SPP' : info.bluetoothServiceClassId);
    }
    if (info.usbVendorId != null) return 'USB ' + hex4(info.usbVendorId) + ':' + hex4(info.usbProductId || 0);
    return message('serialPort');
  }
  function sameInfo(a, b) {
    if (!a || !b) return false;
    if (a.bluetoothServiceClassId || b.bluetoothServiceClassId) return a.bluetoothServiceClassId === b.bluetoothServiceClassId;
    return a.usbVendorId != null && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
  }

  function serialInfo() {
    var p = serialState.port, saved = serialSaved() || {};
    return {
      status: serialState.status,
      paired: !!p,
      connected: !!(p && p.writable),
      label: p ? portLabel(portInfo(p)) : portLabel(saved.info),
      baudRate: saved.baudRate || 9600,
      remembered: !!saved.info,
      lastError: serialState.lastError ? (serialState.lastError.message || String(serialState.lastError)) : null
    };
  }

  function serialSetStatus(status, err) {
    serialState.status = status;
    serialState.lastError = err || null;
    var info = serialInfo();
    serialState.listeners.slice().forEach(function (fn) { try { fn(info); } catch (e) { /* listener */ } });
  }

  // An unplugged USB printer or a dropped Bluetooth link fires "disconnect" on navigator.serial.
  function serialWatch() {
    var s = global.navigator && global.navigator.serial;
    if (serialState.watching || !s || typeof s.addEventListener !== 'function') return;
    serialState.watching = true;
    s.addEventListener('disconnect', function (ev) {
      if (ev && ev.target === serialState.port) serialSetStatus('disconnected');
    });
  }

  function serialAdopt(port) {
    var old = serialState.port;
    if (old && old !== port) {
      try { var c = old.close(); if (c && c.catch) c.catch(function () {}); } catch (e) { /* already closed */ }
    }
    serialState.port = port;
    serialSave({ info: portInfo(port) });
    serialWatch();
  }

  function serialOpen() {
    var p = serialState.port;
    if (!p) return Promise.reject(serialError('no-port', 'noPort'));
    if (p.writable) return Promise.resolve();
    var saved = serialSaved() || {};
    serialSetStatus('connecting');
    return Promise.resolve().then(function () {
      return p.open({ baudRate: saved.baudRate || 9600 });
    }).then(function () {
      serialSetStatus('ready');
    }, function (e) {
      // Already open (InvalidStateError), for example by another tab of this page.
      if (p.writable) { serialSetStatus('ready'); return; }
      var err = serialWrap('open', e);
      serialSetStatus('error', err);
      throw err;
    });
  }

  function serialWrite(bytes, onProgress) {
    var p = serialState.port;
    if (!p || !p.writable) return Promise.reject(serialError('closed', 'explainSerialLost'));
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var writer = p.writable.getWriter(), off = 0, t0 = Date.now();
    function release() { try { writer.releaseLock(); } catch (e) { /* already released */ } }
    function step() {
      if (off >= data.length) return Promise.resolve();
      var piece = data.slice(off, off + SERIAL_CHUNK);
      return writer.write(piece).then(function () {
        off += piece.length;
        if (onProgress) { try { onProgress(off, data.length); } catch (e) { /* page callback */ } }
        return off < data.length ? delay(SERIAL_PAUSE).then(step) : null;
      });
    }
    return step().then(function () {
      release();
      return { ok: true, bytes: data.length, ms: Date.now() - t0, chunk: SERIAL_CHUNK };
    }, function (e) {
      release();
      throw serialWrap('write', e);
    });
  }

  function serialQueue(job) {
    var q = serialState.queue.then(job, job);
    serialState.queue = q.catch(function () {});
    return q;
  }

  RawBT.serial = {
    spp: SERIAL_SPP,
    bauds: SERIAL_BAUDS,
    // Web Serial is there (Chrome and Edge on a computer; not Android, iOS, Firefox, Safari).
    supported: function () {
      var s = global.navigator && global.navigator.serial;
      return !!(s && typeof s.requestPort === 'function');
    },
    saved: serialSaved,
    info: serialInfo,
    on: function (fn) {
      serialState.listeners.push(fn);
      return function () { serialState.listeners = serialState.listeners.filter(function (f) { return f !== fn; }); };
    },
    // Call it directly in the tap handler: Chrome's port chooser needs a user gesture. opts:
    // filters (usbVendorId/usbProductId, as in the Web Serial API), bluetoothServiceClassIds
    // besides the Serial Port Profile, baudRate.
    pair: function (opts) {
      opts = opts || {};
      if (!RawBT.serial.supported()) return Promise.reject(serialError('unsupported', 'serialUnsupported'));
      if (opts.baudRate != null && SERIAL_BAUDS.indexOf(parseInt(opts.baudRate, 10)) < 0) {
        return Promise.reject(serialError('baud', 'badBaud', { list: SERIAL_BAUDS.join(', ') }));
      }
      var req;
      try {
        req = global.navigator.serial.requestPort({
          filters: opts.filters || [],
          allowedBluetoothServiceClassIds: [SERIAL_SPP].concat(opts.bluetoothServiceClassIds || [])
        });
      } catch (e) {
        return Promise.reject(e);
      }
      return req.then(function (port) {
        serialAdopt(port);
        if (opts.baudRate != null) serialSave({ baudRate: parseInt(opts.baudRate, 10) });
        return serialOpen();
      }).then(serialInfo);
    },
    // Without a tap: the port of this page, or the one Chrome remembers for this site. null
    // when a tap is needed (pair).
    reconnect: function () {
      if (serialState.port) return serialOpen().then(serialInfo);
      var s = global.navigator && global.navigator.serial;
      if (!s || typeof s.getPorts !== 'function') return Promise.resolve(null);
      var saved = serialSaved();
      return s.getPorts().then(function (ports) {
        var p = ports.filter(function (x) { return sameInfo(portInfo(x), saved && saved.info); })[0] ||
          (ports.length === 1 ? ports[0] : null);
        if (!p) return null;
        serialAdopt(p);
        return serialOpen().then(serialInfo);
      });
    },
    // The ESC/POS bytes, queued like RawBT.ble.print. opts.onProgress(sent, total).
    print: function (bytes, opts) {
      opts = opts || {};
      return serialQueue(function () {
        if (!serialState.port) return Promise.reject(serialError('no-port', 'noPort'));
        return serialOpen().then(function () {
          serialSetStatus('printing');
          return serialWrite(bytes, opts.onProgress);
        }).then(function (r) {
          serialSetStatus('ready');
          return r;
        }, function (e) {
          serialSetStatus(serialState.port && serialState.port.writable ? 'ready' : 'disconnected', e);
          throw e;
        });
      });
    },
    // Speed of the port, one of RawBT.serial.bauds (USB-serial printers; Bluetooth ports ignore
    // it). The open port is closed and reopened with it at the next print.
    setBaudRate: function (n) {
      var b = parseInt(n, 10);
      if (SERIAL_BAUDS.indexOf(b) < 0) return Promise.reject(serialError('baud', 'badBaud', { list: SERIAL_BAUDS.join(', ') }));
      serialSave({ baudRate: b });
      return RawBT.serial.disconnect().then(function () { return b; });
    },
    // Closes the port (after the queued prints); the printer stays chosen for reconnect().
    disconnect: function () {
      return serialQueue(function () {
        var p = serialState.port;
        if (!p) return null;
        if (!p.writable && !p.readable) { serialSetStatus('disconnected'); return null; }
        return Promise.resolve().then(function () { return p.close(); }).then(null, function () { /* already closed */ })
          .then(function () { serialSetStatus('disconnected'); });
      });
    },
    // Closes the port and forgets it, also in the browser when supported.
    forget: function () {
      var p = serialState.port;
      return RawBT.serial.disconnect().then(function () {
        serialClear();
        serialState.port = null;
        serialSetStatus('idle');
        return p && typeof p.forget === 'function' ? p.forget().catch(function () {}) : null;
      });
    },
    // Message for an error of Web Serial ('' = the person closed the port chooser).
    explain: function (e) {
      var name = (e && e.name) || '', msg = (e && e.message) || String(e || ''), code = e && e.code;
      if (code === 'unsupported') return message('serialUnsupported');
      if (code === 'open') return message('explainSerialOpen', { detail: msg });
      if (code === 'no-port' || code === 'closed') return message('explainSerialLost');
      if (code === 'write') return message('explainSerialWrite', { detail: msg });
      if (code === 'baud') return msg;
      if (name === 'NotFoundError') return '';
      if (name === 'SecurityError') return message('explainGesture');
      return msg;
    }
  };

  // --- Print layouts (PrintBridge.render) ---
  // A layout is a JSON object { paper, columns, codepage, defaults, prepare, blocks } that
  // describes a receipt once; on every print the data fills its {{field|filter}} placeholders.
  // The same bytes go to RawBT.ble.print and to RawBT.sendApi. No eval: layouts may come from a
  // server, so placeholders only read own properties of the data, filters and data preparations
  // are functions registered by the page, and control characters in the data are dropped (they
  // cannot turn into printer commands).
  var PAPERS = { 58: { cols: 32, dots: 384 }, 80: { cols: 48, dots: 576 } };
  var LOGO_MAX_HEIGHT = 240, LOGO_BAND = 128, LOGO_THRESHOLD = 140, LOGO_TIMEOUT = 10000;
  var CACHE_MAX = 16, MAX_DEPTH = 16;
  var DATE_FORMAT = 'dd/MM/yyyy HH:mm';
  var STYLE_PLAIN = { align: 'left', bold: false, ul: false, w: 1, h: 1 };
  var STYLE_CENTER = { align: 'center', bold: false, ul: false, w: 1, h: 1 };
  var ALIGNS = ['left', 'center', 'right'];
  var QR_EC = { L: 0x30, M: 0x31, Q: 0x32, H: 0x33 };
  var PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
  var VIA_STORE = 'printbridge.via';

  // Every message of the layout API that people may read, in one table so that it can be
  // translated (PrintBridge.messages). {name} is replaced with the value of that name.
  var MESSAGES = {
    corsHint: 'the server must allow CORS (Access-Control-Allow-Origin header); otherwise serve ' +
      'the logo from the same site as the page or pass it as a data URL',
    unknownFilter: 'Unknown filter "{name}" in {expr}',
    badCondition: '{where}: invalid condition "{expr}"',
    badBlocks: '{where} must be a list of blocks',
    tooDeep: '{where}: too many nested levels',
    badBlock: '{where}: invalid block ({block})',
    unknownBlock: '{where}: unknown block ({block})',
    badRow: '{where}: row must be a list of columns',
    badAlign: '{where}: align must be left, center or right',
    badSize: '{where}: size must be [width, height]',
    badEc: '{where}: ec must be L, M, Q or H',
    badRaw: '{where}: raw must be a list of bytes',
    badPaper: 'paper must be 58 or 80 (mm), or 384 or 576 (dots)',
    badJson: 'The layout is not valid JSON: {detail}',
    unknownLayout: 'Unknown layout "{name}" (built in: {list})',
    notLayout: 'The layout must be an object with blocks: [...]',
    unknownPrepare: 'Unknown data preparation "{name}"',
    logoMissing: '{where}: "logo": true prints the logo given in options.logo, but options.logo is missing',
    logoNoImage: 'Logo {src}: images cannot be loaded here, pass a ready-made raster',
    logoTimeout: 'Logo not loaded within {seconds} s: {src}',
    logoLoad: 'Logo not loaded: {src}',
    logoLoadCors: 'Logo not loaded: {src}. If it is on another domain, {cors}.',
    logoInvalid: '{where}: invalid logo (use a URL, a data URL, an image or a raster)',
    logoNoCanvas: '{where}: there is no canvas here to prepare the logo, pass a ready-made raster',
    logoTainted: 'Logo {src}: the browser does not let the page read the pixels of an image from ' +
      'another domain loaded without CORS (tainted canvas). For logos from a URL, {cors}.',
    pageImage: '(image of the page)',
    badVia: 'via must be "auto", "ble" or "app"',
    pairCancelled: 'Printer selection cancelled',
    appFailed: 'The Print Bridge app could not print: {detail}',
    appUnreachable: 'The Print Bridge app did not answer ({detail}). Open the app and try again.',
    appUnreachableAuto: 'The Print Bridge app did not answer ({detail}). Open the app, or pair a ' +
      'Bluetooth LE printer from this page (via: "ble").',
    unknownDriver: 'Unknown printer driver "{name}" (available: {list})',
    driverUnknownName: 'Cannot tell which model "{name}" is: choose the driver by hand (driver: {list})',
    driverBleOnly: '{driver} prints only over Bluetooth LE (via: "ble")',
    badImage: 'Invalid image: use a canvas, an image, an ImageBitmap or ImageData',
    imageTooWide: 'The image is {width} dots wide and the paper {dots}: pass a canvas or an image ' +
      '(they are scaled down) or ImageData no wider than the paper',
    imageNoCanvas: 'There is no canvas here to read the image: pass ImageData',
    imageNotLoaded: 'The image has not finished loading (or failed to load): print it from its load event',
    driverNoChannel: 'This printer has no Phomemo print service (FF00): is it really a {driver}? Choose the driver that matches the printer',
    driverNeedsBle: '{driver} prints only over Web Bluetooth: use Chrome on Android or on a computer',
    imageTainted: 'The browser does not let the page read the pixels of this image (tainted canvas): {cors}',
    badWidth: 'width must be a multiple of 8, from 8 to {max} dots',
    badDither: 'dither must be "floyd-steinberg" or "threshold"',
    badDensity: 'density must be 1, 2 or 4',
    badPacing: 'pacing must be "standard", "slow" or "credits"',
    badLanguage: 'language must be one of: {list}, or "auto"',
    // The app (127.0.0.1) and the browser permission.
    imageLoad: 'Image not loaded: {src}',
    noAnswerMs: 'no answer within {ms} ms',
    badResponse: 'invalid answer (HTTP {status})',
    notTheApp: 'a service answered that is not the Print Bridge app ("app": true is missing)',
    lnaSteps: 'Open the site settings in Chrome (padlock icon -> Site settings) and set "Apps on ' +
      'device" (loopback-network) to Allow; on Chrome 142-144 the entry is called "Local network ' +
      'access". If a prompt appears on the first try, tap Allow.',
    lnaDenied: 'Local network access is BLOCKED for this site. {steps}',
    lnaNeeded: 'To print without leaving the browser you must allow local network access (to ' +
      '127.0.0.1). {steps}',
    // Bluetooth LE.
    unnamedPrinter: 'unnamed printer',
    noAnswerS: '{what}: no answer within {s} s',
    connectingPrinter: 'Connection to the printer',
    notificationsOn: 'Notifications on {uuid}',
    noPrinterPaired: 'no printer paired',
    catPrinter: 'this is a "cat printer": it prints only images with its own protocol, not ESC/POS',
    noChannel: 'no known print channel (services found: {list})',
    none: 'none',
    bleUnsupported: 'Web Bluetooth is not available in this browser',
    notWritable: 'characteristic {uuid} is not writable',
    notFoundOnPrinter: '{what} not found on this printer ({detail})',
    noNotify: 'the printer did not accept notifications on FF03',
    explainCat: 'This printer does not use ESC/POS (it is a "cat printer"): it is not supported.',
    explainNoChannel: 'The printer does not expose a known print channel. Open "Diagnostics" and ' +
      'choose the writable characteristic by hand. ({detail})',
    explainUnsupported: 'This browser does not support Web Bluetooth: use Chrome on Android or on a ' +
      'computer, or the Print Bridge app.',
    explainTimeout: '{detail}. Turn the printer on, bring it closer and try again.',
    explainNoNotify: 'The printer does not send status notifications: pair it in the system ' +
      'Bluetooth settings, then try again. Printing works without them.',
    explainLocation: 'Chrome cannot search for devices: give Chrome the Location permission ' +
      '(Settings > Apps > Chrome > Permissions) and turn Location on, then try again.',
    explainNotFound: 'No printer found or channel missing ({detail}). If it does not appear, try ' +
      '"I can\'t find the printer"; if it is Bluetooth Classic only, use the app.',
    explainGesture: 'Choosing the printer needs a tap on a button.',
    explainNetwork: 'Printer not reachable ({detail}). Turn it on and bring it closer. If it is ' +
      'connected to something else (the Print Bridge app, another phone) disconnect it, or turn ' +
      'the printer off and on again, then press "Reconnect".',
    explainNotSupported: 'Bluetooth error while printing ({detail}): print again. If it happens ' +
      'again, choose a slower sending mode in "Advanced".',
    // Web Serial (computers: USB-serial and Bluetooth Classic printers).
    serialUnsupported: 'Web Serial is not available in this browser: use Chrome or Edge on a computer',
    noPort: 'no serial port chosen',
    serialPort: 'serial port',
    portCancelled: 'Port selection cancelled',
    badBaud: 'baudRate must be one of: {list}',
    explainSerialOpen: 'The serial port could not be opened ({detail}): another program may be ' +
      'using it (close it), or the printer is off or unplugged.',
    explainSerialLost: 'The serial port was closed or unplugged: plug the printer in (or turn it ' +
      'on) and press "Reconnect".',
    explainSerialWrite: 'Error while sending to the serial port ({detail}): print again; if it ' +
      'happens again, check the speed (baud rate) in the settings.',
    driverSerialNo: '{driver} prints only over Bluetooth LE, not over a serial port'
  };

  // The same messages in Italian. A missing key falls back to English.
  var MESSAGES_IT = {
    corsHint: 'il server deve consentire CORS (intestazione Access-Control-Allow-Origin); ' +
      'altrimenti servi il logo dallo stesso sito della pagina o passalo come data URL',
    unknownFilter: 'Filtro sconosciuto "{name}" in {expr}',
    badCondition: '{where}: condizione non valida "{expr}"',
    badBlocks: '{where} deve essere un elenco di blocchi',
    tooDeep: '{where}: troppi livelli annidati',
    badBlock: '{where}: blocco non valido ({block})',
    unknownBlock: '{where}: blocco sconosciuto ({block})',
    badRow: '{where}: row deve essere un elenco di colonne',
    badAlign: '{where}: align deve essere left, center o right',
    badSize: '{where}: size deve essere [larghezza, altezza]',
    badEc: '{where}: ec deve essere L, M, Q o H',
    badRaw: '{where}: raw deve essere un elenco di byte',
    badPaper: 'paper deve essere 58 o 80 (mm), oppure 384 o 576 (punti)',
    badJson: 'Il layout non \u00e8 JSON valido: {detail}',
    unknownLayout: 'Layout sconosciuto "{name}" (predefiniti: {list})',
    notLayout: 'Il layout deve essere un oggetto con blocks: [...]',
    unknownPrepare: 'Preparazione dei dati sconosciuta "{name}"',
    logoMissing: '{where}: "logo": true stampa il logo passato in options.logo, ma options.logo manca',
    logoNoImage: 'Logo {src}: qui non si possono caricare immagini, passa un raster gi\u00e0 pronto',
    logoTimeout: 'Logo non caricato entro {seconds} s: {src}',
    logoLoad: 'Logo non caricato: {src}',
    logoLoadCors: 'Logo non caricato: {src}. Se \u00e8 su un altro dominio, {cors}.',
    logoInvalid: '{where}: logo non valido (usa un URL, un data URL, un\'immagine o un raster)',
    logoNoCanvas: '{where}: qui non c\'\u00e8 un canvas per preparare il logo, passa un raster gi\u00e0 pronto',
    logoTainted: 'Logo {src}: il browser non lascia leggere alla pagina i pixel di un\'immagine di ' +
      'un altro dominio caricata senza CORS (canvas "tainted"). Per i loghi da URL, {cors}.',
    pageImage: '(immagine della pagina)',
    badVia: 'via deve essere "auto", "ble", "app" o "serial"',
    pairCancelled: 'Scelta della stampante annullata',
    appFailed: 'L\'app Print Bridge non \u00e8 riuscita a stampare: {detail}',
    appUnreachable: 'L\'app Print Bridge non ha risposto ({detail}). Apri l\'app e riprova.',
    appUnreachableAuto: 'L\'app Print Bridge non ha risposto ({detail}). Apri l\'app, oppure ' +
      'abbina da questa pagina una stampante Bluetooth LE (via: "ble").',
    unknownDriver: 'Driver di stampa sconosciuto "{name}" (disponibili: {list})',
    driverUnknownName: 'Non so quale modello sia "{name}": scegli il driver a mano (driver: {list})',
    driverBleOnly: '{driver} stampa solo via Bluetooth LE (via: "ble")',
    badImage: 'Immagine non valida: usa un canvas, un\'immagine, una ImageBitmap o ImageData',
    imageTooWide: 'L\'immagine \u00e8 larga {width} punti e la carta {dots}: passa un canvas o ' +
      'un\'immagine (vengono ridotti) oppure ImageData non pi\u00f9 larga della carta',
    imageNoCanvas: 'Qui non c\'\u00e8 un canvas per leggere l\'immagine: passa ImageData',
    imageNotLoaded: 'L\'immagine non ha finito di caricarsi (o il caricamento \u00e8 fallito): stampala ' +
      'dal suo evento load',
    driverNoChannel: 'Questa stampante non ha il servizio di stampa Phomemo (FF00): \u00e8 davvero una ' +
      '{driver}? Scegli il driver adatto alla stampante',
    driverNeedsBle: '{driver} stampa solo via Web Bluetooth: usa Chrome su Android o su un computer',
    imageTainted: 'Il browser non lascia leggere alla pagina i pixel di questa immagine (canvas ' +
      '"tainted"): {cors}',
    badWidth: 'width deve essere un multiplo di 8, da 8 a {max} punti',
    badDither: 'dither deve essere "floyd-steinberg" o "threshold"',
    badDensity: 'density deve essere 1, 2 o 4',
    badPacing: 'pacing deve essere "standard", "slow" o "credits"',
    badLanguage: 'la lingua deve essere una tra: {list}, oppure "auto"',
    imageLoad: 'Immagine non caricata: {src}',
    noAnswerMs: 'nessuna risposta entro {ms} ms',
    badResponse: 'risposta non valida (HTTP {status})',
    notTheApp: 'ha risposto un servizio che non \u00e8 l\'app Print Bridge (manca "app": true)',
    lnaSteps: 'Apri le impostazioni del sito in Chrome (icona lucchetto -> Impostazioni sito) e ' +
      'imposta "App sul dispositivo" (loopback-network) su Consenti; su Chrome 142-144 la voce si ' +
      'chiama "Accesso alla rete locale". Se al primo tentativo compare un prompt, premi Consenti.',
    lnaDenied: 'Accesso alla rete locale NEGATO per questo sito. {steps}',
    lnaNeeded: 'Per stampare senza uscire dal browser devi consentire l\'accesso alla rete locale ' +
      '(verso 127.0.0.1). {steps}',
    unnamedPrinter: 'stampante senza nome',
    noAnswerS: '{what}: nessuna risposta entro {s} s',
    connectingPrinter: 'Connessione alla stampante',
    notificationsOn: 'Notifiche su {uuid}',
    noPrinterPaired: 'nessuna stampante abbinata',
    catPrinter: 'questa \u00e8 una "cat printer": stampa solo immagini con un protocollo proprio, non ESC/POS',
    noChannel: 'nessun canale di stampa conosciuto (servizi trovati: {list})',
    none: 'nessuno',
    bleUnsupported: 'Web Bluetooth non disponibile in questo browser',
    notWritable: 'la caratteristica {uuid} non \u00e8 scrivibile',
    notFoundOnPrinter: '{what} non trovato su questa stampante ({detail})',
    noNotify: 'la stampante non ha accettato le notifiche su FF03',
    explainCat: 'Questa stampante non usa ESC/POS (\u00e8 una "cat printer"): non \u00e8 supportata.',
    explainNoChannel: 'La stampante non espone un canale di stampa conosciuto. Apri \u00abDiagnostica\u00bb ' +
      'e scegli a mano la caratteristica scrivibile. ({detail})',
    explainUnsupported: 'Questo browser non supporta Web Bluetooth: usa Chrome su Android o su un ' +
      'computer, oppure l\'app Print Bridge.',
    explainTimeout: '{detail}. Accendi la stampante, avvicinala e riprova.',
    explainNoNotify: 'La stampante non manda le notifiche di stato: abbinala nelle impostazioni ' +
      'Bluetooth del sistema, poi riprova. La stampa funziona anche senza.',
    explainLocation: 'Chrome non pu\u00f2 cercare dispositivi: concedi a Chrome la Posizione (Impostazioni ' +
      '> App > Chrome > Autorizzazioni) e attiva la Localizzazione, poi riprova.',
    explainNotFound: 'Nessuna stampante trovata o canale assente ({detail}). Se non compare, prova ' +
      '\u00abNon trovo la stampante\u00bb; se \u00e8 solo Bluetooth Classic usa l\'app.',
    explainGesture: 'Serve un tocco su un pulsante per scegliere la stampante.',
    explainNetwork: 'Stampante non raggiungibile ({detail}). Accendila e avvicinala. Se \u00e8 collegata ' +
      'ad altro (l\'app Print Bridge, un altro telefono) scollegala, oppure spegni e riaccendi la ' +
      'stampante, poi premi \u00abRiconnetti\u00bb.',
    explainNotSupported: 'Errore Bluetooth durante la stampa ({detail}): ristampa. Se si ripete, in ' +
      '\u00abAvanzate\u00bb scegli una modalit\u00e0 di invio pi\u00f9 lenta.',
    serialUnsupported: 'Web Serial non \u00e8 disponibile in questo browser: usa Chrome o Edge su un computer',
    noPort: 'nessuna porta seriale scelta',
    serialPort: 'porta seriale',
    portCancelled: 'Scelta della porta annullata',
    badBaud: 'baudRate deve essere uno tra: {list}',
    explainSerialOpen: 'Impossibile aprire la porta seriale ({detail}): forse la usa un altro ' +
      'programma (chiudilo), oppure la stampante \u00e8 spenta o scollegata.',
    explainSerialLost: 'La porta seriale si \u00e8 chiusa o \u00e8 stata scollegata: ricollega (o accendi) la ' +
      'stampante e premi \u00abRiconnetti\u00bb.',
    explainSerialWrite: 'Errore durante l\'invio alla porta seriale ({detail}): ristampa; se si ' +
      'ripete, controlla la velocit\u00e0 (baud rate) nelle impostazioni.',
    driverSerialNo: '{driver} stampa solo via Bluetooth LE, non su una porta seriale'
  };

  // Languages of the messages: English (default) and Italian (PrintBridge.translations; add a
  // table to add a language). RawBT.setLanguage('it' | 'en' | 'auto') fixes one and keeps it in
  // localStorage; 'auto' follows the languages of the browser.
  var TRANSLATIONS = { en: MESSAGES, it: MESSAGES_IT };
  var LANG_STORE = 'printbridge.lang';
  var langChoice = null;

  function currentLang() {
    var l = langChoice;
    if (!l) {
      try { l = global.localStorage ? global.localStorage.getItem(LANG_STORE) : null; } catch (e) { l = null; }
    }
    if (l && own(TRANSLATIONS, l)) return l;
    var nav = global.navigator || {};
    var list = nav.languages && nav.languages.length ? nav.languages : [nav.language];
    for (var i = 0; i < list.length; i++) {
      var code = String(list[i] || '').toLowerCase().split('-')[0];
      if (own(TRANSLATIONS, code)) return code;
    }
    return 'en';
  }

  function message(key, params) {
    var table = TRANSLATIONS[currentLang()];
    var s = own(table, key) ? String(table[key]) : own(MESSAGES, key) ? String(MESSAGES[key]) : key;
    return s.replace(/\{(\w+)\}/g, function (m, k) { return own(params, k) ? String(params[k]) : m; });
  }

  function layoutError(code, key, params) {
    var e = new Error(message(key, params));
    e.name = 'PrintBridgeLayoutError';
    e.code = code;
    return e;
  }

  function own(o, k) {
    return o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  }
  function trim(s) { return String(s).trim(); }
  function spaces(n) { return n > 0 ? new Array(n + 1).join(' ') : ''; }
  function intIn(v, min, max, def) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.max(min, Math.min(max, Math.round(n)));
  }
  function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
  function isBytes(v) {
    return Array.isArray(v) || (typeof ArrayBuffer !== 'undefined' && !!ArrayBuffer.isView && ArrayBuffer.isView(v));
  }
  function brief(v) {
    var s;
    try { s = JSON.stringify(v); } catch (e) { s = null; }
    s = String(s == null ? v : s);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  }
  function omit(o, keys) {
    var out = {};
    for (var k in o) if (own(o, k) && keys.indexOf(k) < 0) out[k] = o[k];
    return out;
  }

  // A placeholder value as text: a missing field (or an object) becomes ''.
  function str(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return String(v);
    if (isDate(v)) return isNaN(v.getTime()) ? '' : formatDate(v, DATE_FORMAT);
    return '';
  }

  // Text to print: control characters (ESC, GS...) would become commands.
  function clean(s) {
    return s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
  }

  // A data field: a.b.c, '.' or 'this' for the current element of each, @index, @number,
  // @first, @last. It is looked up from the current element out to the main data and the
  // layout defaults; null counts as missing.
  function lookup(scopes, path) {
    var i, v;
    if (path === '.' || path === 'this') return scopes[0].item;
    if (path.charAt(0) === '@') {
      for (i = 0; i < scopes.length && scopes[i].index == null; i++) { /* closest repetition */ }
      var s = scopes[i];
      if (!s) return undefined;
      if (path === '@index') return s.index;
      if (path === '@number') return s.index + 1;
      if (path === '@first') return s.index === 0;
      if (path === '@last') return s.index === s.count - 1;
      return undefined;
    }
    var parts = path.split('.');
    if (parts[0] === 'this') {
      v = scopes[0].item;
    } else {
      for (i = 0; i < scopes.length; i++) {
        if (own(scopes[i].item, parts[0]) && scopes[i].item[parts[0]] != null) break;
      }
      if (i === scopes.length) return undefined;
      v = scopes[i].item[parts[0]];
    }
    for (var j = 1; j < parts.length; j++) {
      if (!own(v, parts[j])) return undefined;
      v = v[parts[j]];
    }
    return v;
  }

  function evaluate(expr, scopes, ctx) {
    var parts = expr.split('|');
    var v = lookup(scopes, trim(parts[0]));
    for (var i = 1; i < parts.length; i++) {
      var f = parts[i], colon = f.indexOf(':');
      var name = trim(colon < 0 ? f : f.slice(0, colon));
      var fn = (own(ctx.filters, name) && ctx.filters[name]) || (own(FILTERS, name) && FILTERS[name]);
      if (typeof fn !== 'function') throw layoutError('filter', 'unknownFilter', { name: name, expr: '{{' + expr + '}}' });
      v = fn(v, colon < 0 ? undefined : trim(f.slice(colon + 1)), ctx);
    }
    return v;
  }

  function fill(tpl, scopes, ctx) {
    if (typeof tpl !== 'string') return str(tpl);
    return tpl.replace(PLACEHOLDER, function (m, expr) { return str(evaluate(expr, scopes, ctx)); });
  }

  // if: 'field', '!field', 'a && b', 'a || b' (&& before ||), or true/false. Missing fields, '',
  // 0, false and empty lists are false.
  function condition(expr, scopes, where) {
    if (typeof expr === 'boolean') return expr;
    // The whole condition is checked before it is evaluated: a typo must not stay hidden
    // until the data happens to reach that term.
    var ors = String(expr).split('||').map(function (or) {
      return or.split('&&').map(function (term) {
        var t = trim(term), neg = false;
        while (t.charAt(0) === '!') { neg = !neg; t = trim(t.slice(1)); }
        if (!t) throw layoutError('layout', 'badCondition', { where: where, expr: expr });
        return { path: t, neg: neg };
      });
    });
    return ors.some(function (ands) {
      return ands.every(function (t) {
        var v = lookup(scopes, t.path);
        return (Array.isArray(v) ? v.length > 0 : !!v) !== t.neg;
      });
    });
  }

  function toNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (typeof v !== 'string') return NaN;
    var s = trim(v);
    if (/^[-+]?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    // Italian style: 1.234,50 or 1,5.
    if (/^[-+]?\d{1,3}(\.\d{3})*,\d+$/.test(s) || /^[-+]?\d+,\d+$/.test(s)) {
      return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    }
    return NaN;
  }
  function numberOr(v, def) {
    var n = toNumber(v);
    return isNaN(n) ? def : n;
  }

  // Decimal comma, rounded as on paper (1.005 -> 1,01), thousands dot only with group.
  function formatNumber(n, decimals, group) {
    var r = Math.round(Math.abs(n) * Math.pow(10, decimals) + 1e-7);
    var s = String(r);
    while (s.length <= decimals) s = '0' + s;
    var whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals);
    if (group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (n < 0 && r > 0 ? '-' : '') + whole + (decimals ? ',' + frac : '');
  }
  function decimalsOf(arg) { return arg == null || arg === '' ? 2 : intIn(arg, 0, 6, 2); }

  function formatDate(d, fmt) {
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return fmt.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, function (t) {
      if (t === 'yyyy') return String(d.getFullYear());
      if (t === 'yy') return p2(d.getFullYear() % 100);
      if (t === 'MM') return p2(d.getMonth() + 1);
      if (t === 'dd') return p2(d.getDate());
      if (t === 'HH') return p2(d.getHours());
      if (t === 'mm') return p2(d.getMinutes());
      return p2(d.getSeconds());
    });
  }

  // Filters: {{field|name}} or {{field|name:argument}}. More can be added to PrintBridge.filters
  // or options.filters: function (value, argument, context).
  var FILTERS = {
    // 1234.5 -> "1.234,50 EUR" with the euro sign (it-IT, with a normal space, not the
    // no-break space of Intl). Text that is not a number is kept as it is.
    euro: function (v, arg) {
      var n = toNumber(v);
      return isNaN(n) ? str(v) : formatNumber(n, decimalsOf(arg), true) + ' \u20ac';
    },
    // 1234.5 -> "1234,50", like the amounts on the app receipt; num:0 for whole numbers.
    num: function (v, arg) {
      var n = toNumber(v);
      return isNaN(n) ? str(v) : formatNumber(n, decimalsOf(arg), false);
    },
    // true or 'now' = now; also a Date, milliseconds or ISO text. Format with yyyy, yy, MM, dd,
    // HH, mm, ss; dd/MM/yyyy HH:mm by default.
    date: function (v, arg, ctx) {
      var d = v === true || v === 'now' ? ctx.now
        : isDate(v) ? v
          : typeof v === 'number' ? new Date(v)
            : typeof v === 'string' && trim(v) ? new Date(trim(v)) : null;
      if (!d || isNaN(d.getTime())) return typeof v === 'string' ? v : '';
      return formatDate(d, arg || DATE_FORMAT);
    },
    upper: function (v) { return str(v).toUpperCase(); },
    lower: function (v) { return str(v).toLowerCase(); }
  };

  // POST /receipt data read the way the app does (Receipt.parse): items with qty (default 1),
  // price (default 0) and amount = qty * price; a missing total is the sum, with two decimals.
  var PREPARE = {
    receipt: function (d) {
      var out = {}, k, sum = 0;
      for (k in d) if (own(d, k)) out[k] = d[k];
      out.items = (Array.isArray(d.items) ? d.items : []).filter(function (it) {
        return it !== null && typeof it === 'object' && !Array.isArray(it);
      }).map(function (it) {
        var c = {}, j;
        for (j in it) if (own(it, j)) c[j] = it[j];
        c.qty = numberOr(it.qty, 1);
        c.price = numberOr(it.price, 0);
        c.amount = c.qty * c.price;
        sum += c.amount;
        return c;
      });
      out.total = str(d.total);
      if (!out.total && out.items.length) out.total = formatNumber(sum, 2, false);
      return out;
    }
  };

  var LAYOUTS = {
    // The POST /receipt receipt (Receipt.kt), line by line, labels included. "logo": true prints
    // the logo given in options.logo (in the app it is the configured one); width sets the
    // columns as in the app.
    receipt: {
      paper: 58,
      columns: '{{width}}',
      codepage: 16,
      prepare: 'receipt',
      defaults: { date: true, feed: 3, cut: true },
      blocks: [
        { 'if': 'logo', blocks: [{ logo: true }, { text: '', align: 'center' }] },
        { 'if': 'shop', text: '{{shop}}', align: 'center', bold: true, size: [2, 2] },
        { 'if': 'title', text: '{{title}}', align: 'center', bold: true, size: [2, 1] },
        { rule: true },
        { 'if': 'code', text: 'Ricevuta n. {{code}}' },
        { 'if': 'date', text: '{{date|date}}' },
        { 'if': 'subtitle', text: '{{subtitle}}' },
        { 'if': 'lines || items || code || date', rule: true },
        { each: 'lines', text: '{{.}}' },
        { each: 'items', row: ['{{desc}}', '{{amount|num}}'] },
        { 'if': 'items', rule: true },
        { 'if': 'total', row: ['TOTALE EUR', '{{total}}'], bold: true, size: [1, 2] },
        { 'if': 'qr', blocks: [
          { feed: 1 },
          { qr: '{{qr}}', size: 6 },
          { 'if': 'qrText', text: '{{qrText}}', align: 'center' },
          { 'if': '!qrText', text: '{{qr}}', align: 'center' }
        ] },
        { 'if': '!qr && qrText', blocks: [{ feed: 1 }, { text: '{{qrText}}', align: 'center' }] },
        { 'if': 'footer', blocks: [{ feed: 1 }, { text: '{{footer}}', align: 'center' }] },
        { feed: '{{feed}}' },
        { 'if': 'cut', cut: true }
      ]
    }
  };

  // Wraps on words; a word longer than the line is split. Lines that fit stay as they are,
  // spaces included.
  function wrap(s, width) {
    var out = [];
    s.split('\n').forEach(function (par) {
      if (par.length <= width) { out.push(par); return; }
      var words = par.split(/ +/), line = '', start = out.length;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        while (w.length > width) {
          if (line) { out.push(line); line = ''; }
          out.push(w.slice(0, width));
          w = w.slice(width);
        }
        if (!line) line = w;
        else if (line.length + 1 + w.length <= width) line += ' ' + w;
        else { out.push(line); line = w; }
      }
      if (line || out.length === start) out.push(line);
    });
    return out;
  }

  function pad(s, width, align) {
    var room = width - s.length;
    if (align === 'right') return spaces(room) + s;
    if (align === 'center') return spaces(room >> 1) + s + spaces(room - (room >> 1));
    return s + spaces(room);
  }

  function checkAlign(a, where) {
    if (ALIGNS.indexOf(a) < 0) throw layoutError('layout', 'badAlign', { where: where });
    return a;
  }

  function styleOf(b, where) {
    var size = b.size == null ? 1 : b.size;
    if (typeof size !== 'object') size = [size, size];
    if (!Array.isArray(size)) throw layoutError('layout', 'badSize', { where: where });
    return {
      align: checkAlign(b.align == null ? 'left' : b.align, where),
      bold: !!b.bold, ul: !!b.underline,
      w: intIn(size[0], 1, 8, 1), h: intIn(size[1], 1, 8, 1)
    };
  }

  // The columns of a row. A numeric width is fixed, 'auto' is as wide as the text, otherwise
  // the column is flexible (flex, default 1) over the space left. In the short form (plain
  // texts) the first column is flexible and the others 'auto'; the last one is right-aligned.
  // Text that is too long is cut, as the app does, or wraps inside its column with wrap.
  function rowLines(b, scopes, ctx, width, where) {
    var n = b.row.length, gap = b.gap == null ? 1 : intIn(b.gap, 0, 8, 1);
    var free = width - gap * (n - 1), weights = 0;
    var cells = b.row.map(function (c, i) {
      var obj = c !== null && typeof c === 'object' && !Array.isArray(c);
      var cell = obj ? c : { text: c };
      var x = {
        align: checkAlign(cell.align == null ? (n > 1 && i === n - 1 ? 'right' : 'left') : cell.align, where + '.row[' + i + ']'),
        wrap: cell.wrap != null ? !!cell.wrap : !!b.wrap,
        text: clean(fill(cell.text == null ? '' : cell.text, scopes, ctx)),
        width: 0, flex: 0, auto: false
      };
      if (!x.wrap) x.text = x.text.replace(/\n/g, ' ');
      if (typeof cell.width === 'number') x.width = Math.max(0, Math.floor(cell.width));
      else if (cell.width === 'auto' || (!obj && i > 0)) x.auto = true;
      else x.flex = cell.flex > 0 ? cell.flex : 1;
      return x;
    });
    cells.forEach(function (c) { if (!c.auto && !c.flex) free -= c.width; });
    cells.forEach(function (c) {
      if (!c.auto) return;
      var longest = 0;
      c.text.split('\n').forEach(function (l) { longest = Math.max(longest, l.length); });
      c.width = Math.max(0, Math.min(longest, free));
      free -= c.width;
    });
    cells.forEach(function (c) { weights += c.flex; });
    var rest = Math.max(0, free);
    cells.forEach(function (c) {
      if (!c.flex) return;
      c.width = Math.floor(Math.max(0, free) * c.flex / weights);
      rest -= c.width;
    });
    // What the division leaves goes to the first flexible column.
    for (var k = 0; k < n && rest > 0; k++) if (cells[k].flex) { cells[k].width += rest; rest = 0; }
    var parts = cells.map(function (c) {
      if (!c.width) return [''];
      return c.wrap ? wrap(c.text, c.width) : [c.text.slice(0, c.width)];
    });
    var rows = 0, lines = [];
    parts.forEach(function (p) { rows = Math.max(rows, p.length); });
    for (var r = 0; r < rows; r++) {
      lines.push(cells.map(function (c, j) { return pad(parts[j][r] || '', c.width, c.align); })
        .join(spaces(gap)).replace(/ +$/, ''));
    }
    return lines;
  }

  function expand(blocks, scopes, ctx, ops, where, depth) {
    if (!Array.isArray(blocks)) throw layoutError('layout', 'badBlocks', { where: where });
    if (depth > MAX_DEPTH) throw layoutError('layout', 'tooDeep', { where: where });
    for (var i = 0; i < blocks.length; i++) expandBlock(blocks[i], scopes, ctx, ops, where + '[' + i + ']', depth);
  }

  // First pass, synchronous: placeholders, conditions and repetitions become a flat list of
  // operations (lines already laid out, QR codes, logos to load, feeds, cuts).
  function expandBlock(b, scopes, ctx, ops, where, depth) {
    var st, i, lines;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) {
      throw layoutError('layout', 'badBlock', { where: where, block: brief(b) });
    }
    if (own(b, 'if') && !condition(b['if'], scopes, where)) return;
    if (own(b, 'each')) {
      // if applies to the whole block; to pick single elements use blocks with an if inside.
      var list = lookup(scopes, trim(b.each));
      if (!Array.isArray(list)) return;
      var inner = own(b, 'blocks') ? b.blocks : [omit(b, ['each', 'if'])];
      for (i = 0; i < list.length; i++) {
        expand(inner, [{ item: list[i], index: i, count: list.length }].concat(scopes), ctx, ops, where + '.each', depth + 1);
      }
    } else if (own(b, 'blocks')) {
      expand(b.blocks, scopes, ctx, ops, where + '.blocks', depth + 1);
    } else if (own(b, 'text')) {
      st = styleOf(b, where);
      lines = wrap(clean(fill(b.text, scopes, ctx)), Math.max(1, Math.floor(ctx.cols / st.w)));
      for (i = 0; i < lines.length; i++) ops.push({ t: 'line', text: lines[i], style: st });
    } else if (own(b, 'row')) {
      if (!Array.isArray(b.row) || !b.row.length) throw layoutError('layout', 'badRow', { where: where });
      st = styleOf(b, where);
      st.align = 'left';
      lines = rowLines(b, scopes, ctx, Math.max(1, Math.floor(ctx.cols / st.w)), where);
      for (i = 0; i < lines.length; i++) ops.push({ t: 'line', text: lines[i], style: st });
    } else if (own(b, 'rule')) {
      if (b.rule === false) return;
      var ch = typeof b.rule === 'string' && b.rule ? b.rule.charAt(0) : '-';
      ops.push({ t: 'line', text: new Array(ctx.cols + 1).join(ch), style: STYLE_PLAIN });
    } else if (own(b, 'qr')) {
      var data = fill(b.qr, scopes, ctx);
      // A QR code without data is a meaningless command for the printer: the block is skipped.
      if (!data) return;
      var ec = b.ec == null ? 'M' : String(b.ec).toUpperCase();
      if (!own(QR_EC, ec)) throw layoutError('layout', 'badEc', { where: where });
      ops.push({
        t: 'qr', data: data, size: intIn(b.size, 1, 16, 6), ec: QR_EC[ec],
        style: { align: checkAlign(b.align == null ? 'center' : b.align, where), bold: false, ul: false, w: 1, h: 1 }
      });
    } else if (own(b, 'feed')) {
      var nf = typeof b.feed === 'number' ? b.feed : parseInt(fill(b.feed, scopes, ctx), 10);
      if (!isNaN(nf)) ops.push({ t: 'feed', n: intIn(nf, 0, 255, 1) });
    } else if (own(b, 'cut')) {
      if (b.cut) ops.push({ t: 'cut', partial: b.cut === 'partial' });
    } else if (own(b, 'logo')) {
      if (b.logo === true && ctx.logo == null) throw layoutError('logo-missing', 'logoMissing', { where: where });
      var src = b.logo === true ? ctx.logo : typeof b.logo === 'string' ? trim(fill(b.logo, scopes, ctx)) : b.logo;
      if (src === '' || src == null || src === false) return;
      ops.push({
        t: 'logo', src: src, where: where,
        maxHeight: intIn(b.maxHeight, 0, 4000, LOGO_MAX_HEIGHT), threshold: intIn(b.threshold, 0, 255, LOGO_THRESHOLD)
      });
    } else if (own(b, 'raw')) {
      if (!isBytes(b.raw)) throw layoutError('layout', 'badRaw', { where: where });
      ops.push({ t: 'raw', bytes: b.raw });
    } else {
      throw layoutError('layout', 'unknownBlock', { where: where, block: brief(b) });
    }
  }

  // Logo cache: images by src, rasters also by paper width, height and threshold.
  var logoImages = {}, logoRasters = {};

  function remember(cache, key, value) {
    if (Object.keys(cache).length >= CACHE_MAX) {
      for (var k in cache) if (own(cache, k)) delete cache[k];
    }
    cache[key] = value;
  }

  function shortSrc(src) { return src.length > 80 ? src.slice(0, 77) + '...' : src; }

  function offOrigin(src) {
    if (!/^https?:\/\//i.test(src)) return false;
    var origin = global.location && global.location.origin;
    return !origin || src.indexOf(origin + '/') !== 0;
  }

  function loadLogo(src) {
    var key = 'k:' + src;
    if (own(logoImages, key)) return logoImages[key];
    var p = new Promise(function (resolve, reject) {
      if (typeof global.Image !== 'function') {
        reject(layoutError('logo-load', 'logoNoImage', { src: shortSrc(src) }));
        return;
      }
      var img = new global.Image();
      var timer = setTimeout(function () {
        reject(layoutError('logo-load', 'logoTimeout', { seconds: LOGO_TIMEOUT / 1000, src: shortSrc(src) }));
      }, LOGO_TIMEOUT);
      // Before src: otherwise the request goes out without CORS and the canvas cannot be read.
      img.crossOrigin = 'anonymous';
      img.onload = function () { clearTimeout(timer); resolve(img); };
      img.onerror = function () {
        clearTimeout(timer);
        reject(offOrigin(src)
          ? layoutError('logo-load', 'logoLoadCors', { src: shortSrc(src), cors: message('corsHint') })
          : layoutError('logo-load', 'logoLoad', { src: shortSrc(src) }));
      };
      img.src = src;
    });
    remember(logoImages, key, p);
    // A failed load does not stay in the cache: the next print tries again.
    p.then(null, function () { if (logoImages[key] === p) delete logoImages[key]; });
    return p;
  }

  function imageReady(img) {
    if (img.complete !== false || typeof img.addEventListener !== 'function') return Promise.resolve(img);
    return new Promise(function (resolve, reject) {
      img.addEventListener('load', function () { resolve(img); });
      img.addEventListener('error', function () {
        reject(layoutError('logo-load', 'logoLoad', { src: shortSrc(String(img.src || message('pageImage'))) }));
      });
    });
  }

  function rasterOf(img, op, ctx, label) {
    if (!img || !(img.naturalWidth || img.width)) throw layoutError('logo-load', 'logoInvalid', { where: op.where });
    if (!global.document || !global.document.createElement) throw layoutError('logo-load', 'logoNoCanvas', { where: op.where });
    try {
      return EscPos.rasterize(img, ctx.dots, op.threshold, { maxHeight: op.maxHeight, band: LOGO_BAND });
    } catch (e) {
      if (e && (e.name === 'SecurityError' || /taint/i.test(e.message || ''))) {
        throw layoutError('logo-cors', 'logoTainted', { src: label, cors: message('corsHint') });
      }
      throw e;
    }
  }

  // The raster of a logo: ready-made bytes, an image of the page, or a URL (or data URL).
  function resolveLogo(op, ctx) {
    var src = op.src;
    if (isBytes(src)) return Promise.resolve(src);
    if (typeof src !== 'string') {
      return imageReady(src).then(function (img) { return rasterOf(img, op, ctx, message('pageImage')); });
    }
    var key = 'k:' + [ctx.dots, op.maxHeight, op.threshold, src].join('|');
    if (own(logoRasters, key)) return Promise.resolve(logoRasters[key]);
    return loadLogo(src).then(function (img) {
      var r = rasterOf(img, op, ctx, shortSrc(src));
      remember(logoRasters, key, r);
      return r;
    });
  }

  // Second pass: the bytes. Every print starts with ESC @, FS . and the code page; styles are
  // sent only when they change.
  function emit(ops, rasters, ctx) {
    var p = new EscPos().init().kanjiOff().codepage(ctx.codepage);
    var cur = STYLE_PLAIN;
    function set(s) {
      if (s.align !== cur.align) p.align(s.align);
      if (s.bold !== cur.bold) p.bold(s.bold);
      if (s.ul !== cur.ul) p.underline(s.ul);
      // Character size with GS ! (EscPos.size): the columns are computed for these widths.
      if (s.w !== cur.w || s.h !== cur.h) p.size(s.w, s.h);
      cur = s;
    }
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.t === 'line') { set(op.style); p.line(op.text); }
      else if (op.t === 'logo') { set(STYLE_CENTER); p.image(rasters[i]); }
      else if (op.t === 'qr') { set(op.style); p.qr(op.data, op.size, op.ec); }
      else if (op.t === 'feed') p.feed(op.n);
      else if (op.t === 'cut') p.cut(op.partial ? 'partial' : null);
      else p.image(op.bytes);
    }
    return p.bytes();
  }

  function paperOf(v) {
    var n = v == null ? 58 : parseInt(v, 10);
    if (n === 58 || n === 384) return PAPERS[58];
    if (n === 80 || n === 576) return PAPERS[80];
    throw layoutError('layout', 'badPaper');
  }

  function layoutOf(layout) {
    var lay = layout;
    if (typeof lay === 'string') {
      var s = trim(lay);
      if (s.charAt(0) === '{') {
        try { lay = JSON.parse(s); } catch (e) { throw layoutError('layout', 'badJson', { detail: e.message }); }
      } else if (own(LAYOUTS, s)) {
        lay = LAYOUTS[s];
      } else {
        throw layoutError('layout', 'unknownLayout', { name: s, list: Object.keys(LAYOUTS).join(', ') });
      }
    }
    if (lay === null || typeof lay !== 'object' || !Array.isArray(lay.blocks)) throw layoutError('layout', 'notLayout');
    return lay;
  }

  // ESC/POS bytes (an array of numbers) of the layout filled with the data. opts: paper (58/80
  // or 384/576) and codepage win over the layout's, because they belong to the printer; logo
  // for "logo": true blocks; now (a Date) for the date filter; extra filters.
  function render(layout, data, opts) {
    return new Promise(function (resolve) {
      opts = opts || {};
      var lay = layoutOf(layout);
      var paper = paperOf(opts.paper != null ? opts.paper : lay.paper);
      var d = data == null ? {} : data;
      if (lay.prepare != null) {
        var prep = own(PREPARE, lay.prepare) ? PREPARE[lay.prepare] : null;
        if (typeof prep !== 'function') throw layoutError('layout', 'unknownPrepare', { name: lay.prepare });
        d = prep(d, opts);
      }
      var scopes = [{ item: d }];
      if (lay.defaults !== null && typeof lay.defaults === 'object') scopes.push({ item: lay.defaults });
      var ctx = {
        cols: paper.cols, dots: paper.dots,
        codepage: intIn(opts.codepage != null ? opts.codepage : lay.codepage, 0, 255, 16),
        logo: opts.logo, filters: opts.filters,
        now: opts.now != null ? new Date(+opts.now) : new Date()
      };
      // columns (a number or a placeholder, 16-64) replaces the 32 or 48 of the paper, like
      // width in the app receipt; the dots stay those of the paper.
      if (lay.columns != null) {
        var c = typeof lay.columns === 'number' ? lay.columns : parseInt(fill(lay.columns, scopes, ctx), 10);
        if (!isNaN(c)) ctx.cols = intIn(c, 16, 64, paper.cols);
      }
      var ops = [];
      expand(lay.blocks, scopes, ctx, ops, 'blocks', 0);
      resolve(Promise.all(ops.map(function (op) {
        return op.t === 'logo' ? resolveLogo(op, ctx) : null;
      })).then(function (rasters) { return emit(ops, rasters, ctx); }));
    });
  }

  // --- One entry point for printing: RawBT.printLayout (also PrintBridge.print) ---
  var viaChoice = null;

  function viaPreference() {
    var v = viaChoice;
    try { if (global.localStorage) v = global.localStorage.getItem(VIA_STORE) || viaChoice; } catch (e) { /* viaChoice */ }
    return v === 'ble' || v === 'app' || v === 'serial' ? v : null;
  }

  var VIAS = ['auto', 'ble', 'app', 'serial'];

  // The way a print goes, decided synchronously from what is already known: Chrome opens the
  // BLE and serial choosers only while the tap is still valid, so nothing here may wait (no
  // RawBT.check). In order: options.via, the saved preference (RawBT.setVia), a BLE printer
  // paired in this tab, a serial port open in this tab, an app that answered RawBT.check(), a
  // BLE printer used on an earlier visit, a serial port used on an earlier visit, the app.
  function chooseVia(opts) {
    var asked = opts && opts.via != null ? opts.via : 'auto';
    if (VIAS.indexOf(asked) < 0) throw layoutError('via', 'badVia');
    var ble = RawBT.ble, info = ble.info(), ser = RawBT.serial.info(), pref = viaPreference(), via, reason;
    if (asked !== 'auto') { via = asked; reason = 'option'; }
    else if (pref) { via = pref; reason = 'preference'; }
    else if (info.paired) { via = 'ble'; reason = 'paired'; }
    else if (ser.connected) { via = 'serial'; reason = 'serial-open'; }
    else if (RawBT.lastCheck && RawBT.lastCheck.ok) { via = 'app'; reason = 'app-ok'; }
    else if (ble.supported() && info.remembered) { via = 'ble'; reason = 'remembered'; }
    else if (RawBT.serial.supported() && ser.remembered) { via = 'serial'; reason = 'serial-remembered'; }
    else { via = 'app'; reason = 'default'; }
    return {
      via: via, reason: reason,
      needsPairing: via === 'ble' ? !info.paired : via === 'serial' ? !ser.paired : false
    };
  }

  RawBT.chooseVia = chooseVia;

  // Opens the way in the same tap, before anything is awaited: the BLE chooser, or for a serial
  // port the one Chrome remembers for this site (no tap needed) and else the port chooser.
  function openVia(choice) {
    if (!choice.needsPairing) return null;
    if (choice.via === 'ble') return RawBT.ble.pair({ sameName: true });
    if (choice.via === 'serial') {
      if (!RawBT.serial.info().remembered) return RawBT.serial.pair();
      return RawBT.serial.reconnect().then(function (i) { return i || RawBT.serial.pair(); });
    }
    return null;
  }

  // The bytes over the chosen way; the app answers { ok: false, error } when it cannot print.
  function sendVia(choice, bytes, opts, bleOpts) {
    if (choice.via === 'ble') return RawBT.ble.print(bytes, bleOpts || opts);
    if (choice.via === 'serial') return RawBT.serial.print(bytes, opts);
    return RawBT.sendApi(bytes, opts).then(function (j) {
      if (j && j.ok === false) {
        var e = new Error(message('appFailed', { detail: j.error || '?' }));
        e.code = 'app';
        throw e;
      }
      return j;
    });
  }

  // The message of a failed print on the chosen way (shared by printLayout and printCanvas).
  function explainVia(choice, e, r) {
    if (choice.via === 'ble' || choice.via === 'serial') {
      var why = (choice.via === 'ble' ? RawBT.ble : RawBT.serial).explain(e);
      if (why === '') { r.cancelled = true; r.error = message(choice.via === 'ble' ? 'pairCancelled' : 'portCancelled'); } else r.error = why;
    } else if (!(e && e.code === 'app')) {
      r.code = e && e.name === 'TimeoutError' ? 'timeout' : e && e.name === 'ResponseError' ? 'response' : 'network';
      var auto = choice.reason !== 'option' && choice.reason !== 'preference';
      r.error = message(auto ? 'appUnreachableAuto' : 'appUnreachable', { detail: (e && e.message) || String(e) });
    }
    return r;
  }

  // 'app', 'ble' or 'serial' fixes the way for the auto choice (kept in localStorage); 'auto'
  // clears it.
  RawBT.setVia = function (via) {
    if (via == null) via = 'auto';
    if (VIAS.indexOf(via) < 0) throw layoutError('via', 'badVia');
    viaChoice = via === 'auto' ? null : via;
    try {
      if (viaChoice) global.localStorage.setItem(VIA_STORE, viaChoice);
      else global.localStorage.removeItem(VIA_STORE);
    } catch (e) { /* without localStorage the preference lasts until the page is reloaded */ }
    return via;
  };

  // The language of the messages ('en', 'it'): the one set with setLanguage, else the first
  // browser language that has a translation, else English.
  RawBT.language = currentLang;

  // 'it' or 'en' fixes the language of every message (kept in localStorage, shared by the pages
  // of Print Bridge); 'auto' (or null) follows the browser again. Returns the language in use.
  RawBT.setLanguage = function (lang) {
    if (lang == null || lang === 'auto') {
      langChoice = null;
      try { global.localStorage.removeItem(LANG_STORE); } catch (e) { /* nothing stored */ }
      return currentLang();
    }
    var code = String(lang).toLowerCase().split('-')[0];
    if (!own(TRANSLATIONS, code)) throw layoutError('language', 'badLanguage', { list: Object.keys(TRANSLATIONS).join(', ') });
    langChoice = code;
    try { global.localStorage.setItem(LANG_STORE, code); } catch (e) { /* lasts until the page is reloaded */ }
    return code;
  };

  // Renders the layout and prints it, and never rejects. The result is the same whatever the
  // way: { ok: true, via, reason, bytes, ms, result } or { ok: false, via, reason, bytes, ms,
  // error, code, cause }, with cancelled: true when the person closed the BLE chooser. Call it
  // directly in the tap handler: when the way is BLE and no printer is paired in this tab,
  // Chrome's chooser opens straight away, before the logo is loaded.
  RawBT.printLayout = function (layout, data, opts) {
    opts = opts || {};
    var t0 = Date.now(), choice = null, size = 0, ready;
    function failure(e) {
      // A DOMException has a numeric code (NotFoundError = 8): then the name says more.
      var r = {
        ok: false, via: choice && choice.via, reason: choice && choice.reason, bytes: size, ms: Date.now() - t0,
        error: (e && e.message) || String(e), code: (e && (typeof e.code === 'string' ? e.code : e.name)) || 'error', cause: e
      };
      if (!choice || (e && e.name === 'PrintBridgeLayoutError')) return r;
      return explainVia(choice, e, r);
    }
    try {
      choice = chooseVia(opts);
      // Same tap: requestDevice / requestPort must be called before anything is awaited.
      ready = openVia(choice);
    } catch (e) {
      return Promise.resolve(failure(e));
    }
    return Promise.all([ready, render(layout, data, opts)]).then(function (r) {
      size = r[1].length;
      return sendVia(choice, r[1], opts);
    }).then(function (result) {
      return { ok: true, via: choice.via, reason: choice.reason, bytes: size, ms: Date.now() - t0, result: result };
    }, failure);
  };

  // --- Printer drivers: one image, any printer (RawBT.printCanvas) ---
  // A driver turns a 1-bit bitmap into the bytes of one printer family and says how to send
  // them over BLE. All drivers have the same shape:
  //   { id, label, family, dpi, dots (default width), widths (allowed widths),
  //     encode(bitmap, opts) -> bytes, transport (null: the ESC/POS write modes of RawBT.ble) }
  // The input is a canvas, an OffscreenCanvas, an image, an ImageBitmap or ImageData;
  // PrintBridge.toBitmap turns it into the bitmap (Floyd-Steinberg dithering or a threshold).
  // Another printer is another entry in PrintBridge.drivers. Phomemo: docs/phomemo-m02.md.

  // Pacing of a driver transport: chunk bytes, pause ms after each chunk, or credits.
  var PACINGS = {
    standard: { chunk: 128, delay: 20, flow: 'delay' },
    slow: { chunk: 60, delay: 20, flow: 'delay' },
    credits: { chunk: 182, delay: 20, flow: 'credits' }
  };
  // 128 B every 20 ms is the pacing danielgormly/phomo printed with on a real M02 Pro (s04/phomemo
  // uses the same 20 ms pause with MTU-sized chunks up to 244 B); 182 B is the largest packet
  // the printer announces (02 B6 00), never exceeded. "Print
  // complete" (1A 0F 0C) comes 1.5-3 s after the data: wait up to 10 s + 40 ms per row.
  var PHOMEMO_TRANSPORT = {
    label: 'Phomemo', service: PHOMEMO_SERVICE, write: PHOMEMO_WRITE, notify: PHOMEMO_NOTIFY,
    chunk: 128, maxChunk: 182, delay: 20, flow: 'delay', withResponse: false,
    initialCredits: 4, creditTimeout: 1500,
    done: [0x1A, 0x0F, 0x0C], doneBase: 10000, donePerRow: 40, tailWait: 2000
  };
  var PHOMEMO_DENSITIES = [1, 2, 4];

  // Grey level of one RGBA pixel, composited on white paper (transparent = paper).
  function grayOf(d, i) {
    var a = d[i + 3] == null ? 255 : d[i + 3];
    var lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return (lum * a + 255 * (255 - a)) / 255;
  }

  function isPixels(src) {
    return !!src && typeof src.width === 'number' && typeof src.height === 'number' &&
      !!src.data && src.data.length >= src.width * src.height * 4;
  }

  function newCanvas(w, h) {
    if (typeof global.OffscreenCanvas === 'function') return new global.OffscreenCanvas(w, h);
    if (global.document && global.document.createElement) {
      var c = global.document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
    return null;
  }

  // RGBA pixels of the source, no wider than dots: ImageData as it is (it cannot be scaled
  // here), anything drawable on a white canvas, scaled down when wider. Never scaled up.
  function pixelsOf(src, dots) {
    if (isPixels(src)) {
      if (src.width > dots) throw layoutError('image', 'imageTooWide', { width: src.width, dots: dots });
      return src;
    }
    // An image still loading (or broken), or a video without a frame yet, would print as blank
    // paper: drawImage draws nothing and does not fail.
    if (src && typeof src.complete === 'boolean' && (!src.complete || !src.naturalWidth)) {
      throw layoutError('image', 'imageNotLoaded');
    }
    if (src && typeof src.readyState === 'number' && 'videoWidth' in src && src.readyState < 2) {
      throw layoutError('image', 'imageNotLoaded');
    }
    var w = src && (src.naturalWidth || src.videoWidth || src.width);
    var h = src && (src.naturalHeight || src.videoHeight || src.height);
    if (!w || !h) throw layoutError('image', 'badImage');
    var tw = Math.min(dots, w), th = Math.max(1, Math.round(h * tw / w));
    var cv = newCanvas(tw, th);
    if (!cv) throw layoutError('image', 'imageNoCanvas');
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tw, th);
    try {
      ctx.drawImage(src, 0, 0, tw, th);
    } catch (e) {
      // Not something a canvas can draw (TypeError), or a broken image (InvalidStateError).
      throw layoutError('image', 'badImage');
    }
    try {
      return ctx.getImageData(0, 0, tw, th);
    } catch (e) {
      if (e && (e.name === 'SecurityError' || /taint/i.test(e.message || ''))) {
        throw layoutError('image-cors', 'imageTainted', { cors: message('corsHint') });
      }
      throw e;
    }
  }

  // 1-bit bitmap { width (dots), height, bytesPerRow, data } of the source: one bit per dot,
  // most significant bit = leftmost dot, 1 = black. opts: width (dots, multiple of 8, default
  // 384), dither ('floyd-steinberg', default, or 'threshold'), threshold (0-255, default 128),
  // align ('center', default, 'left', 'right') for an image narrower than the paper.
  function toBitmap(src, opts) {
    opts = opts || {};
    var dots = opts.width == null ? 384 : parseInt(opts.width, 10);
    if (isNaN(dots) || dots < 8 || dots > 2048 || dots % 8) throw layoutError('image', 'badWidth', { max: 2048 });
    var dither = opts.dither == null ? 'floyd-steinberg' : opts.dither;
    if (dither !== 'floyd-steinberg' && dither !== 'threshold') throw layoutError('image', 'badDither');
    var align = opts.align == null ? 'center' : opts.align;
    if (ALIGNS.indexOf(align) < 0) throw layoutError('image', 'badAlign', { where: 'image' });
    var th = intIn(opts.threshold, 0, 255, 128);
    var px = pixelsOf(src, dots);
    var w = px.width, h = px.height, d = px.data;
    var x0 = align === 'left' ? 0 : align === 'right' ? dots - w : (dots - w) >> 1;
    var bpr = dots >> 3, out = new Uint8Array(bpr * h);
    var gray = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) gray[i] = grayOf(d, i * 4);
    var fs = dither === 'floyd-steinberg';
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var k = y * w + x, old = gray[k], black = old < th;
        if (black) {
          var X = x0 + x;
          out[y * bpr + (X >> 3)] |= 0x80 >> (X & 7);
        }
        if (fs) {
          // Floyd-Steinberg: 7/16 right, 3/16 below left, 5/16 below, 1/16 below right.
          var err = old - (black ? 0 : 255);
          if (x + 1 < w) gray[k + 1] += err * 7 / 16;
          if (y + 1 < h) {
            if (x > 0) gray[k + w - 1] += err * 3 / 16;
            gray[k + w] += err * 5 / 16;
            if (x + 1 < w) gray[k + w + 1] += err / 16;
          }
        }
      }
    }
    return { width: dots, height: h, bytesPerRow: bpr, data: out };
  }

  // GS v 0 raster of the bitmap in blocks of at most maxRows rows, with the exact row count in
  // each block. escape0A replaces data bytes 0x0A with 0x14 (some Phomemo tools do; off).
  function appendRaster(out, bm, maxRows, escape0A) {
    var bpr = bm.bytesPerRow;
    for (var y0 = 0; y0 < bm.height; y0 += maxRows) {
      var rows = Math.min(maxRows, bm.height - y0);
      out.push(GS, 0x76, 0x30, 0x00, bpr & 0xFF, (bpr >> 8) & 0xFF, rows & 0xFF, (rows >> 8) & 0xFF);
      var end = (y0 + rows) * bpr;
      for (var i = y0 * bpr; i < end; i++) {
        var b = bm.data[i];
        out.push(escape0A && b === 0x0A ? 0x14 : b);
      }
    }
    return out;
  }

  // ESC/POS (Netum and the like): ESC @, the raster in 128-row bands (cheap firmwares read the
  // height on one byte), ESC d feed, optional cut.
  function escposImage(bm, opts) {
    var out = [ESC, 0x40];
    appendRaster(out, bm, LOGO_BAND);
    out.push(ESC, 0x64, intIn(opts.feed, 0, 255, 3));
    if (opts.cut === 'partial') out.push(GS, 0x56, 0x42, 0x00);
    else if (opts.cut) out.push(GS, 0x56, 0x00);
    return out;
  }

  // Phomemo M02 family: ESC @, density 1F 11 02 NN (only 1, 2, 4; 4 is the vendor default),
  // ESC a (1 centre, 0 left, 2 right), the raster in blocks of at most 255 rows, ESC d feed. No speed
  // command exists for these models; no other 1F 11 command is sent.
  function phomemoImage(bm, opts) {
    var d = opts.density;
    var density = d == null ? 4 : (typeof d === 'number' || typeof d === 'string') ? Number(d) : NaN;
    if (PHOMEMO_DENSITIES.indexOf(density) < 0) throw layoutError('driver', 'badDensity');
    // ESC a only matters when the head is wider than the raster (576 dots on a 624-dot M02
    // Pro); 2 (right) follows ESC/POS and has not been tried on a Phomemo.
    var a = opts.align === 'left' ? 0 : opts.align === 'right' ? 2 : 1;
    var out = [ESC, 0x40, 0x1F, 0x11, 0x02, density, ESC, 0x61, a];
    appendRaster(out, bm, 255, !!opts.escape0A);
    out.push(ESC, 0x64, intIn(opts.feed, 0, 10, 3));
    return out;
  }

  var DRIVERS = {
    escpos: {
      id: 'escpos', label: 'ESC/POS thermal printer (58/80 mm)', family: 'escpos',
      dpi: 203, dots: 384, widths: [384, 576], transport: null, encode: escposImage
    },
    'phomemo-m02': {
      id: 'phomemo-m02', label: 'Phomemo M02', family: 'phomemo',
      dpi: 203, dots: 384, widths: [384], transport: PHOMEMO_TRANSPORT, encode: phomemoImage
    },
    // The printable width of the M02 Pro is disputed between 576 and 624 dots by two tests on
    // real printers: 576 is the safe default, 624 can be chosen after the calibration ruler.
    'phomemo-m02pro': {
      id: 'phomemo-m02pro', label: 'Phomemo M02 Pro', family: 'phomemo',
      dpi: 300, dots: 576, widths: [576, 624], transport: PHOMEMO_TRANSPORT, encode: phomemoImage
    }
  };

  // The driver for a BLE name: M02 Pro, M02, null for other Phomemo M02 models whose width is
  // not known (M02S, M02X...: choose by hand), escpos for anything else.
  function driverFor(name) {
    var n = String(name || '').replace(/[\s_-]/g, '').toUpperCase();
    if (n === 'M02PRO') return 'phomemo-m02pro';
    if (n === 'M02') return 'phomemo-m02';
    if (/^M02/.test(n)) return null;
    return 'escpos';
  }

  function driverOf(d) {
    if (d && typeof d === 'object' && typeof d.encode === 'function') return d;
    if (own(DRIVERS, d)) return DRIVERS[d];
    throw layoutError('driver', 'unknownDriver', { name: String(d), list: Object.keys(DRIVERS).join(', ') });
  }

  function widthFor(driver, opts) {
    var max = Math.max.apply(null, driver.widths || [driver.dots]);
    if (opts.width == null) return driver.dots;
    var w = parseInt(opts.width, 10);
    if (isNaN(w) || w < 8 || w > max || w % 8) throw layoutError('image', 'badWidth', { max: max });
    return w;
  }

  function transportFor(driver, pacing) {
    if (!driver.transport) return null;
    var name = pacing == null ? 'standard' : pacing;
    if (!own(PACINGS, name)) throw layoutError('driver', 'badPacing');
    var t = {};
    for (var k in driver.transport) if (own(driver.transport, k)) t[k] = driver.transport[k];
    // The driver's own chunk is the fallback when credits are off or do not arrive.
    t.fallbackChunk = driver.transport.chunk || 128;
    t.chunk = Math.min(PACINGS[name].chunk, t.maxChunk || 182);
    t.delay = PACINGS[name].delay;
    t.flow = PACINGS[name].flow;
    return t;
  }

  // { driver, bitmap, bytes } of the source for a driver (an id or a driver object). opts:
  // width, dither, threshold, align, plus the driver's own (feed, cut; density, escape0A).
  function encodeImage(src, driverId, opts) {
    opts = opts || {};
    var driver = driverOf(driverId);
    var bitmap = toBitmap(src, { width: widthFor(driver, opts), dither: opts.dither, threshold: opts.threshold, align: opts.align });
    return { driver: driver.id, bitmap: bitmap, bytes: driver.encode(bitmap, opts) };
  }

  // Prints an image with a printer driver and never rejects, like printLayout. opts: driver
  // ('auto', default: from the name of the BLE printer; or an id of PrintBridge.drivers), via
  // ('auto', 'ble', 'app'; drivers with their own transport, such as Phomemo, only 'ble'),
  // width, dither, threshold, align, feed, cut, density, pacing ('standard', 'slow',
  // 'credits'), escape0A, onProgress. Call it in the tap handler: pairing starts at once.
  RawBT.printCanvas = function (src, opts) {
    opts = opts || {};
    var t0 = Date.now(), choice = null, size = 0, rows = 0, driverId = null, ready = null;
    var picked = null, job = null;
    function failure(e) {
      var r = {
        ok: false, via: choice && choice.via, reason: choice && choice.reason, driver: driverId,
        bytes: size, rows: rows, ms: Date.now() - t0,
        error: (e && e.message) || String(e), code: (e && (typeof e.code === 'string' ? e.code : e.name)) || 'error', cause: e
      };
      if (!choice || (e && e.name === 'PrintBridgeLayoutError')) return r;
      if (choice.via === 'ble') {
        // A Phomemo-like driver: the generic BLE advice (Diagnostics, use the app) is wrong.
        var drv = picked || (driverId && own(DRIVERS, driverId) ? DRIVERS[driverId] : null);
        if (drv && drv.transport && e && (e.code === 'no-channel' || e.code === 'unsupported')) {
          r.error = message(e.code === 'no-channel' ? 'driverNoChannel' : 'driverNeedsBle', { driver: drv.label || drv.id });
          return r;
        }
      }
      return explainVia(choice, e, r);
    }
    // Whatever goes wrong while reading the image is an image error, never an app or BLE one.
    function encode(driver) {
      try {
        return encodeImage(src, driver, opts);
      } catch (e) {
        if (e && e.name === 'PrintBridgeLayoutError') throw e;
        var le = layoutError('image', 'badImage');
        le.cause = e;
        throw le;
      }
    }
    try {
      var asked = opts.driver == null ? 'auto' : opts.driver;
      // A driver object (not only an id) works here as in encodeImage.
      picked = asked !== 'auto' ? driverOf(asked) : null;
      if (picked) driverId = picked.id;
      if (opts.pacing != null && !own(PACINGS, opts.pacing)) throw layoutError('driver', 'badPacing');
      if (opts.via != null && VIAS.indexOf(opts.via) < 0) throw layoutError('via', 'badVia');
      var bleOnly = !!(picked && picked.transport);
      if (bleOnly && opts.via === 'app') throw layoutError('via', 'driverBleOnly', { driver: picked.label || picked.id });
      if (bleOnly && opts.via === 'serial') throw layoutError('via', 'driverSerialNo', { driver: picked.label || picked.id });
      // With a driver given, the image and its options are checked before the chooser opens
      // (nobody should pick a printer and then hear that the density is wrong). It is quick,
      // so the tap is still valid for requestDevice.
      if (picked) job = encode(picked);
      choice = bleOnly ? { via: 'ble', reason: 'driver', needsPairing: !RawBT.ble.info().paired } : chooseVia(opts);
      // Same tap: requestDevice / requestPort must be called before anything else is awaited.
      ready = openVia(choice);
    } catch (e) {
      return Promise.resolve(failure(e));
    }
    return Promise.resolve(ready).then(function () {
      if (asked === 'auto') {
        var name = RawBT.ble.info().name;
        // Only a BLE name says which model it is; the app and serial ports take ESC/POS.
        driverId = choice.via === 'ble' ? driverFor(name) : 'escpos';
        if (!driverId) throw layoutError('driver', 'driverUnknownName', { name: name, list: Object.keys(DRIVERS).join(', ') });
      }
      var driver = picked || driverOf(driverId);
      if (choice.via === 'app' && driver.transport) throw layoutError('via', 'driverBleOnly', { driver: driver.label || driver.id });
      if (choice.via === 'serial' && driver.transport) throw layoutError('via', 'driverSerialNo', { driver: driver.label || driver.id });
      if (!job) job = encode(driver);
      size = job.bytes.length;
      rows = job.bitmap.height;
      return sendVia(choice, job.bytes, opts,
        { transport: transportFor(driver, opts.pacing), rows: rows, onProgress: opts.onProgress });
    }).then(function (result) {
      return {
        ok: true, via: choice.via, reason: choice.reason, driver: driverId, bytes: size, rows: rows,
        ms: Date.now() - t0, result: result
      };
    }, failure);
  };

  var PrintBridge = {
    // Built-in layouts: receipt reproduces the app receipt (POST /receipt).
    layouts: LAYOUTS,
    filters: FILTERS,
    // Data preparations a layout can name (prepare: 'name').
    prepare: PREPARE,
    // The texts of the errors, by key: messages is the English table, translations has one
    // table per language ({ en, it }); add a table to add a language.
    messages: MESSAGES,
    translations: TRANSLATIONS,
    render: render,
    print: RawBT.printLayout,
    // Printer drivers for images (RawBT.printCanvas): escpos, phomemo-m02, phomemo-m02pro.
    drivers: DRIVERS,
    pacings: PACINGS,
    driverFor: driverFor,
    toBitmap: toBitmap,
    encodeImage: encodeImage,
    printCanvas: RawBT.printCanvas,
    // One text filled with the data, as in the blocks: to try placeholders and filters.
    format: function (template, data, opts) {
      opts = opts || {};
      return fill(template, [{ item: data == null ? {} : data }], {
        filters: opts.filters, now: opts.now != null ? new Date(+opts.now) : new Date()
      });
    },
    clearCache: function () { logoImages = {}; logoRasters = {}; }
  };

  if (global.document && global.document.querySelector) {
    function meta(name) {
      var el = global.document.querySelector('meta[name="' + name + '"]');
      return el ? el.getAttribute('content') : null;
    }
    var port = parseInt(meta('rawbt-api-port'), 10);
    if (port > 0) RawBT.apiPort = port;
    var scheme = meta('rawbt-scheme');
    if (scheme) RawBT.scheme = scheme;
    var pkg = meta('rawbt-package');
    if (pkg) RawBT.packageName = pkg;
  }

  global.EscPos = EscPos;
  global.RawBT = RawBT;
  global.PrintBridge = PrintBridge;
})(window);
