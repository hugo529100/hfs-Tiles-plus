'use strict'; {

    // 原名 Short-plus，現更名為 Tiles-plus。
    // localStorage key 仍是 'short-folder-tile-mode'，讓舊的每資料夾記憶無痛沿用。

    // HFS 只會把標記 frontend: true 的設定透過 HFS.getPluginConfig() 傳給前端。
    // 必須在 script 最上層同步呼叫（HFS 靠 currentScript 判斷是哪個外掛）。
    function readPluginConfig() {
        if (typeof HFS === 'undefined') return {};
        try {
            if (typeof HFS.getPluginConfig === 'function') {
                const cfg = HFS.getPluginConfig();
                if (cfg && typeof cfg === 'object') return cfg;
            }
        } catch (e) {}
        return (HFS.pluginConfig && typeof HFS.pluginConfig === 'object') ? HFS.pluginConfig : {};
    }

    const config = readPluginConfig();

    const ENABLE_ENHANCED_SORTING = config.enableEnhancedSorting !== false;
    const ENABLE_TILE_MODE_MEMORY = config.enableTileModeMemory !== false;

    // ==================== Tile size memory ====================
    // 這裡是 tile 尺寸記憶系統的唯一擁有者（由 Hotkey 搬過來合併）：
    //   - 每個資料夾記住一個尺寸（localStorage）
    //   - 過期清理
    //   - 預設尺寸：直接採用 HFS config.yaml 的 tile_size
    //   - 套用尺寸並同步 #option-tile-size 控制項
    // 鍵盤快捷鍵仍留在 Hotkey，透過 HFS.short.tile.setSize() 呼叫這裡。

    const TILE_MIN = 0;
    const TILE_MAX = 10;
    const TILE_LAST_RESORT_DEFAULT = 2;

    function clampTileSize(value, fallback) {
        // null / undefined / '' / true-false 都不是合法尺寸（0 是合法的清單模式）。
        if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
            return fallback;
        }
        const n = Number(value);
        if (!isFinite(n)) return fallback;
        return Math.max(TILE_MIN, Math.min(TILE_MAX, Math.round(n)));
    }

    // 未設定時沿用舊行為：24 小時。
    const RAW_EXPIRE_HOURS = config.expireHours;
    const EXPIRE_HOURS = (RAW_EXPIRE_HOURS === undefined || RAW_EXPIRE_HOURS === null || RAW_EXPIRE_HOURS === '')
        ? 24
        : Number(RAW_EXPIRE_HOURS);
    const EXPIRE = !isFinite(EXPIRE_HOURS) || EXPIRE_HOURS <= 0
        ? Infinity
        : EXPIRE_HOURS * 60 * 60 * 1000;

    // HFS 開機資料的 tile_size 就是 config.yaml 的 tile_size（0..10）。
    // 這是唯一的預設來源；只有它不存在時才退回 state，最後才用 2。
    function readHfsDefaultTileSize() {
        if (typeof HFS === 'undefined') return undefined;
        const fromBoot = clampTileSize(HFS.tile_size, undefined);
        if (fromBoot !== undefined) return fromBoot;
        return HFS.state ? clampTileSize(HFS.state.tile_size, undefined) : undefined;
    }
    const HFS_DEFAULT_TILE_SIZE = readHfsDefaultTileSize();

    const TILE_STORAGE_KEY = 'short-folder-tile-mode';
    const TILE_STORAGE_VERSION = 2;

    let tileChanging = false;
    let currentTileUri = '';
    let saveTimeout = null;
    let lastSavedTileSize = undefined;
    let isNavigating = false;
    let tileStore = null;

    // ---------- 儲存層（v2，向後相容 v1） ----------
    function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function normalizeTileEntry(raw) {
        if (!isPlainObject(raw)) return null;
        const size = clampTileSize(raw.size, undefined);
        if (size === undefined) return null;
        const time = Number(raw.time);
        return {
            size: size,
            time: isFinite(time) && time > 0 ? time : Date.now(),
        };
    }

    function readTileStore() {
        if (tileStore) return tileStore;

        let parsed = null;
        try {
            const raw = localStorage.getItem(TILE_STORAGE_KEY);
            if (raw) parsed = JSON.parse(raw);
        } catch (e) {
            parsed = null;
        }

        const entries = {};
        if (isPlainObject(parsed)) {
            // v2: { v: 2, entries: { '/path/': { size, time } } }
            // v1: { '/path/': { size, time } }
            const source = (parsed.v === TILE_STORAGE_VERSION && isPlainObject(parsed.entries))
                ? parsed.entries
                : parsed;

            for (const key of Object.keys(source)) {
                // 只接受正規化後的資料夾路徑，順手丟掉壞資料。
                if (typeof key !== 'string' || key.charAt(0) !== '/') continue;
                const entry = normalizeTileEntry(source[key]);
                if (entry) entries[key] = entry;
            }
        }

        tileStore = { v: TILE_STORAGE_VERSION, entries: entries };
        return tileStore;
    }

    function writeTileStore() {
        if (!tileStore) return;
        try {
            localStorage.setItem(TILE_STORAGE_KEY, JSON.stringify(tileStore));
        } catch (e) {
            // 配額爆掉或儲存被停用：這次瀏覽階段仍用記憶體中的副本。
        }
    }

    function wipeTileStore() {
        tileStore = { v: TILE_STORAGE_VERSION, entries: {} };
        try {
            localStorage.removeItem(TILE_STORAGE_KEY);
        } catch (e) {}
    }

    // ---------- 路徑正規化 ----------
    function getTileModeKey(path) {
        if (!path) return '/';

        let raw = String(path);
        let decoded = false;

        // 完整 URL：只留 path + query。
        try {
            if (/^https?:\/\//i.test(raw)) {
                const u = new URL(raw);
                raw = u.pathname + u.search;
            }
        } catch (e) {}

        // API 形式：/~/api/get_file_list?uri=%2FPictures%2F
        // 優先取出 uri 參數（URLSearchParams 已解碼一次）。
        try {
            const qIndex = raw.indexOf('?');
            if (qIndex !== -1) {
                const params = new URLSearchParams(raw.slice(qIndex + 1));
                const uriParam = params.get('uri');
                if (uriParam) {
                    raw = uriParam;
                    decoded = true;
                } else {
                    raw = raw.slice(0, qIndex);
                }
            }
        } catch (e) {
            raw = raw.split('?')[0];
        }

        // 去掉 hash（查詢字串已在上面處理）。
        const hashIndex = raw.indexOf('#');
        if (hashIndex !== -1) raw = raw.slice(0, hashIndex);

        // 路徑形式可能仍是百分比編碼；只解一次，避免 %25 被重複解碼。
        if (!decoded) {
            try {
                raw = decodeURIComponent(raw);
            } catch (e) {}
        }

        if (!raw.startsWith('/')) raw = '/' + raw;
        if (!raw.endsWith('/')) raw = raw + '/';

        // 收斂重複斜線。
        raw = raw.replace(/\/+/g, '/');

        return raw;
    }

    // ---------- 尺寸狀態 ----------
    function getTileSizeFromState() {
        if (typeof HFS !== 'undefined' && HFS.state && HFS.state.tile_size !== undefined) {
            return HFS.state.tile_size;
        }
        return undefined;
    }

    function setTileSize(value) {
        if (typeof HFS !== 'undefined' && HFS.state) {
            tileChanging = true;
            try {
                HFS.state.tile_size = value;
            } finally {
                tileChanging = false;
            }
        }
    }

    function applyTileSizeToDOM(size) {
        try {
            const listWrapper = document.querySelector('.list-wrapper');
            if (listWrapper) {
                listWrapper.style.setProperty('--tile-size', size);
            }
        } catch (e) {}
    }

    function syncTileSizeControl(size) {
        try {
            const panel = document.getElementById('option-tile-size');
            if (!panel) return;

            const range = panel.querySelector('input[type="range"]');
            if (range && String(range.value) !== String(size)) {
                range.value = String(size);
            }

            const nodes = panel.querySelectorAll('div, span, label');
            for (const el of nodes) {
                if (!/tiles?\s*mode/i.test((el.textContent || '').trim())) continue;
                // 只改純文字標籤，避免把別人的子元素（圖示、數字 span）洗掉。
                if (el.children && el.children.length) continue;
                el.textContent = 'Tiles mode: ' + size;
                break;
            }
        } catch (e) {}
    }

    function getServerDefaultTileSize() {
        if (!ENABLE_TILE_MODE_MEMORY) return undefined;
        // 預設尺寸就是 HFS config.yaml 的 tile_size；沒有才退回 2。
        return HFS_DEFAULT_TILE_SIZE !== undefined
            ? HFS_DEFAULT_TILE_SIZE
            : TILE_LAST_RESORT_DEFAULT;
    }

    function applyTileSize(size) {
        const clamped = clampTileSize(size, undefined);
        if (clamped === undefined) return undefined;

        if (getTileSizeFromState() !== clamped) {
            setTileSize(clamped);
        }
        applyTileSizeToDOM(clamped);
        syncTileSizeControl(clamped);
        return clamped;
    }

    // ---------- 過期清理 ----------
    function isTileEntryExpired(entry, now) {
        if (EXPIRE === Infinity) return false;
        return (now - entry.time) > EXPIRE;
    }

    function cleanExpiredTileData() {
        if (EXPIRE === Infinity) return 0;

        const entries = readTileStore().entries;
        const now = Date.now();
        let removed = 0;

        for (const key of Object.keys(entries)) {
            if (isTileEntryExpired(entries[key], now)) {
                delete entries[key];
                removed++;
            }
        }

        if (removed) writeTileStore();
        return removed;
    }

    // ---------- 存 / 讀某個資料夾 ----------
    function saveTileModeForPath(path, size) {
        if (!ENABLE_TILE_MODE_MEMORY) return;
        if (typeof HFS === 'undefined' || !HFS.state) return;

        const value = clampTileSize(size !== undefined ? size : getTileSizeFromState(), undefined);
        if (value === undefined) return;

        const key = getTileModeKey(path);
        const entries = readTileStore().entries;
        const existing = entries[key];
        const defaultSize = getServerDefaultTileSize();

        // 沒有舊記錄、而且值就等於預設值 → 不需要寫入。
        // （沒記錄時本來就會套用預設值，避免把每個瀏覽過的資料夾都塞進儲存區。）
        if (!existing && value === defaultSize) {
            lastSavedTileSize = value;
            return;
        }

        entries[key] = { size: value, time: Date.now() };
        writeTileStore();
        lastSavedTileSize = value;
    }

    function scheduleSave(delay) {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(function() {
            saveTimeout = null;
            if (!currentTileUri) return;

            const currentSize = getTileSizeFromState();
            if (currentSize === undefined) return;
            if (currentSize === lastSavedTileSize) return;

            saveTileModeForPath(currentTileUri, currentSize);
        }, delay || 300);
    }

    function immediateSave() {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
        }
        if (!currentTileUri) return;

        const currentSize = getTileSizeFromState();
        if (currentSize === undefined) return;
        if (currentSize === lastSavedTileSize) return;

        saveTileModeForPath(currentTileUri, currentSize);
    }

    function loadTileModeForPath(path) {
        if (!ENABLE_TILE_MODE_MEMORY) return;
        if (typeof HFS === 'undefined' || !HFS.state) return;

        cleanExpiredTileData();

        const key = getTileModeKey(path);
        const entries = readTileStore().entries;
        const saved = entries[key];
        const defaultSize = getServerDefaultTileSize();

        if (saved) {
            // 有記錄：套用並刷新時間戳（常用資料夾不會過期）。
            saved.time = Date.now();
            writeTileStore();
            applyTileSize(saved.size);
            lastSavedTileSize = saved.size;
            return;
        }

        applyTileSize(defaultSize);
        lastSavedTileSize = defaultSize;
    }

    function forgetTileModeForPath(path) {
        const key = getTileModeKey(path || currentTileUri || location.pathname);
        const entries = readTileStore().entries;
        if (!entries[key]) return false;
        delete entries[key];
        writeTileStore();
        return true;
    }

    // ---------- 初始化記憶模組 ----------
    function initTileModeModule() {
        if (!ENABLE_TILE_MODE_MEMORY) return;
        if (typeof HFS === 'undefined' || typeof HFS.watchState !== 'function') return;

        readTileStore();
        cleanExpiredTileData();

        setTimeout(function() {
            if (typeof HFS === 'undefined' || !HFS.state) return;

            const currentUri = HFS.state.uri || location.pathname;
            if (!currentUri) return;

            currentTileUri = getTileModeKey(currentUri);
            loadTileModeForPath(currentUri);

            const currentSize = getTileSizeFromState();
            if (currentSize !== undefined) lastSavedTileSize = currentSize;
        }, 100);

        HFS.watchState('uri', function(uri) {
            if (!uri) return;

            const newKey = getTileModeKey(uri);
            if (currentTileUri === newKey) return;

            isNavigating = true;

            // 先存舊資料夾，再載入新資料夾。
            immediateSave();
            currentTileUri = newKey;
            loadTileModeForPath(uri);

            const currentSize = getTileSizeFromState();
            if (currentSize !== undefined) lastSavedTileSize = currentSize;

            setTimeout(function() {
                isNavigating = false;
            }, 300);
        });

        HFS.watchState('tile_size', function(value) {
            if (tileChanging) return;
            if (!currentTileUri || isNavigating) return;

            const size = clampTileSize(value, undefined);
            if (size === undefined) return;

            // 原生滑桿 / 其他外掛改動了尺寸：同步 UI 並排程寫入。
            applyTileSizeToDOM(size);
            syncTileSizeControl(size);

            if (size !== lastSavedTileSize) scheduleSave();
        });

        // 關頁 / 切到背景（手機）前落地，避免最後一次調整消失。
        window.addEventListener('beforeunload', immediateSave);
        window.addEventListener('pagehide', immediateSave);
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'hidden') immediateSave();
        });
    }


    const style = document.createElement('style')
    style.textContent = `
        .time-faint {
            color: var(--faint-contrast);
        }

        body.sort-reason-active .list-wrapper.tiles-mode .entry-panel {
            flex-wrap: wrap;
        }

        body.sort-reason-active .list-wrapper.tiles-mode .entry-panel .entry-details {
            flex: 1 1 100%;
            min-width: 0;
        }


    `
    document.head.appendChild(style)

    const { state, watchState, onEvent, misc, elementToEntry } = HFS

    let currentSort = state.sort_by || 'name'
    let queued = false
    let retryTimer = 0
    let fileData = null
    let isListMode = false
    let lastMode = null

    function setPluginActive(active) {
        document.body.classList.toggle('sort-reason-active', active)
    }

    function checkMode() {
        const listWrapper = document.querySelector('.list-wrapper')
        if (listWrapper) {
            if (listWrapper.classList.contains('list-mode')) {
                isListMode = true
            } else if (listWrapper.classList.contains('tiles-mode')) {
                isListMode = false
            } else {
                isListMode = !listWrapper.classList.contains('tiles-mode')
            }
        }
        return isListMode
    }

    function checkModeChange() {
        const currentMode = checkMode()
        if (lastMode !== null && currentMode !== lastMode) {
            fileData = null
            reloadFileData()
        }
        lastMode = currentMode
        return currentMode
    }

    function reloadFileData() {
        fileData = null
        if (typeof HFS.reloadList === 'function') {
            HFS.reloadList()
        }
        setTimeout(() => {
            fileData = getFileData()
            updateAll()
        }, 100)
    }

    watchState('sort_by', value => {
        currentSort = value || 'name'
        reloadFileData()
        refresh(true)
    }, true)

    watchState('uri', () => {
        fileData = null
        lastMode = null
        refresh(true)
    })

    onEvent('newListEntries', () => {
        fileData = null
        lastMode = null
        refresh(true)
    })

    const observer = new MutationObserver(mutations => {
        let needRefresh = false
        for (const mutation of mutations) {
            if (mutation.type !== 'childList' && mutation.type !== 'attributes') continue
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue
                if (
                    node.matches?.('.file, .folder, .entry-details, .entry-size, .entry-ts') ||
                    node.querySelector?.('.file, .folder, .entry-details, .entry-size, .entry-ts') ||
                    node.matches?.('.list-wrapper')
                ) {
                    needRefresh = true
                    break
                }
            }
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                const target = mutation.target
                if (target && target.matches && target.matches('.list-wrapper')) {
                    needRefresh = true
                    break
                }
            }
        }
        if (needRefresh) {
            fileData = null
            refresh(false)
        }
    })

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
    })

    function refresh(retry) {
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
            queued = false
            checkModeChange()
            updateAll()
            if (retry) {
                clearTimeout(retryTimer)
                retryTimer = setTimeout(() => {
                    updateAll()
                    setTimeout(updateAll, 80)
                    setTimeout(updateAll, 200)
                }, 0)
            }
        })
    }

    function getFileData() {
        try {
            let list = null

            if (HFS.state && HFS.state.list) {
                list = HFS.state.list
            }

            if (!list && typeof HFS.getFileList === 'function') {
                list = HFS.getFileList()
            }

            if (!list && typeof HFS.apiCall === 'function') {
                try {
                    const result = HFS.apiCall('get_file_list', { uri: state.uri || '/' })
                    if (result && result.list) {
                        list = result.list
                    }
                } catch (e) {}
            }

            if (!list) {
                const items = document.querySelectorAll('.file, .folder')
                list = []
                for (const li of items) {
                    try {
                        const entry = elementToEntry(li)
                        if (entry) {
                            list.push(entry)
                        }
                    } catch (e) {}
                }
            }

            if (list && list.length > 0) {
                return list
            }
        } catch (e) {}
        return null
    }

    function findEntry(name, isFolder) {
        if (!fileData) {
            fileData = getFileData()
        }
        if (!fileData) return null

        let searchName = name
        if (isFolder && !searchName.endsWith('/')) {
            searchName = name + '/'
        }
        if (!isFolder && searchName.endsWith('/')) {
            searchName = searchName.slice(0, -1)
        }
        const searchClean = searchName.replace(/\/$/, '')

        for (const entry of fileData) {
            const entryClean = entry.n.replace(/\/$/, '')
            if (entryClean === searchClean) {
                return entry
            }
        }

        try {
            const decoded = decodeURIComponent(searchClean)
            for (const entry of fileData) {
                const entryClean = entry.n.replace(/\/$/, '')
                if (entryClean === decoded) {
                    return entry
                }
            }
        } catch (e) {}

        let bestMatch = null
        let bestScore = 0
        for (const entry of fileData) {
            const entryClean = entry.n.replace(/\/$/, '')
            if (entryClean.includes(searchClean) || searchClean.includes(entryClean)) {
                const score = Math.min(entryClean.length, searchClean.length)
                if (score > bestScore) {
                    bestScore = score
                    bestMatch = entry
                }
            }
        }
        if (bestMatch && bestScore >= 2) {
            return bestMatch
        }

        return null
    }

    const APPEND_Z_FOR_NAIVE_ISO = true;

    function pad2(n) {
        return String(n).padStart(2, '0')
    }

    function formatTime(value) {
        if (!value) return null

        let d = null

        if (value instanceof Date) {
            d = value
        } else if (typeof value === 'number') {
            d = new Date(value)
        } else {
            let str
            try {
                str = String(value)
            } catch (e) {
                return null
            }

            const slashMatch = str.match(/^(\d{2,4})\/(\d{2})\/(\d{2})(.*)$/)
            if (slashMatch) {
                let year = slashMatch[1]
                if (year.length === 2) {
                    year = '20' + year
                }
                str = `${year}-${slashMatch[2]}-${slashMatch[3]}${slashMatch[4]}`
            }

            const naiveIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/
            if (APPEND_Z_FOR_NAIVE_ISO && naiveIso.test(str)) {
                str = str + 'Z'
            }

            d = new Date(str)
        }

        if (!d || isNaN(d.getTime())) {
            try {
                const s = String(value)
                const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/)
                if (m) {
                    return `${m[1].slice(-2)}-${m[2]}-${m[3]}`
                }
            } catch (e) {}
            return null
        }

        const year = String(d.getFullYear()).slice(-2)
        const month = pad2(d.getMonth() + 1)
        const day = pad2(d.getDate())
        const hour = pad2(d.getHours())
        const minute = pad2(d.getMinutes())

        if (hour === '00' && minute === '00') {
            return `${year}-${month}-${day}`
        }
        return `${year}-${month}-${day} ${hour}:${minute}`
    }

    function restoreNative(li) {
        const details = li?.querySelector('.entry-details')
        if (!details) return

        const size = details.querySelector('.entry-size')
        const ts = details.querySelector('.entry-ts')

        if (size) {
            size.classList.remove('sort-reason-time-value', 'sort-reason-time')
            size.style.display = ''
            size.style.color = ''
            size.title = ''
            const nameEl = li.querySelector('.entry-name')
            if (nameEl) {
                const entry = findEntry(nameEl.textContent.trim(), li.classList.contains('folder'))
                if (entry && !li.classList.contains('folder')) {
                    size.textContent = entry.s != null ? misc.formatBytes(entry.s) : ''
                } else if (li.classList.contains('folder')) {
                    size.textContent = ''
                }
            }
        }
        if (ts) {
            ts.style.display = ''
            ts.style.color = ''
            ts.classList.remove('sort-reason-time')
        }
    }

    function updateAll() {
        // Core switch: when enhanced sorting is disabled, restore native UI and exit.
        if (!ENABLE_ENHANCED_SORTING) {
            setPluginActive(false)
            document.querySelectorAll('.file, .folder').forEach(restoreNative)
            document.querySelectorAll('.entry-ts[style*="display: none"]').forEach(el => {
                el.style.display = ''
            })
            return
        }

        checkModeChange()

        document.querySelectorAll('.sort-reason-time-value').forEach(el => {
            el.classList.remove('sort-reason-time-value')
        })

        if (isListMode) {
            setPluginActive(false)
            document.querySelectorAll('.file, .folder').forEach(restoreNative)
            document.querySelectorAll('.entry-ts[style*="display: none"]').forEach(el => {
                el.style.display = ''
            })
            return
        }

        if (currentSort === 'name' || currentSort === 'size') {
            setPluginActive(false)
            document.querySelectorAll('.sort-reason-time-value, .sort-reason-time').forEach(el => {
                el.classList.remove('sort-reason-time-value', 'sort-reason-time')
                if (el.classList.contains('entry-size')) {
                    el.style.display = ''
                    el.style.color = ''
                    el.title = ''
                    const li = el.closest('.file, .folder')
                    if (li) {
                        const nameEl = li.querySelector('.entry-name')
                        if (nameEl) {
                            const entry = findEntry(nameEl.textContent.trim(), li.classList.contains('folder'))
                            if (entry && !li.classList.contains('folder')) {
                                el.textContent = entry.s != null ? misc.formatBytes(entry.s) : ''
                            } else if (li.classList.contains('folder')) {
                                el.textContent = ''
                            }
                        }
                    }
                }
                if (el.classList.contains('entry-ts')) {
                    el.style.display = ''
                    el.style.color = ''
                }
            })
            document.querySelectorAll('.entry-ts[style*="display: none"]').forEach(el => {
                el.style.display = ''
            })
            return
        }

        setPluginActive(true)
        if (!fileData) {
            fileData = getFileData()
        }
        document.querySelectorAll('.file, .folder').forEach(updateEntry)
    }

    function updateEntry(li) {
        const details = li.querySelector('.entry-details')
        if (!details) return

        const nameEl = li.querySelector('.entry-name')
        if (!nameEl) return

        const domName = nameEl.textContent.trim()
        const isFolder = li.classList.contains('folder')

        const entry = findEntry(domName, isFolder)

        let size = details.querySelector('.entry-size')
        const ts = details.querySelector('.entry-ts')

        if (!size) {
            size = document.createElement('span')
            size.className = 'entry-size'
            if (ts) {
                details.insertBefore(size, ts)
            } else {
                details.appendChild(size)
            }
        }

        if (ts) {
            ts.style.display = 'none'
        }

        if (currentSort === 'extension') {
            let ext = ''
            let sizeStr = ''

            if (entry && entry.ext) {
                ext = entry.ext
            } else if (entry && entry.n) {
                const dot = entry.n.lastIndexOf('.')
                if (dot > 0 && dot < entry.n.length - 1) {
                    ext = entry.n.substring(dot + 1).toLowerCase()
                }
            } else {
                const dot = domName.lastIndexOf('.')
                if (dot > 0 && dot < domName.length - 1) {
                    ext = domName.substring(dot + 1).toLowerCase()
                }
            }

            if (entry && entry.s != null) {
                sizeStr = misc.formatBytes(entry.s)
            }

            if (ext && sizeStr) {
                size.textContent = ext + ' - ' + sizeStr
            } else if (ext) {
                size.textContent = ext
            } else if (sizeStr) {
                size.textContent = sizeStr
            } else {
                size.textContent = ''
            }
            size.style.display = ''
            size.title = 'Sort by: extension'
            size.classList.add('sort-reason-time-value')
            return
        }

        let displayText = null

        if (entry) {
            let timeValue = null
            if (currentSort === 'time') {
                timeValue = entry.m || entry.c || null
            } else if (currentSort === 'creation') {
                timeValue = entry.c || entry.m || null
            }

            if (timeValue) {
                displayText = formatTime(timeValue)
            }
        }

        if (!displayText && ts) {
            const tsText = ts.textContent.trim()
            if (tsText) {
                displayText = tsText
            }
        }

        if (displayText) {
            const parts = displayText.match(/^(.+?)\s+(\d{2}:\d{2})$/)
            if (parts) {
                size.innerHTML = `${parts[1]} <span class="time-faint">${parts[2]}</span>`
            } else {
                size.textContent = displayText
            }
            size.style.display = ''
            size.title = 'Sort by: ' + currentSort
            size.classList.add('sort-reason-time-value')
        } else {
            size.textContent = ''
            size.style.display = ''
            size.title = ''
            size.classList.remove('sort-reason-time-value')
        }
    }

    function setTileSizeViaApi(size, options) {
        const opts = options || {};
        const applied = applyTileSize(size);
        if (applied === undefined) return undefined;

        if (ENABLE_TILE_MODE_MEMORY && currentTileUri) {
            if (opts.remember === false) {
                // 只是套用（例如剛載入資料夾），不要寫回記憶。
                lastSavedTileSize = applied;
            } else {
                saveTileModeForPath(currentTileUri, applied);
            }
        }
        return applied;
    }

    function stepTileSize(delta) {
        const fallback = getServerDefaultTileSize() ?? TILE_LAST_RESORT_DEFAULT;
        const current = clampTileSize(getTileSizeFromState(), fallback);
        return setTileSizeViaApi(current + (Number(delta) || 0));
    }

    function resetTileSize() {
        const key = currentTileUri || getTileModeKey(location.pathname);
        const entries = readTileStore().entries;
        if (entries[key]) {
            delete entries[key];
            writeTileStore();
        }

        const size = getServerDefaultTileSize();
        applyTileSize(size);
        lastSavedTileSize = size;
        return size;
    }

    function init() {
        initTileModeModule();
        lastMode = checkMode()

        if (typeof HFS !== 'undefined') {
            // 先保留其他外掛（例如 Hotkey）已放在 HFS.short 上的東西，再合併自己的。
            HFS.short = HFS.short || {};

            HFS.short.reload = function() {
                fileData = null;
                if (typeof HFS.reloadList === 'function') {
                    HFS.reloadList();
                }
                setTimeout(() => {
                    fileData = getFileData();
                    updateAll();
                }, 100);
            };

            if (ENABLE_TILE_MODE_MEMORY) {
                HFS.short.tile = {
                    // ---- 新 API ----
                    getSize: function() {
                        return getTileSizeFromState();
                    },
                    setSize: setTileSizeViaApi,
                    step: stepTileSize,
                    reset: resetTileSize,
                    forget: forgetTileModeForPath,
                    clear: wipeTileStore,
                    sync: function() {
                        const size = getTileSizeFromState();
                        applyTileSizeToDOM(size);
                        syncTileSizeControl(size);
                        return size;
                    },

                    // ---- 相容舊 API（Hotkey / Console）----
                    save: immediateSave,
                    load: function(path) {
                        loadTileModeForPath(path || currentTileUri || location.pathname);
                    },
                    cleanExpired: cleanExpiredTileData,
                    getStorage: function() {
                        return readTileStore().entries;
                    },
                    getServerDefault: getServerDefaultTileSize,
                    refresh: function() {
                        if (currentTileUri) {
                            loadTileModeForPath(currentTileUri);
                        }
                    },
                    getCurrentSize: function() {
                        return getTileSizeFromState();
                    }
                };
            }
        }

        setTimeout(() => {
            fileData = getFileData();
            updateAll();
        }, 200);
    }

    let initialized = false;
    function safeInit() {
        if (initialized) return;
        initialized = true;
        init();
    }

    safeInit();
}