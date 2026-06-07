import path from 'node:path';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileBox } from 'file-box';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

function findChromeExecutable() {
  const configured = process.env.WECHATY_CHROME_EXECUTABLE_PATH
    || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured) return configured;

  const candidates = [
    path.join(
      os.homedir(),
      '.cache/puppeteer/chrome/mac_arm-133.0.6943.126/chrome-mac-arm64',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function installNavigationCompatibility(puppet, timeout = DEFAULT_NAVIGATION_TIMEOUT_MS) {
  const bridge = puppet.bridge;
  const originalInitBrowser = bridge.initBrowser.bind(bridge);

  bridge.prependListener('scan', (payload) => {
    if (payload?.code === 400 && payload.url) payload.code = 0;
  });

  bridge.initBrowser = async () => {
    const browser = await originalInitBrowser();
    const originalNewPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await originalNewPage(...args);
      const originalGoto = page.goto.bind(page);
      const originalReload = page.reload.bind(page);

      page.goto = (url, options = {}) => originalGoto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
        ...options,
      });
      page.reload = (options = {}) => originalReload({
        waitUntil: 'domcontentloaded',
        timeout,
        ...options,
      });
      return page;
    };
    return browser;
  };
}

export class WechatyBot {
  constructor(options = {}) {
    this.name = options.name || 'pdd-wechaty-bot';
    this.bot = null;
    this.status = 'disconnected';
    this.loggedInUser = null;
    this.qrData = null;
    this.lastError = null;
    this.scanCallbacks = new Set();
    this.loginCallbacks = new Set();
    this.logoutCallbacks = new Set();
  }

  onScan(callback) {
    this.scanCallbacks.add(callback);
    return () => this.scanCallbacks.delete(callback);
  }

  onLogin(callback) {
    this.loginCallbacks.add(callback);
    return () => this.loginCallbacks.delete(callback);
  }

  onLogout(callback) {
    this.logoutCallbacks.add(callback);
    return () => this.logoutCallbacks.delete(callback);
  }

  async start() {
    if (this.bot) return;

    const executablePath = findChromeExecutable();
    if (!executablePath) throw new Error('No compatible Chrome executable found for Wechaty');
    process.env.PUPPETEER_EXECUTABLE_PATH = executablePath;
    console.log(`[Wechaty] using Chrome at ${executablePath}`);

    const { WechatyBuilder } = await import('wechaty');
    const { PuppetWeChat } = await import('wechaty-puppet-wechat');
    const puppet = new PuppetWeChat({
      endpoint: executablePath,
      stealthless: true,
      uos: true,
      head: process.env.WECHATY_BROWSER_HEAD !== 'false',
    });
    installNavigationCompatibility(puppet);

    this.bot = WechatyBuilder.build({
      name: path.resolve(ROOT, `.cache/${this.name}`),
      puppet,
    });
    this.status = 'starting';
    this.lastError = null;

    this.bot.on('scan', (qrcode, status) => {
      this.status = 'scanning';
      this.qrData = qrcode;
      this.lastError = null;
      console.log(`[Wechaty] scan event, status=${status}`);
      for (const cb of this.scanCallbacks) {
        try { cb(qrcode, status); } catch (e) { console.error('[Wechaty] scan callback error:', e); }
      }
    });

    this.bot.on('login', (user) => {
      this.status = 'logged-in';
      this.loggedInUser = user.name();
      this.qrData = null;
      this.lastError = null;
      console.log(`[Wechaty] logged in as ${this.loggedInUser}`);
      for (const cb of this.loginCallbacks) {
        try { cb(user); } catch (e) { console.error('[Wechaty] login callback error:', e); }
      }
    });

    this.bot.on('logout', (user) => {
      this.status = 'disconnected';
      this.loggedInUser = null;
      console.log(`[Wechaty] logged out`);
      for (const cb of this.logoutCallbacks) {
        try { cb(user); } catch (e) { console.error('[Wechaty] logout callback error:', e); }
      }
    });

    this.bot.on('error', (error) => {
      this.status = 'error';
      this.qrData = null;
      this.lastError = error.message;
      console.error(`[Wechaty] error: ${error.message}`);
    });

    try {
      await this.bot.start();
      console.log('[Wechaty] bot starting...');
    } catch (error) {
      this.status = 'error';
      this.lastError = error.message;
      const failedBot = this.bot;
      this.bot = null;
      await failedBot.stop().catch(() => {});
      throw error;
    }
  }

  async stop() {
    if (!this.bot) return;
    try {
      await this.bot.stop();
    } catch (error) {
      console.error(`[Wechaty] stop error: ${error.message}`);
    }
    this.bot = null;
    this.status = 'disconnected';
    this.loggedInUser = null;
    this.qrData = null;
    this.lastError = null;
  }

  getStatus() {
    return {
      status: this.status,
      loggedInUser: this.loggedInUser || null,
      qrAvailable: this.status === 'scanning' && Boolean(this.qrData),
      error: this.lastError || null,
    };
  }

  async sendToRoom(roomName, text, imagePaths = [], mentionNames = []) {
    if (this.status !== 'logged-in') {
      throw new Error('Wechaty bot is not logged in');
    }

    const room = await this.bot.Room.find({ topic: roomName });
    if (!room) throw new Error(`WeChat room not found: ${roomName}`);

    let imageFiles = [];
    if (imagePaths.length > 0) {
      const missing = imagePaths.filter((imagePath) => !existsSync(imagePath));
      if (missing.length) throw new Error(`WeChat image file not found: ${missing.join(', ')}`);
      imageFiles = imagePaths.map((imagePath) => ({
        imagePath,
        fileBox: FileBox.fromFile(imagePath),
      }));
    }

    const contacts = [];
    for (const name of mentionNames) {
      const contact = await room.member(name);
      if (contact) contacts.push(contact);
      else console.warn(`[Wechaty] member not found in room ${roomName}: ${name}`);
    }

    if (imageFiles.length > 0) {
      for (let index = 0; index < imageFiles.length; index += 1) {
        const { imagePath, fileBox } = imageFiles[index];
        await room.say(fileBox);
        console.log(`[Wechaty] sent image to room ${roomName}: ${path.basename(imagePath)}`);
        if (index < imageFiles.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }

    if (text) {
      if (contacts.length > 0) {
        await room.say(text, ...contacts);
      } else {
        await room.say(text);
      }
      console.log(`[Wechaty] sent text to room ${roomName}`);
    }
  }
}
