/**
 * @aigg/replay — unified, pack-extensible replay.
 * A domain-neutral core (replay@1) + a Pack Registry. Worlds register packs;
 * the recorder, validator, and viewer all consult the same registry.
 */
export * from './schema';
export { PackRegistry, defaultRegistry } from './registry';
export { createRecorder } from './recorder';
export type { Recorder, RecorderOpts, RunInit } from './recorder';
export { validateRun, validateFile } from './validate';
export type { ValidateResult, ValidateError } from './validate';
export { viewerDir } from './assets';
export { corePack, CORE_PACK_ID } from './packs/core';
export { townPack, TOWN_PACK_ID } from './packs/town';
export { econPack, ECON_PACK_ID } from './packs/econ';
