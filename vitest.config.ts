import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Undo every vi.spyOn() after each test, so one test's spies can't leak into the next.
    restoreMocks: true,
  },
});
