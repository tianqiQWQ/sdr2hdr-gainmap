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
  const mobileDefault = await page.evaluate(() => ({
    view: state.view,
    headerBtn: getComputedStyle(document.getElementById("headerOpenBtn")).display,
    drop: getComputedStyle(document.getElementById("drop")).display,
    tabs: [...document.querySelectorAll("#viewTabs button")].map((b) => [b.dataset.view, getComputedStyle(b).display]),
  }));
  console.log("mobile default:", JSON.stringify(mobileDefault));
  if (mobileDefault.tabs.some(([v, d]) => v === "side" && d !== "none")) errors.push("mobile should hide side-by-side tab");
  if (mobileDefault.tabs.filter(([, d]) => d !== "none").length !== 3) errors.push("mobile should have three view tabs");
  if (mobileDefault.view !== "split") errors.push("mobile should default to split view");
  if (mobileDefault.headerBtn !== "none") errors.push("header open button should stay hidden on mobile");
  if (mobileDefault.drop !== "none") errors.push("mobile drop bar should be hidden after load");

  const layout = await page.evaluate(() => {
    const disp = (id) => getComputedStyle(document.getElementById(id)).display;
    const rr = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) }; };
    return {
      sidePanel: disp("sidePanel"),
      mobileParams: disp("mobileParams"),
      viewTabs: disp("viewTabs"),
      viewFrame: disp("viewFrame"),
      chips: document.querySelectorAll("#mChips .m-chip").length,
      dropHidden: getComputedStyle(document.getElementById("drop")).display === "none",
      scrollH: document.documentElement.scrollHeight,
      viewH: innerHeight,
      frameRect: rr("viewFrame"), stageRect: rr("viewStage"), canvasRect: rr("cvView"),
      chipsRect: rr("mobileParams"), barRect: rr("bottomBar"),
    };
  });
  console.log("mobile layout:", JSON.stringify(layout));
  if (layout.sidePanel !== "none") errors.push("sidebar should be hidden on mobile");
  if (layout.mobileParams !== "block") errors.push("mobile parameter bar missing");
  if (layout.viewTabs !== "flex") errors.push("mobile view tabs missing");
  if (layout.chips < 6) errors.push("mobile chips missing");
  if (!layout.dropHidden) errors.push("drop zone should be hidden after load on mobile");
  if (layout.scrollH !== layout.viewH) errors.push("mobile editor page should not scroll");
  if (layout.frameRect.bottom > layout.chipsRect.top + 1) errors.push("photo area overlaps bottom parameter bar");
  if (layout.canvasRect.h > layout.frameRect.h + 1 || layout.canvasRect.w > layout.frameRect.w + 1) errors.push("photo does not fit in frame");
  if (layout.stageRect.h < 100) errors.push("photo stage too small");
  if (layout.barRect.bottom !== layout.viewH) errors.push("bottom nav should be fixed at viewport bottom");
  await page.screenshot({ path: path.join(SHOTS, "ui_v17_mobile_edit.png") });

  // 顶部 SDR / HDR / 对比切换 + 对比分割线
  await page.click('#viewTabs button[data-view="split"]');
  await new Promise((r) => setTimeout(r, 400));
  const split = await page.evaluate(() => ({
    view: state.view,
    bar: document.getElementById("splitBar").style.left,
    tags: !document.getElementById("tagL").classList.contains("hidden") && !document.getElementById("tagR").classList.contains("hidden"),
    histHintHidden: getComputedStyle(document.querySelector(".press-hint")).display === "none",
    scrollH: document.documentElement.scrollHeight,
    viewH: innerHeight,
  }));
  console.log("mobile split:", JSON.stringify(split));
  if (split.view !== "split" || !split.tags) errors.push("mobile split view failed");
  if (split.scrollH !== split.viewH) errors.push("mobile split made page scroll");
  if (!split.histHintHidden) errors.push("press hint should be hidden in split mode");
  await page.screenshot({ path: path.join(SHOTS, "ui_v17_mobile_split.png") });
  await page.click('#viewTabs button[data-view="hdr"]');
  await new Promise((r) => setTimeout(r, 300));

  // 按住画面 → 显示 SDR，松开恢复
  await page.evaluate(() => {
    const el = document.getElementById("viewFrame");
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 100, clientY: 300 }));
  });
  await new Promise((r) => setTimeout(r, 350));
  const pressOn = await page.evaluate(() => !document.getElementById("cvPressSdr").classList.contains("hidden"));
  console.log("press shows SDR:", pressOn);
  if (!pressOn) errors.push("press-to-SDR overlay not shown");
  await page.screenshot({ path: path.join(SHOTS, "ui_v17_press_sdr.png") });
  await page.evaluate(() => document.getElementById("viewFrame").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" })));
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
  await page.screenshot({ path: path.join(SHOTS, "ui_v17_mobile_gainmap.png") });
  await page.evaluate(() => [...document.querySelectorAll("#mChips .m-chip")].find((b) => b.dataset.param === "gainmap").click());
  await new Promise((r) => setTimeout(r, 500));

  // 点“强度” chip → 展开滑块，调整后同步到桌面隐藏控件
  await page.evaluate(() => [...document.querySelectorAll("#mChips .m-chip")].find((b) => b.dataset.param === "strength").click());
  await new Promise((r) => setTimeout(r, 300));
  const sheet = await page.evaluate(() => {
    const rr = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
    return {
      visible: !document.getElementById("mSheet").classList.contains("hidden"),
      rows: document.querySelectorAll("#mSheet .m-row").length,
      value: document.querySelector("#mSheet input[type=range]").value,
      nan: document.getElementById("mSheet").innerText.indexOf("NaN") >= 0,
      scrollH: document.documentElement.scrollHeight,
      viewH: innerHeight,
      viewFrame: rr("viewFrame"), chipsTop: rr("mobileParams").top, barBottom: rr("bottomBar").bottom,
    };
  });
  console.log("strength sheet:", JSON.stringify(sheet));
  if (!sheet.visible || sheet.rows !== 1 || sheet.nan) errors.push("mobile sheet state wrong");
  if (sheet.scrollH !== sheet.viewH) errors.push("sheet should not make the page scroll");
  if (sheet.viewFrame.bottom > sheet.chipsTop + 1) errors.push("sheet should push photo area up, not overlap");
  if (sheet.barBottom !== sheet.viewH) errors.push("bottom nav moved after sheet opened");
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
  await page.screenshot({ path: path.join(SHOTS, "ui_v17_mobile_sheet.png") });

  // 高级参数面板
  await page.evaluate(() => [...document.querySelectorAll("#mChips .m-chip")].find((b) => b.dataset.param === "advanced").click());
  await new Promise((r) => setTimeout(r, 300));
  const advRows = await page.evaluate(() => document.querySelectorAll("#mSheet .m-row").length);
  console.log("advanced sheet rows:", advRows);
  if (advRows < 5) errors.push("advanced mobile sheet incomplete");
  await page.screenshot({ path: path.join(SHOTS, "ui_v17_mobile_advanced.png") });

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
  await page.screenshot({ path: path.join(SHOTS, "ui_v17_mobile_export.png") });

  console.log("js errors:", errors.length ? errors : "none");
  if (errors.length) process.exitCode = 1;
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
