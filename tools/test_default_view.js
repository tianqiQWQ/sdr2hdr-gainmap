#!/usr/bin/env node
/* Default-view regression: importing/re-importing must always land on the
 * intended default view (desktop: side-by-side, mobile: slider split) and all
 * four modes must remain reachable.
 *
 * Usage: node tools/test_default_view.js
 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(__dirname, "..");
const first = path.join(ROOT, "tests/input_synthetic_12mp.jpg");
const second = path.join(ROOT, "tests/input_long_9x16.jpg");

(async () => {
  for (const f of [first, second]) if (!fs.existsSync(f)) throw new Error("missing test image: " + f);
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
  console.log("app version:", await page.evaluate(() => window.__hdrApp.version));

  async function load(file) {
    await (await page.$("#file")).uploadFile(file);
    await page.waitForFunction((name) => state.file && state.file.name === name, { timeout: 120000 }, path.basename(file));
    await page.waitForFunction('!document.getElementById("editor").classList.contains("hidden") && state.bitmap', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 800));
    return page.evaluate(() => ({
      view: state.view,
      mode: els.previewMode.value,
      sideVisible: !document.getElementById("sideView").classList.contains("hidden"),
      stageHidden: document.getElementById("viewStage").classList.contains("hidden"),
      tabs: [...document.querySelectorAll("#viewTabs button")].map((b) => b.dataset.view),
      captions: [...document.querySelectorAll("#sideView figcaption")].map((x) => x.textContent),
    }));
  }

  let r = await load(first);
  console.log("first import:", JSON.stringify(r));
  if (r.view !== "side" || !r.sideVisible || !r.stageHidden) errors.push("first import should default to side-by-side");
  if (r.tabs.length !== 4) errors.push("four view modes missing");

  r = await load(second);
  console.log("second import:", JSON.stringify(r));
  if (r.view !== "side" || !r.sideVisible) errors.push("re-import should default to side-by-side");

  // 切到两种对比模式再回来
  for (const v of ["split", "sdr", "hdr", "side"]) {
    await page.click(`#viewTabs button[data-view="${v}"]`);
    await new Promise((res) => setTimeout(res, 350));
    const got = await page.evaluate(() => state.view);
    if (got !== v) errors.push(`view ${v} did not activate (got ${got})`);
  }

  await page.screenshot({ path: path.join(ROOT, "tests/v21_default_side.png") });
  console.log("js errors:", errors.length ? errors : "none");
  if (errors.length) process.exitCode = 1;
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
