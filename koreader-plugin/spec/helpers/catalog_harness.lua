-- Minimal KOReader widget/environment stubs sufficient to require the real
-- bookorbit_catalog controller in a spec. Widget construction is not exercised;
-- these exist so module-level requires resolve and the controller's own
-- dispatch/mode functions can be driven directly.
local function widget(extra)
    local Widget = {}
    Widget.__index = Widget
    function Widget.new(_, opts)
        opts = opts or {}
        for key, value in pairs(extra or {}) do
            if opts[key] == nil then opts[key] = value end
        end
        return setmetatable(opts, Widget)
    end
    function Widget:getSize() return { w = 0, h = 0 } end
    function Widget:getHeight() return 0 end
    function Widget:free() end
    function Widget:show() end
    function Widget:hide() end
    function Widget:showHide() end
    function Widget:enableDisable() end
    function Widget:enable() end
    function Widget:disableWithoutDimming() end
    function Widget:setText(value) self.text = value end
    function Widget:onShowKeyboard() end
    function Widget:getInputText() return self.input or "" end
    function Widget.extend(base, opts)
        local Sub = {}
        for key, value in pairs(base) do Sub[key] = value end
        for key, value in pairs(opts or {}) do Sub[key] = value end
        Sub.__index = Sub
        Sub.extend = Widget.extend
        Sub.new = function(_, o)
            o = o or {}
            for key, value in pairs(Sub) do
                if o[key] == nil and key ~= "__index" then o[key] = value end
            end
            return setmetatable(o, Sub)
        end
        return Sub
    end
    return Widget
end

local Harness = {}

