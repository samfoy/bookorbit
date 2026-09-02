--[[--
Native external-book Store for the BookOrbit catalog.

The Store is a mixin on the existing catalog controller. It reuses that
controller's stack, mosaic/list widgets, network subprocess boundary, settings,
and local-book download/open lifecycle. All provider and acquisition work stays
on the BookOrbit server.
]]

local ButtonDialog = require("ui/widget/buttondialog")

local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local NetworkMgr = require("ui/network/manager")
local Notification = require("ui/widget/notification")
local TextViewer = require("ui/widget/textviewer")
local UIManager = require("ui/uimanager")
local T = require("ffi/util").template
local _ = require("gettext")

local Capabilities = require("bookorbit_capabilities")
local StoreQueue = require("bookorbit_store_queue")
local StoreDevice = require("bookorbit_store_device")

local Store = {}
local STORE_PAGE_SIZE = 12
local MAX_RECENT_SEARCHES = 5
local POLL_SECONDS = 2.5
local PROVIDER_LABELS = { hardcover = "Hardcover", storygraph = "StoryGraph" }
local ACTIVE_STATUS = { queued = true, downloading = true, optimizing = true, importing = true }
local CANCELLABLE_STATUS = { queued = true, downloading = true, optimizing = true }

local function firstAuthor(book)
    return type(book.authors) == "table" and book.authors[1] or nil
end

local function externalBook(book)
    book = book or {}
    local state = type(book.state) == "table" and book.state or {}
    return {
        id = tostring(book.id or ""),
        title = book.title or _("Untitled"),
        authors = book.authors or {},
        author = firstAuthor(book),
        description = book.description,
        publishedYear = book.publishedYear,
        rating = book.rating,
        ratingsCount = book.ratingsCount,
        isbn10 = book.isbn10,
        isbn13 = book.isbn13,
        pageCount = book.pageCount,
        language = book.language,
        publisher = book.publisher,
        seriesName = book.seriesName,
        seriesIndex = book.seriesPosition,
        genres = book.genres or {},
        sources = book.sources or {},
        coverUrl = book.coverUrl,
        hasCover = type(book.coverUrl) == "string" and book.coverUrl:match("^https://") ~= nil,
        external = true,
        externalId = tostring(book.id or ""),
        inBookOrbit = state.inBookOrbit == true,
        bookId = tonumber(state.bookId),
        formats = state.localFormats or {},
        readStatus = state.bookOrbitStatus,
        progressPercentage = state.progressPercentage,
        hardcoverStatus = state.hardcoverStatus,
        storygraphStatus = state.storygraphStatus,
        recommendationReason = book.recommendationReason,
        alreadyRead = state.alreadyRead == true,
        alreadyOwned = state.alreadyOwned == true,
        onDevice = false,
    }
end

