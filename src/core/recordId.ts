import type { Row } from './types';

// permix keys grants by string id; coerce so a numeric `record.id` matches (the bridge path
// already does `String(farId)` — keep the direct path consistent).
export const recordId = (record: Row): string | undefined =>
  record.id == null ? undefined : String(record.id);
