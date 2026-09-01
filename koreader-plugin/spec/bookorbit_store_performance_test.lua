package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path

local connected = true

local function widget()
    return { new = function(_, opts) return opts or {} end }
end

package.loaded["ui/widget/buttondialog"] = widget()
package.loaded["ui/widget/infomessage"] = widget()
package.loaded["ui/widget/inputdialog"] = widget()
package.loaded["ui/widget/notification"] = { notify = function() end }
package.loaded["ui/widget/textviewer"] = widget()
package.loaded["ui/network/manager"] = { isConnected = function() return connected end }
package.loaded["ui/uimanager"] = {
    show = function() end,
    close = function() end,
    scheduleIn = function() end,
}
package.loaded["ffi/util"] = { template = function(value) return value end }
package.loaded["gettext"] = function(value) return value end
package.loaded["bookorbit_capabilities"] = { supports = function() return true end }

local Store = require("bookorbit_store")

local cached = {
    trending = { title = "Cached shelf", items = {} },
    genreShelves = {},
    personalizedShelves = {},
}
local fresh = {
    trending = { title = "Fresh shelf", items = {} },
    genreShelves = {},
    personalizedShelves = {},
}
local callbacks = {}
local switches = {}
local persisted
local fetches = 0
local menu = {
    catalog_closed = false,
    settings = { store_home_cache = cached },
    on_device = {},
    storeCache = Store.storeCache,
    cacheStoreHome = Store.cacheStoreHome,
    nextStoreRequestGeneration = Store.nextStoreRequestGeneration,
    storeRequestIsCurrent = Store.storeRequestIsCurrent,
    storeHomeItems = Store.storeHomeItems,
    storeBookItems = Store.storeBookItems,
    storeJobForBook = function() return nil end,
    persistSetting = function(self, key, value)
        self.settings[key] = value
        persisted = { key = key, value = value }
    end,
    runConnected = function(_, callback) callbacks[#callbacks + 1] = callback end,
    fetch = function(_, _, callback)
        fetches = fetches + 1
        return callback()
    end,
    client = { catalogStoreHome = function() return fresh end },
    switchTo = function(_, _, _, context, push)
        switches[#switches + 1] = { context = context, push = push }
    end,
    mirrorStoreShelf = function() end,
    resumeStoreAcquisitions = function() end,
    storeHideRead = function() return true end,
}

Store.loadStoreHome(menu, true)
assert(#switches == 1, "cached Store home must render before the connected callback runs")
assert(#callbacks == 1, "connected refresh must be deferred through runConnected")
assert(switches[1].context.store_home == cached, "the synchronous render must use cached shelves")
assert(switches[1].context.stale == true, "cached connected content must be marked stale")
assert(switches[1].context.refreshing == true, "cached connected content must be marked refreshing")
assert(switches[1].context.subtitle:find("refreshing", 1, true), "connected cache subtitle must explain refresh state")

callbacks[1]()
assert(fetches == 1, "the deferred callback must fetch fresh Store home data")
assert(#switches == 2, "fresh Store home must replace cached content")
assert(switches[2].context.store_home == fresh, "the replacement must use fresh shelves")
assert(switches[2].push == false, "fresh Store home must replace cached navigation in place")
assert(persisted and persisted.key == "store_home_cache" and persisted.value == fresh,
    "fresh Store home must be persisted")

callbacks = {}
switches = {}
fetches = 0
persisted = nil
menu.settings.store_home_cache = cached
Store.loadStoreHome(menu, true)
Store.loadStoreHome(menu, true)
assert(#switches == 2, "each reload may synchronously repaint its cached Store page")
callbacks[1]()
assert(fetches == 0, "a stale connected callback must not start a network request")
callbacks[2]()
assert(fetches == 1, "the current connected callback must fetch once")
assert(#switches == 3 and switches[3].context.store_home == fresh,
    "only the current response may replace cached navigation")

print("bookorbit_store_performance_test.lua: ok")
