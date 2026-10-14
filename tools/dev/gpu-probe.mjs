import puppeteer from 'puppeteer-core';
const headless = process.argv[2] === 'headful' ? false : 'new';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless,
  args: ['--enable-unsafe-webgpu','--disable-gpu-vsync','--disable-frame-rate-limit','--no-first-run','--use-angle=metal'] });
const page = await browser.newPage();
await page.goto('http://localhost:5173/?bench');
await new Promise(r => setTimeout(r, 15000));
const s = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  return { gpu: !!navigator.gpu, adapter: a ? a.info?.description || a.info?.architecture || 'yes' : null, loading: document.getElementById('loading-text')?.textContent, frame: window.app?.engine?.frame, logs: window.agent?.logs?.(0)?.slice(-5) };
});
console.log(JSON.stringify(s, null, 2));
await browser.close();
