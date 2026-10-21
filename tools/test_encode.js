#!/usr/bin/env node
/* Run the browser prototype headlessly and encode test inputs.
 *
 * Usage:
 *   node tools/test_encode.js '[{"input":"tests/input_photo.jpg","strength":50,"output":"tests/out_photo_50.jpg"}, ...]'
 */
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

(async () => {
  const cases = JSON.parse(process.argv[2] || "[]");
  if (!cases.length) throw new Error("no cases given");

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  page.on("console", (m) => console.log("[console]", m.type(), m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  const indexUrl = "file://" + path.resolve(__dirname, "..", "index.html");
  await page.goto(indexUrl, { waitUntil: "load" });
  await page.waitForFunction("window.__hdrApp && window.__hdrApp.version", { timeout: 20000 });

  for (const c of cases) {
    const inputPath = path.resolve(c.input);
    if (!fs.existsSync(inputPath)) { console.log(`SKIP missing ${inputPath}`); continue; }
    const b64 = fs.readFileSync(inputPath).toString("base64");
    const t0 = Date.now();
    const params = c.params || (c.strength != null || c.gainScale != null
      ? { strength: c.strength != null ? c.strength : 50, gainScale: c.gainScale || 1 }
      : null);
    const res = await page.evaluate(async (b64, params) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const r = await window.__hdrApp.encodeFromArrayBuffer(arr.buffer, params);
      let s = "";
      const CH = 0x8000;
      for (let i = 0; i < r.bytes.length; i += CH) {
        s += String.fromCharCode.apply(null, r.bytes.subarray(i, i + CH));
      }
      return { b64: btoa(s), gainScale: r.gainScale, meta: r.meta, params: r.params, len: r.bytes.length };
    }, b64, params);
    const outPath = path.resolve(c.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(res.b64, "base64"));
    console.log(`OK ${c.output} len=${res.len} gainScale=${res.gainScale} strength=${res.params ? res.params.strength : '?'} maxLogBoost=${res.meta.maxLogBoost} ${Date.now() - t0}ms`);
  }
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
