import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FileBox } from 'file-box';
import puppeteer from 'puppeteer';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.MAO_WORKSPACE_PATH || APP_ROOT);
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const WECHAT_WEB_ENTRY_URL = 'https://wx.qq.com/?lang=zh_CN&target=t';

function wechatPageScore(page) {
  const url = page.url();
  try {
    const parsed = new URL(url);
    if (/^(wx\.qq\.com|web\.wechat\.com)$/.test(parsed.hostname)) {
      if (parsed.pathname === '/cgi-bin/mmwebwx-bin/webwxnewloginpage') return 0;
      if (parsed.pathname === '/') return 3;
      return 1;
    }
  } catch {}
  if (url === 'chrome://newtab/' || url === 'chrome://new-tab-page/' || url === 'about:blank') return 1;
  return 0;
}

function normalizeWechatNavigationUrl(url) {
  const text = String(url || '');
  return /^https:\/\/wx\.qq\.com\/?$/.test(text) ? WECHAT_WEB_ENTRY_URL : text;
}

function isWechatLoginCallbackUrl(url) {
  try {
    const parsed = new URL(url);
    return /^(wx\.qq\.com|web\.wechat\.com)$/.test(parsed.hostname)
      && parsed.pathname === '/cgi-bin/mmwebwx-bin/webwxnewloginpage';
  } catch {
    return false;
  }
}

function isDuplicateLoginError(error) {
  return /onLogin\(\) user had already logined/i.test(error?.message || '');
}

function errorText(error) {
  if (!error) return '';
  const parts = [
    error.message,
    error.details,
    error.stack,
    String(error),
  ].filter(Boolean);
  return parts.join('\n');
}

