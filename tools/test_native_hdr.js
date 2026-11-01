#!/usr/bin/env node
/* Native HDR preview regression (headless Chrome reports SDR, so we force
 * state.hdrHigh=true to exercise the Ultra HDR preview path). Verifies:
 * - HDR view uses native HDR <img> when available
 * - side-by-side right pane uses native HDR
 * - split compare overlays native HDR on the right half and the clip follows the handle
 * - slider changes regenerate the native HDR preview
 * - diagnostic modes override native rendering with a labelled diagnostic view
 *
 * Usage: node tools/test_native_hdr.js [image.jpg]
 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(__dirname, "..");
const input = process.argv[2] || path.join(ROOT, "tests/input_synthetic_12mp.jpg");

(async () => {
  if (!fs.existsSync(input)) throw new Error("missing test image: " + input);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new", protocolTimeout: 180000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto("file://" + path.join(ROOT, "index.html"), { waitUntil: "load" });
  await page.waitForFunction("window.__hdrApp");
  await (await page.$("#file")).uploadFile(input);
  await page.waitForFunction('!document.getElementById("editor").classList.contains("hidden") && state.bitmap', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));

  // headless 环境通常没有 HDR，强制打开原生 HDR 路径
  await page.evaluate(() => { state.hdrHigh = true; setPreviewModeUi(); scheduleNativeHdrPreview(0); });
  await page.waitForFunction('state.hdrPreviewUrl && document.getElementById("hdrImg").src.indexOf("blob:") === 0 && document.getElementById("hdrImg").naturalWidth > 0', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 800));

  const side = await page.evaluate(() => ({
    view: state.view,
    sideVisible: !document.getElementById("sideView").classList.contains("hidden"),
    sideImgVisible: !document.getElementById("sideHdrImg").classList.contains("hidden"),
    sideCanvasHidden: document.getElementById("cvSideHdr").classList.contains("hidden"),
    caption: document.getElementById("sideHdrCaption").textContent,
    sideSrc: document.getElementById("sideHdrImg").src.slice(0, 5),
    splitSrc: document.getElementById("splitHdrImg").src.slice(0, 5),
  }));
  console.log("native side:", JSON.stringify(side));
  if (side.view !== "side" || !side.sideVisible || !side.sideImgVisible || !side.sideCanvasHidden) errors.push("side-by-side right pane should use native HDR");
  if (!side.caption.includes("原生 HDR")) errors.push("side caption should say native HDR");
  if (side.sideSrc !== "blob:" || side.splitSrc !== "blob:") errors.push("native HDR image URLs missing");

  await page.click('#viewTabs button[data-view="hdr"]');
  await new Promise((r) => setTimeout(r, 500));
  const hdr = await page.evaluate(() => ({
    view: state.view,
    imgVisible: !document.getElementById("hdrImg").classList.contains("hidden"),
    canvasHidden: document.getElementById("cvView").classList.contains("hidden"),
    hint: document.getElementById("viewHint").textContent.slice(0, 50),
  }));
  console.log("native HDR view:", JSON.stringify(hdr));
  if (!hdr.imgVisible || !hdr.canvasHidden) errors.push("HDR view should use native HDR image");
  if (!hdr.hint.includes("原生 HDR")) errors.push("HDR hint should mention native HDR");

  await page.click('#viewTabs button[data-view="split"]');
  await new Promise((r) => setTimeout(r, 500));
  const split0 = await page.evaluate(() => ({
    wrapVisible: !document.getElementById("splitHdrWrap").classList.contains("hidden"),
    width: document.getElementById("splitHdrWrap").style.width,
  }));
  console.log("native split:", JSON.stringify(split0));
  if (!split0.wrapVisible || split0.width !== "50%") errors.push("native split layer missing at 50%");

  // 拖动分割线：原生 HDR 右半容器宽度应跟着变
  const box = await (await page.$("#viewFrame")).boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.76, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 400));
  const splitDrag = await page.evaluate(() => ({
    split: +state.split.toFixed(3),
    width: document.getElementById("splitHdrWrap").style.width,
  }));
  console.log("native split drag:", JSON.stringify(splitDrag));
  if (splitDrag.split < 0.7 || splitDrag.width !== "24%") errors.push("native split clip did not follow handle");

  // 参数变化 → 原生 HDR 预览重新生成
  const oldUrl = await page.evaluate(() => state.hdrPreviewUrl);
  await page.evaluate(() => {
    const el = document.getElementById("strength");
    el.value = "82";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const regenStart = Date.now();
  await page.waitForFunction((old) => state.hdrPreviewUrl && state.hdrPreviewUrl !== old, { timeout: 120000 }, oldUrl);
  const regenMs = Date.now() - regenStart;
  console.log("native regen ms:", regenMs);
  await new Promise((r) => setTimeout(r, 600));
  const realtime = await page.evaluate((old) => ({
    changed: state.hdrPreviewUrl !== old,
    pending: state.hdrPreviewPending,
    img: document.getElementById("splitHdrImg").src.slice(0, 5),
  }), oldUrl);
  console.log("native realtime:", JSON.stringify(realtime));
  if (!realtime.changed) errors.push("slider change did not regenerate native HDR");

  // 诊断模式应覆盖原生渲染并标注
  await page.select("#previewMode", "gainmap");
  await new Promise((r) => setTimeout(r, 600));
  const diag = await page.evaluate(() => ({
    wrapHidden: document.getElementById("splitHdrWrap").classList.contains("hidden"),
    hint: document.getElementById("viewHint").textContent,
  }));
  console.log("diagnostic:", JSON.stringify({ wrapHidden: diag.wrapHidden, hint: diag.hint.slice(0, 60) }));
  if (!diag.wrapHidden || !diag.hint.includes("诊断")) errors.push("diagnostic mode should replace native render");
  await page.screenshot({ path: path.join(ROOT, "tests/v21_native_diag.png") });

  console.log("js errors:", errors.length ? errors : "none");
  if (errors.length) process.exitCode = 1;
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
