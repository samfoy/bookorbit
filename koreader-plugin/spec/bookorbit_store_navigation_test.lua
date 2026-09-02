-- Store navigation regressions found in review of the native index slice.
--
-- Both defects were invisible to item-table-only assertions: an empty search
-- page claimed to be a book page (so the real controller routed it into the
-- mosaic/list book renderer with no book payload), and reloading a shelf pushed
-- it onto the navigation stack again so Back never reached the index.
package.path = "koreader-plugin/spec/?.lua;koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path

require("helpers/catalog_harness").install()

local Catalog = require("bookorbit_catalog")
local Store = require("bookorbit_store")

local function newMenu(overrides)
    local menu = {
        catalog_closed = false,
        stack = {},
        paths = {},
        settings = { store_active_jobs = {} },
        on_device = {},
        selected = { x = 1, y = 1 },
        layout = {},
        item_table = {},
        runConnected = function(_, callback) return callback() end,
        fetch = function(_, _, callback) return callback() end,
        persistSetting = function(self, key, value) self.settings[key] = value end,
        -- Render seam: the real controller decides here what kind of page this
        -- is, so a wrong context kind shows up as a wrong renderer choice.
        cancelThumbnailJobs = function() end,
        scheduleThumbnailDownloads = function(self, books)
            self.rendered_books = books
            for _, book in ipairs(books or {}) do
                assert(type(book) == "table" and book.title ~= nil,
                    "the book renderer must never be handed a non-book entry")
            end
        end,
        resetTitleBar = function() end,
        switchItemTable = function(self, _, item_table) self.item_table = item_table end,
        captureFocus = function(self) return { x = 1, y = self.selected.y, row_id = self.focus_row_id } end,
        restoreFocusOnNextUpdate = function(self, focus) self.restored_focus = focus end,
        updateReturnPath = function(self) self.paths = self.stack end,
        showRetry = function() error("no retry expected") end,
        showStoreGenres = function() end,
        mirrorStoreShelf = function() end,
        resumeStoreAcquisitions = function() end,
        storeHideRead = function() return true end,
        refreshCurrent = function() end,
        updateLeftIcon = function() end,
        initialDashboardContext = function() return {}, { kind = "dashboard" } end,
        shouldRefreshDashboardOnOpen = function() return false end,
    }
    for key, value in pairs(overrides or {}) do menu[key] = value end
    for _, name in ipairs({
        "switchTo", "onReturn", "onMenuSelect", "bookMode", "storeMode", "detailMode",
        "dashboardMode", "pagedSectionMode", "localBookMode", "storeIndexMode",
    }) do
        menu[name] = menu[name] or Catalog[name]
    end
    for name, fn in pairs(Store) do
        if name ~= "install" and menu[name] == nil then menu[name] = fn end
    end
    return menu
end

-- Defect 1: an empty search must be a real native page, not a book page whose
-- single entry has no book behind it.
local empty = newMenu({
    client = { catalogStoreSearch = function() return { results = {}, sources = {} } end },
})
empty.current_context = { kind = "store-index", title = "Book Store" }
empty.item_table = { { text = "Search books", kind = "store-search" } }
empty.selected.y = 1

Store.loadStoreSearch(empty, "nothingatall", true)

local context = empty.current_context
assert(context.store_query == "nothingatall")
assert(Catalog.bookMode(empty) == false,
    "an empty search page must not be routed through the book mosaic/list renderer")
assert(Catalog.storeMode(empty) == true, "an empty search page must stay inside Store mode")
assert(context.kind ~= "store-books",
    "an empty search must not claim to be a book grid it has no books for")
