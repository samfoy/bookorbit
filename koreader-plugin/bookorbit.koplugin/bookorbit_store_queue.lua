-- Persistent device-side intentions for the native BookOrbit Store.
local Queue = {}
local MAX_INTENTIONS = 50
local sequence = 0

local function copy(value)
    local result = {}
    for key, item in pairs(value or {}) do result[key] = item end
    return result
end

function Queue.normalize(value)
    local result = {}
    if type(value) ~= "table" then return result end
    for _, intent in ipairs(value) do
        if type(intent) == "table" and type(intent.intent_id) == "string"
                and type(intent.external_id) == "string" and type(intent.status) == "string" then
            result[#result + 1] = copy(intent)
            if #result >= MAX_INTENTIONS then break end
        end
    end
    return result
end

function Queue.enqueue(queue, intent)
    queue = Queue.normalize(queue)
    for _, existing in ipairs(queue) do
        if existing.external_id == intent.external_id
                and existing.status ~= "failed" and existing.status ~= "cancelled" then
            return queue, existing
        end
    end
    sequence = sequence + 1
    local entry = copy(intent)
    entry.intent_id = entry.intent_id or string.format("store-%d-%d", os.time(), sequence)
    entry.status = entry.status or "queued"
    entry.created_at = entry.created_at or os.time()
    queue[#queue + 1] = entry
    while #queue > MAX_INTENTIONS do table.remove(queue, 1) end
    return queue, entry
end

function Queue.transition(queue, intent_id, status, fields)
    queue = Queue.normalize(queue)
    for _, intent in ipairs(queue) do
        if intent.intent_id == intent_id then
            intent.status = status
            intent.updated_at = os.time()
            for key, value in pairs(fields or {}) do intent[key] = value end
            break
        end
    end
    return queue
end

function Queue.find(queue, intent_id)
    for _, intent in ipairs(Queue.normalize(queue)) do
        if intent.intent_id == intent_id then return intent end
    end
end

function Queue.cancelRemaining(queue, batch_id)
    queue = Queue.normalize(queue)
    for _, intent in ipairs(queue) do
        if intent.batch_id == batch_id and intent.status == "queued" then
            intent.status = "cancelled"
            intent.updated_at = os.time()
        end
    end
    return queue
end

function Queue.active(queue)
    local result = {}
    for _, intent in ipairs(Queue.normalize(queue)) do
        if intent.status == "queued" or intent.status == "acquiring" or intent.status == "downloading"
                or intent.status == "waiting_for_wifi" or intent.status == "waiting_for_charging" then
            result[#result + 1] = intent
        end
    end
    return result
end

return Queue
