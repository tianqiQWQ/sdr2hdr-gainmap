#!/usr/bin/env node
/* Manual skin-picker regression: default off, sample from the image, tolerance/mask
 * controls, side-by-side overlay alignment, clearing and reset on re-import.
 * Uses a tiny embedded PNG fixture so it does not depend on external assets.
 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(__dirname, "..");
const FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAASwAAADICAIAAADdvUsCAAACoElEQVR42u3dvXEiQRSF0W+oiUCh4BIArkoBKAYZGNjYREEARIHSIQZFoZqfPieCZXdvvde3eqqn4+c1YDkHfwUghCCEgBDCsOYmfwmwaAhlEKyjIISAEIJiBjAJQTsKmIQghIBiBkxCQAhBOwqYhKCYAUxCEEJACEE7CihmwDoKCCEIISCE0P7aUcUMmIQghIAQghACuTED7o4C1lEQQkAIQTEDmISgHQVMQhBCQDEDJiEghKAdBUxCUMzAGvzet/HnPF1MQrCOAkII2lEY1aSYga2k0DoKzoQghIAQQl5lGsXj68O/+hp8P9/7/oGTYgaso4AQghACuTFDW7/Wtfcf6O4oMrjwD7SOgjMhCCGQYgaHwnzKBPiyHoMw7SiQYgYUM2AfVcyAdRTQjmJZSzsKKGYwKVLMAClmQAgB7SiOhF5lAilUzIAzISCEIIRAXmWicR4tyqtMgHUUhBAQQsinTJAbM15lQgZ9WQ84E4IQAilmcCj0KRPgy3oMQu0okGIGFDNgH1XMgHUU0I5iG9WOAooZjELFDJBiBoQQ0I7iSOhVJpBC6yg4EwJCCEII5FUm8irTqn/g7H8D23K+WUcBIQQhBPIpE7kx4+4oyKB1FIQQEEJQzIBDoUkI2lEwCE1CEEJAMYN91CQEhBC0o2AbNQlBMQNGoUkIQggIIWhHwZFQMYMUWkcBIQQhBIQQ8ioTNMyrTCYhCCEghCCEQG7MkBsz7o6CDFpHQQgBIQTFDDgUmoSgHQWD0CQEIQQUM9hHTUJACEE7im0UkxAUMxiFzKP94J/X27861lFACEE7CihmwDoKCCEIIQghkFeZwCQEhBCEEBBCyI0ZwN1RsI4CQghCCChmwCQEtKNgEgJCCIoZwCQEIQS0o2ASAv/gD+lGC4d7bIUfAAAAAElFTkSuQmCC",
  "base64"
);

(async () => {
  const tmpPath = path.join(ROOT, "tests", "skin_picker_fixture.png");
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
  fs.writeFileSync(tmpPath, FIXTURE);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new", protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto("file://" + path.join(ROOT, "index.html"), { waitUntil: "load" });
  await page.waitForFunction("window.__hdrApp");
  await (await page.$("#file")).uploadFile(tmpPath);
  await page.waitForFunction('!document.getElementById("editor").classList.contains("hidden") && state.bitmap', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 700));

  const def = await page.evaluate(() => ({
    view: state.view,
    portrait: document.getElementById("portrait").checked,
    manual: document.getElementById("skinManual").checked,
    samples: state.skinSamples.length,
    maskDisabled: document.getElementById("skinShowMask").disabled,
  }));
  console.log("defaults:", JSON.stringify(def));
  if (def.portrait) errors.push("auto skin detection should default off");
  if (def.manual || def.samples || !def.maskDisabled) errors.push("manual skin protection should default off/empty");

  await page.click('#viewTabs button[data-view="sdr"]');
  await new Promise((r) => setTimeout(r, 300));
  await page.click("#skinPickBtn");
  await new Promise((r) => setTimeout(r, 250));
  const frame = await (await page.$("#viewFrame")).boundingBox();
  // fixture 300x200, skin patch around (80,60)-(210,170)
  await page.mouse.click(frame.x + frame.width * (145 / 300), frame.y + frame.height * (115 / 200));
  await new Promise((r) => setTimeout(r, 700));
  const picked = await page.evaluate(() => ({
    samples: state.skinSamples.length,
    manual: state.skinManual,
    pick: state.skinPickMode,
    swatches: document.querySelectorAll("#skinSwatches .skin-swatch").length,
    maskDisabled: document.getElementById("skinShowMask").disabled,
  }));
  console.log("after pick:", JSON.stringify(picked));
  if (picked.samples !== 1 || !picked.manual || !picked.pick) errors.push("skin picker did not sample correctly");
  if (picked.swatches !== 1 || picked.maskDisabled) errors.push("swatch/mask toggle not enabled");

  await page.evaluate(() => {
    const cb = document.getElementById("skinShowMask");
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 500));
  let mask = await page.evaluate(() => ({
    frame: !document.getElementById("skinMaskFrame").classList.contains("hidden"),
    left: !document.getElementById("skinMaskSideL").classList.contains("hidden"),
  }));
  console.log("mask (SDR view):", JSON.stringify(mask));
  if (!mask.frame || mask.left) errors.push("mask overlay should show only on the frame view");
  await page.screenshot({ path: path.join(ROOT, "tests", "skin_picker_frame.png") });

  await page.click('#viewTabs button[data-view="side"]');
  await new Promise((r) => setTimeout(r, 700));
  mask = await page.evaluate(() => ({
    frame: !document.getElementById("skinMaskFrame").classList.contains("hidden"),
    left: !document.getElementById("skinMaskSideL").classList.contains("hidden"),
    right: !document.getElementById("skinMaskSideR").classList.contains("hidden"),
  }));
  console.log("mask (side view):", JSON.stringify(mask));
  if (mask.frame || !mask.left || !mask.right) errors.push("side mask overlays should be visible in side view");
  await page.screenshot({ path: path.join(ROOT, "tests", "skin_picker_side.png") });

  await page.click("#skinClearBtn");
  await new Promise((r) => setTimeout(r, 400));
  const cleared = await page.evaluate(() => ({
    samples: state.skinSamples.length,
    manual: state.skinManual,
    left: document.getElementById("skinMaskSideL").classList.contains("hidden"),
  }));
  console.log("after clear:", JSON.stringify(cleared));
  if (cleared.samples || cleared.manual || !cleared.left) errors.push("clear should remove samples and mask");

  // 重新导入必须重置
  await page.evaluate(() => { const f = document.getElementById("file"); f.value = ""; });
  await (await page.$("#file")).uploadFile(tmpPath);
  await page.waitForFunction((name) => state.file && state.file.name === name, { timeout: 30000 }, "skin_picker_fixture.png");
  await new Promise((r) => setTimeout(r, 700));
  const reloaded = await page.evaluate(() => ({
    samples: state.skinSamples.length,
    manual: state.skinManual,
    portrait: document.getElementById("portrait").checked,
    view: state.view,
  }));
  console.log("after re-import:", JSON.stringify(reloaded));
  if (reloaded.samples || reloaded.manual || reloaded.portrait) errors.push("re-import should reset skin protection");

  console.log("js errors:", errors.length ? errors : "none");
  if (errors.length) process.exitCode = 1;
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
