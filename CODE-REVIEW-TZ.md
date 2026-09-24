# ТЗ: исправления по итогам код-ревью (8 слоёв)

Дата: 2026-09-24. Источник: восьмислойный разбор кода и прода (read-only, прод не менялся).
Исполнитель: владелец репозитория. Работа на `main`, деплой — `bun run ship <symbol>`,
проверка — `bun run check` (это гейт) и команды из `bun run prod guide`.

## Как пользоваться этим ТЗ

- Приоритеты: **P0** — в течение суток (риск истории данных); **P1** — текущий спринт
  (эффективность, диагностика, рост); **P2** — планово (гигиена, структура).
- Формат пункта: Проблема → Доказательство → Что сделать → Критерий приёмки → Оценка.
- Оценка: S — до часа, M — до дня, L — больше дня.
- Ни один пункт не требует смены архитектуры: это либо однострочники, либо пережитки роста,
  либо осознанные компромиссы, которым недописана политика.

> **Где живёт этот файл.** Он лежит в корне репозитория намеренно. `scripts/check-language.ts`
> сканирует `src/`, `scripts/`, `tests/`, `docs/` (расширения `.md` включительно) и падает на
> любой кириллице, а CI (`paths-ignore: "*.md"`) на корневые markdown не запускается вовсе.
> Если этот файл когда-нибудь поедет в `docs/`, его придётся перевести на английский целиком,
> иначе `bun run check` покраснеет.

## Сводка

| ID | Что | Prio | Оценка |
|---|---|---|---|
| Б-1 | Горизонт бэкапов схлопнут деплоями: KEEP=5 на общий пул снапшотов | P0 | S |
| Б-2 | Осиротевший `backup-*.db` в `data/` при прерывании между фазами | P1 | S |
| Б-3 | `superseded-*` и старый `signal-forge-*.json` вне ротации | P2 | S |
| Б-4 | Проверить на хосте cron ночного job и его `*_BACKUP_KEEP` | P0 | S |
| И-1 | Индекс `events(source, entity_id, id)` (9 запросов истории) | P1 | S |
| И-2 | Индекс `events(source, kind, detected_at)` (rename: SCAN+TEMP B-TREE) | P1 | S |
| И-3 | Индекс `events(detected_at, id)` (8+ потребителей отчётов) | P1 | S |
| И-4 | Индекс `records(stream)` (knownModelNames: SCAN records) | P1 | S |
| Р-1 | Ретеншен `source_collection_metrics`, 90 д (144 873 строки, не чистится) | P1 | S |
| Р-2 | Ретеншен `deliveries` 90 д, `suppressions` 180 д, `alert_attempts` 90 д | P2 | S |
| Р-3 | Size-aware ретеншен `snapshots` (174 МБ = 42% содержимого БД) | P2 | M |
| Р-4 | Бюджет `http_cache` 64 → 16 МБ (65.9 МБ ради «сэкономить запрос») | P2 | S |
| Д-1 | `SourceError`: вернуть понятные ошибки коллекторов в issues | P1 | M |
| Д-2 | `fetchBytes`: 11 контентных вызовов в обход политики `fetchText` | P1 | M |
| Д-3 | Async `Bun.gzip/gunzip` вместо `Sync` на многомегабайтных payload | P1 | S |
| П-1 | Инкрементальные `rebuildModelFacts`/`rebuildHypotheses` | P1 | L |
| П-2 | Кэш `knownModelNames` (+ индекс `records(observed_at)`) | P2 | S |
| П-3 | Двойной `MAX(id)` и тройные `filter` в пайплайне | P2 | S |
| С-1 | Retry-once-on-degraded для `arena` (36% отказов недели) | P1 | S |
| С-2 | Кап бэкоффа для суточных источников + `retry_at` в `issues` | P1 | S |
| С-3 | `confirmChanges`: политика после N неподтверждённых чтений | P1 | M |
| С-4 | Pacing-группа `artificialanalysis.ai` | P2 | S |
| С-5 | `claude-web`: разобрать bot-protection (58.7% отказов) | P2 | M |
| О-1 | `release-audit`: до-классификаторные события → `unjudged` | P2 | S |
| О-2 | `coverage-gaps`: аннотировать дыры классом/событием | P2 | S |
| Г-1 | Кавычки в Telegram-HTML + `try/catch` в `pretty()` | P1 | S |
| Г-2 | `readonlyDatabase()` в `operations/database.ts` (busy_timeout) | P1 | S |
| Г-3 | `logoData`: валидация имени логотипа | P2 | S |
| Г-4 | `MAX_ATTACHMENT_BYTES` — действительно байты, а не символы | P2 | S |
| Г-5 | Checksums миграций (`migrations.lock` / `applied_migrations`) | P2 | M |
| Г-6 | `retire-source` + фильтр отчётов по реестру (9 строк-сирот) | P2 | M |
| Г-7 | Biome: `complexity/noExcessiveCognitiveComplexity` | P2 | S |
| Г-8 | Boot-пересборки обернуть в `measure` | P2 | S |
| Г-9 | Тесты: property `due()`; эквивалентность П-1; retired-source; `oneSpelling` | P2 | M |
| Г-10 | README: `src/operations.ts` → `definition.ts`; Status-секция | P2 | S |
| Г-11 | AGENTS.md: строка про единственный lease (collection) | P2 | S |
| Г-12 | Опционально: assert в `budget.ts`; санитайзинг markdown-id | P2 | S |

%%APPEND%%
