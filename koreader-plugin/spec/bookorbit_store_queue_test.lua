package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path

package.loaded["device"] = {
    hasBattery = function() return true end,
    getPowerDevice = function()
        return { isCharging = function() return false end, isCharged = function() return false end }
    end,
}
package.loaded["ui/network/manager"] = { isConnected = function() return true end }
package.loaded["util"] = {
    diskUsage = function() return { available = 1000 } end,
    removeFile = function() return true end,
}

local Queue = require("bookorbit_store_queue")
local DevicePolicy = require("bookorbit_store_device")

local queue = Queue.normalize(nil)
queue = Queue.enqueue(queue, { external_id = "a", title = "A", action = "open", status = "queued" })
queue = Queue.enqueue(queue, { external_id = "a", title = "A duplicate", action = "open", status = "queued" })
assert(#queue == 1, "queue must deduplicate active intentions by external id")
assert(queue[1].action == "open")
queue = Queue.transition(queue, queue[1].intent_id, "ready", { book_id = 42 })
assert(queue[1].status == "ready" and queue[1].book_id == 42)
queue = Queue.enqueue(queue, { external_id = "b", title = "B", action = "download", status = "queued", batch_id = "batch" })
queue = Queue.enqueue(queue, { external_id = "c", title = "C", action = "download", status = "acquiring", batch_id = "batch" })
queue = Queue.cancelRemaining(queue, "batch")
assert(queue[2].status == "cancelled", "cancel remaining cancels queued batch intentions")
assert(queue[3].status == "acquiring", "cancel remaining does not fake cancellation of active server work")

assert(DevicePolicy.downloadBlockReason({ required = 1200, free = 1000 }) == "insufficient_space")
assert(DevicePolicy.downloadBlockReason({ wifi_only = true, connected = true, wifi = false }) == "waiting_for_wifi")
assert(DevicePolicy.downloadBlockReason({ charging_only = true, charging = false }) == "waiting_for_charging")
assert(DevicePolicy.downloadBlockReason({ required = 500, free = 1000, connected = true, wifi = true, charging = true }) == nil)

local removed
local device = { on_device = { [42] = "/books/A.epub" }, persistSetting = function() end }
local ok = DevicePolicy.removeFromDevice(device, 42, function(path) removed = path; return true end)
assert(ok and removed == "/books/A.epub")
assert(device.on_device[42] == nil, "device removal must retain the server book and only clear the local map")

print("bookorbit_store_queue_test.lua: ok")
