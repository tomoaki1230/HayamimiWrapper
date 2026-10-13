'use strict';

/**
 * アプリアイコン（build/icon.png, 512x512）を src/renderer/icon.svg から生成する開発用スクリプト。
 * 実行: npm run icon（VSCode 内などでは env -u ELECTRON_RUN_AS_NODE npm run icon）
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const svgPath = path.join(__dirname, '..', 'src', 'renderer', 'icon.svg');
const svg = fs.readFileSync(svgPath, 'utf8');
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="512" height="512" style="display:block"></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, img.resize({ width: 512, height: 512 }).toPNG());
  fs.copyFileSync(svgPath, path.join(__dirname, '..', 'build', 'icon.svg'));
  console.log(`生成しました: ${out}`);
  app.quit();
});
