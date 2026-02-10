import { parseGeoSite } from './geosite-parser.js';
const DEFAULT_PROXY_CONFIG = import.meta.env.VITE_PROXY_CONFIG;
const GEOSITE_FILE = 'geosite.dat';
const GEOSITE_URL = 'https://raw.githubusercontent.com/runetfreedom/russia-v2ray-rules-dat/release/geosite.dat';
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
            console.error('[GeoSite] Failed to load bundled file');
        }
    } catch (e) {
        console.error('[GeoSite] Error loading bundled file:', e);
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

        const response = await fetch(GEOSITE_URL, { headers, cache: 'no-cache' });

        if (response.status === 304) {
            console.log('[GeoSite] File not modified (304), skipping update');
            return;
        }

        if (response.ok) {
            const buffer = await response.arrayBuffer();
            await parseAndSaveDomains(buffer);

            // Save ETag for next check
            const newEtag = response.headers.get('ETag');
            if (newEtag) {
                await chrome.storage.local.set({ geositeEtag: newEtag });
            }

            // Save timestamp of last successful update
            await chrome.storage.local.set({ geositeLastUpdate: Date.now() });

            console.log('[GeoSite] Updated from remote, new ETag:', newEtag);
        } else {
            console.warn('[GeoSite] Remote fetch failed, status:', response.status);
        }
    } catch (e) {
        console.error('[GeoSite] Update check failed:', e);
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

    const pacScript = `
    function FindProxyForURL(url, host) {
      const sites = ${JSON.stringify(allSites)};
      for (const site of sites) {
        if (dnsDomainIs(host, site) || host.endsWith('.' + site)) {
          return "PROXY ${config.host}:${config.port}";
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
