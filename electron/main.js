const { app, BrowserWindow, ipcMain, shell, dialog, session, protocol, nativeImage } = require('electron');

// Убирает флаг AutomationControlled из Chromium/Blink — без этого Cloudflare Turnstile
// видит браузер как бота даже при всех JS-патчах. Должно быть до app.whenReady().
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'AutomationControlled');

const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const zlib = require('zlib');

/** Рекурсивный размер директории в байтах (синхронно). */
function getDirectorySizeSync(dirPath) {
  let total = 0;
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return stat.size;
    const entries = fs.readdirSync(dirPath);
    for (const name of entries) {
      const full = path.join(dirPath, name);
      try {
        const s = fs.statSync(full);
        total += s.isDirectory() ? getDirectorySizeSync(full) : s.size;
      } catch (_) {}
    }
  } catch (_) {}
  return total;
}

/** Свободное и общее место на диске для пути (байты). */
function getDiskSpaceForPath(dirPath) {
  const resolved = path.resolve(dirPath || app.getPath('userData'));
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      const drive = path.parse(resolved).root.replace(/\\$/, '') || 'C:';
      const out = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace,Size`, { encoding: 'utf8', windowsHide: true });
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length >= 2) {
        const nums = lines[1].trim().split(/\s+/).map(Number).filter(n => !Number.isNaN(n));
        if (nums.length >= 2) return { free: nums[0], total: nums[1] };
      }
    } else {
      const out = execSync(`df -k "${resolved}"`, { encoding: 'utf8' });
      const lines = out.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        const totalK = parseInt(parts[1], 10);
        const usedK = parseInt(parts[2], 10);
        const availK = parseInt(parts[3], 10);
        if (!Number.isNaN(totalK) && !Number.isNaN(availK)) {
          return { free: availK * 1024, total: totalK * 1024 };
        }
      }
    }
  } catch (e) {
    console.warn('[getDiskSpaceForPath]', e.message);
  }
  return { free: 0, total: 0 };
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const isTest = process.env.ELECTRON_TEST === 'true';

let mainWindow = null;
let devServerProcess = null;
let nhentaiCdnRefererHookInstalled = false;
let nhentaiCdnCorsHookInstalled = false;


const distPath = path.join(__dirname, '..', 'dist');
const indexPath = path.join(distPath, 'index.html');


const DEV_SERVER_URL = process.env.EXPO_DEV_SERVER_URL || 'http://localhost:8081';


const APP_SCHEME = 'app';

const LOCAL_SCHEME = 'local';


function getDistBasePath() {
  if (app.isPackaged) {
    const appPath = app.getAppPath();
    const distPath = path.join(appPath, 'dist');
    const possiblePaths = [
      distPath, 
      path.join(process.resourcesPath, 'app.asar', 'dist'), 
      path.join(process.resourcesPath, 'app', 'dist'), 
    ];
    const foundPath = possiblePaths.find(p => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    const finalPath = foundPath || distPath; 
    console.log('[Electron] getDistBasePath - appPath:', appPath);
    console.log('[Electron] getDistBasePath - process.resourcesPath:', process.resourcesPath);
    console.log('[Electron] getDistBasePath - possible paths:', possiblePaths);
    console.log('[Electron] getDistBasePath - using path:', finalPath);
    console.log('[Electron] getDistBasePath - path exists:', fs.existsSync(finalPath));
    const indexPath = path.join(finalPath, 'index.html');
    console.log('[Electron] getDistBasePath - index.html exists:', fs.existsSync(indexPath));
    return finalPath;
  } else {
    return path.join(__dirname, '..', 'dist');
  }
}


function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.webp': 'image/webp', 
  };
  return mimeTypes[ext] || 'application/octet-stream';
}


protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,      
      secure: true,        
      supportFetchAPI: true, 
      corsEnabled: true,   
      stream: true,        
    },
  },
  {
    scheme: LOCAL_SCHEME,
    privileges: {
      standard: true,      
      secure: true,        
      supportFetchAPI: true, 
      corsEnabled: true,   
      stream: true,        
    },
  },
]);


function registerAppProtocolForSession(sess, distBasePath) {
  if (sess.__appProtocolInstalled) return;
  sess.__appProtocolInstalled = true;

  sess.protocol.handle(APP_SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch (e) {
      console.error(`[${APP_SCHEME}://] Invalid URL: ${request.url}`);
      return new Response('Invalid URL', { status: 400 });
    }
    let pathname = decodeURIComponent(url.pathname);

    const isFont = /\.(ttf|woff|woff2|otf)$/i.test(pathname);
    if (isFont) {
      console.log(`[${APP_SCHEME}://] Font Request: ${request.url}`);
      console.log(`[${APP_SCHEME}://] pathname: ${pathname}`);
    }

    if (pathname === '/' || pathname === '' || pathname === '//') {
      pathname = '/index.html';
    }

    let relativePath = pathname.replace(/^\/+/, '').replace(/^\.+\//, '');
    if (relativePath.includes('?')) {
      relativePath = relativePath.split('?')[0];
    }
    let filePath;
    if (relativePath.startsWith('electron/')) {
      const electronFile = relativePath.replace('electron/', '');
      filePath = path.join(__dirname, electronFile);
    } else {
      filePath = path.join(distBasePath, relativePath);
      if (!fs.existsSync(filePath) && isFont) {
        const fontFileName = path.basename(relativePath);
        const fontNameOnly = fontFileName.split('.')[0].split('-')[0]; 
        console.log(`[${APP_SCHEME}://] Font 404: ${fontFileName}. searching alternates...`);
        const possibleLocations = [
          path.join(distBasePath, 'assets', 'fonts', fontFileName),
          path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@expo', 'vector-icons', 'build', 'vendor', 'react-native-vector-icons', 'Fonts', fontFileName),
          path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@expo', 'vector-icons', 'build', 'vendor', 'react-native-vector-icons', 'Fonts', fontNameOnly + '.ttf'),
          path.join(app.getAppPath(), 'node_modules', '@expo', 'vector-icons', 'build', 'vendor', 'react-native-vector-icons', 'Fonts', fontFileName),
        ];

        for (const loc of possibleLocations) {
          if (fs.existsSync(loc)) {
            filePath = loc;
            console.log(`[${APP_SCHEME}://] Found alternate font path: ${filePath}`);
            break;
          }
        }
        if (!fs.existsSync(filePath)) {
          try {
            const unpackedFontsDir = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@expo', 'vector-icons', 'build', 'vendor', 'react-native-vector-icons', 'Fonts');
            if (fs.existsSync(unpackedFontsDir)) {
              const files = fs.readdirSync(unpackedFontsDir);
              const found = files.find(f => f.toLowerCase().startsWith(fontNameOnly.toLowerCase()) && f.endsWith('.ttf'));
              if (found) {
                filePath = path.join(unpackedFontsDir, found);
                console.log(`[${APP_SCHEME}://] Found font by fallback glob: ${filePath}`);
              }
            }
          } catch (e) {}
        }
      }
    }

    if (!fs.existsSync(filePath)) {
      if (isFont) {
        console.warn(`[${APP_SCHEME}://] FONT NOT FOUND: ${filePath}`);
        return new Response('Font Not Found', { status: 404 });
      }

      const ext = path.extname(filePath).toLowerCase();
      const isStaticResource = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.json', '.mp4', '.webm', '.mp3', '.wav'].includes(ext);

      if (!isStaticResource) {
        filePath = path.join(distBasePath, 'index.html');
        if (isDev) {
          console.log(`  SPA fallback to: ${filePath}`);
        }
      } else {
        if (isDev) {
          console.warn(`  NOT FOUND: ${filePath}`);
        }
        return new Response('Not Found', { status: 404 });
      }
    }

    try {
      if (!fs.existsSync(filePath)) {
        console.error(`[${APP_SCHEME}://] File not found: ${filePath}`);
        console.error(`[${APP_SCHEME}://] distBasePath: ${distBasePath}`);
        console.error(`[${APP_SCHEME}://] relativePath: ${relativePath}`);
        return new Response('File Not Found', { status: 404 });
      }
      const fileBuffer = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);

      console.log(`[${APP_SCHEME}://] Serving: ${filePath} (${mimeType}, ${fileBuffer.length} bytes)`);

      return new Response(fileBuffer, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': fileBuffer.length.toString(),
        },
      });
    } catch (error) {
      console.error(`[${APP_SCHEME}://] Error reading file: ${filePath}`, error);
      console.error(`[${APP_SCHEME}://] Error stack:`, error.stack);
      console.error(`[${APP_SCHEME}://] distBasePath: ${distBasePath}`);
      return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
    }
  });
}


function registerLocalProtocolForSession(sess) {
  if (sess.__localProtocolInstalled) return;
  sess.__localProtocolInstalled = true;

  sess.protocol.handle(LOCAL_SCHEME, async (request) => {
    const fullUrl = request.url;
    let filePath = fullUrl.replace(`${LOCAL_SCHEME}://`, '').replace(`${LOCAL_SCHEME}:/`, '');

    if (isDev) {
      console.log(`[${LOCAL_SCHEME}://] Request URL: ${request.url}`);
      console.log(`[${LOCAL_SCHEME}://] Extracted path: ${filePath}`);
    }

    try {
      let decoded = filePath;
      let prevDecoded = '';
      while (decoded !== prevDecoded) {
        prevDecoded = decoded;
        decoded = decodeURIComponent(decoded);
      }
      filePath = decoded;
    } catch (e) {
      if (isDev) {
        console.warn(`[${LOCAL_SCHEME}://] Failed to decode path, using as-is: ${filePath}`);
      }
    }

    if (process.platform === 'win32') {
      filePath = filePath.replace(/^\/+/, '');
      const driveMatch = filePath.match(/^([A-Za-z])(:)?(\/|\\|$)/);
      if (driveMatch) {
        const driveLetter = driveMatch[1];
        const rest = filePath.slice(driveMatch[0].length);
        filePath = driveLetter + ':' + path.sep + rest;
      }
      filePath = path.normalize(filePath);
    }

    try {
      if (!fs.existsSync(filePath)) {
        return new Response('File Not Found', { status: 404 });
      }
      const fileBuffer = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      return new Response(fileBuffer, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': fileBuffer.length.toString(),
        },
      });
    } catch (error) {
      console.error(`[${LOCAL_SCHEME}://] Error reading file: ${filePath}`, error);
      return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
    }
  });
}

