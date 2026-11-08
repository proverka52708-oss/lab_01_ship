# Lab 04 — Node.js, EventEmitter, streams і WebSocket

Star Runner з лабораторних 1–3 тепер працює через Node.js сервер. Сервер роздає зібраний клієнт, керує кімнатами та чатом через WebSocket і записує події матчу потоками NDJSON. Координати та симуляція кораблів мережею не передаються — це залишається для лабораторної 5.

## Запуск

Потрібні Node.js 22 або новіший і npm.

```bash
npm install
npm run build
npm start
```

Відкрийте `http://localhost:3000`. Перевірка стану сервера: `http://localhost:3000/health`.

Для розробки запустіть обидва процеси:

```bash
npm run dev
```

Команда запускає Node сервер і Vite. Відкрийте адресу Vite, яку покаже термінал (зазвичай `http://localhost:5173`). Vite проксує `/api`, `/health` і WebSocket `/ws` на сервер.

PowerShell: якщо політика блокує `npm`, виконуйте команди через `npm.cmd`.

## Структура

```text
client/                 # клієнт Lab 1–3, Vite, Canvas та UI
  public/
  src/
server/
  config.js             # перевірка конфігурації оточення
  http-server.js        # API та безпечна роздача dist/
  index.js              # запуск і graceful shutdown
  match-logger.js       # pipeline подій у NDJSON
  room.js               # EventEmitter кімнати
  room-manager.js       # створення, список і видалення кімнат
  websocket-server.js   # протокол, ліміти та heartbeat
  scripts/rss-benchmark.js
  test/
```

Кореневий `package.json` налаштовує npm workspaces `client` і `server`. Проєкт використовує ESM (`"type": "module"`).

## Кімнати та API

- `GET /health` повертає `{ "status": "ok" }`.
- `GET /api/rooms` повертає кімнати та їхню актуальну кількість гравців.
- `POST /api/rooms` створює кімнату. JSON: `{"id":"my-room","name":"My Room","capacity":4}`. ID — малі латинські літери, цифри та дефіси; місткість — 1–16.
- `GET /api/matches/:matchId/replay` повертає лог матчу як NDJSON потоком.
- Решта `GET`/`HEAD` шляхів обслуговують файли з `client/dist`. Шляхи з `..`, encoded traversal і зворотним слешем відхиляються.

Конфігурація:

| Змінна        | Тип / обмеження    | Значення за замовчуванням |
| ------------- | ------------------ | ------------------------- |
| `PORT`        | ціле число 1–65535 | `3000`                    |
| `LOG_DIR`     | непорожній шлях    | `logs/` у корені проєкту  |
| `SERVER_PORT` | порт Vite proxy    | `3000`                    |

Невалідний `PORT` чи порожній `LOG_DIR` зупиняє запуск з явною помилкою. Сервер коректно завершує роботу на `SIGINT` і `SIGTERM`: закриває WebSocket-з’єднання, кімнати та потоки логів.

## WebSocket-протокол

Підключення: `ws://localhost:3000/ws` (у HTTPS — `wss:`).

Клієнт надсилає:

```json
{"type":"join","roomId":"training","playerName":"Pilot"}
{"type":"chat","text":"Hello!"}
{"type":"leave"}
```

Після входу сервер надсилає `joined`; учасникам кімнати — `player-joined`, `player-left` і `chat`. У клієнті є черга відправлення, повторне підключення з exponential backoff до 10 секунд і повторний вхід у бажану кімнату.

Перевірки та ліміти сервера:

- перше повідомлення `join` потрібно надіслати за 5 секунд;
- тільки JSON text-повідомлення відомих типів із правильною формою;
- максимальний payload WebSocket — 2 KiB, прикладне повідомлення — 1 KiB;
- чат — до 300 символів, ім’я — до 18 символів;
- не більше 20 повідомлень за секунду; порушення закриває з’єднання;
- ping кожні 15 секунд; після двох пропущених pong клієнт від’єднується;
- якщо `bufferedAmount` одержувача понад 128 KiB, нові broadcast-повідомлення йому пропускаються, а повільний клієнт не накопичує необмежену чергу;
- кімната видаляється після виходу останнього гравця.

## Лог матчу та backpressure

Події кімнати проходять через `pipeline`: object-mode `PassThrough` → `Transform` (JSON + newline) → файл `logs/<matchId>.ndjson`. Повтор матчу використовує `createReadStream` і `pipeline` без читання всього файлу у пам’ять. Коли `write()` повертає `false`, producer чекає на `drain`.

