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

local Store = {}
local STORE_PAGE_SIZE = 12
local POLL_SECONDS = 2.5
local ACTIVE_STATUS = { queued = true, downloading = true, optimizing = true, importing = true }
local CANCELLABLE_STATUS = { queued = true, downloading = true, optimizing = true }

local function firstAuthor(book)
    return type(book.authors) == "table" and book.authors[1] or nil
end

local function externalBook(book)
    book = book or {}
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
        seriesName = book.seriesName,
        seriesIndex = book.seriesPosition,
        genres = book.genres or {},
        sources = book.sources or {},
        coverUrl = book.coverUrl,
        hasCover = type(book.coverUrl) == "string" and book.coverUrl:match("^https://") ~= nil,
        external = true,
        externalId = tostring(book.id or ""),
    }
end

function Store.mapBooks(items)
    local books = {}
    for _, item in ipairs(items or {}) do books[#books + 1] = externalBook(item) end
    return books
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

function Store:storeHideRead()
    return self.settings.store_hide_read ~= false
end

function Store:storeCache()
    return type(self.settings.store_home_cache) == "table" and self.settings.store_home_cache or nil
end

function Store:cacheStoreHome(body)
    if type(body) == "table" then self:persistSetting("store_home_cache", body) end
end

function Store:storeHomeItems(body, stale)
    local trending = body and body.trending or {}
    local books = Store.mapBooks(trending.items)
    return self:storeBookItems(books), {
        kind = "store-books",
        title = _("Book Store"),
        subtitle = stale and _("Trending this week - offline cache") or _("Trending this week"),
        books = books,
        page = 1,
        page_count = 1,
        store_kind = "trending",
        store_landing = true,
        store_home = body,
        stale = stale == true,
    }
end

function Store:openBookStore()
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
    if cached and not NetworkMgr:isConnected() then
        local items, context = self:storeHomeItems(cached, true)
        self:switchTo(context.title, items, context, push)
        return
    end
    self:runConnected(function()
        local body, err = self:fetch(_("Loading Book Store..."), function()
            return self.client:catalogStoreHome(self:storeHideRead())
        end)
        if not body then
            if cached then
                local items, context = self:storeHomeItems(cached, true)
                self:switchTo(context.title, items, context, push)
            elseif err ~= "cancelled" then
                self:showRetry(err, function() self:loadStoreHome(push) end)
            end
            return
        end
        self:cacheStoreHome(body)
        local items, context = self:storeHomeItems(body, false)
        self:switchTo(context.title, items, context, push)
        self:resumeStoreAcquisitions()
    end)
end

function Store:storeBookItems(books)
    local items = {}
    for _, book in ipairs(books or {}) do
        items[#items + 1] = { text = book.title, kind = "store-book", book = book }
    end
    return items
end

function Store:loadStoreBrowse(kind, value, page, title, push)
    page = page or 1
    self:runConnected(function()
        local body, err = self:fetch(_("Loading books..."), function()
            return self.client:catalogStoreBrowse({
                kind = kind,
                value = value,
                page = page,
                pageSize = STORE_PAGE_SIZE,
                hideRead = self:storeHideRead(),
            })
        end)
        if not body then
            if err ~= "cancelled" then self:showRetry(err, function() self:loadStoreBrowse(kind, value, page, title, push) end) end
            return
        end
        local books = Store.mapBooks(body.items)
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

function Store:promptStoreSearch()
    local dialog
    dialog = InputDialog:new{
        title = _("Search Hardcover and StoryGraph"),
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

function Store:loadStoreSearch(query, push)
    self:runConnected(function()
        local body, err = self:fetch(_("Searching books..."), function()
            return self.client:catalogStoreSearch(query, "hardcover,storygraph")
        end)
        if not body then
            if err ~= "cancelled" then self:showRetry(err, function() self:loadStoreSearch(query, push) end) end
            return
        end
        local books = Store.mapBooks(body.results)
        local unavailable = {}
        for _, source in ipairs(body.sources or {}) do
            if source.available == false then unavailable[#unavailable + 1] = source.source end
        end
        local context = {
            kind = "store-books",
            title = T(_("Search: %1"), query),
            subtitle = #unavailable > 0 and T(_("Unavailable: %1"), table.concat(unavailable, ", ")) or nil,
            books = books,
            store_query = query,
            page = 1,
            page_count = 1,
        }
        self:switchTo(context.title, self:storeBookItems(books), context, push)
    end)
end

function Store:storeDescription(book)
    local lines = { book.title or _("Untitled") }
    if firstAuthor(book) then lines[#lines + 1] = firstAuthor(book) end
    if book.seriesName then lines[#lines + 1] = book.seriesName end
    if book.publishedYear then lines[#lines + 1] = tostring(book.publishedYear) end
    if book.rating then lines[#lines + 1] = T(_("Rating: %1"), tostring(book.rating)) end
    if book.pageCount then lines[#lines + 1] = T(_("Pages: %1"), tostring(book.pageCount)) end
    if book.description then lines[#lines + 1] = "\n" .. book.description end
    return table.concat(lines, "\n")
end

function Store:showStoreBook(book)
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
            local folder = library.folders and library.folders[1]
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
                {{ text = _("Get book"), callback = function()
                    UIManager:close(dialog)
                    self:startStoreAcquisition(book, library.id, folder and folder.id or nil, source)
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

function Store:chooseStoreLibrary(book, config)
    local dialog
    local buttons = {}
    for _, library in ipairs(config.libraries or {}) do
        local library_id, library_name = library.id, library.name
        buttons[#buttons + 1] = {{ text = library_name, callback = function()
            self:persistSetting("store_library_id", library_id)
            UIManager:close(dialog)
            self:showStoreAcquire(book)
        end }}
    end
    dialog = ButtonDialog:new{ title = _("Choose library"), buttons = buttons }
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
    local jobs = self.settings.store_active_jobs
    return type(jobs) == "table" and jobs or {}
end

function Store:persistActiveStoreJobs(jobs)
    self:persistSetting("store_active_jobs", jobs)
end

function Store:storeJobForBook(external_id)
    for _, entry in ipairs(self:activeStoreJobs()) do
        if entry.external_id == external_id then return entry end
    end
end

function Store:startStoreAcquisition(book, library_id, folder_id, source)
    if self:storeJobForBook(book.externalId) then
        UIManager:show(InfoMessage:new{ text = _("This book is already being acquired."), timeout = 3 })
        return
    end
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
            if err ~= "cancelled" then self:showServerError(err) end
            return
        end
        local jobs = self:activeStoreJobs()
        jobs[#jobs + 1] = { id = job.id, external_id = book.externalId, title = book.title }
        self:persistActiveStoreJobs(jobs)
        Notification:notify(T(_("Getting %1"), book.title))
        self:pollStoreAcquisition(job.id, book.title)
    end)
end

function Store:removeActiveStoreJob(job_id)
    local keep = {}
    for _, entry in ipairs(self:activeStoreJobs()) do
        if entry.id ~= job_id then keep[#keep + 1] = entry end
    end
    self:persistActiveStoreJobs(keep)
end

function Store:pollStoreAcquisition(job_id, title)
    self.store_poll_generations = self.store_poll_generations or {}
    self.store_poll_generations[job_id] = (self.store_poll_generations[job_id] or 0) + 1
    local generation = self.store_poll_generations[job_id]
    local function poll()
        if self.catalog_closed or generation ~= self.store_poll_generations[job_id] then return end
        self:runOffThread(function()
            local job, err = self.client:catalogStoreAcquisition(job_id)
            if generation ~= self.store_poll_generations[job_id] then return end
            if not job then
                if err == 404 then
                    self:removeActiveStoreJob(job_id)
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
                    Notification:notify(T(_("%1 is ready"), title or job.title))
                    self:showCompletedStoreJob(job)
                elseif job.status == "failed" then
                    UIManager:show(InfoMessage:new{ text = job.error or _("Book acquisition failed."), timeout = 5 })
                end
            end
        end)
    end
    UIManager:scheduleIn(POLL_SECONDS, poll)
end

function Store:resumeStoreAcquisitions()
    for _, entry in ipairs(self:activeStoreJobs()) do
        self:pollStoreAcquisition(entry.id, entry.title)
    end
end

function Store:showCompletedStoreJob(job)
    self:runConnected(function()
        local detail, err = self:fetch(_("Loading imported book..."), function() return self.client:catalogBook(job.bookId) end)
        if not detail then
            if err ~= "cancelled" then self:showServerError(err) end
            return
        end
        self:cacheBookDetail(detail)
        self:showBookActionSheet(detail, { include_page_actions = true })
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
                self.client:catalogStoreCancelAcquisition(job.id)
                self:removeActiveStoreJob(job.id)
            end)
        end }}
    end
    dialog = ButtonDialog:new{
        title = T(_("%1\n\nStatus: %2"), job.title or _("Book"), job.status or _("unknown")),
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
    dialog = ButtonDialog:new{
        title = _("Book Store"),
        buttons = {
            {{ text = _("Search books"), callback = function() UIManager:close(dialog); self:promptStoreSearch() end }},
            {{ text = _("Browse genres"), callback = function() UIManager:close(dialog); self:showStoreGenres(context.store_home) end }},
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
    if context.store_landing or context.kind == "store-home" then
        self:loadStoreHome(false)
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
