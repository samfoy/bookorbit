-- Device-only storage, network, charging, and cleanup policy for Store downloads.
local DevicePolicy = {}

local function device() return require("device") end
local function network() return require("ui/network/manager") end
local function utilModule() return require("util") end

function DevicePolicy.freeBytes(path)
    local usage = utilModule().diskUsage(path)
    return usage and tonumber(usage.available) or nil
end

function DevicePolicy.isCharging()
    local Device = device()
    if not Device:hasBattery() then return true end
    local power = Device:getPowerDevice()
    if not power then return false end
    return power:isCharging() or power:isCharged()
end

function DevicePolicy.isWifiConnected()
    local NetworkMgr = network()
    if not NetworkMgr:isConnected() then return false end
    -- KOReader has device-specific Wi-Fi APIs. A missing discriminator means the
    -- connected transport is accepted rather than falsely blocking downloads.
    if NetworkMgr.isWifiConnected then return NetworkMgr:isWifiConnected() end
    return true
end

function DevicePolicy.downloadBlockReason(policy)
    policy = policy or {}
    if policy.required and policy.free and policy.free < policy.required then return "insufficient_space" end
    if policy.wifi_only and (not policy.connected or not policy.wifi) then return "waiting_for_wifi" end
    if policy.charging_only and not policy.charging then return "waiting_for_charging" end
    return nil
end

function DevicePolicy.checkDownload(settings, path, required)
    return DevicePolicy.downloadBlockReason({
        required = required,
        free = DevicePolicy.freeBytes(path),
        wifi_only = settings and settings.store_wifi_only == true,
        charging_only = settings and settings.store_charging_only == true,
        connected = network():isConnected(),
        wifi = DevicePolicy.isWifiConnected(),
        charging = DevicePolicy.isCharging(),
    })
end

function DevicePolicy.removeFromDevice(catalog, book_id, remover)
    local path = catalog.on_device and catalog.on_device[book_id]
    if type(path) ~= "string" or path == "" then return false, "not_on_device" end
    local ok = (remover or utilModule().removeFile)(path)
    if not ok then return false, "remove_failed" end
    catalog.on_device[book_id] = nil
    if catalog.markStackDirty then catalog:markStackDirty() end
    return true
end

function DevicePolicy.cleanupPreview(entries, now, age_days)
    local cutoff = (now or os.time()) - math.max(1, tonumber(age_days) or 30) * 86400
    local result = {}
    for _, entry in ipairs(entries or {}) do
        if entry.finished_at and entry.finished_at <= cutoff and entry.local_path then result[#result + 1] = entry end
    end
    return result
end

return DevicePolicy
