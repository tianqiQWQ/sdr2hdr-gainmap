#!/usr/bin/env node
/* Load-error UX test: visible banner on first import failure + JPEG missing-EOI auto-repair. */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, "tests");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 1280, height: 900 });

  // 准备测试文件
  const good = path.join(ROOT, "tests", "input_synthetic_12mp.jpg");
  const noEoi = path.join(ROOT, "tests", "broken_no_eoi.jpg");
  const invalid = path.join(ROOT, "tests", "broken_invalid.jpg");
  if (!fs.existsSync(good)) throw new Error("missing test input: " + good);
  const raw = fs.readFileSync(good);
  fs.writeFileSync(noEoi, raw.subarray(0, raw.length - 2)); // 去掉 EOI
  fs.writeFileSync(invalid, Buffer.from("not a real jpeg at all"));

  await page.goto("file://" + path.join(ROOT, "index.html"), { waitUntil: "load" });
  await page.waitForFunction("window.__hdrApp && window.__hdrApp.version");
  console.log("app version:", await page.evaluate(() => window.__hdrApp.version));

  // 1) 首次导入损坏文件：主界面必须显示错误
  await (await page.$("#file")).uploadFile(invalid);
  await new Promise((r) => setTimeout(r, 800));
  const bad = await page.evaluate(() => ({
    banner: !document.getElementById("loadError").classList.contains("hidden"),
    text: document.getElementById("loadError").innerText.replace(/\s+/g, " ").slice(0, 100),
    editorHidden: document.getElementById("editor").classList.contains("hidden"),
  }));
  console.log("invalid first import:", JSON.stringify(bad));
  if (!bad.banner || !bad.editorHidden) errors.push("first import failure not visible");
  await page.screenshot({ path: path.join(SHOTS, "ui_v13_load_error.png") });
  await page.evaluate(() => { const b = document.querySelector(".le-close"); if (b) b.click(); });

  // 2) 缺少 EOI 的图：自动修复并导入 + 警告
  await (await page.$("#file")).uploadFile(noEoi);
  await new Promise((r) => setTimeout(r, 1500));
  const repaired = await page.evaluate(() => ({
    banner: !document.getElementById("loadError").classList.contains("hidden"),
    text: document.getElementById("loadError").innerText.replace(/\s+/g, " ").slice(0, 100),
    editorVisible: !document.getElementById("editor").classList.contains("hidden"),
  }));
  console.log("missing-EOI import:", JSON.stringify(repaired));
  if (!repaired.banner || !repaired.editorVisible) errors.push("missing EOI not repaired/reported");
  await page.screenshot({ path: path.join(SHOTS, "ui_v13_load_repaired.png") });

  // 3) 正常文件：警告横幅应消失
  await (await page.$("#file")).uploadFile(good);
  await new Promise((r) => setTimeout(r, 1500));
  const ok = await page.evaluate(() => document.getElementById("loadError").classList.contains("hidden"));
  console.log("normal import banner hidden:", ok);
  if (!ok) errors.push("banner not cleared after normal import");

  console.log("js errors:", errors.length ? errors : "none");
  if (errors.length) process.exitCode = 1;
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
