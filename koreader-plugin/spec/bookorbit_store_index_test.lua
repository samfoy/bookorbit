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
package.loaded["ui/uimanager"] = { show = function() end, close = function() end, scheduleIn = function() end }
package.loaded["ffi/util"] = { template = function(value, replacement)
    return (value:gsub("%%1", tostring(replacement or "")))
end }
package.loaded["gettext"] = function(value) return value end
package.loaded["bookorbit_capabilities"] = { supports = function() return true end }

local Store = require("bookorbit_store")

local function book(id, title)
    return { id = id, title = title, authors = { "Author " .. id } }
end

local home = {
    trending = { id = "trending", title = "Trending this week", kind = "trending", items = { book("hardcover:1", "Trending One") } },
    genreShelves = { { id = "genre-fantasy", title = "Fantasy", kind = "genre", value = "fantasy", items = { book("hardcover:2", "Fantasy One") } } },
    genres = { { name = "Fantasy", slug = "fantasy" }, { name = "Mystery", slug = "mystery" } },
    personalizedShelves = {
        { id = "for-you", title = "For You", kind = "for-you", items = { book("hardcover:3", "For You One") }, available = true },
        { id = "up-next-series", title = "Up Next in Your Series", kind = "up-next", items = { book("hardcover:4", "Up Next One") }, available = true },
        { id = "hardcover-want-to-read", title = "Hardcover Want to Read", kind = "tracker", items = { book("hardcover:5", "Tracker One") }, available = true },
        { id = "storygraph-empty", title = "StoryGraph Read", kind = "tracker", items = {}, available = false, message = "unavailable" },
    },
}

local function indexMenu(settings)
    return {
        on_device = {},
        settings = settings or {},
        storeBookItems = Store.storeBookItems,
        storeJobForBook = function() return nil end,
        activeStoreJobs = Store.activeStoreJobs,
        storeIntentions = Store.storeIntentions,
        storeRecentSearches = Store.storeRecentSearches,
        storeActiveAcquisitionCount = Store.storeActiveAcquisitionCount,
    }
end

-- Behavior 1: Store home is an ordered native index, not shelf-as-pages.
local items, context = Store.storeIndexItems(indexMenu(), home, false, false)

assert(context.kind == "store-index", "Store home must be a native index context")
assert(context.page == nil and context.page_count == nil,
    "Store index must not carry Page 1 of N pagination chrome")
assert(context.store_landing ~= true, "Store index must not reuse shelf-as-page landing behavior")
assert(context.store_home == home, "Store index must be built from the cached whole home payload")

local kinds, texts = {}, {}
for index, item in ipairs(items) do
    kinds[index] = item.kind
    texts[index] = item.text
end

assert(kinds[1] == "store-search", "Search books must be the first index row")
assert(texts[1] == "Search books", "the first row must be labelled Search books")
assert(texts[2] == "For You", "For You must follow Search when available")
assert(kinds[2] == "store-shelf")
assert(texts[3] == "Trending this week", "Trending this week must follow For You")
assert(kinds[3] == "store-shelf")
assert(texts[4] == "Up Next in Your Series", "Up Next in Your Series must follow Trending when available")
assert(texts[5] == "Hardcover Want to Read", "available tracker shelves must render with their concise provider label")
assert(kinds[5] == "store-shelf")
for _, text in ipairs(texts) do
    assert(text ~= "StoryGraph Read", "unavailable tracker shelves must not become dead index rows")
