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

local personalized_home = {
    personalizedShelves = {
        { id = "for-you", title = "For You", kind = "for-you", items = { {
            id = "hardcover:99", title = "Jonathan Strange", authors = { "Susanna Clarke" },
            recommendationReason = "More by Susanna Clarke",
        } } },
        { id = "up-next-series", title = "Up Next in Your Series", kind = "up-next", items = { {
            id = "bookorbit:42", title = "The Tombs of Atuan", authors = { "Ursula K. Le Guin" },
            recommendationReason = "Next in the Earthsea Cycle series",
            state = { inBookOrbit = true, alreadyOwned = true, bookId = 42, localFormats = { "epub" } },
        } } },
    },
    trending = { title = "Trending", kind = "trending", items = {} },
    genreShelves = {},
}
local home_menu = {
    on_device = {},
    storeBookItems = Store.storeBookItems,
    storeJobForBook = function() return nil end,
}
local _, for_you_context = Store.storeHomeItems(home_menu, personalized_home, false, 1)
local _, up_next_context = Store.storeHomeItems(home_menu, personalized_home, false, 2)
assert(for_you_context.subtitle == "For You", "personalized shelves must lead Store home")
assert(for_you_context.books[1].recommendationReason == "More by Susanna Clarke")
assert(up_next_context.books[1].alreadyOwned == true, "strict up-next shelf retains local ownership")

print("bookorbit_store_phase2_test.lua: slice 1 ok")
