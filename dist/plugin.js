exports.repo = "Hug3O/Tiles-plus"
exports.version = 2.2
exports.description = "Improves sorted views by showing time or extension instead of size; also remembers tile size per folder (tile mode memory merged from Hotkey; formerly Short-plus)"
exports.apiRequired = 9.6
exports.frontend_js = "main.js"

exports.config = {
    enableEnhancedSorting: {
        frontend: true,
        label: "Enable Enhanced Sorting UI",
        type: "boolean",
        defaultValue: true,
        helperText: "Core feature. When enabled, the size column is replaced with time / extension info based on the current sort. Disable to keep the native interface."
    },
    enableTileModeMemory: {
        frontend: true,
        label: "Enable Tile Mode Memory",
        type: "boolean",
        defaultValue: true,
        helperText: "Remember the tile size of every folder and restore it when the folder is opened again. Folders without a remembered value use HFS's own config.yaml tile_size. The Ctrl+0..9 tile shortcuts stay in the Hotkey plugin; this plugin owns the remembering. When disabled, no per-folder data is read or written."
    },
    expireHours: {
        frontend: true,
        label: "Memory Expiration (hours)",
        type: "number",
        min: 0,
        max: 8760,
        defaultValue: 24,
        helperText: "Records older than this will be removed. Set to 0 for no expiration."
    }
}
