import { parseGeoSite } from './geosite-parser.js';
const DEFAULT_PROXY_CONFIG = import.meta.env.VITE_PROXY_CONFIG;
const GEOSITE_FILE = 'geosite.dat';
const GEOSITE_URLS = [
    'https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/geosite.dat',
    'https://ghfast.top/https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/geosite.dat',
    'https://raw.githubusercontents.com/runetfreedom/russia-v2ray-rules-dat/release/geosite.dat'
];
const UPDATE_ALARM_NAME = 'geosite-update';
const UPDATE_INTERVAL_HOURS = 6;

// Categories to extract from geosite.dat
const TARGET_CATEGORIES = [
    'MICROSOFT', 'OPENAI', 'YOUTUBE', 'GOOGLE', 'TELEGRAM',
    'TWITTER', 'FACEBOOK', 'INSTAGRAM', 'LINKEDIN',
    'TIKTOK', 'NETFLIX', 'SPOTIFY', 'APPLE', 'AMAZON',
    'CATEGORY-VPN', 'CATEGORY-PROXY',
    'RU-BLOCKED', 'RU' // Inspect 'RU' carefully, might be domestic sites. 'RU-BLOCKED' is definitely blocked.
];

/**
 * Parse geosite.dat buffer and save domains to storage.
 */
async function parseAndSaveDomains(buffer) {
    // Basic validation: ensure buffer is not empty and has a reasonable minimum size (e.g., 1KB for geosite.dat)
    if (!buffer || buffer.byteLength < 1024) {
        console.error('[GeoSite] Validation failed: buffer is too small or empty');
        return [];
    }
    const parsedSites = parseGeoSite(new Uint8Array(buffer), TARGET_CATEGORIES);
    const allSites = [...new Set(parsedSites)];
    console.log(`[GeoSite] Parsed ${allSites.length} unique domains`);
    await chrome.storage.local.set({ geoSites: allSites, geoReady: true });
    return allSites;
}

/**
 * Load bundled geosite.dat from extension package (fallback).
 */
async function loadBundledGeosite() {
    try {
        const response = await fetch(chrome.runtime.getURL(GEOSITE_FILE));
        if (response.ok) {
            const buffer = await response.arrayBuffer();
            await parseAndSaveDomains(buffer);
            console.log('[GeoSite] Loaded bundled geosite.dat');
        } else {
            console.log('[GeoSite] Bundled file not found, will download from remote');
        }
    } catch (e) {
        console.log('[GeoSite] No bundled file available:', e.message);
    }
}

/**
 * Check for geosite.dat updates using ETag (If-None-Match).
 * Downloads only if the file has changed since last check.
 */
async function checkAndUpdateGeosite() {
    try {
        const { geositeEtag } = await chrome.storage.local.get('geositeEtag');

        const headers = {};
        if (geositeEtag) {
            headers['If-None-Match'] = geositeEtag;
        }

        let response = null;
        let success = false;

        for (const url of GEOSITE_URLS) {
            try {
                // Добавляем таймаут 2 минуты (120000 мс) на каждый запрос, т.к. файл весит 61 МБ
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 120000);

                response = await fetch(url, { headers, cache: 'no-cache', signal: controller.signal });
                clearTimeout(timeoutId);

                if (response.status === 304) {
                    console.log('[GeoSite] File not modified (304), skipping update');
                    return;
                }

                if (response.ok) {
                    success = true;
                    console.log(`[GeoSite] Successfully fetched from: ${url}`);
                    break;
                } else {
                    console.warn(`[GeoSite] Bad status from ${url}:`, response.status);
                }
            } catch (err) {
                console.warn(`[GeoSite] Failed to fetch from ${url}:`, err.message);
            }
        }

        if (success && response) {
            // Читаем как поток (stream), чтобы понимать прогресс загрузки
            const contentLength = response.headers.get('Content-Length');
            const totalBytes = contentLength ? parseInt(contentLength, 10) : 60000000; // Примерно 60МБ, если нет заголовка

            const reader = response.body.getReader();
            let receivedBytes = 0;
            const chunks = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                chunks.push(value);
                receivedBytes += value.byteLength;

                const percent = Math.round((receivedBytes / totalBytes) * 100);

                // Обновляем прогресс в хранилище (не чаще раза в секунду, но достаточно часто)
                await chrome.storage.local.set({
                    downloadProgress: {
                        status: 'downloading',
                        percent: percent > 100 ? 100 : percent,
                        downloadedMb: (receivedBytes / 1024 / 1024).toFixed(1),
                        totalMb: (totalBytes / 1024 / 1024).toFixed(1)
                    }
                });
            }

            // Объединяем чанки в один ArrayBuffer
            const totalBuffer = new Uint8Array(receivedBytes);
            let position = 0;
            for (const chunk of chunks) {
                totalBuffer.set(chunk, position);
                position += chunk.byteLength;
            }

            await parseAndSaveDomains(totalBuffer.buffer);

            // Save ETag for next check
            const newEtag = response.headers.get('ETag');
            if (newEtag) {
                await chrome.storage.local.set({ geositeEtag: newEtag });
            }

            // Save timestamp of last successful update
            await chrome.storage.local.set({ geositeLastUpdate: Date.now() });

            console.log('[GeoSite] Updated from remote, new ETag:', newEtag);
            await chrome.storage.local.set({ downloadProgress: null }); // Очищаем статус успешной загрузки
        } else {
            console.warn('[GeoSite] All remote fetch attempts failed');
            await chrome.storage.local.set({ downloadProgress: { status: 'error' } });
        }
    } catch (e) {
        console.error('[GeoSite] Update check failed:', e);
        await chrome.storage.local.set({ downloadProgress: { status: 'error' } });
    }
}