function compactErrorMessage(error) {
  const text = errorText(error).replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function isTransientPageDialogError(error) {
  const text = errorText(error);
  if (/No dialog is showing/i.test(text)) return true;
  if (/Bridge\.onDialog|PuppetWeChatBridge.*onDialog|page\.on\(dialog\)/s.test(text)
    && /return\s+this\._type|type\(\)\s*\{/s.test(text)) {
    return true;
  }
  return /type\(\)\s*\{[\s\S]*return\s+this\._type[\s\S]*\}\s*\(\)/.test(text);
}

let processWechatyErrorGuardsInstalled = false;

function installProcessWechatyErrorGuards() {
  if (processWechatyErrorGuardsInstalled) return;
  processWechatyErrorGuardsInstalled = true;

  process.on('unhandledRejection', (reason) => {
    if (isTransientPageDialogError(reason)) {
      console.warn(`[Wechaty] ignored process-level transient page dialog rejection: ${compactErrorMessage(reason)}`);
      return;
    }
    console.error('[Wechaty] unhandled rejection:', reason);
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  });

  process.on('uncaughtException', (error) => {
    if (isTransientPageDialogError(error)) {
      console.warn(`[Wechaty] ignored process-level transient page dialog exception: ${compactErrorMessage(error)}`);
      return;
    }
    console.error('[Wechaty] uncaught exception:', error);
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  });
}

function installNavigationCompatibility(puppet, {
  cdpUrl = '',
  timeout = DEFAULT_NAVIGATION_TIMEOUT_MS,
} = {}) {
  const bridge = puppet.bridge;
  bridge.prependListener('scan', (payload) => {
    if (payload?.code === 400 && payload.url) payload.code = 0;
  });

  bridge.initBrowser = async () => {
    const browser = await puppeteer.connect({ browserURL: cdpUrl });
    const originalNewPage = browser.newPage.bind(browser);
    let reusablePage = null;

    const pages = await browser.pages();
    reusablePage = pages
      .map((page) => ({ page, score: wechatPageScore(page) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)[0]?.page || null;
    const disconnect = browser.disconnect.bind(browser);
    browser.close = async () => disconnect();
    console.log(`[Wechaty] connected to Chrome at ${cdpUrl}${reusablePage ? `, reusing tab ${reusablePage.url()}` : ''}`);

    browser.newPage = async (...args) => {
      const page = reusablePage || await originalNewPage(...args);
      reusablePage = null;
      page.close = async () => {};
      const originalGoto = page.goto.bind(page);
      const originalReload = page.reload.bind(page);

      page.goto = (url, options = {}) => originalGoto(normalizeWechatNavigationUrl(url), {
        waitUntil: 'domcontentloaded',
        timeout,
        ...options,
      });
      page.reload = (options = {}) => {
        if (isWechatLoginCallbackUrl(page.url())) {
          return originalGoto(WECHAT_WEB_ENTRY_URL, {
            waitUntil: 'domcontentloaded',
            timeout,
            ...options,
          });
        }
        return originalReload({
          waitUntil: 'domcontentloaded',
          timeout,
          ...options,
        });
      };
      return page;
    };
    return browser;
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function textToWechatHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

async function sendTextWithRealMentions(bot, room, text, mentionNames) {
  const bridgePage = bot?.puppet?.bridge?.page;
  if (!bridgePage) {
    throw new Error('Wechaty browser bridge is not available for real @ mention sending.');
  }

  const result = await bridgePage.evaluate(async ({ roomId, textHtml, mentionNames: targetNames }) => {
    if (typeof angular === 'undefined') throw new Error('Angular is not available in WeChat page.');
    const injector = angular.element(document).injector();
    if (!injector) throw new Error('Angular injector is not available in WeChat page.');
    const chatFactory = injector.get('chatFactory');
    const contactFactory = injector.get('contactFactory');
    const confFactory = injector.get('confFactory');

    const decodeHtml = (value) => {
      const node = document.createElement('textarea');
      node.innerHTML = String(value || '');
      return node.value;
    };
    const normalizeName = (value) => decodeHtml(value)
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, '')
      .trim();
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const getRoomContact = async () => {
      let roomContact = contactFactory.getContact(roomId);
      if (roomContact?.MemberList?.length) return roomContact;

      try { contactFactory.addBatchgetChatroomContact(roomId); } catch {}
      try { contactFactory.addBatchgetChatroomMembersContact(roomId); } catch {}
      try {
        const batchResult = contactFactory.batchGetContact();
        if (batchResult && typeof batchResult.then === 'function') await batchResult;
      } catch {}

      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        roomContact = contactFactory.getContact(roomId);
        if (roomContact?.MemberList?.length) return roomContact;
        await wait(100);
      }
      return contactFactory.getContact(roomId);
    };
    const roomContact = await getRoomContact();
    if (!roomContact) throw new Error(`WeChat room not found in page cache: ${roomId}`);
    const members = roomContact.MemberList || [];
    const resolvedMentions = [];
    const missingNames = [];
    for (const name of targetNames) {
      const normalizedTarget = normalizeName(name);
      const member = members.find((candidate) => {
        const fullContact = contactFactory.getContact(candidate.UserName, roomId, true) || {};
        const aliases = [
          candidate.NickName,
          candidate.DisplayName,
          candidate.RemarkName,
          candidate.Alias,
          fullContact.NickName,
          fullContact.DisplayName,
          fullContact.RemarkName,
          fullContact.Alias,
        ].map(normalizeName).filter(Boolean);
        return aliases.includes(normalizedTarget);
      });
      if (!member?.UserName) {
        missingNames.push(name);
        continue;
      }
      resolvedMentions.push({
        id: member.UserName,
        label: name,
        nickName: decodeHtml(member.NickName || ''),
        displayName: decodeHtml(member.DisplayName || ''),
      });
    }
    if (missingNames.length) {
      throw new Error(`WeChat members not found in room ${decodeHtml(roomContact.NickName || roomId)}: ${missingNames.join(', ')}`);
    }

    const mentionInputs = resolvedMentions.map((mention) => (
      `<input type="button" class="emoji emoji_at" un="${mention.id}" value="@${mention.label}\u2005">`
    )).join('');
    const content = `${mentionInputs}${textHtml ? `<br>${textHtml}` : ''}`;
    const message = chatFactory.createMessage({
      ToUserName: roomId,
      Content: content,
      MsgType: confFactory.MSGTYPE_TEXT,
    });
    const actualMentionIds = String(message.MMAtContacts || '').split(',').filter(Boolean);
    const expectedMentionIds = resolvedMentions.map((mention) => mention.id);
    const missingMentionIds = expectedMentionIds.filter((id) => !actualMentionIds.includes(id));
    if (missingMentionIds.length) {
      throw new Error(`WeChat mention token creation failed: ${missingMentionIds.join(', ')}`);
    }
    const originalPostMessage = chatFactory._postMessage;
    let capturedMsgSource = '';
    chatFactory._postMessage = function(api, data, msg) {
      capturedMsgSource = data?.MsgSource || '';
      return originalPostMessage.apply(this, arguments);
    };
    try {
      chatFactory.appendMessage(message);
      chatFactory.sendMessage(message);
    } finally {
      chatFactory._postMessage = originalPostMessage;
    }
    if (!capturedMsgSource || !expectedMentionIds.every((id) => capturedMsgSource.includes(id))) {
      throw new Error('WeChat mention MsgSource was not sent with all expected @ members.');
    }
    return {
      mmAtContacts: message.MMAtContacts || '',
      mmSendContent: message.MMSendContent || '',
      msgSource: capturedMsgSource,
      resolvedMentions,
    };
  }, {
    roomId: room.id,
    textHtml: textToWechatHtml(text || ''),
    mentionNames,
  });

  return result;
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
    this.errorCallbacks = new Set();
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

  onError(callback) {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  notifyError(error) {
    for (const cb of this.errorCallbacks) {
      try { cb(error); } catch (e) { console.error('[Wechaty] error callback error:', e); }
    }
  }

  async start() {
    if (this.bot && ['logged-in', 'scanning', 'starting'].includes(this.effectiveStatus())) return;
    if (this.bot) await this.stop();

    const cdpUrl = process.env.WECHATY_CDP_URL || '';
    if (!cdpUrl) {
      throw new Error('WECHATY_CDP_URL is required. Start a dedicated Chrome debugging session for Wechaty.');
    }

    const { WechatyBuilder } = await import('wechaty');
    const { PuppetWeChat } = await import('wechaty-puppet-wechat');
    const puppet = new PuppetWeChat({
      stealthless: true,
      uos: true,
      head: process.env.WECHATY_BROWSER_HEAD !== 'false',
    });
    installProcessWechatyErrorGuards();
    installNavigationCompatibility(puppet, { cdpUrl });
    puppet.bridge.on('error', (error) => {
      if (isTransientPageDialogError(error)) {
        console.warn(`[Wechaty] ignored bridge transient page dialog error: ${compactErrorMessage(error)}`);
        return;
      }
      this.status = 'error';
      this.qrData = null;
      this.lastError = error?.message || String(error);
      console.error(`[Wechaty] bridge error: ${compactErrorMessage(error)}`);
      this.notifyError(error);
    });

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
      if (isDuplicateLoginError(error)) {
        if (this.loggedInUser) this.status = 'logged-in';
        this.qrData = null;
        this.lastError = null;
        console.warn(`[Wechaty] ignored duplicate login event: ${error.message}`);
        return;
      }
      if (isTransientPageDialogError(error)) {
        console.warn(`[Wechaty] ignored transient page dialog error: ${compactErrorMessage(error)}`);
        return;
      }
      this.status = 'error';
      this.qrData = null;
      this.lastError = error.message;
      console.error(`[Wechaty] error: ${error.message}`);
      this.notifyError(error);
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

  async reload() {
    const bridge = this.bot?.puppet?.bridge;
    if (!bridge || typeof bridge.reload !== 'function') {
      throw new Error('Wechaty browser bridge reload is not available.');
    }
    await bridge.reload();
  }

  effectiveStatus() {
    if (this.status === 'error' && this.loggedInUser && isDuplicateLoginError({ message: this.lastError })) {
      return 'logged-in';
    }
    return this.status;
  }

  getStatus() {
    const status = this.effectiveStatus();
    return {
      status,
      loggedInUser: this.loggedInUser || null,
      qrAvailable: status === 'scanning' && Boolean(this.qrData),
      error: status === 'error' ? (this.lastError || null) : null,
    };
  }

  async sendToRoom(roomName, text, imagePaths = [], mentionNames = []) {
    const status = this.effectiveStatus();
    if (status !== 'logged-in') {
      throw new Error(`Wechaty bot is not logged in (current status: ${status})`);
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

    const normalizedMentionNames = mentionNames.map((name) => String(name).trim()).filter(Boolean);

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
      if (normalizedMentionNames.length > 0) {
        const result = await sendTextWithRealMentions(this.bot, room, text, normalizedMentionNames);
        const mentionSummary = result.resolvedMentions
          .map((mention) => `${mention.label}=>${mention.id}`)
          .join(', ');
        console.log(`[Wechaty] sent text with real mentions to room ${roomName}: ${mentionSummary}`);
      } else {
        await room.say(text);
        console.log(`[Wechaty] sent text to room ${roomName}`);
      }
    }

    return {
      roomName,
      imageCount: imageFiles.length,
      textSent: Boolean(text),
      mentionNames: normalizedMentionNames,
    };
  }
}