assert(#(context.books or {}) == 0)
assert(context.page == nil and context.page_count == nil,
    "an empty search page has nothing to paginate")

local items = empty.item_table
assert(#items == 1 and items[1].text == "Search again", "the empty page must offer Search again")
assert(items[1].kind == "store-search", "Search again must reuse the existing search entry point")

-- The empty page must survive real dispatch: selecting Search again reprompts.
local prompted = 0
empty.promptStoreSearch = function() prompted = prompted + 1 end
Catalog.onMenuSelect(empty, items[1])
assert(prompted == 1, "Search again must be selectable through the real menu dispatch")

-- Back from the empty page must return to the index it was pushed from.
assert(#empty.stack == 1, "an empty search page must be pushed so Back can leave it")
assert(empty.stack[1].context.kind == "store-index")
Catalog.onReturn(empty)
assert(empty.current_context.kind == "store-index", "Back from an empty search must reach the Store index")
assert(empty.restored_focus ~= nil, "Back must restore the index focus")

-- Defect 2: selecting a shelf pushes once; reloading it replaces in place.
local shelf = { id = "trending", title = "Trending this week", kind = "trending", items = {
    { id = "hardcover:1", title = "Trending One", authors = { "A" } },
} }
local nav = newMenu({})
nav.current_context = { kind = "store-index", title = "Book Store", store_home = { trending = shelf } }
nav.item_table = { { text = "Search books", kind = "store-search" }, { text = shelf.title, kind = "store-shelf", shelf = shelf } }
nav.selected.y = 2
nav.focus_row_id = "shelf-trending"

Catalog.onMenuSelect(nav, nav.item_table[2])
assert(nav.current_context.kind == "store-books", "a shelf row must open the cover grid")
assert(#nav.stack == 1, "selecting a shelf must push the index exactly once")
assert(nav.stack[1].context.kind == "store-index")
local pushed_focus = nav.stack[1].focus

-- Refresh / sort / EPUB-only / hide-read all funnel through reloadStoreContext.
Store.reloadStoreContext(nav, nav.current_context)
assert(nav.current_context.kind == "store-books", "reloading a shelf must stay on that shelf")
assert(#nav.stack == 1,
    "reloading a shelf must replace it in place, not push the same shelf again")
assert(nav.stack[1].context.kind == "store-index",
    "the pushed entry must remain the Store index so Back leaves the shelf")
assert(nav.stack[1].focus == pushed_focus, "reloading a shelf must preserve the captured index focus")

Store.reloadStoreContext(nav, nav.current_context)
assert(#nav.stack == 1, "repeated reloads must not grow the navigation stack")

Catalog.onReturn(nav)
assert(nav.current_context.kind == "store-index",
    "Back after reloading a shelf must reach the Store index, not the same shelf")
assert(nav.restored_focus == pushed_focus, "Back must restore the focus the index was left at")

-- Standalone external detail must not inherit Book 1 of 1 pagination from its
-- Store result parent, while local catalog details keep that navigation.
local function pageWidget()
    return {
        text = nil,
        shown = true,
        setText = function(self, value) self.text = value end,
        show = function(self) self.shown = true end,
        hide = function(self) self.shown = false end,
        showHide = function(self, value) self.shown = value end,
        enableDisable = function() end,
        enable = function() end,
        disableWithoutDimming = function() end,
    }
end
local detail_book = { id = "hardcover:1", title = "Piranesi" }
local detail_nav = newMenu({
    current_context = { kind = "detail", detail = { id = "hardcover:1", standalone = true } },
    stack = { { context = { kind = "store-books", books = { detail_book }, page = 1, total = 1 } } },
    paths = { true },
    page_info_text = pageWidget(),
    page_info_left_chev = pageWidget(), page_info_right_chev = pageWidget(),
    page_info_first_chev = pageWidget(), page_info_last_chev = pageWidget(),
    page_return_arrow = pageWidget(),
    getAdjacentDetailBooks = Catalog.getAdjacentDetailBooks,
})
Catalog.updatePageInfo(detail_nav)
assert(detail_nav.page_info_text.text == "", "standalone Store detail must not show Book 1 of 1")
assert(detail_nav.page_info_left_chev.shown == false and detail_nav.page_info_right_chev.shown == false,
    "standalone Store detail must hide catalog pagination chevrons")

detail_nav.current_context.detail.standalone = false
Catalog.updatePageInfo(detail_nav)
assert(detail_nav.page_info_text.text == "Book 1 of 1",
    "local/paged catalog detail must retain Book N of N navigation")

print("bookorbit_store_navigation_test.lua: ok")
