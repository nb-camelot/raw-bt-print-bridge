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
      img.onerror = function () { reject(new Error('Immagine non caricata: ' + url)); };
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
    var err = new Error('nessuna risposta entro ' + ms + ' ms');
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
          var err = new Error('risposta non valida (HTTP ' + x.r.status + ')');
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
            message: 'ha risposto un servizio che non e l\'app (manca "app": true)'
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
      var steps = 'Apri le impostazioni del sito in Chrome (icona lucchetto -> Impostazioni sito) ' +
        'e imposta "App sul dispositivo" (loopback-network) su Consenti; su Chrome 142-144 la voce ' +
        'si chiama "Accesso alla rete locale". Se al primo tentativo compare un prompt, premi Consenti.';
      if (state === 'denied') {
        return 'Accesso alla rete locale NEGATO per questo sito. ' + steps;
      }
      return 'Per stampare senza uscire dal browser devi consentire l\'accesso alla rete locale ' +
        '(verso 127.0.0.1). ' + steps;
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
  var BLE_FILTERS = BLE_PROFILES.map(function (p) { return { services: [p.service] }; }).concat([
    { name: 'BlueTooth Printer' }, { namePrefix: 'Printer' }, { namePrefix: 'MPT' },
    { namePrefix: 'NT-' }, { namePrefix: 'Netum' }, { namePrefix: 'POS' }, { namePrefix: 'MTP' }
  ]);
  var BLE_STORE = 'printbridge.ble';

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function bleError(code, message) {
    var e = new Error(message);
    e.name = 'PrintBridgeBleError';
    e.code = code;
    return e;
  }

  var bleState = {
    device: null, server: null, char: null, profile: null,
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
      name: d ? (d.name || saved.name || 'stampante senza nome') : (saved.name || null),
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
    device.addEventListener('gattserverdisconnected', bleOnDisconnect);
  }

  function withTimeout(promise, ms, what) {
    var timer;
    return Promise.race([
      promise,
      new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          reject(bleError('timeout', what + ': nessuna risposta entro ' + Math.round(ms / 1000) + ' s'));
        }, ms);
      })
    ]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  // Solo la connessione GATT, senza scegliere il canale (serve anche alla diagnostica).
  function bleConnectRaw() {
    var d = bleState.device;
    if (!d) return Promise.reject(bleError('no-device', 'nessuna stampante abbinata'));
    if (d.gatt.connected && bleState.server) return Promise.resolve(bleState.server);
    bleSetStatus('connecting');
    return withTimeout(d.gatt.connect(), 20000, 'Connessione alla stampante').then(function (server) {
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
            throw bleError('cat-printer', 'questa \u00e8 una "cat printer": stampa solo immagini con un protocollo proprio, non ESC/POS');
          }
          throw bleError('no-channel', 'nessun canale di stampa conosciuto (servizi trovati: ' +
            (services.map(function (s) { return s.uuid; }).join(', ') || 'nessuno') + ')');
        }
        var t = tries[i];
        return t.service.getCharacteristic(t.write).then(function (c) {
          if (writable(c)) return { profile: t.name, char: c };
          throw new Error('non scrivibile');
        }).catch(function () {
          // UUID atteso assente: prende la prima caratteristica scrivibile dello stesso servizio.
          return t.service.getCharacteristics().then(function (list) {
            var c = list.filter(writable)[0];
            if (c) return { profile: t.name, char: c };
            return next(i + 1);
          }, function () { return next(i + 1); });
        });
      }
      return next(0);
    }).then(function (found) {
      bleState.char = found.char;
      bleState.profile = found.profile;
      return found;
    });
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
        return Promise.reject(bleError('unsupported', 'Web Bluetooth non disponibile in questo browser'));
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
    print: function (bytes, opts) {
      opts = opts || {};
      function job() {
        if (!bleState.device) return Promise.reject(bleError('no-device', 'nessuna stampante abbinata'));
        return bleEnsure().then(function () {
          bleSetStatus('printing');
          return bleWrite(bytes, opts.onProgress);
        }).then(function (r) {
          bleSetStatus('ready');
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
      var name = (e && e.name) || '', msg = (e && e.message) || String(e || '');
      if (e && e.code === 'cat-printer') return 'Questa stampante non usa ESC/POS (\u00e8 una "cat printer"): non \u00e8 supportata.';
      if (e && e.code === 'no-channel') return 'La stampante non espone un canale di stampa conosciuto. Apri \u00abDiagnostica\u00bb e scegli a mano la caratteristica scrivibile. (' + msg + ')';
      if (e && e.code === 'unsupported') return 'Questo browser non supporta Web Bluetooth: usa Chrome su Android oppure l\'app Print Bridge.';
      if (e && e.code === 'timeout') return msg + '. Accendi la stampante, avvicinala e riprova.';
      if (name === 'NotFoundError' && /cancel/i.test(msg)) return '';
      if (name === 'NotFoundError' && /permission|location|scan/i.test(msg)) {
        return 'Chrome non pu\u00f2 cercare dispositivi: concedi a Chrome la Posizione (Impostazioni > App > Chrome > Autorizzazioni) e attiva la Localizzazione, poi riprova.';
      }
      if (name === 'NotFoundError') return 'Nessuna stampante trovata o canale assente (' + msg + '). Se non compare, prova \u00abNon trovo la stampante\u00bb; se \u00e8 solo Bluetooth Classic usa l\'app.';
      if (name === 'SecurityError') return 'Serve un tocco su un pulsante per scegliere la stampante.';
      if (name === 'NetworkError') {
        return 'Stampante non raggiungibile (' + msg + '). Accendila e avvicinala. Se \u00e8 collegata ad altro (l\'app Print Bridge, un altro telefono) scollegala, oppure spegni e riaccendi la stampante, poi premi \u00abRiconnetti\u00bb.';
      }
      if (name === 'NotSupportedError') return 'Errore Bluetooth durante la stampa (' + msg + '): ristampa. Se si ripete, in \u00abAvanzate\u00bb scegli una modalit\u00e0 di invio pi\u00f9 lenta.';
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
      'Bluetooth LE printer from this page (via: "ble").'
  };

  function message(key, params) {
    var s = own(MESSAGES, key) ? String(MESSAGES[key]) : key;
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
    return v === 'ble' || v === 'app' ? v : null;
  }

  // The way a print goes, decided synchronously from what is already known: Chrome opens the
  // BLE chooser only while the tap is still valid, so nothing here may wait (no RawBT.check).
  // In order: options.via, the saved preference (RawBT.setVia), a BLE printer paired in this
  // tab, an app that answered RawBT.check(), a BLE printer used on an earlier visit, the app.
  function chooseVia(opts) {
    var asked = opts && opts.via != null ? opts.via : 'auto';
    if (asked !== 'auto' && asked !== 'ble' && asked !== 'app') throw layoutError('via', 'badVia');
    var ble = RawBT.ble, info = ble.info(), pref = viaPreference(), via, reason;
    if (asked !== 'auto') { via = asked; reason = 'option'; }
    else if (pref) { via = pref; reason = 'preference'; }
    else if (info.paired) { via = 'ble'; reason = 'paired'; }
    else if (RawBT.lastCheck && RawBT.lastCheck.ok) { via = 'app'; reason = 'app-ok'; }
    else if (ble.supported() && info.remembered) { via = 'ble'; reason = 'remembered'; }
    else { via = 'app'; reason = 'default'; }
    return { via: via, reason: reason, needsPairing: via === 'ble' && !info.paired };
  }

  RawBT.chooseVia = chooseVia;

  // 'app' or 'ble' fixes the way for the auto choice (kept in localStorage); 'auto' clears it.
  RawBT.setVia = function (via) {
    if (via == null) via = 'auto';
    if (via !== 'auto' && via !== 'ble' && via !== 'app') throw layoutError('via', 'badVia');
    viaChoice = via === 'auto' ? null : via;
    try {
      if (viaChoice) global.localStorage.setItem(VIA_STORE, viaChoice);
      else global.localStorage.removeItem(VIA_STORE);
    } catch (e) { /* without localStorage the preference lasts until the page is reloaded */ }
    return via;
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
      if (choice.via === 'ble') {
        var why = RawBT.ble.explain(e);
        if (why === '') { r.cancelled = true; r.error = message('pairCancelled'); } else r.error = why;
      } else if (!(e && e.code === 'app')) {
        r.code = e && e.name === 'TimeoutError' ? 'timeout' : e && e.name === 'ResponseError' ? 'response' : 'network';
        var auto = choice.reason !== 'option' && choice.reason !== 'preference';
        r.error = message(auto ? 'appUnreachableAuto' : 'appUnreachable', { detail: (e && e.message) || String(e) });
      }
      return r;
    }
    try {
      choice = chooseVia(opts);
      // Same tap: requestDevice must be called before anything is awaited.
      ready = choice.needsPairing ? RawBT.ble.pair({ sameName: true }) : null;
    } catch (e) {
      return Promise.resolve(failure(e));
    }
    return Promise.all([ready, render(layout, data, opts)]).then(function (r) {
      size = r[1].length;
      if (choice.via === 'ble') return RawBT.ble.print(r[1], opts);
      return RawBT.sendApi(r[1], opts).then(function (j) {
        if (j && j.ok === false) {
          var e = new Error(message('appFailed', { detail: j.error || '?' }));
          e.code = 'app';
          throw e;
        }
        return j;
      });
    }).then(function (result) {
      return { ok: true, via: choice.via, reason: choice.reason, bytes: size, ms: Date.now() - t0, result: result };
    }, failure);
  };

  var PrintBridge = {
    // Built-in layouts: receipt reproduces the app receipt (POST /receipt).
    layouts: LAYOUTS,
    filters: FILTERS,
    // Data preparations a layout can name (prepare: 'name').
    prepare: PREPARE,
    // The texts of the errors, by key, to translate them.
    messages: MESSAGES,
    render: render,
    print: RawBT.printLayout,
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
