#!/usr/bin/env node
/* TIFF input test: decode 16-bit / LZW TIFFs in the browser and verify the editor loads them.
 *
 * Usage:
 *   node tools/test_tif.js path/to/a.tif [path/to/b.tif ...]
 *   (若不给参数，会尝试 tests/tif/*.tif；没有文件时跳过)
 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, "tests");

(async () => {
  let files = process.argv.slice(2);
  if (!files.length) {
    const dir = path.join(ROOT, "tests", "tif");
    if (fs.existsSync(dir)) {
      files = fs.readdirSync(dir).filter((f) => /\.tiff?$/i.test(f)).map((f) => path.join(dir, f));
    }
  }
  if (!files.length) {
    console.log("SKIP: no TIFF files given and tests/tif/ is empty");
    return;
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    protocolTimeout: 600000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files", "--js-flags=--max-old-space-size=4096"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto("file://" + path.join(ROOT, "index.html"), { waitUntil: "load" });
  await page.waitForFunction("window.__hdrApp && window.__hdrApp.version");
  console.log("app version:", await page.evaluate(() => window.__hdrApp.version));
  const accept = await page.$eval("#file", (el) => el.getAttribute("accept"));
  console.log("file accept:", accept);
  if (!/tiff?/.test(accept)) errors.push("file input does not accept TIFF");

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = path.basename(file);
    const size = fs.statSync(file).size;
    console.log(`\n--- TIFF ${i + 1}/${files.length}: ${name} (${(size / 1048576).toFixed(0)} MB) ---`);
    const t0 = Date.now();
    await (await page.$("#file")).uploadFile(file);
    // 等待当前文件真正完成解码（state.file 在解码成功后才更新）
    await page.waitForFunction((fname) => state.file && state.file.name === fname, { timeout: 600000 }, name);
    await page.waitForFunction('!document.getElementById("bottomBar").classList.contains("hidden")', { timeout: 600000 });
    const elapsed = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 600));
    const info = await page.evaluate(() => ({
      dims: [state.bitmap.width, state.bitmap.height],
      isTiff: state.isTiff,
      note: document.getElementById("note").innerText.replace(/\s+/g, " ").slice(0, 160),
      metaFormat: (document.getElementById("meta").innerText.match(/输入格式[^\n]*/) || [""])[0],
      caption: document.getElementById("sdrCaption").textContent.slice(0, 60),
    }));
    console.log("load ms:", elapsed);
    console.log("info:", JSON.stringify(info));
    if (!info.isTiff || info.dims[0] < 64 || info.dims[1] < 64) errors.push("TIFF did not load: " + name);
    if (elapsed > 60000) console.log("warning: TIFF decode took longer than 60s");
    if (i === 0) {
      await page.screenshot({ path: path.join(SHOTS, "ui_v15_tif.png") });
      console.log("screenshot: ui_v15_tif.png");
    }
  }

  console.log("\njs errors:", errors.length ? errors : "none");
  if (errors.length) process.exitCode = 1;
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
