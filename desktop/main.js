'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, protocol, net, session, globalShortcut, desktopCapturer, dialog, shell,
} = require('electron');

// A interface é servida de dentro do app por app://ui, que o Chromium trata como origem segura
// (necessário para o microfone). O servidor só entra na sinalização, em /ws.
const PUBLIC_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'public')
  : path.join(__dirname, '..', 'public');
const MUTE_SHORTCUT = 'CommandOrControl+Shift+M';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// A UI só carrega código do próprio app; a rede é só o servidor da sala (fetch e WebSocket) e as
// fontes do Google.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' https: http: wss: ws:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

let win = null;

function registerUiProtocol() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return new Response('Proibido', { status: 403 });
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      return new Response(res.body, { status: res.status, headers });
    });
  });
}

function isUiOrigin(url) {
  // Em esquemas próprios URL.origin é "null", então compara protocolo e host.
  try {
    const u = new URL(url);
    return u.protocol === 'app:' && u.host === 'ui';
  } catch {
    return false;
  }
}

function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(isUiOrigin(details.requestingUrl) && ['media', 'display-capture'].includes(permission));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => isUiOrigin(origin) && permission === 'media');

  // Compartilhar tela: com mais de um monitor, pergunta qual.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (sources.length === 0) return callback({});
      let chosen = sources[0];
      if (sources.length > 1) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'question',
          message: 'Qual tela compartilhar?',
          buttons: [...sources.map((s) => s.name), 'Cancelar'],
          cancelId: sources.length,
        });
        if (response === sources.length) return callback({});
        chosen = sources[response];
      }
      callback({ video: chosen });
    } catch {
      callback({});
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    icon: path.join(PUBLIC_DIR, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // não suspender o áudio com a janela minimizada
    },
  });
  win.loadURL('app://ui/');

  // Links externos abrem no navegador, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isUiOrigin(url)) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    registerUiProtocol();
    setupPermissions();
    createWindow();
    // Silenciar/ativar o microfone com a janela em segundo plano.
    const ok = globalShortcut.register(MUTE_SHORTCUT, () => {
      if (win) win.webContents.send('toggle-mute');
    });
    if (!ok) console.warn(`Atalho ${MUTE_SHORTCUT} indisponível (em uso ou bloqueado pelo sistema).`);
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