function getPreloadPath(filename) {
  if (app.isPackaged) {
    const possiblePaths = [
      path.join(__dirname, filename), 
      path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', filename), 
      path.join(process.resourcesPath, 'app', 'electron', filename), 
    ];
    const foundPath = possiblePaths.find(p => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    return foundPath || possiblePaths[0];
  } else {
    return path.join(__dirname, filename);
  }
}


function registerProtocols() {
  const distBasePath = getDistBasePath();

  registerAppProtocolForSession(session.defaultSession, distBasePath);
  registerLocalProtocolForSession(session.defaultSession);

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const isFont = /\.(ttf|woff|woff2|otf)$/i.test(url) || url.includes('unstable_path=');
    if (isDev && url.startsWith(DEV_SERVER_URL)) {
      return callback({});
    }

    if (isFont && !url.startsWith(`${APP_SCHEME}://`)) {
      try {
        const urlObj = new URL(url);
        let pathname = urlObj.pathname;
        if (urlObj.searchParams.has('unstable_path')) {
          pathname = decodeURIComponent(urlObj.searchParams.get('unstable_path'));
        }

        const newUrl = `${APP_SCHEME}://${pathname.replace(/^\/+/, '')}`;
        console.log(`[Electron] Redirecting font request via webRequest: ${url} -> ${newUrl}`);
        callback({ redirectURL: newUrl });
        return;
      } catch (e) {
        console.error('[Electron] Error parsing font URL for redirect:', e);
      }
    }
    callback({});
  });

  // expo-image / <img> on web cannot set Referer from JS; nhentai CDN often returns 403 without it.
  if (!nhentaiCdnRefererHookInstalled) {
    nhentaiCdnRefererHookInstalled = true;
    const NHENTAI_REFERER = 'https://nhentai.net/';
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      try {
        const { hostname } = new URL(details.url);
        if (/^i\d*\.nhentai\.net$/i.test(hostname) || /^t\d*\.nhentai\.net$/i.test(hostname)) {
          callback({
            requestHeaders: {
              ...details.requestHeaders,
              Referer: NHENTAI_REFERER,
              Origin: details.requestHeaders.Origin || 'https://nhentai.net',
            },
          });
          return;
        }
      } catch (_) {
        /* ignore */
      }
      callback({ requestHeaders: details.requestHeaders });
    });
  }

  // expo-image (web) loads pixels via fetch(); i/t CDN omits ACAO → CORS blocks from localhost dev server.
  if (!nhentaiCdnCorsHookInstalled) {
    nhentaiCdnCorsHookInstalled = true;
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      try {
        const { hostname } = new URL(details.url);
        if (!/^i\d*\.nhentai\.net$/i.test(hostname) && !/^t\d*\.nhentai\.net$/i.test(hostname)) {
          return callback({ responseHeaders: details.responseHeaders });
        }
        const rh = { ...details.responseHeaders };
        rh['access-control-allow-origin'] = ['*'];
        rh['access-control-allow-methods'] = ['GET', 'HEAD', 'OPTIONS'];
        rh['access-control-allow-headers'] = ['*'];
        callback({ responseHeaders: rh });
      } catch (_) {
        callback({ responseHeaders: details.responseHeaders });
      }
    });
  }

  if (isDev) {
    console.log(`[Electron] Registered ${APP_SCHEME}:// protocol`);
    console.log(`[Electron] Registered ${LOCAL_SCHEME}:// protocol`);
    console.log(`[Electron] distBasePath: ${distBasePath}`);
  }
}

function createWindow() {
  const preloadPath = getPreloadPath('preload.js');
  if (app.isPackaged) {
    console.log('[Electron] Using preload path:', preloadPath);
    console.log('[Electron] Preload exists:', fs.existsSync(preloadPath));
    console.log('[Electron] __dirname:', __dirname);
    console.log('[Electron] process.resourcesPath:', process.resourcesPath);
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 200,
    minHeight: 200,
    frame: false, 
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      webviewTag: true,
    },
    icon: path.join(__dirname, '..', 'assets', 'images', 'icon.png'),
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximize-changed', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximize-changed', false);
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    if (errorCode !== -3) {
      console.error(`[Electron] Failed to load: ${validatedURL}`);
      console.error(`[Electron] Error: ${errorCode} - ${errorDescription}`);
    }
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2 || message.includes('font') || message.includes('Font') || message.includes('.ttf')) {
      console.log(`[Renderer ${level === 2 ? 'ERROR' : level === 1 ? 'WARN' : 'LOG'}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Electron] Page finished loading');
    mainWindow.webContents.executeJavaScript(`
      console.log('[Electron] App initialized');
      console.log('[Electron] window.location.href:', window.location.href);
      console.log('[Electron] window.location.pathname:', window.location.pathname);
      console.log('[Electron] window.location.protocol:', window.location.protocol);
      // Перехватываем запросы к шрифтам и перенаправляем их через app:// протокол
      (function() {
        const originalFetch = window.fetch;
        window.fetch = function(...args) {
          const url = args[0];
          if (typeof url === 'string' && /\.(ttf|woff|woff2|otf)$/i.test(url)) {
            // Если это относительный путь к шрифту, преобразуем в app://
            if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('app://')) {
              const baseUrl = window.location.origin || 'app://./';
              const newUrl = url.startsWith('/') ? baseUrl + url.slice(1) : baseUrl + url;
              console.log('[Electron] Redirecting font request:', url, '->', newUrl);
              args[0] = newUrl;
            }
          }
          return originalFetch.apply(this, args);
        };
      })();
    `).catch(err => console.error('[Electron] Error:', err));
  });

  if (isTest) {
    console.log(`[Electron] Connecting to dev server: ${DEV_SERVER_URL}`);
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.on('did-fail-load', () => {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(DEV_SERVER_URL);
        }
      }, 1000);
    });
  } else if (fs.existsSync(indexPath) || app.isPackaged) {
    const appUrl = `${APP_SCHEME}://./`;
    console.log(`[Electron] Loading via custom protocol: ${appUrl}`);
    mainWindow.loadURL(appUrl);
    } else {
    console.warn(`[Electron] dist/index.html not found, trying dev server: ${DEV_SERVER_URL}`);
    mainWindow.loadURL(DEV_SERVER_URL);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
    shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}


let loginWindow = null;
let loginResolve = null;
let loginCookieInterval = null;
let loginResolved = false; 

async function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    throw new Error('Login window already open');
  }

  loginResolved = false;

  try {
    const existingCookies = await session.defaultSession.cookies.get({ url: 'https://nhentai.net' });
    for (const cookie of existingCookies) {
      if (cookie.name === 'sessionid' || cookie.name === 'csrftoken') {
        await session.defaultSession.cookies.remove('https://nhentai.net', cookie.name);
        console.log(`[Login] Cleared cookie: ${cookie.name}`);
      }
    }
  } catch (err) {
    console.error('[Login] Error clearing cookies:', err);
  }

  return new Promise((resolve) => {
    loginResolve = resolve;

    loginWindow = new BrowserWindow({
      width: 500,
      height: 700,
      parent: mainWindow,
      modal: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: true,
      },
    });

    const LOGIN_URL = 'https://nhentai.net/login/?next=/';

    const finishLogin = (tokens) => {
      if (loginResolved) {
        console.log('[Login] Already resolved, ignoring duplicate call');
        return;
      }
      loginResolved = true;
      console.log('[Login] Finishing login with tokens:', !!tokens);
      if (loginCookieInterval) {
        clearInterval(loginCookieInterval);
        loginCookieInterval = null;
      }
      if (loginResolve) {
        const r = loginResolve;
        loginResolve = null;
        r(tokens);
      }
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
    };

    const checkCookies = async () => {
      if (!loginWindow || loginWindow.isDestroyed() || loginResolved) return;
      try {
        const cookies = await session.defaultSession.cookies.get({ url: 'https://nhentai.net' });
        let csrftoken = null;
        let sessionid = null;
        for (const cookie of cookies) {
          if (cookie.name === 'csrftoken') csrftoken = cookie.value;
          if (cookie.name === 'sessionid') sessionid = cookie.value;
        }
        console.log('[Login] Cookies:', { csrf: !!csrftoken, session: !!sessionid });
        if (sessionid) {
          console.log('[Login] SUCCESS - got sessionid!');
          finishLogin({ csrftoken, sessionid });
        }
      } catch (err) {
        console.error('[Login] Cookie check error:', err);
      }
    };

    loginCookieInterval = setInterval(checkCookies, 1000);

    loginWindow.webContents.on('did-navigate', (event, url) => {
      console.log('[Login] Navigate:', url);
      setTimeout(checkCookies, 300);
    });

    loginWindow.webContents.on('did-finish-load', () => {
      setTimeout(checkCookies, 300);
    });

    loginWindow.once('ready-to-show', () => {
      loginWindow.show();
    });

    loginWindow.on('closed', () => {
      console.log('[Login] Window closed event');
      if (loginCookieInterval) {
        clearInterval(loginCookieInterval);
        loginCookieInterval = null;
      }
      loginWindow = null;
      if (loginResolve && !loginResolved) {
        console.log('[Login] Window closed without login');
        finishLogin(null);
      }
    });

    loginWindow.loadURL(LOGIN_URL);
  });
}


ipcMain.handle('electron:getVersion', () => {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg && typeof pkg.version === 'string') return pkg.version;
  } catch (e) {
    console.warn('[Electron] getVersion from package.json:', e?.message);
  }
  return app.getVersion();
});
ipcMain.handle('electron:getPlatform', () => process.platform);
ipcMain.handle('electron:getOsName', () => {
  const platform = process.platform;
  const release = os.release();
  if (platform === 'win32') {
    const ver = release.split('.');
    const major = parseInt(ver[0], 10);
    if (major >= 10) return `Windows ${major >= 11 ? 11 : 10}`;
    return 'Windows';
  }
  if (platform === 'darwin') return `macOS ${release.split('.')[0] || ''}`.trim();
  if (platform === 'linux') return 'Linux';
  return platform;
});

