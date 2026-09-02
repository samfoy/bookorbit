-- Slice 4: what an external Store result and its detail page actually say.
--
-- A Store result is a book the reader does not have yet, so the two questions
-- the page has to answer are "which book is this" and "what happens if I press
-- the big button". Both were vague: cards leaned on a badge suffix appended to
-- the title, and the detail's primary action said "Get & explore" whatever
-- state the book was in.
--
-- These assertions drive the real Store/detail owners rather than grepping for
-- strings: the card builder, the state-dependent action descriptor, the
-- secondary action order, the condensed metadata lines, and the standalone
-- detail's page chrome.

package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path

local function widget()
    return { new = function(_, opts) return opts or {} end }
end

package.loaded["ui/widget/buttondialog"] = widget()
package.loaded["ui/widget/infomessage"] = widget()
package.loaded["ui/widget/inputdialog"] = widget()
package.loaded["ui/widget/notification"] = { notify = function() end }
package.loaded["ui/widget/textviewer"] = widget()
package.loaded["ui/network/manager"] = { isConnected = function() return true end }
local shown = {}
package.loaded["ui/uimanager"] = {
    show = function(_, value) shown[#shown + 1] = value end,
    close = function() end,
    scheduleIn = function() end,
}
package.loaded["ffi/util"] = { template = function(value, a, b)
    local out = tostring(value)
    for index, replacement in ipairs({ a, b }) do
        out = out:gsub("%%" .. index, tostring(replacement or ""))
    end
    return out
end }
package.loaded["gettext"] = function(value) return value end
package.loaded["bookorbit_capabilities"] = { supports = function() return true end }

local Store = require("bookorbit_store")

local function assertEqual(actual, expected, label)
    if actual ~= expected then
        error(string.format("%s: expected %s, got %s", label, tostring(expected), tostring(actual)), 2)
    end
end

local function storeMenu(overrides)
    local menu = {
        on_device = {},
        settings = {},
        storeBookItems = Store.storeBookItems,
        storeJobForBook = function() return nil end,
    }
    for key, value in pairs(overrides or {}) do menu[key] = value end
    return menu
end

local function mapped(raw, menu)
    local books = Store.mapBooks({ raw })
    Store.overlayDeviceState(menu or storeMenu(), books)
    return books[1]
end

local NOT_OWNED = {
    id = "hardcover:1",
    title = "Piranesi",
    authors = { "Susanna Clarke", "Translator Two" },
    publishedYear = 2020,
    pageCount = 245,
    language = "en",
    rating = 4.2,
    seriesName = "Standalone",
    seriesPosition = 1,
    sources = { { source = "hardcover", externalId = "hc-1" } },
    genres = { { name = "Fantasy", slug = "fantasy" } },
    description = "A house of endless halls.",
    state = {},
}

-- 1. Cards name the book. A result row must expose the title and the primary
-- author as separate, reliable fields, with the state badge kept as its own
-- concise value rather than glued onto the title.
local card = Store.storeBookItems(storeMenu(), { mapped(NOT_OWNED) })[1]
assertEqual(card.kind, "store-book", "a result row stays a selectable store book")
assertEqual(card.title, "Piranesi", "a result card must expose the title on its own")
assertEqual(card.author, "Susanna Clarke", "a result card must expose the primary author")
assertEqual(card.badge, "Get", "a result card must carry a concise state badge")
assert(card.text:find("Piranesi", 1, true), "the rendered row must still name the book")
assert(card.text:find("Susanna Clarke", 1, true),
    "the rendered row must name the primary author, not only the title")

local untitled = Store.storeBookItems(storeMenu(), { mapped({ id = "hardcover:2", state = {} }) })[1]
assertEqual(untitled.title, "Untitled", "a book with no title still names itself")
assertEqual(untitled.author, nil, "a book with no author exposes no author field")
assert(not untitled.text:find(" - $"),
    "a missing author must not leave a dangling separator on the row")

-- 2. The detail's primary action is explicit and state-dependent.
local function primary(raw, menu)
    return Store.storePrimaryAction(menu or storeMenu(), mapped(raw, menu))
end

local get = primary(NOT_OWNED)
assertEqual(get.text, "Get", "a book the reader does not own offers Get")
assertEqual(get.action, "get", "and it routes to the acquisition path")
assertEqual(get.enabled, true, "Get is actionable")
for _, descriptor in ipairs({ get }) do
    assert(not tostring(descriptor.text):find("explore"),
        "the primary action must never use the vague Get & explore wording")
end

local owned = primary({
    id = "hardcover:3", title = "Owned", authors = { "A" },
    state = { inBookOrbit = true, alreadyOwned = true, bookId = 42 },
})
assertEqual(owned.text, "Download", "an owned BookOrbit book not on the device offers Download")
assertEqual(owned.action, "download", "and it routes to the owned-book handoff")
assertEqual(owned.enabled, true)

local on_device_menu = storeMenu({ on_device = { [42] = "/mnt/onboard/owned.epub" } })
local on_device = primary({
    id = "hardcover:4", title = "On device", authors = { "A" },
    state = { inBookOrbit = true, alreadyOwned = true, bookId = 42, localFormats = { "epub" } },
}, on_device_menu)
assertEqual(on_device.text, "Open", "a copy already on the device offers Open")
assertEqual(on_device.action, "open", "and it routes to the local open lifecycle")
assertEqual(on_device.path, "/mnt/onboard/owned.epub", "Open knows the file it opens")

-- "On device" is only honest when there is genuinely nothing to do: the book is
-- on the device but the plugin has no path to open.
local stranded_menu = storeMenu({ on_device = {} })
local stranded = Store.storePrimaryAction(stranded_menu, (function()
    local book = mapped({
        id = "hardcover:5", title = "Stranded", authors = { "A" },
        state = { inBookOrbit = true, alreadyOwned = true, bookId = 7 },
    }, stranded_menu)
    book.onDevice = true
    book.localPath = nil
    return book
end)())
assertEqual(stranded.text, "On device", "a genuinely non-actionable on-device state says so")
assertEqual(stranded.enabled, false, "and it is not offered as an action")

local acquiring_menu = storeMenu({ storeJobForBook = function() return { id = 1, status = "downloading" } end })
local acquiring = primary(NOT_OWNED, acquiring_menu)
assertEqual(acquiring.text, "Getting", "a book already being acquired reports its own progress")
assertEqual(acquiring.enabled, false, "and does not offer a duplicate Get")

-- 3. Secondary actions follow the primary in a required order.
local order = Store.storeSecondaryActions(storeMenu(), mapped(NOT_OWNED))
local labels = {}
for index, entry in ipairs(order) do labels[index] = entry.text end
assertEqual(labels[1], "Description", "Description follows the primary action")
assertEqual(labels[2], "More by Susanna Clarke", "then More by the primary author")
assertEqual(labels[3], "Similar books", "then Similar books")
assertEqual(labels[4], "Fantasy", "then one genre browse action when available")
assertEqual(#order, 4, "and nothing else is promoted to the secondary block")

local sparse = Store.storeSecondaryActions(storeMenu(), mapped({
    id = "hardcover:6", title = "Sparse", state = {},
}))
assertEqual(#sparse, 1, "a book with no author, source, or genre offers only Description")
assertEqual(sparse[1].text, "Description")

local storygraph_only = Store.storeSecondaryActions(storeMenu(), mapped({
    id = "storygraph:1", title = "Story Book", authors = { "Story Author" },
    genres = { { name = "Fantasy", slug = "fantasy" } },
    sources = { { source = "storygraph", externalId = "sg-1" } }, state = {},
}))
assertEqual(#storygraph_only, 1,
    "StoryGraph-only results must not offer Hardcover-owned author or genre browse actions")
assertEqual(storygraph_only[1].text, "Description")

-- 4. Secondary metadata condenses to at most two lines and hides empty fields.
local lines = Store.storeDetailMetaLines(mapped(NOT_OWNED))
assert(#lines <= 2, "external detail metadata must fit two concise lines")
assertEqual(#lines, 2, "a fully populated book fills both lines")
assert(lines[1]:find("2020", 1, true), "the first line carries series/year/pages/language")
assert(lines[1]:find("245", 1, true))
assert(lines[2]:find("4.2", 1, true), "the second line carries rating and provider")
assert(lines[2]:find("Hardcover", 1, true))

local bare = Store.storeDetailMetaLines(mapped({ id = "hardcover:7", title = "Bare", state = {} }))
assertEqual(#bare, 0, "a book with no metadata renders no empty placeholder lines")
for _, line in ipairs(bare) do
    assert(not line:find("Not rated"), "an unrated external book must not print Not rated")
end
local reception_only = Store.storeDetailMetaLines(mapped({
    id = "hardcover:rating", title = "Rated", rating = 4.8,
    sources = { { source = "hardcover", externalId = "hc-rating" } }, state = {},
}))
assertEqual(#reception_only, 1, "rating/provider metadata survives when the identity line is empty")
assertEqual(reception_only[1], "4.8 - Hardcover")
local empty_strings = Store.storeDetailMetaLines(mapped({
    id = "hardcover:empty", title = "Empty", seriesName = "", language = "", state = {},
}))
assertEqual(#empty_strings, 0, "empty strings do not render a separator-only metadata line")

-- 5. A standalone external detail carries no catalog pagination chrome.
local detail = Store.storeDetail(mapped(NOT_OWNED))
assertEqual(detail.external, true, "the detail is still an external detail")
assertEqual(detail.standalone, true,
    "an external detail reached from a Store result is standalone, so Book 1 of 1 is meaningless")
assertEqual(detail.hasCover, nil, "the detail must not invent cover placeholder state")

-- 6. The action sheet keeps the primary action first and routes every action
-- through existing Store owners rather than duplicating lifecycle logic.
local routed = {}
local action_menu = storeMenu({
    storePrimaryAction = Store.storePrimaryAction,
    storeSecondaryActions = Store.storeSecondaryActions,
    runStorePrimaryAction = Store.runStorePrimaryAction,
    runStoreSecondaryAction = Store.runStoreSecondaryAction,
    showStoreAcquire = function(_, book) routed[#routed + 1] = { "get", book } end,
    showOwnedStoreBook = function(_, book) routed[#routed + 1] = { "download", book } end,
    openDownloadedFile = function(_, path) routed[#routed + 1] = { "open", path } end,
    storeDescription = function() return "Description" end,
    loadStoreBrowse = function(_, kind, value) routed[#routed + 1] = { kind, value } end,
})
action_menu.showStoreBookActions = Store.showStoreBookActions

action_menu:showStoreBookActions(mapped(NOT_OWNED))
local action_dialog = shown[#shown]
local action_labels = {}
for _, row in ipairs(action_dialog.buttons) do action_labels[#action_labels + 1] = row[1].text end
assertEqual(table.concat(action_labels, "|"),
    "Get|Description|More by Susanna Clarke|Similar books|Fantasy",
    "primary and secondary actions render in the required order")
action_dialog.buttons[1][1].callback()
assertEqual(routed[#routed][1], "get", "Get reuses the acquisition owner")

local owned_book = mapped({
    id = "hardcover:8", title = "Owned", authors = { "A" },
    state = { inBookOrbit = true, alreadyOwned = true, bookId = 42 },
})
action_menu:showStoreBookActions(owned_book)
shown[#shown].buttons[1][1].callback()
assertEqual(routed[#routed][1], "download", "Download reuses the owned-book handoff")

local open_book = mapped({
    id = "hardcover:9", title = "Open", authors = { "A" },
    state = { inBookOrbit = true, alreadyOwned = true, bookId = 42 },
}, on_device_menu)
action_menu.on_device = on_device_menu.on_device
Store.overlayDeviceState(action_menu, { open_book })
action_menu:showStoreBookActions(open_book)
shown[#shown].buttons[1][1].callback()
assertEqual(routed[#routed][1], "open", "Open reuses the local file lifecycle")
assertEqual(routed[#routed][2], "/mnt/onboard/owned.epub")

print("bookorbit_store_detail_test.lua: ok")
