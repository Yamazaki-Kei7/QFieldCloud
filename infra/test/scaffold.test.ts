import { CONFIG } from "../lib/config";

test("config has sane defaults", () => {
  expect(CONFIG.appName).toBe("qfc");
  expect(CONFIG.aurora.minAcu).toBeGreaterThanOrEqual(0.5);
  expect(["ARM64", "X86_64"]).toContain(CONFIG.cpuArchitecture);
});
