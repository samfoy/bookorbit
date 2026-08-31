package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path

local shown = {}
local scheduled = {}
local store_supported = true
local connected = true

local function widget()
    return { new = function(_, opts) return opts or {} end }
end

package.loaded["ui/widget/buttondialog"] = widget()
package.loaded["ui/widget/infomessage"] = widget()
package.loaded["ui/widget/inputdialog"] = widget()
package.loaded["ui/widget/notification"] = { notify = function(message) shown[#shown + 1] = message end }
package.loaded["ui/widget/textviewer"] = widget()
package.loaded["ui/network/manager"] = { isConnected = function() return connected end }
package.loaded["ui/uimanager"] = {
    show = function(_, value) shown[#shown + 1] = value end,
    close = function() end,
    scheduleIn = function(_, delay, callback) scheduled[#scheduled + 1] = { delay = delay, callback = callback } end,
}
package.loaded["ffi/util"] = { template = function(value, a, b, c)
    local out = value
    for i, replacement in ipairs({ a, b, c }) do out = out:gsub("%%" .. i, tostring(replacement or "")) end
    return out
end }
package.loaded["gettext"] = function(value) return value end
package.loaded["bookorbit_capabilities"] = { supports = function() return store_supported end }

local Store = require("bookorbit_store")

local books = Store.mapBooks({ {
    id = "hardcover:10",
    title = "Piranesi",
    authors = { "Susanna Clarke" },
    genres = { { name = "Fantasy", slug = "fantasy" } },
    sources = { { source = "hardcover", externalId = "10" } },
} })
assert(#books == 1)
assert(books[1].external == true)
assert(books[1].externalId == "hardcover:10")
assert(books[1].author == "Susanna Clarke")
assert(Store.jobIsActive({ status = "downloading" }) == true)
assert(Store.jobIsActive({ status = "completed" }) == false)
assert(Store.jobIsCancellable({ status = "optimizing" }) == true)
assert(Store.jobIsCancellable({ status = "importing" }) == false)

local external_detail = Store.storeDetail(books[1])
assert(external_detail.external == true)
assert(external_detail.storeBook == books[1])
assert(external_detail.genres[1] == "Fantasy")
assert(external_detail.tags[1] == "Hardcover")
local shown_detail
Store.showStoreBook({ showBookDetail = function(_, detail) shown_detail = detail end }, books[1])
assert(shown_detail == external_detail or (shown_detail and shown_detail.external), "Store selection must open the native detail page")

local home_menu = { storeBookItems = Store.storeBookItems }
local home = {
    trending = { title = "Trending this week", items = { books[1] } },
    genreShelves = { { title = "Fantasy", kind = "genre", value = "fantasy", items = { books[1] } } },
}
local _, trending_context = Store.storeHomeItems(home_menu, home, false, 1)
local _, fantasy_context = Store.storeHomeItems(home_menu, home, false, 2)
assert(trending_context.page_count == 2, "Store landing must page through trending and genre shelves")
assert(fantasy_context.subtitle == "Fantasy", "Store landing second shelf must render the genre shelf")

local persisted
local client_calls = 0
local menu = {
    settings = { store_active_jobs = { { id = "active-1", external_id = "hardcover:10", title = "Piranesi" } } },
    activeStoreJobs = Store.activeStoreJobs,
    storeJobForBook = Store.storeJobForBook,
    persistSetting = function(_, key, value) persisted = { key = key, value = value } end,
    runConnected = function(_, callback) callback() end,
    client = { catalogStoreStartAcquisition = function() client_calls = client_calls + 1 end },
}
Store.startStoreAcquisition(menu, books[1], 1, nil, "auto")
assert(client_calls == 0, "a second tap must not create a duplicate job")
assert(#shown > 0, "duplicate acquisition should be explained")
assert(persisted == nil, "duplicate acquisition must not rewrite active state")

local pending_starts = {}
local racing_menu = {
    settings = { store_active_jobs = {} },
    activeStoreJobs = Store.activeStoreJobs,
    storeJobForBook = Store.storeJobForBook,
    persistActiveStoreJobs = Store.persistActiveStoreJobs,
    persistSetting = function(self, key, value) self.settings[key] = value end,
    runConnected = function(_, callback) pending_starts[#pending_starts + 1] = callback end,
    fetch = function(_, _, callback) return callback() end,
    client = { catalogStoreStartAcquisition = function()
        client_calls = client_calls + 1
        return { id = "job-" .. client_calls, status = "queued" }
    end },
    pollStoreAcquisition = function() end,
}
client_calls = 0
Store.startStoreAcquisition(racing_menu, books[1], 1, nil, "auto")
Store.startStoreAcquisition(racing_menu, books[1], 1, nil, "auto")
assert(#pending_starts == 1, "rapid duplicate taps must schedule only one acquisition request")
pending_starts[1]()
assert(client_calls == 1, "only one acquisition POST may run for one external book")

local pending_searches = {}
local search_menu = {
    catalog_closed = false,
    runConnected = function(_, callback) pending_searches[#pending_searches + 1] = callback end,
    fetch = function(_, _, callback) return callback() end,
    client = { catalogStoreSearch = function(_, query)
        return { results = { { id = query, title = query, authors = {} } }, sources = {} }
    end },
    nextStoreRequestGeneration = Store.nextStoreRequestGeneration,
    storeRequestIsCurrent = Store.storeRequestIsCurrent,
    storeBookItems = Store.storeBookItems,
    switchTo = function(self, _, _, context) self.current_context = context end,
}
Store.loadStoreSearch(search_menu, "old", true)
Store.loadStoreSearch(search_menu, "new", true)
pending_searches[2]()
pending_searches[1]()
assert(search_menu.current_context.store_query == "new", "a stale response must not replace newer Store navigation")

shown = {}
local removed_jobs, resumed_jobs, cancellation_errors = 0, 0, 0
local cancel_menu = {
    runConnected = function(_, callback) callback() end,
    client = { catalogStoreCancelAcquisition = function() return nil, 409 end },
    removeActiveStoreJob = function() removed_jobs = removed_jobs + 1 end,
    pollStoreAcquisition = function() resumed_jobs = resumed_jobs + 1 end,
    showServerError = function() cancellation_errors = cancellation_errors + 1 end,
}
Store.showStoreJob(cancel_menu, { id = "job-1", title = "Piranesi", status = "downloading" })
shown[#shown].buttons[1][1].callback()
assert(removed_jobs == 0, "a failed cancellation must retain the active job")
assert(resumed_jobs == 1, "a failed cancellation must resume job polling")
assert(cancellation_errors == 1, "a failed cancellation must be visible")

local selected_library, selected_folder = Store.storeDestination({
    settings = { store_library_id = 2, store_folder_id = 22 },
}, {
    libraries = {
        { id = 1, name = "One", folders = { { id = 11, path = "/one" } } },
        { id = 2, name = "Two", folders = { { id = 21, path = "/two/default" }, { id = 22, path = "/two/chosen" } } },
    },
})
assert(selected_library and selected_library.id == 2, "stored library must be selected")
assert(selected_folder and selected_folder.id == 22, "stored folder must be selected")

store_supported = nil
connected = false
local loaded_offline = false
local offline_menu = {
    settings = { store_home_cache = { trending = { items = {} } } },
    storeCache = Store.storeCache,
    storeSupported = Store.storeSupported,
    loadStoreHome = function(_, push)
        loaded_offline = push == true
    end,
}
Store.openBookStore(offline_menu)
assert(loaded_offline, "cached Store must remain reachable while offline and capability status is unknown")

print("bookorbit_store_test.lua: ok")
