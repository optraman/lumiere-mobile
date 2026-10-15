/*
 * ПЕРЕДАТОЧНЫЙ УЗЕЛ: телефон → этот компьютер → SOCKS5 → резка.
 *
 * Зачем он вообще. У Влада каждый запрос к резке и сам видеопоток идут через встроенный SOCKS5
 * (см. HdRezkaClient.proxyFactory и комментарий в PlayerScreen про «тот же клиент, что несёт
 * прокси»). Именно поэтому у него всё играет без учётной записи и без кук: резка решает, что
 * отдать, по АДРЕСУ, с которого пришли. С домашнего адреса она отдаёт ролик про подписку.
 *
 * Перенести SOCKS5 внутрь приложения нельзя: в Expo Go нет ни сырых сокетов, ни настройки прокси
 * ни для запросов, ни для плеера. Зато его прекрасно умеет обычный Node на этом компьютере.
 * Поэтому прокси живёт здесь: телефон ходит по локальной сети сюда, а отсюда всё уходит тем же
 * маршрутом, что у Влада.
 *
 * Зависимостей нет — SOCKS5 и туннель написаны руками, ставить ничего не нужно.
 *
 * Запуск:  node tools/relay.js
 * Адрес, который потом вписывается в настройках приложения, печатается при запуске.
 */
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'relay.config.json'), 'utf8'));
const PORT = Number(process.env.PORT || 8099);

/** Разрешаем только резку: узел не должен превращаться в открытый прокси для чего угодно. */
const ALLOWED = /(^|\.)((hd)?rezka[a-z0-9-]*)\.[a-z.]+$/i;
/** Домены раздачи потоков — их имена к «rezka» не сводятся, поэтому перечислены отдельно. */
const ALLOWED_CDN = /(voidboost|stream\.|cdn|prx-cogent|streamguard|dedicatestream)/i;

/**
 * ПРЯМОЕ СОЕДИНЕНИЕ — когда узел уже стоит там, где резка пускает.
 *
 * Изначально узел был обходом через чужой SOCKS5, потому что казалось, будто дело в подписке. Дело
 * оказалось в стране: из Италии резка отдаёт всё, из Израиля — ролик про подписку. А раз так,
 * никакой прокси не нужен: достаточно, чтобы сам узел стоял в стране, где всё работает. Тогда он
 * просто ходит к резке напрямую, а телефон — к нему.
 */
function directConnect(host, port) {
  return Promise.resolve(net.connect({ host, port }));
}

/**
 * СОЕДИНЕНИЕ С ЦЕЛЬЮ — НАПРЯМУЮ ИЛИ ЧЕРЕЗ SOCKS5.
 *
 * Смысл узла — не в прокси, а в ТОЧКЕ ВЫХОДА. Если узел сам стоит там, откуда резка отдаёт всё
 * (европейская машина), никакой прокси не нужен: он выходит собой. Прокси остаётся для случая,
 * когда узел стоит там же, где и вы, и точку выхода надо взять взаймы.
 *
 * Пустой host в настройках означает «выходим напрямую».
 */
function connectTo(host, port) {
  if (!cfg.host) {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      s.setTimeout(20000, () => s.destroy(new Error('цель не отвечает')));
      s.once('error', reject);
      s.once('connect', () => {
        s.setTimeout(0);
        resolve(s);
      });
    });
  }
  return socksConnect(host, port);
}

