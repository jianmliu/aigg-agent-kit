/**
 * WriteOptions.onchain — tags a write as belonging to the shared, durable,
 * ownership-relevant subset. Local backends may ignore it; the future MUD
 * backend routes these (and only these) to onchain tables. The union of all
 * onchain-tagged (scope, key) pairs defines the contracts/world schema.
 */
export interface WriteOptions {
  onchain?: boolean;
}
