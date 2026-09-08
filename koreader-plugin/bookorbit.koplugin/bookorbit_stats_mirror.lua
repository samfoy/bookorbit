--[[--
Mirrors BookOrbit's unified reading history into KOReader's statistics.sqlite3.

KOReader's statistics plugin owns the database schema and all native rows. This
module writes only through the existing `book` and `page_stat_data` lifecycle and
keeps small ownership metadata tables because those native tables have no provenance
column. The ownership rows are the safety boundary: a later snapshot may update
or delete only rows this mirror actually inserted; a conflicting native row is
recorded as unowned and is never changed.

A snapshot is paged. Each page commits independently and stamps its generation.
Only finishGeneration() removes older owned rows, so an interrupted sync leaves
the previous complete history intact and replaying a page is idempotent.
]]

local DataStorage = require("datastorage")
local SQ3 = require("lua-ljsqlite3/init")
local logger = require("logger")
local lfs = require("libs/libkoreader-lfs")

local StatsMirror = {}

local BUSY_TIMEOUT_MS = 3000
local REQUIRED_SCHEMA_VERSION = 20221111
local MIRROR_SCHEMA = [[
CREATE TABLE IF NOT EXISTS bookorbit_stats_books (
    remote_book_id INTEGER PRIMARY KEY,
    id_book INTEGER NOT NULL,
    created_by_mirror INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bookorbit_stats_mirror (
    remote_key TEXT PRIMARY KEY,
    remote_book_id INTEGER NOT NULL,
    id_book INTEGER NOT NULL,
    page INTEGER NOT NULL,
    start_time INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    total_pages INTEGER NOT NULL,
    generation TEXT NOT NULL,
    owned INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookorbit_stats_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookorbit_stats_pending (
    remote_key TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    kind TEXT NOT NULL,
    remote_book_id INTEGER NOT NULL,
    hash TEXT NOT NULL,
    title TEXT NOT NULL,
    authors TEXT NOT NULL,
    pages INTEGER NOT NULL,
    page INTEGER NOT NULL,
    start_time INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    total_pages INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookorbit_stats_pending_generation_idx
    ON bookorbit_stats_pending(generation);
CREATE INDEX IF NOT EXISTS bookorbit_stats_mirror_generation_idx
    ON bookorbit_stats_mirror(generation);
CREATE INDEX IF NOT EXISTS bookorbit_stats_mirror_native_key_idx
    ON bookorbit_stats_mirror(id_book, page, start_time);
]]

local function dbPath()
    return DataStorage:getSettingsDir() .. "/statistics.sqlite3"
end

local function openConn()
    local ok, conn = pcall(SQ3.open, dbPath())
    if not ok or not conn then return nil, "open_failed" end
    pcall(conn.set_busy_timeout, conn, BUSY_TIMEOUT_MS)
    return conn
end

local function row(conn, sql, params)
    local stmt = conn:prepare(sql)
    if params then stmt:bind(unpack(params)) end
    local result = stmt:step()
    stmt:close()
    return result
end

local function run(conn, sql, params)
    local stmt = conn:prepare(sql)
    if params then stmt:bind(unpack(params)) end
    stmt:step()
    stmt:close()
end

local function changed(conn)
    return tonumber(conn:rowexec("SELECT changes();")) or 0
end

local function validItem(item)
    return type(item) == "table"
        and type(item.key) == "string" and item.key ~= ""
        and (item.kind == "page" or item.kind == "session")
        and type(item.bookId) == "number" and item.bookId >= 1
        and type(item.hash) == "string" and item.hash:match("^%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x$")
        and type(item.title) == "string" and item.title ~= ""
        and type(item.authors) == "string"
        and type(item.pages) == "number" and item.pages >= 1
        and type(item.page) == "number" and item.page >= 0
        and type(item.startTime) == "number" and item.startTime >= 1
        and type(item.durationSeconds) == "number" and item.durationSeconds >= 0 and item.durationSeconds <= 86400
        and type(item.totalPages) == "number" and item.totalPages >= 1
end

function StatsMirror.ensureSchema()
    if lfs.attributes(dbPath(), "mode") ~= "file" then return nil, "statistics_disabled" end
    local conn, err = openConn()
    if not conn then return nil, err end
    local ok, result = pcall(function()
        local version = tonumber(conn:rowexec("PRAGMA user_version;")) or 0
        if version < REQUIRED_SCHEMA_VERSION then error("unsupported_schema") end
        if not conn:exec("PRAGMA table_info('book');") or not conn:exec("PRAGMA table_info('page_stat_data');") then
            error("missing_statistics_schema")
        end
        conn:exec(MIRROR_SCHEMA)
        return true
    end)
    conn:close()
    if not ok then
        logger.warn("BookOrbit: statistics mirror schema unavailable:", result)
        return nil, tostring(result):match("([^:]+)$") or "schema_failed"
    end
    return true
end

function StatsMirror.hasOwnershipTable(conn)
    local ok, found = pcall(function()
        return tonumber(conn:rowexec("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='bookorbit_stats_mirror';")) == 1
    end)
    return ok and found
end

function StatsMirror.currentGeneration()
    if lfs.attributes(dbPath(), "mode") ~= "file" then return nil end
    local conn = openConn()
    if not conn then return nil end
    local ok, value = pcall(function()
        local exists = tonumber(conn:rowexec(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='bookorbit_stats_meta';")) == 1
        if not exists then return nil end
        local generation = row(conn, "SELECT value FROM bookorbit_stats_meta WHERE key='last_generation';")
        local expected = row(conn, "SELECT value FROM bookorbit_stats_meta WHERE key='last_row_count';")
        if not generation or not expected then return nil end
        local actual = tonumber(conn:rowexec("SELECT count(*) FROM bookorbit_stats_mirror;")) or -1
        if actual ~= tonumber(expected[1]) then return nil end
        local missing = tonumber(conn:rowexec([[
            SELECT count(*) FROM bookorbit_stats_mirror m
            WHERE m.owned=1 AND NOT EXISTS (
                SELECT 1 FROM page_stat_data p
                WHERE p.id_book=m.id_book AND p.page=m.page AND p.start_time=m.start_time
                  AND p.duration=m.duration AND p.total_pages=m.total_pages
            );
        ]])) or 0
        if missing > 0 then return nil end
        return generation[1]
    end)
    conn:close()
    return ok and value or nil
end

local moveOwnedRows

local function resolveBook(conn, item, touched)
    local mapped = row(conn,
        "SELECT b.id, m.created_by_mirror, b.md5, b.title, b.authors, b.pages FROM bookorbit_stats_books m JOIN book b ON b.id=m.id_book WHERE m.remote_book_id=?;",
        { item.bookId })
    if mapped then
        local mapped_id = tonumber(mapped[1])
        local mapped_created = tonumber(mapped[2]) == 1
        if tostring(mapped[3] or ""):lower() == item.hash:lower() then
            if mapped_created
                    and (tostring(mapped[4] or "") ~= item.title
                        or tostring(mapped[5] or "") ~= item.authors
                        or tonumber(mapped[6]) ~= math.floor(item.pages)) then
                -- A second local row may already have the same title/authors/hash.
                -- Metadata polish must never abort the statistics transaction on
                -- that native uniqueness constraint; page count is always safe.
                pcall(run, conn, "UPDATE book SET title=?,authors=? WHERE id=?;",
                    { item.title, item.authors, mapped_id })
                run(conn, "UPDATE book SET pages=? WHERE id=?;", { math.floor(item.pages), mapped_id })
                touched[mapped_id] = true
            end
            return mapped_id, mapped_created
        end

        local replacement = row(conn, "SELECT id FROM book WHERE md5=? ORDER BY last_open DESC, id LIMIT 1;", { item.hash })
        if replacement then
            local replacement_id = tonumber(replacement[1])
            moveOwnedRows(conn, mapped_id, replacement_id, touched)
            if mapped_created then
                run(conn, "DELETE FROM book WHERE id=? AND NOT EXISTS (SELECT 1 FROM page_stat_data WHERE id_book=?);",
                    { mapped_id, mapped_id })
            end
            local replacement_created = row(conn,
                "SELECT created_by_mirror FROM bookorbit_stats_books WHERE id_book=? AND created_by_mirror=1 LIMIT 1;",
                { replacement_id }) ~= nil
            run(conn, "INSERT OR REPLACE INTO bookorbit_stats_books(remote_book_id,id_book,created_by_mirror) VALUES(?,?,?);",
                { item.bookId, replacement_id, replacement_created and 1 or 0 })
            return replacement_id, replacement_created
        elseif mapped_created then
            run(conn, "UPDATE book SET title=?,authors=?,pages=?,md5=? WHERE id=?;",
                { item.title, item.authors, math.floor(item.pages), item.hash:lower(), mapped_id })
            touched[mapped_id] = true
            return mapped_id, true
        end
        -- A native row changed identity. Leave it untouched and create a new
        -- mirror-owned row for the server's new edition below.
    end

    local existing = row(conn, "SELECT id FROM book WHERE md5=? ORDER BY last_open DESC, id LIMIT 1;", { item.hash })
    local id_book, created
    if existing then
        id_book, created = tonumber(existing[1]), false
    else
        run(conn, [[
            INSERT INTO book
                (title, authors, notes, last_open, highlights, pages, series, language, md5, total_read_time, total_read_pages)
            VALUES (?, ?, 0, 0, 0, ?, '', '', ?, 0, 0);
        ]], { item.title, item.authors, math.floor(item.pages), item.hash:lower() })
        id_book, created = tonumber(conn:rowexec("SELECT last_insert_rowid();")), true
    end
    run(conn, "INSERT OR REPLACE INTO bookorbit_stats_books(remote_book_id,id_book,created_by_mirror) VALUES(?,?,?);",
        { item.bookId, id_book, created and 1 or 0 })
    return id_book, created
end

local function deleteOwnedRow(conn, tracked)
    if not tracked or tonumber(tracked[6]) ~= 1 then return false end
    run(conn, [[
        DELETE FROM page_stat_data
        WHERE id_book=? AND page=? AND start_time=? AND duration=? AND total_pages=?;
    ]], { tonumber(tracked[1]), tonumber(tracked[2]), tonumber(tracked[3]), tonumber(tracked[4]), tonumber(tracked[5]) })
    return changed(conn) > 0
end

moveOwnedRows = function(conn, from_id, to_id, touched)
    if from_id == to_id then return end
    local stmt = conn:prepare([[
        SELECT remote_key,page,start_time,duration,total_pages,generation,kind
        FROM bookorbit_stats_mirror WHERE id_book=? AND owned=1;
    ]])
    stmt:bind(from_id)
    local rows = {}
    for tracked in stmt:rows() do
        table.insert(rows, { tracked[1], tracked[2], tracked[3], tracked[4], tracked[5], tracked[6], tracked[7] })
    end
    stmt:close()
    for _, tracked in ipairs(rows) do
        run(conn, "INSERT OR IGNORE INTO page_stat_data(id_book,page,start_time,duration,total_pages) VALUES(?,?,?,?,?);",
            { to_id, tracked[2], tracked[3], tracked[4], tracked[5] })
        local owned = changed(conn) > 0
        deleteOwnedRow(conn, { from_id, tracked[2], tracked[3], tracked[4], tracked[5], 1 })
        run(conn, "UPDATE bookorbit_stats_mirror SET id_book=?,owned=? WHERE remote_key=?;",
            { to_id, owned and 1 or 0, tracked[1] })
    end
    if #rows > 0 then
        touched[from_id] = true
        touched[to_id] = true
    end
end

local function applyItem(conn, item, generation, touched)
    if not validItem(item) then error("invalid_mirror_item") end
    local id_book = resolveBook(conn, item, touched)
    local page = math.floor(item.page)
    local start_time = math.floor(item.startTime)
    local duration = math.floor(item.durationSeconds)
    local total_pages = math.floor(item.totalPages)
    local tracked = row(conn, [[
        SELECT id_book,page,start_time,duration,total_pages,owned
        FROM bookorbit_stats_mirror WHERE remote_key=?;
    ]], { item.key })

    if tracked
            and tonumber(tracked[1]) == id_book
            and tonumber(tracked[2]) == page
            and tonumber(tracked[3]) == start_time
            and tonumber(tracked[4]) == duration
            and tonumber(tracked[5]) == total_pages then
        local actual = row(conn, [[
            SELECT duration,total_pages FROM page_stat_data
            WHERE id_book=? AND page=? AND start_time=?;
        ]], { id_book, page, start_time })
        if actual then
            local still_owned = tonumber(actual[1]) == duration and tonumber(actual[2]) == total_pages
                and tonumber(tracked[6]) == 1
            run(conn, "UPDATE bookorbit_stats_mirror SET generation=?,owned=? WHERE remote_key=?;",
                { generation, still_owned and 1 or 0, item.key })
            return false, false
        end
        -- The tracked row vanished: recreate it below instead of trusting stale
        -- ownership metadata.
    end

    local deleted_owned = false
    if tracked then
        deleted_owned = deleteOwnedRow(conn, tracked)
        if deleted_owned then touched[tonumber(tracked[1])] = true end
        run(conn, "DELETE FROM bookorbit_stats_mirror WHERE remote_key=?;", { item.key })
    end

    run(conn, "INSERT OR IGNORE INTO page_stat_data(id_book,page,start_time,duration,total_pages) VALUES(?,?,?,?,?);",
        { id_book, page, start_time, duration, total_pages })
    local owned = changed(conn) > 0
    run(conn, [[
        INSERT INTO bookorbit_stats_mirror
            (remote_key,remote_book_id,id_book,page,start_time,duration,total_pages,generation,owned,kind)
        VALUES(?,?,?,?,?,?,?,?,?,?);
    ]], { item.key, item.bookId, id_book, page, start_time, duration, total_pages, generation, owned and 1 or 0, item.kind })
    if owned then touched[id_book] = true end
    return owned, owned or deleted_owned
end

local function refreshBookTotals(conn, touched)
    for id_book in pairs(touched) do
        run(conn, [[
            UPDATE book SET
                total_read_pages=coalesce((SELECT count(DISTINCT page) FROM page_stat WHERE id_book=?),0),
                total_read_time=coalesce((SELECT sum(duration) FROM page_stat WHERE id_book=?),0),
                last_open=coalesce((SELECT max(start_time + duration) FROM page_stat_data WHERE id_book=?),last_open)
            WHERE id=?;
        ]], { id_book, id_book, id_book, id_book })
    end
end

function StatsMirror.applyPage(generation, items)
    if type(generation) ~= "string" or generation == "" or type(items) ~= "table" then
        return nil, "invalid_page"
    end
    local ready, ready_err = StatsMirror.ensureSchema()
    if not ready then return nil, ready_err end
    local conn, err = openConn()
    if not conn then return nil, err end
    local ok, result = pcall(function()
        conn:exec("BEGIN IMMEDIATE;")
        run(conn, "DELETE FROM bookorbit_stats_pending WHERE generation<>?;", { generation })
        for _, item in ipairs(items) do
            if not validItem(item) then error("invalid_mirror_item") end
            run(conn, [[
                INSERT OR REPLACE INTO bookorbit_stats_pending
                    (remote_key,generation,kind,remote_book_id,hash,title,authors,pages,page,start_time,duration,total_pages)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?);
            ]], {
                item.key, generation, item.kind, item.bookId, item.hash:lower(), item.title, item.authors,
                math.floor(item.pages), math.floor(item.page), math.floor(item.startTime),
                math.floor(item.durationSeconds), math.floor(item.totalPages),
            })
        end
        conn:exec("COMMIT;")
        return true
    end)
    if not ok then pcall(conn.exec, conn, "ROLLBACK;") end
    conn:close()
    if not ok then
        logger.warn("BookOrbit: statistics mirror page staging failed:", result)
        return nil, tostring(result)
    end
    return { received = #items, inserted = 0, changed = false }
end

function StatsMirror.finishGeneration(generation)
    if type(generation) ~= "string" or generation == "" then return nil, "invalid_generation" end
    local ready, ready_err = StatsMirror.ensureSchema()
    if not ready then return nil, ready_err end
    local conn, err = openConn()
    if not conn then return nil, err end
    local touched, removed, inserted, changed_any = {}, 0, 0, false
    local ok, result = pcall(function()
        conn:exec("BEGIN IMMEDIATE;")
        local pending_stmt = conn:prepare([[
            SELECT remote_key,kind,remote_book_id,hash,title,authors,pages,page,start_time,duration,total_pages
            FROM bookorbit_stats_pending WHERE generation=? ORDER BY remote_key;
        ]])
        pending_stmt:bind(generation)
        local pending_rows = {}
        for pending in pending_stmt:rows() do
            table.insert(pending_rows, {
                pending[1], pending[2], pending[3], pending[4], pending[5], pending[6],
                pending[7], pending[8], pending[9], pending[10], pending[11],
            })
        end
        pending_stmt:close()
        for _, pending in ipairs(pending_rows) do
            local owned, item_changed = applyItem(conn, {
                key = pending[1], kind = pending[2], bookId = tonumber(pending[3]), hash = pending[4],
                title = pending[5], authors = pending[6], pages = tonumber(pending[7]),
                page = tonumber(pending[8]), startTime = tonumber(pending[9]),
                durationSeconds = tonumber(pending[10]), totalPages = tonumber(pending[11]),
            }, generation, touched)
            if owned then inserted = inserted + 1 end
            changed_any = changed_any or item_changed == true
        end

        local stale = conn:prepare([[
            SELECT remote_key,id_book,page,start_time,duration,total_pages,owned
            FROM bookorbit_stats_mirror WHERE generation<>?;
        ]])
        stale:bind(generation)
        local stale_rows = {}
        for tracked in stale:rows() do
            table.insert(stale_rows, {
                tracked[1], tracked[2], tracked[3], tracked[4], tracked[5], tracked[6], tracked[7],
            })
        end
        stale:close()
        for _, tracked in ipairs(stale_rows) do
            local values = { tracked[2], tracked[3], tracked[4], tracked[5], tracked[6], tracked[7] }
            if deleteOwnedRow(conn, values) then
                touched[tonumber(tracked[2])] = true
                removed = removed + 1
                changed_any = true
            end
            run(conn, "DELETE FROM bookorbit_stats_mirror WHERE remote_key=?;", { tracked[1] })
        end
        refreshBookTotals(conn, touched)
        conn:exec([[
            DELETE FROM book
            WHERE id IN (SELECT id_book FROM bookorbit_stats_books WHERE created_by_mirror=1)
              AND NOT EXISTS (SELECT 1 FROM page_stat_data p WHERE p.id_book=book.id);
            DELETE FROM bookorbit_stats_books
            WHERE NOT EXISTS (SELECT 1 FROM book b WHERE b.id=bookorbit_stats_books.id_book);
        ]])
        run(conn, "INSERT OR REPLACE INTO bookorbit_stats_meta(key,value) VALUES('last_generation',?);", { generation })
        local row_count = tonumber(conn:rowexec("SELECT count(*) FROM bookorbit_stats_mirror;")) or 0
        run(conn, "INSERT OR REPLACE INTO bookorbit_stats_meta(key,value) VALUES('last_row_count',?);", { tostring(row_count) })
        run(conn, "DELETE FROM bookorbit_stats_pending WHERE generation=?;", { generation })
        conn:exec("COMMIT;")
        return true
    end)
    if not ok then pcall(conn.exec, conn, "ROLLBACK;") end
    conn:close()
    if not ok then
        logger.warn("BookOrbit: statistics mirror finalize failed:", result)
        return nil, tostring(result)
    end
    return { removed = removed, inserted = inserted, changed = changed_any or next(touched) ~= nil }
end

function StatsMirror.invalidateConsumerCaches()
    local settings = DataStorage:getSettingsDir()
    os.remove(settings .. "/reading_insights_cache.lua")
    os.remove(settings .. "/readinginsights_records_cache.lua")
    local provider = package.loaded["modules/module_stats_provider"]
        or package.loaded["desktop_modules/module_stats_provider"]
    if provider and provider.invalidate then pcall(provider.invalidate) end
    -- Reading Insights clears its in-memory/frozen-year caches on this event;
    -- deleting its disk caches above covers a later cold start as well.
    local ok, Event = pcall(require, "ui/event")
    if ok and Event then
        local ok_ui, UIManager = pcall(require, "ui/uimanager")
        if ok_ui and UIManager and UIManager.broadcastEvent then
            pcall(UIManager.broadcastEvent, UIManager, Event:new("BookOrbitStatisticsSynced"))
        end
    end
end

return StatsMirror
