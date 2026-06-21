import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

function parseArgs(argv) {
  const options = {
    checkPermission: false,
    keyboardEnterTest: false,
    keyboardTest: false,
    openRetryTest: false,
    pressReturnOnly: false,
    prompt: false,
    mentionNames: [],
    imagePaths: [],
    roomName: '',
    selectMethod: 'click-first',
    send: false,
    text: '',
  };

  for (const arg of argv) {
    if (arg === '--send') {
      options.send = true;
    } else if (arg === '--no-send' || arg === '--dry-run') {
      options.send = false;
    } else if (arg === '--check-permission') {
      options.checkPermission = true;
    } else if (arg === '--prompt') {
      options.prompt = true;
    } else if (arg === '--keyboard-test') {
      options.keyboardTest = true;
    } else if (arg === '--keyboard-enter-test') {
      options.keyboardEnterTest = true;
    } else if (arg === '--open-retry-test') {
      options.openRetryTest = true;
    } else if (arg === '--press-return-only') {
      options.pressReturnOnly = true;
    } else if (arg.startsWith('--room=')) {
      options.roomName = arg.slice('--room='.length).trim();
    } else if (arg.startsWith('--mention=')) {
      options.mentionNames.push(arg.slice('--mention='.length).trim());
    } else if (arg.startsWith('--mentions=')) {
      options.mentionNames.push(
        ...arg.slice('--mentions='.length).split(/[,，]/).map((name) => name.trim()).filter(Boolean),
      );
    } else if (arg.startsWith('--text=')) {
      options.text = arg.slice('--text='.length);
    } else if (arg.startsWith('--image=')) {
      options.imagePaths.push(arg.slice('--image='.length).trim());
    } else if (arg.startsWith('--images=')) {
      options.imagePaths.push(
        ...arg.slice('--images='.length).split(/\n/).map((item) => item.trim()).filter(Boolean),
      );
    } else if (arg.startsWith('--select-method=')) {
      options.selectMethod = arg.slice('--select-method='.length);
    }
  }

  options.mentionNames = options.mentionNames.filter(Boolean);
  options.imagePaths = options.imagePaths.filter(Boolean);
  if (!options.roomName && !options.checkPermission && !options.keyboardTest && !options.keyboardEnterTest && !options.pressReturnOnly) {
    throw new Error('Missing --room=微信群名');
  }
  if (options.openRetryTest && !options.roomName) throw new Error('Missing --room=微信群名 for --open-retry-test');
  if (!options.text) options.text = `桌面微信自动化@测试 ${new Date().toLocaleString('zh-CN', { hour12: false })}，请忽略`;
  if (!['click-first', 'enter', 'none'].includes(options.selectMethod)) {
    throw new Error('--select-method must be one of: click-first, enter, none');
  }
  return options;
}

function run(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function appRootDir() {
  if (process.env.MAO_APP_ROOT) return process.env.MAO_APP_ROOT;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function nativeHelperPath() {
  const executable = process.platform === 'win32' ? 'mao-wechat-automation.ps1' : 'mao-wechat-automation';
  return path.join(appRootDir(), 'bin', executable);
}

async function runNativeHelper(options) {
  const helperPath = nativeHelperPath();
  if (!fs.existsSync(helperPath)) {
    throw new Error(`桌面微信自动化 helper 不存在：${helperPath}。请重新打包或运行 pnpm desktop:prepare。`);
  }
  const args = [];
  if (options.checkPermission) args.push('--check-permission');
  if (options.prompt) args.push('--prompt');
  if (options.keyboardTest) args.push('--keyboard-test');
  if (options.keyboardEnterTest) args.push('--keyboard-enter-test');
  if (options.openRetryTest) args.push('--open-retry-test');
  if (options.pressReturnOnly) args.push('--press-return-only');
  if (options.roomName) args.push(`--room=${options.roomName}`);
  args.push(
    `--mentions=${options.mentionNames.join(',')}`,
    `--text=${options.text}`,
    options.send ? '--send' : '--dry-run',
    `--select-method=${options.selectMethod}`,
  );
  for (const imagePath of options.imagePaths) args.push(`--image=${imagePath}`);
  if (process.platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath, ...args]);
  }
  return run(helperPath, args);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error(`Desktop WeChat automation is not implemented for ${process.platform} yet.`);
  }
  const { stdout, stderr } = await runNativeHelper(options);
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
