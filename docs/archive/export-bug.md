# Export bug — full mode fails with `ERR_FAILED 200 (OK)`

## Симптомы
- Light export работает
- Full export (с оригинальными изображениями) возвращает `net::ERR_FAILED 200 (OK)`
- Бэкенд лог: `[export:{dieId}] failed: Error: Request aborted (ECONNABORTED)`
- Прямой curl-запрос к бэкенду (порт 3001) работает корректно

## Что пробовали (не помогло)

| Попытка | Результат |
|---------|-----------|
| `app.ts`: `headersSent` check в error handler | Не влияет на экспорт |
| Vite proxy timeout 600s | Проблема не в proxy (обходили его) |
| `response.sendFile` вместо `response.download` | Не помогло |
| Direct backend URL (порт 3001, bypass proxy) | Всё равно `ERR_FAILED` |
| `createReadStream.pipe(response)` без Content-Disposition | Всё равно `ERR_FAILED` |
| `httpServer.requestTimeout = 0` | Не помогло |

## Наблюдения
- Экспорт работает через `curl http://localhost:3001/api/...` напрямую
- Не работает через браузер (и через Vite proxy, и напрямую на 3001)
- Бэкенд получает `ECONNABORTED` — браузер обрывает соединение
- Chrome показывает `ERR_FAILED 200 (OK)` — 200 OK получен, но тело ответа не доставлено

## Гипотезы
1. **Content-Disposition: attachment** — браузер перехватывает ответ для скачивания,
   fetch не может прочитать blob. Пробовали убрать — не помогло.
2. **Размер ответа** — ZIP > 50MB. Возможно лимит памяти Chrome для blob.
3. **CORS** — запрос на другой порт (3001). Даже с `Access-Control-Allow-Origin: *`.
4. **React Query mutation abort** — возможно mutation отменяет запрос по таймауту.

## Что попробовать дальше
1. **Вместо fetch → window.open / a.click с form POST** — обойти fetch API
2. **Чанкованный ответ** — backend должен слать частями, не одним blob
3. **Уменьшить/отключить CORS** — отдавать файл с того же порта (через Vite proxy)
   с корректным streaming
4. **Streams API** — использовать `response.body.getReader()` вместо blob
5. **Проверить на малом файле** — full export на die с маленьким изображением