### RSS під час повільного завантаження

`npm run benchmark` генерує скінченний потік подій, перетворює їх на NDJSON і передає повільному Writable зі штучною затримкою. Це контрольований тест backpressure; RSS вимірюється через `process.memoryUsage().rss`. Запускати на тій самій машині варто кілька разів, бо початковий RSS і навантаження системи різняться.

```text
RSS MiB
45 |                         *---*
44 |                   *---*
43 |        *---*---*
42 | *---*---*
41 +----------------------------------------------> seconds
     0.3   1.3   2.3   3.3   4.3   5.0
```

Один вимір на Node.js 24: 9.7 MiB NDJSON за 5.0 s; RSS змінився з 41.6 MiB до 44.8 MiB. Невелике коливання RSS зумовлене allocator/GC, але пам’ять не зростала пропорційно до переданих 9.7 MiB.

| Час (s) | RSS (MiB) |
| ------: | --------: |
|     0.3 |      41.6 |
|     1.3 |      42.7 |
|     2.3 |      42.7 |
|     3.3 |      43.5 |
|     4.4 |      44.6 |
|     5.0 |      44.8 |

Пласка крива показує, що швидке джерело не накопичує весь лог, коли споживач повільний. `pipeline` поширює backpressure назад до джерела. Якщо ігнорувати `write() === false` та продовжувати створювати chunks, черга буферів росте, а разом із нею росте RSS.

## Event loop, EventEmitter і Node

Node виконує JavaScript у головному потоці. `libuv` допомагає з I/O, але довгий синхронний handler усе одно блокує обробку інших запитів. Якщо HTTP handler займе event loop на 300 ms, усі клієнти цього процесу відчують приблизно таку затримку: пізніше прийдуть відповіді, WebSocket-повідомлення й таймери; CPU-bound код варто виносити з головного потоку або розбивати на короткі задачі.

Фази libuv — timers, pending callbacks, poll, check та close callbacks. `process.nextTick` і Promise microtasks спорожнюються між callback-ами. У головному модулі порядок `setTimeout(..., 0)` і `setImmediate()` не варто вважати стабільним; усередині I/O callback їхній порядок передбачуваніший.

У `EventEmitter` подія `'error'` особлива: якщо її емітити без зареєстрованого слухача, Node кидає помилку, і процес завершується. Тому у потоків, сокетів і кімнат є явні error handlers.

Node і браузер використовують JavaScript, але різне host-середовище: браузер має `window`, DOM і Canvas; Node має `process`, файли, HTTP та сокети. Цей проєкт — ESM (`import`/`export`). CommonJS (`require`) — інший формат модулів, який зустрічається у старих Node-проєктах.

## Перевірки та короткі досліди

```bash
npm test
npm run format:check
npm run build
npm run benchmark
```

Приклади для термінала Node:

```bash
node -e "setTimeout(()=>console.log('t'),0); setImmediate(()=>console.log('i')); process.nextTick(()=>console.log('n')); Promise.resolve().then(()=>console.log('p'))"
node -e "const { EventEmitter } = require('node:events'); new EventEmitter().emit('error', new Error('boom'))"
node -e "console.log(Buffer.from('привіт').length, 'привіт'.length); console.log(Buffer.from([0xff, 0x00]).readUInt16BE(0))"
```

Перший приклад зазвичай починається з `n`, потім `p`; порядок `t`/`i` може змінюватися. Другий навмисно завершує процес з помилкою — не запускайте його всередині довгоживучого сервера. Третій показує, що UTF-8 байти не дорівнюють кількості символів, а `readUInt16BE` повертає `65280`.

## Демонстрація на захисті

1. Запустіть сервер і клієнт; відкрийте Vite адресу у двох вікнах.
2. У кожному введіть різне ім’я та приєднайтесь до однієї кімнати.
3. Надішліть повідомлення у чаті й покажіть, що обидва клієнти його отримали.
4. Закрийте одне вікно: інше побачить `player-left`, а після виходу останнього кімната зникне зі списку.
5. Покажіть `logs/`, replay endpoint і виміри RSS.

## Reflection

1. Що станеться з усіма клієнтами, якщо синхронний HTTP handler блокуватиме event loop 300 ms?
2. Чому `write()` повертає `false`, і як `pipeline` допомагає з backpressure?
3. Чому `'error'` без слухача може завершити процес Node?
