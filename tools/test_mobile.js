#!/usr/bin/env node
/* Mobile UI test (390x844): single HDR image, bottom parameter chips, export entry. */
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, "tests");

(async () => {
  const input = process.argv[2] || "tests/input_synthetic_12mp.jpg";
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  await page.goto("file://" + path.join(ROOT, "index.html"), { waitUntil: "load" });
  await page.waitForFunction("window.__hdrApp && window.__hdrApp.version");
  console.log("app version:", await page.evaluate(() => window.__hdrApp.version));

  await (await page.$("#file")).uploadFile(path.join(ROOT, input));
  await page.waitForFunction('!document.getElementById("mobileParams").classList.contains("hidden")', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 900));

  const layout = await page.evaluate(() => {
    const disp = (id) => getComputedStyle(document.getElementById(id)).display;
    return {
      figSdr: disp("figSdr"),
      sidePanel: disp("sidePanel"),
      mobileParams: disp("mobileParams"),
      figHdr: disp("figHdr"),
      chips: document.querySelectorAll("#mChips .m-chip").length,
      dropHidden: getComputedStyle(document.getElementById("drop")).display === "none",
    };
  });
  console.log("mobile layout:", JSON.stringify(layout));
  if (layout.figSdr !== "none") errors.push("SDR figure should be hidden on mobile");
  if (layout.sidePanel !== "none") errors.push("sidebar should be hidden on mobile");
  if (layout.mobileParams !== "block") errors.push("mobile parameter bar missing");
  if (layout.chips < 6) errors.push("mobile chips missing");
  if (!layout.dropHidden) errors.push("drop zone should be hidden after load on mobile");
  await page.screenshot({ path: path.join(SHOTS, "ui_v12_mobile_edit.png") });

  // 按住画面 → 显示 SDR，松开恢复
  await page.evaluate(() => {
    const el = document.getElementById("figHdr");
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 100, clientY: 300 }));
  });
  await new Promise((r) => setTimeout(r, 350));
  const pressOn = await page.evaluate(() => !document.getElementById("cvPressSdr").classList.contains("hidden"));
  console.log("press shows SDR:", pressOn);
  if (!pressOn) errors.push("press-to-SDR overlay not shown");
  await page.screenshot({ path: path.join(SHOTS, "ui_v13_press_sdr.png") });
  await page.evaluate(() => document.getElementById("figHdr").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" })));
  await new Promise((r) => setTimeout(r, 300));
  const pressOff = await page.evaluate(() => document.getElementById("cvPressSdr").classList.contains("hidden"));
  console.log("release hides SDR:", pressOff);
  if (!pressOff) errors.push("press-to-SDR overlay not hidden");

  // 增益图灰度 chip
  await page.evaluate(() => [...document.querySelectorAll("#mChips .m-chip")].find((b) => b.dataset.param === "gainmap").click());
  await new Promise((r) => setTimeout(r, 700));
  const gm = await page.evaluate(() => ({
    mode: document.getElementById("previewMode").value,
    active: [...document.querySelectorAll("#mChips .m-chip")].find((b) => b.dataset.param === "gainmap").classList.contains("on"),
  }));
  console.log("mobile gainmap:", JSON.stringify(gm));
  if (gm.mode !== "gainmap" || !gm.active) errors.push("mobile gain map toggle failed");
  await page.screenshot({ path: path.join(SHOTS, "ui_v13_mobile_gainmap.png") });
  await page.evaluate(() => [...document.querySelectorAll("#mChips .m-chip")].find((b) => b.dataset.param === "gainmap").click());
  await new Promise((r) => setTimeout(r, 500));

  // 点“强度” chip → 展开滑块，调整后同步到桌面隐藏控件
  await page.evaluate(() => [...document.querySelectorAll("#mChips .m-chip")].find((b) => b.dataset.param === "strength").click());
  await new Promise((r) => setTimeout(r, 300));
  const sheet = await page.evaluate(() => ({
    visible: !document.getElementById("mSheet").classList.contains("hidden"),
    rows: document.querySelectorAll("#mSheet .m-row").length,
    value: document.querySelector("#mSheet input[type=range]").value,
    nan: document.getElementById("mSheet").innerText.indexOf("NaN") >= 0,
  }));
  console.log("strength sheet:", JSON.stringify(sheet));
  if (!sheet.visible || sheet.rows !== 1 || sheet.nan) errors.push("mobile sheet state wrong");
  await page.evaluate(() => {
    const inp = document.querySelector("#mSheet input[type=range]");
    inp.value = "80";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 800));
  const synced = await page.evaluate(() => ({
    desktop: document.getElementById("strength").value,
    chip: [...document.querySelectorAll("#mChips .m-chip")].find((b) => b.dataset.param === "strength").textContent,
  }));
  console.log("synced strength:", JSON.stringify(synced));
  if (synced.desktop !== "80" || !synced.chip.includes("80")) errors.push("mobile slider not synced");
  await page.screenshot({ path: path.join(SHOTS, "ui_v12_mobile_sheet.png") });

  // 高级参数面板
  await page.evaluate(() => [...document.querySelectorAll("#mChips .m-chip")].find((b) => b.dataset.param === "advanced").click());
  await new Promise((r) => setTimeout(r, 300));
  const advRows = await page.evaluate(() => document.querySelectorAll("#mSheet .m-row").length);
  console.log("advanced sheet rows:", advRows);
  if (advRows < 5) errors.push("advanced mobile sheet incomplete");
  await page.screenshot({ path: path.join(SHOTS, "ui_v12_mobile_advanced.png") });

  // 导出界面：移动参数条与底栏隐藏
  await page.click("#exportBtn");
  await new Promise((r) => setTimeout(r, 500));
  const exp = await page.evaluate(() => ({
    exportVisible: !document.getElementById("exportScreen").classList.contains("hidden"),
    chipsHidden: document.getElementById("mobileParams").classList.contains("hidden"),
    bottomHidden: document.getElementById("bottomBar").classList.contains("hidden"),
  }));
  console.log("mobile export:", JSON.stringify(exp));
  if (!exp.exportVisible || !exp.chipsHidden || !exp.bottomHidden) errors.push("mobile export screen wrong");
  await page.screenshot({ path: path.join(SHOTS, "ui_v12_mobile_export.png") });

  console.log("js errors:", errors.length ? errors : "none");
  if (errors.length) process.exitCode = 1;
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
