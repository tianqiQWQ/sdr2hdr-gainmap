#!/usr/bin/env node
/* Regression: importing/re-importing must always default to the split compare view,
 * even if the previous image was being viewed in true HDR mode (which used to keep
 * previewMode=truehdr, force view back to HDR and disable the compare tab).
 *
 * Usage: node tools/test_default_view.js [first.jpg] [second.jpg]
 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(__dirname, "..");
const first = process.argv[2] || path.join(ROOT, "tests/input_synthetic_12mp.jpg");
const second = process.argv[3] || path.join(ROOT, "tests/input_long_9x16.jpg");

(async () => {
  for (const f of [first, second]) {
    if (!fs.existsSync(f)) throw new Error("missing test image: " + f);
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto("file://" + path.join(ROOT, "index.html"), { waitUntil: "load" });
  await page.waitForFunction("window.__hdrApp");
  console.log("app version:", await page.evaluate(() => window.__hdrApp.version));

  async function load(file) {
    await (await page.$("#file")).uploadFile(file);
    await page.waitForFunction((name) => state.file && state.file.name === name, { timeout: 120000 }, path.basename(file));
    await page.waitForFunction('state.view === "split" && !document.getElementById("splitBar").classList.contains("hidden")', { timeout: 30000 });
    return page.evaluate(() => ({
      view: state.view,
      mode: els.previewMode.value,
      splitDisabled: document.querySelector('#viewTabs button[data-view="split"]').disabled,
      tags: !document.getElementById("tagL").classList.contains("hidden") && !document.getElementById("tagR").classList.contains("hidden"),
    }));
  }

  let r = await load(first);
  console.log("first import:", JSON.stringify(r));
  if (r.view !== "split" || r.mode !== "gain" || r.splitDisabled || !r.tags) errors.push("first import not default split");

  // 选“真 HDR”，再导入第二张图；修复前会被 truehdr 顶回 HDR 并禁用对比
  await page.select("#previewMode", "truehdr");
  await page.waitForFunction('document.getElementById("hdrImg").src.indexOf("blob:") === 0', { timeout: 30000 });
  console.log("true HDR before re-import:", JSON.stringify(await page.evaluate(() => ({ view: state.view, mode: els.previewMode.value }))));

  r = await load(second);
  console.log("second import:", JSON.stringify(r));
  if (r.view !== "split" || r.mode !== "gain" || r.splitDisabled || !r.tags) errors.push("re-import not default split");

  // 再选真 HDR，然后点对比：按钮应仍可点，并回退到标准模拟
  await page.select("#previewMode", "truehdr");
  await page.waitForFunction('document.getElementById("hdrImg").src.indexOf("blob:") === 0', { timeout: 30000 });
  await page.click('#viewTabs button[data-view="split"]');
  await new Promise((r) => setTimeout(r, 800));
  const recovered = await page.evaluate(() => ({ view: state.view, mode: els.previewMode.value }));
  console.log("split from true HDR:", JSON.stringify(recovered));
  if (recovered.view !== "split" || recovered.mode !== "gain") errors.push("split click did not recover from true HDR");

  await page.screenshot({ path: path.join(ROOT, "tests/v20_default_split_regression.png") });
  console.log("js errors:", errors.length ? errors : "none");
  if (errors.length) process.exitCode = 1;
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
