#!/usr/bin/env node
/* End-to-end UI test for v0.10: bottom navigation, preview screen, export screen, watermark, quality. */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, "tests");

(async () => {
  const input = process.argv[2] || "tests/input_synthetic_12mp.jpg";
  const downloadDir = path.join(ROOT, "tests", "downloads");
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });

  await page.goto("file://" + path.join(ROOT, "index.html"), { waitUntil: "load" });
  await page.waitForFunction("window.__hdrApp && window.__hdrApp.version");
  console.log("app version:", await page.evaluate(() => window.__hdrApp.version));

  const fi = await page.$("#file");
  await fi.uploadFile(path.join(ROOT, input));
  await page.waitForFunction('!document.getElementById("editor").classList.contains("hidden") && document.getElementById("cvSdr").width > 0', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 700));

  async function setSlider(id, value) {
    await page.evaluate((id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, id, value);
  }
  async function shot(name) {
    await page.screenshot({ path: path.join(SHOTS, name) });
    console.log("screenshot:", name);
  }

  // ---- 基础状态 + 底部导航 ----
  const nav = await page.evaluate(() => ({
    bottomVisible: !document.getElementById("bottomBar").classList.contains("hidden"),
    exportEnabled: !document.getElementById("exportBtn").disabled,
    previewEnabled: !document.getElementById("previewBtn").disabled,
  }));
  console.log("bottom nav:", JSON.stringify(nav));
  if (!nav.bottomVisible || !nav.exportEnabled || !nav.previewEnabled) errors.push("bottom navigation not enabled");
  await shot("ui_v11_edit.png");
  console.log("meta:\n" + (await page.$eval("#meta", (el) => el.innerText)));

  // ---- 直方图尺寸 + 悬停提示 ----
  const histBox = await page.$eval("#hist", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log("histogram size:", histBox.w + "x" + histBox.h);
  if (histBox.h < 180 || histBox.w < 300) errors.push("histogram too small");
  await page.mouse.move(histBox.x + histBox.w * 0.4, histBox.y + histBox.h * 0.5);
  await new Promise((r) => setTimeout(r, 250));
  const histTip = await page.evaluate(() => {
    const t = document.getElementById("tip");
    return { visible: !t.classList.contains("hidden"), text: t.innerText.replace(/\s+/g, " ").slice(0, 60) };
  });
  console.log("histogram tooltip:", JSON.stringify(histTip));
  if (!histTip.visible) errors.push("histogram hover tooltip missing");
  await shot("ui_v11_hist_tooltip.png");

  // ---- 参数悬停说明 ----
  const sBox = await page.$eval("#strength", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(sBox.x + sBox.w * 0.5, sBox.y + sBox.h * 0.5);
  await new Promise((r) => setTimeout(r, 250));
  const paramTip = await page.evaluate(() => {
    const t = document.getElementById("tip");
    return { visible: !t.classList.contains("hidden"), text: t.innerText.replace(/\s+/g, " ").slice(0, 60) };
  });
  console.log("parameter tooltip:", JSON.stringify(paramTip));
  if (!paramTip.visible) errors.push("parameter hover tooltip missing");
  await page.mouse.move(10, 10);
  await new Promise((r) => setTimeout(r, 200));

  // ---- 参数 / 曝光 / 高级 / 热力图 / 真 HDR 回归 ----
  await setSlider("exposureEv", 1.2);
  await new Promise((r) => setTimeout(r, 900));
  const expInfo = await page.evaluate(() => ({
    sdr: document.getElementById("sdrCaption").textContent,
    meta: document.getElementById("meta").innerText,
  }));
  console.log("exposure UI (HDR-only):", JSON.stringify({
    sdrKept: expInfo.sdr.includes("保持不变"),
    metaHdrOnly: expInfo.meta.includes("仅作用于 HDR"),
  }));
  if (!expInfo.sdr.includes("保持不变") || !expInfo.meta.includes("仅作用于 HDR")) errors.push("exposure should not modify SDR base");
  await shot("ui_v14_exposure.png");

  // 仅整体曝光：其他参数应被忽略（禁用）
  await page.evaluate(() => {
    const cb = document.getElementById("exposureOnly");
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 700));
  const only = await page.evaluate(() => ({
    strengthDisabled: document.getElementById("strength").disabled,
    meta: document.getElementById("meta").innerText,
  }));
  console.log("exposure-only UI:", JSON.stringify({ strengthDisabled: only.strengthDisabled, metaIgnored: only.meta.includes("仅整体曝光") }));
  if (!only.strengthDisabled || !only.meta.includes("仅整体曝光")) errors.push("exposure-only toggle should disable other params");
  await shot("ui_v14_exposure_only.png");
  await page.evaluate(() => {
    const cb = document.getElementById("exposureOnly");
    cb.checked = false;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await setSlider("exposureEv", 0);
  await new Promise((r) => setTimeout(r, 400));

  await setSlider("knee", 120);
  await setSlider("detail", 80);
  await setSlider("color", 100);
  await new Promise((r) => setTimeout(r, 700));
  await page.evaluate(() => { document.getElementById("advanced").open = true; });
  await page.evaluate(() => {
    document.getElementById("detailRadius").value = "28";
    document.getElementById("detailRadius").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.select("#previewMode", "heatmap");
  await new Promise((r) => setTimeout(r, 500));
  await shot("ui_v10_heatmap.png");
  await page.select("#previewMode", "truehdr");
  await page.waitForFunction('document.getElementById("hdrImg").src.indexOf("blob:") === 0 && document.getElementById("hdrImg").naturalWidth > 0', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 500));
  await shot("ui_v10_truehdr.png");
  // 增益图灰度预览
  await page.select("#previewMode", "gainmap");
  await new Promise((r) => setTimeout(r, 700));
  const gmCheck = await page.evaluate(() => {
    const c = document.getElementById("cvHdr");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let gray = true;
    for (let i = 0; i < d.length; i += 4 * 991) {
      if (Math.max(Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 1] - d[i + 2]), Math.abs(d[i] - d[i + 2])) > 2) { gray = false; break; }
    }
    return { gray, caption: document.getElementById("captionHdr").textContent.slice(0, 30) };
  });
  console.log("gainmap preview:", JSON.stringify(gmCheck));
  if (!gmCheck.gray) errors.push("gain map preview is not grayscale");
  await shot("ui_v13_gainmap_preview.png");
  await page.select("#previewMode", "gain");
  await new Promise((r) => setTimeout(r, 500));

  // ---- 成品预览（全屏，无参数面板） ----
  await page.click("#previewBtn");
  await page.waitForFunction('!document.getElementById("bigView").classList.contains("hidden")', { timeout: 10000 });
  await page.waitForFunction('document.getElementById("bigStatus").textContent.indexOf("已生成") >= 0', { timeout: 120000 });
  const preview = await page.evaluate(() => ({
    w: document.getElementById("bigImg").naturalWidth,
    h: document.getElementById("bigImg").naturalHeight,
    status: document.getElementById("bigStatus").textContent.slice(0, 60),
    dockExists: !!document.getElementById("bigDock"),
  }));
  console.log("preview:", JSON.stringify(preview));
  await shot("ui_v10_preview.png");
  const firstSrc = await page.evaluate(() => document.getElementById("bigImg").src);
  await setSlider("detail", 65);
  await page.waitForFunction((oldSrc) => document.getElementById("bigImg").src !== oldSrc, { timeout: 120000 }, firstSrc);
  console.log("preview regenerated after param change");
  await page.click("#bigActual");
  console.log("1:1 mode:", await page.evaluate(() => document.getElementById("bigStage").classList.contains("actual")));
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 600));
  const previewClosed = await page.evaluate(() => document.getElementById("bigView").classList.contains("hidden"));
  console.log("preview closed:", previewClosed);
  if (!previewClosed) errors.push("preview did not close");

  // ---- 关闭辅助回归 ----
  await page.evaluate(() => { const cb = document.getElementById("showAssist"); cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 300));
  const assistHidden = await page.evaluate(() => document.getElementById("histFig").classList.contains("hidden") && document.getElementById("previews").classList.contains("single"));
  console.log("assist off hides preview+hist:", assistHidden);
  await page.evaluate(() => { const cb = document.getElementById("showAssist"); cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 400));

  // ---- 独立导出界面 ----
  await page.click("#exportBtn");
  await page.waitForFunction('!document.getElementById("exportScreen").classList.contains("hidden")', { timeout: 10000 });
  const exp0 = await page.evaluate(() => ({
    bottomHidden: document.getElementById("bottomBar").classList.contains("hidden"),
    dropHidden: document.getElementById("drop").classList.contains("hidden"),
    qualityDisabled: document.getElementById("exportQuality").disabled,
    info: document.getElementById("exportInfo").innerText.replace(/\s+/g, " ").slice(0, 80),
    prefix: document.getElementById("filenamePrefix").value,
  }));
  console.log("export screen (pass-through):", JSON.stringify(exp0));
  if (!exp0.bottomHidden || !exp0.dropHidden || !exp0.qualityDisabled) errors.push("export screen initial state wrong");
  await shot("ui_v10_export.png");

  // 水印：文字 -> 触发重编码、质量滑块生效
  await page.select("#wmType", "text");
  await page.evaluate(() => {
    const el = document.getElementById("wmText");
    el.value = "TEST WM";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400));
  const exp1 = await page.evaluate(() => ({
    qualityDisabled: document.getElementById("exportQuality").disabled,
    wmVisible: !document.getElementById("wmTextFields").classList.contains("hidden"),
    info: document.getElementById("exportInfo").innerText.replace(/\s+/g, " ").slice(0, 120),
    startDisabled: document.getElementById("exportStart").disabled,
  }));
  console.log("export screen (watermark):", JSON.stringify(exp1));
  if (exp1.qualityDisabled || !exp1.wmVisible || exp1.startDisabled) errors.push("watermark state wrong");
  await shot("ui_v10_export_watermark.png");

  // 成品预览应包含水印（在导出界面也能进入）
  await page.click("#previewFromExport");
  await page.waitForFunction('document.getElementById("bigStatus").textContent.indexOf("已生成") >= 0', { timeout: 120000 });
  console.log("preview from export:", await page.evaluate(() => document.getElementById("bigStatus").textContent.slice(0, 80)));
  await shot("ui_v10_preview_watermark.png");
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 500));

  // 导出
  await page.click("#exportStart");
  await page.waitForFunction('document.getElementById("exportStatus").textContent.indexOf("完成") >= 0', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 1200));
  const files = fs.readdirSync(downloadDir);
  console.log("downloads:", files, files.length ? fs.statSync(path.join(downloadDir, files[0])).size : 0);
  const dims = await page.evaluate(async (url) => await new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = rej; im.src = url;
  }), "file://" + path.join(downloadDir, files[0]));
  console.log("Chrome decoded export:", dims);
  console.log("export status:", await page.evaluate(() => document.getElementById("exportStatus").textContent));
  await shot("ui_v10_export_done.png");

  // 返回编辑
  await page.click("#exportBack");
  await new Promise((r) => setTimeout(r, 500));
  const backEdit = await page.evaluate(() => ({
    editor: !document.getElementById("editor").classList.contains("hidden"),
    exportScreen: document.getElementById("exportScreen").classList.contains("hidden"),
    drop: !document.getElementById("drop").classList.contains("hidden"),
  }));
  console.log("back to edit:", JSON.stringify(backEdit));
  if (!backEdit.editor || !backEdit.exportScreen || !backEdit.drop) errors.push("back to edit failed");

  // 回归：把刚导出的 HDR 图（已含增益图 + 水印）再上传，应被检测并拒绝
  const exportedPath = path.join(downloadDir, files[0]);
  await (await page.$("#file")).uploadFile(exportedPath);
  await new Promise((r) => setTimeout(r, 1200));
  const rejectInfo = await page.evaluate(() => ({
    banner: !document.getElementById("loadError").classList.contains("hidden"),
    text: document.getElementById("loadError").textContent.replace(/\s+/g, " ").slice(0, 70),
  }));
  console.log("HDR re-upload rejected:", JSON.stringify(rejectInfo));
  if (!rejectInfo.banner) errors.push("already-HDR input was not rejected");
  await shot("ui_v10_reject.png");

  // ---- SDR/HDR 对比拼图导出 ----
  await page.click("#exportBtn");
  await page.waitForFunction('!document.getElementById("exportScreen").classList.contains("hidden")', { timeout: 10000 });
  await page.select("#outputMode", "compare");
  await new Promise((r) => setTimeout(r, 400));
  const cmpUi = await page.evaluate(() => ({
    fields: !document.getElementById("compareFields").classList.contains("hidden"),
    info: document.getElementById("exportInfo").innerText.replace(/\s+/g, " ").slice(0, 140),
    qualityDisabled: document.getElementById("exportQuality").disabled,
    name: document.getElementById("exportHeadInfo").textContent,
  }));
  console.log("compare UI:", JSON.stringify(cmpUi));
  if (!cmpUi.fields || cmpUi.qualityDisabled || !cmpUi.name.includes("SDR-HDR")) errors.push("compare UI wrong");
  await shot("ui_v13_export_compare.png");
  await page.click("#exportStart");
  await page.waitForFunction('document.getElementById("exportStatus").textContent.indexOf("完成") >= 0', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 1500));
  const files2 = fs.readdirSync(downloadDir);
  console.log("downloads after compare:", files2);
  const cmpFile = files2.find((f) => f.includes("SDR-HDR")) || files2[files2.length - 1];
  const cmpDims = await page.evaluate(async (url) => await new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = rej; im.src = url;
  }), "file://" + path.join(downloadDir, cmpFile));
  console.log("compare decoded dims:", cmpFile, cmpDims);
  if (!(cmpDims[1] > 3000 && cmpDims[0] > 1000)) errors.push("compare image dims wrong");
  await shot("ui_v13_compare_done.png");

  // 对比图同样含增益图，重新上传应被拒绝
  await (await page.$("#file")).uploadFile(path.join(downloadDir, cmpFile));
  await new Promise((r) => setTimeout(r, 1000));
  const cmpReject = await page.evaluate(() => !document.getElementById("loadError").classList.contains("hidden"));
  console.log("compare re-upload rejected:", cmpReject);
  if (!cmpReject) errors.push("compare image not rejected");

  console.log("js errors:", errors.length ? errors : "none");
  if (errors.length || !files.length) process.exitCode = 1;
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
