(function () {
  'use strict';
  // ====== НАСТРОЙКИ ======
  // Перед публикацией поставь false: тогда ?now=... и ?reset перестанут работать.
  var DEBUG_ENABLED = true;
  // =======================
  var app = document.getElementById('app'), dlg = document.getElementById('dlg');
  var q = new URLSearchParams(location.search);
  var enc = new TextEncoder(), dec = new TextDecoder();
  var DATA, D = [];
  var opened = {};     // id дня -> { gifts, ps, finaleText, key }
  var mediaUrls = {};  // id дня -> [blobUrl|null]
  var mediaBusy = {};
  var giftUrls = {};   // id дня -> [blobUrl|null] (фото подарков из карточек товара)
  var justAnswered = null, pendingHint = null;
  var ROT = [-1.5, 1.2, -0.8, 1.5, -1.2, 1];
  var sig = '';

  /* ---- хранилище (с защитой от его отсутствия) ---- */
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (e) { return {}; } }
  function lsSet(k, id, v) { try { var o = lsGet(k); o[id] = v; localStorage.setItem(k, JSON.stringify(o)); } catch (e) {} }
  var hints = {};

  /* ---- время: берём с сервера (заголовок Date), чтобы подкрутка часов не работала ---- */
  var offset = 0, debugBase = null, bootPerf = performance.now();
  function syncTime() {
    var qn = q.get('now');
    if (DEBUG_ENABLED && qn && !isNaN(Date.parse(qn.replace(' ', '+')))) { debugBase = Date.parse(qn.replace(' ', '+')); return Promise.resolve(); }
    var t0 = Date.now();
    return fetch(location.pathname + '?t=' + t0, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
      var d = r.headers.get('date');
      if (d) offset = Date.parse(d) + (Date.now() - t0) / 2 - Date.now();
    }).catch(function () {});
  }
  function now() { return debugBase !== null ? debugBase + (performance.now() - bootPerf) : Date.now() + offset; }

  /* ---- шифрование ---- */
  function b64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  function norm(s) { return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, ''); }
  function tryDecrypt(day, answer) {
    var n = norm(answer);
    if (!n) return Promise.resolve(null);
    return crypto.subtle.importKey('raw', enc.encode(n), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      var i = 0;
      function next() {
        if (i >= day.wraps.length) return null;
        var w = day.wraps[i++];
        return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(w.salt), iterations: DATA.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
          .then(function (k) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(w.iv) }, k, b64(w.ct)); })
          .then(function (raw) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); })
          .then(function (ck) {
            return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(day.iv) }, ck, b64(day.ct)).then(function (pt) {
              var c = JSON.parse(dec.decode(pt)); c.key = ck; return c;
            });
          })
          .catch(next);
      }
      return next();
    });
  }
  function loadMedia(day) {
    var c = opened[day.id];
    if (!c || mediaBusy[day.id]) return mediaBusy[day.id] || Promise.resolve();
    mediaUrls[day.id] = []; giftUrls[day.id] = [];
    var gi = (day.giftImgs || []).map(function (m, i) {
      if (!m) return null;
      return fetch(m.file).then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); })
        .then(function (buf) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(m.iv) }, c.key, buf); })
        .then(function (pt) { giftUrls[day.id][i] = URL.createObjectURL(new Blob([pt], { type: m.type })); })
        .catch(function () { giftUrls[day.id][i] = null; });
    });
    mediaBusy[day.id] = Promise.all(gi.concat(day.media.map(function (m, i) {
      return fetch(m.file).then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); })
        .then(function (buf) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(m.iv) }, c.key, buf); })
        .then(function (pt) { mediaUrls[day.id][i] = URL.createObjectURL(new Blob([pt], { type: m.type })); })
        .catch(function () { mediaUrls[day.id][i] = null; });
    })));
    return mediaBusy[day.id];
  }

  /* ---- состояния: closed | riddle | wait | open ---- */
  function openAt(d) { return Date.parse(d.riddleAt); }
  function state(d) {
    if (now() < openAt(d)) return 'closed';
    if (!opened[d.id]) return 'riddle';
    return 'open';
  }
  // «Где искать» открывается в 18:30: к этому времени подарок уже лежит на месте
  function ready(d) { return now() >= Date.parse(d.revealAt); }
  function eNo(d) { var k = 1; for (var i = 0; i < D.length && D[i] !== d; i++) k += D[i].giftCount; return k; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var DELAY = function (d) { return Date.parse(d.revealAt) - Date.parse(d.riddleAt); };

  /* ---- заглушка до начала дела: этапы с таймерами (тексты открытые, секретов тут нет) ---- */
  var STAGES = [
    { at: '2026-10-30T18:30:00+04:00', title: 'До выезда в Воткинск', short: 'Дорога в Воткинск', when: '30 окт · 18:30',
      text: 'Дорога, родители, праздник: всё это совсем скоро. А у Канцелярии Уюта на вас свои планы: после праздничных дней для вас откроют особое дело. Загляните сюда, когда таймер дойдёт до нуля, и вы увидите следующий этап. Если в дороге пропадёт интернет, ничего страшного: страница подхватит всё, как только связь вернётся.' },
    { at: '2026-10-31T16:00:00+04:00', title: 'До начала праздника', short: 'Праздник', when: '31 окт · 16:00',
      text: 'Скоро начнётся праздник, и Канцелярия обещает не мешать. Но в 16:00 загляните сюда на секунду: следующий этап не сдвинется без вас. А мы пока доводим до ума то, ради чего вся эта страница. Подробности будут, но позже.' },
    { at: '2026-11-01T18:30:00+04:00', title: 'До тихого вечера дома', short: 'Вечер дома', when: '1 ноя · 18:30',
      text: 'Праздник позади, вы дома: диван, плед, возможно, «Дюна». Это последний вечер перед тем, что для вас готовится. Откройте страницу в 18:30, дальше останется всего одна ночь.' },
    { at: '2026-11-02T00:00:00+04:00', title: 'До начала дела', short: 'Последнее ожидание', when: '2 ноя · 00:00',
      text: 'Последнее ожидание. В полночь Канцелярия откроет доску дела, а первое письмо придёт уже в тот же день, в 18:00 по Ижевску. Дальше каждый вечер вас будет ждать загадка, а за верный ответ кое-что для вашего собственного кабинета. Заходите в полночь, если не спите. Или утром: всё будет на месте.' }
  ];
  function teaserIdx() { var t = now(); for (var i = 0; i < STAGES.length; i++) if (t < Date.parse(STAGES[i].at)) return i; return -1; }
  function teaser(i) {
    var S = STAGES[i], at = Date.parse(S.at);
    app.className = '';
    app.innerHTML = '<div class="paper locked tz"><i class="pin"></i><div class="eyebrow">Канцелярия Уюта · входящее · ' + (i + 1) + ' из ' + STAGES.length + '</div><h1>' + S.title + '</h1>' +
      '<div class="cd" data-cd="' + at + '">' + fmt(at - now()) + '</div><p class="tz-p">' + S.text + '</p></div>' +
      '<ol class="paper tz-list" style="--r:.8deg">' + STAGES.map(function (x, j) {
        return '<li class="' + (j < i ? 'done' : j === i ? 'now' : '') + '"><span>' + x.short + '</span><i>' + x.when + '</i></li>';
      }).join('') + '</ol>';
  }

  /* ---- утилиты ---- */
  function p2(n) { return ('0' + n).slice(-2); }
  function fmt(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400); s -= d * 86400;
    var t = p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s % 3600 / 60)) + ':' + p2(s % 60);
    return d ? d + ' д ' + t : t;
  }
  function photo(d, k, mode) {
    var m = d.media[k - 1], u = (mediaUrls[d.id] || [])[k - 1], src = '';
    if (m) src = (mode === 'lock' || !u || m.type.indexOf('image') !== 0) ? m.thumb : u;
    return '<div class="ph ' + mode + '" style="--h:' + d.hue[k - 1] + '"><div class="sc"></div>' + (src ? '<img src="' + src + '" alt="">' : '') + '</div>';
  }
  var ICON_BACK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F6EFDC" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  var HEART = 'M12 21C5 15.5 2 12.2 2 8.6 2 5.9 4 4 6.5 4c1.9 0 3.7 1 5.5 3.1C13.8 5 15.6 4 17.5 4 20 4 22 5.9 22 8.6c0 3.6-3 6.9-10 12.4z';
  function dateRu(d) { return d.n + ' ноября'; }

  /* ---- главная ---- */
  function noteHtml(d, i) {
    var s = state(d), side = i % 2 ? 'r' : 'l', r = '--r:' + (ROT[i] || 0) + 'deg';
    var num = p2(d.n) + ' · ' + d.wd, href = '#/day/' + d.n;
    if (d.final) {
      return '<a class="note final" href="' + href + '" style="' + r + '"><i class="pin" style="left:calc(50% - 8px)"></i><div class="g"><div><div class="n">' + num + ' · 8 НОЯБРЯ, 18:00</div><div class="st" style="font-size:26px;margin-top:6px">Закрытие дела</div>' +
        '<div class="sub">' + (s === 'closed' ? 'Последний конверт. Вскрывать лично.' : s === 'riddle' ? 'Конверт ждёт. Вскрывать лично.' : 'Дело закрыто. Открыть снова →') + '</div></div>' +
        '<svg class="seal" width="78" height="78" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="34" fill="#C23E58"/><circle cx="42" cy="42" r="27" fill="none" stroke="#7E1D32" stroke-width="2"/><path d="M42 58C28 48 24 42 24 36c0-5 3.5-8 7.5-8 3.8 0 7 2.3 10.5 6 3.5-3.7 6.7-6 10.5-6 4 0 7.5 3 7.5 8 0 6-4 12-18 22z" fill="#FFE2D1"/></svg></div></a>';
    }
    if (s === 'closed') {
      var first = D.filter(function (x) { return state(x) === 'closed'; })[0] === d;
      return '<a class="note env ' + side + '" href="' + href + '" style="' + r + '" aria-label="День ' + d.n + ', запечатано"><i class="pin"></i><div class="lab">' + num + ' · ' +
        (first ? '<span data-cd="' + openAt(d) + '">' + fmt(openAt(d) - now()) + '</span>' : d.n + '.11 в 18:00') + '</div><span class="sticker">18:00</span></a>';
    }
    var mode = s === 'riddle' ? 'lock' : 'open', inner;
    if (s === 'open') inner = '<div class="st">Подарок выдан</div><div class="sub">' + (ready(d) ? 'Вещдок №' + eNo(d) + (d.giftCount > 1 ? '–' + (eNo(d) + d.giftCount - 1) : '') : 'адрес откроется в 18:30') + '</div>';
    else inner = '<div class="st"><span class="lamp"></span>Новая загадка</div><span class="mini">Читать письмо →</span>';
    return '<a class="note ' + side + (s === 'riddle' ? ' riddle' : '') + '" href="' + href + '" style="' + r + '"><i class="pin"></i><div class="g"><div class="pol">' + photo(d, 1, mode) + '</div><div><div class="n">' + num + '</div>' + inner + '</div></div></a>';
  }
  function home() {
    app.className = '';
    app.innerHTML = '<div class="home"><svg class="strings" aria-hidden="true"></svg>' +
      '<div class="paper head"><i class="pin" style="left:120px"></i><div class="eyebrow">Канцелярия Уюта</div><h1>' + esc(DATA.title) + '</h1><p>Объект: Алёна Сергеевна.<br>2–8 ноября. Статус: <i>в работе</i>.</p></div>' +
      '<div class="secret">СТРОГО<br>ЛИЧНОЕ</div><div style="height:30px"></div>' + D.map(noteHtml).join('') + '</div>';
    drawStrings();
  }
  function drawStrings() {
    var h = app.querySelector('.home'); if (!h) return;
    var svg = h.querySelector('.strings'), hr = h.getBoundingClientRect(), pins = h.querySelectorAll('.pin'), pts = [];
    pins.forEach(function (p) { var r = p.getBoundingClientRect(); pts.push([r.left - hr.left + 8, r.top - hr.top + 8]); });
    var last = 0;
    D.forEach(function (d, i) { if (state(d) !== 'closed') last = i + 1; });
    function path(a, b) {
      var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 + 16;
      return 'M' + a[0] + ' ' + a[1] + 'Q' + mx + ' ' + my + ' ' + b[0] + ' ' + b[1];
    }
    var solid = '', dash = '';
    for (var i = 0; i < pts.length - 1; i++) (i < last ? (solid += path(pts[i], pts[i + 1])) : (dash += path(pts[i], pts[i + 1])));
    svg.setAttribute('width', hr.width); svg.setAttribute('height', hr.height);
    svg.innerHTML = '<g fill="none" stroke-linecap="round"><path d="' + solid + '" stroke="#B8352B" stroke-width="2.5"/><path d="' + dash + '" stroke="#6B2A1E" stroke-width="2" stroke-dasharray="3 7" opacity=".75"/></g>';
  }

  /* ---- страница дня ---- */
  function backBar(right) {
    return '<div class="top"><a class="back" href="#/" aria-label="Назад к доске">' + ICON_BACK + '</a>' + (right || '') + '</div>';
  }
  function locked(d) {
    app.className = '';
    app.innerHTML = backBar() + '<div class="paper locked"><i class="pin"></i><div class="eyebrow">Дело №08.11 · ' + dateRu(d) + '</div><h1>Конверт запечатан</h1>' +
      '<p style="margin:0 0 12px;font-size:16px;line-height:1.5">Канцелярия работает по графику. Поступит в 18:00 по Ижевску.</p><div class="cd" data-cd="' + openAt(d) + '">' + fmt(openAt(d) - now()) + '</div></div>';
  }
  function giftsHtml(d) {
    var c = opened[d.id], n = eNo(d), rdy = ready(d), gu = giftUrls[d.id] || [];
    var out = c.gifts.map(function (g, i) {
      return '<div class="paper gift"><i class="pin"></i><div class="eyebrow" style="color:#B8352B;font-weight:600">ВЕЩДОК №' + (n + i) + '</div>' +
        (gu[i] ? '<div class="gimg"><img src="' + gu[i] + '" alt=""></div>' : '') +
        '<h2>' + esc(g.title) + '</h2><p>' + esc(g.text) + '</p></div>' +
        (rdy ? '<div class="where"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#7A1F1A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg><div><div class="eyebrow" style="font-weight:600;color:#2B2118">Где искать</div><div style="font-size:16px;line-height:1.45;margin-top:4px">' + esc(g.where) + '</div></div></div>' : '');
    }).join('');
    if (!rdy) {
      var end = Date.parse(d.revealAt);
      out += '<div class="paper wait"><i class="pin"></i><div class="eyebrow">Выдача вещдока</div><div style="font:600 20px/1.25 Literata,serif;margin-top:4px">Канцелярия готовит выдачу…</div>' +
        '<div class="sub">Адрес откроется в 18:30 по Ижевску, через <b data-cd="' + end + '">' + fmt(end - now()) + '</b></div><div class="bar"><i data-prog="' + openAt(d) + '" data-dur="' + DELAY(d) + '"></i></div></div>';
    }
    return out;
  }
  function day(d) {
    var s = state(d), idx = D.indexOf(d), mode = s === 'riddle' ? 'lock' : (justAnswered === d.id ? 'dev' : 'open');
    var tone = d.n >= 6 ? 'tone-3' : d.n >= 4 ? 'tone-2' : '';
    app.className = '';
    var m2 = d.media[1];
    var h = backBar('<span class="tag-day mono">ЛИСТ ' + (idx + 1) + ' ИЗ ' + D.length + '</span>') +
      '<div class="paper hero"><i class="pin"></i>' + photo(d, 1, mode) + '<div class="cap">УЛИКА №' + eNo(d) + '</div>' +
      '<div class="paper pol2"><i class="pin" style="left:54px"></i>' + photo(d, 2, mode) + '<div class="d">' + esc(m2 ? m2.date : '') + '</div></div></div>' +
      (s !== 'riddle' ? '<div class="stamp">ВЕРНО</div>' : '') +
      '<div class="paper letter ruled ' + tone + '"><div class="mono eyebrow">ИСХ. №' + p2(d.n) + '/11 · ' + dateRu(d) + ', 18:00</div><div class="gr">' + d.greet + '</div><p>' + d.body + '</p>' +
      '<div class="rid"><b>ЗАГАДКА · </b>' + d.riddle + '</div></div>';
    if (s === 'riddle') {
      h += '<form class="form" id="f" autocomplete="off"><label for="ans">Ваш ответ</label><input id="ans" type="text" enterkeyhint="send" autocapitalize="off" autocorrect="off" spellcheck="false"><p class="msg" id="msg" role="status"></p>' +
        '<div class="stack"><button class="btn" type="submit">Отправить ответ</button>' +
        (d.hint && !hints[d.id] ? '<button class="btn ghost" type="button" id="hintbtn">Подсказка</button>' : '') + '</div></form>' +
        (d.hint && hints[d.id] ? '<div class="paper hintbox"><div class="eyebrow">Из протокола · подсказка</div><div style="margin-top:4px;font-size:16px;line-height:1.5">' + d.hint + '</div></div>' : '');
    } else {
      var ps = opened[d.id].ps;
      h += giftsHtml(d) + (ps ? '<div class="paper letter tone-2" style="margin-top:16px"><div class="ps" style="font:500 26px/28px Caveat,cursive">' + esc(ps) + '</div></div>' : '');
    }
    var nx = D[idx + 1];
    if (nx) h += '<div class="next">СЛЕДУЮЩИЙ КОНВЕРТ · ' + dateRu(nx).toUpperCase() + ', 18:00' + (state(nx) === 'closed' ? '<br>через <b data-cd="' + openAt(nx) + '">' + fmt(openAt(nx) - now()) + '</b>' : '<br><a href="#/day/' + nx.n + '" style="text-decoration:underline">Уже можно открыть</a>') + '</div>';
    app.innerHTML = h;

    var f = document.getElementById('f');
    if (f) {
      var inp = document.getElementById('ans'), msg = document.getElementById('msg');
      inp.addEventListener('input', function () { inp.classList.remove('bad'); msg.classList.remove('on'); });
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = inp.value;
        if (!norm(v)) return;
        if (!(window.crypto && crypto.subtle)) { msg.textContent = 'Нужен защищённый адрес (https).'; msg.classList.add('on'); return; }
        tryDecrypt(d, v).then(function (c) {
          if (c) {
            opened[d.id] = c; lsSet('adv_answers', d.id, v); justAnswered = d.id;
            if (navigator.vibrate) navigator.vibrate(20);
            loadMedia(d).then(route);
          } else {
            inp.classList.remove('bad'); void inp.offsetWidth; inp.classList.add('bad');
            msg.textContent = 'Не то. Канцелярия делает пометку.'; msg.classList.add('on');
          }
        });
      });
      var hb = document.getElementById('hintbtn');
      if (hb) hb.addEventListener('click', function () { pendingHint = d.id; dlg.showModal(); });
    }
  }
  document.getElementById('dlg-no').addEventListener('click', function () { dlg.close(); });
  document.getElementById('dlg-yes').addEventListener('click', function () {
    if (pendingHint) { hints[pendingHint] = 1; lsSet('adv_hints', pendingHint, 1); }
    dlg.close(); route();
  });

  /* ---- финал ---- */
  function hearts() {
    var out = '';
    for (var i = 0; i < 14; i++) {
      var w = 18 + Math.round(Math.random() * 20);
      out += '<svg class="heart' + (i >= 9 ? ' stay' : '') + '" viewBox="0 0 24 24" aria-hidden="true" style="left:' + Math.round(Math.random() * 92) + '%;width:' + w + 'px;animation-delay:' + (i * 0.7).toFixed(1) + 's;--y:' + (10 + Math.round(Math.random() * 60)) + '%"><path d="' + HEART + '"/></svg>';
    }
    document.body.insertAdjacentHTML('beforeend', out);
  }
  function finale(d) {
    var c = opened[d.id], ft = c.finaleText || { paragraphs: [], sign: '' };
    app.className = 'warm';
    var all = '', k = 0, rots = [-4, 3, -1, 4, -3, 2, -2];
    D.forEach(function (x) {
      x.media.forEach(function (m, j) {
        if (m.type.indexOf('image') !== 0) return;
        var u = (mediaUrls[x.id] || [])[j];
        all += '<div class="ph ' + (u ? 'open' : 'lock') + '" style="--h:' + x.hue[j] + ';--i:' + k + ';--r:' + rots[k % 7] + 'deg"><div class="sc"></div><img src="' + (u || m.thumb) + '" alt=""></div>'; k++;
      });
    });
    var vi = -1; d.media.forEach(function (m, j) { if (m.type.indexOf('video') === 0) vi = j; });
    var vu = vi >= 0 ? (mediaUrls[d.id] || [])[vi] : null;
    app.innerHTML = backBar() +
      '<svg class="garland" viewBox="0 0 390 80" aria-hidden="true" fill="none"><path d="M-10 14Q100 66 195 36T400 18" stroke="#6B2A1E" stroke-width="2"/><g fill="#E0506A"><path transform="translate(40 34)" d="' + HEART + '"/><path transform="translate(110 48) scale(1.1)" fill="#F7B267" d="' + HEART + '"/><path transform="translate(180 46)" d="' + HEART + '"/><path transform="translate(250 40) scale(1.1)" fill="#F7B267" d="' + HEART + '"/><path transform="translate(320 26)" d="' + HEART + '"/></g></svg>' +
      '<h1 class="fin-title">Дело закрыто</h1>' +
      (vu ? '<div class="paper vid"><i class="pin"></i><div class="box"><div class="ph" style="--h:' + d.hue[0] + '"><div class="sc"></div></div><video controls playsinline preload="metadata" src="' + vu + '"></video></div><div class="vcap" id="vcap">Дело закрыто' + (d.media[vi].date ? ' · ' + esc(d.media[vi].date) : '') + '</div></div>' : '') +
      '<div class="paper words ruled"><i class="pin"></i>' + ft.paragraphs.map(function (t, i) { return '<p style="--i:' + (i + 1) + '">' + esc(t) + '</p>'; }).join('') + '<p class="sign" style="--i:' + (ft.paragraphs.length + 1) + '">' + esc(ft.sign) + '</p></div>' +
      giftsHtml(d) +
      '<div class="eyebrow" style="margin-top:24px;background:#F6EFDC;display:inline-block;padding:3px 8px">Все улики</div><div class="all">' + all + '</div>';
    var v = app.querySelector('video');
    if (v) v.addEventListener('ended', function () { var e = document.getElementById('vcap'); if (e) e.classList.add('done'); });
    hearts();
  }

  /* ---- маршрутизация и таймер ---- */
  function signature() { var ti = teaserIdx(); if (ti >= 0) return 'T' + ti; return D.map(function (d) { return state(d) + (ready(d) ? 'r' : ''); }).join() + '|' + Object.keys(mediaUrls).length + '|' + Object.keys(giftUrls).length; }
  function route() {
    document.querySelectorAll('.heart').forEach(function (h) { h.remove(); });
    var ti = teaserIdx();
    if (ti >= 0) { teaser(ti); sig = signature(); return; }
    var m = /^#\/day\/(\d+)/.exec(location.hash), d = m && D.filter(function (x) { return x.n === +m[1]; })[0];
    if (!d) { home(); }
    else if (state(d) === 'closed') { locked(d); }
    else if (d.final && state(d) === 'open') { finale(d); }
    else { day(d); }
    if (justAnswered && (!d || d.id !== justAnswered)) justAnswered = null;
    sig = signature();
  }
  window.addEventListener('hashchange', function () { justAnswered = null; route(); window.scrollTo(0, 0); });
  window.addEventListener('resize', drawStrings);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawStrings);

  setInterval(function () {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (signature() !== sig && !dlg.open && !typing) { route(); return; }
    document.querySelectorAll('[data-cd]').forEach(function (el) { el.textContent = fmt(+el.dataset.cd - now()); });
    document.querySelectorAll('[data-prog]').forEach(function (el) {
      var p = (now() - +el.dataset.prog) / +el.dataset.dur;
      el.style.width = Math.max(2, Math.min(100, p * 100)) + '%';
    });
  }, 1000);

  /* ---- запуск ---- */
  function fail(t) { app.innerHTML = '<div class="paper locked"><h1>Канцелярия закрыта</h1><p style="margin:0">' + t + '</p></div>'; }
  if (DEBUG_ENABLED && q.has('reset')) { try { localStorage.removeItem('adv_answers'); localStorage.removeItem('adv_hints'); } catch (e) {} }
  hints = lsGet('adv_hints');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  var tp = syncTime();
  tp.then(function () { if (teaserIdx() >= 0) route(); });
  tp.then(function () { return fetch('data.json', { cache: 'no-store' }).then(function (r) { return r.json(); }); }).then(function (data) {
    DATA = data; D = DATA.days;
    var saved = lsGet('adv_answers');
    return Promise.all(D.map(function (d) {
      return saved[d.id] ? tryDecrypt(d, saved[d.id]).then(function (c) { if (c) opened[d.id] = c; }) : null;
    }));
  }).then(function () {
    route();
    D.forEach(function (d) { if (opened[d.id]) loadMedia(d).then(function () { if (!(document.activeElement && document.activeElement.tagName === 'INPUT') && !dlg.open) route(); }); });
  }).catch(function () { if (teaserIdx() < 0) fail('Не удалось загрузить данные. Обновите страницу.'); });
})();
