package.loaded["logger"] = { warn = function() end }
package.loaded["ui/uimanager"] = {
    scheduleIn = function(_, _, callback) callback() end,
}
package.loaded["bookorbit_capabilities"] = {
    supports = function(_, feature)
        assert(feature == "statisticsMirror")
        return true
    end,
    markUnsupported = function() end,
}

local applied = {}
local finalized = {}
local invalidations = 0
package.loaded["bookorbit_stats_mirror"] = {
    currentGeneration = function() return "v2-known" end,
    applyPage = function(generation, items)
        table.insert(applied, { generation = generation, items = items })
        return { received = #items, inserted = #items }
    end,
    finishGeneration = function(generation)
        table.insert(finalized, generation)
        return { removed = 2 }
    end,
    invalidateConsumerCaches = function()
        invalidations = invalidations + 1
    end,
}

package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local StatsSync = require("bookorbit_stats_sync")

local calls = {}
local pages = {
    {
        generation = "v1-2-3",
        items = { { key = "page:1" }, { key = "page:2" } },
        nextCursor = "next-page",
        done = false,
    },
    {
        generation = "v1-2-3",
        items = { { key = "session:3" } },
        nextCursor = nil,
        done = true,
    },
}
local client = {
    syncStatisticsMirror = function(_, cursor, limit, known_generation)
        table.insert(calls, { cursor = cursor, limit = limit, known_generation = known_generation })
        return { mirror = table.remove(pages, 1) }
    end,
}
local finished, finish_err
assert(StatsSync.run{
    client = client,
    on_finish = function(result, err)
        finished, finish_err = result, err
    end,
})
assert(#calls == 2 and calls[1].cursor == nil and calls[2].cursor == "next-page")
assert(calls[1].limit == 100 and calls[2].limit == 100)
assert(calls[1].known_generation == "v2-known" and calls[2].known_generation == nil)
assert(#applied == 2 and applied[1].generation == "v1-2-3")
assert(#finalized == 1 and finalized[1] == "v1-2-3")
assert(finished and finished.received == 3 and finished.inserted == 3 and finished.removed == 2)
assert(finish_err == nil and invalidations == 1)
assert(not StatsSync.isRunning())

-- A snapshot must never mix generations: no finalize, no deletion sweep.
applied, finalized, invalidations = {}, {}, 0
pages = {
    { generation = "old", items = {}, nextCursor = "next", done = false },
    { generation = "new", items = {}, nextCursor = nil, done = true },
}
finished, finish_err = nil, nil
assert(StatsSync.run{
    client = client,
    on_finish = function(result, err)
        finished, finish_err = result, err
    end,
})
assert(finished == nil and finish_err == "generation_changed")
assert(#finalized == 0 and invalidations == 0 and not StatsSync.isRunning())

print("bookorbit_stats_sync_test.lua: ok")
