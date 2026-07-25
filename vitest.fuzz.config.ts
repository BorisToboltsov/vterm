import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

// Nightly-only вариант базового конфига для глубокого fuzz-прогона
// (untrusted.fuzz.test.ts при FUZZ_RUNS=150000).
//
// Зачем отдельный конфиг. Изолированный запуск fuzz-файла на раннере валил
// vitest ещё на старте: dep-optimizer собирает пребандл через rolldown 1.1.5,
// чей CJS-runtime тянет `import { createRequire } from 'node:module'`, а под
// web-таргет `node:module` не резолвится — `[RESOLVE_ERROR] Could not resolve
// 'node:module' in \0rolldown/runtime.js`. Полный `pnpm test` падает так же;
// проходит лишь `pnpm test:coverage`, но гнать coverage поверх 150k прогонов
// нельзя — оверхед упрётся в таймаут теста.
//
// Пребандл зависимостей — это ускорение старта, а не требование корректности:
// с выключенным оптимизатором vite трансформирует зависимости на лету, минуя
// rolldown-runtime и саму ошибку. Правка узкая — только этот конфиг, только
// nightly; основной vitest.config.ts и PR-CI (pnpm test:coverage) не тронуты.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      deps: { optimizer: { web: { enabled: false }, ssr: { enabled: false } } },
    },
  }),
);