/**
 * Ensure periodic alarm is set for geosite updates.
 */
async function ensureUpdateAlarm() {
    const existing = await chrome.alarms.get(UPDATE_ALARM_NAME);
    if (!existing) {
        chrome.alarms.create(UPDATE_ALARM_NAME, {
            delayInMinutes: 1, // first check 1 min after startup
            periodInMinutes: UPDATE_INTERVAL_HOURS * 60 // then every 6 hours
        });
        console.log(`[GeoSite] Alarm set: every ${UPDATE_INTERVAL_HOURS}h`);
    }
}

// --- Extension lifecycle ---

chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === "update") {
        chrome.storage.local.get(['proxyConfig'], (result) => {
            if (result.proxyConfig === DEFAULT_PROXY_CONFIG) {
                chrome.storage.local.remove('proxyConfig');
            }
        });
    }

    // Load bundled geosite.dat as immediate fallback
    await loadBundledGeosite();

    chrome.storage.local.set({ isEnabled: false });

    // Set up periodic update alarm
    await ensureUpdateAlarm();

    // Immediately try to fetch fresh version from remote
    checkAndUpdateGeosite();
});

// On service worker startup (browser restart, wake-up), ensure alarm exists
chrome.runtime.onStartup.addListener(async () => {
    await ensureUpdateAlarm();
});

// Handle periodic alarm
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_ALARM_NAME) {
        console.log('[GeoSite] Alarm fired, checking for updates...');
        checkAndUpdateGeosite();
    }
});

// --- Proxy logic (unchanged) ---

function parseProxyConfig(configString) {
    if (!configString) return null;
    const parts = configString.split(':');
    if (parts.length < 2) return null;
    return {
        host: parts[0],
        port: parts[1],
        user: parts[2] || '',
        pass: parts[3] || ''
    };
}

async function updateProxy() {
    const { isEnabled, geoSites, proxyConfig } = await chrome.storage.local.get(['isEnabled', 'geoSites', 'proxyConfig']);
    const { sites } = await chrome.storage.sync.get(['sites']);
    const config = parseProxyConfig(proxyConfig || DEFAULT_PROXY_CONFIG);
    const allSites = [...(geoSites || []), ...(sites || [])];

    if (!isEnabled || !allSites.length || !config) {
        chrome.proxy.settings.clear({ scope: 'regular' });
        return;
    }

    // Sanitize host and port to prevent PAC script injection
    const safeHost = config.host.replace(/[^a-zA-Z0-9\.-]/g, '');
    const safePort = config.port.replace(/[^0-9]/g, '');

    const pacScript = `
    function FindProxyForURL(url, host) {
      const sites = ${JSON.stringify(allSites)};
      for (const site of sites) {
        if (dnsDomainIs(host, site) || host.endsWith('.' + site)) {
          return "PROXY ${safeHost}:${safePort}";
        }
      }
      return "DIRECT";
    }
  `;

    const proxySettings = {
        mode: "pac_script",
        pacScript: {
            data: pacScript
        }
    };

    chrome.proxy.settings.set({ value: proxySettings, scope: 'regular' });
}

let cachedConfig = null;

async function refreshCachedConfig() {
    const { proxyConfig } = await chrome.storage.local.get(['proxyConfig']);
    cachedConfig = parseProxyConfig(proxyConfig || DEFAULT_PROXY_CONFIG);
}

// Первоначальный запуск и обновление кеша при изменениях
refreshCachedConfig();

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.sites) {
        updateProxy();
    }
    if (area === 'local') {
        if (changes.isEnabled || changes.geoSites || changes.proxyConfig) {
            if (changes.proxyConfig) {
                cachedConfig = parseProxyConfig(changes.proxyConfig.newValue || DEFAULT_PROXY_CONFIG);
            }
            updateProxy();
        }
    }
});

chrome.webRequest.onAuthRequired.addListener(
    (details) => {
        if (details.isProxy && cachedConfig && cachedConfig.user && cachedConfig.pass) {
            return {
                authCredentials: {
                    username: cachedConfig.user,
                    password: cachedConfig.pass
                }
            };
        }
    },
    { urls: ["<all_urls>"] },
    ["blocking"]
);

// Initialize on startup
updateProxy();
