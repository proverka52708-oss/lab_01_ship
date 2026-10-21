# Lab 03 — Promises, async/await і екран завантаження

**Star Runner** — браузерна гра з курсу JavaScript. Lab 03 додає конкурентне завантаження спрайтів, звуку й конфігурації арени, HTTP-лобі з скасуванням запитів та звук, відокремлений від симуляції подіями.

## Запуск

Потрібні Node.js 22 і npm.

```bash
npm install
npm run dev
```

Відкрийте адресу Vite, зазвичай `http://localhost:5173`. Клацніть по ігровому полю, щоб воно отримало клавіатурний ввід. У PowerShell використовуйте `npm.cmd`, якщо політика блокує `npm`.

```bash
npm run format:check
npm run build
```

## Сценарій демо

1. Loading screen показує поступове завантаження ресурсів.
2. Lobby запитує `/api/rooms`, показує зайнятість кімнат і періодично оновлює список.
3. Введіть ім’я, виберіть кімнату й натисніть **Join game**. Розмір арени береться з конфігурації кімнати.
4. Натисніть `Space`: куля малюється зі sprite sheet, а звук запускається через Web Audio після жесту користувача.
5. **Leave game** повертає в лобі та скасовує активний refresh.
6. У лобі кнопки запускають порівняння часу й failure gallery.

Керування в грі: `W/A/D` або стрілки — рух, `Space` — стріляти, `R` — рестарт.

## Asset pipeline

`public/assets/manifest.json` перелічує sprite sheet, звукові файли й JSON-дані. `loadAll()` запускає всі завантаження паралельно; після кожного результату оновлює progress bar. Гра стартує лише після завершення обов’язкових ресурсів. Якщо обов’язковий ресурс не завантажився, loading screen показує помилку й **Retry loading**. Помилка необов’язкового звуку не блокує гру.

`loadImage`, `loadAudio`, `loadJson` і `fetchJson` приймають `AbortSignal`. `fetchJson` окремо перевіряє `response.ok`: HTTP 404 — це HTTP-помилка, а не мережевий reject. `withRetry()` використовує exponential backoff із jitter, але не повторює 4xx або abort.

Завантаження sprite sheet і трьох WAV та JSON-файлів стартує одночасно. Для двох контрольованих 250 ms задач UI виміряв:

| Варіант             |    Час |
| ------------------- | -----: |
| Послідовний `await` | 503 ms |
| `Promise.all`       | 255 ms |

Час залежить від браузера та навантаження; обидва варіанти вимірюються кнопкою в лобі.

## Lobby, events і audio

`Lobby extends EventTarget` опитує `/api/rooms` раз на 5 секунд, застосовує timeout до кожного запиту й використовує `AbortController`. `leave()` скасовує поточний fetch і polling. DOM лобі знаходиться в `src/lobby/view.js`, окремо від класу `Lobby`.

Симуляція не імпортує audio чи UI модулі. Game session надсилає `fired`, `hit` і `exploded` у `GameEvents`; `audio-player.js` слухає ці події й запускає попередньо декодовані WAV буфери. `AudioContext` відновлюється тільки після кліку гравця.

## П’ять головоломок порядку

Запускайте в DevTools Console. Очікуваний вивід наведений під прикладом.

### 1. Promise вирішується один раз; `.then` завжди пізніше

```js
const p = new Promise((resolve) => {
  resolve('first')
  resolve('ignored')
})
p.then((value) => console.log('then', value))
console.log('after subscribe')
```

Вивід:

```text
after subscribe
then first
```

Другий `resolve` ігнорується, а реакція `.then` виконується в microtask, навіть якщо Promise вже fulfilled.

### 2. `await null` теж віддає керування циклу

```js
async function run() {
  console.log('before')
  await null
  console.log('after')
}
run()
console.log('sync')
```

Вивід: `before`, `sync`, `after`. Продовження після `await` стає microtask.

### 3. Таймер усередині `.then` і сусідня microtask

```js
console.log('sync')
Promise.resolve().then(() => {
  console.log('then')
  setTimeout(() => console.log('timer'), 0)
})
Promise.resolve().then(() => console.log('neighbor'))
```

Вивід: `sync`, `then`, `neighbor`, `timer`. Microtask queue спорожнюється раніше за timer task.

### 4. `requestAnimationFrame` і microtask

```js
console.log('sync')
requestAnimationFrame(() => console.log('frame'))
Promise.resolve().then(() => console.log('microtask'))
```

Вивід: `sync`, `microtask`, `frame`. Callback rAF виконується на кроці рендерингу, після поточних microtasks.

### 5. `async/await`, Promise reaction і timer

```js
setTimeout(() => console.log('task'), 0)
Promise.resolve().then(() => console.log('micro'))
;(async () => {
  console.log('async-start')
  await 0
  console.log('async-end')
})()
console.log('sync-end')
```

Вивід: `async-start`, `sync-end`, `micro`, `async-end`, `task`. Синхронний код завершується першим, потім відпрацьовують microtasks і лише потім timer.

## Failure gallery

Кнопка **Run failure gallery** перевіряє локальні dev endpoints і показує результат у лобі. Перевірено в браузері:

| Випадок                    | Результат                                        |
| -------------------------- | ------------------------------------------------ |
| 404 спрайта                | `HttpError 404`, одна спроба; 4xx не ретраїться  |
| Timeout                    | `TimeoutError`; лобі лишається доступним         |
| Abort посеред завантаження | `AbortError`; запит скасовано                    |
| Некоректний JSON           | `SyntaxError`; помилку спіймано, сторінка працює |

Локальні test endpoints створені Vite middleware у `vite.config.js`; це інструменти перевірки, а не production API.

## Структура

```text
src/
├── assets/loader.js          # loadImage/loadAudio/loadJson, retry, progress
├── assets/failure-gallery.js # контрольовані відмови та timing comparison
├── audio/                    # EventTarget шина та Web Audio playback
├── game/game-session.js      # симуляція, без імпорту audio/UI
├── lobby/                    # EventTarget lobby й окремий DOM view
├── render/                   # Canvas, sprites, HUD, loading screen
└── sim/                      # Entity, World, фізика та зіткнення
public/
├── api/                      # статичні room/arena JSON
└── assets/                   # manifest, sprite sheet, WAV звуки
```

## Перевірка

На цій версії перевірено `npm run format:check` і `npm run build`. У браузері перевірені loading → lobby → game → lobby, постріл зі sprite sheet і звуком, refresh/cancel lobby, чотири failure cases та sequential/concurrent timing.

## Технології

JavaScript ES Modules, Vite, Promises, `async`/`await`, Fetch, AbortController, EventTarget, Canvas 2D і Web Audio API.