/** Соединение через SOCKS5 (RFC 1928): здороваемся, при нужде входим, просим соединить. */
function socksConnect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: cfg.host, port: cfg.port });
    s.setTimeout(20000, () => s.destroy(new Error('SOCKS5 не отвечает')));
    s.once('error', reject);

    const read = (n) =>
      new Promise((res, rej) => {
        const tryRead = () => {
          const b = s.read(n);
          if (b) return res(b);
          s.once('readable', tryRead);
        };
        s.once('error', rej);
        tryRead();
      });

    s.once('connect', async () => {
      try {
        const useAuth = !!cfg.user;
        s.write(useAuth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
        const hello = await read(2);
        if (hello[0] !== 5) throw new Error('это не SOCKS5');
        if (hello[1] === 2) {
          if (!useAuth) throw new Error('прокси требует логин, а его нет в настройках');
          const u = Buffer.from(cfg.user, 'utf8');
          const p = Buffer.from(cfg.pass, 'utf8');
          s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          const auth = await read(2);
          if (auth[1] !== 0) throw new Error('прокси не принял логин');
        } else if (hello[1] !== 0) {
          throw new Error('прокси не предложил подходящего способа входа');
        }

        const h = Buffer.from(host, 'utf8');
        const req = Buffer.concat([
          Buffer.from([5, 1, 0, 3, h.length]),
          h,
          Buffer.from([(port >> 8) & 255, port & 255]),
        ]);
        s.write(req);
        const head = await read(4);
        if (head[1] !== 0) throw new Error('прокси отказал в соединении (код ' + head[1] + ')');
        // Дочитываем адрес, который прокси вернул, — он нам не нужен, но должен быть снят с потока.
        const atyp = head[3];
        if (atyp === 1) await read(4);
        else if (atyp === 3) {
          const l = await read(1);
          await read(l[0]);
        } else if (atyp === 4) await read(16);
        await read(2);
        s.setTimeout(0);
        resolve(s);
      } catch (e) {
        s.destroy();
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  /*
    КЛЮЧ В ПУТИ, А НЕ В ЗАГОЛОВКЕ.

    Как только узел выставлен наружу, он для всего интернета — открытый вход в чужой SOCKS5:
    любой, кто узнает адрес, будет качать через него. Список разрешённых доменов от этого не
    спасает, он ограничивает КУДА, а не КТО.

    Ключ живёт именно в пути, потому что через узел ходит не только приложение, но и плеер, а ему
    свои заголовки не пропишешь — он получает только ссылку. Путь есть у любого запроса.
  */
  const m = /^(?:\/k\/([A-Za-z0-9_-]+))?\/p\/(.+)$/s.exec(req.url || '');
  if (!m) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Узел работает.\n');
    return;
  }
  if (cfg.key && m[1] !== cfg.key) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('нужен ключ');
    return;
  }
  let target;
  try {
    target = new URL(decodeURIComponent(m[2]));
  } catch {
    res.writeHead(400).end('плохой адрес');
    return;
  }
  if (!ALLOWED.test(target.hostname) && !ALLOWED_CDN.test(target.hostname)) {
    res.writeHead(403).end('этот домен через узел не пускаем');
    return;
  }

  const isTls = target.protocol === 'https:';
  const port = Number(target.port) || (isTls ? 443 : 80);

  const useSocks = !!cfg.host && cfg.port > 0 && cfg.mode !== 'direct';
  let sock;
  try {
    sock = useSocks
      ? await socksConnect(target.hostname, port)
      : await directConnect(target.hostname, port);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('SOCKS5: ' + e.message);
    return;
  }

  // Заголовки телефона едут дальше как есть, кроме Host — его задаёт цель.
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  headers.host = target.host;

  const lib = isTls ? https : http;
  const upstream = lib.request(
    {
      method: req.method,
      path: target.pathname + target.search,
      headers,
      createConnection: () =>
        isTls ? tls.connect({ socket: sock, servername: target.hostname }) : sock,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('узел: ' + e.message);
  });
  req.pipe(upstream);
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  }
  const tail = cfg.key ? '/k/' + cfg.key : '';
  const useSocks = !!cfg.host && cfg.port > 0 && cfg.mode !== 'direct';
  console.log('Узел запущен на порту ' + PORT + '.');
  console.log(cfg.host ? 'Выход: через SOCKS5.' : 'Выход: напрямую, с этой машины.');
  console.log(
    useSocks
      ? 'Режим: через SOCKS5.'
      : 'Режим: напрямую — всё уходит с адреса ЭТОГО компьютера. Он и должен стоять там, где резка отдаёт качество.',
  );
  console.log('');
  console.log('В ОДНОЙ СЕТИ — впишите в приложении (Настройки → Узел связи):');
  for (const ip of ips) console.log('   http://' + ip + ':' + PORT + tail);
  console.log('');
  console.log('ДЛЯ ТЕХ, КТО НЕ В ВАШЕЙ СЕТИ — откройте узел наружу отдельным окном:');
  console.log('   cloudflared tunnel --url http://localhost:' + PORT);
  console.log('   он напечатает адрес вида https://что-то.trycloudflare.com');
  console.log('   впишите в приложении: https://что-то.trycloudflare.com' + tail);
  console.log('');
  console.log('Ключ обязателен: без него узел стал бы открытым входом в чужой прокси.');
});
