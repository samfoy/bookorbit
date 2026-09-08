--[[--
Account-wide BookOrbit -> KOReader statistics synchronization.

The server returns a frozen, cursor-paginated snapshot through the existing
page-stats endpoint. Every response page is committed idempotently to
statistics.sqlite3; stale mirror-owned rows are removed only after the final
page. This module owns transport/orchestration, while bookorbit_stats_mirror owns
SQLite row ownership.
]]

local UIManager = require("ui/uimanager")
local logger = require("logger")

local Capabilities = require("bookorbit_capabilities")
local StatsMirror = require("bookorbit_stats_mirror")

local StatsSync = {
    running = false,
}

local FEATURE = "statisticsMirror"
local PAGE_SIZE = 100
local STEP_DELAY = 0.05

function StatsSync.isRunning()
    return StatsSync.running
end

function StatsSync.run(opts)
    opts = opts or {}
    if StatsSync.running then
        if opts.on_finish then opts.on_finish(nil, "already_running") end
        return false, "already_running"
    end
    if not opts.client then return false, "missing_client" end

    local supported = Capabilities.supports(opts.client, FEATURE)
    if supported == false then
        if opts.on_finish then opts.on_finish(nil, "unsupported_server") end
        return false, "unsupported_server"
    elseif supported == nil then
        if opts.on_finish then opts.on_finish(nil, "capability_unavailable") end
        return false, "capability_unavailable"
    end

    StatsSync.running = true
    local cursor, generation
    local known_generation = StatsMirror.currentGeneration()
    local totals = { received = 0, inserted = 0, removed = 0, pages = 0 }
    local finished = false

    local function finish(result, err)
        if finished then return end
        finished = true
        StatsSync.running = false
        if opts.on_finish then opts.on_finish(result, err) end
    end

    local function fail(err)
        logger.warn("BookOrbit: statistics mirror sync failed:", err)
        finish(nil, err)
    end

    local step
    step = function()
        if opts.cancelled and opts.cancelled() then
            finish(nil, "cancelled")
            return
        end
        local known
        if not cursor then known = known_generation end
        local body, err = opts.client:syncStatisticsMirror(cursor, PAGE_SIZE, known)
        local page = body and body.mirror
        if not page then
            if err == 404 or err == 405 then Capabilities.markUnsupported(opts.client, FEATURE) end
            fail(err or "invalid_response")
            return
        end
        if type(page.generation) ~= "string" or type(page.items) ~= "table" then
            fail("invalid_response")
            return
        end
        if generation and generation ~= page.generation then
            fail("generation_changed")
            return
        end
        generation = page.generation

        local applied, apply_err = StatsMirror.applyPage(generation, page.items)
        if not applied then
            fail(apply_err or "database_write_failed")
            return
        end
        totals.pages = totals.pages + 1
        totals.received = totals.received + (applied.received or 0)
        totals.inserted = totals.inserted + (applied.inserted or 0)
        if opts.on_progress then pcall(opts.on_progress, totals) end

        if page.done == true then
            local finalized, finalize_err = StatsMirror.finishGeneration(generation)
            if not finalized then
                fail(finalize_err or "database_finalize_failed")
                return
            end
            totals.removed = finalized.removed or 0
            if totals.inserted > 0 or totals.removed > 0 then
                StatsMirror.invalidateConsumerCaches()
            end
            finish(totals)
            return
        end
        if type(page.nextCursor) ~= "string" or page.nextCursor == "" then
            fail("missing_cursor")
            return
        end
        cursor = page.nextCursor
        UIManager:scheduleIn(STEP_DELAY, step)
    end

    step()
    return true
end

return StatsSync
