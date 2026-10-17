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
