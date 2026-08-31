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