function Store.mapBooks(items)
    local books = {}
    for _, item in ipairs(items or {}) do books[#books + 1] = externalBook(item) end
    return books
end

function Store:overlayDeviceState(books)
    for _index, book in ipairs(books or {}) do
        local path = book.bookId and self.on_device and self.on_device[book.bookId] or nil
        book.onDevice = type(path) == "string" and path ~= ""
        book.localPath = book.onDevice and path or nil
        local acquiring = Store.storeJobForBook(self, book.externalId) ~= nil
        local badge = Store.stateBadge(self, book, acquiring)
        local compact = {
            [_("Acquiring")] = _("Getting"),
            [_("On Device")] = _("Device"),
            [_("Want to Read")] = _("Wishlist"),
            [_("In BookOrbit")] = _("Owned"),
            [_("Not owned")] = _("Get"),
        }
        book.storeBadge = compact[badge] or badge
    end
    return books
end

function Store:stateBadge(book, acquiring)
    if acquiring then return _("Acquiring") end
    if book.onDevice then return _("On Device") end
    if book.alreadyRead then return _("Read") end
    if book.readStatus == "reading" or book.readStatus == "rereading" then return _("Reading") end
    if book.readStatus == "want_to_read" or book.hardcoverStatus == "want_to_read"
            or book.storygraphStatus == "to-read" then return _("Want to Read") end
    if book.alreadyOwned then return _("In BookOrbit") end
    return _("Not owned")
end

function Store.jobIsActive(job)
    return type(job) == "table" and ACTIVE_STATUS[job.status] == true
end

function Store.jobIsCancellable(job)
    return type(job) == "table" and CANCELLABLE_STATUS[job.status] == true
end

function Store:storeSupported()
    return Capabilities.supports(self.client, "catalogStore")
end

function Store:storeCapabilityAdvertised()
    local known = Capabilities.cached(self.client)
    return known ~= nil and known.catalogStore == true
end

function Store:storeHideRead()
    return not self.settings or self.settings.store_hide_read ~= false
end

function Store:storeCache()
    return type(self.settings.store_home_cache) == "table" and self.settings.store_home_cache or nil
end

function Store:cacheStoreHome(body)
    if type(body) == "table" then self:persistSetting("store_home_cache", body) end
end

function Store:nextStoreRequestGeneration()
    self.store_request_generation = (self.store_request_generation or 0) + 1
    return self.store_request_generation
end

function Store:storeRequestIsCurrent(generation)
    return not self.catalog_closed and generation == self.store_request_generation
end

local function countLabel(value)
    local count = tonumber(value)
    if not count or count < 1 then return nil end
    return tostring(math.floor(count))
end

function Store:storeRecentSearches()
    local stored = self.settings and self.settings.store_recent_searches
    local recent = {}
    for _, query in ipairs(type(stored) == "table" and stored or {}) do
        if type(query) == "string" and query ~= "" then recent[#recent + 1] = query end
    end
    return recent
end

function Store:storeActiveAcquisitionCount()
    local seen, count = {}, 0
    for _, entry in ipairs(Store.activeStoreJobs(self)) do
        local key = tostring(entry.external_id or entry.id or "")
        if key ~= "" and not seen[key] then
            seen[key] = true
            count = count + 1
        end
    end
    for _, intent in ipairs(StoreQueue.active(Store.storeIntentions(self))) do
        local key = tostring(intent.external_id or intent.intent_id or "")
        if key ~= "" and not seen[key] then
            seen[key] = true
            count = count + 1
        end
    end
    return count
end

-- The ordered browse paths a Store index offers, derived purely from the cached
-- whole-home payload. Unavailable or empty shelves are dropped rather than
-- rendered as dead rows.
local function indexShelves(body)
    local personalized = (body or {}).personalizedShelves or {}
    local function shelvesOfKind(kind)
        local matches = {}
        for _, shelf in ipairs(personalized) do
            if shelf.kind == kind and shelf.available ~= false and #(shelf.items or {}) > 0 then
                matches[#matches + 1] = shelf
            end
        end
        return matches
    end
    local ordered = {}
    local function append(shelves)
        for _, shelf in ipairs(shelves) do ordered[#ordered + 1] = shelf end
    end
    append(shelvesOfKind("for-you"))
    local trending = type(body) == "table" and body.trending or nil
    if type(trending) == "table" and #(trending.items or {}) > 0 then ordered[#ordered + 1] = trending end
    append(shelvesOfKind("up-next"))
    append(shelvesOfKind("tracker"))
    append(shelvesOfKind("curated"))
    return ordered
end

function Store:storeIndexItems(body, stale, refreshing)
    local items = { { text = _("Search books"), kind = "store-search" } }
    for _, query in ipairs(Store.storeRecentSearches(self)) do
        items[#items + 1] = { text = query, kind = "store-recent-search", store_query = query }
    end
    for _, shelf in ipairs(indexShelves(body)) do
        items[#items + 1] = {
            text = shelf.title or _("Books"),
            mandatory = countLabel(#(shelf.items or {})),
            kind = "store-shelf",
            shelf = shelf,
        }
    end
    items[#items + 1] = { text = _("Browse genres"), kind = "store-genres" }
    items[#items + 1] = {
        text = _("Downloads"),
        mandatory = countLabel(Store.storeActiveAcquisitionCount(self)),
        kind = "store-jobs",
    }
    local subtitle
    if refreshing then
        subtitle = _("refreshing")
    elseif stale then
        subtitle = _("offline cache")
    end
    return items, {
        kind = "store-index",
        title = _("Book Store"),
        subtitle = subtitle,
        store_home = body,
        stale = stale == true,
        refreshing = refreshing == true,
    }
end

function Store:storeIndexMode()
    return self.current_context ~= nil and self.current_context.kind == "store-index"
end

-- The index is one vertical menu of browse paths, so Menu's inherited paginator
-- has nothing to page through. Mirrors the dashboard's own suppression.
function Store:storeIndexPageInfo()
    self.page_info_text:setText("")
    self.page_info_left_chev:hide()
    self.page_info_right_chev:hide()
    self.page_info_first_chev:hide()
    self.page_info_last_chev:hide()
    self.page_info_text:disableWithoutDimming()
    self.page_return_arrow:showHide(self.onReturn ~= nil)
    self.page_return_arrow:enableDisable(#(self.paths or {}) > 0)
end

function Store:openBookStore()
    if self:storeCache() and not NetworkMgr:isConnected() then
        self:loadStoreHome(true)
        return
    end
    self:runConnected(function()
        local supported = self:storeSupported()
        if supported == false then
            UIManager:show(InfoMessage:new{ text = _("The Book Store needs a newer BookOrbit server."), timeout = 4 })
            return
        elseif supported == nil then
            UIManager:show(InfoMessage:new{ text = _("Could not check Book Store support."), timeout = 3 })
            return
        end
        self:loadStoreHome(true)
    end)
end

function Store:loadStoreHome(push)
    local cached = self:storeCache()
    local connected = NetworkMgr:isConnected()
    if cached then
        local items, context = self:storeIndexItems(cached, not connected, connected)
        self:switchTo(context.title, items, context, push)
        if not connected then return end
    end
    local request_generation = self:nextStoreRequestGeneration()
    self:runConnected(function()
        if not self:storeRequestIsCurrent(request_generation) then return end
        local body, err = self:fetch(_("Loading Book Store..."), function()
            return self.client:catalogStoreHome(self:storeHideRead())
        end)
        if not self:storeRequestIsCurrent(request_generation) then return end
        if not body then
            if cached then
                local items, context = self:storeIndexItems(cached, true, false)
                self:switchTo(context.title, items, context, false)
            elseif err ~= "cancelled" then
                self:showRetry(err, function() self:loadStoreHome(push) end)
            end
            return
        end
        self:cacheStoreHome(body)
        local items, context = self:storeIndexItems(body, false, false)
        local navigation_push = push
        if cached then navigation_push = false end
        self:switchTo(context.title, items, context, navigation_push)
        if push == false then self:mirrorStoreShelf(body) end
        self:resumeStoreAcquisitions()
    end)
end

-- A shelf row opens the existing cover grid over the books the index already
-- holds, pushed so Back pops straight back to the index with its focus.
function Store:showStoreShelf(shelf)
    shelf = shelf or {}
    local books = Store.mapBooks(shelf.items)
    Store.overlayDeviceState(self, books)
    local context = {
        kind = "store-books",
        title = shelf.title or _("Book Store"),
        subtitle = shelf.subtitle,
        books = books,
        store_kind = shelf.kind,
        store_value = shelf.value,
        store_shelf_id = shelf.id,
        store_shelf = shelf,
        page = 1,
        page_count = 1,
    }
    self:switchTo(context.title, self:storeBookItems(books), context, true)
end

function Store:storeBookItems(books)
    local items = {}
    for _, book in ipairs(books or {}) do
        local acquiring = Store.storeJobForBook(self, book.externalId) ~= nil
        items[#items + 1] = {
            text = book.title .. " - " .. Store.stateBadge(self, book, acquiring),
            kind = "store-book",
            book = book,
        }
    end
    return items
end

function Store:loadStoreBrowse(kind, value, page, title, push)
    page = page or 1
    local request_generation = self:nextStoreRequestGeneration()
    self:runConnected(function()
        if not self:storeRequestIsCurrent(request_generation) then return end
        local body, err = self:fetch(_("Loading books..."), function()
            return self.client:catalogStoreBrowse({
                kind = kind,
                value = value,
                page = page,
                pageSize = STORE_PAGE_SIZE,
                hideRead = self:storeHideRead(),
                sort = self.settings.store_sort or "relevance",
                ebookOnly = self.settings.store_ebook_only == true,
                seriesMode = self.settings.store_series_mode,
            })
        end)
        if not self:storeRequestIsCurrent(request_generation) then return end
        if not body then
            if err ~= "cancelled" then self:showRetry(err, function() self:loadStoreBrowse(kind, value, page, title, push) end) end
            return
        end
        local books = Store.mapBooks(body.items)
        Store.overlayDeviceState(self, books)
        local context = {
            kind = "store-books",
            title = body.title or title or _("Book Store"),
            subtitle = body.subtitle,
            books = books,
            store_kind = kind,
            store_value = value,
            page = body.page or page,
            page_count = body.hasMore and (body.page or page) + 1 or (body.page or page),
            has_more = body.hasMore == true,
        }
        self:switchTo(context.title, self:storeBookItems(books), context, push)
    end)
end

function Store:rememberStoreSearch(query)
    local trimmed = tostring(query or ""):match("^%s*(.-)%s*$")
    if trimmed == "" then return end
    local recent = { trimmed }
    for _, existing in ipairs(Store.storeRecentSearches(self)) do
        if existing ~= trimmed and #recent < MAX_RECENT_SEARCHES then recent[#recent + 1] = existing end
    end
    self:persistSetting("store_recent_searches", recent)
end

function Store:promptStoreSearch()
    local dialog
    dialog = InputDialog:new{
        title = _("Search books"),
        input = "",
        input_hint = _("Title, author, or ISBN"),
        buttons = {{
            { text = _("Cancel"), id = "close", callback = function() UIManager:close(dialog) end },
            { text = _("Search"), is_enter_default = true, callback = function()
                local query = tostring(dialog:getInputText() or ""):match("^%s*(.-)%s*$")
                if query == "" then return end
                UIManager:close(dialog)
                self:loadStoreSearch(query, true)
            end },
        }},
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

-- Concise prose for a result page: how many books came back, plus which
-- provider could not answer. Never the raw API wording.
local function searchSubtitle(count, unavailable)
    local parts = {}
    if count == 0 then
        parts[#parts + 1] = _("No books found")
    elseif count == 1 then
        parts[#parts + 1] = _("1 book")
    else
        parts[#parts + 1] = T(_("%1 books"), tostring(count))
    end
    if #unavailable > 0 then
        parts[#parts + 1] = T(_("%1 could not be reached"), table.concat(unavailable, ", "))
    end
    return table.concat(parts, " - ")
end

function Store:loadStoreSearch(query, push)
    local request_generation = self:nextStoreRequestGeneration()
    self:runConnected(function()
        if not self:storeRequestIsCurrent(request_generation) then return end
        local body, err = self:fetch(_("Searching books..."), function()
            return self.client:catalogStoreSearch(query, "hardcover,storygraph", false)
        end)
        if not self:storeRequestIsCurrent(request_generation) then return end
        if not body then
            if err ~= "cancelled" then self:showRetry(err, function() self:loadStoreSearch(query, push) end) end
            return
        end
        self:rememberStoreSearch(query)
        local books = Store.mapBooks(body.results)
        Store.overlayDeviceState(self, books)
        local unavailable = {}
        for _, source in ipairs(body.sources or {}) do
            if source.available == false then
                local name = tostring(source.source or "")
                unavailable[#unavailable + 1] = PROVIDER_LABELS[name] or name
            end
        end
        local context = {
            kind = "store-books",
            title = T(_("Search: %1"), query),
            subtitle = searchSubtitle(#books, unavailable),
            books = books,
            store_query = query,
            page = 1,
            page_count = 1,
        }
        local items = self:storeBookItems(books)
        if #books == 0 then
            items = { { text = _("Search again"), kind = "store-search" } }
        end
        self:switchTo(context.title, items, context, push)
    end)
end

function Store:storeDescription(book)
    local lines = { book.title or _("Untitled") }
    if book.recommendationReason then lines[#lines + 1] = book.recommendationReason end
    if firstAuthor(book) then lines[#lines + 1] = firstAuthor(book) end
    if book.seriesName then lines[#lines + 1] = book.seriesName end
    if book.publishedYear then lines[#lines + 1] = tostring(book.publishedYear) end
    if book.rating then lines[#lines + 1] = T(_("Rating: %1"), tostring(book.rating)) end
    if book.pageCount then lines[#lines + 1] = T(_("Pages: %1"), tostring(book.pageCount)) end
    if book.language then lines[#lines + 1] = T(_("Language: %1"), book.language) end
    if book.publisher then lines[#lines + 1] = T(_("Publisher: %1"), book.publisher) end
    if book.isbn13 then lines[#lines + 1] = T(_("ISBN: %1"), book.isbn13) end
    if book.description then lines[#lines + 1] = "\n" .. book.description end
    return table.concat(lines, "\n")
end

function Store.storeDetail(book)
    local genres = {}
    for _, genre in ipairs(book.genres or {}) do genres[#genres + 1] = genre.name or genre.slug end
    local tags = {}
    for _, source in ipairs(book.sources or {}) do
        local name = tostring(source.source or "")
        if name ~= "" then tags[#tags + 1] = name:sub(1, 1):upper() .. name:sub(2) end
    end
    return {
        id = book.externalId,
        title = book.title,
        authors = book.authors or {},
        description = book.description,
        coverUrl = book.coverUrl,
        publishedYear = book.publishedYear,
        rating = book.rating,
        pageCount = book.pageCount,
        seriesName = book.seriesName,
        seriesIndex = book.seriesIndex,
        isbn10 = book.isbn10,
        isbn13 = book.isbn13,
        genres = genres,
        tags = tags,
        files = {},
        relatedSections = {},
        external = true,
        storeBook = book,
        recommendationReason = book.recommendationReason,
    }
end

function Store:showStoreBook(book)
    self:showBookDetail(Store.storeDetail(book), { external = true })
end

function Store:showStoreBookActions(book)
    local dialog
    local buttons = {{
        { text = _("Get"), callback = function() UIManager:close(dialog); self:showStoreAcquire(book) end },
        { text = _("Description"), callback = function()
            UIManager:close(dialog)
            UIManager:show(TextViewer:new{ title = book.title, text = self:storeDescription(book) })
        end },
    }}
    local author = firstAuthor(book)
    if author then buttons[#buttons + 1] = {{ text = T(_("More by %1"), author), callback = function()
        UIManager:close(dialog); self:loadStoreBrowse("author", author, 1, nil, true)
    end }} end
    local hardcover_id
    for _, source in ipairs(book.sources or {}) do
        if source.source == "hardcover" then hardcover_id = source.externalId end
    end
    if hardcover_id then buttons[#buttons + 1] = {{ text = _("Similar books"), callback = function()
        UIManager:close(dialog); self:loadStoreBrowse("similar", hardcover_id, 1, nil, true)
    end }} end
    if book.genres and book.genres[1] then buttons[#buttons + 1] = {{ text = book.genres[1].name, callback = function()
        UIManager:close(dialog); self:loadStoreBrowse("genre", book.genres[1].slug, 1, nil, true)
    end }} end
    if book.onDevice and book.bookId then buttons[#buttons + 1] = {{ text = _("Remove from device"), callback = function()
        UIManager:close(dialog)
        local ok, err = StoreDevice.removeFromDevice(self, book.bookId)
        UIManager:show(InfoMessage:new{ text = ok and _("Removed from device; kept in BookOrbit.") or tostring(err), timeout = 3 })
    end }} end
    dialog = ButtonDialog:new{ title = book.title, buttons = buttons }
    UIManager:show(dialog)
end

function Store:storeConfig()
    return type(self.store_config) == "table" and self.store_config or nil
end

function Store:loadStoreConfig(callback)
    local cached = self:storeConfig()
    if cached then callback(cached); return end
    self:runConnected(function()
        local config, err = self:fetch(_("Loading download options..."), function() return self.client:catalogStoreConfig() end)
        if not config then
            if err ~= "cancelled" then self:showServerError(err) end
            return
        end
        self.store_config = config
        callback(config)
    end)
end

function Store:storeDestination(config)
    local wanted = tonumber(self.settings.store_library_id)
    for _, library in ipairs(config.libraries or {}) do
        if not wanted or library.id == wanted then
            local folder
            local wanted_folder = tonumber(self.settings.store_folder_id)
            for _, candidate in ipairs(library.folders or {}) do
                if candidate.id == wanted_folder then
                    folder = candidate
                    break
                end
            end
            folder = folder or (library.folders and library.folders[1])
            return library, folder
        end
    end
end

function Store:storeSource(config)
    local wanted = self.settings.store_acquisition_source or "auto"
    if wanted == "auto" then return wanted end
    for _, source in ipairs(config.sources or {}) do
        if source.source == wanted and source.available then return wanted end
    end
    return "auto"
end

function Store:showStoreAcquire(book)
    if book.alreadyOwned and book.bookId then
        self:showOwnedStoreBook(book)
        return
    end
    self:loadStoreConfig(function(config)
        if config.canAcquire == false then
            UIManager:show(InfoMessage:new{ text = _("Your BookOrbit account cannot acquire books."), timeout = 4 })
            return
        end
        local library, folder = self:storeDestination(config)
        if not library then
            UIManager:show(InfoMessage:new{ text = _("No writable BookOrbit library is available."), timeout = 4 })
            return
        end
        local source = self:storeSource(config)
        local dialog
        dialog = ButtonDialog:new{
            title = T(_("Get %1?\n\nLibrary: %2\nSource: %3"), book.title, library.name, source),
            buttons = {
                {{ text = _("Get"), callback = function()
                    UIManager:close(dialog)
                    self:startStoreAcquisition(book, library.id, folder and folder.id or nil, source, "get")
                end }},
                {{ text = _("Get and download"), callback = function()
                    UIManager:close(dialog)
                    self:startStoreAcquisition(book, library.id, folder and folder.id or nil, source, "download")
                end }, { text = _("Get and open"), callback = function()
                    UIManager:close(dialog)
                    self:startStoreAcquisition(book, library.id, folder and folder.id or nil, source, "open")
                end }},
                {{ text = _("Destination"), callback = function()
                    UIManager:close(dialog); self:chooseStoreLibrary(book, config)
                end }, { text = _("Source"), callback = function()
                    UIManager:close(dialog); self:chooseStoreSource(book, config)
                end }},
            },
        }
        UIManager:show(dialog)
    end)
end

function Store:showOwnedStoreBook(book)
    self:runConnected(function()
        local detail, err = self:fetch(_("Loading BookOrbit book..."), function()
            return self.client:catalogBook(book.bookId)
        end)
        if not detail then
            if err ~= "cancelled" then self:showServerError(err) end
            return
        end
        self:cacheBookDetail(detail)
        self:showBookActionSheet(detail, { include_page_actions = true })
    end)
end

function Store:chooseStoreLibrary(book, config)
    local dialog
    local buttons = {}
    for _, library in ipairs(config.libraries or {}) do
        local selected_library = library
        buttons[#buttons + 1] = {{ text = selected_library.name, callback = function()
            self:persistSetting("store_library_id", selected_library.id)
            self:persistSetting("store_folder_id", nil)
            UIManager:close(dialog)
            if #(selected_library.folders or {}) > 1 then
                self:chooseStoreFolder(book, config, selected_library)
            else
                self:showStoreAcquire(book)
            end
        end }}
    end
    dialog = ButtonDialog:new{ title = _("Choose library"), buttons = buttons }
    UIManager:show(dialog)
end

function Store:chooseStoreFolder(book, config, library)
    local dialog
    local buttons = {}
    for _, folder in ipairs(library.folders or {}) do
        local folder_id, folder_path = folder.id, folder.path
        buttons[#buttons + 1] = {{ text = folder_path, callback = function()
            self:persistSetting("store_folder_id", folder_id)
            UIManager:close(dialog)
            self:showStoreAcquire(book)
        end }}
    end
    dialog = ButtonDialog:new{ title = _("Choose folder"), buttons = buttons }
    UIManager:show(dialog)
end

function Store:chooseStoreSource(book, config)
    local dialog
    local buttons = {{{ text = _("Automatic"), callback = function()
        self:persistSetting("store_acquisition_source", "auto"); UIManager:close(dialog); self:showStoreAcquire(book)
    end }}}
    for _, source in ipairs(config.sources or {}) do
        local source_id, source_label, source_available = source.source, source.label, source.available
        buttons[#buttons + 1] = {{ text = source_label, enabled = source_available, callback = function()
            self:persistSetting("store_acquisition_source", source_id); UIManager:close(dialog); self:showStoreAcquire(book)
        end }}
    end
    dialog = ButtonDialog:new{ title = _("Choose source"), buttons = buttons }
    UIManager:show(dialog)
end

function Store:activeStoreJobs()
    local jobs = self.settings and self.settings.store_active_jobs
    return type(jobs) == "table" and jobs or {}
end

function Store:persistActiveStoreJobs(jobs)
    self:persistSetting("store_active_jobs", jobs)
end

function Store:storeIntentions()
    return StoreQueue.normalize(self.settings and self.settings.store_queue)
end

function Store:persistStoreIntentions(intentions)
    self:persistSetting("store_queue", intentions)
end

function Store:updateStoreIntention(intent_id, status, fields)
    if not intent_id then return end
    self:persistStoreIntentions(StoreQueue.transition(self:storeIntentions(), intent_id, status, fields))
end

function Store:startStoreBatch(books, action)
    self:loadStoreConfig(function(config)
        local library, folder = self:storeDestination(config)
        if not library then return end
        local batch_id = string.format("batch-%d", os.time())
        local queue = self:storeIntentions()
        for index, book in ipairs(books or {}) do
            if index > STORE_PAGE_SIZE then break end
            if not book.alreadyOwned then
                queue = StoreQueue.enqueue(queue, {
                    external_id = book.externalId, title = book.title, book = book,
                    library_id = library.id, folder_id = folder and folder.id or nil,
                    source = self:storeSource(config), action = action or "download",
                    status = "queued", batch_id = batch_id,
                })
            end
        end
        self:persistStoreIntentions(queue)
        self:processStoreBatch(batch_id)
    end)
end

function Store:mirrorStoreShelf(home)
    local wanted = self.settings.store_mirrored_shelf_id
    if not wanted then return end
    for _, shelf in ipairs((home or {}).personalizedShelves or {}) do
        if shelf.id == wanted and shelf.available ~= false then
            local books = Store.mapBooks(shelf.items)
            Store.overlayDeviceState(self, books)
            self:startStoreBatch(books, "download")
            return
        end
    end
end

function Store:showStoreShelfAvailability(home)
    local lines = {}
    for _, shelf in ipairs((home or {}).personalizedShelves or {}) do
        if shelf.available == false and shelf.message then lines[#lines + 1] = shelf.title .. ": " .. shelf.message end
    end
    UIManager:show(TextViewer:new{
        title = _("Shelf availability"),
        text = #lines > 0 and table.concat(lines, "\n\n") or _("All advertised shelves are available."),
    })
end

function Store:processStoreBatch(batch_id)
    for _, intent in ipairs(self:storeIntentions()) do
        if intent.batch_id == batch_id and intent.status == "acquiring" then return end
    end
    for _, intent in ipairs(self:storeIntentions()) do
        if intent.batch_id == batch_id and intent.status == "queued" then
            self:startStoreAcquisition(intent.book, intent.library_id, intent.folder_id, intent.source, intent.action, intent)
            return
        end
    end
end

function Store:cancelRemainingStoreBatch(batch_id)
    self:persistStoreIntentions(StoreQueue.cancelRemaining(self:storeIntentions(), batch_id))
end

function Store:showStoreCleanupPreview()
    local ConfirmBox = require("ui/widget/confirmbox")
    local entries = {}
    for _, intent in ipairs(self:storeIntentions()) do
        if intent.status == "ready" and intent.book_id and self.on_device and self.on_device[intent.book_id] then
            entries[#entries + 1] = {
                book_id = intent.book_id, title = intent.title,
                local_path = self.on_device[intent.book_id],
                finished_at = intent.updated_at or intent.created_at,
            }
        end
    end
    local candidates = StoreDevice.cleanupPreview(entries, os.time(), self.settings.store_cleanup_age_days or 30)
    if #candidates == 0 then
        UIManager:show(InfoMessage:new{ text = _("No finished Store downloads are eligible for cleanup."), timeout = 3 })
        return
    end
    UIManager:show(ConfirmBox:new{
        text = T(_("Remove %1 finished downloads from this device? They remain in BookOrbit."), #candidates),
        ok_text = _("Remove from device"),
        ok_callback = function()
            for _, entry in ipairs(candidates) do StoreDevice.removeFromDevice(self, entry.book_id) end
        end,
    })
end

function Store:storeJobForBook(external_id)
    for _, entry in ipairs(Store.activeStoreJobs(self)) do
        if entry.external_id == external_id then return entry end
    end
end

function Store:startStoreAcquisition(book, library_id, folder_id, source, action, existing_intent)
    self.store_starting_jobs = self.store_starting_jobs or {}
    if book.alreadyOwned and book.bookId then
        self:showOwnedStoreBook(book)
        return
    end
    if self:storeJobForBook(book.externalId) or self.store_starting_jobs[book.externalId] then
        UIManager:show(InfoMessage:new{ text = _("This book is already being acquired."), timeout = 3 })
        return
    end
    local intentions, intent = StoreQueue.enqueue(self:storeIntentions(), existing_intent or {
        external_id = book.externalId,
        title = book.title,
        book = book,
        library_id = library_id,
        folder_id = folder_id,
        source = source,
        action = action or "get",
        status = "queued",
    })
    self:persistStoreIntentions(intentions)
    self:updateStoreIntention(intent.intent_id, "acquiring")
    self.store_starting_jobs[book.externalId] = true
    self:runConnected(function()
        local job, err = self:fetch(_("Starting acquisition..."), function()
            return self.client:catalogStoreStartAcquisition({
                libraryId = library_id,
                folderId = folder_id,
                title = book.title,
                authors = book.authors,
                isbn10 = book.isbn10,
                isbn13 = book.isbn13,
                source = source,
            })
        end)
        if not job then
            self.store_starting_jobs[book.externalId] = nil
            self:updateStoreIntention(intent.intent_id, "failed", { error = tostring(err or "acquisition_failed") })
            if err ~= "cancelled" then self:showServerError(err) end
            if intent.batch_id then self:processStoreBatch(intent.batch_id) end
            return
        end
        local jobs = self:activeStoreJobs()
        jobs[#jobs + 1] = {
            id = job.id, external_id = book.externalId, title = book.title,
            intent_id = intent.intent_id, action = intent.action,
        }
        self:persistActiveStoreJobs(jobs)
        self:updateStoreIntention(intent.intent_id, "acquiring", { job_id = job.id })
        self.store_starting_jobs[book.externalId] = nil
        Notification:notify(T(_("Getting %1"), book.title))
        self:pollStoreAcquisition(job.id, book.title, intent.intent_id, intent.action)
    end)
end

function Store:removeActiveStoreJob(job_id)
    local keep = {}
    for _, entry in ipairs(self:activeStoreJobs()) do
        if entry.id ~= job_id then keep[#keep + 1] = entry end
    end
    self:persistActiveStoreJobs(keep)
end

function Store:pollStoreAcquisition(job_id, title, intent_id, action)
    self.store_poll_generations = self.store_poll_generations or {}
    self.store_poll_generations[job_id] = (self.store_poll_generations[job_id] or 0) + 1
    local generation = self.store_poll_generations[job_id]
    local function poll()
        if self.catalog_closed or generation ~= self.store_poll_generations[job_id] then return end
        self:runOffThread(function()
            local job, err = self.client:catalogStoreAcquisition(job_id)
            if generation ~= self.store_poll_generations[job_id] then return end
            local tracked_intent = StoreQueue.find(self:storeIntentions(), intent_id)
            local batch_id = tracked_intent and tracked_intent.batch_id
            if not job then
                if err == 404 then
                    self:removeActiveStoreJob(job_id)
                    self:updateStoreIntention(intent_id, "failed", { error = "server_job_lost" })
                    if batch_id then self:processStoreBatch(batch_id) end
                else
                    UIManager:scheduleIn(POLL_SECONDS, poll)
                end
                return
            end
            self.store_recent_jobs = self.store_recent_jobs or {}
            self.store_recent_jobs[job.id] = job
            if Store.jobIsActive(job) then
                UIManager:scheduleIn(POLL_SECONDS, poll)
            else
                self:removeActiveStoreJob(job.id)
                if job.status == "completed" and job.bookId then
                    self:updateStoreIntention(intent_id, "ready", { book_id = job.bookId })
                    Notification:notify(T(_("%1 is ready"), title or job.title))
                    self:showCompletedStoreJob(job, action)
                elseif job.status == "failed" then
                    self:updateStoreIntention(intent_id, "failed", { error = job.error })
                    UIManager:show(InfoMessage:new{ text = job.error or _("Book acquisition failed."), timeout = 5 })
                elseif job.status == "cancelled" then
                    self:updateStoreIntention(intent_id, "cancelled")
                end
                if batch_id then UIManager:nextTick(function() self:processStoreBatch(batch_id) end) end
            end
        end)
    end
    UIManager:scheduleIn(POLL_SECONDS, poll)
end

function Store:resumeStoreAcquisitions()
    for _, entry in ipairs(self:activeStoreJobs()) do
        self:pollStoreAcquisition(entry.id, entry.title, entry.intent_id, entry.action)
    end
end

function Store:showCompletedStoreJob(job, action)
    self:runConnected(function()
        local detail, err = self:fetch(_("Loading imported book..."), function() return self.client:catalogBook(job.bookId) end)
        if not detail then
            if err ~= "cancelled" then self:showServerError(err) end
            return
        end
        self:cacheBookDetail(detail)
        if action == "download" or action == "open" then
            local file = self:supportedFiles(detail)[1]
            if not file then
                self:showBookActionSheet(detail, { include_page_actions = true })
                return
            end
            local block = StoreDevice.checkDownload(self.settings, self:getCurrentDownloadDir(), file.sizeBytes)
            if block then
                UIManager:show(InfoMessage:new{ text = block, timeout = 4 })
                return
            end
            self:downloadDefaultFile(detail, file, { open = action == "open" })
        else
            self:showBookActionSheet(detail, { include_page_actions = true })
        end
    end)
end

function Store:showStoreJob(job)
    local dialog
    local buttons = {}
    if job.status == "completed" and job.bookId then
        buttons[#buttons + 1] = {{ text = _("View in library"), callback = function()
            UIManager:close(dialog); self:showCompletedStoreJob(job)
        end }}
    elseif Store.jobIsCancellable(job) then
        buttons[#buttons + 1] = {{ text = _("Cancel acquisition"), callback = function()
            UIManager:close(dialog)
            self:runConnected(function()
                local cancelled, err = self.client:catalogStoreCancelAcquisition(job.id)
                if cancelled and cancelled.status == "cancelled" then
                    self:removeActiveStoreJob(job.id)
                    return
                end
                if err then self:showServerError(err) end
                local tracked
                for _, entry in ipairs(Store.activeStoreJobs(self)) do if entry.id == job.id then tracked = entry; break end end
                self:pollStoreAcquisition(job.id, job.title, tracked and tracked.intent_id, tracked and tracked.action)
            end)
        end }}
    end
    local attempt_lines = {}
    for _, attempt in ipairs(job.attempts or {}) do attempt_lines[#attempt_lines + 1] = attempt.source .. ": " .. attempt.message end
    dialog = ButtonDialog:new{
        title = T(_("%1\n\nStatus: %2\n%3"), job.title or _("Book"), job.status or _("unknown"), table.concat(attempt_lines, "\n")),
        buttons = buttons,
    }
    UIManager:show(dialog)
end

function Store:showStoreIntention(intent)
    local dialog
    local buttons = {}
    if intent.status == "failed" and intent.book then
        buttons[#buttons + 1] = {{ text = _("Retry same source"), callback = function()
            UIManager:close(dialog)
            intent.status = "queued"
            self:startStoreAcquisition(intent.book, intent.library_id, intent.folder_id, intent.source, intent.action, intent)
        end }, { text = _("Retry another source"), callback = function()
            UIManager:close(dialog)
            intent.status = "queued"; intent.source = "auto"
            self:startStoreAcquisition(intent.book, intent.library_id, intent.folder_id, "auto", intent.action, intent)
        end }}
    end
    if intent.batch_id then buttons[#buttons + 1] = {{ text = _("Cancel remaining batch"), callback = function()
        UIManager:close(dialog); self:cancelRemainingStoreBatch(intent.batch_id)
    end }} end
    dialog = ButtonDialog:new{
        title = T(_("%1\n\nStatus: %2\n%3"), intent.title or _("Book"), intent.status or _("unknown"), intent.error or ""),
        buttons = buttons,
    }
    UIManager:show(dialog)
end

function Store:showStoreQueue()
    self:runConnected(function()
        local jobs, err = self:fetch(_("Loading acquisitions..."), function() return self.client:catalogStoreAcquisitions() end)
        if not jobs then
            if err ~= "cancelled" then self:showServerError(err) end
            return
        end
        local items = {}
        for _, intent in ipairs(self:storeIntentions()) do
            items[#items + 1] = {
                text = T(_("%1 - %2"), intent.title, intent.status),
                kind = "store-intent",
                intent = intent,
            }
        end
        for _, job in ipairs(jobs) do
            items[#items + 1] = {
                text = T(_("%1 - %2"), job.title, job.status),
                kind = "store-job",
                job = job,
            }
        end
        self:switchTo(_("Downloads & acquisitions"), items, {
            kind = "store-jobs",
            title = _("Downloads & acquisitions"),
        }, true)
    end)
end

function Store:showStoreActions()
    local context = self.current_context or {}
    local dialog
    local sorts = { "relevance", "rating", "popularity", "newest", "shortest", "longest" }
    local function nextSort()
        local current = self.settings.store_sort or "relevance"
        for index, value in ipairs(sorts) do
            if value == current then return sorts[index % #sorts + 1] end
        end
        return "relevance"
    end
    dialog = ButtonDialog:new{
        title = _("Book Store"),
        buttons = {
            {{ text = _("Search books"), callback = function() UIManager:close(dialog); self:promptStoreSearch() end }},
            {{ text = _("Browse genres"), callback = function() UIManager:close(dialog); self:showStoreGenres(context.store_home) end }},
            {{ text = T(_("Sort: %1"), self.settings.store_sort or "relevance"), callback = function()
                self:persistSetting("store_sort", nextSort()); UIManager:close(dialog); self:reloadStoreContext(context)
            end }, { text = self.settings.store_ebook_only and _("EPUB only: On") or _("EPUB only: Off"), callback = function()
                self:persistSetting("store_ebook_only", not self.settings.store_ebook_only); UIManager:close(dialog); self:reloadStoreContext(context)
            end }},
            {{ text = _("Get all visible"), callback = function()
                UIManager:close(dialog); self:startStoreBatch(context.books or {}, "download")
            end }, { text = _("Get unread series"), callback = function()
                UIManager:close(dialog)
                local books = {}
                for _, book in ipairs(context.books or {}) do
                    if book.seriesName and not book.alreadyRead then books[#books + 1] = book end
                end
                self:startStoreBatch(books, "download")
            end }},
            {{ text = self.settings.store_wifi_only and _("Wi-Fi only: On") or _("Wi-Fi only: Off"), callback = function()
                self:persistSetting("store_wifi_only", not self.settings.store_wifi_only); UIManager:close(dialog)
            end }, { text = self.settings.store_charging_only and _("Charging only: On") or _("Charging only: Off"), callback = function()
                self:persistSetting("store_charging_only", not self.settings.store_charging_only); UIManager:close(dialog)
            end }},
            {{ text = _("Preview finished-book cleanup"), callback = function()
                UIManager:close(dialog); self:showStoreCleanupPreview()
            end }},
            {{ text = self.settings.store_mirrored_shelf_id == context.store_shelf_id and _("Stop mirroring this shelf") or _("Mirror this shelf on refresh"), callback = function()
                local value = self.settings.store_mirrored_shelf_id == context.store_shelf_id and nil or context.store_shelf_id
                self:persistSetting("store_mirrored_shelf_id", value); UIManager:close(dialog)
            end }, { text = _("Shelf availability"), callback = function()
                UIManager:close(dialog); self:showStoreShelfAvailability(context.store_home)
            end }},
            {{ text = self:storeHideRead() and _("Show read books") or _("Hide read books"), callback = function()
                UIManager:close(dialog)
                self:persistSetting("store_hide_read", not self:storeHideRead())
                self:reloadStoreContext(context)
            end }},
            {{ text = _("Downloads & acquisitions"), callback = function() UIManager:close(dialog); self:showStoreQueue() end }},
            {{ text = _("Refresh"), callback = function() UIManager:close(dialog); self:reloadStoreContext(context) end }},
        },
    }
    UIManager:show(dialog)
end

function Store:reloadStoreContext(context)
    context = context or self.current_context or {}
    if context.kind == "store-index" then
        self:loadStoreHome(false)
    elseif context.store_shelf then
        self:showStoreShelf(context.store_shelf)
    elseif context.store_query then
        self:loadStoreSearch(context.store_query, false)
    elseif context.kind == "store-books" then
        self:loadStoreBrowse(context.store_kind, context.store_value, context.page or 1, context.title, false)
    elseif context.kind == "store-jobs" then
        self:showStoreQueue()
    end
end

function Store:showStoreGenres(home)
    home = home or (self.current_context and self.current_context.store_home) or self:storeCache()
    local dialog
    local buttons = {}
    for _, genre in ipairs((home or {}).genres or {}) do
        local genre_name, genre_slug = genre.name, genre.slug
        buttons[#buttons + 1] = {{ text = genre_name, callback = function()
            UIManager:close(dialog)
            self:loadStoreBrowse("genre", genre_slug, 1, genre_name, true)
        end }}
    end
    dialog = ButtonDialog:new{ title = _("Browse genres"), buttons = buttons }
    UIManager:show(dialog)
end

function Store.install(Catalog)
    for name, fn in pairs(Store) do
        if name ~= "install" then Catalog[name] = fn end
    end
end

return Store
