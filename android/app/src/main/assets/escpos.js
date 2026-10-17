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
  EscPos.prototype.size = function (w, h) {
    w = Math.max(1, Math.min(8, w || 1));
    h = Math.max(1, Math.min(8, h || 1));
    return this.raw(ESC, 0x21, ((w - 1) << 4) | (h - 1));
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
  var BLE_FILTERS = BLE_PROFILES.slice(0, 4).map(function (p) { return { services: [p.service] }; }).concat([
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
})(window);
