# Kie.ai MCP connector за Claude

Малък сървър, който превежда командите ти в чата ("направи банер със...") в реални
извиквания към Kie.ai API-то (генериране/редакция на изображения). Веднъж пуснат и
свързан, аз мога директно да викам Kie.ai вместо теб да местиш промптове в друг таб.

## Какво прави

Сървърът говори MCP (Model Context Protocol) през HTTP и излага 5 инструмента:

- **kie_generate_image** — основният инструмент за банери/реклами. По подразбиране
  ползва модела `flux1-kontext` (text-to-image + редакция на снимка чрез `inputImageUrl`),
  чака резултата и връща директен линк към готовото изображение.
- **kie_generate_image_gpt4o** — същото, но през отделния GPT-Image (gpt4o-image) endpoint
  на Kie.ai — добър за фотореалистични кадри или банери с много текст.
- **kie_create_task** / **kie_get_task_status** — по-суровите "generic" инструменти:
  пускат/проверяват задача за **произволен** модел от каталога на Kie.ai (Nano Banana,
  Midjourney, Grok Imagine и т.н.), стига да знаеш точния `model` slug и полетата му
  от [docs.kie.ai](https://docs.kie.ai). Полезни, ако утре поискаш модел, който не е
  сред вградените wrapper-и.
- **kie_get_gpt4o_task_status** — статус за задачи, пуснати през `kie_generate_image_gpt4o`.

Кодът е тестван локално (MCP handshake, tools/list, грешки) — виж `server2.log` логиката
по-долу не е нужна за теб, важното е, че протоколната част работи.

## 1. Вземи Kie.ai API ключ

https://kie.ai/api-key → копирай ключа.

## 2. Измисли си "парола" за сървъра (MCP_SHARED_SECRET)

Това пази сървъра ти да не бъде викан от случаен човек, ако разбере линка му (иначе
би харчил твоите Kie.ai кредити). Всеки дълъг случаен низ върши работа, напр.:

```
openssl rand -hex 24
```

Ако нямаш терминал под ръка, просто измисли дълъг случаен низ на ръка (30+ символа).

## 3. Деплойни го (препоръка: Render.com, безплатно, само през браузър)

1. Качи тази папка в нов **GitHub repository** (github.com → New repository → Add file →
   Upload files → провлачи всички файлове от тази папка → Commit). Не е нужен git в
   терминала, всичко става през сайта на GitHub.
2. Отиди в https://render.com → New → **Web Service** → избери токущо създадения repo.
3. Настройки:
   - **Runtime**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. В **Environment** добави:
   - `KIE_AI_API_KEY` = твоят ключ от стъпка 1
   - `MCP_SHARED_SECRET` = паролата от стъпка 2
   - `ALLOWED_HOSTS` = `<име>.onrender.com` (Render ти показва точния адрес — попълни
     го тук СЛЕД първия деплой, после направи "Manual Deploy" пак, за да влезе в сила)
5. Deploy. Render ще ти даде публичен адрес от вида `https://kie-mcp-xxxx.onrender.com`.
   MCP endpoint-ът е `https://kie-mcp-xxxx.onrender.com/mcp`.

(Ако предпочиташ Railway, Fly.io или собствен VPS — проектът е обикновено Node.js
приложение, включен е и `Dockerfile`, работи навсякъде, само `KIE_AI_API_KEY`,
`MCP_SHARED_SECRET` и `ALLOWED_HOSTS` трябва да са зададени.)

> Забележка: Render Free приспива услугата след неактивност и първото повикване след
> това отнема ~30-50 сек, докато се събуди — нормално е, не е грешка.

## 4. Добави го в Claude

Settings → Connectors → **Add custom connector**:

- **URL**: `https://kie-mcp-xxxx.onrender.com/mcp`
- Ако интерфейсът предложи "Request header" / "static header" автентикация — избери я
  и сложи `Authorization` = `Bearer <твоята MCP_SHARED_SECRET>`. Ако тази опция не се
  вижда при теб (в момента е в бета и невинаги достъпна за всеки план), можеш да
  оставиш връзката без хедър — тогава сигурността разчита само на това, че никой друг
  не знае адреса ти.

След свързването инструментите `kie_generate_image` и др. ще се появят достъпни за мен
в чата — на claude.ai през браузъра, в Cowork, а по-късно и в desktop приложението,
защото custom connector-ите са вързани към акаунта ти, не към конкретно устройство.

## 5. Тествай

Кажи ми в чата нещо от рода на:

> Генерирай банер 1200x628 с текст "-30% тази седмица" в стил ярък градиент, чрез Kie.ai

Аз ще извикам `kie_generate_image` (или `kie_generate_image_gpt4o`) вместо теб.

## Локално тестване (по желание)

```
npm install
npm run build
KIE_AI_API_KEY=... MCP_SHARED_SECRET=testsecret npm start
```

Сървърът слуша на `http://localhost:3000/mcp`.
