#!/usr/bin/env node
/* End-to-end UI test for v0.3: sliders, preview modes, assist toggle, advanced panel, export. */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, "tests");

(async () => {
  const input = process.argv[2] || "tests/input_color.jpg";
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
  await page.setViewport({ width: 1280, height: 1100, deviceScaleFactor: 1 });
  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });

  await page.goto("file://" + path.join(ROOT, "index.html"), { waitUntil: "load" });
  await page.waitForFunction("window.__hdrApp && window.__hdrApp.version");
  console.log("app version:", await page.evaluate(() => window.__hdrApp.version));

  const fi = await page.$("#file");
  await fi.uploadFile(path.join(ROOT, input));
  await page.waitForFunction('!document.getElementById("editor").classList.contains("hidden") && document.getElementById("cvSdr").width > 0', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 600));

  async function setSlider(id, value) {
    await page.evaluate((id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, id, value);
  }
  async function shot(name) {
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
    console.log("screenshot:", name);
  }

  await shot("ui_v4_default.png");
  console.log("meta:\n" + (await page.$eval("#meta", (el) => el.innerText)));
  console.log("hist caption:", await page.$eval("#histCaption", (el) => el.textContent));

  // 整体曝光（PS 拉曝光效果）
  await setSlider("exposureEv", 1.2);
  await new Promise((r) => setTimeout(r, 900));
  const expInfo = await page.evaluate(() => ({
    caption: document.getElementById("sdrCaption").textContent,
    meta: document.getElementById("meta").innerText,
  }));
  console.log("exposure caption:", expInfo.caption.slice(0, 26), "| meta has 整体曝光:", expInfo.meta.includes("整体曝光"));
  await shot("ui_v6_exposure.png");
  await setSlider("exposureEv", 0);
  await new Promise((r) => setTimeout(r, 500));

  // 调整参数：起点降低、细节/彩色拉高
  await setSlider("knee", 120);
  await setSlider("detail", 80);
  await setSlider("color", 100);
  await new Promise((r) => setTimeout(r, 700));
  console.log("after sliders:", await page.$eval("#meta", (el) => el.innerText));

  // 高级参数
  await page.evaluate(() => { document.getElementById("advanced").open = true; });
  await page.evaluate(() => { document.getElementById("detailRadius").value = "28"; document.getElementById("detailRadius").dispatchEvent(new Event("input", { bubbles: true })); });
  await page.evaluate(() => { document.getElementById("clarity").value = "60"; document.getElementById("clarity").dispatchEvent(new Event("input", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 700));
  await shot("ui_v4_advanced.png");

  // 热力图模式
  await page.select("#previewMode", "heatmap");
  await new Promise((r) => setTimeout(r, 600));
  await shot("ui_v4_heatmap.png");
  console.log("heatmap caption:", await page.$eval("#captionHdr", (el) => el.textContent));

  // 真 HDR 预览（原生渲染）
  await page.evaluate(() => console.log("hdr high:", matchMedia("(dynamic-range: high)").matches));
  await page.select("#previewMode", "truehdr");
  await page.waitForFunction('document.getElementById("hdrImg").src.indexOf("blob:") === 0 && document.getElementById("hdrImg").naturalWidth > 0', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  const hdrInfo = await page.evaluate(async () => {
    const img = document.getElementById("hdrImg");
    const res = await fetch(img.src);
    const buf = new Uint8Array(await res.arrayBuffer());
    let s = ""; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    return { b64: btoa(s), w: img.naturalWidth, h: img.naturalHeight };
  });
  fs.writeFileSync(path.join(SHOTS, "truehdr_preview.jpg"), Buffer.from(hdrInfo.b64, "base64"));
  console.log("true HDR preview: img", hdrInfo.w, "x", hdrInfo.h, "file", fs.statSync(path.join(SHOTS, "truehdr_preview.jpg")).size, "bytes");
  await shot("ui_v4_truehdr.png");
  const modeUi = await page.evaluate(() => ({
    cvHidden: document.getElementById("cvHdr").classList.contains("hidden"),
    imgShown: !document.getElementById("hdrImg").classList.contains("hidden"),
    caption: document.getElementById("captionHdr").textContent.slice(0, 40),
  }));
  console.log("true HDR mode UI:", modeUi);

  // 大图 HDR 调试视图
  await page.click("#bigViewBtn");
  await page.waitForFunction('document.getElementById("bigView") && !document.getElementById("bigView").classList.contains("hidden")', { timeout: 10000 });
  await page.waitForFunction('document.getElementById("bigStatus").textContent.indexOf("已生成") >= 0', { timeout: 120000 });
  const big1 = await page.evaluate(() => ({
    src: document.getElementById("bigImg").src,
    w: document.getElementById("bigImg").naturalWidth,
    h: document.getElementById("bigImg").naturalHeight,
    status: document.getElementById("bigStatus").textContent,
    dockHasControls: document.getElementById("bigDock").contains(document.querySelector(".controls")),
  }));
  console.log("big view:", JSON.stringify(big1));
  await new Promise((r) => setTimeout(r, 500));
  await shot("ui_v5_big.png");
  // 在大图里调参数，应自动重新按最终分辨率生成
  await page.evaluate(() => {
    const el = document.getElementById("detail");
    el.value = "80";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.waitForFunction((oldSrc) => document.getElementById("bigImg").src !== oldSrc, { timeout: 120000 }, big1.src);
  const big2 = await page.evaluate(() => ({ status: document.getElementById("bigStatus").textContent, detail: document.getElementById("detail").value }));
  console.log("big view after adjust:", JSON.stringify(big2));
  await shot("ui_v5_big_adjusted.png");
  await page.click("#bigActual");
  const actual = await page.evaluate(() => document.getElementById("bigStage").classList.contains("actual"));
  console.log("1:1 mode:", actual);
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 600));
  const closed = await page.evaluate(() => ({
    hidden: document.getElementById("bigView").classList.contains("hidden"),
    dockEmpty: document.getElementById("bigDock").children.length === 0,
    controlsBack: document.querySelector(".controls").parentElement.id !== "bigDock",
  }));
  console.log("big view closed:", JSON.stringify(closed));
  if (!closed.hidden || !closed.controlsBack) process.exitCode = 1;

  // 关闭辅助
  await page.evaluate(() => { const cb = document.getElementById("showAssist"); cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 300));
  const hidden = await page.evaluate(() => document.getElementById("histFig").classList.contains("hidden") && document.getElementById("previews").classList.contains("single"));
  console.log("assist off hides preview+hist:", hidden);
  await shot("ui_v4_assist_off.png");
  await page.evaluate(() => { const cb = document.getElementById("showAssist"); cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.select("#previewMode", "gain");
  await new Promise((r) => setTimeout(r, 500));

  // 导出
  await page.click("#exportBtn");
  await page.waitForFunction('!document.getElementById("result").classList.contains("hidden")', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 1200));
  const files = fs.readdirSync(downloadDir);
  console.log("downloads:", files, files.length ? fs.statSync(path.join(downloadDir, files[0])).size : 0);
  const dims = await page.evaluate(async (url) => await new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = rej; im.src = url;
  }), "file://" + path.join(downloadDir, files[0]));
  console.log("Chrome decoded export:", dims);
  // 回归：把刚导出的 HDR 图（已含增益图）再上传，应被检测并拒绝
  const exportedPath = path.join(downloadDir, files[0]);
  await (await page.$("#file")).uploadFile(exportedPath);
  await new Promise((r) => setTimeout(r, 1200));
  const rejectInfo = await page.evaluate(() => ({
    banner: !document.getElementById("loadError").classList.contains("hidden"),
    text: document.getElementById("loadError").textContent.replace(/\s+/g, " ").slice(0, 80),
  }));
  console.log("HDR re-upload rejected:", JSON.stringify(rejectInfo));
  if (!rejectInfo.banner) errors.push("already-HDR input was not rejected");
  await shot("ui_v9_reject.png");

  console.log("js errors:", errors.length ? errors : "none");
  if (errors.length || !hidden || !files.length) process.exitCode = 1;
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
