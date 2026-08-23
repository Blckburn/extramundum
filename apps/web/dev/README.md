# Пробные страницы

Не входят в сборку: Vite собирает только `index.html`, а эти файлы лежат
вне корня сборки и в `dist` не попадают. Проверено `pnpm check:bundle`.

Нужны для локального замера в настоящем браузере:

```bash
pnpm --filter @extramundum/web dev -- --port 5199
pnpm render:probe                 # цифры от самого рендера + скриншот
pnpm render:probe -- --url http://127.0.0.1:5199/dev/layout.html --width 380 --height 780
```

`scene.html` — сцена без интерфейса, меряет вызовы отрисовки и кадр.
`layout.html` — настоящий экран арены, меряет переполнение и перекрытие.