ipcMain.handle('electron:getBannerAssetDataUrls', async () => {
  try {
    const dir = __dirname;
    const updPath = path.join(dir, 'upd.png');
    const iconPath = path.join(dir, 'adaptive-icon.png');
    const [updBuf, iconBuf] = await Promise.all([
      fs.promises.readFile(updPath).catch(() => null),
      fs.promises.readFile(iconPath).catch(() => null),
    ]);
    const toDataUrl = (buf, mime = 'image/png') =>
      buf ? `data:${mime};base64,${buf.toString('base64')}` : null;
    return {
      bg: toDataUrl(updBuf),
      icon: toDataUrl(iconBuf),
    };
  } catch (e) {
    console.warn('[Electron] getBannerAssetDataUrls:', e?.message);
    return { bg: null, icon: null };
  }
});

ipcMain.handle('electron:login', async () => {
  try {
    const result = await createLoginWindow();
    return { success: true, tokens: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('electron:getCookies', async (event, url) => {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: url || 'https://nhentai.net' });
    const result = {};
    for (const cookie of cookies) {
      result[cookie.name] = cookie.value;
    }
    return { success: true, cookies: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


let cloudflareWindow = null;
let cloudflareResolve = null;
let cloudflareCookieInterval = null;
let cloudflareResolved = false;

async function createCloudflareChallengeWindow(options) {
  const { url, galleryId, prefillText } = options || {};
  if (cloudflareWindow && !cloudflareWindow.isDestroyed()) {
    console.log('[Cloudflare] Closing existing window before opening new one');
    cloudflareResolved = true;
    if (cloudflareCookieInterval) {
      clearInterval(cloudflareCookieInterval);
      cloudflareCookieInterval = null;
    }
    cloudflareWindow.close();
    cloudflareWindow = null;
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  cloudflareResolved = false;
  const targetUrl = url || (galleryId ? `https://nhentai.net/g/${galleryId}/` : 'https://nhentai.net/');

  const cloudflareSession = session.fromPartition('persist:cloudflare');
  try {
    const mainCookies = await session.defaultSession.cookies.get({ url: 'https://nhentai.net' });
    console.log(`[Cloudflare] Syncing ${mainCookies.length} cookies to Cloudflare session`);
    for (const cookie of mainCookies) {
      try {
        await cloudflareSession.cookies.set({
          url: 'https://nhentai.net',
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expirationDate: cookie.expirationDate,
        });
      } catch (err) {
        console.warn(`[Cloudflare] Failed to sync cookie ${cookie.name}:`, err);
      }
    }
    console.log('[Cloudflare] Cookies synced to Cloudflare session');
  } catch (err) {
    console.error('[Cloudflare] Error syncing cookies:', err);
  }

  return new Promise((resolve) => {
    cloudflareResolve = resolve;

    cloudflareWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      parent: mainWindow,
      modal: false,
      show: false, 
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:cloudflare',
        webviewTag: true,
      },
    });

    const finishCloudflare = (result) => {
      if (cloudflareResolved) {
        console.log('[Cloudflare] Already resolved, ignoring duplicate call');
        return;
      }
      cloudflareResolved = true;
      console.log('[Cloudflare] Finishing challenge');

      if (cloudflareCookieInterval) {
        clearInterval(cloudflareCookieInterval);
        cloudflareCookieInterval = null;
      }

      if (cloudflareResolve) {
        const r = cloudflareResolve;
        cloudflareResolve = null;
        r(result);
      }

      setTimeout(() => {
        if (cloudflareWindow && !cloudflareWindow.isDestroyed()) {
          console.log('[Cloudflare] Closing window after completion');
          cloudflareWindow.close();
          cloudflareWindow = null;
        }
      }, 100);
    };

    let lastCommentIds = new Set();
    const checkForNewComment = async () => {
      if (!cloudflareWindow || cloudflareWindow.isDestroyed() || cloudflareResolved) return null;
      try {
        const result = await cloudflareWindow.webContents.executeJavaScript(`
          (function() {
            try {
              var comments = document.querySelectorAll('#comments .comment');
              var newComments = [];
              for (var i = 0; i < comments.length; i++) {
                var comment = comments[i];
                var commentId = comment.id;
                var timeEl = comment.querySelector('time[datetime]');
                var bodyEl = comment.querySelector('.body');
                var userLink = comment.querySelector('.header .left b a');
                var avatarLink = comment.querySelector('.avatar');
                var avatarImg = comment.querySelector('.avatar img');
                if (commentId && timeEl && bodyEl) {
                  var datetime = timeEl.getAttribute('datetime');
                  var timestamp = datetime ? new Date(datetime).getTime() : null;
                  var bodyText = bodyEl.textContent || bodyEl.innerText || '';
                  var username = '';
                  if (userLink) {
                    var userText = userLink.textContent || userLink.innerText || '';
                    if (userText && userText.trim) {
                      username = userText.trim();
                    } else {
                      username = userText;
                    }
                  }
                  // Пробуем извлечь ID пользователя из ссылки на профиль
                  var userId = null;
                  var profileLink = null;
                  if (userLink && userLink.getAttribute) {
                    profileLink = userLink.getAttribute('href');
                  }
                  if (!profileLink && avatarLink && avatarLink.getAttribute) {
                    profileLink = avatarLink.getAttribute('href');
                  }
                  if (profileLink) {
                    try {
                      // Формат ссылки: /users/5912619/evts
                      var parts = profileLink.split('/users/');
                      if (parts.length > 1 && parts[1]) {
                        var idPart = parts[1].split('/')[0];
                        var parsedId = parseInt(idPart, 10);
                        if (!isNaN(parsedId)) {
                          userId = parsedId;
                        }
                      }
                    } catch (e) {
                      userId = null;
                    }
                  }
                  var avatarUrl = '';
                  if (avatarImg) {
                    var src = avatarImg.getAttribute('src') || '';
                    var dataSrc = avatarImg.getAttribute('data-src') || '';
                    if (src && src.indexOf('data:image') === 0) {
                      avatarUrl = dataSrc || '';
                    } else {
                      avatarUrl = src || dataSrc || '';
                    }
                    if (avatarUrl && avatarUrl.indexOf('//') === 0) {
                      avatarUrl = 'https:' + avatarUrl;
                    }
                    if (avatarUrl && avatarUrl.indexOf('http') !== 0 && avatarUrl.indexOf('data:') !== 0) {
                      if (avatarUrl.indexOf('/') === 0) {
                        avatarUrl = 'https://i.nhentai.net' + avatarUrl;
                      } else {
                        avatarUrl = 'https://i.nhentai.net/' + avatarUrl;
                      }
                    }
                    if (avatarUrl && (avatarUrl.indexOf('data:') === 0 || avatarUrl.length === 0)) {
                      avatarUrl = '';
                    }
                  }
                  var commentIdNum = commentId.replace('comment-', '');
                  newComments.push({
                    id: commentIdNum,
                    commentId: commentId,
                    body: bodyText,
                    timestamp: timestamp,
                    datetime: datetime,
                    username: username,
                    userId: userId,
                    avatarUrl: avatarUrl,
                    postDate: timestamp || Date.now(),
                  });
                }
              }
              return newComments;
            } catch (error) {
              console.error('[Cloudflare] Error in checkForNewComment script:', error);
              return [];
            }
          })();
        `);
        if (result && Array.isArray(result) && result.length > 0) {
          const newestComment = result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
          const commentAge = Date.now() - (newestComment.timestamp || 0);
          const isRecent = commentAge < 120000 && commentAge > -60000; 
          if (isRecent && !lastCommentIds.has(newestComment.id)) {
            if (prefillText && newestComment.body.trim().toLowerCase() === prefillText.trim().toLowerCase()) {
              console.log('[Cloudflare] Found new comment matching sent text:', newestComment);
              lastCommentIds.add(newestComment.id);
              return newestComment;
            }
          }
        }
        return null;
      } catch (err) {
        console.error('[Cloudflare] Error checking for new comment:', err);
        return null;
      }
    };

    const checkCookiesAndComment = async () => {
      if (!cloudflareWindow || cloudflareWindow.isDestroyed() || cloudflareResolved) return;
      try {
        const cloudflareSession = cloudflareWindow.webContents.session;
        const cookies = await cloudflareSession.cookies.get({ url: 'https://nhentai.net' });
        const cookieMap = {};
        for (const cookie of cookies) {
          cookieMap[cookie.name] = cookie.value;
        }

        const hasSession = !!cookieMap['sessionid'];
        if (!hasSession) {
          console.log('[Cloudflare] No sessionid cookie - user not logged in');
        }

        if (cookieMap['cf_clearance']) {
          console.log('[Cloudflare] cf_clearance cookie found!');
          try {
            for (const cookie of cookies) {
              await session.defaultSession.cookies.set({
                url: 'https://nhentai.net',
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                sameSite: cookie.sameSite,
                expirationDate: cookie.expirationDate,
              });
            }
            console.log('[Cloudflare] Cookies synced to main session');
          } catch (err) {
            console.error('[Cloudflare] Error syncing cookies:', err);
          }

          let commentResult = null;
          try {
            const interceptedResult = await cloudflareWindow.webContents.executeJavaScript('window.__cloudflareCommentResult');
            if (interceptedResult) {
              console.log('[Cloudflare] Comment result from interceptor:', interceptedResult);
              commentResult = interceptedResult;
              cloudflareWindow.webContents.executeJavaScript('window.__cloudflareCommentResult = null').catch(() => {});
            }
          } catch (err) {
          }
          if (!commentResult && prefillText) {
            const newComment = await checkForNewComment();
            if (newComment) {
              console.log('[Cloudflare] Found new comment in DOM:', newComment);
              console.log('[Cloudflare] Avatar URL from DOM:', newComment.avatarUrl);
              var slug = newComment.username ? newComment.username.toLowerCase() : 'user';
              commentResult = {
                id: parseInt(newComment.id) || undefined,
                gallery_id: galleryId,
                body: newComment.body,
                post_date: newComment.postDate,
                poster: {
                  username: newComment.username,
                  slug: slug,
                  ...(newComment.userId ? { id: newComment.userId } : {}),
                  ...(newComment.avatarUrl ? { avatar_url: newComment.avatarUrl } : {}),
                },
              };
              console.log('[Cloudflare] Comment result with avatar:', commentResult);
            }
          }
          if (commentResult) {
            console.log('[Cloudflare] Comment successfully posted, closing window');
            setTimeout(() => {
              finishCloudflare({
                success: true,
                cookies: {
                  csrf: cookieMap['csrftoken'] || null,
                  session: cookieMap['sessionid'] || null,
                  cf: cookieMap['cf_clearance'] || null,
                },
                comment: commentResult,
              });
            }, 500);
          }
        }
      } catch (err) {
        console.error('[Cloudflare] Cookie check error:', err);
      }
    };

    cloudflareCookieInterval = setInterval(checkCookiesAndComment, 1000);
    const commentCheckInterval = setInterval(async () => {
      if (cloudflareResolved) {
        clearInterval(commentCheckInterval);
        return;
      }
      if (prefillText) {
        const newComment = await checkForNewComment();
        if (newComment) {
          console.log('[Cloudflare] New comment detected in DOM, closing window');
          clearInterval(commentCheckInterval);
          const commentResult = {
            id: parseInt(newComment.id) || undefined,
            gallery_id: galleryId,
            body: newComment.body,
            post_date: newComment.postDate,
            poster: {
              username: newComment.username,
              ...(newComment.userId ? { id: newComment.userId } : {}),
              ...(newComment.avatarUrl ? { avatar_url: newComment.avatarUrl } : {}),
            },
          };
          try {
            const cloudflareSession = cloudflareWindow.webContents.session;
            const cookies = await cloudflareSession.cookies.get({ url: 'https://nhentai.net' });
            const cookieMap = {};
            for (const cookie of cookies) {
              cookieMap[cookie.name] = cookie.value;
            }
            for (const cookie of cookies) {
              await session.defaultSession.cookies.set({
                url: 'https://nhentai.net',
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                sameSite: cookie.sameSite,
                expirationDate: cookie.expirationDate,
              });
            }
            finishCloudflare({
              success: true,
              cookies: {
                csrf: cookieMap['csrftoken'] || null,
                session: cookieMap['sessionid'] || null,
                cf: cookieMap['cf_clearance'] || null,
              },
              comment: commentResult,
            });
          } catch (err) {
            console.error('[Cloudflare] Error getting cookies for comment:', err);
            finishCloudflare({
              success: true,
              comment: commentResult,
            });
          }
        }
      }
    }, 500);
    cloudflareWindow.webContents.on('did-navigate', (event, navUrl) => {
      console.log('[Cloudflare] Navigate:', navUrl);
      setTimeout(() => {
        if (!cloudflareWindow || cloudflareWindow.isDestroyed() || cloudflareResolved) {
          return;
        }
        checkCookiesAndComment();
      }, 500);
    });

    cloudflareWindow.webContents.on('dom-ready', () => {
      if (!cloudflareWindow || cloudflareWindow.isDestroyed()) {
        return;
      }
      cloudflareWindow.webContents.executeJavaScript(`
        (function() {
          // Перехватываем fetch для отправки комментария
          const originalFetch = window.fetch;
          window.fetch = function(...args) {
            const url = args[0];
            const options = args[1] || {};
            // Проверяем, это запрос на отправку комментария?
            if (typeof url === 'string' && (url.includes('/comments/submit') || (url.includes('/api/gallery/') && url.includes('/comments')))) {
              if (options.method === 'POST') {
                console.log('[Cloudflare] Intercepting comment submit via fetch:', url);
                return originalFetch.apply(this, args)
                  .then(response => {
                    const cloned = response.clone();
                    cloned.json().then(data => {
                      if (data && !data.error) {
                        console.log('[Cloudflare] Comment submitted successfully via fetch');
                        window.__cloudflareCommentResult = data;
                      }
                    }).catch(() => {});
                    return response;
                  });
              }
            }
            return originalFetch.apply(this, args);
          };
          // Перехватываем XMLHttpRequest
          const originalXHROpen = XMLHttpRequest.prototype.open;
          const originalXHRSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method, url) {
            this.__method = method;
            this.__url = url;
            return originalXHROpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function(data) {
            if (this.__method === 'POST' && this.__url && (this.__url.includes('/comments/submit') || (this.__url.includes('/api/gallery/') && this.__url.includes('/comments')))) {
              console.log('[Cloudflare] Intercepting XHR comment submit:', this.__url);
              this.addEventListener('loadend', function() {
                if (this.status >= 200 && this.status < 300) {
                  try {
                    const result = JSON.parse(this.responseText);
                    if (result && !result.error) {
                      console.log('[Cloudflare] Comment submitted via XHR');
                      window.__cloudflareCommentResult = result;
                    }
                  } catch (e) {}
                }
              });
            }
            return originalXHRSend.apply(this, arguments);
          };
        })();
      `).catch(err => console.error('[Cloudflare] Error injecting interceptors:', err));
    });

    cloudflareWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        if (!cloudflareWindow || cloudflareWindow.isDestroyed() || cloudflareResolved) {
          return;
        }
        checkCookiesAndComment();
      }, 500);
      if (prefillText && galleryId) {
        setTimeout(() => {
          if (!cloudflareWindow || cloudflareWindow.isDestroyed() || cloudflareResolved) {
            return;
          }
          cloudflareWindow.webContents.executeJavaScript(`
            (function() {
              try {
                console.log('[Cloudflare] Starting auto-fill and submit');
                // Находим textarea
                const textarea = document.querySelector('#id_body') || 
                                document.querySelector('textarea[name="body"]') ||
                                document.querySelector('textarea');
                if (textarea) {
                  console.log('[Cloudflare] Found textarea, inserting text:', ${JSON.stringify(prefillText.substring(0, 50))} + '...');
                  // Вставляем текст
                  textarea.value = ${JSON.stringify(prefillText)};
                  // Триггерим события для валидации
                  textarea.dispatchEvent(new Event('input', { bubbles: true }));
                  textarea.dispatchEvent(new Event('change', { bubbles: true }));
                  textarea.dispatchEvent(new Event('blur', { bubbles: true }));
                  // Ждем немного для обработки событий и нажимаем кнопку
                  setTimeout(() => {
                    // Ищем форму комментария (родительский элемент textarea)
                    const commentForm = textarea.closest('form') || 
                                      textarea.closest('#comment_form') ||
                                      textarea.closest('.row')?.querySelector('form');
                    // Ищем кнопку отправки ВНУТРИ формы комментария, а не на всей странице
                    let submitBtn = null;
                    if (commentForm) {
                      // Ищем кнопку внутри формы комментария
                      submitBtn = commentForm.querySelector('button[type="submit"]') ||
                                 commentForm.querySelector('button.btn-primary') ||
                                 commentForm.querySelector('.btn-primary') ||
                                 commentForm.querySelector('button.btn');
                      console.log('[Cloudflare] Found comment form, looking for submit button inside');
                    }
                    // Если не нашли в форме, ищем рядом с textarea
                    if (!submitBtn) {
                      const commentContainer = textarea.closest('#comment_form') || 
                                              textarea.closest('.row') ||
                                              textarea.parentElement;
                      if (commentContainer) {
                        submitBtn = commentContainer.querySelector('button[type="submit"]') ||
                                   commentContainer.querySelector('button.btn-primary') ||
                                   commentContainer.querySelector('.btn-primary');
                        console.log('[Cloudflare] Looking for submit button near textarea');
                      }
                    }
                    if (submitBtn) {
                      console.log('[Cloudflare] Found submit button in comment form, clicking');
                      // Проверяем, что textarea валидна (минимум 10 символов)
                      if (textarea.value.length >= 10) {
                        // Проверяем, что это действительно кнопка комментария (не поиска)
                        const btnText = submitBtn.textContent || submitBtn.innerHTML || '';
                        const isCommentBtn = btnText.includes('Comment') || 
                                           btnText.includes('comment') ||
                                           submitBtn.querySelector('i.fa-comment');
                        if (isCommentBtn || !submitBtn.closest('form.search')) {
                          submitBtn.click();
                          console.log('[Cloudflare] Comment submit button clicked');
                        } else {
                          console.warn('[Cloudflare] Found submit button but it seems to be search button, skipping');
                        }
                      } else {
                        console.warn('[Cloudflare] Text too short:', textarea.value.length);
                      }
                    } else {
                      console.warn('[Cloudflare] Submit button not found in comment form, trying form submit');
                      // Пробуем отправить форму комментария напрямую
                      if (commentForm && !commentForm.classList.contains('search')) {
                        commentForm.submit();
                        console.log('[Cloudflare] Comment form submitted directly');
                      }
                    }
                  }, 1000);
                } else {
                  console.warn('[Cloudflare] Textarea not found, retrying in 2 seconds...');
                  return false;
                  // Повторная попытка через 2 секунды (на случай медленной загрузки)
                  setTimeout(() => {
                    const retryTextarea = document.querySelector('#id_body') || 
                                         document.querySelector('textarea[name="body"]');
                    if (retryTextarea) {
                      retryTextarea.value = ${JSON.stringify(prefillText)};
                      retryTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                      setTimeout(() => {
                        // Ищем кнопку в форме комментария, а не поиска
                        const retryForm = retryTextarea.closest('form');
                        const retryBtn = retryForm && !retryForm.classList.contains('search')
                          ? (retryForm.querySelector('button[type="submit"]') || 
                             retryForm.querySelector('.btn-primary'))
                          : null;
                        if (retryBtn) {
                          const btnText = retryBtn.textContent || retryBtn.innerHTML || '';
                          const isCommentBtn = btnText.includes('Comment') || 
                                             btnText.includes('comment') ||
                                             retryBtn.querySelector('i.fa-comment');
                          if (isCommentBtn || !retryBtn.closest('form.search')) {
                            retryBtn.click();
                            console.log('[Cloudflare] Submit button clicked on retry');
                          }
                        }
                      }, 500);
                    }
                  }, 2000);
                }
              } catch (err) {
                console.error('[Cloudflare] Error auto-filling comment:', err);
              }
            })();
          `).catch(err => {
            if (!cloudflareWindow || cloudflareWindow.isDestroyed()) {
              return;
            }
            console.error('[Cloudflare] Error executing auto-fill script:', err);
          });
        }, 2000); 
      }
    });

    cloudflareWindow.once('ready-to-show', () => {
      setTimeout(() => {
        checkCookiesAndComment();
      }, 1000);
    });

    cloudflareWindow.on('closed', () => {
      console.log('[Cloudflare] Window closed event');
      if (cloudflareCookieInterval) {
        clearInterval(cloudflareCookieInterval);
        cloudflareCookieInterval = null;
      }
      if (cloudflareWindow && cloudflareWindow.isDestroyed()) {
        cloudflareWindow = null;
      }
      if (cloudflareResolve && !cloudflareResolved) {
        console.log('[Cloudflare] Window closed without completion');
        finishCloudflare({ success: false, error: 'Window closed' });
      }
    });

    cloudflareWindow.loadURL(targetUrl);
  });
}

