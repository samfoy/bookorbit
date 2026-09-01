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

print("bookorbit_store_search_test.lua: ok")