end
assert(texts[6] == "Browse genres", "Browse genres must follow the shelves")
assert(kinds[6] == "store-genres")
assert(texts[7] == "Downloads", "Downloads must be the final index row")
assert(kinds[7] == "store-jobs")
assert(#items == 7, "the index must render exactly the available browse paths")

-- Each shelf row carries the books it opens, so selecting it needs no extra request.
assert(#items[2].shelf.items == 1, "a shelf row must carry its own books")
assert(items[3].shelf.kind == "trending")
assert(items[2].mandatory == "1", "shelf rows must show how many books they hold")

-- Behavior: Downloads shows an active count only when work is in flight.
assert(items[7].mandatory == nil, "Downloads must stay uncluttered when nothing is active")

local busy = indexMenu({
    store_active_jobs = { { id = "job-1", external_id = "hardcover:9", title = "Getting" } },
    store_queue = {
        { intent_id = "store-1", external_id = "hardcover:9", status = "acquiring" },
        { intent_id = "store-2", external_id = "hardcover:10", status = "queued" },
        { intent_id = "store-3", external_id = "hardcover:11", status = "ready" },
    },
})
local busy_items = Store.storeIndexItems(busy, home, false, false)
assert(busy_items[7].mandatory == "2", "Downloads must report the distinct active acquisition count")

-- Behavior: connected opening paints the cached index at once, then refreshes in place.
local callbacks, switches = {}, {}
local lifecycle = {
    catalog_closed = false,
    on_device = {},
    settings = { store_home_cache = home },
    storeCache = Store.storeCache,
    cacheStoreHome = Store.cacheStoreHome,
    nextStoreRequestGeneration = Store.nextStoreRequestGeneration,
    storeRequestIsCurrent = Store.storeRequestIsCurrent,
    storeIndexItems = Store.storeIndexItems,
    storeBookItems = Store.storeBookItems,
    storeRecentSearches = Store.storeRecentSearches,
    storeActiveAcquisitionCount = Store.storeActiveAcquisitionCount,
    activeStoreJobs = Store.activeStoreJobs,
    storeIntentions = Store.storeIntentions,
    storeJobForBook = function() return nil end,
    storeHideRead = function() return true end,
    persistSetting = function(self, key, value) self.settings[key] = value end,
    runConnected = function(_, callback) callbacks[#callbacks + 1] = callback end,
    fetch = function(_, _, callback) return callback() end,
    client = { catalogStoreHome = function() return home end },
    switchTo = function(self, _, items, context, push)
        self:nextStoreRequestGeneration()
        switches[#switches + 1] = { items = items, context = context, push = push }
    end,
    mirrorStoreShelf = function() end,
    resumeStoreAcquisitions = function() end,
}

Store.loadStoreHome(lifecycle, true)
assert(#switches == 1, "the cached index must paint before the connected refresh runs")
assert(switches[1].context.kind == "store-index", "the first paint must be the native index")
assert(switches[1].context.refreshing == true, "a connected cached index must say it is refreshing")
callbacks[1]()
assert(#switches == 2, "the fresh payload must refresh the index")
assert(switches[2].push == false, "the refresh must replace the cached index in place")
assert(switches[2].context.refreshing == false and switches[2].context.stale == false)

-- Behavior: a stale response must never overwrite newer Store navigation.
callbacks, switches = {}, {}
Store.loadStoreHome(lifecycle, true)
Store.loadStoreHome(lifecycle, true)
local fetches = 0
lifecycle.fetch = function(_, _, callback)
    fetches = fetches + 1
    return callback()
end
callbacks[1]()
assert(fetches == 0, "a superseded index request must not reach the network")
callbacks[2]()
assert(fetches == 1, "only the current index request may fetch")

-- Behavior: an offline cached index is explicitly labelled.
package.loaded["ui/network/manager"].isConnected = function() return false end
callbacks, switches = {}, {}
Store.loadStoreHome(lifecycle, true)
assert(#switches == 1 and #callbacks == 0, "an offline index must render from cache without a request")
assert(switches[1].context.stale == true, "an offline index must be marked stale")
assert(switches[1].context.subtitle == "offline cache", "an offline index must say it is a cache")
package.loaded["ui/network/manager"].isConnected = function() return true end

-- Behavior: each shelf row opens the existing cover grid, and Back preserves index focus.
local opened = {}
local shelf_menu = {
    on_device = {},
    settings = {},
    storeBookItems = Store.storeBookItems,
    storeJobForBook = function() return nil end,
    switchTo = function(self, title, items, context, push)
        opened[#opened + 1] = { title = title, items = items, context = context, push = push }
        self.current_context = context
    end,
}
Store.showStoreShelf(shelf_menu, items[3].shelf)
assert(#opened == 1)
assert(opened[1].context.kind == "store-books", "a shelf row must open the existing cover grid context")
assert(opened[1].push == true, "opening a shelf must push so Back returns to the index with its focus")
assert(opened[1].context.title == "Trending this week")
assert(#opened[1].context.books == 1, "the shelf grid must use the books the index already holds")
assert(opened[1].context.store_kind == "trending")
assert(opened[1].items[1].kind == "store-book", "shelf books must remain selectable result rows")

-- Behavior: the index is a single vertical menu, so it must not render page chrome.
local Catalog = { updatePageInfo = function() end }
local function chevron()
    return { shown = true, show = function(self) self.shown = true end, hide = function(self) self.shown = false end,
        enableDisable = function() end, showHide = function() end }
end
local index_page = {
    current_context = { kind = "store-index" },
    page_info_text = { text = nil, setText = function(self, value) self.text = value end,
        enable = function() end, disableWithoutDimming = function() end },
    page_info_left_chev = chevron(), page_info_right_chev = chevron(),
    page_info_first_chev = chevron(), page_info_last_chev = chevron(),
    page_return_arrow = chevron(),
    storeIndexMode = function(self) return self.current_context.kind == "store-index" end,
    detailMode = function() return false end,
    dashboardMode = function() return false end,
    pagedSectionMode = function() return false end,
}
assert(Store.storeIndexPageInfo, "the Store index must own its page-chrome suppression")
Store.storeIndexPageInfo(index_page)
assert(index_page.page_info_text.text == "", "the Store index must not print Page 1 of N")
assert(index_page.page_info_left_chev.shown == false, "the Store index must hide shelf paging chevrons")
assert(index_page.page_info_right_chev.shown == false)
assert(Catalog ~= nil)

print("bookorbit_store_index_test.lua: ok")