function Harness.install()
    G_defaults = G_defaults or { readSetting = function(_, _, default) return default end }
    G_reader_settings = G_reader_settings or {
        readSetting = function(_, _, default) return default end,
        saveSetting = function() end,
        isTrue = function() return false end,
        isFalse = function() return false end,
        nilOrTrue = function() return true end,
        has = function() return false end,
    }
    local widgets = {
        "ui/widget/buttondialog", "ui/widget/container/centercontainer", "ui/widget/horizontalgroup",
        "ui/widget/horizontalspan", "ui/widget/iconbutton", "ui/widget/iconwidget",
        "ui/widget/infomessage", "ui/widget/inputdialog", "ui/widget/overlapgroup",
        "ui/widget/textboxwidget", "ui/widget/titlebar", "ui/widget/verticalgroup",
        "ui/widget/verticalspan", "ui/widget/notification", "ui/widget/textviewer",
        "ui/widget/confirmbox", "ui/geometry",
    }
    for _, name in ipairs(widgets) do
        package.loaded[name] = widget()
    end

    local Menu = widget()
    Menu.updatePageInfo = function() end
    Menu.onClose = function() return true end
    Menu.onNextPage = function() return true end
    Menu.onPrevPage = function() return true end
    Menu.onFirstPage = function() return true end
    Menu.onLastPage = function() return true end
    Menu.onGotoPage = function() return true end
    Menu.onCloseWidget = function() return true end
    Menu._recalculateDimen = function() end
    Menu.updateItems = function() end
    Menu.switchItemTable = function() end
    package.loaded["ui/widget/menu"] = Menu

    package.loaded["device"] = {
        screen = {
            scaleBySize = function(_, value) return value end,
            getWidth = function() return 758 end,
            getHeight = function() return 1024 end,
        },
        isTouchDevice = function() return false end,
        hasKeys = function() return true end,
        hasDPad = function() return true end,
        hasFrontlight = function() return false end,
        hasKeyboard = function() return false end,
        isAndroid = function() return false end,
    }
    package.loaded["ui/font"] = { getFace = function() return {} end }
    package.loaded["ui/size"] = {
        padding = { button = 0, default = 0, small = 0, large = 0 },
        border = { default = 0, thin = 0, button = 0, window = 0 },
        margin = { default = 0, small = 0, tiny = 0 },
        span = { horizontal_default = 0, vertical_default = 0 },
        item = { height_default = 0, height_big = 0 },
        line = { thin = 0, medium = 0 },
        radius = { window = 0, button = 0 },
    }
    package.loaded["ui/trapper"] = { isWrapped = function() return false end, wrap = function(_, fn) return fn() end }
    package.loaded["ui/uimanager"] = {
        show = function() end, close = function() end,
        scheduleIn = function() end, nextTick = function(_, fn) if fn then fn() end end,
        forceRePaint = function() end, setDirty = function() end,
    }
    package.loaded["ui/network/manager"] = {
        isConnected = function() return true end,
        runWhenConnected = function(_, fn) return fn() end,
    }
    package.loaded["libs/libkoreader-lfs"] = { attributes = function() return nil end, dir = function() return function() return nil end end }
    package.loaded["util"] = { fixUtf8 = function(value) return value end, splitFilePathName = function(p) return p, p end }
    package.loaded["document/documentregistry"] = { hasProvider = function() return true end }
    package.loaded["ffi/util"] = { template = function(value, a, b)
        local out = tostring(value)
        for index, replacement in ipairs({ a, b }) do
            out = out:gsub("%%" .. index, tostring(replacement or ""))
        end
        return out
    end }
    package.loaded["gettext"] = function(value) return value end
    package.loaded["bookorbit_capabilities"] = { supports = function() return true end, cached = function() return { catalogStore = true } end }

    package.loaded["socket.http"] = { request = function() return nil end }
    package.loaded["socketutil"] = { set_timeout = function() end, reset_timeout = function() end, LARGE_BLOCK_TIMEOUT = 30, LARGE_TOTAL_TIMEOUT = 60, FILE_BLOCK_TIMEOUT = 30, FILE_TOTAL_TIMEOUT = 60 }

    package.loaded["socket"] = { skip = function() end, sink = {}, source = {} }
    package.loaded["socket.url"] = { escape = function(value) return value end, parse = function() return {} end }
    package.loaded["ltn12"] = { sink = { table = function() return function() return 1 end end }, source = { string = function() return function() return nil end end } }
    package.loaded["ssl.https"] = { request = function() return nil end }
    package.loaded["md5"] = { sum = function(value) return value end, sumhexa = function(value) return value end }
    package.loaded["rapidjson"] = { encode = function() return "{}" end, decode = function() return {} end }
    package.loaded["json"] = { encode = function() return "{}" end, decode = function() return {} end }
    package.loaded["dbg"] = setmetatable({ log = function() end, v = function() end }, { __call = function() end })
    package.loaded["logger"] = { info = function() end, warn = function() end, err = function() end, dbg = function() end }
    package.loaded["datastorage"] = { getDataDir = function() return "/tmp" end, getSettingsDir = function() return "/tmp" end }
    package.loaded["ui/widget/container/framecontainer"] = widget()
    package.loaded["ui/widget/container/widgetcontainer"] = widget()
    package.loaded["ui/widget/container/rightcontainer"] = widget()
    package.loaded["ui/widget/container/leftcontainer"] = widget()
    package.loaded["ui/widget/container/bottomcontainer"] = widget()
    package.loaded["ui/widget/imagewidget"] = widget()
    package.loaded["ui/widget/progresswidget"] = widget()
    package.loaded["ui/widget/textwidget"] = widget()
    package.loaded["ui/widget/button"] = widget()
    package.loaded["ui/widget/linewidget"] = widget()
    package.loaded["ui/widget/spinwidget"] = widget()
    package.loaded["ui/widget/multiinputdialog"] = widget()
    package.loaded["ui/widget/checkbutton"] = widget()
    package.loaded["ui/widget/menu"] = package.loaded["ui/widget/menu"]
    package.loaded["ui/renderimage"] = { renderImageData = function() return nil end }
    package.loaded["ui/screenshoter"] = {}
    package.loaded["ui/event"] = widget()
    package.loaded["ui/bidi"] = { rtl = function() return false end }
    package.loaded["ui/widget/filechooser"] = widget()
    package.loaded["ffi"] = { load = function() return {} end, new = function() return {} end, cdef = function() end }
    package.loaded["ffi/blitbuffer"] = { new = function() return {} end }
    package.loaded["luasettings"] = { open = function()
        local store = {}
        return {
            readSetting = function(_, key, default) if store[key] == nil then return default end return store[key] end,
            saveSetting = function(_, key, value) store[key] = value end,
            delSetting = function(_, key) store[key] = nil end,
            has = function(_, key) return store[key] ~= nil end,
            flush = function() end, close = function() end,
        }
    end }
    package.loaded["sqlite3"] = { open = function() return nil end }
    package.loaded["ui/widget/keyvaluepage"] = widget()
    package.loaded["ui/widget/sortwidget"] = widget()
    package.loaded["ui/widget/inputtext"] = widget()
    package.loaded["ui/widget/toggleswitch"] = widget()
    package.loaded["ui/widget/radiobuttonwidget"] = widget()

    -- The controller pulls in a long tail of KOReader modules it never exercises
    -- on the Store paths under test. Rather than enumerate every one, resolve
    -- unknown non-BookOrbit modules to a permissive stub via a package searcher.
    local Permissive = {}
    Permissive.__index = function(_, key)
        if key == "extend" or key == "new" then
            return function(_, opts) return setmetatable(opts or {}, Permissive) end
        end
        return function() return nil end
    end
    local function permissive()
        return setmetatable({
            new = function(_, opts) return setmetatable(opts or {}, Permissive) end,
            extend = function(_, opts) return setmetatable(opts or {}, Permissive) end,
            open = function() return setmetatable({}, Permissive) end,
        }, Permissive)
    end
    table.insert(package.loaders, function(name)
        if name:match("^bookorbit") or name:match("^helpers") then return nil end
        return function() return permissive() end
    end)
end

return Harness