ipcMain.handle('electron:openCloudflareChallenge', async (event, options) => {
  try {
    const result = await createCloudflareChallengeWindow(options);
  return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('electron:fetchHtml', async (event, url) => {
  try {
    const { net } = require('electron');
    const cookieList = await session.defaultSession.cookies.get({ url });
    const cookieHeader = cookieList
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    console.log(`[fetchHtml] Fetching ${url} with ${cookieList.length} cookies`);
    return new Promise((resolve) => {
      const request = net.request({
        method: 'GET',
        url: url,
        headers: {
          'Cookie': cookieHeader,
          'User-Agent': 'nh-client',
          'Referer': 'https://nhentai.net/',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
      let html = '';
      let finalUrl = url; 
      request.on('response', (response) => {
        console.log(`[fetchHtml] Response status: ${response.statusCode}`);
        const location = response.headers['location'] || response.headers['Location'];
        if (location) {
          finalUrl = location.startsWith('http') ? location : new URL(location, url).href;
          console.log(`[fetchHtml] Redirect to: ${finalUrl}`);
        }
        response.on('data', (chunk) => {
          html += chunk.toString();
        });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 400) {
            console.log(`[fetchHtml] Success, HTML length: ${html.length}, finalUrl: ${finalUrl}`);
            resolve({ success: true, html, status: response.statusCode, finalUrl });
          } else {
            console.warn(`[fetchHtml] HTTP ${response.statusCode}`);
            resolve({ success: false, error: `HTTP ${response.statusCode}`, status: response.statusCode, finalUrl });
          }
        });
      });
      request.on('error', (error) => {
        console.error(`[fetchHtml] Request error:`, error);
        resolve({ success: false, error: error.message, finalUrl: url });
      });
      request.end();
    });
  } catch (error) {
    console.error(`[fetchHtml] Error:`, error);
    return { success: false, error: error.message };
  }
});

// Legacy profile edit/blacklist IPC handlers removed (app uses API v2).


ipcMain.handle('electron:getRandomId', async () => {
  try {
    const { net } = require('electron');
    const baseUrl = 'https://nhentai.net/random';
    const makeRequest = async (url, redirectCount = 0) => {
      if (redirectCount > 5) {
        throw new Error('Too many redirects');
      }
      const cookieList = await session.defaultSession.cookies.get({ url });
      const cookieHeader = cookieList
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
      console.log(`[getRandomId] Fetching ${url} with ${cookieList.length} cookies (redirect: ${redirectCount})`);
      return new Promise((resolve, reject) => {
        const request = net.request({
          method: 'GET',
          url: url,
          headers: {
            'Cookie': cookieHeader,
            'User-Agent': 'nh-client',
            'Referer': 'https://nhentai.net/',
            'Accept': 'text/html,application/xhtml+xml',
          },
        });
        let html = '';
        let finalUrl = url;
        request.on('response', (response) => {
          const statusCode = response.statusCode;
          console.log(`[getRandomId] Response status: ${statusCode} for ${url}`);
          if (statusCode >= 300 && statusCode < 400) {
            const location = response.headers['location'] || response.headers['Location'];
            if (location) {
              response.on('data', () => {});
              response.on('end', () => {
                const redirectUrl = location.startsWith('http') ? location : new URL(location, url).href;
                console.log(`[getRandomId] Redirect ${statusCode} to: ${redirectUrl}`);
                makeRequest(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
              });
              return;
            }
          }
          if (statusCode >= 200 && statusCode < 300) {
            const location = response.headers['location'] || response.headers['Location'];
            if (location && location !== url) {
              finalUrl = location.startsWith('http') ? location : new URL(location, url).href;
              console.log(`[getRandomId] Location header found: ${finalUrl}`);
            } else {
              finalUrl = url;
            }
            response.on('data', (chunk) => {
              html += chunk.toString();
            });
            response.on('end', () => {
              const urlMatch = finalUrl.match(/\/g\/(\d+)\//);
              if (urlMatch?.[1]) {
                const id = Number(urlMatch[1]);
                console.log(`[getRandomId] Success, extracted ID: ${id} from URL: ${finalUrl}`);
                resolve({ success: true, id });
                return;
              }
              let htmlMatch = html.match(/rel=["']canonical["'][^>]*href=["']([^"']*\/g\/(\d+)\/)[^"']*["']/i);
              if (htmlMatch?.[2]) {
                const id = Number(htmlMatch[2]);
                console.log(`[getRandomId] Success, extracted ID: ${id} from canonical link`);
                resolve({ success: true, id });
                return;
              }
              htmlMatch = html.match(/property=["']og:url["'][^>]*content=["']([^"']*\/g\/(\d+)\/)[^"']*["']/i);
              if (htmlMatch?.[2]) {
                const id = Number(htmlMatch[2]);
                console.log(`[getRandomId] Success, extracted ID: ${id} from og:url`);
                resolve({ success: true, id });
                return;
              }
              htmlMatch = html.match(/window\.location\s*=\s*["']([^"']*\/g\/(\d+)\/)[^"']*["']/i);
              if (htmlMatch?.[2]) {
                const id = Number(htmlMatch[2]);
                console.log(`[getRandomId] Success, extracted ID: ${id} from window.location`);
                resolve({ success: true, id });
                return;
              }
              // 4. Meta refresh
              htmlMatch = html.match(/meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']*\/g\/(\d+)\/)[^"']*["']/i);
              if (htmlMatch?.[2]) {
                const id = Number(htmlMatch[2]);
                console.log(`[getRandomId] Success, extracted ID: ${id} from meta refresh`);
                resolve({ success: true, id });
                return;
              }
              // 5. Любой URL с /g/ID/ в HTML
              htmlMatch = html.match(/\/g\/(\d+)\//);
              if (htmlMatch?.[1]) {
                const id = Number(htmlMatch[1]);
                console.log(`[getRandomId] Success, extracted ID: ${id} from generic /g/ID/ pattern`);
                resolve({ success: true, id });
                return;
              }
              console.warn(`[getRandomId] Failed to extract ID from URL or HTML. FinalUrl: ${finalUrl}, HTML length: ${html.length}`);
              // Логируем небольшой фрагмент HTML для отладки
              if (html.length > 500) {
                console.warn(`[getRandomId] HTML preview (first 500 chars): ${html.substring(0, 500)}`);
              }
              resolve({ success: false, error: 'Failed to extract gallery id', finalUrl });
            });
          } else {
            reject(new Error(`HTTP ${statusCode}`));
          }
        });
        request.on('error', (error) => {
          console.error(`[getRandomId] Request error:`, error);
          reject(error);
        });
        request.end();
      });
    };
    // Выполняем запрос с обработкой редиректов
    try {
      return await makeRequest(baseUrl);
    } catch (error) {
      console.error(`[getRandomId] Error:`, error);
      return { success: false, error: error.message };
    }
  } catch (error) {
    console.error(`[getRandomId] Error:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('electron:readFile', async (event, filePath) => {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { success: true, content };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('electron:getFileAsDataUrl', async (event, filePath) => {
  try {
    const buf = await fs.promises.readFile(filePath);
    const base64 = buf.toString('base64');
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { success: true, dataUrl: `data:${mime};base64,${base64}` };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('electron:writeFile', async (event, filePath, content) => {
  try {
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// File system operations for Electron
ipcMain.handle('electron:getInfo', async (event, filePath) => {
  try {
    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (!stats) {
      return { success: true, exists: false };
    }
    return {
      success: true,
      exists: true,
      isDirectory: stats.isDirectory(),
      size: stats.size,
      modificationTime: stats.mtime.getTime(),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Окна чтения (храним ссылки для управления)
const readerWindows = new Map();

ipcMain.handle('electron:openReaderWindow', async (event, options) => {
  const { bookId, page = 1 } = options;
  const windowKey = `reader-${bookId}`;
  // Если окно уже открыто, фокусируем его
  if (readerWindows.has(windowKey)) {
    const existingWindow = readerWindows.get(windowKey);
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.focus();
      existingWindow.webContents.send('reader:navigate', { bookId, page });
      return { success: true, windowId: existingWindow.id };
    } else {
      readerWindows.delete(windowKey);
    }
  }
  // Используем отдельный preload для reader окна
  const readerPreloadPath = getPreloadPath('reader-preload.js');
  const readerHtmlPath = path.join(__dirname, 'reader.html');
  // Получаем размер экрана
  const { width: screenWidth, height: screenHeight } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const readerWindow = new BrowserWindow({
    width: screenWidth,
    height: screenHeight,
    minWidth: 600,
    minHeight: 400,
    frame: false, // Без рамки для полного контроля
    transparent: true, // Прозрачное окно для оверлея
    backgroundColor: '#00000000',
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    webPreferences: {
      preload: readerPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      webviewTag: true,
    },
    show: false, // Показываем после загрузки
  });
  readerWindows.set(windowKey, readerWindow);
  // Отслеживаем maximize/minimize для обновления кнопки
  readerWindow.on('maximize', () => {
    readerWindow.webContents.send('window:maximize');
  });
  readerWindow.on('unmaximize', () => {
    readerWindow.webContents.send('window:unmaximize');
  });
  // Удаляем из Map при закрытии окна
  readerWindow.on('closed', () => {
    readerWindows.delete(windowKey);
  });
  // Показываем окно сразу и разворачиваем на весь экран
  readerWindow.once('ready-to-show', () => {
    readerWindow.maximize();
    readerWindow.show();
  });
  // Загружаем через app:// протокол для общего localStorage
  // Используем путь относительно dist для единого протокола с основным окном
  const readerUrl = `app://./electron/reader.html?bookId=${bookId}&page=${page}`;
  readerWindow.loadURL(readerUrl).catch(err => {
    console.error('[Electron Reader] Error loading window:', err);
  });
  return { success: true, windowId: readerWindow.id };
});

ipcMain.handle('electron:readDirectory', async (event, dirPath) => {
  try {
    const entries = await fs.promises.readdir(dirPath);
    return { success: true, entries };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('electron:makeDirectory', async (event, dirPath, options) => {
  try {
    await fs.promises.mkdir(dirPath, { recursive: options?.intermediates !== false });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('electron:deleteAsync', async (event, filePath, options) => {
  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.isDirectory()) {
      await fs.promises.rmdir(filePath, { recursive: true });
    } else {
      await fs.promises.unlink(filePath);
    }
    return { success: true };
  } catch (error) {
    if (options?.idempotent && error.code === 'ENOENT') {
      return { success: true }; // File doesn't exist, but that's ok
    }
    return { success: false, error: error.message };
  }
});

ipcMain.handle('electron:getPicturesPath', async () => {
  try {
    const picturesPath = app.getPath('pictures');
    return { success: true, path: picturesPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Path utilities for renderer process
ipcMain.handle('electron:pathJoin', async (event, ...paths) => {
  try {
    return path.join(...paths);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('electron:pathNormalize', async (event, p) => {
  try {
    return path.normalize(p);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('electron:pathSep', async () => {
  return path.sep;
});

// Show folder picker dialog
ipcMain.handle('electron:showOpenDialog', async (event, options) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      ...options,
    });
    return { success: true, canceled: result.canceled, filePaths: result.filePaths };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Download file from URL to local path
ipcMain.handle('electron:downloadFile', async (event, url, filePath) => {
  try {
    const { net } = require('electron');
    return new Promise((resolve) => {
      const request = net.request({
        method: 'GET',
        url: url,
      });
      const fileStream = fs.createWriteStream(filePath);
      request.on('response', (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          response.on('data', (chunk) => {
            fileStream.write(chunk);
          });
          response.on('end', () => {
            fileStream.end();
            resolve({ success: true });
          });
    } else {
          fileStream.end();
          fs.unlink(filePath, () => {});
          resolve({ success: false, error: `HTTP ${response.statusCode}` });
        }
      });
      request.on('error', (error) => {
        fileStream.end();
        fs.unlink(filePath, () => {});
        resolve({ success: false, error: error.message });
      });
      request.end();
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/** Referer/Origin must match the request URL host or Chromium cancels (invalid referrer → ERR_BLOCKED_BY_CLIENT). */
function refererOriginForRequestUrl(requestUrl) {
  try {
    const u = new URL(requestUrl);
    const host = u.hostname;
    if (host === 'nhentai.net' || host.endsWith('.nhentai.net')) {
      return { Referer: 'https://nhentai.net/', Origin: 'https://nhentai.net' };
    }
    const origin = `${u.protocol}//${u.host}`;
    return { Referer: `${origin}/`, Origin: origin };
  } catch {
    return { Referer: 'https://nhentai.net/', Origin: 'https://nhentai.net' };
  }
}

// Fetch JSON/API requests with Electron session cookies (bypasses CORS and proxy issues)
ipcMain.handle('electron:fetchJson', async (event, url, options) => {
  try {
    const { net } = require('electron');
    const method = options.method || 'GET';
    const headers = options.headers || {};
    // Если cookies уже переданы в заголовках (из AsyncStorage), используем их
    // Иначе получаем из session
    if (!headers['Cookie']) {
      // Получаем cookies из session
      const cookieList = await session.defaultSession.cookies.get({ url });
      // Формируем Cookie заголовок
      const cookieHeader = cookieList
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
        console.log(`[fetchJson] Using cookies from session (${cookieList.length} cookies)`);
      }
    } else {
      console.log(`[fetchJson] Using cookies from headers (from AsyncStorage)`);
    }
    // Фильтруем заголовки: убираем пустые значения и undefined
    const cleanHeaders = {};
    Object.keys(headers).forEach(key => {
      const value = headers[key];
      if (value !== undefined && value !== null && value !== '') {
        cleanHeaders[key] = String(value);
      }
    });
    const refOr = refererOriginForRequestUrl(url);
    const finalHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      Referer: refOr.Referer,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: refOr.Origin,
      ...cleanHeaders,
    };
    console.log(`[fetchJson] ${method} ${url}`);
    console.log(`[fetchJson] Headers:`, JSON.stringify(finalHeaders, null, 2));
    return new Promise((resolve) => {
      const request = net.request({
        method: method,
        url: url,
        headers: finalHeaders,
      });
      let body = '';
      let hasError = false;
      request.on('response', (response) => {
        console.log(`[fetchJson] Response status: ${response.statusCode}`);
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          if (hasError) return;
          const responseHeaders = {};
          if (response.headers) {
            Object.keys(response.headers).forEach(key => {
              const value = response.headers[key];
              if (Array.isArray(value)) {
                responseHeaders[key] = value.join(', ');
              } else {
                responseHeaders[key] = value;
              }
            });
          }
          const isCloudflareChallenge = 
            response.statusCode === 403 || 
            response.statusCode === 429 ||
            (response.statusCode === 200 && (
              body.includes('challenges.cloudflare.com') ||
              body.includes('cf-browser-verification') ||
              body.includes('Just a moment') ||
              body.includes('Checking your browser')
            ));
          if (isCloudflareChallenge) {
            console.warn(`[fetchJson] Cloudflare challenge detected (status ${response.statusCode})`);
            resolve({
              success: false,
              status: response.statusCode,
              statusText: response.statusMessage || 'Cloudflare Challenge',
              headers: responseHeaders,
              body: body,
              error: 'Cloudflare challenge detected. Please try again later or check your connection.',
            });
            return;
          }
          if (response.statusCode !== 200) {
            console.log(`[fetchJson] Response body (status ${response.statusCode}):`, body.substring(0, 500));
          }
          resolve({
            success: true,
            status: response.statusCode,
            statusText: response.statusMessage || '',
            headers: responseHeaders,
            body: body,
          });
        });
      });
      request.on('error', (error) => {
        console.error(`[fetchJson] Request error:`, error);
        hasError = true;
        resolve({ success: false, error: error.message });
      });
      if (options.body) {
        if (typeof options.body === 'string') {
          request.write(options.body);
        } else if (options.body instanceof ArrayBuffer) {
          request.write(Buffer.from(options.body));
        } else if (Buffer.isBuffer(options.body)) {
          request.write(options.body);
        }
      }
      request.end();
    });
  } catch (error) {
    console.error(`[fetchJson] Error:`, error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('electron:getPath', async (event, name) => {
  try {
    return app.getPath(name);
  } catch (error) {
    return null;
  }
});

ipcMain.handle('electron:getDiskSpace', async (event, basePath) => {
  try {
    const dir = basePath && typeof basePath === 'string' ? path.resolve(basePath) : path.join(app.getPath('pictures'), 'NHAppSaves');
    const { free, total } = getDiskSpaceForPath(dir);
    let documentDirSize = 0;
    let downloadedSize = 0;
    if (fs.existsSync(dir)) {
      documentDirSize = getDirectorySizeSync(dir);
      const nhAppDir = path.join(dir, 'NHAppAndroid');
      if (fs.existsSync(nhAppDir)) {
        downloadedSize = getDirectorySizeSync(nhAppDir);
      }
    }
    return {
      success: true,
      free,
      total,
      downloaded: downloadedSize,
      appStorage: documentDirSize,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('electron:openExternal', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


// Native reader: GET /api/v2/config + /api/v2/galleries/:id → same shape as legacy parseBookData
function normalizeV2MediaPathReader(path) {
  if (!path) return path;
  let p = String(path).trim();
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      u.pathname = u.pathname.replace(/\.webp\.webp$/i, '.webp');
      return u.toString();
    } catch {
      return p.replace(/\.webp\.webp$/i, '.webp');
    }
  }
  return p.replace(/\.webp\.webp$/i, '.webp');
}

function joinCdnBaseReader(base) {
  return String(base || '').replace(/\/$/, '');
}

function resolveReaderImagePath(pathStr, imageServer) {
  const p = normalizeV2MediaPathReader(pathStr);
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) {
    return p.replace(/^https?:\/\/i\.nhentai\.net(?=\/|$)/i, joinCdnBaseReader(imageServer));
  }
  return joinCdnBaseReader(imageServer) + (p.startsWith('/') ? p : '/' + p);
}

function resolveReaderThumbPath(pathStr, thumbServer) {
  const p = normalizeV2MediaPathReader(pathStr);
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) {
    return p.replace(/^https?:\/\/t\.nhentai\.net(?=\/|$)/i, joinCdnBaseReader(thumbServer));
  }
  return joinCdnBaseReader(thumbServer) + (p.startsWith('/') ? p : '/' + p);
}

function parseGalleryV2ToBook(g, imageServer, thumbServer) {
  const rawPages = Array.isArray(g.pages) ? [...g.pages] : [];
  rawPages.sort((a, b) => (a.number || 0) - (b.number || 0));
  const pages = rawPages.map((pg) => ({
    page: pg.number,
    url: resolveReaderImagePath(pg.path, imageServer),
    urlThumb: resolveReaderThumbPath(pg.thumbnail, thumbServer),
    width: pg.width ?? 0,
    height: pg.height ?? 0,
  }));
  return {
    id: Number(g.id),
    title: {
      english: g.title?.english || '',
      japanese: g.title?.japanese || '',
      pretty: g.title?.pretty || '',
    },
    uploaded: g.upload_date
      ? new Date(g.upload_date * 1000).toISOString()
      : '',
    media: parseInt(String(g.media_id), 10) || 0,
    favorites: g.num_favorites || 0,
    pagesCount: g.num_pages || pages.length,
    scanlator: g.scanlator || '',
    tags: g.tags || [],
    cover: resolveReaderThumbPath(g.cover?.path, thumbServer),
    coverW: g.cover?.width ?? 0,
    coverH: g.cover?.height ?? 0,
    thumbnail: resolveReaderThumbPath(g.thumbnail?.path, thumbServer),
    pages,
  };
}

function nhNetGetJson(url, cookieHeader) {
  const { net } = require('electron');
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Referer': 'https://nhentai.net/',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://nhentai.net',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url, headers });
    let body = '';
    request.on('response', (response) => {
      const status = response.statusCode || 0;
      if (status !== 200) {
        response.on('data', () => {});
        response.on('end', () => {
          reject(new Error(`HTTP ${status}`));
        });
        return;
      }
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

ipcMain.handle('electron:getBook', async (event, id) => {
  try {
    console.log('[getBook] Starting v2 fetch for book:', id);
    const cookieList = await session.defaultSession.cookies.get({ url: 'https://nhentai.net' });
    const cookieHeader = cookieList.map((c) => `${c.name}=${c.value}`).join('; ');

    const run = async () => {
      let imageServer = 'https://i1.nhentai.net';
      let thumbServer = 'https://t1.nhentai.net';
      try {
        const cfg = await nhNetGetJson('https://nhentai.net/api/v2/config', cookieHeader);
        if (Array.isArray(cfg.image_servers) && cfg.image_servers[0]) {
          imageServer = String(cfg.image_servers[0]).replace(/\/$/, '');
        }
        if (Array.isArray(cfg.thumb_servers) && cfg.thumb_servers[0]) {
          thumbServer = String(cfg.thumb_servers[0]).replace(/\/$/, '');
        }
      } catch (e) {
        console.warn('[getBook] v2/config failed, using default CDN:', e?.message || e);
      }
      const gid = encodeURIComponent(String(id));
      let g = await nhNetGetJson(`https://nhentai.net/api/v2/galleries/${gid}`, cookieHeader);
      if (!Array.isArray(g.pages) || g.pages.length === 0) {
        try {
          const pr = await nhNetGetJson(
            `https://nhentai.net/api/v2/galleries/${gid}/pages`,
            cookieHeader
          );
          g = { ...g, pages: pr.pages || [], num_pages: pr.num_pages || (pr.pages || []).length };
        } catch (e2) {
          console.warn('[getBook] v2 galleries/:id/pages fallback failed:', e2?.message || e2);
        }
      }
      const book = parseGalleryV2ToBook(g, imageServer, thumbServer);
      console.log('[getBook] v2 book parsed, pages:', book.pages.length);
      return book;
    };

    return await Promise.race([
      run(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), 30000);
      }),
    ]);
  } catch (error) {
    console.error('[getBook] Error:', error);
    throw error;
  }
});


function getSaveDirectory() {
  try {
    const userDataPath = app.getPath('userData');
    const settingsPath = path.join(userDataPath, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.savePath) {
        const normalized = path.normalize(settings.savePath);
        return normalized.endsWith(path.sep) ? normalized : normalized + path.sep;
      }
    }
  } catch (e) {
    console.warn('[getBookFromLocal] Failed to read settings:', e.message);
  }
  const picturesPath = app.getPath('pictures');
  return path.join(picturesPath, 'NHAppSaves') + path.sep;
}

ipcMain.handle('electron:getBookFromLocal', async (event, id) => {
  try {
    console.log('[getBookFromLocal] ========================================');
    console.log('[getBookFromLocal] Searching for book ID:', id);
    const saveDir = getSaveDirectory();
    const nhDir = path.join(saveDir, 'NHAppAndroid');
    console.log('[getBookFromLocal] Save directory:', saveDir);
    console.log('[getBookFromLocal] NHAppAndroid directory:', nhDir);
    const documentsPath = app.getPath('documents');
    const oldNhDir = path.join(documentsPath, 'NHAppAndroid');
    console.log('[getBookFromLocal] Old Documents path (fallback):', oldNhDir);
    const searchPaths = [nhDir];
    if (fs.existsSync(oldNhDir) && oldNhDir !== nhDir) {
      searchPaths.push(oldNhDir);
    }
    for (const searchDir of searchPaths) {
      if (!fs.existsSync(searchDir)) {
        console.log('[getBookFromLocal] Directory does not exist:', searchDir);
        continue;
      }
      console.log('[getBookFromLocal] Searching in:', searchDir);
      const titles = fs.readdirSync(searchDir);
      console.log('[getBookFromLocal] Found', titles.length, 'titles in directory:', searchDir);
      for (const title of titles) {
        const titleDir = path.join(searchDir, title);
        if (!fs.statSync(titleDir).isDirectory()) continue;
      const idMatch = title.match(/^(\d+)_/);
      if (idMatch && Number(idMatch[1]) !== id) continue;
      const langs = fs.readdirSync(titleDir);
      for (const lang of langs) {
        const langDir = path.join(titleDir, lang);
        if (!fs.statSync(langDir).isDirectory()) continue;
        const metaPath = path.join(langDir, 'metadata.json');
        if (!fs.existsSync(metaPath)) continue;
        try {
          const metaContent = fs.readFileSync(metaPath, 'utf8');
          const book = JSON.parse(metaContent);
          if (book.id !== id) {
            console.log(`[getBookFromLocal] Book ID mismatch: metadata has ${book.id}, searching for ${id}`);
            continue;
          }
          console.log('[getBookFromLocal] ✅ Found matching book ID:', book.id);
          console.log('[getBookFromLocal] Book title:', book.title?.pretty || 'Unknown');
          console.log('[getBookFromLocal] Language directory:', lang);
          console.log('[getBookFromLocal] Loading images from:', langDir);
          const images = fs.readdirSync(langDir)
            .filter(f => f.startsWith('Image'))
            .sort((a, b) => {
              const numA = parseInt(a.match(/\d+/)?.[0] || '0');
              const numB = parseInt(b.match(/\d+/)?.[0] || '0');
              return numA - numB;
            });
          console.log('[getBookFromLocal] Found', images.length, 'images');
          console.log('[getBookFromLocal] Metadata pages count:', (book.pages || []).length);
          if (images.length === 0) {
            console.error('[getBookFromLocal] No images found in directory!');
            continue;
          }
          const metadataPages = book.pages || [];
          const pages = new Array(images.length);
          for (let idx = 0; idx < images.length; idx++) {
            const img = images[idx];
            if (!img || !img.startsWith('Image')) {
              console.warn(`[getBookFromLocal] Skipping invalid image file: ${img}`);
              continue;
            }
            const imgPath = path.join(langDir, img);
            if (!fs.existsSync(imgPath)) {
              console.warn(`[getBookFromLocal] Image file does not exist: ${imgPath}`);
              continue;
            }
            const normalizedPath = imgPath.replace(/\\/g, '/');
            const uri = `local:///${normalizedPath}`;
            const metaPage = metadataPages[idx];
            pages[idx] = {
              page: idx + 1,
              url: uri,  
              urlThumb: uri,  
              width: metaPage?.width || 800,
              height: metaPage?.height || 1200,
            };
            if (idx === 0 || idx === 1) {
              console.log(`[getBookFromLocal] Page ${idx + 1} URI:`, uri);
              console.log(`[getBookFromLocal] Page ${idx + 1} local path:`, imgPath);
              console.log(`[getBookFromLocal] Page ${idx + 1} URL starts with local://:`, uri.startsWith('local://'));
            }
          }
          const localBook = {
            id: book.id,
            media_id: book.media_id,
            title: book.title,
            images: book.images ? {
              ...book.images,
              cover: book.images.cover ? { ...book.images.cover } : undefined,
              thumbnail: book.images.thumbnail ? { ...book.images.thumbnail } : undefined,
              pages: undefined, 
            } : undefined,
            scanlator: book.scanlator,
            upload_date: book.upload_date,
            tags: book.tags ? [...book.tags] : [],
            num_pages: pages.length,
            num_favorites: book.num_favorites,
            num_views: book.num_views,
            languages: book.languages ? [...book.languages] : [],
            pages: pages.map((page) => ({
              page: page.page,
              url: page.url, 
              urlThumb: page.urlThumb, 
              width: page.width,
              height: page.height,
            })),
            cover: pages[0]?.url || '',
            thumbnail: pages[0]?.urlThumb || pages[0]?.url || '',
          };
          const nonLocalPages = pages.filter(p => !p.url || !p.url.startsWith('local://'));
          if (nonLocalPages.length > 0) {
            console.error('[getBookFromLocal] ❌ CRITICAL: Some pages are not local:', nonLocalPages.length);
            console.error('[getBookFromLocal] This should never happen! Fixing...');
            for (let i = 0; i < pages.length; i++) {
              const page = pages[i];
              if (!page.url || !page.url.startsWith('local://')) {
                const img = images[i];
                if (img) {
                  const imgPath = path.join(langDir, img);
                  const uri = `local:///${imgPath.replace(/\\/g, '/')}`;
                  console.log(`[getBookFromLocal] Fixing page ${i + 1}: ${page.url} -> ${uri}`);
                  page.url = uri;
                  page.urlThumb = uri;
                }
              }
            }
          } else {
            console.log('[getBookFromLocal] ✅ All pages are local (offline mode)');
          }
          const finalCheck = pages.filter(p => !p.url || !p.url.startsWith('local://'));
          if (finalCheck.length > 0) {
            console.error('[getBookFromLocal] ❌ CRITICAL: After fix, still have non-local pages:', finalCheck.length);
            console.error('[getBookFromLocal] This is a serious bug!');
          } else {
            console.log('[getBookFromLocal] ✅ Final check passed: all pages are local');
          }
          console.log('[getBookFromLocal] First 3 page URLs:');
          for (let i = 0; i < Math.min(3, pages.length); i++) {
            console.log(`  Page ${i + 1}: ${pages[i].url}`);
          }
          console.log('[getBookFromLocal] Book loaded successfully, pages:', pages.length);
          if (localBook.pages && Array.isArray(localBook.pages)) {
            const finalNonLocal = localBook.pages.filter(p => !p || !p.url || !p.url.startsWith('local://'));
            if (finalNonLocal.length > 0) {
              console.error('[getBookFromLocal] ❌ CRITICAL BUG: localBook.pages contains non-local URLs!');
              console.error('[getBookFromLocal] Non-local pages count:', finalNonLocal.length);
              for (let i = 0; i < localBook.pages.length; i++) {
                if (localBook.pages[i] && images[i]) {
                  const imgPath = path.join(langDir, images[i]);
                  const uri = `local:///${imgPath.replace(/\\/g, '/')}`;
                  localBook.pages[i].url = uri;
                  localBook.pages[i].urlThumb = uri;
                }
              }
              console.log('[getBookFromLocal] Fixed all URLs in localBook.pages');
            } else {
              console.log('[getBookFromLocal] ✅ Final verification passed: localBook.pages contains only local URLs');
            }
          }
          if (localBook.pages.length > 1) {
            console.log('[getBookFromLocal] Second page URL:', localBook.pages[1].url);
            if (!localBook.pages[1].url || !localBook.pages[1].url.startsWith('local://')) {
              console.error('[getBookFromLocal] ❌ SECOND PAGE HAS NON-LOCAL URL!');
              const imgPath = path.join(langDir, images[1]);
              const uri = `local:///${imgPath.replace(/\\/g, '/')}`;
              localBook.pages[1].url = uri;
              localBook.pages[1].urlThumb = uri;
              console.log('[getBookFromLocal] Fixed second page URL:', uri);
            }
          }
          console.log('[getBookFromLocal] Returning localBook with', localBook.pages?.length || 0, 'pages');
          console.log('[getBookFromLocal] ========================================');
          return localBook;
        } catch (e) {
          console.error('[getBookFromLocal] ❌ Error processing metadata:', e.message);
          console.error('[getBookFromLocal] Error stack:', e.stack);
          console.error('[getBookFromLocal] Language:', lang);
          console.error('[getBookFromLocal] Metadata path:', metaPath);
          continue;
        }
      }
    }
  }
  console.log('[getBookFromLocal] ❌ Book not found after searching all directories');
  console.log('[getBookFromLocal] Searched ID:', id);
  console.log('[getBookFromLocal] Searched directories:', searchPaths.length);
  for (const searchPath of searchPaths) {
    console.log('[getBookFromLocal]  -', searchPath, fs.existsSync(searchPath) ? '(exists)' : '(not found)');
  }
  return null;
  } catch (error) {
    console.error('[getBookFromLocal] Error:', error);
    return null;
  }
});


function parseBookData(item) {
  const media = item.media_id;
  const extByToken = (t) => {
    switch (t) {
      case 'J': return 'jpg.webp';
      case 'j': return 'jpg';
      case 'P': return 'png.webp';
      case 'p': return 'png';
      case 'W': return 'webp.webp';
      case 'w': return 'webp';
      case 'G': return 'gif.webp';
      case 'g': return 'gif';
      default: return 'jpg';
    }
  };
  const pickHost = (mediaId, pageNum) => {
    const hosts = ['i1', 'i2', 'i3', 'i4'];
    return hosts[(mediaId + pageNum) % hosts.length];
  };
  const coverExt = extByToken(item.images.cover?.t || 'j');
  const thumbExt = extByToken(item.images.thumbnail?.t || 'j');
  const coverBase = `https://t3.nhentai.net/galleries/${media}/cover`;
  const thumbBase = `https://t3.nhentai.net/galleries/${media}/thumb`;
  const numPages = item.num_pages || 0;
  const pages = new Array(numPages);
  for (let i = 0; i < numPages; i++) {
    const pageNum = i + 1;
    const img = item.images.pages[i] || {};
    const pageExt = extByToken(img.t || 'j');
    const host = pickHost(media, pageNum);
    const pageBase = `https://${host}.nhentai.net/galleries/${media}/${pageNum}`;
    const pageBaseThumb = `https://t1.nhentai.net/galleries/${media}/${pageNum}t`;
    pages[i] = {
      page: pageNum,
      url: `${pageBase}.${pageExt}`,
      urlThumb: `${pageBaseThumb}.${pageExt}`,
      width: img.w ?? 0,
      height: img.h ?? 0,
    };
  }
  return {
    id: Number(item.id),
    title: {
      english: item.title.english || '',
      japanese: item.title.japanese || '',
      pretty: item.title.pretty || '',
    },
    uploaded: item.upload_date
      ? new Date(item.upload_date * 1000).toISOString()
      : '',
    media,
    favorites: item.num_favorites || 0,
    pagesCount: item.num_pages || 0,
    scanlator: item.scanlator || '',
    tags: item.tags || [],
    cover: `${coverBase}.${coverExt}`,
    coverW: item.images.cover?.w ?? 0,
    coverH: item.images.cover?.h ?? 0,
    thumbnail: `${thumbBase}.${thumbExt}`,
    pages,
  };
}

ipcMain.handle('electron:minimize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.minimize();
});

ipcMain.handle('electron:maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});

ipcMain.handle('electron:close', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.close();
});

ipcMain.handle('electron:isMaximized', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window ? window.isMaximized() : false;
});





// ─── Captcha: скрытое окно nhentai.net → auto-pass Turnstile ──────────────────
//
// 1. Пользователь нажимает кнопку-виджет (ElectronCaptchaButton)
// 2. Открывается СКРЫТЫЙ BrowserWindow с nhentai.net/login/ + persist:cloudflare
//    (там уже есть cf_clearance — Turnstile в managed-mode проходит без кликов)
// 3. Тело страницы скрыто через CSS; Turnstile-iframe всё равно запускается
// 4. Полим cf-turnstile-response каждые 400ms
// 5а. Нашли за <autoShowMs>: закрыли окно → вернули токен → успех без UI
// 5б. Не нашли за <autoShowMs>: показываем окно для ручного клика пользователя

let nhCaptchaHtml = null; // сохраняем HTML для protocol.handle (legacy)

const NH_CAPTCHA_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

// IPC: renderer может по-прежнему пушить HTML (используется mobil-like webview)
ipcMain.handle('nh:set-captcha-html', (_event, html) => {
  if (typeof html === 'string') nhCaptchaHtml = html;
  return true;
});

// Показываем ТОЛЬКО .captcha-container, всё остальное прячем.
// Применяется ПОСЛЕ did-finish-load, перед win.show() — пользователь никогда не видит белую страницу.
const CAPTCHA_WIDGET_CSS = [
  'html,body{background:#0d0d0d!important;margin:0!important;padding:0!important;overflow:hidden!important}',
  '*{visibility:hidden!important}',
  '.captcha-container,.captcha-container *{visibility:visible!important}',
  '.captcha-container{position:fixed!important;top:50%!important;left:50%!important;',
  'transform:translate(-50%,-50%)!important;z-index:99999!important}',
].join('');

const CAPTCHA_READ_JS = `(function(){
  var a=document.querySelector('textarea[name="cf-turnstile-response"]');
  if(a&&a.value)return a.value;
  var b=document.querySelector('input[name="cf-turnstile-response"]');
  return b&&b.value?b.value:'';
})()`;

let captchaWin = null;

ipcMain.handle('electron:getCaptchaToken', async (_event, options) => {
  const totalMs = (options && options.timeout) ? options.timeout : 180_000;

  // Если уже есть живое окно — фокусируем его
  if (captchaWin && !captchaWin.isDestroyed()) {
    captchaWin.show();
    captchaWin.focus();
  }

  return new Promise((resolve) => {
    let done = false;
    let poll = null;
    let totalTimer = null;

    const finish = (token) => {
      if (done) return;
      done = true;
      if (poll)       { clearInterval(poll);   poll = null; }
      if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
      if (captchaWin && !captchaWin.isDestroyed()) captchaWin.close();
      captchaWin = null;
      resolve(token);
    };

    captchaWin = new BrowserWindow({
      width: 320,
      height: 82,
      show: false,          // скрыто ДО применения CSS — нет вспышки белого экрана
      frame: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      title: 'Verify — nhentai',
      backgroundColor: '#0d0d0d', // фон до загрузки страницы
      parent: mainWindow || undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:cloudflare',
        webviewTag: false,
      },
    });

    captchaWin.setMenuBarVisibility(false);
    captchaWin.loadURL('https://nhentai.net/login/?next=/');

    captchaWin.webContents.on('did-finish-load', () => {
      if (done || !captchaWin || captchaWin.isDestroyed()) return;
      const url = captchaWin.webContents.getURL();
      if (!url.includes('nhentai.net')) return;

      // Применяем CSS синхронно (promise), ждём применения, затем показываем окно
      captchaWin.webContents.insertCSS(CAPTCHA_WIDGET_CSS)
        .then(() => new Promise(r => setTimeout(r, 80))) // 80ms — браузер применяет CSS
        .then(() => {
          if (done || !captchaWin || captchaWin.isDestroyed()) return;
          captchaWin.center();
          captchaWin.show();
          captchaWin.focus();
        })
        .catch(() => {});

      // Полим токен
      if (poll) clearInterval(poll);
      poll = setInterval(async () => {
        if (done || !captchaWin || captchaWin.isDestroyed()) { clearInterval(poll); return; }
        try {
          const tok = await captchaWin.webContents.executeJavaScript(CAPTCHA_READ_JS);
          if (typeof tok === 'string' && tok.length > 20) {
            clearInterval(poll); poll = null;
            finish(tok);
          }
        } catch {}
      }, 400);
    });

    totalTimer = setTimeout(() => finish(null), totalMs);

    captchaWin.on('closed', () => {
      captchaWin = null;
      finish(null);
    });
  });
});

// ─── Protocol helper для webview-fallback (не используется на десктопе) ────────
function registerCaptchaProtocol() {
  try {
    const { net } = require('electron');
    const NH_PARTITION = 'persist:nh-captcha';
    const NH_URL       = 'https://nhentai.net/__captcha__';
    const ses = session.fromPartition(NH_PARTITION);

    ses.setUserAgent(NH_CAPTCHA_UA);

    const guestPreload = path.join(__dirname, 'captcha-guest-preload.js');
    try { ses.setPreloads([guestPreload]); } catch {}

    session.defaultSession.cookies.get({ url: 'https://nhentai.net' }).then((cookies) => {
      for (const c of cookies) ses.cookies.set({ url: 'https://nhentai.net', ...c }).catch(() => {});
    }).catch(() => {});

    ses.protocol.handle('https', async (req) => {
      const u = req.url.split('?')[0].split('#')[0];
      if (u === NH_URL) {
        const body = nhCaptchaHtml || '<!DOCTYPE html><html><body></body></html>';
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      return net.fetch(req, { bypassCustomProtocolHandlers: true });
    });
  } catch (e) {
    console.error('[nh-captcha] registerCaptchaProtocol:', e?.message || e);
  }
}

app.whenReady().then(() => {
  registerProtocols();
  registerCaptchaProtocol();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (devServerProcess) devServerProcess.kill();
});
