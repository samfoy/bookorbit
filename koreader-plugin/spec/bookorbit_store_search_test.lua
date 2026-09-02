package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path

local function widget()
    return { new = function(_, opts) return opts or {} end }
end

package.loaded["ui/widget/buttondialog"] = widget()
package.loaded["ui/widget/infomessage"] = widget()
package.loaded["ui/widget/inputdialog"] = { new = function(_, opts)
    opts = opts or {}
    opts.onShowKeyboard = function() end
    opts.getInputText = function() return opts.input or "" end
    return opts
end }
package.loaded["ui/widget/notification"] = { notify = function() end }
package.loaded["ui/widget/textviewer"] = widget()
package.loaded["ui/network/manager"] = { isConnected = function() return true end }
package.loaded["ui/uimanager"] = { show = function() end, close = function() end }
package.loaded["ffi/util"] = { template = function(value, replacement)
    return value:gsub("%%1", tostring(replacement or ""))
end }
package.loaded["gettext"] = function(value) return value end
package.loaded["bookorbit_capabilities"] = { supports = function() return true end }

local Store = require("bookorbit_store")
local pending = {}
local calls = {}
local menu = {
    catalog_closed = false,
    settings = { store_hide_read = true, store_active_jobs = {} },
    runConnected = function(_, callback) pending[#pending + 1] = callback end,
    fetch = function(_, _, callback) return callback() end,
    client = { catalogStoreSearch = function(_, query, sources, hide_read)
        calls[#calls + 1] = { query = query, sources = sources, hide_read = hide_read }
        return {
            results = { {
                id = "hardcover:read",
                title = query,
                authors = { "Exact Author" },
                state = {
                    inBookOrbit = true,
                    bookId = 42,
                    localFormats = { "epub" },
                    alreadyRead = true,
                    alreadyOwned = true,
                },
            } },
            sources = {},
        }
    end },
    nextStoreRequestGeneration = Store.nextStoreRequestGeneration,
    storeRequestIsCurrent = Store.storeRequestIsCurrent,
    storeBookItems = Store.storeBookItems,
    storeRecentSearches = Store.storeRecentSearches,
    rememberStoreSearch = Store.rememberStoreSearch,
    persistSetting = function(self, key, value) self.settings[key] = value end,
    switchTo = function(self, _, items, context)
        self.items = items
        self.current_context = context
    end,
}

Store.loadStoreSearch(menu, "old", true)
Store.loadStoreSearch(menu, "Dune", true)
pending[2]()
pending[1]()

assert(#calls == 1, "a stale explicit search must remain generation guarded")
assert(calls[1].query == "Dune")
assert(calls[1].sources == "hardcover,storygraph")
assert(calls[1].hide_read == false, "explicit Store search must never hide read matches")
assert(menu.current_context.store_query == "Dune")
assert(#menu.current_context.books == 1, "the exact read/owned result must remain visible")
assert(menu.current_context.books[1].alreadyRead == true)
assert(menu.current_context.books[1].alreadyOwned == true)
assert(menu.items[1].text:match("Read"), "read state must be presented as a badge")

-- Slice 3: the native input dialog states plainly what it searches.
local dialogs = {}
package.loaded["ui/uimanager"].show = function(_, value) dialogs[#dialogs + 1] = value end
local prompt_menu = {
    settings = { store_recent_searches = {} },
    storeRecentSearches = Store.storeRecentSearches,
    loadStoreSearch = function() end,
}
Store.promptStoreSearch(prompt_menu)
local dialog = dialogs[#dialogs]
assert(dialog.title == "Search books", "the search dialog title must simply be Search books")
assert(dialog.input_hint == "Title, author, or ISBN", "the search hint must name title, author, or ISBN")

-- Slice 3: up to five recent non-empty queries persist, deduplicated most-recent-first.
local recent_menu = {
    settings = {},
    storeRecentSearches = Store.storeRecentSearches,
    persistSetting = function(self, key, value) self.settings[key] = value end,
}
for _, query in ipairs({ "one", "two", "three", "four", "five", "six" }) do
    Store.rememberStoreSearch(recent_menu, query)
end
local recent = Store.storeRecentSearches(recent_menu)
assert(#recent == 5, "at most five recent searches may persist")
assert(recent[1] == "six", "the newest query must lead the recent list")
assert(recent[5] == "two", "the oldest query must be dropped once five are stored")

Store.rememberStoreSearch(recent_menu, "three")
recent = Store.storeRecentSearches(recent_menu)
assert(recent[1] == "three", "rerunning a stored query must move it to the front")
local occurrences = 0
for _, query in ipairs(recent) do
    if query == "three" then occurrences = occurrences + 1 end
end
assert(occurrences == 1, "recent searches must be deduplicated")

Store.rememberStoreSearch(recent_menu, "   ")
assert(Store.storeRecentSearches(recent_menu)[1] == "three", "blank queries must never be stored")
assert(recent_menu.settings.store_recent_searches, "recent searches must live in existing plugin settings")

-- Slice 3: an executed search is remembered and its rows can rerun it.
Store.loadStoreSearch(menu, "Piranesi", true)
pending[#pending]()
assert(Store.storeRecentSearches(menu)[1] == "Piranesi", "an executed search must be remembered")
local index_items = Store.storeIndexItems({
    settings = menu.settings,
    on_device = {},
    storeBookItems = Store.storeBookItems,
    storeJobForBook = function() return nil end,
    activeStoreJobs = Store.activeStoreJobs,
    storeIntentions = Store.storeIntentions,
    storeRecentSearches = Store.storeRecentSearches,
    storeActiveAcquisitionCount = Store.storeActiveAcquisitionCount,
}, { trending = { title = "Trending this week", kind = "trending", items = {} } }, false, false)
assert(index_items[2].kind == "store-recent-search", "recent searches must render as native rows under Search books")
assert(index_items[2].text == "Piranesi")
assert(index_items[2].store_query == "Piranesi", "selecting a recent row must be able to rerun that query")

-- Slice 3: the result subtitle reports counts plus concise partial-provider status.
local partial_menu = {
    catalog_closed = false,
    settings = { store_active_jobs = {} },
    runConnected = function(_, callback) callback() end,
    fetch = function(_, _, callback) return callback() end,
    client = { catalogStoreSearch = function()
        return {
            results = { { id = "hardcover:1", title = "One", authors = {} }, { id = "hardcover:2", title = "Two", authors = {} } },
            sources = {
                { source = "hardcover", available = true, resultCount = 2 },
                { source = "storygraph", available = false, resultCount = 0 },
            },
        }
    end },
    nextStoreRequestGeneration = Store.nextStoreRequestGeneration,
    storeRequestIsCurrent = Store.storeRequestIsCurrent,
    storeBookItems = Store.storeBookItems,
    storeRecentSearches = Store.storeRecentSearches,
    rememberStoreSearch = Store.rememberStoreSearch,
    persistSetting = function(self, key, value) self.settings[key] = value end,
    switchTo = function(self, _, items, context)
        self.items = items
        self.current_context = context
    end,
}
Store.loadStoreSearch(partial_menu, "Dune", true)
local partial_subtitle = partial_menu.current_context.subtitle
assert(partial_subtitle:find("2", 1, true), "the result subtitle must report the result count")
assert(partial_subtitle:lower():find("storygraph"), "a partial result must name the unavailable provider")
assert(not partial_subtitle:lower():find("unavailable: storygraph"),
    "partial-provider status must read as prose, not raw API wording")

-- Slice 3: an empty search offers Search again instead of a blank grid.
local empty_menu = {
    catalog_closed = false,
    settings = { store_active_jobs = {} },
    runConnected = function(_, callback) callback() end,
    fetch = function(_, _, callback) return callback() end,
    client = { catalogStoreSearch = function() return { results = {}, sources = {} } end },
    nextStoreRequestGeneration = Store.nextStoreRequestGeneration,
    storeRequestIsCurrent = Store.storeRequestIsCurrent,
    storeBookItems = Store.storeBookItems,
    storeRecentSearches = Store.storeRecentSearches,
    rememberStoreSearch = Store.rememberStoreSearch,
    persistSetting = function(self, key, value) self.settings[key] = value end,
    switchTo = function(self, _, items, context)
        self.items = items
        self.current_context = context
    end,
}
Store.loadStoreSearch(empty_menu, "nothingatall", true)
assert(#empty_menu.current_context.books == 0)
assert(#empty_menu.items >= 1, "an empty search must not render a blank grid")
assert(empty_menu.items[1].text == "Search again", "an empty search must offer Search again")
assert(empty_menu.items[1].kind == "store-search", "Search again must reuse the existing search entry point")
assert(empty_menu.current_context.subtitle:lower():find("no"),
    "an empty result must explain that nothing matched")

print("bookorbit_store_search_test.lua: ok")
