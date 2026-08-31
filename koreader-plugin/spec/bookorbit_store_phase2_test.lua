package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path

local shown = {}
local function widget()
    return { new = function(_, opts) return opts or {} end }
end

package.loaded["ui/widget/buttondialog"] = widget()
package.loaded["ui/widget/infomessage"] = widget()
package.loaded["ui/widget/inputdialog"] = widget()
package.loaded["ui/widget/notification"] = { notify = function(message) shown[#shown + 1] = message end }
package.loaded["ui/widget/textviewer"] = widget()
package.loaded["ui/network/manager"] = { isConnected = function() return true end }
package.loaded["ui/uimanager"] = { show = function(_, value) shown[#shown + 1] = value end, close = function() end }
package.loaded["ffi/util"] = { template = function(value) return value end }
package.loaded["gettext"] = function(value) return value end
package.loaded["bookorbit_capabilities"] = { supports = function() return true end }

local Store = require("bookorbit_store")

local mapped = Store.mapBooks({ {
    id = "hardcover:10",
    title = "Piranesi",
    authors = { "Susanna Clarke" },
    state = {
        inBookOrbit = true,
        bookId = 42,
        localFormats = { "epub" },
        bookOrbitStatus = "reading",
        progressPercentage = 35,
        hardcoverStatus = "want_to_read",
        storygraphStatus = nil,
        alreadyRead = false,
        alreadyOwned = true,
    },
} })[1]
assert(mapped.bookId == 42, "server-owned result must retain its local BookOrbit id")
assert(mapped.onDevice == false, "device state starts absent before the local map overlay")

local overlay_menu = {
    on_device = { [42] = "/books/Piranesi.epub" },
    isOnDevice = function(self, book) return self.on_device[book.bookId] ~= nil end,
}
Store.overlayDeviceState(overlay_menu, { mapped })
assert(mapped.onDevice == true, "the existing on-device book map must overlay server state")
assert(mapped.localPath == "/books/Piranesi.epub")
assert(Store.stateBadge(overlay_menu, mapped, false) == "On Device")
assert(Store.stateBadge(overlay_menu, mapped, true) == "Acquiring")

local opened, posted = 0, 0
local owned_menu = {
    showOwnedStoreBook = function(_, book) opened = opened + book.bookId end,
    loadStoreConfig = function() posted = posted + 1 end,
}
Store.showStoreAcquire(owned_menu, mapped)
assert(opened == 42, "Get on an owned result must hand off to the local catalog")
assert(posted == 0, "owned results must never reach acquisition POST setup")

local repeated_menu = {
    store_starting_jobs = { [mapped.externalId] = true },
    storeJobForBook = function() return nil end,
    activeStoreJobs = function() return {} end,
    runConnected = function() posted = posted + 1 end,
}
local unowned = Store.mapBooks({ { id = mapped.externalId, title = mapped.title, authors = mapped.authors } })[1]
Store.startStoreAcquisition(repeated_menu, unowned, 1, nil, "auto")
assert(posted == 0, "rapid repeated taps must still be blocked before POST")

print("bookorbit_store_phase2_test.lua: slice 1 ok")
