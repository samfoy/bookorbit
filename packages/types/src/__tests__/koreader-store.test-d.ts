import type { KoreaderPluginCapability, KoreaderStoreConfigResponse, KoreaderStoreFolderOption, KoreaderStoreLibraryOption } from "../index";

const folder = { id: 9, path: "/books/fiction" } satisfies KoreaderStoreFolderOption;
const library = { id: 4, name: "Fiction", folders: [folder] } satisfies KoreaderStoreLibraryOption;
const config = {
  canAcquire: true,
  sources: [{ source: "libgen", available: true, label: "LibGen", message: null }],
  libraries: [library],
} satisfies KoreaderStoreConfigResponse;
const capability: KoreaderPluginCapability = "catalogStore";

void config;
void capability;
