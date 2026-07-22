import { CONFIG } from "../lib/config";

test("config has sane defaults", () => {
  expect(CONFIG.appName).toBe("qfc");
  expect(CONFIG.aurora.minAcu).toBeGreaterThanOrEqual(0.5);
  // QGIS image (docker-qgis) is amd64-only; ARM64 tasks cannot run it.
  expect(CONFIG.cpuArchitecture).toBe("X86_64");
});
